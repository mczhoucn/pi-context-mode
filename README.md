# Context Mode for Pi Coding Agent

[中文文档](README.zh_CN.md)

> This README is specifically written for the **Pi Coding Agent** plugin and documents its available features and configuration.

## What this is

Context Mode is an MCP server and a Pi extension that keeps large command output, files, web pages, and session history out of the model's context until they are needed. The Pi package adds a native bridge, lifecycle hooks, optional native-tool replacements, configurable tool visibility, and Pi-specific rendering.

The Pi entry point is `build/adapters/pi/host-entry.js`, declared by `package.json` under `pi.extensions`. The extension starts `server.bundle.mjs` lazily, performs the MCP handshake, and registers the `ctx_*` tools in Pi's own tool registry. A second MCP entry is not required for this Pi package path.

## Install

**Requirements:** Pi Coding Agent and Node.js `>=22.5` (Bun is also supported by the runtime adapter).

```bash
npm install -g pi-context-mode
pi install npm:pi-context-mode
```

Restart Pi after installation. For a source checkout:

```bash
pnpm install
pnpm build
```

## Pi settings

Context Mode reads only these files:

- Global: `~/.pi/agent/context-mode/settings.json`
- Project: `<project>/.pi/context-mode/settings.json`

**Before:** Pi context-mode settings and permission resolution reused Claude Code settings and Pi's generic `~/.pi/settings.json`, with broad fallback behavior. A configuration intended for another host could therefore affect Pi or be picked up unexpectedly.

**Now:** these Pi features read only the two context-mode-owned files listed above. Project settings override global settings, and there is no fallback to Claude Code settings or generic Pi settings.

**Benefits:** Pi configuration is isolated from other hosts, precedence is predictable, and users have one explicit project path and one explicit global path to manage.

A complete example is:

```json
{
  "toolReplacements": {
    "bash": { "enabled": true },
    "read": { "enabled": true, "maxLines": 300, "maxBytes": 10240 }
  },
  "tidyToolDisplay": { "enabled": true },
  "disabledBuiltinFeatures": [
    "ctx_stats",
    "ctx_doctor",
    "ctx_upgrade",
    "ctx_purge",
    "ctx_insight"
  ],
  "extensionAdapters": {
    "blackhole": { "enabled": true }
  }
}
```

All sections are optional. Invalid settings fail closed and warn without blocking Pi startup. Reload the extension or restart Pi after changing settings; live toggling is not supported.

## Pi-specific features

### 1. Native prompt metadata

**Before:** the Pi adapter assembled a static routing anchor during `before_agent_start` and appended it through Pi's `context` hook as an extra model-visible message. The message explained the tool hierarchy and when to choose `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_search`, and related tools.

**Now:** the Pi adapter puts stable tool-selection guidance in Pi's native `promptSnippet` / `promptGuidelines` metadata when registering the tools. `before_agent_start` keeps only dynamic session context, such as active memory and resume data, and no longer adds the static routing anchor.

**Benefits:** the routing guidance stays attached to the relevant tool, repeated prompt text is removed from every turn, and the stable prompt prefix is easier for providers to cache. Dynamic session information remains available without mixing it with static tool instructions.

### 2. Native Bash and Read replacements (off by default)

Enable them independently under `toolReplacements`.

- **Bash:** routes shell work through `ctx_execute` when the replacement is really active. Native Bash remains callable as a recovery channel, but is removed from Pi's textual tool summary. Pi's contradictory file-exploration Bash bullet is removed only from known provider instruction fields; history, tool schemas, and unrelated payload fields are untouched.
- **Read:** keeps native `read(path, offset?, limit?)` semantics while bounding returned text to `maxLines` and `maxBytes`. Defaults are 300 source lines and 10,240 UTF-8 bytes. Images are preserved, and continuation offsets are reported separately from source text.
- Ownership is checked from Pi's live tool registry. If another extension owns `bash` or `read`, the replacement is skipped and stronger routing is not advertised.
- The two settings are independent. An invalid explicit value disables only the affected replacement; malformed or unreadable settings disable both safely.

### 3. Tidy-style tool display (off by default)

This display is modeled on the `pi-tidy-tools` plugin (`@mobrienv/pi-tidy-tools`), but implemented within this plugin without importing or depending on it. `tidyToolDisplay.enabled` enables this style for Context Mode's Pi tools; it does not enable Bash or Read replacement by itself.

If you also enable `toolReplacements.bash.enabled` and/or `toolReplacements.read.enabled`, each successfully activated replacement uses the same `pi-tidy-tools`-style display.

