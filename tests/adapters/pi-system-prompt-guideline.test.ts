import "../setup-home";
/**
 * Pi Bash file-exploration guideline removal.
 *
 * Pi hardcodes "- Use bash for file operations like ls, rg, find" from the
 * active tool NAMES alone, so a recovery-only Bash replacement cannot suppress
 * it through prompt metadata. It is removed at the provider payload seam.
 *
 * The last suite exercises the real extension wiring: only an EFFECTIVE Bash
 * replacement opts in, and the payload is filtered after an earlier payload
 * handler (remove-pi-system) has already rewritten the system text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_BASH_FILE_OPERATIONS_BULLETS,
  filterProviderPayload,
  stripBashFileOperationsGuideline,
} from "../../src/adapters/pi/system-prompt-guideline.js";
import type { NativeDefinition, NativeToolSDK } from "../../src/adapters/pi/tool-replacements.js";

// ── Fixtures ────────────────────────────────────────────────

const PI_DOCS_BLOCK = [
  "",
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
  "- Main documentation: /pi/README.md",
].join("\n");

const HOST_PROMPT = [
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.",
  "",
  "Available tools:",
  "- read: Read exact file excerpts (up to 300 lines / 10240 source bytes) or images",
  "- bash: Native shell recovery only when context-mode fails",
  "",
  "Guidelines:",
  "- Use bash for file operations like ls, rg, find",
  "- Route all shell commands through ctx_execute or suitable ctx_batch_execute, regardless of output size or side effects.",
  "- Be concise in your responses",
  PI_DOCS_BLOCK,
  "",
  "Current working directory: /tmp/project",
].join("\n");

const BASHLESS_PROMPT = HOST_PROMPT.replace("- Use bash for file operations like ls, rg, find\n", "");

/** What an earlier `before_provider_request` handler (remove-pi-system) leaves
 * behind: the same prompt minus the Pi documentation block, which means the
 * payload string is no longer equal to `ctx.getSystemPrompt()`. */
const EARLIER_FILTERED_PROMPT = HOST_PROMPT.replace(PI_DOCS_BLOCK, "");

function payloadOf(instructions: string) {
  return {
    model: "gpt-6-astra",
    stream: true,
    instructions,
    input: [
      { role: "user", content: [{ type: "input_text", text: "list the files" }] },
    ],
    tools: [{ type: "function", name: "read", description: "Use bash for file operations like ls, rg, find" }],
    temperature: 0,
  };
}

// ── Pure text removal ───────────────────────────────────────

describe("stripBashFileOperationsGuideline", () => {
  it("removes the Bash bullet and preserves every other line byte for byte", () => {
    const stripped = stripBashFileOperationsGuideline(HOST_PROMPT);
    expect(stripped).toBe(BASHLESS_PROMPT);
    expect(stripped).not.toContain("Use bash for file operations");
    expect(stripped).toContain("- Route all shell commands through ctx_execute");
    expect(stripped).toContain("- Be concise in your responses");
    expect(stripped).toContain("Current working directory: /tmp/project");
  });

  it.each(PI_BASH_FILE_OPERATIONS_BULLETS)("removes the Pi variant %j", (bullet) => {
    const prompt = `Guidelines:\n${bullet}\n- Be concise in your responses`;
    expect(stripBashFileOperationsGuideline(prompt)).toBe("Guidelines:\n- Be concise in your responses");
  });

  it("is idempotent and returns unchanged content otherwise", () => {
    const once = stripBashFileOperationsGuideline(HOST_PROMPT);
    expect(stripBashFileOperationsGuideline(once)).toBe(once);
    expect(stripBashFileOperationsGuideline(BASHLESS_PROMPT)).toBe(BASHLESS_PROMPT);
    expect(stripBashFileOperationsGuideline("")).toBe("");
  });

  it("never partially rewrites a near-miss line or a non-LF copy", () => {
    const nearMiss = "- Use bash for file operations like ls, rg, find, and more";
    expect(stripBashFileOperationsGuideline(`Guidelines:\n${nearMiss}`)).toBe(`Guidelines:\n${nearMiss}`);
    const crlf = `Guidelines:\r\n${PI_BASH_FILE_OPERATIONS_BULLETS[0]}\r\n`;
    expect(stripBashFileOperationsGuideline(crlf)).toBe(crlf);
  });
});

