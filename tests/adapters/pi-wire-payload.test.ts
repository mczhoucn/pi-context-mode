import "../setup-home";
/**
 * Pi wire-equivalent payload assertions (P0-1 / P0-2 / P0-3 / P1).
 *
 * The audit report's hard rule: the FINAL payload is the only fact layer for
 * "what the model actually received". Source-level checks alone are not
 * enough — a tool can be registered yet absent from the summary, a description
 * override can fail to apply, and a schema can advertise a call shape the
 * handler refuses.
 *
 * This suite therefore reproduces the Pi registration path end to end:
 *   1. spawn the real MCP server through `start.mjs` (the Pi bridge entry)
 *   2. `tools/list` → the exact JSON Schemas the model is shown
 *   3. pass each description through `piToolPresentation(name, desc, routeAllShell)`
 *      exactly as `bootstrapMCPTools` does
 *   4. assert the acceptance criteria from the handoff document
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { piToolPresentation } from "../../src/adapters/pi/mcp-bridge.js";
import { PiAdapter } from "../../src/adapters/pi/index.js";
import {
  filterProviderPayload,
  PI_BASH_FILE_OPERATIONS_BULLETS,
} from "../../src/adapters/pi/system-prompt-guideline.js";

const SIX_AGENT_TOOLS = [
  "ctx_execute",
  "ctx_batch_execute",
  "ctx_execute_file",
  "ctx_fetch_and_index",
  "ctx_index",
  "ctx_search",
] as const;

interface WireTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    required?: string[];
    properties?: Record<string, { description?: string; default?: unknown; minItems?: number; minLength?: number; items?: { minLength?: number } }>;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const mcpEntry = resolve(here, "..", "..", "start.mjs");

let proc: ChildProcess;
let homeDir: string;
let tools: WireTool[] = [];

beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "ctx-wire-payload-"));
  proc = spawn("node", [mcpEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
      VITEST: "1",
      CLAUDE_PROJECT_DIR: homeDir,
      HOME: homeDir,
    },
  });

  let buffer = "";
  proc.stdout!.on("data", (d: Buffer) => (buffer += d.toString()));
  const send = (msg: Record<string, unknown>) => proc.stdin!.write(JSON.stringify(msg) + "\n");

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi", version: "0.85.1" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  tools = await new Promise<WireTool[]>((resolveList) => {
    const timer = setTimeout(() => resolveList([]), 20_000);
    const poll = setInterval(() => {
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { tools?: WireTool[] } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          clearInterval(poll);
          resolveList(msg.result.tools);
          return;
        }
      }
    }, 100);
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}, 40_000);

afterAll(async () => {
  const exited = new Promise<void>((done) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return done();
    proc.once("exit", () => done());
    setTimeout(done, 5_000);
  });
  try {
    proc?.kill();
  } catch {
    /* best effort */
  }
  await exited;
  // The killed server may still be flushing SQLite files under the fake HOME,
  // so retry the recursive remove instead of racing it (ENOTEMPTY on macOS).
  if (homeDir) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(homeDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
});

const byName = (name: string) => tools.find((t) => t.name === name);
const describeField = (name: string, field: string) =>
  byName(name)?.inputSchema?.properties?.[field]?.description ?? "";

describe("Pi wire payload — P0-1: all six ctx_* tools visible, routing summary complete", () => {
  it("tools/list exposes all six agent-facing context-mode tools", () => {
    for (const name of SIX_AGENT_TOOLS) {
      expect(byName(name), `${name} missing from tools/list`).toBeDefined();
    }
  });

  it("routing summary names every ctx_* tool, including ctx_index", () => {
    const routing = new PiAdapter().getRoutingInstructions();
    expect(routing).toContain("ctx_index");
    for (const name of SIX_AGENT_TOOLS) expect(routing).toContain(name);
  });

  it("routing summary groups workflow pairs and does not imply always-calling", () => {
    const routing = new PiAdapter().getRoutingInstructions();
    expect(routing).toMatch(/ctx_fetch_and_index[\s\S]{0,80}ctx_search/);
    expect(routing).toMatch(/ctx_index[\s\S]{0,80}ctx_search/);
    expect(routing).toMatch(/alternatives, not a checklist/i);
    expect(routing).toMatch(/not the complete tool list/i);
    expect(routing).not.toMatch(/ONLY chance/i);
    expect(routing).not.toMatch(/\b5-8\b/);
  });

  it("Pi payload filter removes the hardcoded Bash file-operations guideline", () => {
    // Pi emits this bullet from ACTIVE TOOL NAMES alone, so an effective Bash
    // replacement (recovery channel) otherwise leaves the prompt contradicting
    // the ctx_execute routing policy.
    const payload = {
      instructions: [
        "Intro.",
        "",
        "Available tools:",
        "- bash: recovery",
        "- ctx_execute: run commands",
        "",
        "Guidelines:",
        PI_BASH_FILE_OPERATIONS_BULLETS[0],
        "- Be concise in your responses",
      ].join("\n"),
    };
    const filtered = filterProviderPayload(payload) as { instructions: string };
    expect(filtered.instructions).not.toContain(PI_BASH_FILE_OPERATIONS_BULLETS[0]);
    expect(filtered.instructions).not.toMatch(/file operations like/i);
    expect(filtered.instructions).toContain("Be concise in your responses");
    expect(filtered.instructions).toContain("- bash: recovery");
  });
});

