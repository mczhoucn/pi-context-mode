// Optional installed-host contract check. Run AFTER npm run build:
// node tests/fixtures/pi-replacements-host-smoke.mjs
// No model requests, package installation, user extension discovery or settings writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = realpathSync(process.env.PI_SMOKE_CLI || execFileSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]);
const pkg = resolve(dirname(cli), "../..");
const scratch = mkdtempSync(join(tmpdir(), "ctx-pi-host-smoke-"));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.JITI_FS_CACHE = "false";
process.env.CONTEXT_MODE_DISABLE_VERSION_CHECK = "1";
let checks = 0;
try {
  const sdk = await import(pathToFileURL(join(pkg, "dist/index.js")).href);
  const loader = await import(pathToFileURL(join(pkg, "dist/core/extensions/loader.js")).href);
  const chunkName = readFileSync(cli, "utf8").match(/from["']\.\/chunks\/([^"']+)["']/)?.[1];
  assert.ok(chunkName, "Expected the supported Pi bundled CLI layout");
  const bundled = await import(pathToFileURL(join(dirname(cli), "chunks", chunkName)).href);
  const { createBoundedRead, formatReadText } = await import(pathToFileURL(join(root, "build/adapters/pi/tool-replacements.js")).href);
  const limits = { enabled: true, maxLines: 300, maxBytes: 10240 };
  const file = join(scratch, "text.png");
  const bounded = createBoundedRead(scratch, limits, sdk);
  const run = (args = {}, signal) => bounded.execute("smoke", { path: file, ...args }, signal);

  for (const text of ["", "x\n", "a\r\nb\r\n", "🙂汉字\nend", "[999 more lines in file. Use offset=1001 to continue.]\nx"]) {
    writeFileSync(file, text);
    assert.equal((await run()).content[0].text, text); checks++;
  }
  const lines = Array.from({ length: 601 }, (_, i) => `line-${i + 1}`);
  writeFileSync(file, lines.join("\n"));
  for (const args of [{}, { limit: 99999 }]) {
    const result = await run(args);
    assert.equal(result.content[0].text, lines.slice(0, 300).join("\n") + "\n\n[Showing lines 1-300 of 601. Use offset=301 to continue.]");
    assert.equal(result.details.truncation.outputLines, 300); checks++;
  }
  assert.equal((await run({ offset: 301 })).content[0].text, lines.slice(300, 600).join("\n") + "\n\n[Showing lines 301-600 of 601. Use offset=601 to continue.]"); checks++;
  assert.equal((await run({ offset: 601 })).content[0].text, "line-601"); checks++;
  await assert.rejects(run({ offset: 602 }), /beyond end of file/); checks++;
  await assert.rejects(bounded.execute("missing", { path: join(scratch, "missing") }), /ENOENT/); checks++;
  const early = new AbortController(); early.abort();
  await assert.rejects(run({}, early.signal), /aborted/); checks++;
  const late = new AbortController();
  const afterReadSDK = { ...sdk, createReadToolDefinition(cwd, options) {
    const native = sdk.createReadToolDefinition(cwd, options);
    return { ...native, execute: async (...args) => { const result = await native.execute(...args); late.abort(); return result; } };
  } };
  await assert.rejects(createBoundedRead(scratch, limits, afterReadSDK).execute("late", { path: file }, late.signal), /aborted/); checks++;

  for (const size of [10240, 10241]) {
    writeFileSync(file, "x".repeat(size));
    const result = await run();
    if (size === 10240) assert.equal(result.content[0].text.length, size);
    else { assert.match(result.content[0].text, /No source text returned/); assert.doesNotMatch(result.content[0].text, /offset=/); }
    checks++;
  }
  const big = "🙂".repeat(15000) + "\nend";
  writeFileSync(file, big);
  assert.equal((await createBoundedRead(scratch, { enabled: true, maxLines: 4000, maxBytes: 100000 }, sdk).execute("big", { path: file })).content[0].text, big); checks++;
  const many = Array.from({ length: 2500 }, () => "x").join("\n");
  assert.equal(formatReadText(many, { path: file }, { maxLines: 3000, maxBytes: 100000 }, sdk.truncateHead).text, many); checks++;
  writeFileSync(file, many);
  assert.equal((await createBoundedRead(scratch, { enabled: true, maxLines: 3000, maxBytes: 100000 }, sdk).execute("many-lines", { path: file })).content[0].text, many); checks++;
  writeFileSync(file, "🙂\r\n汉字\r\nx");
  const small = createBoundedRead(scratch, { enabled: true, maxLines: 300, maxBytes: 7 }, sdk);
  assert.equal((await small.execute("crlf", { path: file })).content[0].text, "🙂\r\n\n[Showing lines 1-1 of 3. Use offset=2 to continue.]"); checks++;
  assert.equal((await small.execute("crlf2", { path: file, offset: 2 })).content[0].text, "汉字\r\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]"); checks++;
  const png = join(scratch, "image.txt");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=", "base64"));
  const image = await bounded.execute("image", { path: png });
  const originalImage = await sdk.createReadToolDefinition(scratch).execute("native", { path: png });
  assert.deepEqual(image, originalImage); checks++; // Includes native text-only resize warnings.
  const unresizedSDK = { ...sdk, createReadToolDefinition: (cwd, options) => sdk.createReadToolDefinition(cwd, { ...options, autoResizeImages: false }) };
  const unresized = await createBoundedRead(scratch, limits, unresizedSDK).execute("unresized", { path: png });
  assert.deepEqual(unresized, await sdk.createReadToolDefinition(scratch, { autoResizeImages: false }).execute("original-unresized", { path: png }));
  assert.ok(unresized.content.some(c => c.type === "image")); checks++;
  const parallel = await Promise.all([file, png].map(path => bounded.execute("parallel", { path })));
  assert.equal(parallel[0].content[0].text, "🙂\r\n汉字\r\nx"); assert.deepEqual(parallel[1], originalImage); checks++;

  // Actual loaders + actual AgentSession registry (not a simulated tools map).
  // Resource discovery is inert and sessions/settings are isolated; no prompt
  // is sent, so this exercises ownership/lifecycle without model requests.
  const resourceLoader = loaded => ({
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  });
  const createSession = async (loaded, cwd, customTools = []) => (await sdk.createAgentSession({
    cwd, agentDir: join(cwd, "isolated-agent-dir"), customTools,
    resourceLoader: resourceLoader(loaded),
    settingsManager: sdk.SettingsManager.inMemory(),
    sessionManager: sdk.SessionManager.inMemory(cwd),
  })).session;
  for (const mode of ["unbundled", "bundled"]) {
    for (const [bash, read] of [[false, false], [true, false], [false, true], [true, true]]) {
      const cwd = join(scratch, `${mode}-${bash}-${read}`);
      mkdirSync(join(cwd, ".pi/context-mode"), { recursive: true });
      writeFileSync(join(cwd, ".pi/context-mode/settings.json"), JSON.stringify({ toolReplacements: { bash: { enabled: bash }, read: { enabled: read } } }));
      process.env.PI_WORKSPACE_DIR = cwd;
      const entry = join(root, "build/adapters/pi/host-entry.js");
      const loaded = mode === "unbundled" ? await loader.loadExtensions([entry], cwd)
        : await bundled.discoverAndLoadExtensions([entry], cwd, join(cwd, "absent-agent-dir"));
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      const ext = loaded.extensions[0];
      assert.equal(ext.tools.size, 0, "discovery must not register tools/start MCP");
      const session = await createSession(loaded, cwd);
      try {
        await session.bindExtensions({});
        assert.ok(!session.state.messages.some(m => m.customType === "context-mode-warning"));
        assert.deepEqual([...ext.tools.keys()].sort(), [bash ? "bash" : null, read ? "read" : null].filter(Boolean).sort());
        for (const [name, enabled] of [["bash", bash], ["read", read]]) {
          const installed = session.getAllTools().find(t => t.name === name);
          assert.equal(installed.sourceInfo.source === "builtin", !enabled);
          if (enabled) assert.equal(installed.description, ext.tools.get(name).definition.description);
        }
        assert.equal(/^- bash:/m.test(session.systemPrompt), !bash,
          "effective Bash replacement must omit Bash from Pi's tool summary");
        if (bash) {
          assert.match(session.systemPrompt,
            /^- Use bash only as a recovery fallback when context-mode is unavailable or has failed\./m);
          assert.doesNotMatch(session.systemPrompt, /Execute bash commands \(ls, grep, find, etc\.\)/);
        } else {
          assert.doesNotMatch(session.systemPrompt,
            /Use bash only as a recovery fallback when context-mode is unavailable or has failed\./);
        }
        if (read) {
          const nativeFile = join(cwd, "source"); writeFileSync(nativeFile, lines.join("\n"));
          assert.match((await session.getToolDefinition("read").execute("loaded", { path: nativeFile })).content[0].text, /offset=301/);
        }
        if (bash) {
          const result = await session.getToolDefinition("bash").execute("recovery", { command: "printf native-recovery", timeout: 5 });
          assert.equal(result.content[0].text, "native-recovery");
        }
        checks++;
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
        session.dispose();
      }
    }
  }
  // Another extension's discovery-time override must survive regardless of
  // extension order. SDK custom tools also win the real registry merge.
  for (const mode of ["unbundled", "bundled"]) {
    for (const feature of ["bash", "read"]) {
      for (const owner of ["extension-before", "extension-after", "sdk"]) {
        const cwd = join(scratch, `owner-${mode}-${feature}-${owner}`);
        mkdirSync(join(cwd, ".pi/context-mode"), { recursive: true });
        writeFileSync(join(cwd, ".pi/context-mode/settings.json"), JSON.stringify({ toolReplacements: {
          bash: { enabled: true }, read: { enabled: true },
        } }));
        process.env.PI_WORKSPACE_DIR = cwd;
        const entry = join(root, "build/adapters/pi/host-entry.js");
        const conflict = join(cwd, "owner.mjs");
        const factory = feature === "bash" ? "createBashToolDefinition" : "createReadToolDefinition";
        writeFileSync(conflict, `import { ${factory} } from '@earendil-works/pi-coding-agent';
export default pi => pi.registerTool({ ...${factory}(${JSON.stringify(cwd)}), description: 'third-party owner' });`);
        const paths = owner === "sdk" ? [entry] : owner === "extension-before" ? [conflict, entry] : [entry, conflict];
        const loaded = mode === "unbundled" ? await loader.loadExtensions(paths, cwd)
          : await bundled.discoverAndLoadExtensions(paths, cwd, join(cwd, "absent-agent-dir"));
        assert.deepEqual(loaded.errors, []);
        const ext = loaded.extensions.find(e => e.path === entry);
        assert.ok(ext);
        const customTools = owner === "sdk" ? [{ ...sdk[factory](cwd), description: "third-party owner" }] : [];
        const session = await createSession(loaded, cwd, customTools);
        try {
          const before = session.getToolDefinition(feature);
          await session.bindExtensions({});
          assert.equal(session.getToolDefinition(feature), before, "existing executable owner must not change");
          assert.equal(session.getAllTools().find(t => t.name === feature).description, "third-party owner");
          assert.ok(!ext.tools.has(feature), "do not even register a conflicting replacement");
          assert.ok(ext.tools.has(feature === "bash" ? "read" : "bash"), "independent replacement still installs");
          assert.ok(session.state.messages.some(m => m.customType === "context-mode-warning" && m.content.includes(`${feature} replacement skipped`)));
          checks++;
        } finally {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
          session.dispose();
        }
      }
    }
  }
  console.log(JSON.stringify({ sdkVersion: JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version, checks, loaders: ["unbundled", "bundled"], registry: "AgentSession", modelRequests: 0, result: "PASS" }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
