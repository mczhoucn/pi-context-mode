# Capture pitfalls

Read when diagnosing routing mistakes, missing evidence, empty output, or timeouts. Apply the main skill's routing tree first; these are recovery cases, not another universal tool hierarchy.

## 1. Choosing tools by line count alone

Guaranteed-small-output Bash whitelist operations can run directly. Data-producing commands still use context-mode under this skill's policy, even if their output looks short. A small file needed for an edit is a normal Read task; analysis of that file belongs in `ctx_execute_file`.

Related CLI commands, command-based research, or command-output gather-and-search use `ctx_batch_execute`. A single command/transformation uses `ctx_execute`. Web references use `ctx_fetch_and_index`, and indexed content uses `ctx_search`, regardless of how many URLs or questions there are.

## 2. Empty or unhelpful output

The sandbox only exposes printed findings. Computed variables that are never printed cannot be retrieved. For example, in `ctx_execute_file` with JavaScript:

```javascript
const data = JSON.parse(FILE_CONTENT);
const errors = data.filter(row => row.status === 'error');
console.log(`Errors: ${errors.length}/${data.length}`);
for (const row of errors) console.log(`${row.id}: ${row.message}`);
```

Print evidence, not only a total. For structured findings, use `JSON.stringify` or an explicit table; JavaScript string interpolation of a plain object yields `[object Object]`. This does not justify dumping an entire dataset when a focused answer is enough.

## 3. Confusing analysis with capture

Choose according to the question:

- **One-shot analysis:** read/process the data inside the sandbox and print the derived answer. Filtering, aggregation, and transformation are intended uses of `ctx_execute` and `ctx_execute_file`.
- **Exploratory capture:** preserve full output in the index for later questions, using `ctx_execute` with a specific `intent`, or `ctx_batch_execute` for related commands plus questions. Narrow after capture with `ctx_search`.

Piping a command through `head` before capture loses all later lines. Repeated searches cannot recover those lines; rerun the producer without that truncation when complete evidence is required. Similarly, a printed summary does not retain unprinted raw data. If future questions need the raw data, keep a permitted saved/indexed copy.

## 4. Passing large data through tool arguments

When a producer can save to disk, use its `filename` option, then `ctx_index(path: ...)` for reuse or `ctx_execute_file(path: ...)` for one extraction. Large `content` arguments send the data through context again. Reserve `ctx_index(content: ...)` for small inline text you compose.

If another MCP tool has already returned its response inline, use it directly. Re-indexing it will not save the context already consumed. For browser-specific capture and navigation caveats, read [Browser workflows](./browser.md) only when working with browser tools.

## 5. Using a raw file read for data analysis

Use `ctx_execute_file` so the file becomes `FILE_CONTENT` inside the sandbox. For JSON/API work use JavaScript; CSV/statistics suit Python; native command pipelines suit shell. Switch complex inline Node/Python shell fragments to the corresponding `language` instead of nesting interpreters. Read exact source normally when preparing an edit.

## 6. Missing timeout or failure evidence

Use the current tool schema: `timeout` is milliseconds, and `intent` names what to retrieve from large output. For a slow build or test suite, set a suitable explicit timeout when needed; report whether the command failed or timed out rather than treating missing output as success.

For a single test command, run this inside `ctx_execute` with `language: "shell"` and an intent such as `failing tests and final exit status`:

```shell
npm test 2>&1
status=$?
printf '\nEXIT=%s\n' "$status"
exit "$status"
```

When using pipelines, preserve the producer's exit status as well as stderr. If output is too large to inspect directly, query the captured output for failures and summary lines. Keep stateful or CPU-heavy commands serial; parallelize only independent I/O.

## 7. Treating retrieval focus as a replacement for evidence

An `intent` such as `failing tests with file paths and messages` is more useful than `summarize this`. It selects passages from captured output, not facts that were never printed. When multiple sources are indexed, scope searches with `source` and batch related questions in `queries`.

Completion: the tool matches the task, needed raw evidence remains available where required, findings are printed with identifiers, and failure/timeout status is explicit.