describe("Pi wire payload — P0-3: no single-shot or 5-8 query claims", () => {
  it("no advertised schema claims ONLY chance or demands 5-8 queries", () => {
    const flat = JSON.stringify(tools);
    expect(flat).not.toMatch(/ONLY chance/i);
    expect(flat).not.toMatch(/5-8/);
    expect(flat).not.toMatch(/No follow-up calls needed/i);
  });

  it("ctx_batch_execute keeps focused-query wording and its real semantics", () => {
    const described = describeField("ctx_batch_execute", "queries");
    expect(described).toMatch(/one or more focused queries/i);
    expect(described).toMatch(/indexed output/i);
    expect(described).toMatch(/ctx_search/);
    expect(described).toMatch(/batch related questions/i);
  });
});

describe("Pi wire payload — P0-2: ctx_search schema matches the runtime", () => {
  it("requires a non-empty `queries` array on the wire", () => {
    const schema = byName("ctx_search")?.inputSchema;
    expect(schema?.required).toContain("queries");
    expect(schema?.properties?.queries?.minItems).toBe(1);
    expect(schema?.properties?.queries?.items?.minLength).toBe(1);
  });

  it("does not advertise the unreachable singular `query` alias", () => {
    expect(byName("ctx_search")?.inputSchema?.properties).not.toHaveProperty("query");
  });

  it("advertises limit default 2 — the same ceiling the handler enforces", () => {
    const limit = byName("ctx_search")?.inputSchema?.properties?.limit;
    expect(limit?.default).toBe(2);
    expect(limit?.description).toContain("default: 2");
    expect(limit?.description).toMatch(/maximum: 2/);
  });
});

describe("Pi wire payload — P1: at-least-one-input tools stay honest", () => {
  it("ctx_index advertises its fields and documents the at-least-one rule", () => {
    const schema = byName("ctx_index")?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(Object.keys(schema?.properties ?? {}).length).toBeGreaterThan(0);
    expect(byName("ctx_index")?.description).toMatch(/at least one input/i);
    expect(describeField("ctx_index", "content")).toMatch(/at least one is required/i);
    expect(describeField("ctx_index", "path")).toMatch(/at least one is required/i);
  });

  it("ctx_fetch_and_index keeps the legacy url shape and the batch requests shape", () => {
    const schema = byName("ctx_fetch_and_index")?.inputSchema;
    expect(schema?.properties).toHaveProperty("url");
    expect(schema?.properties).toHaveProperty("requests");
    expect(describeField("ctx_fetch_and_index", "url")).toMatch(/legacy single-shape/i);
    expect(byName("ctx_fetch_and_index")?.description).toMatch(/at least one input/i);
  });

  it("no ctx_* tool advertises an empty parameter list (#563 ZodEffects class)", () => {
    for (const name of SIX_AGENT_TOOLS) {
      const schema = byName(name)?.inputSchema;
      expect(schema?.type, `${name} is not an object schema`).toBe("object");
      expect(
        Object.keys(schema?.properties ?? {}).length,
        `${name} advertises properties:{} — a .refine/.transform wrapper collapsed it`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("Pi wire payload — P1: ctx_execute routing matches the Bash recovery policy", () => {
  const generic = () => byName("ctx_execute")?.description ?? "";

  it("routeAllShell=false passes the generic description through untouched", () => {
    const presented = piToolPresentation("ctx_execute", generic(), false);
    expect(presented.description).toBe(generic());
    expect(presented.description).not.toMatch(/In Pi, run ALL shell commands here/i);
  });

  it("routeAllShell=true states every Pi routing rule and contradicts nothing", () => {
    const presented = piToolPresentation("ctx_execute", generic(), true);
    const text = presented.description;
    // The four rules the effective Bash replacement requires.
    expect(text).toMatch(/In Pi, route ALL shell commands through context-mode/i);
    expect(text).toMatch(/small output, navigation, and filesystem mutations/i);
    expect(text).toMatch(/ctx_batch_execute for independent command collection\/search/i);
    expect(text).toMatch(/ctx_execute here for a single command or dependent chain/i);
    // Bash recovery policy — same contract as the Bash replacement metadata.
    expect(text).toMatch(/Native bash is a recovery channel only/i);
    expect(text).toMatch(/Never automatically retry/i);
    // The generic "use native host tools" branch must NOT survive here: it
    // would contradict the policy shipped in the same payload.
    expect(text).not.toMatch(/use native host tools/i);
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  it("the effective Pi payload contains exactly one Bash routing instruction", () => {
    const presented = piToolPresentation("ctx_execute", generic(), true);
    // Simulate the post-filter payload with the replacement active: Pi's own
    // file-ops bullet is removed, so the ctx_execute guideline is the only
    // Bash routing text left and must not be contradicted.
    const filtered = filterProviderPayload({
      instructions: [
        "Guidelines:",
        PI_BASH_FILE_OPERATIONS_BULLETS[0],
        presented.promptGuidelines[0],
      ].join("\n"),
    }) as { instructions: string };

    expect(filtered.instructions).not.toMatch(/file operations like/i);
    expect(filtered.instructions).toMatch(/native bash is recovery only/i);
    const contradictory = filtered.instructions.match(/use bash for file operations/gi) ?? [];
    expect(contradictory).toEqual([]);
  });

  it("routeAllShell does not touch tools that are not shell entry points", () => {
    for (const name of SIX_AGENT_TOOLS.filter((n) => n !== "ctx_execute" && n !== "ctx_batch_execute")) {
      const description = byName(name)?.description ?? "";
      expect(piToolPresentation(name, description, true).description).toBe(description);
    }
  });
});
