# Contributing to context-mode

This project is licensed under the Elastic License 2.0 (ELv2) and moves forward with your support. Every issue, every PR, every idea matters.

Don't overthink it. Don't ask yourself "is my PR good enough?" or "is this issue too small?" -- just send it. A rough draft beats a perfect plan that never ships. If you found a bug, report it. If you have an idea, open an issue. If you wrote a fix, submit the PR.

That said, I'm a solo maintainer with limited time. The best way to help me help you: follow the templates, run the debug script (`bash scripts/ctx-debug.sh`), and write tests for your changes. The more context you give me, the faster I can review.

I genuinely love open source and I'm grateful to have you here. Don't hesitate to reach out -- whether it's a question, a suggestion, or just to say hi. Let's build this together.

---

This guide covers the local development workflow so you can test changes in a live Pi session before submitting a PR.

## Architecture Overview

context-mode uses a flat `src/` structure:

```
src/
  server.ts        → MCP server, tool handlers, auto-indexing
  store.ts         → FTS5 content store (index, search, chunking)
  executor.ts      → Polyglot code executor (12 languages)
  security.ts      → Permission enforcement (deny/allow rules)
  runtime.ts       → Runtime detection (Node, Bun, Python, etc.)
  db-base.ts       → SQLite base class (shared by store + session)
  truncate.ts      → Smart output truncation
  cli.ts           → CLI commands (setup, doctor)
  types.ts         → Shared type definitions
  session/
    db.ts          → SessionDB — persistent event storage
    extract.ts     → Event extractors for PostToolUse hook
    snapshot.ts    → Resume snapshot builder (priority tiers)
  adapters/
    types.ts       → HookAdapter interface, RoutingInstructionsConfig
    detect.ts      → Platform detection via env vars
    claude-code/   → Claude Code adapter (index.ts, hooks.ts, config.ts)
    qwen-code/     → Qwen Code adapter (extends Claude Code wire protocol)
    gemini-cli/    → Gemini CLI adapter
    opencode/      → OpenCode adapter
    codex/         → Codex CLI adapter
    vscode-copilot/ → VS Code Copilot adapter
    omp/           → retained upstream compatibility adapter (unsupported in this fork)
  openclaw/
    workspace-router.ts → Workspace path resolution for Pi Agent sessions
  openclaw-plugin.ts   → OpenClaw gateway plugin entry (sync register)
hooks/               → Plain JS hooks (.mjs) — no build needed
configs/             → Retained upstream platform assets; only configs/pi is supported here
```

`tsc` compiles `src/` → `build/`. `start.mjs` loads `server.bundle.mjs` (CI-built) if present, otherwise falls back to `build/server.js`.

> **Critical for local dev:** Delete `server.bundle.mjs` in your local clone or your `build/server.js` changes will never be loaded:
> ```bash
> rm server.bundle.mjs  # forces start.mjs to use build/server.js
> ```

### Session Continuity Architecture

Session events flow through a two-database system:

1. **SessionDB** (persistent, per-project): `~/.claude/context-mode/sessions/<hash>.db`
   - PostToolUse hook captures events in real-time
   - PreCompact hook builds resume snapshots
   - UserPromptSubmit hook captures user prompts

2. **ContentStore** (ephemeral, per-process): `/tmp/context-mode-<PID>.db`
   - FTS5 full-text search index for tool outputs
   - Auto-indexes session events file written by SessionStart hook
   - Dies when MCP server process exits

**Session restore flow** (compact/resume):
```
SessionStart hook → reads SessionDB → writes events as markdown file
                  → injects ~275 token directive (summary + search queries)
MCP server        → detects markdown file on next getStore() call
                  → auto-indexes into FTS5 → deletes file
LLM               → searches source:"session-events" for details on demand
```

Raw session events are **never injected into context**. Only a compact summary table + search queries are injected. The LLM searches for details via the existing `ctx_search()` MCP tool.

### Multi-writer contract (v1.0.130 — see [docs/adr/0001-sessiondb-multi-writer.md](docs/adr/0001-sessiondb-multi-writer.md))

Both SessionDB and ContentStore are **multi-writer-safe**. Two processes may open the same on-disk dbPath simultaneously — that is the legitimate multi-window UX shape. Write contention is handled by `withRetry()` on top of SQLite's built-in `busy_timeout` (30000ms). Do NOT add `acquireDbLock`-style file locks or `locking_mode = EXCLUSIVE` pragmas to `SQLiteBase` or `applyWALPragmas`. Process-identity invariants (one MCP per project) live in `src/util/sibling-mcp.ts`, not the DB layer.

## Prerequisites

- Pi Coding Agent
- Node.js 22.5 or newer, or Bun
- pnpm 10

## Local Development Setup

### 1. Clone, install, and build

```bash
git clone https://github.com/mksglu/context-mode.git
cd context-mode
pnpm install
pnpm build
```

### 2. Load the project extension in Pi

