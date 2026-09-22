# Pi native tool replacement contract

## 1. Scope / Trigger

Read this when changing Pi tool registration, `toolReplacements` configuration, `disabledBuiltinFeatures` policy, Read truncation, or the published Pi extension entry. This contract is Pi-only; do not change shared MCP tool defaults to implement an opt-in host policy — and do not add a shared "human-only" filter to `server.ts` either.

## 2. Signatures and ownership

Implementation owners:

- `src/adapters/pi/host-entry.ts`: static host-SDK import and injection into `piExtension`.
- `tool-replacement-settings.ts`: `loadToolReplacementSettings(projectDir, warn, home?)` and the single `normalizeToolReplacements(documents, warn)` decoder.
- `builtin-feature-settings.ts`: `loadBuiltinFeatureSettings(projectDir, warn, home?)` and `normalizeBuiltinFeatureSettings(documents, warn)`. `DEFAULT_DISABLED_BUILTIN_FEATURES` and `COMPACT_RECOVERY_FEATURE` are the only sources for those two defaults; `src/ctx-tool-catalog.ts` owns the canonical tool-name lists.
- `mcp-bridge.ts: bootstrapMCPTools(pi, script, { disabledTools })`: filters at the `pi.registerTool` boundary only.
- `extension.ts`: `ensureBuiltinFeatures(ctx)` caches the decoded settings per extension instance; `session_before_compact` / `session_compact` gate on `compactRecoveryDisabled`.
- `src/adapters/opencode/plugin.ts`: applies its own host policy (administrative tools excluded from the OpenCode/Kilo native map) because it consumes the same registry.
- `tool-replacements.ts`: `installToolReplacements(pi, cwd, settings, sdk, warn) -> { bash, read }`, `createBoundedRead`, and pure `formatReadText`.
- `system-prompt-guideline.ts`: pure `stripBashFileOperationsGuideline(text)` and `filterProviderPayload(payload)`; the extension registers them from `before_provider_request`.
- `mcp-bridge.ts`: effective Bash policy selects Pi-specific ctx descriptions and prompt metadata.

The package's `pi.extensions` and `.pi/extensions/context-mode/index.ts` must point to the same host entry. Ordinary Node tests import injectable helpers instead of requiring a globally installed Pi SDK.

## 3. Configuration and result contracts

See README's **Optional native tool replacements (Pi)** and **Disabling built-in features (Pi)** sections for the user-facing configuration examples and limitations. Reuse `resolvePiGlobalSettingsPath` and `resolveProjectSettingsPaths(projectDir, "pi")`; do not read Pi's generic settings or Claude/Trellis settings for either feature.

Both switches default off. Explicit project fields override global fields, then defaults. Read defaults are owned by `DEFAULT_READ_LIMITS`: 300 source lines and 10,240 UTF-8 bytes. Limits apply to source text; short continuation notices are additional metadata. Images and native image warnings are exempt.

The tool catalog is host-agnostic. `src/server.ts` registers and advertises all eleven `ctx_*` tools; adapters decide what reaches their own agent-facing registry. Never re-introduce a shared "human-only" filter in `server.ts`: that silently binds every host to one policy and is the failure mode `ctx-tool-catalog.ts` exists to prevent.

`disabledBuiltinFeatures` accepts the eleven `ctx_*` names plus `compactRecovery`. Tool entries are exact MCP names filtered before `pi.registerTool`, so a disabled tool is absent from Pi's callable registry and prompt metadata while its handler stays available to the CLI and other hosts. An absent live tool is unaffected; the filter can only remove. The list is replaced wholesale by the higher-priority tier (no per-entry merge, unlike `toolReplacements`), an explicit empty list restores every tool, and invalid configuration (non-array, non-string/unknown entry, malformed/unreadable file) warns once and falls back to hiding the five administrative tools. Unreadable settings arrive at the decoder as a `null` sentinel so the path is reported exactly once.

`compactRecovery` gates context-mode's own post-compaction recovery at both boundaries: `session_before_compact` skips `recovery.prepare` (so the pre-compaction event collection does not run either) and `session_compact` skips `recovery.compact`. Runtime capture, `incrementCompactCount`, `session_compact_failed` cleanup, Pi/Blackhole compaction, the native transcript and explicit-reload baseline recovery all remain unchanged. The filter also retires an already-injected `reason: "compact"` body from model context while the flag is on, so the feature is not still active through its own old output; `reason: "resume"` bodies are untouched, the transcript stays append-only, and re-enabling restores the body. The flag is read once per extension instance; tool visibility cannot change without a reload.

