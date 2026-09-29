import "../setup-home";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToolReplacementSettings, normalizeToolReplacements, DEFAULT_READ_LIMITS } from "../../src/adapters/pi/tool-replacement-settings.js";
import { DEFAULT_DISABLED_BUILTIN_FEATURES } from "../../src/adapters/pi/builtin-feature-settings.js";
import { createBoundedRead, formatReadText, installToolReplacements, type NativeDefinition, type NativeToolSDK, type ReadOperations } from "../../src/adapters/pi/tool-replacements.js";
import { piToolPresentation } from "../../src/adapters/pi/mcp-bridge.js";

// Deliberately injectable SDK contract double. A separate installed-host smoke
// test exercises the actual truncateHead, reader and compiled Pi loader boundary.
function sdkFixture() {
  const bashExecute = vi.fn(async () => ({ content: [{ type: "text", text: "native bash" }], details: { marker: true } }));
  const renderResult = vi.fn();
  const executions = vi.fn();
  const schemas = {
    bash: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] },
    read: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
  };
  const truncateHead: NativeToolSDK["truncateHead"] = (text, limits) => {
    const lines = text.split("\n");
    let output: string[] = [];
    let by: "lines" | "bytes" | null = null;
    for (const line of lines) {
      if (output.length === limits.maxLines) { by = "lines"; break; }
      if (Buffer.byteLength([...output, line].join("\n")) > limits.maxBytes) { by = "bytes"; break; }
      output.push(line);
    }
    const content = output.join("\n");
    return { content, truncated: by !== null, truncatedBy: by, totalLines: lines.length,
      totalBytes: Buffer.byteLength(text), outputLines: text === "" ? 0 : output.length, outputBytes: Buffer.byteLength(content),
      lastLinePartial: false, firstLineExceedsLimit: output.length === 0, ...limits };
  };
  const sdk: NativeToolSDK = {
    truncateHead,
    detectSupportedImageMimeTypeFromFile: vi.fn(async () => null),
    createBashToolDefinition: () => ({
      name: "bash", label: "Bash", description: "native",
      promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
      promptGuidelines: ["Use native bash for shell work."],
      parameters: schemas.bash, execute: bashExecute, renderResult,
    }),
    createReadToolDefinition: (_cwd, options) => ({
      name: "read", label: "Read", description: "native", parameters: schemas.read, renderResult,
      prepareArguments: { native: true },
      async execute(id, args, signal, update, ctx) {
        executions(id, args, signal, update, ctx);
        if (signal?.aborted) throw new Error("Operation aborted");
        const ops = options!.operations;
        await ops.access(args.path);
        const mime = await ops.detectImageMimeType(args.path);
        const buffer = await ops.readFile(args.path);
        if (mime) return { content: [{ type: "text", text: "image processing warning" }], details: { image: true } };
        const total = buffer.toString("utf8").split("\n").length;
        if ((args.offset ?? 1) > total) throw new Error(`Offset ${args.offset} is beyond end of file (${total} lines total)`);
        return { content: [{ type: "text", text: "NATIVE FIXED LIMIT NOTICE — must not be parsed" }], details: { marker: true, truncation: { maxBytes: 51200 } } };
      },
    }),
  };
  const tools: Array<NativeDefinition & { sourceInfo: { source: string } }> = [sdk.createBashToolDefinition("."), sdk.createReadToolDefinition(".")].map(t => ({ ...t, sourceInfo: { source: "builtin" } }));
  const pi = {
    getAllTools: vi.fn(() => tools),
    registerTool: vi.fn((tool: NativeDefinition) => {
      const index = tools.findIndex(t => t.name === tool.name);
      tools[index] = { ...tool, sourceInfo: { source: "extension" } };
    }),
  };
  return { sdk, pi, tools, bashExecute, renderResult, executions };
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ctx-replacements-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const config = (bash = false, read = false) => ({ bash: { enabled: bash }, read: { enabled: read, ...DEFAULT_READ_LIMITS } });
const normalize = (values: unknown[]) => normalizeToolReplacements(values, vi.fn());
const settingsFile = (home: boolean) => join(root, ".pi", ...(home ? ["agent"] : []), "context-mode", "settings.json");
function save(path: string, text: string) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); }

