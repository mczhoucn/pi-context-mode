# Context Mode

**The other half of the context problem.**

[![users](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2Fmksglu%2Fcontext-mode%40main%2Fstats.json&query=%24.message&label=users&color=brightgreen)](https://www.npmjs.com/package/context-mode) [![npm](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2Fmksglu%2Fcontext-mode%40main%2Fstats.json&query=%24.npm&label=npm&color=blue)](https://www.npmjs.com/package/context-mode) [![marketplace](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2Fmksglu%2Fcontext-mode%40main%2Fstats.json&query=%24.marketplace&label=marketplace&color=blue)](https://github.com/mksglu/context-mode) [![GitHub stars](https://img.shields.io/github/stars/mksglu/context-mode?style=flat&color=yellow)](https://github.com/mksglu/context-mode/stargazers) [![GitHub forks](https://img.shields.io/github/forks/mksglu/context-mode?style=flat&color=blue)](https://github.com/mksglu/context-mode/network/members) [![Last commit](https://img.shields.io/github/last-commit/mksglu/context-mode?color=green)](https://github.com/mksglu/context-mode/commits) [![License: ELv2](https://img.shields.io/badge/License-ELv2-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/discord/1478479412700909750?label=Discord&logo=discord&color=5865f2)](https://discord.gg/DCN9jUgN5v)
[![Hacker News #1](https://img.shields.io/badge/Hacker%20News-%231%20%E2%80%A2%20570%2B%20points-ff6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/item?id=47193064)

<p align="center">
<sub>Used across teams at</sub>
<br><br>
<a href="#"><img src="https://img.shields.io/badge/Microsoft-141414?style=flat" alt="Microsoft" /></a>
<a href="#"><img src="https://img.shields.io/badge/Google-141414?style=flat&logo=google&logoColor=white" alt="Google" /></a>
<a href="#"><img src="https://img.shields.io/badge/Meta-141414?style=flat&logo=meta&logoColor=white" alt="Meta" /></a>
<a href="#"><img src="https://img.shields.io/badge/Amazon-141414?style=flat" alt="Amazon" /></a>
<a href="#"><img src="https://img.shields.io/badge/IBM-141414?style=flat" alt="IBM" /></a>
<a href="#"><img src="https://img.shields.io/badge/NVIDIA-141414?style=flat&logo=nvidia&logoColor=white" alt="NVIDIA" /></a>
<a href="#"><img src="https://img.shields.io/badge/ByteDance-141414?style=flat&logo=bytedance&logoColor=white" alt="ByteDance" /></a>
<a href="#"><img src="https://img.shields.io/badge/Stripe-141414?style=flat&logo=stripe&logoColor=white" alt="Stripe" /></a>
<a href="#"><img src="https://img.shields.io/badge/Datadog-141414?style=flat&logo=datadog&logoColor=white" alt="Datadog" /></a>
<a href="#"><img src="https://img.shields.io/badge/Salesforce-141414?style=flat" alt="Salesforce" /></a>
<a href="#"><img src="https://img.shields.io/badge/GitHub-141414?style=flat&logo=github&logoColor=white" alt="GitHub" /></a>
<a href="#"><img src="https://img.shields.io/badge/Red%20Hat-141414?style=flat&logo=redhat&logoColor=white" alt="Red Hat" /></a>
<a href="#"><img src="https://img.shields.io/badge/Supabase-141414?style=flat&logo=supabase&logoColor=white" alt="Supabase" /></a>
<a href="#"><img src="https://img.shields.io/badge/Canva-141414?style=flat" alt="Canva" /></a>
<a href="#"><img src="https://img.shields.io/badge/Notion-141414?style=flat&logo=notion&logoColor=white" alt="Notion" /></a>
<a href="#"><img src="https://img.shields.io/badge/Hasura-141414?style=flat&logo=hasura&logoColor=white" alt="Hasura" /></a>
<a href="#"><img src="https://img.shields.io/badge/Framer-141414?style=flat&logo=framer&logoColor=white" alt="Framer" /></a>
<a href="#"><img src="https://img.shields.io/badge/Cursor-141414?style=flat&logo=cursor&logoColor=white" alt="Cursor" /></a>
</p>

## The Problem

Every MCP tool call dumps raw data into your context window. A Playwright snapshot costs 56 KB. Twenty GitHub issues cost 59 KB. One access log — 45 KB. After 30 minutes, 40% of your context is gone. And when the agent compacts the conversation to free space, it forgets which files it was editing, what tasks are in progress, and what you last asked for. On top of that, the agent wastes output tokens on filler, pleasantries, and verbose explanations — burning context from both sides.

### How Context Mode Solves It

Context Mode is an MCP server that solves all four sides of this problem:

1. **Context Saving** — Sandbox tools keep raw data out of the context window. 315 KB becomes 5.4 KB. 98% reduction.
2. **Session Continuity** — Every file edit, git operation, task, error, and user decision is tracked in SQLite. When the conversation compacts, context-mode doesn't dump this data back into context — it indexes events into FTS5 and retrieves only what's relevant via BM25 search. The model picks up exactly where you left off. If you don't `--continue`, previous session data is deleted immediately — a fresh session means a clean slate.
3. **Think in Code** — The LLM should program the analysis, not compute it. Instead of reading 50 files into context to count functions, the agent writes a script that does the counting and `console.log()`s only the result. One script replaces ten tool calls and saves 100x context. This Pi-focused distribution treats the LLM as a code generator instead of a data processor.

   ```js
   // Before: 47 × Read() = 700 KB.  After: 1 × ctx_execute() = 3.6 KB.
   ctx_execute("javascript", `
     const files = fs.readdirSync('src').filter(f => f.endsWith('.ts'));
     files.forEach(f => console.log(f + ': ' + fs.readFileSync('src/'+f,'utf8').split('\\n').length + ' lines'));
   `);
   ```
4. **No prose-style enforcement** — context-mode keeps raw data out of context but never dictates how the model writes its final answer. Brevity, completeness, formatting — your model's call (or yours via your own `CLAUDE.md` / `AGENTS.md`). Aggressive brevity prompts have been shown to degrade coding/reasoning benchmarks ([Moonshot AI on `kimi-k2.5`](https://github.com/anomalyco/opencode/issues/20258)) — the routing block stays focused on *where data goes*, not on *how the model talks*.

<a href="https://www.youtube.com/watch?v=QUHrntlfPo4">
  <picture>
    <img src="https://img.youtube.com/vi/QUHrntlfPo4/maxresdefault.jpg" alt="Watch context-mode demo on YouTube" width="100%">
  </picture>
</a>
<p align="center"><a href="https://www.youtube.com/watch?v=QUHrntlfPo4"><img src="https://img.shields.io/badge/%E2%96%B6%EF%B8%8F_Watch_Demo-YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch on YouTube"></a></p>

## Install

This downstream distribution documents and validates only **Pi Coding Agent**. Other adapter sources remain solely to keep upstream merges manageable; they are not supported installation targets in this fork.

<details>
<summary><strong>Pi Coding Agent</strong> — extension with full hook support</summary>

**Prerequisites:** Node.js >= 22.5 (or Bun), Pi Coding Agent installed.

**Install:**

1. Install context-mode globally:

   ```bash
   npm install -g context-mode
   ```

2. Install the package into Pi:

   ```bash
   pi install npm:context-mode
   ```

   Alternative — add it manually to `~/.pi/agent/settings.json` (or `.pi/settings.json` for project-level):

   ```json
   {
     "packages": ["npm:context-mode"]
   }
   ```

3. Add to `~/.pi/agent/mcp.json` (or `.pi/mcp.json` for project-level):

   ```json
   {
     "mcpServers": {
       "context-mode": {
         "command": "context-mode"
       }
     }
   }
   ```

4. Restart Pi.

**Context-mode settings in Pi:** security permissions are read from exactly these two files:

- Project: `<project>/.pi/context-mode/settings.json`
- Global: `~/.pi/agent/context-mode/settings.json`

Pi does not read `.claude/settings.local.json`, `.claude/settings.json`, or the generic `~/.pi/settings.json` for context-mode permissions.

### Optional native tool replacements (Pi)

Both replacements are **off by default**. To opt in, add this namespace to either context-mode settings file above (leave existing permissions intact):

```json
{
  "toolReplacements": {
    "bash": { "enabled": true },
    "read": { "enabled": true, "maxLines": 300, "maxBytes": 10240 }
  }
}
```

- The switches are independent. Explicit project fields override global fields; omitted fields inherit global values, then defaults. Booleans must be actual booleans; limits must be positive safe integers (zero is not unlimited). An invalid explicit value in either tier disables that replacement with a warning. Malformed/unreadable settings disable both. These settings never come from Pi's generic settings, Claude, or Trellis.
- **Bash enabled:** route every shell command through `ctx_execute`, even small output, navigation, or filesystem mutations. Use an explicit shell chain for dependent commands. `ctx_batch_execute` is for suitable output collection/search, not transactions; parallel commands must be independent. Native `bash` remains callable as a context-mode failure-recovery channel, but it is omitted from Pi's textual tool summary; its recovery-only policy is rendered under `Guidelines` instead. Inspect possible side effects before retrying: there is no automatic fallback or rollback. Existing permissions and the HTTP routing guard still apply. Pi's hardcoded `- Use bash for file operations like ls, rg, find` bullet (and its PowerShell variants) is removed from the request payload, because Pi emits it from active tool names alone and it contradicts this routing policy. The removal touches the system instructions only — never conversation history, tool schemas, or sampling fields — and is skipped while the Bash replacement is not effective.
- **Read enabled:** keep native `read(path, offset?, limit?)` and images, without routing through `ctx_execute_file`. Text defaults to **300 source lines / 10,240 UTF-8 bytes**, whichever comes first. A smaller requested line limit is respected; larger/omitted limits cannot bypass caps. Offset and limit must be positive safe integers. Complete lines, CRLF, and multibyte characters are preserved. Short continuation notices are **additional metadata outside the source-text budget**; follow the displayed next offset. An oversized first line returns no source text: increase `maxBytes` or use ctx for explicitly partial analysis, not complete edit evidence. Images and native image warnings are exempt from text limits. This bounds output, not whole-file read memory.
- **Compatibility:** verified with `@earendil-works/pi-coding-agent` 0.85.1 using its bundled and unbundled loaders. The Pi-only entry imports the host SDK statically; no second SDK is installed or bundled. Module evaluation still occurs with switches off. Other hosts/loaders are not guaranteed to resolve that SDK module. At runtime, an absent capability, unsupported schema, or another extension/SDK owning the native tool skips that replacement and warns; a skipped Bash replacement does not activate the stronger ctx policy.
- **Standard-local profile:** opting in rebuilds native definitions with standard local defaults. It does not inherit hidden runtime shell path, command prefix, image-resize settings, or custom SDK operations, and cannot compose arbitrary third-party wrappers or guarantee against later dynamic takeovers.
- **Cross-extension ordering:** provider payload handlers run in extension load order, but the removal does not depend on it. It is content-addressed to the exact bullet line inside known instruction slots rather than gated on a whole-prompt equality check, so another extension that rewrote the same system text first cannot disable it.
- **Apply/rollback:** reload extensions or restart Pi after changing settings. Disable a switch and reload/restart to restore the previous behavior; live toggling is not supported.

**Verify:** In a Pi session, ask `ctx_execute` to print `ok`.

**Routing:** Automatic. The extension registers all key lifecycle events (`tool_call`, `tool_result`, `session_start`, `session_before_compact`), providing full session continuity and routing enforcement.

### Optional tidy-style tool display (Pi)

This switch is **off by default**. It only changes how context-mode draws its own Pi calls. It does not import, call, or read `@mobrienv/pi-tidy-tools`, and it does not turn `bash` or `read` replacement on.

```json
{
  "tidyToolDisplay": { "enabled": true }
}
```

- Put it beside `toolReplacements` in the same two context-mode settings files. An explicit project boolean overrides the global boolean. A non-boolean value, a malformed `tidyToolDisplay` object, or an unreadable settings file disables only this switch and warns. It does not disable Bash or Read replacements. A malformed `toolReplacements` object does not disable this switch. `purposeDisplay` and `extensionAdapters` are not this switch.
- **Off:** no purpose field is added. `ctx_*` stays the current one-line tool name and result summary. Bash and Read replacements keep their current display and execution.
- **On:** context-mode adds a required `reasoning` string to the Pi-side schema copy only. The model should write one short sentence in the user's language stating the goal, not a command, path, or secret. The field is removed from a copied argument object before MCP or native execution. Omitting it, leaving it blank, or sending a non-text value still runs the call; the first line then shows the concrete target, or only the tool name when there is no target. If a tool schema already has `reasoning`, context-mode does not overwrite it and does not refuse the call.
- Folded output is two lines: the tool name plus the purpose in the normal text color, then the concrete target plus a short result. `read` uses the same light-blue terminal color tidy uses for read. `ctx_execute`, replaced `bash`, and other context-mode tools use the magenta tidy uses for bash. Both lines use the full-width tool background. Expanding keeps those two lines and adds the full text on the same background. Backgrounds and the purpose use Pi's own colors. It does not copy tidy icons, timers, or diffs.
- `bash` and `read` get those two lines only when context-mode's replacement is actually active. If another extension still owns those names, the replacement is skipped and warned, and the stronger shell routing stays off. That ownership conflict is unchanged by this switch.
- **Apply/rollback:** reload extensions or restart Pi after changing the switch. Live toggling is not supported.

### Disabling built-in features (Pi)

The five administrative operations are **hidden from Pi agents by default**. They remain callable from the terminal CLI and from other hosts; only Pi's own agent-facing tool catalog excludes them. To change what Pi exposes, add this namespace to either context-mode settings file above:

```json
{
  "disabledBuiltinFeatures": [
    "ctx_stats",
    "ctx_doctor",
    "ctx_upgrade",
    "ctx_purge",
    "ctx_insight"
  ]
}
```

Accepted entries are these five tool names, the other agent-facing tools (`ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`) if you want to narrow the sandbox toolset, and one feature switch:

| Entry | Effect |
|---|---|
| A `ctx_*` tool name | That tool is not registered with Pi: the agent cannot see or call it, and its Pi prompt metadata is absent. Its handler still exists for the CLI and other hosts. |
| `compactRecovery` | Disables context-mode's own post-compaction recovery: the pre-compaction data collection for that summary is skipped, and no recovery message is injected after a successful compaction. |

Behavior notes:

- **Default:** the five administrative tools are disabled; `compactRecovery` is enabled. Writing the list is how you change that, including an explicit empty list — `"disabledBuiltinFeatures": []` restores all five tools to Pi while leaving post-compaction recovery on.
- The list is a complete statement, not a merge: an explicit project list replaces the global list, and a project file without the field inherits the global value, then the default.
- Disabling a *tool* never disables the matching Pi slash command (`/ctx-stats`, `/ctx-doctor`), and never changes the MCP server's own tool catalog for other hosts.
- Disabling `compactRecovery` does **not** stop runtime event capture, Pi's or Blackhole's compaction, SessionDB writes, the native transcript, or lifecycle recovery on an explicit extension reload. It only stops context-mode's compact-boundary summary. A summary injected before the setting changed also stops reaching the model, so the feature is not still active through its own old output; the append-only transcript is never rewritten, so re-enabling the feature restores it.
- Invalid configuration (non-array value, non-string or unknown entry, malformed/unreadable file) warns once and falls back to the defaults: administrative tools hidden, `compactRecovery` enabled. It never blocks Pi startup.
- These settings never come from Pi's generic settings, Claude, or Trellis, and they are independent of `toolReplacements`, `tidyToolDisplay`, and `extensionAdapters`.
- **Apply/rollback:** tool visibility is fixed when Pi registers the bridge, so reload extensions or restart Pi after changing this list. Live toggling is not supported.

</details>

<details>
<summary><strong>Build Prerequisites</strong> <sup>(CentOS, RHEL, Alpine)</sup></summary>

Context Mode uses [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) on Node.js, which ships prebuilt native binaries for most platforms. On glibc >= 2.31 systems (Ubuntu 20.04+, Debian 11+, Fedora 34+, macOS, Windows), `npm install` works without any build tools.

**Linux + Node.js >= 22.5:** Context Mode automatically uses the built-in `node:sqlite` module instead of `better-sqlite3`. This eliminates the native addon entirely, avoiding [sporadic SIGSEGV crashes](https://github.com/nodejs/node/issues/62515) caused by V8's `madvise(MADV_DONTNEED)` corrupting the addon's `.got.plt` section on Linux. No configuration needed — detection is automatic. **Linux + Node < 22.5 is unsupported** ([#564](https://github.com/mksglu/context-mode/issues/564)) — `npm install` will fail with remediation instructions.

**Bun users:** No native compilation needed. Context Mode automatically detects Bun and uses the built-in `bun:sqlite` module via a compatibility adapter. `better-sqlite3` and all its build dependencies are skipped entirely.

On older glibc systems (CentOS 7/8, RHEL 8, Debian 10), prebuilt binaries don't load and better-sqlite3 **automatically falls back to compiling from source** via `prebuild-install || node-gyp rebuild --release`. This requires a C++20 compiler (GCC 10+), Make, and Python with setuptools.

**Windows / missing binding self-heal:** if `better_sqlite3.node` ends up missing after install (e.g. `prebuild-install` not on cmd.exe PATH, no MSVC toolchain), the postinstall script and the runtime hook automatically re-fetch the prebuild and repair the binding — no manual `npm rebuild` needed (#408).

**CentOS 8 / RHEL 8** (glibc 2.28):

```bash
dnf install -y gcc-toolset-10-gcc gcc-toolset-10-gcc-c++ make python3 python3-setuptools
scl enable gcc-toolset-10 'npm install -g context-mode'
```

**CentOS 7 / RHEL 7** (glibc 2.17):

```bash
yum install -y centos-release-scl
yum install -y devtoolset-10-gcc devtoolset-10-gcc-c++ make python3
pip3 install setuptools
scl enable devtoolset-10 'npm install -g context-mode'
```

**Alpine Linux:**

Alpine prebuilt binaries (musl) are available in better-sqlite3 v12.8.0+. With the `^12.6.2` dependency range, `npm install` resolves to the latest 12.x and works without build tools on Alpine. If you pin an older version:

```bash
apk add build-base python3 py3-setuptools
npm install -g context-mode
```

</details>

## Tools

| Tool | What it does | Context saved |
|---|---|---|
| `ctx_batch_execute` | Run multiple commands + search multiple queries in ONE call. Opt-in `concurrency: 1-8` for I/O-bound batches. | 986 KB → 62 KB |
| `ctx_execute` | Run code in 12 languages. Only stdout enters context. | 56 KB → 299 B |
| `ctx_execute_file` | Process files in sandbox. Raw content never leaves. | 45 KB → 155 B |
| `ctx_index` | Chunk markdown into FTS5 with BM25 ranking. | 60 KB → 40 B |
| `ctx_search` | Query indexed content with multiple queries in one call. | On-demand retrieval |
| `ctx_fetch_and_index` | Fetch URL, chunk and index. Cache reuses content within TTL (default 24h, override per-call with `ttl: <ms>`). `ttl: 0` or `force: true` to bypass. Pass `requests: [{url, source}, ...]` + `concurrency: 1-8` for parallel multi-URL. | 60 KB → 40 B |

## How the Sandbox Works

Each `ctx_execute` call spawns an isolated subprocess with its own process boundary. Scripts can't access each other's memory or state. The subprocess runs your code, captures stdout, and only that stdout enters the conversation context. The raw data — log files, API responses, snapshots — never leaves the sandbox.

Twelve language runtimes are available: JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir, and C#. Bun is auto-detected for 3-5x faster JS/TS execution.

Authenticated CLIs work through credential passthrough — `gh`, `aws`, `gcloud`, `kubectl`, `docker` inherit environment variables and config paths without exposing them to the conversation.

When output exceeds 5 KB and an `intent` is provided, Context Mode switches to intent-driven filtering: it indexes the full output into the knowledge base, searches for sections matching your intent, and returns only the relevant matches with a vocabulary of searchable terms for follow-up queries.

## How the Knowledge Base Works

The `ctx_index` tool chunks markdown content by headings while keeping code blocks intact, then stores them in a **SQLite FTS5** (Full-Text Search 5) virtual table. The SQLite backend is selected automatically at runtime: `bun:sqlite` on Bun, `node:sqlite` on Node.js >= 22.5, and `better-sqlite3` everywhere else. Search uses **BM25 ranking** — a probabilistic relevance algorithm that scores documents based on term frequency, inverse document frequency, and document length normalization. **Porter stemming** is applied at index time so "running", "runs", and "ran" match the same stem. Titles and headings are weighted **5x** in BM25 scoring for precise navigational queries.

When you call `ctx_search`, it returns relevant content snippets focused around matching query terms — not full documents, not approximations, the actual indexed content with smart extraction around what you're looking for. `ctx_fetch_and_index` extends this to URLs: fetch, convert HTML to markdown, chunk, index. The raw page never enters context. Use the `contentType` parameter to filter results by type (e.g. `code` or `prose`).

### Ranking: Reciprocal Rank Fusion

Search runs two parallel strategies and merges them with **Reciprocal Rank Fusion (RRF)**:

- **Porter stemming** — FTS5 MATCH with porter tokenizer. "caching" matches "cached", "caches", "cach".
- **Trigram substring** — FTS5 trigram tokenizer matches partial strings. "useEff" finds "useEffect", "authenticat" finds "authentication".

RRF merges both ranked lists into a single result set, so a document that ranks well in both strategies surfaces higher than one that ranks well in only one. This replaces the old cascading fallback approach where trigram results were only used if porter returned nothing.

### Proximity Reranking

Multi-term queries get an additional reranking pass. Results where query terms appear close together are boosted — `"session continuity"` ranks passages with adjacent terms higher than pages where "session" and "continuity" appear paragraphs apart.

### Fuzzy Correction

Levenshtein distance corrects typos before re-searching. "kuberntes" becomes "kubernetes", "autentication" becomes "authentication".

### Smart Snippets

Search results use intelligent extraction instead of truncation. Instead of returning the first N characters (which might miss the important part), Context Mode finds where your query terms appear in the content and returns windows around those matches.

### TTL Cache

Indexed content persists in a per-project SQLite database at `~/.context-mode/content/`. When `ctx_fetch_and_index` is called for a URL that was already indexed within its TTL window, the fetch is skipped entirely and the model searches the existing index directly.

- **Default TTL:** 24 hours. Override per-call with `ttl: <milliseconds>` (PR #666). Longer for stable specs, shorter for changelogs you want re-checked often.
- **Cache hit (within TTL):** Returns a cache hint (~0.3KB) instead of re-fetching (48KB+). Model proceeds to `ctx_search`.
- **Cache miss (TTL expired):** Re-fetches silently. No user action needed.
- **`ttl: 0`** or **`force: true`:** Bypasses cache and re-fetches regardless of freshness.
- **14-day cleanup:** Content databases and sources older than 14 days are removed on startup.

This means `--continue` sessions preserve indexed docs across restarts. No re-fetching, no wasted context tokens.

The status line reports cache performance separately: hits, data avoided, network requests saved, and total context savings including cache.

### Progressive Throttling

- **Calls 1-3:** Normal results (2 per query)
- **Calls 4-8:** Reduced results (1 per query) + warning
- **Calls 9+:** Blocked — redirects to `ctx_batch_execute`

## Session Continuity

Pi captures genuine user prompts and supported tool events in a per-project SQLite database under `~/.pi/context-mode/`. Recovery happens at **lifecycle boundaries**, not on every prompt:

- **New/empty session:** no historical recovery, including other sessions in the same project.
- **Startup/resume of an existing session:** trust Pi's native transcript; do not read or inject a second historical recovery. Pi may report an initial `--continue`/`--resume` as `startup`, so an already-populated conversational branch follows the same no-injection rule.
- **Explicit extension reload:** may rebuild the current session's recovery as a repair boundary; this is not part of normal resume.
- **Before compaction:** prepare only; cancellation/failure does not replace the existing recovery.
- **Successful compaction:** persist one hidden `context-mode-recovery` custom message using `triggerTurn:false`. During an active turn, supported Pi hosts flush it after `turn_end`, before the next model call; no extra user prompt or agent run is needed.
- **Subsequent model calls:** retain that message without rebuilding/appending copies. Context filtering removes superseded owned messages; an empty replacement also retires the old recovery. Other extensions' messages and tool/result ordering stay intact.

Session history is append-only. Old custom messages remain in the transcript but are not current recovery. Historical errors, environment and subagent records are evidence, **not live state, unresolved-status guarantees or authorization**. Persistent messages still use context tokens on later calls.

Capture, recovery and statistics use Pi's native `sessionManager.getSessionId()` directly. Normal reopen/resume retains that ID and does not rebuild historical recovery; an explicit extension reload can rebuild its own recovery with fresh file/branch provenance. Missing host identity or a persistent session file disables recovery. Ambiguous same-session branches/forks/tree navigation conservatively omit rebuilding from session-wide events. Pi does not need Claude's cross-ID latest-snapshot fallback for normal resume. Missing helpers or provenance fail safely rather than guessing; `/ctx-doctor` reports lifecycle-owned recovery.

**Legacy limitation:** old path-hash database rows have no native-ID binding and are not automatically read or migrated for recovery. Existing retention is unchanged; no migration deletes history. Native Pi transcripts and summaries remain intact. Old version-1 context-mode recovery bodies are filtered out of model context, not removed from the append-only transcript. New recovery uses version-2 provenance.

Recovery's search hint uses `ctx_search(queries: [...], sort: "timeline")` for captured records and available indexed content. Project history may include other sessions: verify provenance. Captured records can be summaries or metadata, not full tool outputs; no `session-events` index is assumed. Genuine repeated user prompts retain each occurrence; empty resume projections send nothing, while successful compaction still persists an empty retirement marker when needed.

### Optional Blackhole trimming (Pi)

Default: **off**. Add to context-mode's own settings (not generic Pi settings):

- Global: `~/.pi/agent/context-mode/settings.json`
- Project: `<project>/.pi/context-mode/settings.json`

```json
{
  "extensionAdapters": {
    "blackhole": { "enabled": true }
  }
}
```

`extensionAdapters` collects per-extension adaptation switches, keyed by extension name; Blackhole is currently the only entry.

Explicit project fields override global fields. Invalid explicit configuration in either tier, or malformed/unreadable settings, disables trimming with a non-disruptive warning. Missing files/fields use defaults/inheritance. Existing `toolReplacements` settings are independent.

The flag delegates a fixed set of categories to Blackhole **only after successful compaction**. Normal startup/resume does not project historical categories at all; an explicit reload uses the baseline profile, while compact uses the table below. It neither detects nor configures Blackhole, performs semantic deduplication, nor makes model calls. Enable it only if you accept missing information when Blackhole omits/truncates it; even its minimal tail does not always preserve the latest request.

| Recovery information | Baseline projection (reload or compact flag off) | Trimmed compact projection |
|---|---|---|
| Historical role/persona, heuristic intent/workmode, Claude plan state | Exclude | Exclude |
| Duplicated task snapshots | Do not add | Do not add |
| Recorded goal / last user request | Include if captured | Exclude |
| File activity | Include if captured | Exclude |
| Git commits | Include if captured | Exclude |
| Other Git operations (branch/stash/rebase/etc.) | Keep | Keep |
| Historical tool errors | Include if captured | Exclude |
| Skills, counts and reload hints | Include if captured | Exclude |
| MCP invocation counts | Include if captured | Exclude |
| Recorded decisions/constraints | Keep | Keep |
| Project rule-file references (not full rules) | Keep | Keep |
| Historical cwd/environment/subagent records | Keep | Keep |
| Bounded data references and `ctx_search` hints | Keep | Keep |

The guide reuses the shared renderer with Pi-specific projection and historical labels. Categories describe **available recorded data**, not a promise that every Pi plugin supplies it. There is no todo/goal/subagent plugin-state integration; task plugins retain ownership of their state (use their list tools). Exclusions match event categories/subtypes, not arbitrary words, and do not erase facts already included in another extension's summary.

**Verified host boundary:** Pi **0.85.1** with installed **pi-blackhole 0.5.2** inline adapter. After building, `node tests/fixtures/pi-recovery-host-smoke.mjs` checks real delivery and chained filtering in both extension orders with an isolated, deterministic, no-network summary. It does not cover live providers or the complete Blackhole observer pipeline. Optional lookup overrides: `PI_SMOKE_CLI`, `PI_BLACKHOLE_ROOT`.

Removing/rolling back this extension does not delete persistent custom entries; a host without the filter may expose them as ordinary history until compaction.

## Pi Platform Compatibility

| Feature | Pi Coding Agent |
|---|:---:|
| MCP server / native tools | Extension + MCP bridge |
| Pre-tool enforcement | `tool_call` |
| Post-tool capture | `tool_result` |
| Session restore | `session_start`, `session_compact` |
| Recovery preparation | `session_before_compact` (delivery only on success) |
| Can block tools | Yes |
| Storage root | `~/.pi/context-mode/` |

### Routing Enforcement

Pi intercepts tool calls through its extension lifecycle. The shipped instruction file is [`configs/pi/AGENTS.md`](configs/pi/AGENTS.md), and enforcement comes from extension hooks.

Without hooks, one unrouted command or page snapshot can dump tens of kilobytes into context. Keep the extension enabled instead of relying only on prompt instructions.

See [`docs/platform-support.md`](docs/platform-support.md) for the Pi-specific capability reference.
## Utility Commands

**Inside any AI session** — the agent-facing tools handle sandboxed work and search:

```
ctx index       → index a local file or directory for later search
ctx search      → search previously indexed content
```

**From your terminal** — run administrative commands without an AI session:

```bash
context-mode doctor
context-mode index . --source project:my-app
context-mode search "authentication middleware" --source project:my-app
context-mode upgrade
context-mode insight          # opens the hosted Insight dashboard in browser
bash scripts/ctx-debug.sh    # full diagnostic report for bug reports
```

The debug script collects OS info, runtime versions, better-sqlite3 status, adapter detection, config files (redacted), hook validation, FTS5/SQLite test, executor test, process check, session databases, and environment variables into a single pasteable markdown report.

These terminal commands support the documented Pi integration. Agent-facing indexing and search remain available through `ctx_index` and `ctx_search`.

## Benchmarks

| Scenario | Raw | Context | Saved |
|---|---|---|---|
| Playwright snapshot | 56.2 KB | 299 B | 99% |
| GitHub Issues (20) | 58.9 KB | 1.1 KB | 98% |
| Access log (500 requests) | 45.1 KB | 155 B | 100% |
| Context7 React docs | 5.9 KB | 261 B | 96% |
| Analytics CSV (500 rows) | 85.5 KB | 222 B | 100% |
| Git log (153 commits) | 11.6 KB | 107 B | 99% |
| Test output (30 suites) | 6.0 KB | 337 B | 95% |
| Repo research (subagent) | 986 KB | 62 KB | 94% |

Over a full session: 315 KB of raw output becomes 5.4 KB. Session time extends from ~30 minutes to ~3 hours.

[Full benchmark data with 21 scenarios →](BENCHMARK.md)

## Try It

These prompts work out of the box. Inspect the status line after each to see the savings.

**Deep repo research** — 5 calls, 62 KB context (raw: 986 KB, 94% saved)
```
Research https://github.com/modelcontextprotocol/servers — architecture, tech stack,
top contributors, open issues, and recent activity.
```

**Git history analysis** — 1 call, 5.6 KB context
```
Clone https://github.com/facebook/react and analyze the last 500 commits:
top contributors, commit frequency by month, and most changed files.
```

**Web scraping** — 1 call, 3.2 KB context
```
Fetch the Hacker News front page, extract all posts with titles, scores,
and domains. Group by domain.
```

**Large JSON API** — 7.5 MB raw → 0.9 KB context (99% saved)
```
Create a local server that returns a 7.5 MB JSON with 20,000 records and a secret
hidden at index 13000. Fetch the endpoint, find the hidden record, and show me
exactly what's in it.
```

**Documentation search** — 2 calls, 1.8 KB context
```
Fetch the React useEffect docs, index them, and find the cleanup pattern
with code examples.
```

**Session continuity** — compaction recovery with full state
```
Start a multi-step task: "Create a REST API with Express — add routes, tests,
and error handling." After 20+ tool calls, inspect the status line to see the session
event count. When context compacts, the model continues from your last prompt
with tasks, files, and decisions intact — no re-prompting needed.
```

## Privacy & Architecture

Context Mode is not a CLI output filter or a cloud analytics dashboard. It operates at the MCP protocol layer — raw data stays in a sandboxed subprocess and never enters your context window. Web pages, API responses, file analysis, Playwright snapshots, log files — everything is processed in complete isolation.

**Nothing leaves your machine.** No telemetry, no cloud sync, no usage tracking, no account required. Your code, your prompts, your session data — all local. The SQLite databases live in your home directory and die when you're done.

This is a deliberate architectural choice, not a missing feature. Context optimization should happen at the source, not in a dashboard behind a per-seat subscription. Privacy-first is our philosophy — and every design decision follows from it. [License →](#license)

## Security

Context Mode enforces the same permission rules you already use — but extends them to the MCP sandbox. If you block `sudo`, it's also blocked inside `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute`.

**Zero setup required.** If you haven't configured any permissions, nothing changes. This only activates when you add rules.

```json
{
  "permissions": {
    "deny": [
      "Bash(sudo *)",
      "Bash(rm -rf /*)",
      "Read(.env)",
      "Read(**/.env*)"
    ],
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)"
    ]
  }
}
```

For Pi, put this in `<project>/.pi/context-mode/settings.json` (or `~/.pi/agent/context-mode/settings.json` for global rules). Pi intentionally does not read `.claude/*` or `~/.pi/settings.json` as a fallback.

The pattern is `Tool(what to match)` where `*` means "anything".

Commands chained with `&&`, `;`, or `|` are split — each part is checked separately. `echo hello && sudo rm -rf /tmp` is blocked because the `sudo` part matches the deny rule.

**deny** always wins over **allow**. More specific (project-level) rules override global ones.

### Project-boundary containment

`ctx_execute_file` is confined to the project root. A `path` that resolves **outside** the workspace — an absolute path like `/home/user/secrets`, a `../../` traversal, or a project-local symlink whose target escapes the project — is refused with a `File access blocked` error. This closes the [#852](https://github.com/mksglu/context-mode/issues/852) escape vector where an agent, denied an out-of-project read by the host sandbox, retried through the MCP sandbox (the host's MCP approval prompt cannot inspect the tool's input params, so the escape was invisible to the approver).

The guard is **on by default** and requires no configuration. To intentionally process a file outside the project (e.g. a shared log under `/var/log`), opt that path back in with the **same `permissions.allow` rule you already use for the host `Read` tool** — there is no context-mode-specific env flag:

```json
{
  "permissions": {
    "allow": ["Read(/var/log/**)"]
  }
}
```

context-mode honors that allow rule from Pi's settings paths: `.pi/context-mode/settings.json` for the project and `~/.pi/agent/context-mode/settings.json` globally.

Reviewing the prompt: the `ctx_execute` / `ctx_execute_file` approval titles now read as code execution ("Run code in a sandbox…", "Run code over a file…") so an unfamiliar reviewer can recognise the action class even though the MCP prompt renders only the tool title and raw arguments. `ctx_execute` and `ctx_batch_execute` run arbitrary code and still inherit the process's filesystem access, so the boundary guard is a defense-in-depth layer for the *file-read* tool, not a full OS sandbox — treat approving any execution tool as approving arbitrary code, and keep host-level sandboxing enabled.

### Network fetch hardening

`ctx_fetch_and_index` blocks dangerous URL targets by default:

- **Schemes**: only `http:` and `https:` allowed (no `file://`, `gopher://`, `javascript:`, `data:`).
- **Cloud metadata + link-local**: `169.254.0.0/16` (incl. AWS/GCP/Azure IMDS endpoint `169.254.169.254`) hard-blocked even if a hostname resolves to it (DNS-rebinding defense).
- **Multicast / reserved**: `224.0.0.0/4`, `0.0.0.0/8`, IPv6 `ff00::/8`, `fe80::/10` blocked.
- **Loopback + RFC1918** (`localhost`, `127.x`, `10.x`, `172.16-31.x`, `192.168.x`, IPv6 `::1`, `fc00::/7`) **allowed by default** so local dev servers + internal-network fetches keep working.

For hosted/CI environments where you want to block private targets too, set:

```bash
export CTX_FETCH_STRICT=1
```

That blocks loopback + RFC1918 + ULA in addition to the always-blocked ranges. Useful when context-mode runs as a shared service, not on a developer's own machine.

`tool_input` for any `mcp__*` tool call is also redacted before persistence — the regex matcher in `hooks/posttooluse.mjs` masks `authorization`, `auth_token`, `access_token`, `refresh_token`, `bearer`, `token`, `secret`, `password`, `passwd`, `pwd`, `api_key` / `apikey` / `x_api_key`, `cookie` / `set-cookie`, `signature`, `private_key`, and `client_secret` (case-insensitive, hyphen/underscore-insensitive) to `[REDACTED]` so credentials in MCP arguments don't end up in the session DB.

### Storage environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CONTEXT_MODE_DIR` | `~/.pi/context-mode` | Since v1.0.147. Absolute writable root for context-mode storage. Sessions and stats use `<root>/sessions`; indexed content uses `<root>/content`. Empty or whitespace-only values are treated as unset and shown by `context-mode doctor`; non-empty values must be absolute. `~` is not expanded. |

### Routing-guidance environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY` | `10` | Cadence (in tool calls) at which the PreToolUse hook re-injects the "wrap large external-MCP payloads in `ctx_execute`" guidance. The original implementation ([#529](https://github.com/mksglu/context-mode/pull/529)) fired only once per session, which got lost after context compaction in MCP-heavy sessions (e.g. 50+ Jira/Slack/Notion calls — see [#567](https://github.com/mksglu/context-mode/issues/567) follow-up). The default re-fires every 10th matching call, keeping the guidance in the model's recent window. Range `[1, 100]`; invalid values fall back to `10`. Set to `1` for "every call" (most aggressive — adds ~250 tokens/call) or to a larger value for less frequent reminders. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and TDD guidelines.

```bash
git clone https://github.com/mksglu/context-mode.git
cd context-mode && npm install && npm test
```

## License

Licensed under [Elastic License 2.0](LICENSE) (source-available). You can use it, fork it, modify it, and distribute it. Two things you can't do: offer it as a hosted/managed service, or remove the licensing notices. We chose ELv2 over MIT because MIT permits repackaging the code as a competing closed-source SaaS — ELv2 prevents that while keeping the source available to everyone.
