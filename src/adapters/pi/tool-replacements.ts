import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import type { ReplacementWarning, ToolReplacementSettings } from "./tool-replacement-settings.js";

// Structural host boundary: no installed/bundled second copy of the Pi SDK.
export interface NativeResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface NativeDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (id: string, args: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<NativeResult>;
  [key: string]: unknown;
}
export interface ReadOperations {
  access(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  detectImageMimeType(path: string): Promise<string | null>;
}
export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}
export interface NativeToolSDK {
  createReadToolDefinition(cwd: string, options?: { operations: ReadOperations }): NativeDefinition;
  createBashToolDefinition(cwd: string): NativeDefinition;
  detectSupportedImageMimeTypeFromFile(path: string): Promise<string | null>;
  truncateHead(text: string, limits: { maxLines: number; maxBytes: number }): TruncationResult;
}
export interface ReplacementAPI {
  getAllTools(): Array<{ name: string; parameters: unknown; description: string; sourceInfo?: { source?: string } }>;
  registerTool(tool: NativeDefinition): void;
}
export interface EffectiveReplacementPolicy { bash: boolean; read: boolean }
export interface ReadArguments { path: string; offset?: number; limit?: number }

function validateReadRange(args: ReadArguments): void {
  for (const key of ["offset", "limit"] as const) {
    const value = args[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`read ${key} must be a positive safe integer`);
    }
  }
}

/** Format exact captured text, never parse the native human-readable notices.
 * Source bytes/lines have hard caps; the short continuation notice is extra.
 */
export function formatReadText(
  text: string,
  args: ReadArguments,
  limits: { maxLines: number; maxBytes: number },
  truncateHead: NativeToolSDK["truncateHead"],
): { text: string; truncation?: TruncationResult } {
  validateReadRange(args);
  const lines = text.split("\n"); // Matches native EOF/trailing-newline semantics, preserving CRLF.
  const start = (args.offset ?? 1) - 1;
  if (start >= lines.length) throw new Error(`Offset ${start + 1} is beyond end of file (${lines.length} lines total)`);
  const selected = lines.slice(start, args.limit === undefined ? undefined : start + args.limit).join("\n");
  const truncation = truncateHead(selected, limits);
  if (truncation.firstLineExceedsLimit) {
    return {
      text: `[Line ${start + 1} exceeds the ${limits.maxBytes} UTF-8 byte source limit. No source text returned. Increase toolReplacements.read.maxBytes or use ctx_execute for explicitly partial analysis; partial text is not complete edit evidence.]`,
      truncation,
    };
  }
  // Pi truncateHead reports zero outputLines for an empty string, whereas
  // native read treats an empty file/trailing empty line as one source line.
  const next = start + (truncation.truncated ? truncation.outputLines : selected.split("\n").length);
  let output = truncation.content;
  if (next < lines.length) {
    output += `\n\n[Showing lines ${start + 1}-${next} of ${lines.length}. Use offset=${next + 1} to continue.]`;
  }
  return { text: output, ...(truncation.truncated ? { truncation } : {}) };
}

export function createBoundedRead(
  cwd: string,
  limits: ToolReplacementSettings["read"],
  sdk: NativeToolSDK,
): NativeDefinition {
  const base = sdk.createReadToolDefinition(cwd);
  return {
    ...base,
    description: `Read exact file content or native images. Text source is capped at ${limits.maxLines} lines or ${limits.maxBytes} UTF-8 bytes, whichever comes first; short continuation notices are additional. Use path, optional 1-based offset and optional positive line limit. Images are not subject to text caps.`,
    promptSnippet: `Read exact file excerpts (up to ${limits.maxLines} lines / ${limits.maxBytes} source bytes) or images`,
    promptGuidelines: [
      "Use read for exact content needed for editing; follow its next offset to continue. Use ctx_execute_file for analysis instead. An oversized line requires a larger configured byte budget; partial analysis is not complete edit evidence.",
    ],
    async execute(id, args: ReadArguments, signal, onUpdate, ctx) {
      validateReadRange(args);
      let captured: Buffer | undefined;
      let mime: string | null = null;
      // Per invocation, never shared between concurrent reads. Supply ALL ops:
      // native operations are replaced wholesale, not merged with defaults.
      const native = sdk.createReadToolDefinition(cwd, {
        operations: {
          access: (path) => access(path, constants.R_OK),
          detectImageMimeType: async (path) => (mime = await sdk.detectSupportedImageMimeTypeFromFile(path)),
          readFile: async (path) => (captured = await readFile(path)),
        },
      });
      const result = await native.execute(id, {
        ...args,
        limit: Math.min(args.limit ?? limits.maxLines, limits.maxLines),
      }, signal, onUpdate, ctx);
      if (signal?.aborted) throw new Error("Operation aborted");
      // A failed image conversion can return only text. MIME, not output blocks,
      // decides whether to preserve the ENTIRE native result.
      if (mime) return result;
      if (!captured) throw new Error("Native read did not supply source bytes; refusing to return unbounded text");
      const formatted = formatReadText(captured.toString("utf8"), args, limits, sdk.truncateHead);
      const details = { ...result.details };
      delete details.truncation; // Never retain the native fixed 2000-line/50KiB notice.
      if (formatted.truncation) details.truncation = formatted.truncation;
      return {
        ...result,
        content: [{ type: "text", text: formatted.text }],
        details: Object.keys(details).length ? details : undefined,
      };
    },
  };
}

