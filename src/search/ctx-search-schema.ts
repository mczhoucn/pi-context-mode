/**
 * ctx_search input-schema builder and project-scope resolver.
 *
 * Issue #737 introduces the optional `project:` parameter used by callers
 * running in the shared-DB mode (`CONTEXT_MODE_PROJECT_DIR` is set). The
 * field is registered conditionally so that in the default per-project DB
 * mode the LLM physically cannot pass it — the parameter does not exist
 * in the tool schema at all, which is a stronger guarantee than runtime
 * validation that depends on the model honouring documentation.
 *
 * The handler in `src/server.ts` consumes both exports:
 *   - {@link buildCtxSearchInputSchema} composes the Zod object used at
 *     `registerTool` time, spreading the conditional `project` field only
 *     when `isSharedMode` is true.
 *   - {@link resolveProjectScope} normalises the raw param into the
 *     three-state contract consumed by `searchAllSources`:
 *       undefined → no filter
 *       null      → explicit cross-project recall (no filter)
 *       string    → restrict to that project directory
 *
 * P0-2 contract fixes:
 *   - `queries` is REQUIRED with at least one non-empty string. The previous
 *     `.optional()` accepted `{}` and `{queries: []}` at the wire level and
 *     only failed inside the handler, so tools/list advertised a call shape
 *     the runtime always rejected.
 *   - The singular `query` alias is deliberately NOT declared. It is
 *     unreachable through the MCP transport: Zod object parsing strips
 *     unknown keys before the handler runs (verified against the built
 *     server), so advertising it would document a parameter that cannot work.
 *   - The `limit` default (2) matches the handler's `Math.min(limit, 2)`
 *     clamp instead of advertising 3 and silently returning 2.
 *
 * IMPORTANT: this schema MUST stay a plain `z.object`. `.refine()`,
 * `.superRefine()`, `.transform()`, or a top-level `z.union()` produce a
 * ZodEffects/union that the MCP SDK's `normalizeObjectSchema()` cannot read
 * `.shape` from, which collapses the advertised JSON Schema to
 * `{type:"object",properties:{}}` and makes strict clients reject every call
 * (issue #563; guarded by the class-wide test in tests/core/server.test.ts).
 * Cross-field rules therefore live in the handler body.
 */

import { z } from "zod";

/**
 * Helper that mirrors the Zod coercer used elsewhere in the server for
 * array-shaped tool args. Kept inline so this module has no runtime
 * dependency on `server.ts` (which would create a cycle).
 *
 * Behaviour mirrors `coerceJsonArray` in `server.ts`:
 *   1. Empty / whitespace string → returned untouched so Zod surfaces the
 *      "non-empty" error rather than masquerading as `[""]`.
 *   2. Valid JSON array string → parsed and returned.
 *   3. Any other plain string (a bare single query) → lifted to a
 *      single-element array. Fixes #627 for the native OpenCode plugin
 *      path where some providers deliver `queries: "search term"`.
 */
function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.length === 0) return val;
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through — not JSON, treat as bare-string lift */
    }
    return [val];
  }
  return val;
}

/**
 * Build the Zod object passed to `server.registerTool("ctx_search", …)`.
 *
 * The base fields (`queries`, `limit`, `source`, `contentType`, `sort`)
 * are always present and mirror today's contract exactly. The `project`
 * field is only spread in when `isSharedMode` is true. When the host runs
 * with the default per-project DB layout the schema does not expose the
 * field at all, which keeps the tool surface honest about what is
 * actionable in that mode.
 */
export function buildCtxSearchInputSchema(isSharedMode: boolean) {
  const projectField = isSharedMode
    ? {
        project: z
          .string()
          .optional()
          .describe(
            "Project scope. " +
              "Default (omit): this session's project — auto-resolved from the host adapter. " +
              "'global': span every project in the shared store (cross-project recall). " +
              "<absolute-path>: scope to that specific project directory.",
          ),
      }
    : ({} as Record<string, never>);

  return z.object({
    // Required + min(1) + per-item min(1): the wire schema now rejects the
    // empty-object and empty-array shapes the handler already rejected at
    // runtime, so tools/list and the handler agree on the same contract.
    // `.regex(/\S/)` rejects whitespace-only entries too — without it,
    // `{queries: ["  "]}` passed validation and the handler silently dropped
    // the entry, turning a malformed call into an empty search.
    queries: z.preprocess(coerceJsonArray, z
      .array(z.string().min(1).regex(/\S/, "must contain a non-whitespace character"))
      .min(1)
      .describe("Array of search queries (at least one, non-blank). Batch related questions in one call.")),
    // limit: z.coerce.number() (not z.number()) — OpenCode's native
    // plugin path delivers tool args straight from the LLM provider's
    // tool-call JSON, where several providers stringify primitives
    // (limit:"4" instead of limit:4). Since v1.0.139 / #621 we run
    // inputSchema.parse() on that path, so a plain z.number() rejects
    // "4" with "Expected number, received string". z.coerce mirrors what
    // ctx_batch_execute / ctx_fetch_and_index / ctx_execute already do.
    // Fixes #627.
    //
    // Default 2 (not 3): the handler clamps normal-mode calls with
    // `Math.min(limit, 2)`, so advertising 3 documented a value the server
    // silently reduced.
    limit: z
      .coerce.number()
      .optional()
      .default(2)
      .describe("Results per query (default: 2, maximum: 2)"),
    source: z
      .string()
      .optional()
      .describe("Filter to a specific indexed source (partial match)."),
    contentType: z
      .enum(["code", "prose"])
      .optional()
      .describe("Filter results by content type: 'code' or 'prose'."),
    sort: z
      .enum(["relevance", "timeline"])
      .optional()
      .default("relevance")
      .describe(
        "Sort mode. 'relevance' (default): BM25 ranked, current session only. " +
          "'timeline': chronological across current session, prior sessions, and auto-memory.",
      ),
    ...projectField,
  });
}

/**
 * Normalise the raw `project` value into the three-state contract consumed
 * by {@link searchAllSources}.
 *
 *   - shared mode OFF                        → `undefined` (param ignored)
 *   - shared mode ON, param `undefined`      → current project (`getProjectDirFn()`)
 *   - shared mode ON, param `"global"`       → `null` (no filter — cross-project)
 *   - shared mode ON, param `<string>`       → that string verbatim
 *
 * The function is pure so it stays trivially testable without spinning up
 * the MCP server.
 */
export function resolveProjectScope(
  raw: string | undefined,
  isSharedMode: boolean,
  getProjectDirFn: () => string,
): string | null | undefined {
  if (!isSharedMode) return undefined;
  if (raw === undefined) return getProjectDirFn();
  if (raw === "global") return null;
  return raw;
}

/**
 * Module-load snapshot of `CONTEXT_MODE_PROJECT_DIR`. Captured once so the
 * tool schema registered with `server.registerTool` reflects the launch
 * environment — the LLM-visible surface should never flip mid-session.
 */
export const CTX_SEARCH_SHARED_MODE = !!process.env.CONTEXT_MODE_PROJECT_DIR;