`read` keeps path/offset/limit, native-compatible result/details/image shapes, and errors. Each invocation privately captures the complete Buffer and detected MIME from its own native ReadOperations. Native image results are returned unchanged; text is formatted from that Buffer, never from the native human-readable output. This limits model output, not whole-file memory usage.

Only an actually activated Bash replacement selects stronger ctx routing. Native Bash remains callable for failure recovery; never automatically retry possibly side-effecting ctx operations. The replacement explicitly clears the native Bash `promptSnippet`: Pi therefore omits Bash from its textual `Available tools` section (including headings rewritten to `Core tools`) while retaining the callable provider tool and its full schema description. The recovery-only explanation lives in Bash's `promptGuidelines`, which Pi renders independently in `Guidelines`.

An effective Bash replacement also removes Pi's hardcoded Bash file-exploration bullet (`- Use bash for file operations like ls, rg, find`, plus its PowerShell variants) from the provider payload. Pi emits it from the ACTIVE TOOL NAMES alone (`dist/core/system-prompt.js:54-70`), so it cannot be suppressed through `promptGuidelines`, which are appended one-way; while the replacement is effective that bullet contradicts the ctx_execute routing policy. Removal happens at `before_provider_request` — the payload seam, after every `before_agent_start` chain and tool registration — and is content-addressed to the exact bullet line inside known instruction slots. It must NOT be gated on whole-string equality with `ctx.getSystemPrompt()`: an earlier payload handler (remove-pi-system) rewrites the same system text first, and provider payload families differ, so equality would silently stop matching. Non-instruction content (history, tool schemas, sampling fields) is never rewritten, an unchanged payload keeps its input reference, and errors leave the payload untouched.

Check ownership using the runtime-bound `getAllTools()` projection, not an extension's registration map. In Pi 0.85.1, `registerTool` synchronously calls `runtime.refreshTools`, bound by AgentSession to `_refreshToolRegistry`; its resulting `_toolDefinitions` backs `getAllTools()`. This permits immediate activation verification on the supported host. A third-party discovery-time owner must survive regardless of extension order; this does not promise protection against later dynamic takeovers.

## 4. Validation and error matrix

| Input/state | Behavior |
|---|---|
| Missing configuration | No native replacements |
| Nonboolean enabled flag | Disable affected feature and warn |
| Non-positive, non-integer, or unsafe limit | Disable Read and warn |
| Invalid explicit value in either config tier | Remains invalid even if another tier supplies a valid value |
| Malformed/unreadable settings | Disable both and warn; ENOENT is absence |
| Tool owned by another extension/SDK, unsupported schema/capability | Skip that feature and warn |
| Activation cannot be verified | Do not advertise effective routing; request reload/restart |
| Invalid explicit `disabledBuiltinFeatures` (shape, entry, or unreadable file) | Warn once and hide the five administrative tools; `compactRecovery` stays enabled |
| `disabledBuiltinFeatures` explicit list at the project tier | Replaces the global list entirely, including an explicit empty list |
| Disabled tool | Absent from `pi.registerTool` and `bridge.tools`; handler untouched for CLI/other hosts |
| `compactRecovery` disabled | No pre-compaction preparation, no recovery message, no retirement marker; an already-injected `reason: "compact"` body stops reaching the model while the transcript keeps it; capture and compact counting continue |
| `compactRecovery` enabled (default) | Existing prepare/deliver/provenance behavior is unchanged |
| Bash replacement inactive | Native Bash keeps its tool-summary snippet and Pi's Bash file-exploration bullet; payload passes through by reference |
| Bash replacement effective | Bash remains callable but has no tool-summary snippet; its fallback policy appears in `Guidelines`, and Pi's conflicting file-exploration bullet is removed from instruction slots only; every other field keeps its input reference |
| Payload slot already rewritten by another extension, unknown shape, hostile/proxy object | Filter is content-addressed and fails closed: unmatched or unreadable payloads are returned unchanged |
| Read offset/limit not positive safe integers | Error |
| Access/EOF/cancellation failure | Preserve failure, not a successful-looking excerpt |
| First source line exceeds byte budget | No source fragment; explicit guidance, no same-offset continuation loop |

## 5. Good / Base / Bad cases

- **Base:** both switches absent leaves original tool metadata and lazy MCP behavior unchanged; the five administrative tools stay hidden from Pi and compact recovery stays on.
- **Good:** an explicit empty `disabledBuiltinFeatures` restores the five administrative tools to Pi while leaving compact recovery on.
- **Good:** disabling `compactRecovery` stops both the pre-compaction collection and the post-compaction message, while capture and the compact counter continue.
- **Good:** reading 601 short lines returns lines 1–300 with offset 301, then 301–600 with offset 601, then the final line.
- **Good:** an empty file returns empty source without a misleading continuation; UTF-8 and CRLF survive exact excerpts.
- **Bad:** interpreting a source line containing `[999 more lines ...]` as actual pagination metadata.
- **Bad:** treating source=`builtin` as proof that the current tool uses factory defaults. Public runtime options are not available. Users explicitly opt into standard-local defaults, not transparent inheritance of custom shell/image settings.

