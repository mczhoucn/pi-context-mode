# Pi native tool replacement contract

## 1. Scope / Trigger

Read this when changing Pi tool registration, `toolReplacements` configuration, Read truncation, or the published Pi extension entry. This contract is Pi-only; do not change shared MCP tool defaults to implement an opt-in host policy.

## 2. Signatures and ownership

Implementation owners:

- `src/adapters/pi/host-entry.ts`: static host-SDK import and injection into `piExtension`.
- `tool-replacement-settings.ts`: `loadToolReplacementSettings(projectDir, warn, home?)` and the single `normalizeToolReplacements(documents, warn)` decoder.
- `tool-replacements.ts`: `installToolReplacements(pi, cwd, settings, sdk, warn) -> { bash, read }`, `createBoundedRead`, and pure `formatReadText`.
- `mcp-bridge.ts`: effective Bash policy selects Pi-specific ctx descriptions and prompt metadata.

The package's `pi.extensions` and `.pi/extensions/context-mode/index.ts` must point to the same host entry. Ordinary Node tests import injectable helpers instead of requiring a globally installed Pi SDK.

## 3. Configuration and result contracts

See README's **Optional native tool replacements (Pi)** section for the user-facing configuration example and limitations. Reuse `resolvePiGlobalSettingsPath` and `resolveProjectSettingsPaths(projectDir, "pi")`; do not read Pi's generic settings or Claude/Trellis settings for this feature.

Both switches default off. Explicit project fields override global fields, then defaults. Read defaults are owned by `DEFAULT_READ_LIMITS`: 300 source lines and 10,240 UTF-8 bytes. Limits apply to source text; short continuation notices are additional metadata. Images and native image warnings are exempt.

`read` keeps path/offset/limit, native-compatible result/details/image shapes, and errors. Each invocation privately captures the complete Buffer and detected MIME from its own native ReadOperations. Native image results are returned unchanged; text is formatted from that Buffer, never from the native human-readable output. This limits model output, not whole-file memory usage.

Only an actually activated Bash replacement selects stronger ctx routing. Native Bash remains callable for failure recovery; never automatically retry possibly side-effecting ctx operations.

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
| Read offset/limit not positive safe integers | Error |
| Access/EOF/cancellation failure | Preserve failure, not a successful-looking excerpt |
| First source line exceeds byte budget | No source fragment; explicit guidance, no same-offset continuation loop |

## 5. Good / Base / Bad cases

- **Base:** both switches absent leaves original tool metadata and lazy MCP behavior unchanged.
- **Good:** reading 601 short lines returns lines 1–300 with offset 301, then 301–600 with offset 601, then the final line.
- **Good:** an empty file returns empty source without a misleading continuation; UTF-8 and CRLF survive exact excerpts.
- **Bad:** interpreting a source line containing `[999 more lines ...]` as actual pagination metadata.
- **Bad:** treating source=`builtin` as proof that the current tool uses factory defaults. Public runtime options are not available. Users explicitly opt into standard-local defaults, not transparent inheritance of custom shell/image settings.

## 6. Required tests and assertion points

- `tests/adapters/pi-tool-replacements.test.ts`: defaults/four combinations, configuration precedence/validation, ownership, exact line/byte caps, pagination, images, cancellation, and effective policy.
- `tests/pi-extension.test.ts`: registration/prompt metadata and lazy lifecycle integration.
- Existing Pi configuration, help/no-orphan, workspace, and bridge tests must remain green.
- After building, `node tests/fixtures/pi-replacements-host-smoke.mjs` checks the actual compiled entry through both installed Pi loaders, real native definitions, and a real AgentSession registry. It covers both extension orders and SDK ownership conflicts without simulating `getAllTools`. Resources/settings are isolated and it makes zero model requests; it is not a full model-session test.
- `npm run typecheck`, `npm run build`, and `git diff --check` are required gates.

SDK loader evidence is from Pi 0.85.1: static root imports work through bundled/unbundled loaders; compiled-JS dynamic imports do not resolve the virtual SDK. Capability checks do not rescue an unresolved static import; preserve the supported-loader documentation.

## 7. Wrong vs correct

**Wrong:** truncate the native result's text and derive the next offset by counting all returned lines. Native notices and source text are not distinguishable by string parsing.

**Correct:** capture the native readFile Buffer per invocation, preserve MIME-detected image results, and format exact source ranges with accurate continuation and truncation details.

**Wrong:** pass `{ maxLines, maxBytes }` to the native Read factory or assume its fixed 2,000-line/50-KiB formatter implements the feature.

**Correct:** native options do not accept those limits. Apply the configured source budget after native execution using the captured full Buffer, replacing only obsolete native text/truncation metadata.