This repository includes `.pi/extensions/context-mode/index.ts`, which points to the compiled Pi host entry in `build/adapters/pi/host-entry.js` (which supplies the host SDK to the injectable adapter in `extension.js`). Start Pi from the repository root after the build so it can load that project-local extension.

Rebuild and restart Pi whenever extension or MCP bridge code changes.

For native replacement changes, run `node tests/fixtures/pi-replacements-host-smoke.mjs` after building. This optional installed-Pi check resolves `pi` from PATH (or `PI_SMOKE_CLI`), exercises both actual loaders and native Read/Bash without model requests, and isolates settings in a temporary directory. The normal unit tests use an injected SDK and do not require Pi installed.

### 3. Verify the local build

In a Pi session, ask `ctx_execute` to run `console.log("ok")`. The tool should return `ok`. Expand tool output with `Ctrl+O` when diagnosing a failure.
## Development Workflow

### Build and test your changes

```bash
# TypeScript compilation
npm run build

# Run all tests (parallel via Vitest)
npm test

# Type checking only
npm run typecheck

# Watch mode
npm run test:watch
```

### What needs rebuild?

| Changed | Rebuild needed? | Why |
|---------|:-:|---|
| `hooks/*.mjs` | No | Plain JS, loaded fresh each invocation |
| `src/*.ts` | Yes | Compiles to `build/` (MCP server, executor, store) |
| `src/session/*.ts` | Yes | Compiles to `build/session/`, imported by hooks |
| `src/adapters/**/*.ts` | Yes | Compiles to `build/adapters/`, platform detection + hooks |
| `configs/*` | No | Static files, served directly |

After rebuilding, restart your Pi session. The extension and MCP bridge reload when the session starts.

> **Tip:** If you only changed hook files (`hooks/*.mjs`), restart Pi without rebuilding. Hooks are plain JavaScript loaded fresh on each invocation.

### Key files to know

| File | Purpose |
|---|---|
| `src/server.ts` | MCP server, tool handlers, auto-indexing of session events |
| `src/store.ts` | FTS5 content store (index, search, chunking) |
| `src/executor.ts` | Polyglot code executor (JS, Python, Shell, etc.) |
| `src/session/db.ts` | SessionDB — persistent session event storage |
| `src/session/extract.ts` | Event extractors for PostToolUse hook |
| `src/adapters/detect.ts` | Platform detection (Claude Code, Gemini CLI, etc.) |
| `src/adapters/types.ts` | HookAdapter interface, shared adapter types |
| `hooks/sessionstart.mjs` | Session lifecycle (startup/compact/resume/clear) |
| `hooks/posttooluse.mjs` | Real-time event capture from tool calls |
| `hooks/precompact.mjs` | Resume snapshot builder (fires before compact) |
| `hooks/pretooluse.mjs` | Tool routing + context window protection |
| `hooks/session-helpers.mjs` | Shared utilities (stdin reader, session ID, DB paths) |

## TDD Workflow

We follow test-driven development. Every PR must include tests.

**We strongly recommend installing the context-mode-ops skill** — it includes TDD enforcement, issue triage, PR review, and release automation with parallel subagent orchestration.