**Using both plugins:** if `pi-tidy-tools` is installed, configure it to pass through the native `bash` and `read` tools that Context Mode will replace—leave those tools unreplaced by `pi-tidy-tools`. Otherwise, both plugins compete to replace the same tool. Context Mode skips its replacement and warns when it detects another plugin already owns that tool; the two replacements are not automatically combined. Other tools can continue to use `pi-tidy-tools`.

When enabled, the Pi-side schema copy adds a display-only `reasoning` sentence. The field is removed before execution. Calls render as two lines with category icons, purpose/target, full-width backgrounds, elapsed time, result counts, and error status. Narrow rows keep the trailing statistic and shorten the target with `…`. Expanded rows keep the two-line header and then show the result.

The display reports line counts for `read` and `ctx_execute_file`, elapsed completion for shell tools, command counts for `ctx_batch_execute`, hit counts for `ctx_search`, section counts for indexing tools, and a compact `done` status for other tools.

### 4. Tool visibility and compact recovery

`disabledBuiltinFeatures` is a complete replacement list, not a merge. It accepts the eleven `ctx_*` names plus `compactRecovery`.

- By default, `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, and `ctx_insight` are hidden from Pi agents because these tools are intended for people rather than normal agent turns; registering them in Pi's tool list would waste context space.
- An explicit empty list restores all eleven tools to Pi.
- Disabling a tool removes it from Pi's registry and prompt metadata, but does not remove its CLI or other-host handler.
- `compactRecovery` disables Context Mode's own post-compaction preparation, recovery message, and retirement marker. Runtime capture, the native transcript, compaction counting, and explicit-reload recovery remain available.
- Invalid lists fall back to the safe defaults: administrative tools hidden and compact recovery enabled.
- The shared MCP catalog remains complete; Pi filters only its own agent-facing registry, so other hosts can apply their own visibility policy.

### 5. Pi-Blackhole compact-recovery integration

This Pi adapter supports running alongside `pi-blackhole`. After compaction, `pi-blackhole` can inject its pre-compaction snapshot while Context Mode publishes its own hidden recovery message. The adapter coordinates the two messages so they complement rather than repeat each other.

- Enable `extensionAdapters.blackhole.enabled` to omit overlapping entries from Context Mode's compact-recovery projection: `goal`, `prompt`, `file`, `error`, `skill`, `mcp`, and `git` events with type `git_commit`.
- Only Context Mode's recovery message is filtered. The `pi-blackhole` message and Pi's native transcript are not modified. Filtering applies to compact recovery only; resume recovery is not filtered by this switch.
- Session events use Pi's native session ID and the canonical per-project SessionDB path. Recovery messages are bound to the current branch and compaction segment, while duplicate callbacks, stale identities, and foreign branches are rejected.
- Normal startup and resume trust Pi's native transcript and do not inject historical SessionDB events again.

This lets `pi-blackhole` provide the pre-compaction snapshot while Context Mode supplies the remaining recovery context, reducing repeated tokens and avoiding duplicate recovery information.

### 6. Guidance and validation improvements

- Tool guidance prefers an existing CLI such as `git`, `rg`, `fd`, `jq`, `gh`, `yq`, or `uv` when it is the clearest reliable solution; custom code is used when shell is unsuitable or the logic is complex.
- `ctx_search` validates missing, empty, and invalid-string queries before checking whether the index is empty.
- The public `ctx_search` schema no longer advertises a misleading backslash pattern; actual non-empty query validation remains in the handler.
- Tool descriptions, `ctx_index`, `ctx_batch_execute`, fetch inputs, result counts, and recovery routing guidance now match runtime behavior.

### 7. Bug fixes

- **Bridge startup:** A parent Pi process could inherit `CONTEXT_MODE_BRIDGE_DEPTH` and be mistaken for a bridge child, causing its tools to be disabled. The fix marks only spawned bridge children with `CONTEXT_MODE_BRIDGE_CHILD` and requires that marker together with a positive depth before stopping bridge startup.
- **Database cleanup:** A content database could be removed merely because its WAL had been quiet, even while the database was still in use. Cleanup now follows the retention period of the main database instead of WAL inactivity alone, preserving the live database and its WAL.

## Development and verification

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
git diff --check
```

The Pi-specific tests cover settings precedence and isolation, tool ownership, Read limits, Bash routing, prompt filtering, lifecycle recovery, tidy rendering, bridge registration, and real-host smoke behavior. The package is distributed under the Elastic License 2.0; see [LICENSE](LICENSE).