export const BASH_RECOVERY_METADATA = {
  description: "Native Bash recovery channel only when context-mode is unavailable or has failed. Normally route ALL shell commands through context-mode: use ctx_execute for a single command or dependent chain, and ctx_batch_execute for independent command collection/search, including small output and filesystem mutations. Native timeout is in seconds. Never automatically retry a failed ctx command here: side effects may already have occurred. Existing permission and HTTP routing guards still apply.",
  // Pi only lists active tools that provide a prompt snippet. Override the
  // native Bash snippet so the callable recovery channel stays out of the
  // Available/Core tools summary while its policy remains in Guidelines.
  promptSnippet: undefined,
  promptGuidelines: [
    "Use bash only as a recovery fallback when context-mode is unavailable or has failed. Normally route all shell commands through context-mode: use ctx_execute for a single command or dependent chain, and ctx_batch_execute for independent command collection/search, regardless of output size or side effects; inspect possible prior effects before any retry.",
  ],
};

function supportedSchema(schema: unknown, name: "bash" | "read"): boolean {
  if (!schema || typeof schema !== "object") return false;
  const value = schema as { type?: string; properties?: Record<string, { type?: string }>; required?: unknown };
  const expected = name === "bash" ? { command: "string", timeout: "number" } : { path: "string", offset: "number", limit: "number" };
  const required = name === "bash" ? "command" : "path";
  return value.type === "object" && Array.isArray(value.required) &&
    value.required.length === 1 && value.required[0] === required &&
    !!value.properties && Object.keys(value.properties).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, type]) => value.properties?.[key]?.type === type);
}

/** Call only once runtime APIs are bound, never during extension discovery. */
export function installToolReplacements(
  pi: ReplacementAPI,
  cwd: string,
  settings: ToolReplacementSettings,
  sdk: NativeToolSDK | undefined,
  warn: ReplacementWarning,
): EffectiveReplacementPolicy {
  const effective = { bash: false, read: false };
  for (const feature of ["bash", "read"] as const) {
    if (!settings[feature].enabled) continue;
    let registrationAttempted = false;
    try {
      const owner = pi.getAllTools().find((tool) => tool.name === feature);
      if (owner?.sourceInfo?.source !== "builtin") throw new Error("tool is absent or already owned by another extension/SDK");
      if (!supportedSchema(owner.parameters, feature)) throw new Error("unsupported native parameter schema");
      if (!sdk) throw new Error("host SDK unavailable (use the Pi host entry)");
      if (feature === "read" && (typeof sdk.createReadToolDefinition !== "function" ||
          typeof sdk.detectSupportedImageMimeTypeFromFile !== "function" || typeof sdk.truncateHead !== "function")) {
        throw new Error("host lacks the required native Read capabilities");
      }
      if (feature === "bash" && typeof sdk.createBashToolDefinition !== "function") throw new Error("host lacks native Bash definition factory");
      const definition = feature === "read"
        ? createBoundedRead(cwd, settings.read, sdk)
        : { ...sdk.createBashToolDefinition(cwd), ...BASH_RECOVERY_METADATA };
      if (definition.name !== feature || typeof definition.execute !== "function" || !supportedSchema(definition.parameters, feature)) {
        throw new Error("unsupported native definition");
      }
      registrationAttempted = true;
      pi.registerTool(definition);
      // Runtime registration is synchronous on the supported host. Verify that
      // first-registration-wins did not silently leave another definition active.
      const installed = pi.getAllTools().find((tool) => tool.name === feature);
      if (!installed || installed.sourceInfo?.source === "builtin" || installed.description !== definition.description) {
        throw new Error("runtime did not activate the replacement");
      }
      effective[feature] = true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(registrationAttempted
        ? `${feature} replacement activation could not be verified: ${reason}. Routing policy remains inactive; reload/restart before continuing.`
        : `${feature} replacement skipped: ${reason}. Existing tool retained; reload/restart after resolving the conflict.`);
    }
  }
  return effective;
}
