---
name: context-mode
description: >-
  Use context-mode for large or unpredictable command, file, test, build, log,
  API, browser, dependency, infrastructure, or data-analysis output, including
  code metrics, Git history, web documentation, and MCP output over 20 lines.
  Multiple related commands use ctx_batch_execute before ctx_execute;
  one command or transformation uses ctx_execute.
---

# Context Mode: Analyze Before Returning Data

## MANDATORY RULE

Default to context-mode for ALL commands, file analysis, and large or uncertain tool output. Use Bash only for guaranteed-small whitelist operations below. For files you need to edit, use the normal Read tool for exact text, then host edit/write tools.

### Host tool routing

Use the host's registered tool descriptions and runtime policy as the source of truth for native-tool routing. This skill does not inspect context-mode settings or decide which host routing mode is active. A host-provided recovery policy takes precedence over generic examples below; otherwise follow the host's normal native-tool surface.

### Bash whitelist

For a host where native Bash is the normal command surface, use Bash directly for these operations when their output is guaranteed small:
- File mutations: `mkdir`, `mv`, `cp`, `rm`, `touch`, `chmod`.
- Git writes: `git add`, `git commit`, `git push`, `git checkout`, `git branch`, `git merge`.
- Navigation: `cd`, `pwd`, `which`.
- Process control: `kill`, `pkill`.
- Package management: `npm install`, `npm publish`, `pip install`.
- Simple output: `echo`, `printf`.

Everything else goes through context-mode, including CLI inspection, tests/builds, Git logs/diffs, infrastructure queries, dependency/security audits, and code metrics. Host permissions still apply to every tool.

## Decision Tree

Route specialized sources before generic shell/CLI work; batch-first is not a universal tool hierarchy.

```text
Searching already-indexed content or session memory?
  -> ctx_search
Fetching web documentation or HTML pages to retain?
  -> ctx_fetch_and_index -> ctx_search (including multiple URLs)
Indexing local or inline reference material for later queries?
  -> ctx_index
Reading a file to analyze/summarize rather than edit?
  -> ctx_execute_file; the file is loaded into FILE_CONTENT
Using browser automation or inspecting snapshots, console, or network?
  -> Before browser tool calls, read [Browser workflows](./references/browser.md)
     relative to this SKILL.md for capture and parallel-session isolation
Processing another MCP tool's output?
  -> Already in context: use it directly
  -> Otherwise save to file: ctx_index(path) for repeated queries,
     or ctx_execute_file(path) for one-shot extraction
Multiple related shell/CLI commands, command-based research, or command-output gather-and-search?
  -> ctx_batch_execute before ctx_execute
One shell/CLI command MIGHT produce large output, or one data transformation?
  -> ctx_execute
```

## Critical Rules

- For one-shot questions, print findings, not raw data dumps: include supporting IDs, file paths, line numbers, and exact values, not just counts. Only printed output enters the conversation/index.
- For later exploratory searches, preserve the full output in the capture/index before narrowing with `ctx_search`. Truncating a command with `head` before capture permanently drops evidence; one-shot computed answers are a different mode.
- Save large tool results with `filename`, then pass the path to `ctx_index(path: ...)` or `ctx_execute_file`. Paths must be accessible and host-permitted; transfer remote files first.
- Use `ctx_index(content: ...)` only for small inline text you compose. Reuse MCP output already in context directly; passing its full text again duplicates the cost. Save/index copies only for later retrieval, not to undo an earlier context load.
- Prefer shell with available CLI tools (e.g. git, curl, rg, fd, jq, gh, yq, uv) when they solve the task clearly and reliably. Write custom code when tools are unsuitable or complex analysis, transformations, or control flow are hard to express clearly in shell; choose any suitable supported language. Use `language: "shell"` in `ctx_execute`; `ctx_batch_execute` accepts shell commands. For one existing file, prefer `ctx_execute_file` with `FILE_CONTENT` over a raw file read.
- Use the registered schemas for parameters. `intent` focuses retrieval from captured output; `timeout` is in milliseconds. Preserve test/build exit status when reporting results. Use batch concurrency only for independent I/O; keep CPU-heavy, stateful, or ordered work serial.

## Search and external documentation

- BM25 uses OR semantics: matches on more query terms rank higher. Use 2–4 specific technical terms rather than broad concepts.
- Batch related questions in one `queries` array. Use `source` when multiple documents are indexed; partial source-label matches work.
- Fetch external package documentation with `ctx_fetch_and_index`, rather than reading local copies of packages you do not own. For GitHub text, prefer `https://raw.githubusercontent.com/org/repo/main/CHANGELOG.md`. Scope follow-up searches to its source.

## Task-specific references

Read only the reference matching the current task; loading this skill does not require reading every linked file. Paths are relative to this skill directory.

- When diagnosing routing mistakes, missing captured evidence, empty output, or timeouts, read [Capture pitfalls](./references/anti-patterns.md).
- Only when a JavaScript/TypeScript implementation example is needed, read [JS/TS patterns](./references/patterns-javascript.md) for HTTP/JSON, dependencies, config diffs, and test-result parsing.
- Only when a Python implementation example is needed, read [Python patterns](./references/patterns-python.md) for CSV, logs, text extraction, file comparison, and duplicates.
- Only when a shell implementation example is needed, read [Shell patterns](./references/patterns-shell.md) for builds/tests, logs, disk/directory inspection, and Git history.

Subagent routing is supplied automatically by the host integration (PreToolUse hooks where supported); describe the task naturally instead of copying the tool catalog into every subagent prompt.
