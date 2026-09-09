// Optional installed-host smoke. Run after npm run build. No model/network calls or user settings writes.
// Private methods below simulate the host turn boundary ONLY; product code uses public APIs.
// Exercises installed Pi + Blackhole inline adapter; synthetic summary replaces LLM work.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const cli = realpathSync(process.env.PI_SMOKE_CLI || execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pi'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]);
const host = resolve(dirname(cli), '../..');
const blackhole = process.env.PI_BLACKHOLE_ROOT || join(homedir(), '.pi/agent/npm/node_modules/pi-blackhole');
const scratch = mkdtempSync(join(tmpdir(), 'pi-recovery-probe-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.JITI_FS_CACHE = 'false';
process.env.CONTEXT_MODE_DISABLE_VERSION_CHECK = '1';
let session;
try {
  const sdkPath = join(host, 'dist/index.js');
  const sdk = await import(pathToFileURL(sdkPath).href);
  // Fresh-process reopen through public manager APIs, independently of the
  // private active-turn harness below. Seed native and unbound legacy records.
  const { SessionDB } = await import(pathToFileURL(resolve('build/session/db.js')).href);
  const { createHash } = await import('node:crypto');
  const identityPath = join(scratch, 'identity.jsonl');
  const identityDBPath = join(scratch, 'identity.db');
  const manager = sdk.SessionManager.open(identityPath, scratch, scratch);
  manager.appendMessage({ role: 'user', content: 'identity seed', timestamp: 1 });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'synthetic' }], timestamp: 2 });
  const nativeID = manager.getSessionId();
  const identityDB = new SessionDB({ dbPath: identityDBPath });
  for (const [key, data] of [[nativeID, 'NATIVE ID SMOKE'],
    [createHash('sha256').update(identityPath).digest('hex').slice(0, 16), 'LEGACY HASH SENTINEL']]) {
    identityDB.insertEvent(key, { type: 'decision', category: 'decision', data, priority: 1 });
  }
  identityDB.close();
  const childScript = join(scratch, 'reopen.mjs');
  writeFileSync(childScript, `
    import assert from 'node:assert/strict';
    import { SessionManager } from ${JSON.stringify(sdkPath)};
    import { SessionDB } from ${JSON.stringify(pathToFileURL(resolve('build/session/db.js')).href)};
    import { PiRecovery, renderRecovery } from ${JSON.stringify(pathToFileURL(resolve('build/adapters/pi/recovery.js')).href)};
    const manager = SessionManager.open(process.argv[2], ${JSON.stringify(scratch)});
    assert.equal(manager.getSessionId(), ${JSON.stringify(nativeID)});
    const db = new SessionDB({ dbPath: ${JSON.stringify(identityDBPath)} });
    let sends = 0;
    const recovery = new PiRecovery({
      events: key => { assert.equal(key, manager.getSessionId()); return db.getEvents(key); },
      blackhole: () => false,
      render: (events, reason, flag) => renderRecovery(${JSON.stringify(resolve('.'))}, events, reason, flag),
      send: (message, options) => {
        assert.equal(options.triggerTurn, false);
        assert.match(message.content, /NATIVE ID SMOKE/);
        assert.doesNotMatch(message.content, /LEGACY HASH SENTINEL/);
        assert.equal(message.details.file, process.argv[2]);
        assert.equal(message.details.version, 2);
        manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        sends++;
      },
      warn: message => { throw new Error(message); },
    });
    await recovery.activate('resume', { sessionManager: manager });
    assert.equal(sends, 1);
    assert.equal(recovery.filter(manager.buildSessionContext().messages, { sessionManager: manager })
      .filter(m => m.customType === 'context-mode-recovery').length, 1);
    db.close();
  `);
  execFileSync(process.execPath, [childScript, identityPath], { stdio: 'pipe' });
  const movedIdentityPath = join(scratch, 'moved-identity.jsonl');
  renameSync(identityPath, movedIdentityPath);
  execFileSync(process.execPath, [childScript, movedIdentityPath], { stdio: 'pipe' });
  const replacement = sdk.SessionManager.open(identityPath, scratch, scratch);
  assert.notEqual(replacement.getSessionId(), nativeID);
  console.log('PASS: fresh-process public-manager reopen and rename rebuild native-ID recovery; reused path gets new ID');
  const { loadExtensions } = await import(pathToFileURL(join(host, 'dist/core/extensions/loader.js')).href);
  const { build } = await import(pathToFileURL(resolve('node_modules/esbuild/lib/main.js')).href);
  const adapterPath = join(scratch, 'inline.mjs');
  await build({
    entryPoints: [join(blackhole, 'src/om/inline-compaction.ts')],
    outfile: adapterPath, bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'installed-sdk', setup(b) {
      b.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: sdkPath, external: true }));
    } }],
  });
  const adapter = await import(pathToFileURL(adapterPath).href);
  const status = adapter.installInlineCompactionAdapter({ sessionClass: sdk.AgentSession });
  assert.equal(status.supported, true, status.reason);
  const extensionPath = join(scratch, 'summary-extension.mjs');
  writeFileSync(extensionPath, `export default function(pi) {
    pi.on('session_before_compact', e => ({compaction: {
      summary: 'Synthetic summary: no model call',
      firstKeptEntryId: e.preparation.firstKeptEntryId,
      tokensBefore: e.preparation.tokensBefore,
    }}));
    pi.on('context', e => ({ messages: [...e.messages] }));
  }`);
  const product = resolve('build/adapters/pi/host-entry.js');
  for (const ordering of [[product, extensionPath], [extensionPath, product]]) {
  process.env.PI_PROJECT_DIR = scratch;
  const loaded = await loadExtensions(ordering, scratch);
  assert.deepEqual(loaded.errors, []);
  const resources = {
    getExtensions: () => loaded,
    getSkills: () => ({skills: [], diagnostics: []}),
    getPrompts: () => ({prompts: [], diagnostics: []}),
    getThemes: () => ({themes: [], diagnostics: []}),
    getAgentsFiles: () => ({agentsFiles: []}),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources() {}, async reload() {},
  };
  const model = {id:'probe', name:'probe', provider:'probe', api:'openai-completions',
    baseUrl:'http://invalid.local', reasoning:false, input:['text'],
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:16000,maxTokens:1024};
  ({session} = await sdk.createAgentSession({cwd:scratch,agentDir:join(scratch,'agent'),
    resourceLoader:resources,model,tools:[],
    settingsManager:sdk.SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:512,keepRecentTokens:256}}),
    sessionManager:sdk.SessionManager.create(scratch, join(scratch, 'sessions'))}));
  await session.bindExtensions({});
  session._getSummarizationRequestAuth = async () => ({model,apiKey:'synthetic-not-a-key'});
  const seed = (label) => {
    session.sessionManager.appendMessage({role:'user',content:label + ' detail'.repeat(1000),timestamp:1});
    session.sessionManager.appendMessage({role:'assistant',content:[{type:'text',text:'done'}],
      api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:2,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  };
  for (let i=0;i<5;i++) seed('request '+i);
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  // Capture a real supported event through the registered product handler.
  await session._extensionRunner.emit({ type: 'tool_result', toolName: 'read', params: { path: '/src/recovery-smoke.ts' }, result: 'source' });
  const originalEmit = session._emitExtensionEvent.bind(session);
  session._emitExtensionEvent = async event => {
    await originalEmit(event);
    if (event.type === 'turn_end') {
      await adapter.compactInlineAtTurnBoundary(session.sessionManager);
      assert.equal(session._pendingCustomMessages.length, 1, 'running sendMessage queues until turn_end flush');
    }
  };
  session._isAgentRunActive = true;
  session.agent.state.isStreaming = true;
  await session._handleAgentEvent({type:'turn_end',message:session.agent.state.messages.at(-1),toolResults:[]});
  assert.equal(session._pendingCustomMessages.length, 0);
  const isRecovery = m => m.role === 'custom' && m.customType === 'context-mode-recovery';
  const inState = session.agent.state.messages.filter(isRecovery);
  assert.equal(inState.length, 1);
  const next = await session.agent.prepareNextTurnWithContext({context:{messages:[]}},new AbortController().signal);
  assert.equal(next.context.messages.filter(isRecovery).length, 1, 'Blackhole refresh includes flushed message');
  assert.equal(session.sessionManager.buildSessionContext().messages.filter(isRecovery).length,1);
  const entry = session.sessionManager.getBranch().find(e => e.type === 'custom_message' && e.customType === 'context-mode-recovery');
  assert.ok(entry, 'message persisted as session entry');
  assert.match(inState[0].content, /recovery-smoke.ts/);
  const projected = await session._extensionRunner.emitContext(next.context.messages);
  assert.equal(projected.filter(isRecovery).length, 1);
  for (let i = 0; i < 3; i++) {
    const again = await session._extensionRunner.emitContext(projected);
    assert.equal(again.filter(isRecovery).length, 1);
    assert.equal(session.sessionManager.getBranch().filter(e => e.customType === 'context-mode-recovery').length, 1);
  }
  // Idle compaction with an adversarial retained recovery tail. Notify through
  // the real extension runner; summary is deterministic, no provider involved.
  session._isAgentRunActive = false; session.agent.state.isStreaming = false;
  await session._extensionRunner.emit({ type: 'session_before_compact' });
  const secondId = session.sessionManager.appendCompaction('second summary', entry.id, 1000, undefined, true);
  const second = session.sessionManager.getEntry(secondId);
  await session._extensionRunner.emit({ type: 'session_compact', compactionEntry: second, fromExtension: true });
  await session._extensionRunner.emit({ type: 'session_compact', compactionEntry: second, fromExtension: true });
  const both = session.sessionManager.buildSessionContext().messages;
  assert.equal(both.filter(isRecovery).length, 2, 'append-only transcript retains old tail');
  assert.equal((await session._extensionRunner.emitContext(both)).filter(isRecovery).length, 1, 'real chained context hooks retire old generation');
  const unrelated = { role: 'custom', customType: 'other-extension', content: 'untouched', display: false, timestamp: 1 };
  const paired = [{ role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: { path: 'x' } }] }, { role: 'toolResult', toolCallId: 't', toolName: 'read', content: [{ type: 'text', text: 'result' }], isError: false, timestamp: 1 }];
  const ordered = await session._extensionRunner.emitContext([...paired, unrelated, ...both]);
  assert.deepEqual(ordered.slice(0, 3), [...paired, unrelated]);
  // Resume reprojects baseline once; reload is idempotent.
  await session._extensionRunner.emit({ type: 'session_start', reason: 'resume' });
  const count = session.sessionManager.getBranch().filter(e => e.customType === 'context-mode-recovery').length;
  await session._extensionRunner.emit({ type: 'session_start', reason: 'reload' });
  assert.equal(session.sessionManager.getBranch().filter(e => e.customType === 'context-mode-recovery').length, count);
  // Opt-in compact trimming removes the sole file event; empty replacement
  // must still retire all older generations.
  mkdirSync(join(scratch, '.pi/context-mode'), { recursive: true });
  writeFileSync(join(scratch, '.pi/context-mode/settings.json'), JSON.stringify({ recovery: { blackhole: { enabled: true } } }));
  await session._extensionRunner.emit({ type: 'session_before_compact' });
  const thirdId = session.sessionManager.appendCompaction('third summary', entry.id, 1000, undefined, true);
  await session._extensionRunner.emit({ type: 'session_compact', compactionEntry: session.sessionManager.getEntry(thirdId), fromExtension: true });
  assert.equal((await session._extensionRunner.emitContext(session.sessionManager.buildSessionContext().messages)).filter(isRecovery).length, 0);
  console.log('PASS:', ordering[0] === product ? 'product-first' : 'summary-first', 'real Pi queued inline delivery, installed Blackhole next-turn refresh, persistent reuse, chained filtering, idle compact, empty retirement and tool ordering');
  rmSync(join(scratch, '.pi/context-mode/settings.json'));
  await session._extensionRunner.emit({ type: 'session_shutdown' });
  session.dispose(); session = undefined;
  }
  console.log('LIMIT: synthetic summary; no live model or full Blackhole observer/summary pipeline. Requires supported installed Pi and pi-blackhole (override PI_SMOKE_CLI / PI_BLACKHOLE_ROOT).');
} finally {
  if (session) { session._isAgentRunActive = false; session.agent.state.isStreaming = false; session.dispose(); }
  rmSync(scratch,{recursive:true,force:true});
}