describe("Pi replacement settings", () => {
  it("defaults off and merges individual project fields including explicit false", () => {
    expect(normalize([])).toEqual(config());
    expect(normalize([{ toolReplacements: { bash: { enabled: true }, read: { enabled: true, maxLines: 42, maxBytes: 99 } } },
      { toolReplacements: { bash: { enabled: false }, read: { maxBytes: 12 } } }])).toEqual({ bash: { enabled: false }, read: { enabled: true, maxLines: 42, maxBytes: 12 } });
  });
  it.each([0, -1, 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "300", null, false])("invalid cap %s disables only Read", value => {
    for (const key of ["maxLines", "maxBytes"]) {
      const warn = vi.fn();
      const result = normalizeToolReplacements([{ toolReplacements: { bash: { enabled: true }, read: { enabled: true, [key]: value } } }], warn);
      expect(result.bash.enabled).toBe(true);
      expect(result.read.enabled).toBe(false);
      expect(warn).toHaveBeenCalled();
    }
  });
  it.each(["true", 1, null, [], {}])("rejects nonboolean enabled %s", enabled => {
    expect(normalize([{ toolReplacements: { bash: { enabled }, read: { enabled: true } } }]).bash.enabled).toBe(false);
  });
  it("fails closed for malformed namespaces and tiers, even with a later valid opt-in", () => {
    for (const invalid of [null, [], { toolReplacements: null }, { toolReplacements: [] }]) {
      expect(normalize([invalid, { toolReplacements: config(true, true) }])).toEqual(config());
    }
    expect(normalize([{ toolReplacements: { bash: [], read: { enabled: true } } }]).read.enabled).toBe(true);
  });
  it("loads only the established global/project Pi context-mode paths", () => {
    save(settingsFile(true), JSON.stringify({ toolReplacements: config(true, true), permissions: {} }));
    save(settingsFile(false), JSON.stringify({ toolReplacements: { bash: { enabled: false }, read: { maxLines: 5 } } }));
    save(join(root, ".pi", "settings.json"), "invalid Pi settings ignored");
    save(join(root, ".claude", "settings.json"), "invalid Claude settings ignored");
    const warn = vi.fn();
    expect(loadToolReplacementSettings(root, warn, root)).toEqual({ bash: { enabled: false }, read: { enabled: true, maxLines: 5, maxBytes: 10240 } });
    expect(warn).not.toHaveBeenCalled();
  });
  it("missing files are defaults; malformed/unreadable files warn and disable", () => {
    expect(loadToolReplacementSettings(root, vi.fn(), root)).toEqual(config());
    save(settingsFile(true), JSON.stringify({ toolReplacements: config(true, true) }));
    save(settingsFile(false), "{");
    const warn = vi.fn();
    expect(loadToolReplacementSettings(root, warn, root)).toEqual(config());
    expect(warn).toHaveBeenCalled();
    rmSync(settingsFile(false)); mkdirSync(settingsFile(false)); // EISDIR, deterministic even under root
    expect(loadToolReplacementSettings(root, warn, root)).toEqual(config());
  });
});

