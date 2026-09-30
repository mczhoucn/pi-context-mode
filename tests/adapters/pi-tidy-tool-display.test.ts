import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeToolReplacements } from "../../src/adapters/pi/tool-replacement-settings.js";
import {
  loadTidyToolDisplaySettings,
  normalizeTidyToolDisplay,
} from "../../src/adapters/pi/tidy-tool-display-settings.js";
import {
  createTidyRenderers,
  displayTarget,
  omitDisplayReasoning,
  renderTidyLines,
  selectDisplaySchema,
  type DisplayTheme,
} from "../../src/adapters/pi/tidy-tool-display.js";
import { PiTextComponent, bootstrapMCPTools, MCPStdioClient, visibleAnsiWidth } from "../../src/adapters/pi/mcp-bridge.js";
import { installToolReplacements, type NativeToolSDK } from "../../src/adapters/pi/tool-replacements.js";

const theme: DisplayTheme = {
  bold: (text) => `*${text}*`,
  fg: (color, text) => `[${color}]${text}`,
  bg: (color, text) => `{${color}}${text}`,
};
const baseSchema = {
  type: "object",
  properties: { code: { type: "string" } },
  required: ["code"],
};

function save(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("tidy display settings", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("defaults off, lets an explicit project boolean override, and ignores old keys", () => {
    const warn = vi.fn();
    expect(normalizeTidyToolDisplay([], warn)).toEqual({ enabled: false });
    expect(warn).not.toHaveBeenCalled();
    expect(normalizeTidyToolDisplay([
      { tidyToolDisplay: { enabled: true }, purposeDisplay: { enabled: true } },
      { extensionAdapters: { "pi-tool-display-intent": { enabled: true } } },
    ], warn)).toEqual({ enabled: true });
    expect(normalizeTidyToolDisplay([
      { tidyToolDisplay: { enabled: true } },
      { tidyToolDisplay: { enabled: false } },
    ], warn)).toEqual({ enabled: false });
    expect(normalizeTidyToolDisplay([
      { tidyToolDisplay: { enabled: false } },
      { tidyToolDisplay: {} },
    ], warn)).toEqual({ enabled: false });
  });

  it("disables only this switch when its value is invalid, without touching replacements", () => {
    const documents = [{
      tidyToolDisplay: { enabled: "yes" },
      toolReplacements: { bash: { enabled: true }, read: { enabled: true } },
    }];
    const warn = vi.fn();
    expect(normalizeTidyToolDisplay(documents, warn)).toEqual({ enabled: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tidyToolDisplay.enabled"));
    expect(normalizeToolReplacements(documents, vi.fn()).bash.enabled).toBe(true);
    expect(normalizeTidyToolDisplay([
      { tidyToolDisplay: { enabled: true } },
      { toolReplacements: null },
    ], vi.fn())).toEqual({ enabled: true });
    expect(normalizeTidyToolDisplay([
      null,
      { tidyToolDisplay: { enabled: true } },
    ], warn).enabled).toBe(false);
  });

  it("reads only context-mode Pi settings, not tidy or generic Pi settings", () => {
    root = mkdtempSync(join(tmpdir(), "ctx-tidy-display-"));
    save(join(root, ".pi", "agent", "context-mode", "settings.json"), JSON.stringify({ tidyToolDisplay: { enabled: true } }));
    save(join(root, ".pi", "context-mode", "settings.json"), JSON.stringify({ tidyToolDisplay: { enabled: false } }));
    save(join(root, ".pi", "agent", "pi-tidy-tools.json"), JSON.stringify({ enabled: true }));
    save(join(root, ".pi", "settings.json"), JSON.stringify({ tidyToolDisplay: { enabled: true } }));
    expect(loadTidyToolDisplaySettings(root, vi.fn(), root)).toEqual({ enabled: false });
    save(join(root, ".pi", "agent", "context-mode", "settings.json"), "{");
    const warn = vi.fn();
    expect(loadTidyToolDisplaySettings(root, warn, root)).toEqual({ enabled: false });
    expect(warn).toHaveBeenCalled();
  });
});

describe("tidy display contract", () => {
  it("adds required reasoning on a copy and leaves an owned field untouched", () => {
    const selected = selectDisplaySchema(baseSchema, true);
    expect(selected.injected).toBe(true);
    expect(selected.schema).not.toBe(baseSchema);
    expect(baseSchema.required).toEqual(["code"]);
    expect(baseSchema.properties).not.toHaveProperty("reasoning");
    const published = selected.schema as { required: string[]; properties: Record<string, { description?: string }> };
    expect(published.required[0]).toBe("reasoning");
    expect(published.properties.reasoning.description).toMatch(/user's language/);
    const owned = { type: "object", properties: { reasoning: { type: "string" } }, required: ["reasoning"] };
    expect(selectDisplaySchema(owned, true)).toEqual({ schema: owned, injected: false });
    expect(selectDisplaySchema(baseSchema, false).schema).toBe(baseSchema);
  });

  it("drops only the display field from a copy", () => {
    const params = { code: "echo ok", reasoning: "show the marker", intent: "keep" };
    expect(omitDisplayReasoning(params)).toEqual({ code: "echo ok", intent: "keep" });
    expect(params.reasoning).toBe("show the marker");
    expect(omitDisplayReasoning({ code: "echo ok", reasoning: "  " })).toEqual({ code: "echo ok" });
    expect(omitDisplayReasoning({ code: "echo ok", reasoning: 1 })).toEqual({ code: "echo ok" });
    expect(omitDisplayReasoning(undefined)).toEqual({});
  });

  it("paints two folded lines and falls back without repeating the tool name", () => {
    const withPurpose = renderTidyLines("ctx_execute", { reasoning: "show the marker", code: "echo ok" }, undefined, { expanded: false, isPartial: true }, theme);
    expect(withPurpose).toContain("\x1b[35m\x1b[1mctx_execute\x1b[0m");
    expect(withPurpose).toContain("[text]show the marker");
    expect(withPurpose).not.toContain("[toolOutput]show the marker");
    expect(withPurpose).toContain("echo ok");
    expect(withPurpose).toContain("indexing/searching...");
    const fallback = renderTidyLines("bash", { command: "printf ok" }, { content: [{ type: "text", text: "ok" }] }, { expanded: false, isPartial: false }, theme);
    expect(fallback).toContain("\x1b[35m\x1b[1mbash\x1b[0m");
    expect(fallback).toContain("printf ok");
    expect(fallback).toContain("ok");
    expect(fallback.match(/\x1b\[35m\x1b\[1mbash\x1b\[0m/g)).toHaveLength(1);
    const nameOnly = renderTidyLines("ctx_doctor", {}, { content: [{ type: "text", text: "" }] }, { expanded: false, isPartial: false }, theme);
    expect(nameOnly).toContain("\x1b[35m\x1b[1mctx_doctor\x1b[0m");
    expect(nameOnly).not.toContain("ctx_doctor [toolOutput]ctx_doctor");
    const expanded = renderTidyLines("read", { path: "a.ts", reasoning: "show the marker" }, { content: [{ type: "text", text: "full\noutput" }] }, { expanded: true, isPartial: false }, theme);
    expect(expanded).toContain("\x1b[36m\x1b[1mread\x1b[0m");
    expect(expanded).not.toContain("\x1b[35m\x1b[1mread");
    expect(expanded).toContain("[text]show the marker");
    expect(expanded).toContain("full\noutput");
    expect(displayTarget("ctx_search", { queries: ["first", "second"] })).toBe("first");
    expect(displayTarget("ctx_fetch_and_index", { requests: [{ url: "https://example.test" }] })).toBe("https://example.test");
    expect(displayTarget("ctx_execute", { code: "echo ok" })).toBe("echo ok");
  });

  it("shows the in-progress block from the call renderer and the finished block from the result renderer", () => {
    const renderers = createTidyRenderers("ctx_execute", PiTextComponent);
    const running = renderers.renderCall({ reasoning: "show the marker", code: "echo ok" }, theme, { isPartial: true });
    expect(running.render(80).join("\n")).toContain("show the marker");
    expect(renderers.renderCall({}, theme, { isPartial: false }).render(80)).toEqual([]);
    expect(renderers.renderResult({ content: [{ type: "text", text: "ok" }] }, { expanded: false, isPartial: true }, theme, {}).render(80)).toEqual([]);
    const done = renderers.renderResult(
      { content: [{ type: "text", text: "ok" }] },
      { expanded: false, isPartial: false },
      theme,
      { args: { reasoning: "show the marker", code: "echo ok" } },
    );
    expect(done.render(120).join("\n")).toContain("ok");
  });

  it("paints every visible line to the row edge, including the expanded header", () => {
    const painted: string[] = [];
    const filling: DisplayTheme = {
      ...theme,
      bg: (color, text) => {
        painted.push(`${color}:${text}`);
        return `{${color}}${text}`;
      },
    };
    const renderers = createTidyRenderers("ctx_execute", PiTextComponent);
    const running = renderers.renderCall({ reasoning: "查看", code: "echo ok" }, filling, { isPartial: true });
    running.render(12);
    expect(painted.every((entry) => entry.startsWith("toolPendingBg:"))).toBe(true);
    const pendingPlain = painted.filter((entry) => !entry.includes("\x1b[0m"));
    expect(pendingPlain.length).toBeGreaterThan(0);
    expect(pendingPlain.every((entry) => visibleAnsiWidth(entry.slice(entry.indexOf(":") + 1)) === 12)).toBe(true);

    painted.length = 0;
    const expanded = renderers.renderResult(
      { content: [{ type: "text", text: "full\n\noutput\x1b[0m!" }] },
      { expanded: true, isPartial: false },
      filling,
      { args: { reasoning: "show the marker", code: "echo ok" } },
    );
    const lines = expanded.render(80);
    expect(lines[0]).toContain("\x1b[35m\x1b[1mctx_execute\x1b[0m");
    expect(lines[0]).toContain("show the marker");
    expect(lines.join("\n")).toContain("full");
    expect(lines.join("\n")).toContain("output");
    expect(painted.length).toBeGreaterThanOrEqual(4);
    expect(painted.every((entry) => entry.startsWith("toolSuccessBg:"))).toBe(true);
    const widthOf = (entry: string) => visibleAnsiWidth(entry.slice(entry.indexOf(":") + 1));
    expect(painted.filter((entry) => !entry.includes("\x1b[0m")).every((entry) => widthOf(entry) === 80)).toBe(true);
    const resetParts = painted.filter((entry) => entry.includes("\x1b[0m"));
    expect(resetParts.length).toBeGreaterThan(1);
    expect(resetParts.some((entry) => entry.includes(" \x1b[0m"))).toBe(true);
  });
});

describe("replacement display", () => {
  function fixture() {
    const bashExecute = vi.fn(async () => ({ content: [{ type: "text", text: "native" }] }));
    const schema = {
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "number" } },
      required: ["command"],
    };
    const sdk = {
      createBashToolDefinition: () => ({
        name: "bash",
        label: "Bash",
        description: "native recovery",
        parameters: schema,
        execute: bashExecute,
        renderResult: vi.fn(),
      }),
    } as unknown as NativeToolSDK;
    const tools = [{ ...sdk.createBashToolDefinition(), sourceInfo: { source: "builtin" } }];
    const pi = {
      getAllTools: vi.fn(() => tools),
      registerTool: vi.fn((tool: { name: string; description: string }) => {
        tools[0] = { ...tool, sourceInfo: { source: "extension" } };
      }),
    };
    return { pi, sdk, tools, bashExecute, schema };
  }

  it("leaves the native tool unchanged when the flag is off", () => {
    const { pi, sdk, tools, bashExecute } = fixture();
    expect(installToolReplacements(pi, "/tmp", { bash: { enabled: true }, read: { enabled: false, maxLines: 1, maxBytes: 1 } }, sdk, vi.fn())).toEqual({ bash: true, read: false });
    expect(tools[0].execute).toBe(bashExecute);
    expect(tools[0].parameters).not.toHaveProperty("properties.reasoning");
  });

  it("strips reasoning before native execute and still runs when it is missing", async () => {
    const { pi, sdk, tools, bashExecute } = fixture();
    const settings = { bash: { enabled: true }, read: { enabled: false, maxLines: 1, maxBytes: 1 } };
    expect(installToolReplacements(pi, "/tmp", settings, sdk, vi.fn(), { tidyToolDisplay: true })).toEqual({ bash: true, read: false });
    const args = { command: "printf ok", reasoning: "show the marker" };
    await tools[0].execute("id", args, undefined, undefined, undefined);
    expect(bashExecute).toHaveBeenCalledWith("id", { command: "printf ok" }, undefined, undefined, undefined);
    expect(args.reasoning).toBe("show the marker");
    await tools[0].execute("id", { command: "printf ok" }, undefined, undefined, undefined);
    await tools[0].execute("id", { command: "printf ok", reasoning: " " }, undefined, undefined, undefined);
    await tools[0].execute("id", { command: "printf ok", reasoning: false }, undefined, undefined, undefined);
    expect(bashExecute).toHaveBeenCalledTimes(4);
  });

  it("does not take a foreign bash tool just because the display flag is on", () => {
    const { pi, sdk, tools } = fixture();
    tools[0].sourceInfo.source = "extension";
    const warn = vi.fn();
    expect(installToolReplacements(pi, "/tmp", { bash: { enabled: true }, read: { enabled: false, maxLines: 1, maxBytes: 1 } }, sdk, warn, { tidyToolDisplay: true })).toEqual({ bash: false, read: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bash replacement skipped"));
    expect(pi.registerTool).not.toHaveBeenCalled();
  });
});

describe("bridge display", () => {
  afterEach(() => vi.restoreAllMocks());

  it("strips reasoning before the MCP call and does not mutate the shared schema", async () => {
    const schema = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };
    vi.spyOn(MCPStdioClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(MCPStdioClient.prototype, "initialize").mockResolvedValue(undefined);
    vi.spyOn(MCPStdioClient.prototype, "listTools").mockResolvedValue([
      { name: "ctx_execute", description: "run", inputSchema: schema },
      { name: "ctx_owned", description: "owned", inputSchema: { type: "object", properties: { reasoning: { type: "string" } }, required: ["reasoning"] } },
    ]);
    const callTool = vi.spyOn(MCPStdioClient.prototype, "callTool").mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const registered: Array<{ name: string; parameters: unknown; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    await bootstrapMCPTools(
      { registerTool: (tool) => registered.push(tool) },
      "/unused/server.mjs",
      { tidyToolDisplay: true, _resolveJsRuntime: () => "node", env: {} },
    );
    const execute = registered.find((tool) => tool.name === "ctx_execute")!;
    const owned = registered.find((tool) => tool.name === "ctx_owned")!;
    expect(execute.parameters).not.toBe(schema);
    expect(schema.properties).not.toHaveProperty("reasoning");
    expect(owned.parameters).toEqual({ type: "object", properties: { reasoning: { type: "string" } }, required: ["reasoning"] });
    const params = { code: "echo ok", reasoning: "show the marker" };
    await execute.execute("id", params);
    expect(callTool).toHaveBeenCalledWith("ctx_execute", { code: "echo ok" });
    expect(params.reasoning).toBe("show the marker");
    await owned.execute("id", { reasoning: "keep me" });
    expect(callTool).toHaveBeenCalledWith("ctx_owned", { reasoning: "keep me" });
  });
});

describe("extension passes the display flag once", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PI_WORKSPACE_DIR;
    delete process.env.PI_PROJECT_DIR;
  });

  it("does not turn shell routing on when only the display flag is enabled", async () => {
    vi.resetModules();
    const root = mkdtempSync(join(tmpdir(), "ctx-tidy-extension-"));
    process.env.PI_WORKSPACE_DIR = root;
    process.env.PI_PROJECT_DIR = root;
    try {
      const settings = await import("../../src/adapters/pi/tidy-tool-display-settings.js");
      const replacements = await import("../../src/adapters/pi/tool-replacements.js");
      const bridge = await import("../../src/adapters/pi/mcp-bridge.js");
      const load = vi.spyOn(settings, "loadTidyToolDisplaySettings").mockReturnValue({ enabled: true });
      const install = vi.spyOn(replacements, "installToolReplacements").mockReturnValue({ bash: false, read: false });
      const bootstrap = vi.spyOn(bridge, "bootstrapMCPTools").mockResolvedValue({
        tools: [],
        shutdown() {},
        client: {} as InstanceType<typeof bridge.MCPStdioClient>,
      });
      const { default: piExtension } = await import("../../src/adapters/pi/extension.js");
      const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
      piExtension({
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
          (handlers[event] ??= []).push(handler);
        },
        registerCommand: () => {},
        registerTool: () => {},
        sendMessage: () => {},
      });
      const trigger = async (event: string, ...args: unknown[]) => {
        for (const handler of handlers[event] ?? []) await handler(...args);
      };
      await trigger("session_start", { reason: "new" }, {});
      await trigger("before_agent_start", { prompt: "hi" }, { hasUI: false });
      expect(load).toHaveBeenCalledTimes(1);
      expect(install).toHaveBeenCalledWith(
        expect.anything(),
        root,
        expect.anything(),
        undefined,
        expect.any(Function),
        { tidyToolDisplay: true },
      );
      expect(bootstrap).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({ tidyToolDisplay: true, routeAllShell: false }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
