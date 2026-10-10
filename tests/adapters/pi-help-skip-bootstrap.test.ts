import "../setup-home";
/**
 * Pi extension — session-start MCP bridge bootstrap (#534, #809).
 *
 * Pi may load extensions for CLI-only paths such as `pi --help`, `pi install`,
 * `pi list`, `pi config`, and `pi --list-models`. Those paths do not dispatch
 * an agent session, so bootstrapping the long-lived MCP bridge during extension
 * discovery can orphan the bridge child (#534) or keep package commands alive
 * forever (#809).
 *
 * The bridge starts from `session_start`, which is emitted by Pi's interactive,
 * print, and RPC agent modes before the first prompt. This makes ctx_* tools and
 * their native prompt metadata available for the first request without keeping
 * a bridge for CLI-only commands.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string;
let originalArgv: string[];

type HandlerFn = (...args: any[]) => any;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-pi-lazy-bridge-"));
  originalArgv = process.argv;
  vi.resetModules();
});

afterEach(() => {
  process.argv = originalArgv;
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  delete process.env.PI_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
});

function createMockPi() {
  const handlers: Record<string, HandlerFn[]> = {};
  return {
    on: vi.fn((event: string, handler: HandlerFn) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
    }),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    _trigger: async (event: string, ...args: any[]) => {
      for (const handler of handlers[event] ?? []) {
        await handler(...args);
      }
    },
  };
}

async function registerWithBootstrapSpy(argv: string[]) {
  process.argv = ["/usr/bin/pi", "pi-coding-agent", ...argv];
  process.env.PI_PROJECT_DIR = scratch;
  process.env.CLAUDE_PROJECT_DIR = scratch;

  const bridgeMod = await import("../../src/adapters/pi/mcp-bridge.js");
  const spy = vi
    .spyOn(bridgeMod, "bootstrapMCPTools")
    .mockResolvedValue({
      tools: [],
      shutdown: () => {},
      client: { _spawnEnv: null } as unknown as InstanceType<
        typeof bridgeMod.MCPStdioClient
      >,
    });

  const extMod = await import("../../src/adapters/pi/extension.js");
  const pi = createMockPi();
  extMod.default(pi);
  await extMod._mcpBridgeReady;

  return { pi, spy };
}

describe("piExtension — session-start MCP bootstrap avoids CLI orphans (#534, #809)", () => {
  it.each([
    ["--help"],
    ["-v"],
    ["help"],
    ["--list-models"],
    ["install", "npm:pi-context-mode"],
    ["install", "--help"],
    ["remove", "npm:pi-context-mode"],
    ["uninstall", "npm:pi-context-mode"],
    ["update"],
    ["list"],
    ["config"],
  ])("does NOT bootstrap during extension discovery for argv: %s", async (...argv) => {
    const { spy } = await registerWithBootstrapSpy(argv);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each([
    [],
    ["-p", "task"],
    ["--print", "task"],
    ["--resume"],
    ["--mode", "json", "-p", "--no-session", "task"],
    ["--model", "sonnet", "task"],
  ])("bootstraps at session_start for real agent argv: %s", async (...argv) => {
    const { pi, spy } = await registerWithBootstrapSpy(argv);

    await pi._trigger("session_start", {}, {});

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does not bootstrap from before_agent_start without session_start", async () => {
    const { pi, spy } = await registerWithBootstrapSpy(["-p", "task"]);

    await pi._trigger("before_agent_start", { prompt: "task", systemPrompt: "" });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not bootstrap more than once per extension registration", async () => {
    const { pi, spy } = await registerWithBootstrapSpy(["-p", "task"]);

    await pi._trigger("session_start", {}, {});
    await pi._trigger("before_agent_start", { prompt: "first", systemPrompt: "" });
    await pi._trigger("before_agent_start", { prompt: "second", systemPrompt: "" });

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
