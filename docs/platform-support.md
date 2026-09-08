# Pi Coding Agent Support

This downstream distribution documents and validates context-mode only for
**Pi Coding Agent**. Non-Pi adapter source remains in the repository to keep
upstream merges manageable, but those adapters are not supported installation
targets in this fork.

## Supported Integration

| Capability | Pi Coding Agent |
|---|:---:|
| Installation form | Pi package + extension |
| Agent-facing context-mode tools | 6 |
| Pre-tool routing enforcement | `tool_call` |
| Post-tool event capture | `tool_result` |
| Session restore | `session_start` |
| Pre-compaction snapshot | `session_before_compact` |
| Tool blocking | Yes |
| Storage root | `~/.pi/context-mode/` |

The six agent-facing tools are:

- `ctx_batch_execute`
- `ctx_execute`
- `ctx_execute_file`
- `ctx_index`
- `ctx_search`
- `ctx_fetch_and_index`

Administrative operations are intentionally absent from the agent tool catalog.
Run diagnostics, upgrades, status reporting, and Insight from the terminal.

## Prerequisites

- Node.js 22.5 or newer, or Bun
- Pi Coding Agent

## Installation

Install both the terminal command and the Pi package:

```bash
npm install -g context-mode
pi install npm:context-mode
```

Register the MCP server in `~/.pi/agent/mcp.json`, or in `.pi/mcp.json` for one
project:

```json
{
  "mcpServers": {
    "context-mode": {
      "command": "context-mode"
    }
  }
}
```

Restart Pi after installation.

## Verification

Ask Pi to run `ctx_execute` with `console.log("ok")`. A successful installation
returns `ok`.

## Permission Settings

Pi reads context-mode permission rules from exactly these paths:

- Project: `<project>/.pi/context-mode/settings.json`
- Global: `~/.pi/agent/context-mode/settings.json`

It does not fall back to `.claude/settings.local.json`,
`.claude/settings.json`, or `~/.pi/settings.json`.

## Lifecycle and Isolation

The Pi extension registers four lifecycle handlers:

| Event | Role |
|---|---|
| `tool_call` | Enforce routing before execution |
| `tool_result` | Capture completed tool activity |
| `session_before_compact` | Persist a recovery snapshot |
| `session_start` | Restore state after compaction or resume |

Session databases, indexes, and statistics are stored under
`~/.pi/context-mode/` by default.

## Routing File

Pi ships [`configs/pi/AGENTS.md`](../configs/pi/AGENTS.md). This file explains
routing to the model; enforcement comes from extension hooks rather than prose
alone.
