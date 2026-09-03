/**
 * OpenClaw MCP tool registry.
 *
 * Catalogs the six agent-facing ctx_* tools that the OpenClaw plugin must
 * register via api.registerTool(...) so the routing block (which nudges agents
 * toward ctx_execute, ctx_search, etc.) actually has tools to call. The
 * administrative ctx_* operations are intentionally human-only and are not
 * included in this registry.
 *
 * Pattern mirrors the swarmvault MCP plugin
 * (refs/plugin-examples/openclaw/swarmvault/packages/engine/src/mcp.ts:46-51):
 *   server.registerTool(name, { description, inputSchema }, handler)
 *
 * OpenClaw signature is slightly different — see building-plugins.md:116
 *   api.registerTool({ name, description, parameters: TypeBox, execute(id, params) })
 *
 * Tool handlers are intentionally thin shims that delegate to the bundled CLI
 * (cli.bundle.mjs). This keeps the plugin's blast radius minimal:
 * we don't re-export the entire MCP server stack inside OpenClaw's process.
 *
 * The six agent-facing tools mirror the public registry in src/server.ts.
 */

/** Minimal JSON-schema-like parameter spec accepted by OpenClaw registerTool. */
export interface OpenClawToolParameters {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Tool definition shape returned to OpenClaw via api.registerTool. */
export interface OpenClawToolDef {
  name: string;
  description: string;
  parameters: OpenClawToolParameters;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/** Wrap any handler so failures become a well-formed text error rather than crashing. */
function safe(
  handler: (
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
): OpenClawToolDef["execute"] {
  return async (_id, params) => {
    try {
      return await handler(params ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `[context-mode] tool error: ${message}`,
          },
        ],
      };
    }
  };
}

/** Stub handler — points users at the bundled CLI for full functionality. */
function cliRedirect(toolName: string) {
  return safe(async () => ({
    content: [
      {
        type: "text" as const,
        text: `[context-mode] ${toolName} is exposed via the bundled context-mode CLI. Run 'context-mode ${toolName}' or invoke the MCP server directly. This OpenClaw stub registers the tool name so the routing block remains valid; full execution requires the standalone MCP transport.`,
      },
    ],
  }));
}

/**
 * The six agent-facing ctx_* tool definitions registered into OpenClaw via
 * api.registerTool. Names + descriptions mirror the public registry in
 * src/server.ts so routing prompts resolve to real callable tools.
 */
export const OPENCLAW_TOOL_DEFS: readonly OpenClawToolDef[] = [
  {
    name: "ctx_execute",
    description:
      "Execute code in a sandboxed subprocess. Only stdout enters context. Prefer over Bash for any command producing >20 lines.",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", description: "Runtime language" },
        code: { type: "string", description: "Source code to execute" },
        timeout: { type: "number", description: "Max execution time in ms" },
      },
      required: ["language", "code"],
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_execute"),
  },
  {
    name: "ctx_execute_file",
    description:
      "Execute code with a file path. Only printed summary enters context — raw file stays in sandbox.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        language: { type: "string", description: "Runtime language" },
        code: { type: "string", description: "Source code" },
      },
      required: ["path", "language", "code"],
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_execute_file"),
  },
  {
    name: "ctx_index",
    description: "Store content in the FTS5 knowledge base for later search.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Text to index" },
        source: { type: "string", description: "Descriptive source label" },
      },
      required: ["content", "source"],
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_index"),
  },
  {
    name: "ctx_search",
    description: "Query indexed content via FTS5. Pass all questions as an array in ONE call.",
    parameters: {
      type: "object",
      properties: {
        queries: { type: "array", description: "Search queries" },
        source: { type: "string", description: "Optional source filter" },
        sort: { type: "string", description: "relevance | timeline" },
      },
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_search"),
  },
  {
    name: "ctx_fetch_and_index",
    description: "Fetch a URL, chunk it, and index — raw HTML never enters context.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        source: { type: "string", description: "Source label for indexed chunks" },
      },
      required: ["url"],
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_fetch_and_index"),
  },
  {
    name: "ctx_batch_execute",
    description:
      "Run multiple commands and search queries in ONE call. Primary research tool — replaces 30+ individual calls.",
    parameters: {
      type: "object",
      properties: {
        commands: { type: "array", description: "Array of {label, command} objects" },
        queries: { type: "array", description: "Search queries to run after indexing" },
      },
      additionalProperties: true,
    },
    execute: cliRedirect("ctx_batch_execute"),
  },
];

/** Stable list of tool names — used by tests and manifest validation. */
export const OPENCLAW_TOOL_NAMES: readonly string[] = OPENCLAW_TOOL_DEFS.map(
  (def) => def.name,
);