## 6. Required tests and assertion points

- `tests/adapters/pi-builtin-feature-settings.test.ts`: defaults, per-feature classification, tier replacement, deduplication, agent-facing tool entries, every invalid shape, unknown-entry warning text, settings-path isolation, ENOENT, malformed file and directory-as-file.
- `tests/pi-extension.test.ts`: filter behavior through the real MCP child (`disabledTools: []` restores the administrative tools; a single-name filter leaves the rest; filtered names are absent from `registerTool`); `compactRecovery` suppression (no send and no retirement marker, compact counter still incremented), default-enabled compatibility, and fallback-to-defaults on an invalid list; registration/prompt metadata, lazy lifecycle integration, and `before_provider_request` registration plus its inactive-policy no-op.
- `tests/adapters/pi-tool-replacements.test.ts`: defaults/four combinations, configuration precedence/validation, ownership, Bash tool-summary suppression with independent fallback guidance, exact line/byte caps, pagination, images, cancellation, effective policy, and the decoded `disabledTools` set passed to the lazy bootstrap.
- `tests/core/server.test.ts`: `tools/list` advertises the complete catalog, `REGISTERED_CTX_TOOLS` annotations cover all eleven tools, and the ZodEffects guard still distinguishes an undetectable shape from a legitimately empty one.
- `tests/opencode-plugin.test.ts`: the OpenCode/Kilo native map still excludes the administrative tools under its own policy.
- `tests/adapters/pi-system-prompt-guideline.test.ts`: bullet variants, near-miss and non-LF fail-closed, every instruction slot shape, untouched history/tool schemas, reference preservation, idempotence, hostile payloads, and the real extension wiring (inactive policy is a no-op; effective policy strips after another handler rewrote the system text).
- `tests/pi-extension.test.ts`: registration/prompt metadata, lazy lifecycle integration, and `before_provider_request` registration plus its inactive-policy no-op (see §6's earlier entry for the builtin-feature cases).
- Existing Pi configuration, help/no-orphan, workspace, and bridge tests must remain green.
- After building, `node tests/fixtures/pi-replacements-host-smoke.mjs` checks the actual compiled entry through both installed Pi loaders, real native definitions, and a real AgentSession registry and system prompt. It covers Bash summary visibility and fallback guidance for both switch states, both extension orders, and SDK ownership conflicts without simulating `getAllTools`. Resources/settings are isolated and it makes zero model requests; it is not a full model-session test.
- `npm run typecheck`, `npm run build`, and `git diff --check` are required gates.

SDK loader evidence is from Pi 0.85.1: static root imports work through bundled/unbundled loaders; compiled-JS dynamic imports do not resolve the virtual SDK. Capability checks do not rescue an unresolved static import; preserve the supported-loader documentation.

- `PiRecovery` takes an optional `compactRecoveryDisabled?()` dependency. The Pi extension always supplies it from the decoded settings; unit harnesses that omit it keep the historical projection behavior.
- `tests/adapters/pi-recovery.test.ts`: compact-reason retirement while the flag is on (including re-enable restoring the body and the transcript staying append-only) and resume-reason bodies surviving the flag, alongside the existing category matrix, bounded data, provenance and lifecycle cases.

## 7. Wrong vs correct

**Wrong:** truncate the native result's text and derive the next offset by counting all returned lines. Native notices and source text are not distinguishable by string parsing.

**Correct:** capture the native readFile Buffer per invocation, preserve MIME-detected image results, and format exact source ranges with accurate continuation and truncation details.

**Wrong:** gate the bullet removal on `payload.instructions === ctx.getSystemPrompt()` (or on any whole-prompt equality). Earlier payload handlers and provider-specific serialization break that equality, and the filter silently stops working while the contradictory bullet stays in the prompt.

**Correct:** match the exact bullet LINE inside known instruction slots, return the payload by reference when nothing matched, and leave unknown shapes untouched.

**Wrong:** pass `{ maxLines, maxBytes }` to the native Read factory or assume its fixed 2,000-line/50-KiB formatter implements the feature.

**Correct:** native options do not accept those limits. Apply the configured source budget after native execution using the captured full Buffer, replacing only obsolete native text/truncation metadata.