describe("native replacement installation and routing", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])("independent bash=%s read=%s", (bash, read) => {
    const { pi, sdk } = sdkFixture();
    expect(installToolReplacements(pi, root, config(bash, read), sdk, vi.fn())).toEqual({ bash, read });
    expect(pi.registerTool).toHaveBeenCalledTimes(Number(bash) + Number(read));
    if (!bash && !read) expect(pi.getAllTools).not.toHaveBeenCalled();
  });
  it.each(["bash", "read"] as const)("does not displace another extension owning %s", feature => {
    const { pi, sdk, tools } = sdkFixture();
    const owned = tools.find(t => t.name === feature)!; owned.sourceInfo.source = "lsp";
    const warn = vi.fn();
    expect(installToolReplacements(pi, root, config(true, true), sdk, warn)).toEqual({ bash: feature !== "bash", read: feature !== "read" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${feature} replacement skipped`));
    expect(owned.description).toBe("native");
  });
  it("fails safely on unsupported schemas, missing capabilities, runtime failure and ignored registration", () => {
    for (const mode of ["schema", "sdk", "factory", "runtime", "ignored"] as const) {
      const { pi, sdk, tools } = sdkFixture();
      if (mode === "schema") tools[0].parameters = { type: "object" };
      if (mode === "factory") sdk.createBashToolDefinition = undefined as any;
      if (mode === "runtime") pi.getAllTools.mockImplementation(() => { throw new Error("not bound"); });
      if (mode === "ignored") pi.registerTool.mockImplementation(() => {});
      const warn = vi.fn();
      expect(installToolReplacements(pi, root, config(true), mode === "sdk" ? undefined : sdk, warn).bash).toBe(false);
      expect(warn).toHaveBeenCalled();
    }
  });
  it("Bash preserves native execute/renderers/timeout and never invokes an automatic fallback", async () => {
    const { pi, sdk, tools, bashExecute, renderResult } = sdkFixture();
    installToolReplacements(pi, root, config(true), sdk, vi.fn());
    expect(tools[0].execute).toBe(bashExecute);
    expect(tools[0].renderResult).toBe(renderResult);
    const args = { command: "printf x", timeout: 2 };
    const signal = new AbortController().signal;
    const update = vi.fn(), ctx = {};
    await tools[0].execute("id", args, signal, update, ctx);
    expect(bashExecute).toHaveBeenCalledExactlyOnceWith("id", args, signal, update, ctx);
    expect(tools[0].description).toContain("recovery");
    expect(tools[0].promptSnippet).toBeUndefined();
    const guidance = tools[0].promptGuidelines?.join(" ") ?? "";
    expect(guidance).toMatch(/bash only as a recovery fallback when context-mode is unavailable or has failed/i);
    expect(guidance).toMatch(/ctx_execute for a single command or dependent chain/i);
    expect(guidance).toMatch(/ctx_batch_execute for independent command collection\/search/i);
  });
  it("Pi descriptions and prompt metadata agree only for effective Bash policy", () => {
    for (const name of ["ctx_execute", "ctx_batch_execute"]) {
      const disabled = piToolPresentation(name, "original");
      // OFF: the generic MCP description passes through byte-for-byte, so the
      // still-callable native Bash stays a normal tool with no contradiction.
      expect(disabled.description).toBe("original");
      const enabled = piToolPresentation(name, "original", true);
      expect(enabled.description).toMatch(/side effects/);
      expect(enabled.description).toMatch(/Native bash/);
      expect(enabled.promptGuidelines?.join(" ")).toMatch(/retry/);
      // ON: the override must replace, never augment, the generic text.
      expect(enabled.description).not.toBe("original");
      expect(enabled.description.length).toBeLessThanOrEqual(1000);
    }
    const onExecute = piToolPresentation("ctx_execute", "original", true);
    expect(onExecute.description).toMatch(/In Pi, route ALL shell commands through context-mode/i);
    expect(onExecute.description).toMatch(/ctx_execute here for a single command or dependent chain/i);
    expect(onExecute.description).toMatch(/ctx_batch_execute for independent command collection\/search/i);
    expect(onExecute.description).not.toMatch(/use native host tools/i);
    expect(piToolPresentation("ctx_execute_file", "original", true)).toEqual(piToolPresentation("ctx_execute_file", "original"));
    // A tool that is NOT a shell entry point must never receive the override.
    expect(piToolPresentation("ctx_index", "original", true).description).toBe("original");
    expect(piToolPresentation("ctx_search", "original", true).description).toBe("original");
  });
});

describe("bounded native-style Read", () => {
  function reader(text: string, caps = DEFAULT_READ_LIMITS as { maxLines: number; maxBytes: number }) {
    const file = join(root, "file.txt"); writeFileSync(file, text);
    const fixture = sdkFixture();
    const tool = createBoundedRead(root, { enabled: true, ...caps }, fixture.sdk);
    return { ...fixture, file, tool, run: (args = {}) => tool.execute("id", { path: file, ...args }) };
  }
  it.each(["", "a", "a\n", "a\r\nb\r\n", "🙂汉字\nlast", "[999 more lines in file. Use offset=1001 to continue.]\nx"])("returns exact small text %j, retaining non-truncation details", async text => {
    const { run } = reader(text);
    const result = await run();
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(result.details).toEqual({ marker: true });
  });
  it("clamps omitted/oversized line limits and follows the actual next source line", async () => {
    const lines = Array.from({ length: 601 }, (_, i) => `line-${i + 1}`);
    const { run, executions } = reader(lines.join("\n"));
    for (const args of [{}, { limit: 9999 }]) {
      const result = await run(args);
      expect(result.content[0].text).toBe(lines.slice(0, 300).join("\n") + "\n\n[Showing lines 1-300 of 601. Use offset=301 to continue.]");
      expect(result.details?.truncation).toMatchObject({ outputLines: 300, maxLines: 300 });
    }
    const next = await run({ offset: 301 });
    expect(next.content[0].text).toBe(lines.slice(300, 600).join("\n") + "\n\n[Showing lines 301-600 of 601. Use offset=601 to continue.]");
    expect((await run({ offset: 601 })).content[0].text).toBe("line-601");
    expect(executions.mock.calls[0][1].limit).toBe(300);
  });
  it("respects smaller requested limits and exact EOF including trailing newline", async () => {
    const { run } = reader("a\nb\n");
    expect((await run({ offset: 2, limit: 1 })).content[0].text).toBe("b\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]");
    expect((await run({ offset: 3 })).content[0].text).toBe("");
    await expect(run({ offset: 4 })).rejects.toThrow("beyond end of file");
  });
  it.each([0, -1, 1.5, Infinity, NaN])("rejects invalid offsets and limits %s", async value => {
    const { run } = reader("a");
    await expect(run({ offset: value })).rejects.toThrow("positive safe integer");
    await expect(run({ limit: value })).rejects.toThrow("positive safe integer");
  });
  it("preserves complete UTF-8/CRLF lines at byte boundaries and paginates without omission", async () => {
    const { run } = reader("🙂\r\n汉字\r\nx", { maxLines: 300, maxBytes: 7 });
    expect((await run()).content[0].text).toBe("🙂\r\n\n[Showing lines 1-1 of 3. Use offset=2 to continue.]");
    expect((await run({ offset: 2 })).content[0].text).toBe("汉字\r\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]");
    expect((await run({ offset: 3 })).content[0].text).toBe("x");
  });
  it("accepts exactly 10240 bytes, but stops an oversized first line without a looping cursor", async () => {
    const { run, file } = reader("🙂".repeat(2560));
    expect((await run()).content[0].text).toBe("🙂".repeat(2560));
    writeFileSync(file, "🙂".repeat(2561) + "\nnext");
    const result = await run();
    expect(result.content[0].text).toContain("No source text returned");
    expect(result.content[0].text).not.toContain("offset=");
    expect(result.details?.truncation).toMatchObject({ outputBytes: 0, firstLineExceedsLimit: true });
  });
  it("supports larger custom budgets without native fixed-cap text/details pollution", async () => {
    const text = "x".repeat(60000) + "\nend";
    const { run } = reader(text, { maxLines: 4000, maxBytes: 100000 });
    expect((await run()).content[0].text).toBe(text);
    const { sdk } = sdkFixture();
    const lines = Array.from({ length: 2500 }, () => "x").join("\n");
    expect(formatReadText(lines, { path: "x" }, { maxLines: 3000, maxBytes: 100000 }, sdk.truncateHead).text).toBe(lines);
  });
  it("retains image-only warnings and image results by identity, independent of extension", async () => {
    const { sdk, file } = reader("binary image");
    sdk.detectSupportedImageMimeTypeFromFile = vi.fn(async () => "image/png");
    for (const content of [[{ type: "text", text: "image warning" }], [{ type: "image", data: "xyz", mimeType: "image/png" }]]) {
      const result = { content, details: { image: true } };
      const original = sdk.createReadToolDefinition;
      sdk.createReadToolDefinition = (cwd, options) => ({ ...original(cwd, options), execute: async () => {
        await options!.operations.detectImageMimeType(file);
        return result;
      } });
      expect(await createBoundedRead(root, config(false, true).read, sdk).execute("id", { path: file })).toBe(result);
      sdk.createReadToolDefinition = original;
    }
  });
  it("preserves errors, signal/update/context, and cancellation after native success", async () => {
    const { tool, sdk, file, executions, renderResult } = reader("a");
    expect(tool.renderResult).toBe(renderResult);
    expect(tool.prepareArguments).toEqual({ native: true });
    await expect(tool.execute("id", { path: join(root, "missing") })).rejects.toThrow(/ENOENT/);
    const controller = new AbortController(), update = vi.fn(), ctx = {};
    await tool.execute("id", { path: file }, controller.signal, update, ctx);
    expect(executions).toHaveBeenLastCalledWith("id", { path: file, limit: 300 }, controller.signal, update, ctx);
    controller.abort();
    await expect(tool.execute("id", { path: file }, controller.signal)).rejects.toThrow("aborted");
    const late = new AbortController();
    const original = sdk.createReadToolDefinition;
    sdk.createReadToolDefinition = (cwd, options) => {
      const native = original(cwd, options);
      return { ...native, execute: async (...args) => { const result = await native.execute(...args); late.abort(); return result; } };
    };
    await expect(createBoundedRead(root, config(false, true).read, sdk).execute("id", { path: file }, late.signal)).rejects.toThrow("aborted");
  });
  it("isolates concurrent operations and consumes exactly the same native read Buffer", async () => {
    const { sdk } = sdkFixture();
    const first = join(root, "first"), second = join(root, "second");
    writeFileSync(first, "alpha"); writeFileSync(second, "beta");
    const original = sdk.createReadToolDefinition;
    const operations: ReadOperations[] = [];
    sdk.createReadToolDefinition = (cwd, options) => {
      if (options) operations.push(options.operations);
      const native = original(cwd, options);
      return { ...native, execute: async (...args) => {
        const result = await native.execute(...args);
        writeFileSync(args[1].path, "changed after native read");
        return result;
      } };
    };
    const tool = createBoundedRead(root, config(false, true).read, sdk);
    const results = await Promise.all([first, second].map(path => tool.execute("id", { path })));
    expect(results.map(r => r.content[0].text)).toEqual(["alpha", "beta"]);
    expect(operations[0]).not.toBe(operations[1]);
  });
});

// Regression gate: the injectable entry must still install replacements before
// passing EFFECTIVE policy to lazy MCP bootstrap, not merely expose good helpers.
describe("replacement lifecycle wiring", () => {
  it("warns through Pi's non-UI message channel and keeps ctx policy disabled on ownership conflict", async () => {
    const { pi, sdk, tools } = sdkFixture(); tools[0].sourceInfo.source = "lsp";
    save(settingsFile(false), JSON.stringify({ toolReplacements: config(true) }));
    vi.stubEnv("PI_WORKSPACE_DIR", root);
    const handlers: Record<string, Function> = {};
    const sendMessage = vi.fn();
    Object.assign(pi, { on: (name: string, fn: Function) => { handlers[name] = fn; }, registerCommand: vi.fn(), sendMessage });
    const bridge = await import("../../src/adapters/pi/mcp-bridge.js");
    const bootstrap = vi.spyOn(bridge, "bootstrapMCPTools").mockResolvedValue({ tools: [], shutdown() {}, client: {} as any });
    const { default: extension } = await import("../../src/adapters/pi/extension.js");
    try {
      extension(pi, sdk);
      // Also covers hosts that reach before_agent_start without session_start.
      await handlers.before_agent_start({ prompt: "test" }, { hasUI: false });
      expect(pi.registerTool).not.toHaveBeenCalled();
      expect(bootstrap).toHaveBeenCalledWith(pi, expect.any(String), {
        foreground: false,
        routeAllShell: false,
        tidyToolDisplay: false,
        disabledTools: [...DEFAULT_DISABLED_BUILTIN_FEATURES],
      });
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("bash replacement skipped"), display: true }), { triggerTurn: false });
    } finally { await handlers.session_shutdown?.(); vi.unstubAllEnvs(); }
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])("lazy initialization bash=%s read=%s", async (bash, read) => {
    const { pi, sdk } = sdkFixture();
    save(settingsFile(false), JSON.stringify({ toolReplacements: config(bash, read) }));
    vi.stubEnv("PI_WORKSPACE_DIR", root);
    const handlers: Record<string, Function> = {};
    Object.assign(pi, { on: (name: string, fn: Function) => { handlers[name] = fn; }, registerCommand: vi.fn() });
    const bridge = await import("../../src/adapters/pi/mcp-bridge.js");
    const bootstrap = vi.spyOn(bridge, "bootstrapMCPTools").mockResolvedValue({ tools: [], shutdown() {}, client: {} as any });
    const { default: extension } = await import("../../src/adapters/pi/extension.js");
    try {
      extension(pi, sdk);
      expect(pi.registerTool).not.toHaveBeenCalled();
      expect(bootstrap).not.toHaveBeenCalled();
      await handlers.session_start({}, {});
      expect(pi.registerTool).toHaveBeenCalledTimes(Number(bash) + Number(read));
      expect(await handlers.tool_call({ toolName: "bash", input: { command: "curl https://example.com" } })).toMatchObject({ block: true });
      expect(await handlers.tool_call({ toolName: "bash", input: { command: "curl -s -o /tmp/recovery.json https://example.com" } })).toBeUndefined();
      await handlers.before_agent_start({ prompt: "test" }, { hasUI: false });
      expect(bootstrap).toHaveBeenCalledExactlyOnceWith(pi, expect.any(String), {
        foreground: false,
        routeAllShell: bash,
        tidyToolDisplay: false,
        disabledTools: [...DEFAULT_DISABLED_BUILTIN_FEATURES],
      });
      await handlers.before_agent_start({ prompt: "again" }, {});
      expect(pi.registerTool).toHaveBeenCalledTimes(Number(bash) + Number(read));
    } finally { await handlers.session_shutdown?.(); vi.unstubAllEnvs(); }
  });
});