The skill lives under `.claude/skills/context-mode-ops/` in this repo (moved from the deprecated `skills/` location in #439). Install via the direct path:

```bash
npx skills add https://github.com/mksglu/context-mode/tree/main/.claude/skills/context-mode-ops
```

### Red-Green-Refactor

1. **Red** -- Write a failing test for the behavior you want
2. **Green** -- Write the minimum code to make it pass
3. **Refactor** -- Clean up while keeping tests green

### Test file organization

**Do NOT create new test files.** Add your tests to the existing file that covers the same domain. We maintain a small number of well-organized test files — one per adapter, one per core module. Creating a new file per feature or per PR leads to fragmentation that makes the suite harder to navigate and maintain.

| Domain | Test File |
|---|---|
| Adapters | `tests/adapters/<platform>.test.ts` |
| Client detection | `tests/adapters/detect.test.ts`, `tests/adapters/client-map.test.ts` |
| Search & FTS5 | `tests/core/search.test.ts` |
| Server & tools | `tests/core/server.test.ts` |
| CLI & bundle | `tests/core/cli.test.ts` |
| Routing | `tests/core/routing.test.ts` |
| Hook routing | `tests/hooks/core-routing.test.ts` |
| Hook formatting | `tests/hooks/formatters.test.ts` |
| Hook integration | `tests/hooks/integration.test.ts` |
| Cursor hooks | `tests/hooks/cursor-hooks.test.ts` |
| Gemini hooks | `tests/hooks/gemini-hooks.test.ts` |
| VS Code hooks | `tests/hooks/vscode-hooks.test.ts` |
| JetBrains hooks | `tests/hooks/jetbrains-hooks.test.ts` |
| Kiro hooks | `tests/hooks/kiro-hooks.test.ts` |
| Copilot CLI hooks | `tests/hooks/copilot-cli-hooks.test.ts` |
| Antigravity CLI hooks | `tests/hooks/antigravity-cli-hooks.test.ts` |
| Session DB | `tests/session/session-db.test.ts` |
| Session extract | `tests/session/session-extract.test.ts` |
| Session snapshot | `tests/session/session-snapshot.test.ts` |
| Session continuity | `tests/session/continuity.test.ts` |
| Session pipeline | `tests/session/session-pipeline.test.ts` |
| Executor | `tests/executor.test.ts` |
| Store/Search | `tests/store.test.ts` |
| Security | `tests/security.test.ts` |
| OpenClaw plugin | `tests/plugins/openclaw.test.ts` |

If your change doesn't fit any existing file, discuss with the maintainer before creating a new one.

### Output quality matters

When your change affects tool output (ctx_execute, ctx_search, ctx_fetch_and_index, etc.), always compare before and after:

1. Run the same prompt **before** your change (on `main`)
2. Run it **again** with your change
3. Include both outputs in your PR

## Prose-style policy (issue [#482](https://github.com/mksglu/context-mode/issues/482))

context-mode does not dictate how the model writes its final answer. The four pillars (sandbox routing, session continuity, think-in-code, no prose-style enforcement) keep raw data out of context but leave editorial style — brevity vs. completeness, formatting, tone — entirely to the model and the user's own `CLAUDE.md` / `AGENTS.md`.

**Why:** aggressive brevity instructions have been shown to degrade coding/reasoning benchmarks. Moonshot AI's report on `kimi-k2.5` (cited in [#482](https://github.com/mksglu/context-mode/issues/482), with the OpenCode fix at [anomalyco/opencode#20259](https://github.com/anomalyco/opencode/pull/20259)) showed that prompts like "minimize output tokens", "MUST answer concisely with fewer than 4 lines", and "one-word answers are best" pushed coding models to drop assumptions, caveats, verification evidence, failure modes, and security warnings the user actually needed.

**What this means for contributors:**

- Do **not** add brevity directives to MCP tool descriptions in `src/server.ts`.
- Do **not** add `<communication_style>` or `<response_format>` blocks to `hooks/routing-block.mjs`.
- Do **not** put "Terse like caveman" / "Only fluff die" / "Drop articles, filler" / "fewer than N lines" wording in any shipped adapter config under `configs/*/`.
- Workflow-discipline rules — "write artifacts to FILES", "use descriptive `ctx_search` source labels", `<artifact_policy>` — are fine. They describe *what to do* (file vs. inline), not *how to write*.

The regression test at `tests/core/server.test.ts > prose-style policy (#482)` pins the deletion: any caveman-style language landing in `src/server.ts`, `hooks/routing-block.mjs`, or `README.md` will fail CI.

If you genuinely need to nudge the model on style for a specific use case, do it in your own project's `CLAUDE.md` / `AGENTS.md`. Don't ship it inside the framework.

## For Pi developers

context-mode works on Pi now. The extension injects routing rules, registers
ctx_* tools through the MCP bridge, and the lean `configs/pi/AGENTS.md` keeps
context budget tight.

**First-time setup:** If you open this project in Pi before running `npm install`
and `npm run build`, you will see errors. That's normal — the extension needs
the compiled server bundle. Run the build once and restart.

- If you use Pi: remove `CLAUDE.md` from your project root. Pi.dev reads both
  CLAUDE.md and AGENTS.md, burning double context on duplicated routing
  instructions the extension already injects.
- Use `ctx_search` to recall decisions, errors, and blockers from prior
  sessions instead of re-reading raw files.
- Run `context-mode insight` for personal analytics — session activity, tool
  usage, error rate, and project focus.

For the full local dev workflow, build commands, and test instructions, see
[the contributing guide above](#contributing-to-context-mode).

## Submitting a Bug Report

When filing a bug, **always include your prompt**. The exact message you sent to the agent is critical for reproduction. Without it, we can't debug the issue.

Required information:
- Debug script output: `bash scripts/ctx-debug.sh` (collects OS, runtimes, configs, hooks, SQLite diagnostics)
- The prompt that triggered the bug
- Full error output (expand with `Ctrl+O` in Pi)
- Steps to reproduce

## Submitting a Pull Request

1. Fork the repository
2. Create a feature branch from `next`
3. Follow the local development setup above
4. Write tests first (TDD)
5. Run `npm test` and `npm run typecheck`
6. Test in a live Pi session
7. Compare output quality before/after
8. Open a PR using the template

## Quick Reference

| Task | Command |
|---|---|
| Check version | `context-mode doctor` |
| Upgrade plugin | `context-mode upgrade` |
| View session stats | `context-mode statusline` |
| Run diagnostics | `bash scripts/ctx-debug.sh` |
| See background steps | `Ctrl+O` |
| Kill cached server | `pkill -f "context-mode.*start.mjs"` |
| Rebuild after changes | `npm run build` |
| Run all tests | `npm test` |
| Watch mode | `npm run test:watch` |
