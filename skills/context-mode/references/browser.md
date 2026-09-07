# Browser capture workflows

Read this reference before browser automation, page inspection, or collecting browser console/network output. Ordinary CLI, test, and log tasks only need the main skill.

## Capture boundary

Use the browser tool's `filename` parameter to save textual snapshots, console messages, and network listings, then process the file server-side. Use the installed tool schema to confirm supported parameters. A path must exist on the context-mode host and pass its permissions; transfer remote-browser artifacts through an approved mechanism first.

A raw browser result can be large. Sending it back through `ctx_index(content: ...)` adds another copy to context. Prefer `path` for saved data. If a result is already in context, use it directly; saving it later does not remove the first copy.

`browser_navigate` may return an automatic snapshot. Treat that as already-loaded output, not something to re-index through a content argument. For subsequent inspection, request a file-backed `browser_snapshot`; saving a new snapshot cannot undo the navigation response's cost.

Screenshots are images, not searchable text snapshots. Save image artifacts where supported and inspect only the images needed for the task; use textual snapshots for text search/extraction.

## A. Snapshot for repeated queries

```text
browser_snapshot(filename: "/tmp/playwright-snapshot.md")
ctx_index(path: "/tmp/playwright-snapshot.md", source: "Playwright snapshot")
ctx_search(queries: ["login email password", "navigation links"], source: "Playwright snapshot")
```

The browser saves the snapshot; context-mode reads it server-side. Only confirmations and matching chunks enter context. Exact savings depend on page size and returned metadata, not a fixed token count.

## B. Snapshot for one-shot extraction

```text
browser_snapshot(filename: "/tmp/playwright-snapshot.md")
ctx_execute_file(path: "/tmp/playwright-snapshot.md", language: "javascript", code: <analysis below>)
```

Example analysis for a textual accessibility snapshot; adapt the patterns to the actual saved format:

```javascript
const links = [...FILE_CONTENT.matchAll(/- link "([^"]+)"/g)].map(m => m[1]);
const buttons = [...FILE_CONTENT.matchAll(/- button "([^"]+)"/g)].map(m => m[1]);
const inputs = [...FILE_CONTENT.matchAll(/- textbox|- checkbox|- radio/g)];
console.log('Links:', links.length, '| Buttons:', buttons.length, '| Inputs:', inputs.length);
console.log('Navigation sample:', links.slice(0, 10).join(', '));
```

The data is analyzed in the sandbox; only printed findings return. Use the full indexed snapshot instead when later questions may need information excluded by this summary.

## C. Console and network

```text
browser_console_messages(level: "error", filename: "/tmp/console.md")
browser_network_requests(includeStatic: false, filename: "/tmp/network.md")
```

For each file, choose `ctx_execute_file(path: ...)` for one-shot analysis or `ctx_index(path: ...)` followed by `ctx_search` for repeated queries. Report actionable evidence such as the error message, endpoint, status, and relevant line numbers. Respect the installed browser tool's schema if option names differ.

## Parallel browser work

Playwright MCP can expose one shared browser instance: navigation in one agent can invalidate another agent's page state. Serialize operations sharing that instance.

If parallel work is needed, `agent-browser` can be run through `ctx_execute` with `language: "shell"`. Give each concurrent worker a distinct named session and artifact path; separate subprocesses alone do not establish browser isolation. Check the installed CLI's session option before starting, and close only the session owned by that worker. Use its compact accessibility tree and ref-based interactions where appropriate.

Single-worker example (run inside `ctx_execute`; for parallel workers add the installed CLI's explicit session selector):

```shell
agent-browser open example.com && agent-browser snapshot -i -c
```

Completion: the requested page/console/network evidence has been captured without replaying large raw text as tool arguments, and findings include the relevant saved source or artifact path.
