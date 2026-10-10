# Pi lifecycle recovery contract

## 1. Scope / Trigger

Read when changing Pi lifecycle hooks, recovery delivery/provenance, historical event projection or recovery settings. This is Pi-only; shared Claude renderer defaults and extractors must not change incidentally. No todo/Blackhole plugin state integration or session DB migration.

## 2. Signatures and ownership

- `extension-adapter-settings.ts`: `normalizeExtensionAdapterSettings(documents, warn): boolean`, `loadExtensionAdapterSettings(projectDir, warn, home?): boolean`. The namespace is per extension (`extensionAdapters.<extension>.enabled`); `blackhole` is the only entry today, other entries are inert.
- `recovery.ts`: `projectRecoveryEvents(events, reason, blackhole)`, `renderRecovery(pluginRoot, events, reason, blackhole)`; instance-scoped `PiRecovery.activate/prepare/failed/compact/filter/reset`.
- `extension.ts`: thin lifecycle wiring; `session_start` awaits lazy MCP bridge registration, while `before_agent_start` retains replacement setup and genuine raw/derived prompt capture, **not bridge startup or recovery generation**.
- `hooks/session-directive.mjs`: additive fourth argument `{ historical?, includeGoal?, searchHint?, dataSearchHint?, dataOlderHint? }`; omitted options preserve Claude output. Pi uses the existing guide once, not a duplicate behavioral block.

## 3. Contracts

`extensionAdapters.blackhole.enabled` defaults false. The retired `recovery.blackhole.enabled` namespace is not aliased: it is an unknown field, ignored without warning, so opt-in must be re-declared under `extensionAdapters`. Only `~/.pi/agent/context-mode/settings.json` and `<project>/.pi/context-mode/settings.json` are read, through existing path helpers. Explicit project fields override global fields; invalid explicit values at either tier disable trimming. Warnings use the existing TUI-safe logger/UI/custom-message channel and are deduplicated per activation. Replacement decoding remains independent.

Capture, recovery and stats use public `sessionManager.getSessionId()` directly, sharing `readPiSessionId` in `session-identity.ts`. File path is a delivery guard, never a DB key. Normal reopen/rename preserves native identity; a reused file with a different host ID must not read its predecessor. Missing native ID uses isolated random bookkeeping in the extension; missing identity or persistent file never qualifies for recovery. Any off-branch entry makes session-wide events ambiguous: do not rebuild them. Tree/fork changes clear local eligibility until another verified activation. Old path-hash rows lack native-ID binding: no automatic reads/migration/deletion; existing retention and native transcripts are unchanged. Normal Pi startup/resume trusts the native transcript and does not read or inject historical SessionDB events; an explicit extension reload remains the repair boundary. No `getLatestSessionEvents`, latest-snapshot claim or raw XML fallback is needed for normal Pi resume.

Public delivery is `sendMessage({ customType: "context-mode-recovery", content, display: false, details }, { triggerTurn: false })`. Details contain `{ version:2, file, host, boundary, segment, reason, profile }`; segment is latest compaction entry ID or `initial`, reason is `resume|compact`, profile is `baseline|blackhole`. `boundary` must exist on the current branch. Version-1 bodies came from unbound path keys: reject them in metadata validation and filter only owned model messages, never rewrite historical entries. `activate("resume", ...)` never reads, renders or sends historical recovery; initial startup with a conversational branch is treated as the same native-transcript resume path. Explicit reload may use the legacy `resume` delivery provenance as a repair boundary. Preparation never sends; successful compaction finalizes. If preparation is absent, only unambiguous own-session events may be read. Asynchronous completion checks activation epoch, identity, segment and unchanged leaf before delivery.

Context hooks only remove invalid/superseded **custom-role, owned-type** messages. Eligibility requires a persisted entry on the current branch; scheduling alone is not delivery. Empty content is a durable retirement marker and is filtered from model context. Existing transcript entries remain append-only. Legacy resume rows are neither read nor consumed; stats explains the replacement. Duplicate callbacks/reload must not schedule the same boundary twice, including in-flight render and sent-but-not-flushed windows. Same-identity/same-boundary activation preserves the reservation and epoch; real identity/boundary changes invalidate it. Each filter invocation builds the segment and branch-ID set once; provenance checks are O(1) per entry/message with no cross-request cache.

Projection permanently excludes role/persona, intent/workmode, plan and task snapshots. Only compact+flag true additionally removes goal, prompt, file, error, skill and MCP-count categories, and **git + type=git_commit**. Noncommit Git, decisions, rule-file references (not `rule_content`), historical cwd/env/subagent records and bounded data references/search hints remain. Normalize `user-prompt` to the guide's `prompt` locally. All skill hints must disappear in trimmed output. Do not filter arbitrary text containing excluded words.

