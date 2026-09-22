/**
 * Canonical ctx_* tool catalog data.
 *
 * Two facts live here, and only these two:
 *   1. every ctx_* tool the shared MCP server registers;
 *   2. which of them are administrative operations (human-facing diagnostics,
 *      upgrades and purges) rather than agent-facing sandbox/search work.
 *
 * There is deliberately NO filtering logic in this module. Whether an agent may
 * see an administrative tool is a per-host policy: the MCP server advertises its
 * complete catalog, and each adapter decides what reaches its own agent-facing
 * registry. A shared filter here would silently bind every host to one decision
 * — the failure mode this module exists to prevent.
 */

/** Every ctx_* tool the shared MCP server registers. */
export const CTX_TOOL_NAMES: readonly string[] = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_batch_execute",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
];

/** Administrative operations that host adapters hide by default. */
export const ADMINISTRATIVE_CTX_TOOL_NAMES: readonly string[] = [
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
];