// ── Provider payload filtering ──────────────────────────────

describe("filterProviderPayload", () => {
  it("strips the instructions slot and leaves every sibling field by reference", () => {
    const payload = payloadOf(HOST_PROMPT);
    const filtered = filterProviderPayload(payload) as typeof payload;
    expect(filtered).not.toBe(payload);
    expect(filtered.instructions).toBe(BASHLESS_PROMPT);
    expect(filtered.model).toBe(payload.model);
    expect(filtered.input).toBe(payload.input);
    expect(filtered.tools).toBe(payload.tools);
    expect(filtered.temperature).toBe(payload.temperature);
  });

  it("strips the system text string, block array, and the other provider slots", () => {
    const cases: Array<[string, unknown]> = [
      ["system", HOST_PROMPT],
      ["instructions", HOST_PROMPT],
      ["systemInstruction", HOST_PROMPT],
      ["systemPrompt", HOST_PROMPT],
      ["system", [{ type: "text", text: HOST_PROMPT, cache_control: { type: "ephemeral" } }]],
    ];
    for (const [slot, value] of cases) {
      const payload: Record<string, unknown> = { model: "m", [slot]: value };
      const filtered = filterProviderPayload(payload) as Record<string, unknown>;
      expect(JSON.stringify(filtered)).not.toContain("Use bash for file operations");
      expect(JSON.stringify(filtered)).toContain("Route all shell commands through ctx_execute");
      expect(filtered.model).toBe("m");
    }
  });

  it("strips instruction-role messages in messages/input and preserves the rest", () => {
    const user = { role: "user", content: [{ type: "input_text", text: HOST_PROMPT }] };
    const payload = {
      messages: [
        { role: "developer", content: HOST_PROMPT },
        user,
      ],
      input: [
        { role: "system", content: [{ type: "text", text: HOST_PROMPT }] },
        { role: "assistant", content: HOST_PROMPT },
      ],
    };
    const filtered = filterProviderPayload(payload) as typeof payload;
    expect(filtered).not.toBe(payload);
    expect((filtered.messages[0].content as string)).toBe(BASHLESS_PROMPT);
    expect(filtered.messages[1]).toBe(user);
    expect((filtered.input[0].content as Array<{ text: string }>)[0].text).toBe(BASHLESS_PROMPT);
    expect(filtered.input[1]).toBe(payload.input[1]);
  });

  it("strips a nested context.systemPrompt slot", () => {
    const payload = { context: { systemPrompt: HOST_PROMPT, unrelated: "keep" }, model: "m" };
    const filtered = filterProviderPayload(payload) as typeof payload;
    expect(filtered.context.systemPrompt).toBe(BASHLESS_PROMPT);
    expect(filtered.context.unrelated).toBe("keep");
    expect(filtered.model).toBe("m");
  });

  it("strips after an earlier payload handler rewrote the system text", () => {
    // Exact-equality gating against ctx.getSystemPrompt() would silently stop
    // matching here — the regression this suite exists to prevent.
    expect(EARLIER_FILTERED_PROMPT).not.toBe(HOST_PROMPT);
    const filtered = filterProviderPayload(payloadOf(EARLIER_FILTERED_PROMPT)) as { instructions: string };
    expect(filtered.instructions).not.toContain("Use bash for file operations");
    expect(filtered.instructions).toContain("Route all shell commands through ctx_execute");
  });

  it("never rewrites tool schemas or non-instruction history", () => {
    const payload = payloadOf("Guidelines:\n- Be concise in your responses");
    const filtered = filterProviderPayload(payload) as typeof payload;
    expect(filtered).toBe(payload);
  });

  it("is idempotent", () => {
    const once = filterProviderPayload(payloadOf(HOST_PROMPT)) as { instructions: string };
    const twice = filterProviderPayload(once) as { instructions: string };
    expect(twice.instructions).toBe(once.instructions);
    expect(twice).toBe(once);
  });

  it("fails closed on unknown shapes, primitives, and hostile payloads", () => {
    for (const value of [null, undefined, 0, "text", [], [{ role: "system", content: HOST_PROMPT }]]) {
      expect(filterProviderPayload(value)).toBe(value);
    }
    const nested = { body: { prompt: HOST_PROMPT } };
    expect(filterProviderPayload(nested)).toBe(nested);
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error("hostile payload"); },
    });
    expect(filterProviderPayload(hostile)).toBe(hostile);
  });
});