Genuine raw Pi `user_prompt` inserts use `SessionDB.insertEvent(..., bytes?, { deduplicate: false })` to retain A/B/A and consecutive equal occurrences. Derived events and all omitted/default options retain existing recent-window deduplication, with no schema changes.

Pi host search/data hints use `ctx_search(queries: [...], sort: "timeline")`, not `source: "session-events"`. Explain project history may include other sessions and records may be metadata/summaries; do not claim full outputs or a prebuilt index exist. Shared Claude defaults must remain byte-identical. Diagnostics is `/ctx-doctor`.

## 4. Validation / error matrix

| State | Behavior |
|---|---|
| New/empty session | No historical event read/injection |
| Existing own startup/resume | No historical read or injection; native transcript is authoritative |
| Explicit extension reload | Baseline repair projection; reuse identical delivered boundary |
| Failed/cancelled compaction | No supersession; prior segment stays active |
| Successful second compact, retained old tail | Only latest valid generation exposed |
| Empty compact projection | No custom send or persisted marker |
| Empty successful compact projection | One durable marker retires previous generation |
| Missing identity or divergent legacy branch | Omit rebuilding; never substitute foreign history |
| Missing renderer / send failure | Warn safely; no raw fallback; later eligible activation can retry |
| Missing settings / ENOENT | Default/inherit |
| Invalid object/boolean, malformed/unreadable file | Trimming off; lifecycle still enabled |
| Retired `recovery` namespace or other extension entry | Ignored as unknown field: no alias, no warning |
| Other extension/user messages | Preserve unchanged, including tool/result ordering |

## 5. Good / base / bad cases

- Base: repeated normal prompts capture events but append zero recovery messages.
- Good: startup/resume of an existing native transcript reads no historical events and appends zero recovery messages.
- Good: `git_branch` with data mentioning `commit` survives trimmed compact; `git_commit` does not.
- Good: Blackhole inline compact queues recovery during `turn_end`; Pi flushes before next model preparation.
- Bad: reading another session's unconsumed resume row because the current session has no events.
- Bad: calling historical failures unresolved or treating historical approvals as current authorization.

## 6. Required tests and verified limits

- `tests/adapters/pi-extension-adapter-settings.test.ts`: defaults, precedence, invalid lower tier, ENOENT, malformed/unreadable files, generic-settings isolation, other-extension isolation and ignored retired namespace.
- `tests/adapters/pi-recovery.test.ts`: category matrix, bounded data, excluded-only empty results, HEAD-derived Claude golden fixture, identity, no-read startup/resume, preparation/success/failure, persistent delivery confirmation, duplicates/reload, empty supersession, async stale identity and helper failure.
- `tests/pi-extension.test.ts`: real event shapes, strict preparation no-return/no-send, native-ID capture/stats/reopen/rename/path-reuse/legacy sentinels, startup/resume no-injection, explicit reload repair, real SessionDB + ContentStore timeline search, repeated prompt occurrences, lifecycle send without another prompt, context no-append and existing routing/bridge registration.
- Build then `node tests/fixtures/pi-recovery-host-smoke.mjs`: installed Pi 0.85.1 + pi-blackhole 0.5.2 inline adapter, no model/network, both product/synthetic-summary extension orders, real chained filtering, next-turn refresh, persisted entries, idle compact, empty retirement and tool ordering; fresh-process public-manager reopen/rename with native-ID SessionDB recovery (verified in the current host-smoke run). Overrides: `PI_SMOKE_CLI`, `PI_BLACKHOLE_ROOT`. Missing prerequisites fail explicitly; this is optional host-dependent verification, not a portable unit test.
- Preserve native replacement host smoke, focused Pi regressions, hook/session tests, typecheck, build and diff checks.

The host smoke uses private harness methods to simulate an active turn and deterministic summary; **production never may**. It does not validate live providers or full Blackhole observer/summary behavior. Another extension's summary may already contain old facts; filtering cannot erase those. Removing the extension removes its filter, not historical entries.

## 7. Wrong vs correct

**Wrong:** append a recovery user message from every `context` callback, or consume a resume snapshot immediately after `sendMessage` returns.

**Correct:** render once at the verified lifecycle boundary, use public persistent custom-message delivery, then only filter current context by branch-persisted provenance. No resume storage is consumed by this implementation.

**Wrong:** use the unit mock's first-truthy handler shortcut as evidence of compatibility with other extensions.

**Correct:** run the installed real runner's chained `emitContext` and both handler orderings. Keep deterministic smoke limitations explicit.
