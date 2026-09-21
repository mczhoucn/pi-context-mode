import "./setup-home";
/**
 * Pi Extension Tests — TDD vertical slices.
 *
 * The Pi extension (src/adapters/pi/extension.ts) is a default-exported function that
 * receives a Pi API object and registers event handlers. Since we cannot test
 * against a real Pi runtime, we mock the Pi API to capture registered handlers
 * and invoke them with simulated events.
 *
 * Test slices:
 *   1. Tool name mapping (Pi names → context-mode canonical names)
 *   2. Event extraction from tool_result
 *   3. PreToolUse routing enforcement (tool_call)
 *   4. Session lifecycle
 *   5. Lifecycle-owned recovery (prepare/success, persistent delivery, context filtering)
 *   6. Stats command (/ctx-stats)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDB, resolveSessionDbPath } from "../src/session/db.js";
import { ContentStore } from "../src/store.js";
import { searchAllSources } from "../src/search/unified.js";

// ── Mock Pi API ──────────────────────────────────────────────

type HandlerFn = (...args: any[]) => any;

interface MockCommandOpts {
  description?: string;
  handler?: HandlerFn;
  [key: string]: unknown;
}

function createMockPiApi() {
  const handlers: Record<string, HandlerFn[]> = {};
  const commands: Record<string, MockCommandOpts> = {};

  return {
    on: (event: string, handler: HandlerFn) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    registerCommand: (name: string, opts: MockCommandOpts) => {
      commands[name] = opts;
    },
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(),

    // ── Test helpers ──
    _trigger: async (event: string, ...args: any[]) => {
      for (const h of handlers[event] ?? []) {
        const result = await h(...args);
        if (result) return result;
      }
    },
    _getCommand: (name: string) => commands[name],
    _handlers: handlers,
    _commands: commands,
  };
}

// ── Shared state ────────────────────────────────────────────

let tempDir: string;
let api: ReturnType<typeof createMockPiApi>;

// ── Dynamic import helper ───────────────────────────────────

async function registerPiExtension(
  mockApi: ReturnType<typeof createMockPiApi>,
  opts?: { projectDir?: string },
) {
  // Set environment variable so the extension uses our temp directory
  const projectDir = opts?.projectDir ?? tempDir;
  process.env.PI_PROJECT_DIR = projectDir;
  process.env.CLAUDE_PROJECT_DIR = projectDir;

  const mod = await import("../src/adapters/pi/extension.js");
  const register = mod.default;
  await register(mockApi);

  return mockApi;
}

// ── Tests ───────────────────────────────────────────────────

describe("Pi Extension", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-ext-test-"));
    mkdirSync(tempDir, { recursive: true });
    api = createMockPiApi();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* cleanup best effort */
    }
    delete process.env.PI_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 1: Tool name mapping
  // ═══════════════════════════════════════════════════════════

  describe("Slice 1: Tool name mapping", () => {
    it("maps Pi 'bash' to context-mode 'Bash'", async () => {
      await registerPiExtension(api);

      // Trigger a tool_result event with Pi's "bash" tool name
      // and verify it gets mapped correctly for event extraction
      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "git status" },
        tool_result: "On branch main\nnothing to commit",
      });

      // The handler should not throw — successful mapping means
      // extractEvents recognized "Bash" and produced git events
    });

    it("maps Pi 'read' to context-mode 'Read'", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/app.ts" },
        tool_result: "export default {}",
      });

      // Should not throw — "Read" mapping enables file_read event extraction
    });

    it("passes unknown tool names through unchanged", async () => {
      await registerPiExtension(api);

      // Unknown tools should pass through without error
      await api._trigger("tool_result", {
        tool_name: "SomeCustomTool",
        tool_input: { data: "test" },
        tool_result: "ok",
      });
    });

    it("maps 'context_mode_' prefix to 'mcp__context_mode__' so MCP tool calls get extracted", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {
        session_id: "test-fix1",
        project_dir: tempDir,
      });

      // Pi prefixes MCP-registered tools with "context_mode_". Without
      // normalisation the extract functions (P, F) silently drop all
      // events because they gate on e.startsWith("mcp__").
      await api._trigger("tool_result", {
        tool_name: "context_mode_ctx_execute",
        params: { language: "javascript", code: "console.log(1)" },
        result: "1",
      });

      // Verify via ctx-stats that events include "mcp" category
      // (meaning they were extracted, not just the generic fallback).
      const stats = (await api._getCommand("ctx-stats")!.handler!({})) as {
        text: string;
      };
      expect(stats.text).toContain("mcp");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 2: Event extraction from tool_result
  // ═══════════════════════════════════════════════════════════

  describe("Slice 2: Event extraction from tool_result", () => {
    it("extracts file and git events from bash command", async () => {
      await registerPiExtension(api);

      // Bash with git command should produce git events
      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "git commit -m 'initial'" },
        tool_result: "[main abc1234] initial\n 1 file changed",
      });

      // No throw = events extracted successfully
    });

    it("extracts file_read event from read tool", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/index.ts" },
        tool_result: "export const hello = 'world';",
      });
    });

    it("extracts file_read event when Pi passes 'path' instead of 'file_path'", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {
        session_id: "test-fix2",
        project_dir: tempDir,
      });

      // Pi's native Read tool sends { path: "..." } rather than
      // { file_path: "..." } (Claude Code convention). Without
      // normalisation the extractor reads n.file_path → undefined,
      // producing file_read events with an empty path.
      await api._trigger("tool_result", {
        tool_name: "read",
        params: { path: "/src/index.ts" },
        result: "export const hello = 'world';",
      });

      // Verify the file_read event was captured by checking
      // ctx-stats shows "file" category events.
      const stats = (await api._getCommand("ctx-stats")!.handler!({})) as {
        text: string;
      };
      expect(stats.text).toContain("file");
    });

    it("extracts cwd event from cd command", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "cd /tmp/workspace && ls" },
        tool_result: "file1.ts\nfile2.ts",
      });
    });

    it("extracts error event from failed tool result", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "npm test" },
        tool_result: "Error: test failed with exit code 1",
        is_error: true,
      });
    });

    it("handles missing tool_result gracefully", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "echo hello" },
      });
    });

    it("handles empty event gracefully", async () => {
      await registerPiExtension(api);

      await api._trigger("tool_result", {});
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 3: PreToolUse routing enforcement (tool_call)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 3: PreToolUse routing enforcement", () => {
    it("blocks bash with curl", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl https://example.com" },
      });

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
    });

    it("blocks bash with wget", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "wget https://example.com -O out.html" },
      });

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
    });

    it("allows bash with git status", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "git status" },
      });

      // git status should NOT be blocked — result is undefined (passthrough)
      // or an allow/context action (not deny/blocked)
      if (result) {
        expect(result.blocked).not.toBe(true);
      }
    });

    it("allows read tool (no blocking)", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "read",
        input: { file_path: "/src/app.ts" },
      });

      // Read should never be blocked — at most it gets routing guidance
      if (result) {
        expect(result.blocked).not.toBe(true);
      }
    });

    it("handles missing tool_name gracefully", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {});
      // Should not throw, and should passthrough
      if (result) {
        expect(result.blocked).not.toBe(true);
      }
    });

    // ── Issue #625 — escape hatches + quoted-string false positives ──
    //
    // The original BLOCKED_BASH_PATTERNS blocked every curl/wget unconditionally
    // and matched inside quoted CLI arguments. Two consequences:
    //
    //   1. False positive: `gh issue list --search "...curl..."` was blocked
    //      because the literal word `curl` appeared inside the quoted search
    //      argument. The reporter literally could not file the issue via `gh`
    //      until they rephrased the query.
    //
    //   2. Unrecoverable trap: when the MCP bridge dies, the agent's only
    //      escape hatch is a disk-buffered HTTP download (curl -s -o file).
    //      With every curl/wget invocation blocked, there is no way to fetch
    //      a URL until the user restarts Pi entirely.
    //
    // Fix mirrors hooks/core/routing.mjs:660–722:
    //   - Strip quoted content before regex matching
    //   - Split on chain operators (&&, ||, ;)
    //   - Allow segments that are: silent (-s/-q) + file output (-o/-O or >)
    //     + no verbose (-v) + no stdout alias (-o -, -o /dev/stdout)
    //
    // This preserves the original "do not flood context" intent while letting
    // the agent gracefully self-recover when MCP is unreachable.

    it("does NOT block gh command with 'curl' inside quoted --search argument (Issue #625 bonus)", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: {
          command: 'gh issue list --search "BLOCKED_BASH_PATTERNS curl wget block"',
        },
      });

      // The literal word "curl" appears only inside a quoted argument; the
      // command itself is `gh`, which has nothing to do with HTTP fetching.
      // Stripping quoted content before matching must allow this through.
      if (result) {
        expect(result.block).not.toBe(true);
      }
    });

    it("does NOT block echo with 'wget' inside a quoted log message (Issue #625 bonus)", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: {
          command: 'echo "users tried to wget the bundle and it failed"',
        },
      });

      if (result) {
        expect(result.block).not.toBe(true);
      }
    });

    it("allows curl with silent + file output for MCP-down recovery (Issue #625)", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl -s -o /tmp/data.json https://example.com/api" },
      });

      // -s (silent) + -o file means the body never enters context. This must
      // remain available as an escape hatch when ctx_fetch_and_index is
      // unreachable (e.g. MCP bridge dead between requests).
      if (result) {
        expect(result.block).not.toBe(true);
      }
    });

    it("allows wget with quiet + output-document for MCP-down recovery (Issue #625)", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "wget -q -O /tmp/data.json https://example.com/api" },
      });

      if (result) {
        expect(result.block).not.toBe(true);
      }
    });

    it("still blocks curl that would flood context (no file output)", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl https://example.com/big-response" },
      });

      // No -o flag → body goes straight to stdout → straight into context.
      // Must remain blocked.
      expect(result).toBeDefined();
      expect(result.block).toBe(true);
    });

    it("still blocks curl -o - (explicit stdout alias)", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl -s -o - https://example.com/api" },
      });

      // -o - means stdout, which feeds context — must remain blocked even
      // when silent flag is present.
      expect(result).toBeDefined();
      expect(result.block).toBe(true);
    });

    it("still blocks verbose curl (floods stderr → context)", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl -v -s -o /tmp/x.json https://example.com" },
      });

      // -v dumps request/response headers to stderr — flooding context.
      expect(result).toBeDefined();
      expect(result.block).toBe(true);
    });

    it("blocks chained command if ANY segment is unsafe curl", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: {
          command:
            "curl -s -o /tmp/a.json https://example.com/a && curl https://example.com/b",
        },
      });

      // First segment safe, second unsafe → must block the whole chain.
      expect(result).toBeDefined();
      expect(result.block).toBe(true);
    });

    it("allows chained command where every curl segment is safe", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("tool_call", {
        toolName: "bash",
        input: {
          command:
            "curl -s -o /tmp/a.json https://example.com/a && curl -s -o /tmp/b.json https://example.com/b",
        },
      });

      // Both segments: silent + file output + no stdout alias + no verbose.
      // The chain must pass.
      if (result) {
        expect(result.block).not.toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 4: Session lifecycle
  // ═══════════════════════════════════════════════════════════

  describe("Slice 4: Session lifecycle", () => {
    it("session_start initializes session in DB", async () => {
      await registerPiExtension(api);

      // session_start should register without error
      await api._trigger("session_start", {
        session_id: "test-session-abc123",
        project_dir: tempDir,
      });
    });

    it("session_start stats use the native Pi context session ID", async () => {
      await registerPiExtension(api);
      const sessionFile = join(tempDir, "stable-session.jsonl");
      const expectedSessionId = "native-stable-session";

      await api._trigger(
        "session_start",
        { type: "session_start", reason: "startup" },
        { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => expectedSessionId } },
      );

      const result = await api._getCommand("ctx-stats")!.handler!({});
      expect((result as { text: string }).text).toContain(
        `Session: \`${expectedSessionId.slice(0, 8)}`,
      );
    });

    it("session_before_compact only prepares and never returns a replacement or delivers", async () => {
      await registerPiExtension(api);
      const branch = [{ id: "u1", type: "message" }];
      const ctx = { sessionManager: {
        getSessionFile: () => join(tempDir, "prepare.jsonl"), getSessionId: () => "prepare-native",
        getBranch: () => branch, getEntries: () => branch,
      } };
      await api._trigger("session_start", { reason: "new" }, ctx);

      // First capture some events
      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/index.ts" },
        tool_result: "export default {}",
      });

      // Then trigger compaction
      const result = await api._trigger("session_before_compact", {}, ctx);

      expect(result).toBeUndefined();
      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("session_compact increments compact counter", async () => {
      await registerPiExtension(api);

      // Capture events first
      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/app.ts" },
        tool_result: "code here",
      });

      // Prepare without replacing host compaction
      await api._trigger("session_before_compact", {});

      // Increment counter
      await api._trigger("session_compact", {});

      // No throw = success
    });

    it("session_shutdown cleans up", async () => {
      await registerPiExtension(api);

      await api._trigger("session_start", {
        session_id: "cleanup-session-xyz",
        project_dir: tempDir,
      });

      // Shutdown should clean up without error
      await api._trigger("session_shutdown", {});
    });

    it("session_start receives (event, ctx) — ctx.sessionManager is used for session ID", async () => {
      await registerPiExtension(api);

      // The handler signature must be (event, ctx), not (ctx).
      // Pass a real-looking ctx as the second argument with sessionManager;
      // if the signature were wrong, sessionManager would be on the event
      // object and deriveSessionId would fall back to pi-<timestamp>.
      const sessionFile = `/fake/session-${Date.now()}.jsonl`;
      await api._trigger("session_start",
        { reason: "startup" },                               // event (1st arg)
        { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => sessionId } }, // ctx (2nd arg)
      );

      // Verify the session was initialised with the file-derived ID by checking
      // that before_agent_start doesn't blow up (it needs a valid _sessionId).
      // In the new behavior, before_agent_start no longer returns systemPrompt;
      // recovery belongs to verified lifecycle boundaries, not this hook.
      const result = await api._trigger("before_agent_start", {
        systemPrompt: "Base.",
      });
      // before_agent_start may or may not return a value — the key is it doesn't throw
      expect(result?.systemPrompt ?? null).toBe(null); // systemPrompt is no longer returned
    });

    it("handles session lifecycle in correct order", async () => {
      await registerPiExtension(api);

      // Full lifecycle: start → events → compact → more events → shutdown
      await api._trigger("session_start", {
        session_id: "lifecycle-test",
        project_dir: tempDir,
      });

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "git status" },
        tool_result: "On branch main",
      });

      await api._trigger("session_before_compact", {});
      await api._trigger("session_compact", {});

      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/file.ts" },
        tool_result: "content",
      });

      await api._trigger("session_shutdown", {});
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 5: Lifecycle-owned recovery
  // ═══════════════════════════════════════════════════════════

  describe("Slice 5: Lifecycle-owned recovery", () => {
    it("persists recovery at verified compact, without waiting for before_agent_start", async () => {
      await registerPiExtension(api);
      const branch: any[] = [{ id: "u1", type: "message" }];
      const ctx = { sessionManager: {
        getSessionFile: () => join(tempDir, "own-session.jsonl"),
        getSessionId: () => "own-session",
        getBranch: () => [...branch], getEntries: () => [...branch],
      } };
      await api._trigger("session_start", { reason: "new" }, ctx);
      await api._trigger("tool_result", {
        toolName: "read", params: { path: "/src/main.ts" }, result: "contents",
      });
      api.sendMessage.mockImplementation((message: any) => {
        branch.push({ ...message, type: "custom_message", id: "recovery", parentId: "c1" });
      });
      await api._trigger("session_before_compact", {}, ctx);
      expect(api.sendMessage).not.toHaveBeenCalled();
      branch.push({ type: "compaction", id: "c1", parentId: "u1" });
      await api._trigger("session_compact", { compactionEntry: { id: "c1" } }, ctx);
      expect(api.sendMessage).toHaveBeenCalledOnce();
      const [message, options] = api.sendMessage.mock.calls[0];
      expect(options).toEqual({ triggerTurn: false });
      expect(message.content).toContain("main.ts");
      expect(message.content).toContain("session_knowledge");
      expect(message.customType).toBe("context-mode-recovery");
      const messages = [{ role: "user", content: "request" }, { role: "custom", ...message }];
      for (let i = 0; i < 3; i++) {
        expect(await api._trigger("context", { messages }, ctx)).toBeUndefined();
        expect(messages).toHaveLength(2);
      }
      await api._trigger("session_compact", { compactionEntry: { id: "c1" } }, ctx);
      expect(api.sendMessage).toHaveBeenCalledOnce();
    });

    it("never injects historical XML when host identity cannot be verified", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", { reason: "resume" });
      await api._trigger("tool_result", {
        toolName: "read", params: { path: "/src/main.ts" }, result: "contents",
      });
      await api._trigger("session_before_compact", {});
      await api._trigger("session_compact", {});
      const messages = [{ role: "user", content: "continue" }];
      expect(await api._trigger("context", { messages })).toBeUndefined();
      expect(messages).toHaveLength(1);
      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("returns nothing when no resume exists", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("before_agent_start", {
        systemPrompt: "You are a helpful assistant.",
      });

      // No resume → no modification (undefined or original prompt)
      if (result?.systemPrompt) {
        expect(result.systemPrompt).not.toContain("session_resume");
      }
    });

    it("native IDs isolate reused paths and rebuild own recovery after reopen or move without reading legacy hashes", async () => {
      await registerPiExtension(api);
      let file: string | undefined = join(tempDir, "reused.jsonl");
      let host = "native-A";
      let branch: any[] = [{ id: "u1", type: "message" }];
      const ctx = { sessionManager: {
        getSessionFile: () => file, getSessionId: () => host,
        getBranch: () => [...branch], getEntries: () => [...branch],
      } };
      const legacyKey = createHash("sha256").update(file).digest("hex").slice(0, 16);
      const db = new SessionDB({ dbPath: resolveSessionDbPath({
        projectDir: tempDir, sessionsDir: join(process.env.HOME!, ".pi", "context-mode", "sessions"),
      }) });
      try {
        db.insertEvent(legacyKey, { type: "decision", category: "decision", data: "LEGACY UNBOUND SENTINEL", priority: 1 });
        db.insertEvent("native-A", { type: "decision", category: "decision", data: "NATIVE A SENTINEL", priority: 1 });
        // Opening an existing transcript does not rebuild context from SessionDB.
        // An explicit extension reload remains the opt-in repair boundary, and it
        // must still use the native key rather than the hash of the current path.
        await api._trigger("session_start", { reason: "startup" }, ctx);
        expect(api.sendMessage).not.toHaveBeenCalled();
        await api._trigger("session_start", { reason: "reload" }, ctx);
        expect(api.sendMessage).toHaveBeenCalledOnce();
        expect(api.sendMessage.mock.calls[0][0].content).toContain("NATIVE A SENTINEL");
        expect(api.sendMessage.mock.calls[0][0].content).not.toContain("LEGACY UNBOUND");
        api.sendMessage.mockClear();
        host = "native-B";
        await api._trigger("session_start", { reason: "startup" }, ctx);
        expect(api.sendMessage).not.toHaveBeenCalled();
        await api._trigger("session_before_compact", {}, ctx);
        branch.push({ id: "c1", type: "compaction" });
        await api._trigger("session_compact", { compactionEntry: { id: "c1" } }, ctx);
        expect(api.sendMessage).toHaveBeenCalledOnce();
        expect(api.sendMessage.mock.calls[0][0].content).toBe("");
        expect(api.sendMessage.mock.calls[0][0].details.host).toBe("native-B");
        await api._trigger("before_agent_start", { prompt: "B raw occurrence" }, ctx);
        expect(db.getEvents("native-B").some(e => e.data === "B raw occurrence")).toBe(true);
        expect(db.getEvents("native-A").some(e => e.data === "B raw occurrence")).toBe(false);
        const stats = await api._getCommand("ctx-stats")!.handler!({});
        expect(stats.text).toContain("Session: `native-B");
        // New extension instance simulates process-local state loss; normal
        // reopen and moved-file reopen keep the native ID, with fresh guards.
        await api._trigger("session_shutdown", {}, ctx);
        api = createMockPiApi(); await registerPiExtension(api);
        host = "native-A"; branch = [{ id: "u1", type: "message" }];
        await api._trigger("session_start", { reason: "resume" }, ctx);
        expect(api.sendMessage).not.toHaveBeenCalled();
        await api._trigger("session_start", { reason: "reload" }, ctx);
        expect(api.sendMessage).toHaveBeenCalledOnce();
        expect(api.sendMessage.mock.calls[0][0].content).toContain("NATIVE A SENTINEL");
        file = join(tempDir, "moved.jsonl");
        await api._trigger("session_start", { reason: "resume" }, ctx);
        expect(api.sendMessage).toHaveBeenCalledOnce();
        await api._trigger("session_start", { reason: "reload" }, ctx);
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
        const moved = api.sendMessage.mock.calls[1][0];
        expect(moved.content).toContain("NATIVE A SENTINEL");
        expect(moved.content).not.toContain("LEGACY UNBOUND");
        expect(moved.details).toMatchObject({ file, host: "native-A", version: 2 });
        file = undefined; api.sendMessage.mockClear();
        await api._trigger("session_start", { reason: "resume" }, ctx);
        await api._trigger("session_before_compact", {}, ctx);
        branch.push({ id: "c2", type: "compaction" });
        await api._trigger("session_compact", { compactionEntry: { id: "c2" } }, ctx);
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(db.getEvents(legacyKey).map(e => e.data)).toEqual(["LEGACY UNBOUND SENTINEL"]);
      } finally { db.close(); await api._trigger("session_shutdown", {}, ctx); }
    });

    it("captures repeated prompt occurrences, recovers the latest, and retrieves real project history through timeline search", async () => {
      await registerPiExtension(api);
      const file = join(tempDir, "search-session.jsonl");
      const key = "search-session";
      const branch: any[] = [{ id: "u1", type: "message" }];
      const ctx = { sessionManager: {
        getSessionFile: () => file, getSessionId: () => "search-session",
        getBranch: () => [...branch], getEntries: () => [...branch],
      } };
      await api._trigger("session_start", { reason: "new" }, ctx);
      const prompts = ["orchid parser A", "orchid parser B", "orchid parser A", "orchid parser A"];
      for (const prompt of prompts) await api._trigger("before_agent_start", { prompt }, ctx);
      await api._trigger("tool_result", {
        toolName: "read", params: { path: "/src/orchid.ts" }, result: "private full output not captured",
      }, ctx);
      const db = new SessionDB({ dbPath: resolveSessionDbPath({
        projectDir: tempDir, sessionsDir: join(process.env.HOME!, ".pi", "context-mode", "sessions"),
      }) });
      const store = new ContentStore(join(tempDir, "content.db"));
      try {
        expect(db.getEvents(key).filter(e => e.type === "user_prompt").map(e => e.data)).toEqual(prompts);
        await api._trigger("session_start", { reason: "reload" }, ctx);
        expect(api.sendMessage).toHaveBeenCalledOnce();
        const text = api.sendMessage.mock.calls[0][0].content;
        expect(text).toContain(prompts.at(-1));
        expect(text).not.toContain(prompts[1]);
        expect(text).toContain('ctx_search(queries: [...], sort: "timeline")');
        expect(text).not.toContain('source: "session-events"');
        expect(text).not.toContain("already indexed");
        expect(text).toContain("Project history may include other sessions");
        // The same public search implementation used by ctx_search: no invented
        // source index and no mocked DB/store. History is project-, not session-scoped.
        db.insertEvent("other-session", { type: "decision", category: "decision", data: "orchid sibling evidence", priority: 1 },
          "Stop", { projectDir: tempDir });
        db.insertEvent("foreign-project", { type: "decision", category: "decision", data: "orchid foreign evidence", priority: 1 },
          "Stop", { projectDir: join(tempDir, "foreign") });
        const search = () => searchAllSources({ query: "orchid", limit: 50, sort: "timeline", store,
          sessionDB: db, projectDir: tempDir });
        const withoutIndex = search();
        expect(withoutIndex.filter(r => r.content === prompts[0])).toHaveLength(3);
        expect(withoutIndex.some(r => r.content.includes("orchid.ts"))).toBe(true);
        expect(withoutIndex.some(r => r.content.includes("sibling evidence"))).toBe(true);
        expect(withoutIndex.some(r => r.content.includes("foreign evidence"))).toBe(false);
        expect(withoutIndex.some(r => r.content.includes("private full output"))).toBe(false);
        store.index({ content: "orchid indexed reference", source: "reference" });
        const merged = search();
        expect(merged.some(r => r.source === "reference" && r.content.includes("indexed reference"))).toBe(true);
        expect(merged.some(r => r.content === prompts[0])).toBe(true);
      } finally {
        store.close(); db.close();
        await api._trigger("session_shutdown", {}, ctx);
      }
    });

    it("records genuine raw prompts but not recovery/system notifications", async () => {
      await registerPiExtension(api);
      const spy = vi.spyOn(SessionDB.prototype, "insertEvent");
      try {
        await api._trigger("session_start", { reason: "new" }, {
          sessionManager: { getSessionFile: () => join(tempDir, "raw-prompts.jsonl") },
        });
        await api._trigger("before_agent_start", { prompt: "Please explain the parser." });
        await api._trigger("before_agent_start", { prompt: "<system-reminder>not a request</system-reminder>" });
        await api._trigger("before_agent_start", { prompt: '<session_knowledge source="compact">old history</session_knowledge>' });
        const raw = spy.mock.calls.filter(call => call[1].category === "user-prompt");
        expect(raw).toHaveLength(1);
        expect(raw[0][1].data).toBe("Please explain the parser.");
      } finally { spy.mockRestore(); }
    });

    it("extracts user prompt events", async () => {
      await registerPiExtension(api);

      // User prompt with decision-like content should extract events
      await api._trigger("user_prompt", {
        message: "Don't use lodash, use native Array methods instead",
      });

      // Should not throw — user events are silently captured
    });

    it("handles missing systemPrompt gracefully", async () => {
      await registerPiExtension(api);

      const result = await api._trigger("before_agent_start", {});

      // Should not throw
      if (result) {
        expect(result).toBeDefined();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 6: Stats command (/ctx-stats)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 6: Stats command", () => {
    it("registers /ctx-stats command", async () => {
      await registerPiExtension(api);

      const cmd = api._getCommand("ctx-stats");
      expect(cmd).toBeDefined();
    });

    it("/ctx-stats returns formatted stats text", async () => {
      await registerPiExtension(api);

      // Capture some events first
      await api._trigger("tool_result", {
        tool_name: "read",
        tool_input: { file_path: "/src/app.ts" },
        tool_result: "export default {}",
      });

      await api._trigger("tool_result", {
        tool_name: "bash",
        tool_input: { command: "git status" },
        tool_result: "On branch main",
      });

      const cmd = api._getCommand("ctx-stats");
      expect(cmd).toBeDefined();
      expect(cmd!.handler).toBeDefined();

      const result = await cmd!.handler!({});

      // Stats should contain formatted text with session info
      expect(result).toBeDefined();
      if (typeof result === "object" && result !== null && "text" in result) {
        const text = (result as { text: string }).text;
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
        // Should contain typical stats output
        expect(text).toMatch(/stat|session|event/i);
      } else if (typeof result === "string") {
        expect(result.length).toBeGreaterThan(0);
        expect(result).toMatch(/stat|session|event/i);
      }
    });

    it("/ctx-stats works with empty session", async () => {
      await registerPiExtension(api);

      const cmd = api._getCommand("ctx-stats");
      expect(cmd).toBeDefined();
      expect(cmd!.handler).toBeDefined();

      // Should not throw even with no events
      const result = await cmd!.handler!({});
      expect(result).toBeDefined();
    });

    it("/ctx-stats treats SQLite started_at as UTC", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-09T12:30:00Z"));

      const originalTZ = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";

      const sessionFile = join(tempDir, "stats-utc-session.jsonl");
      const sessionId = "native-stats-utc-session";

      try {
        await registerPiExtension(api);
        await api._trigger(
          "session_start",
          { type: "session_start", reason: "startup" },
          { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => sessionId } },
        );

        // Issue #645 — Pi extension now resolves the SessionDB file
        // through `resolveSessionDbPath`, the same helper the MCP
        // server uses. The shared "context-mode.db" literal is gone;
        // the file lives at <canonical-hash>.db (case-folded on
        // darwin/win32, worktree-suffixed when applicable). Mirror
        // the production resolver here so this test reads from the
        // exact path the extension just wrote to.
        const { resolveSessionDbPath } = await import("../src/session/db.js");
        const sessionsDir = join(
          process.env.HOME!,
          ".pi",
          "context-mode",
          "sessions",
        );
        const dbPath = resolveSessionDbPath({
          projectDir: process.env.PI_PROJECT_DIR!,
          sessionsDir,
        });
        const db = new SessionDB({ dbPath });
        try {
          // SQLite datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS".
          // If parsed as local time in America/Los_Angeles, this would be
          // 2026-05-09T19:00:00Z and the age would not be 30 minutes.
          db.db
            .prepare(
              "UPDATE session_meta SET started_at = ? WHERE session_id = ?",
            )
            .run("2026-05-09 12:00:00", sessionId);
        } finally {
          db.close();
        }

        const result = await api._getCommand("ctx-stats")!.handler!({});

        expect((result as { text: string }).text).toContain(
          "- Session age: 30m",
        );
      } finally {
        if (originalTZ === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = originalTZ;
        }
        vi.useRealTimers();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 7: Pi-native routing prompt metadata
  // ═══════════════════════════════════════════════════════════

  describe("Slice 7: Routing prompt ownership", () => {
    it("does not inject a static routing message on the first agent turn", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {}, {
        sessionManager: { getSessionFile: () => `routing-1-${Date.now()}-${Math.random()}` },
      });

      await api._trigger("before_agent_start", {
        systemPrompt: "Base prompt.",
      });

      const messages: any[] = [];
      const ctxResult = await api._trigger("context", { messages });

      expect(ctxResult).toBeUndefined();
      expect(messages).toEqual([]);
    });

    it("does not inject a static routing message on subsequent turns", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {}, {
        sessionManager: { getSessionFile: () => `routing-2-${Date.now()}-${Math.random()}` },
      });

      for (let call = 0; call < 3; call++) {
        await api._trigger("before_agent_start", { systemPrompt: "Base." });
        const messages: any[] = [];
        const ctxResult = await api._trigger("context", { messages });
        expect(ctxResult).toBeUndefined();
        expect(messages).toEqual([]);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 8: before_provider_response (Pi-2)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 8: before_provider_response handler", () => {
    it("registers a before_provider_response handler", async () => {
      await registerPiExtension(api);
      expect(api._handlers["before_provider_response"]).toBeDefined();
      expect(api._handlers["before_provider_response"].length).toBeGreaterThan(0);
    });

    it("invokes the handler without throwing on metadata payloads", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {
        session_id: "provider-1",
        project_dir: tempDir,
      });

      await expect(
        api._trigger("before_provider_response", {
          model: "pi-1",
          provider: "pi",
          latencyMs: 42,
          usage: { prompt: 10, completion: 20 },
        }),
      ).resolves.not.toThrow();
    });

    it("handles empty payload gracefully", async () => {
      await registerPiExtension(api);
      await expect(
        api._trigger("before_provider_response", {}),
      ).resolves.not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 8b: before_provider_request — Pi's hardcoded Bash bullet
  // ═══════════════════════════════════════════════════════════

  describe("Slice 8b: before_provider_request payload filtering", () => {
    const hostPrompt = [
      "Guidelines:",
      "- Use bash for file operations like ls, rg, find",
      "- Route all shell commands through ctx_execute or suitable ctx_batch_execute.",
    ].join("\n");

    it("registers a before_provider_request handler", async () => {
      await registerPiExtension(api);
      expect(api._handlers["before_provider_request"]).toBeDefined();
      expect(api._handlers["before_provider_request"].length).toBeGreaterThan(0);
    });

    it("leaves the payload untouched while no Bash replacement is effective", async () => {
      // This suite registers the extension without a native SDK, so the Bash
      // replacement can never become effective and the provider payload — and
      // the bullet that agrees with native Bash — must pass through unchanged.
      await registerPiExtension(api);
      const payload = { model: "pi-1", instructions: hostPrompt };
      await expect(api._trigger("before_provider_request", { payload })).resolves.toBeUndefined();
      expect(payload.instructions).toBe(hostPrompt);
      expect(payload.instructions).toContain("Use bash for file operations like");
    });

    it("never throws on empty or hostile payloads", async () => {
      await registerPiExtension(api);
      for (const payload of [undefined, null, 0, "text", [], new Proxy({}, {
        getOwnPropertyDescriptor() { throw new Error("hostile payload"); },
      })]) {
        await expect(
          api._trigger("before_provider_request", { payload }),
        ).resolves.toBeUndefined();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 9: active_memory always-on + token cap (Pi-3, Pi-4)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 9: active_memory injection", () => {
    it("ordinary prompts never generate active memory", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {
        sessionManager: { getSessionFile: () => `active-mem-1-${Date.now()}-${Math.random()}` },
      });

      // Seed user prompt with role pattern (priority 3).
      await api._trigger("before_agent_start", {
        prompt: "You are a senior staff engineer reviewing this codebase.",
        systemPrompt: "Base.",
      });

      // Subsequent prompts capture but never rebuild recovery.
      await api._trigger("before_agent_start", {
        systemPrompt: "Base 2.",
      });

      // context hook never appends a recovery message
      const ctxResult = await api._trigger("context", { messages: [] });

      expect(ctxResult).toBeUndefined();
      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("many ordinary prompts still produce no recovery message", async () => {
      await registerPiExtension(api);
      await api._trigger("session_start", {
        sessionManager: { getSessionFile: () => `active-mem-2-${Date.now()}-${Math.random()}` },
      });

      // Flood with very long role-pattern prompts (priority 3).
      const longText = "You are a senior staff engineer. " + "x".repeat(500);
      for (let i = 0; i < 20; i++) {
        await api._trigger("before_agent_start", {
          prompt: `${longText} #${i}`,
          systemPrompt: "Base.",
        });
      }

      await api._trigger("before_agent_start", {
        systemPrompt: "Base final.",
      });

      const ctxResult = await api._trigger("context", { messages: [] });
      const content = String(ctxResult?.messages?.[0]?.content ?? "");
      // Issue #856 — flooding with role prompts must NOT accumulate any
      // behavioral_directive, and dynamic session context stays bounded.
      expect(content).not.toContain("<behavioral_directive>");
      expect(content).not.toContain("context-mode active");
      expect(content).toBe("");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 9b (#856): role is NOT re-injected as a standing
  // behavioral_directive every turn (do-nothing-loop fix)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 9b (#856): role not re-injected as behavioral_directive", () => {
    it("never emits <behavioral_directive> in the per-turn context injection, even with a stored role", async () => {
      await registerPiExtension(api);
      const sessionFile = `role-noreinject-${Date.now()}-${Math.random()}`;
      await api._trigger("session_start", {
        sessionManager: { getSessionFile: () => sessionFile },
      });

      // Drive a genuine persona role prompt — extracted into the DB as a
      // priority-3 `role` event. Pre-fix this froze as <behavioral_directive>
      // and was replayed every turn.
      await api._trigger("before_agent_start", {
        prompt: "You are a senior staff engineer reviewing this codebase.",
        systemPrompt: "Base.",
      });

      // Subsequent turn rebuilds context.
      await api._trigger("before_agent_start", { systemPrompt: "Base 2." });
      const ctxResult = await api._trigger("context", { messages: [] });
      const content = String(ctxResult?.messages?.[0]?.content ?? "");

      // The stale role must NOT be pinned as a standing behavioral_directive.
      expect(content).not.toContain("<behavioral_directive>");
    });

    it("does not replay roles or dynamic history on ordinary prompts", async () => {
      await registerPiExtension(api);
      const sessionFile = `role-filter-surgical-${Date.now()}-${Math.random()}`;
      await api._trigger("session_start", {
        sessionManager: { getSessionFile: () => sessionFile },
      });

      await api._trigger("before_agent_start", {
        prompt: "You are a senior staff engineer reviewing this codebase.",
        systemPrompt: "Base.",
      });
      await api._trigger("before_agent_start", { systemPrompt: "Base 2." });
      const ctxResult = await api._trigger("context", { messages: [] });
      const content = String(ctxResult?.messages?.[0]?.content ?? "");

      // Role is filtered out, while independently captured session context
      // remains available. Static routing is supplied by Pi tool metadata.
      expect(content).not.toContain("<behavioral_directive>");
      expect(content).toBe("");
      expect(content).not.toContain("context-mode active");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Registration integrity
  // ═══════════════════════════════════════════════════════════

  describe("Registration integrity", () => {
    it("registers expected event handlers", async () => {
      await registerPiExtension(api);

      // The extension should register handlers for key lifecycle events
      const registeredEvents = Object.keys(api._handlers);
      expect(registeredEvents.length).toBeGreaterThan(0);

      // At minimum, tool_call and tool_result should be handled
      const hasToolCall = registeredEvents.includes("tool_call");
      const hasToolResult = registeredEvents.includes("tool_result");

      // At least one of the core event types should be registered
      expect(hasToolCall || hasToolResult).toBe(true);
    });

    it("does not throw during registration", async () => {
      await expect(registerPiExtension(api)).resolves.not.toThrow();
    });

    it("can be registered multiple times without error", async () => {
      const api1 = createMockPiApi();
      const api2 = createMockPiApi();

      await registerPiExtension(api1, { projectDir: join(tempDir, "reg1") });
      await registerPiExtension(api2, { projectDir: join(tempDir, "reg2") });
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// MCP bridge — bridges context-mode MCP tools into Pi's pi.registerTool()
// surface so the LLM can actually reach ctx_execute / ctx_search / etc.
// (#426). Pi 0.73.x has no native MCP support; without this bridge the
// LLM receives neither callable ctx_* tools nor their prompt metadata.
// ────────────────────────────────────────────────────────────────────────

describe("Pi MCP bridge (#426)", () => {
  let mcpScratch: string;

  beforeEach(() => {
    mcpScratch = mkdtempSync(join(tmpdir(), "ctx-pi-bridge-"));
  });

  afterEach(() => {
    try {
      rmSync(mcpScratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function writeFakeServer(source: string): string {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = join(mcpScratch, `fake-mcp-${Date.now()}-${Math.random()}.mjs`);
    fs.writeFileSync(path, source, "utf-8");
    return path;
  }

  // ── Unit: MCPStdioClient framing & lifecycle ──────────────────────

  describe("MCPStdioClient", () => {
    it("matches request id to response result over newline-delimited JSON", async () => {
      const fakePath = writeFakeServer(`
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null) continue;
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              result: { echoed: msg.method, params: msg.params },
            }) + "\\n");
          }
        });
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        const r1 = await client.request("tools/list", { foo: 1 });
        expect(r1).toEqual({ echoed: "tools/list", params: { foo: 1 } });
        const r2 = await client.request("tools/call", { bar: 2 });
        expect(r2).toEqual({ echoed: "tools/call", params: { bar: 2 } });
      } finally {
        client.shutdown();
      }
    });

    it("matches concurrent in-flight requests by id (out-of-order responses)", async () => {
      // Reverse delays so the slowest goes first — exercises the id-map
      // dispatch, not just FIFO ordering.
      const fakePath = writeFakeServer(`
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null) continue;
            const delay = msg.params?.delay ?? 0;
            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0", id: msg.id, result: { id: msg.id },
              }) + "\\n");
            }, delay);
          }
        });
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        const promises = [50, 40, 30, 20, 10].map((delay, i) =>
          client.request<{ id: number }>("probe", { delay, idx: i }),
        );
        const results = await Promise.all(promises);
        expect(results).toHaveLength(5);
        for (const r of results) expect(typeof r.id).toBe("number");
      } finally {
        client.shutdown();
      }
    });

    it("rejects in-flight requests when the child exits", async () => {
      const fakePath = writeFakeServer(`
        process.stdin.once("data", () => process.exit(0));
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      const promise = client.request("tools/list", {});
      await expect(promise).rejects.toThrow(/exited|MCP/);
      client.shutdown();
    });

    it("times out instead of hanging on a silent server", async () => {
      const fakePath = writeFakeServer(`
        process.stdin.on("data", () => {});
        setInterval(() => {}, 1000);
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        await expect(
          client.request("tools/list", {}, 200),
        ).rejects.toThrow(/timeout/);
      } finally {
        client.shutdown();
      }
    });

    it("ignores non-JSON stdout lines without crashing the parser", async () => {
      const fakePath = writeFakeServer(`
        process.stdout.write("[some startup banner]\\n");
        process.stdout.write("not valid json {{{\\n");
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null) continue;
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
          }
        });
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        const r = await client.request<{ ok: boolean }>("ping", {});
        expect(r.ok).toBe(true);
      } finally {
        client.shutdown();
      }
    });
  });

  // ── Integration: bootstrapMCPTools + real MCP server ──────────────

  describe("bootstrapMCPTools — registers every ctx_* tool with Pi", () => {
    // Lifted out of each `it` so the path resolution lives in one place
    // and a future MCP-entrypoint move only has to change one line.
    const path = require("node:path") as typeof import("node:path");
    const url = require("node:url") as typeof import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const mcpEntry = path.resolve(here, "..", "start.mjs");
    const mcpEnv = { ...process.env, CONTEXT_MODE_DISABLE_VERSION_CHECK: "1" };

    let bridge: { tools: string[]; shutdown: () => void } | null = null;

    afterEach(() => {
      if (bridge) {
        bridge.shutdown();
        bridge = null;
      }
    });

    it("registers the canonical ctx_* tool set with Pi-native prompt metadata", async () => {
      const registered: Array<{
        name: string;
        label: string;
        description: string;
        promptSnippet?: string;
        promptGuidelines?: string[];
        parameters: unknown;
        execute: Function;
      }> = [];
      const fakePi = {
        registerTool: (tool: any) => {
          registered.push(tool);
        },
      };

      const { bootstrapMCPTools } = await import("../src/adapters/pi/mcp-bridge.js");
      bridge = await bootstrapMCPTools(fakePi, mcpEntry, { env: mcpEnv });

      // Pin the canonical agent-facing names. Administrative operations are
      // intentionally absent from the MCP bridge tool catalog.
      expect(bridge.tools).toEqual(
        expect.arrayContaining([
          "ctx_execute",
          "ctx_execute_file",
          "ctx_search",
          "ctx_index",
          "ctx_batch_execute",
          "ctx_fetch_and_index",
        ]),
      );
      expect(bridge.tools).not.toEqual(
        expect.arrayContaining([
          "ctx_doctor",
          "ctx_stats",
          "ctx_upgrade",
          "ctx_purge",
          "ctx_insight",
        ]),
      );

      // Each registration must satisfy the Pi contract.
      for (const reg of registered) {
        expect(reg.name).toMatch(/^ctx_/);
        expect(reg.label).toBe(reg.name);
        expect(typeof reg.description).toBe("string");
        expect(reg.description.length).toBeLessThanOrEqual(1000);
        expect(reg.promptSnippet?.trim().length).toBeGreaterThan(0);
        expect(reg.promptGuidelines?.length).toBeGreaterThan(0);
        for (const guideline of reg.promptGuidelines ?? []) {
          expect(guideline).toMatch(/\bctx_[a-z_]+\b/);
        }
        expect(reg.parameters).toBeTruthy();
        expect(typeof reg.execute).toBe("function");
      }

      for (const name of ["ctx_execute", "ctx_batch_execute"]) {
        const tool = registered.find((reg) => reg.name === name)!;
        expect(tool.description).toContain("Prefer shell with available CLI tools");
        expect(tool.description).toContain("Write custom code when tools are unsuitable");
        expect(tool.description).toContain("hard to express clearly in shell");
        expect(tool.description).toContain("any suitable supported language");
        expect(tool.description).not.toMatch(/javascript|typescript|python/i);
      }
      expect(registered.find((reg) => reg.name === "ctx_execute")?.description)
        .toContain('language: "shell"');

      // P1: with routeAllShell OFF the native Bash tool is a normal tool, so
      // the generic MCP descriptions must pass through untouched. No Pi-only
      // "everything goes through ctx_execute" wording may leak into the
      // disabled state — that would contradict the still-advertised Bash.
      const serverTools = await bridge!.client!.listTools();
      const executeDisabled = registered.find((reg) => reg.name === "ctx_execute")!;
      const serverExecute = serverTools.find((t) => t.name === "ctx_execute")!;
      expect(executeDisabled.description).toBe(serverExecute.description);
      expect(executeDisabled.description).not.toMatch(/In Pi, route ALL shell commands through context-mode/i);
      for (const reg of registered) {
        expect(reg.description).not.toMatch(/In Pi, route ALL shell commands through context-mode/i);
      }

      const batchGuidance = registered
        .find((reg) => reg.name === "ctx_batch_execute")
        ?.promptGuidelines?.join(" ") ?? "";
      expect(batchGuidance).toContain("multiple related commands");
      expect(batchGuidance).toContain("command-based research collection");
      expect(batchGuidance).toContain("command-output gather-and-search");
      expect(batchGuidance).toMatch(/ctx_execute for one command/);
    }, 30_000);

    it("overrides only Pi shell descriptions when the effective Bash policy is active", async () => {
      const registered: any[] = [];
      const { bootstrapMCPTools } = await import("../src/adapters/pi/mcp-bridge.js");
      const handle = await bootstrapMCPTools({ registerTool: tool => { registered.push(tool); } }, mcpEntry, {
        env: mcpEnv, routeAllShell: true,
      });
      bridge = handle;
      const serverTools = await handle.client.listTools();
      for (const name of ["ctx_execute", "ctx_batch_execute"]) {
        const tool = registered.find(t => t.name === name);
        expect(tool.description).toContain("side effects");
        expect(tool.description).toContain("Native bash");
        expect(tool.description.length).toBeLessThanOrEqual(1000);
        expect(tool.description).toContain("Prefer shell with available CLI tools");
        expect(tool.description).toContain("Write custom code when tools are unsuitable");
        expect(tool.description).toContain("hard to express clearly in shell");
        expect(tool.description).toContain("any suitable supported language");
        expect(tool.description).not.toMatch(/javascript|typescript|python/i);
        expect(tool.description).not.toBe(serverTools.find(t => t.name === name)?.description);
        expect(tool.promptGuidelines.join(" ")).toContain("retry");
      }
      // P1: the ACTIVE state must state the Pi routing rule explicitly and must
      // NOT carry the generic "use native host tools" branch that would
      // contradict the Bash recovery-channel policy in the same wire payload.
      const execute = registered.find(t => t.name === "ctx_execute")!;
      expect(execute.description).toMatch(/In Pi, route ALL shell commands through context-mode/i);
      expect(execute.description).toMatch(/small output, navigation, and filesystem mutations/i);
      expect(execute.description).toMatch(/ctx_execute here for a single command or dependent chain/i);
      expect(execute.description).toMatch(/ctx_batch_execute for independent command collection\/search/i);
      expect(execute.description).toMatch(/Native bash is a recovery channel only/i);
      expect(execute.description).toMatch(/Never automatically retry/i);
      expect(execute.description).not.toMatch(/use native host tools/i);
      const batch = registered.find(t => t.name === "ctx_batch_execute")!;
      expect(batch.description).toMatch(/ctx_batch_execute for independent shell command collection\/search/i);
      expect(batch.description).toMatch(/ctx_execute with an explicit shell chain/i);
      // Pi-native snippet list and rules are shared with the disabled state.
      const read = registered.find(t => t.name === "ctx_execute_file");
      expect(read.description).toBe(serverTools.find(t => t.name === "ctx_execute_file")?.description);
    }, 30_000);

    it("execute() round-trips through tools/call to the MCP server", async () => {
      const registered: any[] = [];
      const fakePi = {
        registerTool: (tool: any) => registered.push(tool),
      };

      const { bootstrapMCPTools } = await import("../src/adapters/pi/mcp-bridge.js");
      bridge = await bootstrapMCPTools(fakePi, mcpEntry, { env: mcpEnv });

      const indexTool = registered.find((t) => t.name === "ctx_index");
      expect(indexTool).toBeDefined();

      const marker = `pi-bridge-marker-${process.pid}-${Date.now()}`;
      const result = await indexTool.execute("test-call-1", {
        content: `# heading\n\n${marker}\n`,
        source: "pi-bridge-smoke",
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      // Server returns "Indexed N sections … from: pi-bridge-smoke" on
      // success — pin the source label so a regression in tools/call
      // arg-passing also fails this test.
      expect(result.content[0].text).toMatch(/pi-bridge-smoke/);
      expect(result.isError).toBeFalsy();
    }, 30_000);
  });

  // ── Wiring: before_agent_start must bootstrap MCP tools
  //
  // This is the regression that the rest of the suite does NOT catch: if
  // a future refactor drops the `bootstrapMCPTools(pi, …)` call from the
  // Pi lifecycle wiring but keeps the bridge module intact, every other
  // bridge test stays green and the bug silently re-enters. The bridge is
  // intentionally lazy now (#809): extension discovery alone must not spawn a
  // child, but `before_agent_start` must register at least the canonical ctx_*
  // set before the model call.

  describe("pi-extension.ts wiring (#426 regression guard)", () => {
    it("before_agent_start bootstraps and registers ctx_* via pi.registerTool", async () => {
      const wireApi = createMockPiApi();
      // PI_PROJECT_DIR / CLAUDE_PROJECT_DIR set inside registerPiExtension.
      await registerPiExtension(wireApi, { projectDir: tempDir });

      // Lazy bootstrap: no tool should be registered during extension discovery.
      expect((wireApi.registerTool as any).mock.calls.length).toBe(0);

      const mod = await import("../src/adapters/pi/extension.js");
      await wireApi._trigger("before_agent_start", {
        prompt: "tool registration smoke",
        systemPrompt: "",
      });
      await mod._mcpBridgeReady;

      const calls = (wireApi.registerTool as any).mock.calls as Array<[any]>;
      const registeredNames = calls.map(([t]) => t?.name).filter(Boolean);

      // Same canonical pin as the bridge integration test — but reached
      // through the Pi lifecycle hook instead of bootstrapMCPTools directly,
      // so dropping the wiring fails even when the bridge module still works.
      expect(registeredNames).toEqual(
        expect.arrayContaining([
          "ctx_execute",
          "ctx_search",
          "ctx_index",
          "ctx_batch_execute",
          "ctx_fetch_and_index",
        ]),
      );

      // Cleanup: SIGTERM the bridge child the hook spawned so it does
      // not leak past this test.
      const sd = mod.default as any;
      void sd; // silence unused
      await wireApi._trigger("session_shutdown");
    }, 30_000);

    // Race regression — comment 4412197109 on PR #472.
    //
    // Each Pi subagent spawns a fresh `pi --mode json -p --no-session`
    // process that loads context-mode and then immediately fires
    // `before_agent_start` to dispatch the LLM call. The lazy MCP bridge
    // bootstrap (spawn server.bundle.mjs → initialize → tools/list →
    // pi.registerTool × N) starts in that hook, so without an explicit await
    // the LLM call would go out with an empty ctx_* tool registry: neither
    // the callable tools nor their Pi-native Available tools / Guidelines
    // metadata would be present for that turn.
    //
    // This test pins the contract: by the time `before_agent_start`
    // resolves, the canonical ctx_* tools MUST have been registered
    // through pi.registerTool. The pre-trigger assertion confirms the
    // race window is open (otherwise the test would pass for the wrong
    // reason — bridge happened to win the race).
    it("before_agent_start awaits MCP bridge bootstrap so ctx_* are registered before LLM call", async () => {
      const wireApi = createMockPiApi();
      await registerPiExtension(wireApi, { projectDir: tempDir });

      // Establish a session so before_agent_start does real work
      // (the handler early-returns when `!_sessionId`).
      await wireApi._trigger(
        "session_start",
        {},
        { session_id: "race-test", project_dir: tempDir },
      );

      // Sanity: lazy bootstrap has not started during extension/session setup.
      // If this ever fails, the bridge became eager again and #809 can regress.
      const preCalls = (wireApi.registerTool as any).mock.calls.length;
      expect(preCalls).toBe(0);

      // The race: trigger before_agent_start now. Pi will dispatch the
      // LLM call as soon as this resolves — so the handler MUST block
      // until the bridge has registered ctx_* tools.
      await wireApi._trigger("before_agent_start", {
        sessionID: "race-test",
        prompt: "anything",
        systemPrompt: "",
      });

      const calls = (wireApi.registerTool as any).mock.calls as Array<[any]>;
      const registeredNames = calls.map(([t]) => t?.name).filter(Boolean);
      expect(registeredNames).toEqual(
        expect.arrayContaining([
          "ctx_execute",
          "ctx_search",
          "ctx_index",
          "ctx_batch_execute",
          "ctx_fetch_and_index",
        ]),
      );

      await wireApi._trigger("session_shutdown");
    }, 30_000);
  });

  // ── Pi bridge resilience (#472 round-3) ───────────────────────────
  //
  // Three reliability gaps verified on PR #472 round-3 review:
  //   1. stdio[2] = "ignore" silently swallows server crash logs — when
  //      the MCP child dies during bootstrap the user sees nothing in
  //      stderr, only "ctx_* tools will not be callable from this
  //      session" with no diagnostic of WHY.
  //   2. shutdown() sends SIGTERM and immediately nulls the child handle.
  //      A child that ignores SIGTERM (or hangs on cleanup) becomes a
  //      zombie because no SIGKILL fallback ever fires.
  //   3. session_shutdown does not await `_mcpBridgeReady`. If shutdown
  //      fires while bootstrap is still in flight, `_mcpBridge` is null
  //      → the freshly-spawned MCP child is orphaned once bootstrap
  //      eventually resolves.
  //
  // These tests pin the resilience contract: stderr piped, SIGKILL
  // bounded at 5s, shutdown awaits bridge bootstrap up to 2s.

  describe("Pi bridge resilience (#472 round-3)", () => {
    it("routes child stderr to pi.logger, NOT the TUI terminal (case 1: crash diagnostics; #472 intent / #868)", async () => {
      // Server writes a diagnostic line to stderr then exits non-zero,
      // mimicking a real crash during initialize. With stdio[2] = "ignore"
      // the diagnostic vanishes (#472). We keep capturing it — but route it
      // through `diag` (Pi's file logger), NEVER process.stderr, because Pi's
      // raw-mode TUI renders any console write into the editor box (#868).
      const fakePath = writeFakeServer(`
        process.stderr.write("FAKE_MCP_CRASH_DIAG: bundle corrupted at line 42\\n");
        process.exit(1);
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const logged: string[] = [];
      const client = new MCPStdioClient(fakePath, process.env, null, (line) =>
        logged.push(line),
      );

      // Guard: nothing the child writes may reach process.stderr (Pi's TUI).
      const stderrCaptured: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // @ts-expect-error monkeypatch
      process.stderr.write = (chunk: any, ...rest: any[]) => {
        stderrCaptured.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
        return origWrite(chunk, ...rest);
      };

      try {
        client.start();
        // Give the child time to write its diag line and exit.
        await new Promise((r) => setTimeout(r, 300));
      } finally {
        // @ts-expect-error restore
        process.stderr.write = origWrite;
        client.shutdown();
      }

      const all = logged.join("\n");
      // #472 intent preserved: the crash diagnostic is captured (now in the log)…
      expect(all.includes("FAKE_MCP_CRASH_DIAG")).toBe(true);
      // …with the [mcp-bridge] prefix so ops can grep ~/.omp/logs.
      expect(all.includes("[mcp-bridge]")).toBe(true);
      // #868: it must NOT have been written to the terminal.
      expect(stderrCaptured.join("").includes("FAKE_MCP_CRASH_DIAG")).toBe(false);
    }, 10_000);

    it.skipIf(process.platform === "win32")("escalates to SIGKILL when SIGTERM is ignored (case 2: bounded shutdown)", async () => {
      // Windows has no POSIX signal delivery: child.kill('SIGTERM') maps to
      // TerminateProcess (unblockable), and child.kill('SIGKILL') hits the
      // same syscall. The fake server's `process.on('SIGTERM', ...)` handler
      // never fires, so the SIGKILL-escalation contract that this test pins
      // is fundamentally unobservable on win32. POSIX (Linux/macOS) coverage
      // is sufficient for the resilience guarantee.
      // Child explicitly ignores SIGTERM and refuses to exit. Without a
      // SIGKILL fallback the process leaks indefinitely.
      // Also ignore stdin 'end'/'close' so closing the pipe doesn't end
      // the process — only SIGKILL should be able to terminate this.
      // Emit "READY" on stdout once handlers are registered so the test
      // does not race the spawn (otherwise SIGTERM arrives during Node
      // bootstrap before our handler is registered → default terminate).
      const fakePath = writeFakeServer(`
        process.on("SIGTERM", () => { /* deliberately ignore */ });
        process.on("SIGINT", () => { /* deliberately ignore */ });
        process.on("SIGHUP", () => { /* deliberately ignore */ });
        process.stdin.on("end", () => { /* stay alive */ });
        process.stdin.on("close", () => { /* stay alive */ });
        process.stdin.on("data", () => {});
        setInterval(() => {}, 1000);
        process.stdout.write("READY\\n");
      `);
      const { MCPStdioClient } = await import("../src/adapters/pi/mcp-bridge.js");
      const client = new MCPStdioClient(fakePath);
      client.start();

      // Reach into the private child handle for the assertion. Tests
      // already do this elsewhere and the field is the only way to
      // observe the OS-level lifecycle without a polling sentinel.
      const childRef: any = (client as any).child;
      expect(childRef).toBeTruthy();
      expect(childRef.killed).toBe(false);

      // Wait for "READY" — confirms SIGTERM handler is installed.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child never READY")), 3000);
        childRef.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf-8").includes("READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        childRef.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
          resolve({ code, signal });
        });
      });

      const t0 = Date.now();
      client.shutdown();

      // Bounded by the 5s SIGKILL timer — give it a small grace window.
      const result = await Promise.race([
        exitPromise.then((r) => ({ ...r, timedOut: false })),
        new Promise<{ code: null; signal: null; timedOut: true }>((r) =>
          setTimeout(() => r({ code: null, signal: null, timedOut: true }), 7500),
        ),
      ]);
      const elapsedMs = Date.now() - t0;

      // Must NOT have timed out — that would mean no SIGKILL fallback.
      expect(result.timedOut).toBe(false);
      // Killed by signal (SIGKILL) — Node's behavior across platforms:
      // signal field populated when killed by signal.
      expect(result.signal).toBe("SIGKILL");
      // Bounded at ~5s — assert lower bound (escalation, not immediate)
      // and upper bound (not hung beyond the 5s ceiling + grace).
      expect(elapsedMs).toBeGreaterThanOrEqual(4500);
      expect(elapsedMs).toBeLessThan(7000);
    }, 15_000);

    it.skipIf(process.platform === "win32")("session_shutdown awaits bridge bootstrap so child is not orphaned (case 3: race)", async () => {
      // Windows ChildProcess.killed/exitCode/signalCode lifecycle for
      // tsx-spawned MCP children races with TerminateProcess in CI in a way
      // that produces a false-negative for the dead-child assertion. The
      // shutdown-await contract this test pins is platform-agnostic logic
      // (the await on _mcpBridgeReady) — POSIX coverage exercises the race.
      // Repro: trigger session_shutdown WHILE bootstrap is still in
      // flight. Without an await on `_mcpBridgeReady`, _mcpBridge is
      // null at shutdown time → the bootstrap eventually resolves and
      // a live MCP child stays orphaned for the rest of the process.
      //
      // Instrument bootstrapMCPTools by patching the bridge module's
      // `bootstrapMCPTools` to capture the resolved BridgeHandle, then
      // check its underlying client.child after shutdown completes.
      const wireApi = createMockPiApi();

      const bridgeMod = await import("../src/adapters/pi/mcp-bridge.js");
      const handles: any[] = [];
      const origBootstrap = bridgeMod.bootstrapMCPTools;
      let markBootstrapEntered!: () => void;
      const bootstrapEntered = new Promise<void>((resolve) => {
        markBootstrapEntered = resolve;
      });
      let releaseBootstrap!: () => void;
      const bootstrapRelease = new Promise<void>((resolve) => {
        releaseBootstrap = resolve;
      });
      const spy = vi
        .spyOn(bridgeMod, "bootstrapMCPTools")
        .mockImplementation(async (...args: any[]) => {
          markBootstrapEntered();
          const handle = await (origBootstrap as any)(...args);
          handles.push(handle);
          await bootstrapRelease;
          return handle;
        });

      try {
        await registerPiExtension(wireApi, { projectDir: tempDir });

        const mod = await import("../src/adapters/pi/extension.js");

        // Lazy bootstrap now starts from before_agent_start. Fire shutdown while
        // that bootstrap promise is still pending, then release it so shutdown's
        // bounded await can see and terminate the real handle.
        const agentStart = wireApi._trigger("before_agent_start", {
          prompt: "race",
          systemPrompt: "",
        });
        await bootstrapEntered;
        const shutdown = wireApi._trigger("session_shutdown");
        releaseBootstrap();
        await shutdown;
        await agentStart;

        // Wait for the in-flight bootstrap to settle. By this point the
        // child has been spawned. If session_shutdown did NOT await
        // _mcpBridgeReady, the bridge handle resolves AFTER shutdown
        // returned → the child is alive and orphaned.
        await mod._mcpBridgeReady;
        await new Promise((r) => setTimeout(r, 300));

        expect(handles.length).toBeGreaterThan(0);
        for (const handle of handles) {
          const child = (handle.client as any).child;
          // After session_shutdown, the bridge child must be dead OR
          // the bridge handle's internal child reference must be null
          // (already cleaned via shutdown()). If it's a live ChildProcess
          // with no exit signal, the orphan bug is present.
          if (child) {
            const dead =
              child.killed ||
              child.exitCode !== null ||
              child.signalCode !== null;
            expect(dead).toBe(true);
          }
        }
      } finally {
        spy.mockRestore();
        for (const handle of handles) {
          try {
            handle.shutdown();
          } catch {
            /* best effort */
          }
        }
      }
    }, 30_000);

    it("shuts down a bridge handle that resolves after the shutdown timeout", async () => {
      const wireApi = createMockPiApi();
      const bridgeMod = await import("../src/adapters/pi/mcp-bridge.js");

      const staleShutdown = vi.fn();
      const staleHandle = {
        tools: [],
        shutdown: staleShutdown,
        client: { _spawnEnv: null } as unknown as InstanceType<
          typeof bridgeMod.MCPStdioClient
        >,
      };

      let resolveBootstrap!: (handle: typeof staleHandle) => void;
      const bootstrapPromise = new Promise<typeof staleHandle>((resolve) => {
        resolveBootstrap = resolve;
      });
      const spy = vi
        .spyOn(bridgeMod, "bootstrapMCPTools")
        .mockImplementation(async () => bootstrapPromise as any);

      try {
        await registerPiExtension(wireApi, { projectDir: tempDir });

        const agentStart = wireApi._trigger("before_agent_start", {
          prompt: "late-bootstrap-race",
          systemPrompt: "",
        });
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(1);

        // Let session_shutdown hit its 2s ceiling while bootstrap is still
        // pending. The late bootstrap resolution below must not publish a stale
        // handle; it must self-shutdown the handle instead.
        await wireApi._trigger("session_shutdown");
        expect(staleShutdown).not.toHaveBeenCalled();

        resolveBootstrap(staleHandle);
        await agentStart;
        await Promise.resolve();

        expect(staleShutdown).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    }, 10_000);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #473 round-3: extension MUST route session dir through PiAdapter
// rather than re-encoding the ~/.pi/context-mode/sessions literal. Any
// drift (e.g., PiAdapter changes the segment list) would silently desync
// otherwise — extension keeps writing to ~/.pi while the rest of the
// harness reads from the new location.
// ────────────────────────────────────────────────────────────────────────

describe("Pi extension respects PiAdapter session dir (#473 round-3)", () => {
  let scratch: string;
  let mockedSessionDir: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "pi-ext-r3-"));
    mockedSessionDir = join(scratch, "custom-pi-sess");
    mkdirSync(mockedSessionDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    vi.doUnmock("../src/adapters/pi/index.js");
    vi.resetModules();
  });

  it("opens SessionDB at the path returned by PiAdapter.getSessionDir, not at ~/.pi literal", async () => {
    vi.doMock("../src/adapters/pi/index.js", () => {
      class MockPiAdapter {
        getSessionDir() {
          return mockedSessionDir;
        }
      }
      return { PiAdapter: MockPiAdapter };
    });

    const projectDir = join(scratch, "project");
    mkdirSync(projectDir, { recursive: true });
    process.env.PI_PROJECT_DIR = projectDir;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    const localApi = createMockPiApi();
    const mod = await import("../src/adapters/pi/extension.js");
    await mod.default(localApi);

    await localApi._trigger("session_start", {}, {});

    // DB file must be created under the mocked dir — proof that the
    // extension routes through PiAdapter rather than the hardcoded
    // ~/.pi/context-mode/sessions literal. Issue #645: the filename
    // inside that dir is the canonical per-project `<hash>.db`, the
    // same one the MCP server reads via `resolveSessionDbPath`.
    const { resolveSessionDbPath } = await import("../src/session/db.js");
    const expectedDbPath = resolveSessionDbPath({
      projectDir,
      sessionsDir: mockedSessionDir,
    });
    const { existsSync: fileExists } = await import("node:fs");
    expect(fileExists(expectedDbPath)).toBe(true);

    // Also assert the doctor command surfaces the mocked path so
    // future contributors do not silently regress (it reads getDBPath()).
    const doctor = localApi._getCommand("ctx-doctor");
    expect(doctor?.handler).toBeDefined();
    const result = await doctor!.handler!({}, { hasUI: false });
    const text = String((result as { text?: string } | undefined)?.text ?? "");
    expect(text).toContain(mockedSessionDir);

    await localApi._trigger("session_shutdown");

    delete process.env.PI_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });
});

// ═══════════════════════════════════════════════════════════
// Pi package skill visibility
// ═══════════════════════════════════════════════════════════

describe("Pi package skill visibility", () => {
  it("keeps ctx-index and ctx-search as manual slash skills only", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const url = require("node:url") as typeof import("node:url");
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
    const frontmatter = (name: string) => {
      const source = fs.readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8");
      return source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    };

    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.pi.skills).toContain("./skills");
    expect(frontmatter("context-mode")).not.toMatch(/^disable-model-invocation:\s*true$/m);
    expect(frontmatter("ctx-index")).toMatch(/^disable-model-invocation:\s*true$/m);
    expect(frontmatter("ctx-index")).toContain("/skill:ctx-index");
    expect(frontmatter("ctx-search")).toMatch(/^disable-model-invocation:\s*true$/m);
    expect(frontmatter("ctx-search")).toContain("/skill:ctx-search");
  });

  it("keeps the model-visible skill consistent with batch-first routing", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const url = require("node:url") as typeof import("node:url");
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
    const source = fs.readFileSync(
      path.join(root, "skills", "context-mode", "SKILL.md"),
      "utf8",
    );
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

    expect(frontmatter).toContain("ctx_batch_execute");
    expect(source).toMatch(
      /multiple related commands[\s\S]{0,220}ctx_batch_execute[\s\S]{0,40}before[\s\S]{0,20}ctx_execute/i,
    );

    const indexedRoute = source.indexOf("Searching already-indexed content");
    const fetchRoute = source.indexOf("Fetching web documentation");
    const fileRoute = source.indexOf("Reading a file to analyze");
    const batchRoute = source.indexOf("Multiple related shell/CLI commands");
    const singleRoute = source.indexOf("One shell/CLI command MIGHT");
    expect(indexedRoute).toBeGreaterThan(0);
    expect(fetchRoute).toBeGreaterThan(0);
    expect(fileRoute).toBeGreaterThan(0);
    expect(batchRoute).toBeGreaterThan(indexedRoute);
    expect(batchRoute).toBeGreaterThan(fetchRoute);
    expect(batchRoute).toBeGreaterThan(fileRoute);
    expect(singleRoute).toBeGreaterThan(batchRoute);
  });
});

// ═══════════════════════════════════════════════════════════
// Issue #645 — Pi extension opens SessionDB at the canonical
// per-project hash path (`<hash>.db`), the same file the MCP
// server reads via `resolveSessionDbPath`. The shared
// `context-mode.db` literal is divergent — `ctx_stats` and
// `ctx_search(sort: "timeline")` silently degrade because the
// MCP server resolves a `<hash>.db` that does not exist.
// Regression test pins the contract: Pi must use the canonical
// helper, NOT the hardcoded literal.
// ═══════════════════════════════════════════════════════════

describe("Pi extension SessionDB path matches MCP server's canonical resolver (#645)", () => {
  let scratch: string;
  let mockedSessionDir: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "pi-ext-645-"));
    mockedSessionDir = join(scratch, "pi-sess");
    mkdirSync(mockedSessionDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    vi.doUnmock("../src/adapters/pi/index.js");
    vi.resetModules();
    delete process.env.PI_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it("writes SessionDB to resolveSessionDbPath({projectDir, sessionsDir}), not the shared 'context-mode.db' literal", async () => {
    vi.doMock("../src/adapters/pi/index.js", () => {
      class MockPiAdapter {
        getSessionDir() {
          return mockedSessionDir;
        }
      }
      return { PiAdapter: MockPiAdapter };
    });

    const projectDir = join(scratch, "project");
    mkdirSync(projectDir, { recursive: true });
    process.env.PI_PROJECT_DIR = projectDir;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    const localApi = createMockPiApi();
    const mod = await import("../src/adapters/pi/extension.js");
    await mod.default(localApi);

    await localApi._trigger("session_start", {}, {});

    // The MCP server (src/server.ts) resolves the SessionDB path via
    // resolveSessionDbPath({ projectDir, sessionsDir }). The Pi
    // extension MUST write to the same file. Compute the canonical
    // path with the SAME helper the server uses and require it to
    // exist on disk after session_start.
    const { resolveSessionDbPath } = await import("../src/session/db.js");
    const canonicalPath = resolveSessionDbPath({
      projectDir,
      sessionsDir: mockedSessionDir,
    });
    const { existsSync: fileExists } = await import("node:fs");
    expect(fileExists(canonicalPath)).toBe(true);

    // The shared literal must NOT be created — that was the bug.
    const buggyLiteralPath = join(mockedSessionDir, "context-mode.db");
    // Only fail the "no literal" check when canonical ≠ literal.
    // (They differ for any real projectDir → 16-hex hash.)
    if (canonicalPath !== buggyLiteralPath) {
      expect(fileExists(buggyLiteralPath)).toBe(false);
    }

    // ctx-doctor must surface the same canonical path so users
    // diagnosing degraded ctx_stats see the actual on-disk file.
    const doctor = localApi._getCommand("ctx-doctor");
    expect(doctor?.handler).toBeDefined();
    const result = await doctor!.handler!({}, { hasUI: false });
    const text = String((result as { text?: string } | undefined)?.text ?? "");
    expect(text).toContain(canonicalPath);

    await localApi._trigger("session_shutdown");
  });
});