// ── Extension wiring ───────────────────────────────────────

const BASH_SCHEMA = {
  type: "object",
  properties: { command: { type: "string" }, timeout: { type: "number" } },
  required: ["command"],
};

type HandlerFn = (...args: any[]) => any;

function createFakePi() {
  const handlers: Record<string, HandlerFn[]> = {};
  const tools: Array<NativeDefinition & { sourceInfo: { source: string } }> = [];
  const pi = {
    on: (event: string, handler: HandlerFn) => {
      (handlers[event] ??= []).push(handler);
    },
    getAllTools: () => tools,
    registerTool: (tool: NativeDefinition) => {
      const index = tools.findIndex((existing) => existing.name === tool.name);
      tools[index] = { ...tool, sourceInfo: { source: "extension" } };
    },
    registerCommand: () => {},
    sendMessage: vi.fn(),
    _handlers: handlers,
    _tools: tools,
  };
  return pi;
}

function nativeBashSdk(): NativeToolSDK {
  return {
    createBashToolDefinition: () => ({
      name: "bash",
      label: "bash",
      description: "native bash",
      parameters: BASH_SCHEMA,
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }),
    createReadToolDefinition: () => { throw new Error("Read is not enabled in this suite"); },
    detectSupportedImageMimeTypeFromFile: async () => null,
    truncateHead: (text: string) => ({
      content: text, truncated: false, truncatedBy: null, totalLines: 1,
      totalBytes: Buffer.byteLength(text), outputLines: 1, outputBytes: Buffer.byteLength(text),
      lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 1, maxBytes: 10_240,
    }),
  } as unknown as NativeToolSDK;
}

describe("Pi extension payload hook", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-guideline-test-"));
    mkdirSync(join(root, ".pi", "context-mode"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "context-mode", "settings.json"),
      JSON.stringify({ toolReplacements: { bash: { enabled: true } } }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.PI_PROJECT_DIR;
  });

  it("strips Pi's bullet only once the Bash replacement is effective", async () => {
    process.env.PI_PROJECT_DIR = root;
    const pi = createFakePi();
    pi._tools.push({
      name: "bash", label: "bash", description: "native", parameters: BASH_SCHEMA,
      execute: async () => ({ content: [] }),
      sourceInfo: { source: "builtin" },
    } as unknown as NativeDefinition & { sourceInfo: { source: string } });

    const mod = await import("../../src/adapters/pi/extension.js");
    mod.default(pi, nativeBashSdk());

    const handler = pi._handlers["before_provider_request"]?.[0];
    expect(typeof handler).toBe("function");

    // Before the replacement is installed the payload must pass through
    // untouched: with the switch off the bullet agrees with native Bash.
    const payload = payloadOf(HOST_PROMPT);
    expect(await handler({ payload })).toBeUndefined();

    await pi._handlers["session_start"]?.[0]({ reason: "startup" }, {});
    expect(pi._tools.find((tool) => tool.name === "bash")?.sourceInfo.source).toBe("extension");

    const filtered = await handler({ payload }) as { instructions: string };
    expect(filtered).not.toBe(payload);
    expect(filtered.instructions).toBe(BASHLESS_PROMPT);
    expect(payload.instructions).toBe(HOST_PROMPT);
  });
});
