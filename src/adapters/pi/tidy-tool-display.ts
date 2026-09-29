/**
 * Local two-line tool display for Pi. This is not a tidy plugin adapter:
 * it does not import, call, or read @mobrienv/pi-tidy-tools.
 */

export const REASONING_FIELD = "reasoning";

export const REASONING_DESCRIPTION =
  "One short sentence in the user's language stating the goal of this call. Do not repeat the command or path, and do not include a secret. Display only; omitted before execution.";

export interface TidyToolDisplaySettings {
  enabled: boolean;
}

interface SchemaObject {
  type?: string;
  properties?: Record<string, unknown>;
  required?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function schemaOwnsReasoning(schema: unknown): boolean {
  return isRecord(schema) && isRecord(schema.properties) && Object.hasOwn(schema.properties, REASONING_FIELD);
}

/** Pi-side schema copy. Never mutates the shared MCP or native schema. */
export function withDisplayReasoning(schema: unknown): { schema: SchemaObject; injected: boolean } {
  if (!isRecord(schema) || schemaOwnsReasoning(schema)) {
    return { schema: (isRecord(schema) ? schema : { type: "object", properties: {} }) as SchemaObject, injected: false };
  }
  const properties = { ...(isRecord(schema.properties) ? schema.properties : {}) };
  properties[REASONING_FIELD] = { type: "string", description: REASONING_DESCRIPTION };
  const required: unknown[] = [REASONING_FIELD];
  if (Array.isArray(schema.required)) {
    for (const item of schema.required) {
      if (item !== REASONING_FIELD) required.push(item);
    }
  }
  return {
    schema: {
      ...schema,
      type: typeof schema.type === "string" ? schema.type : "object",
      properties,
      required,
    },
    injected: true,
  };
}

/** Copy arguments and drop the display-only field. Non-objects pass through. */
export function omitDisplayReasoning(params: unknown): unknown {
  if (!isRecord(params)) return params ?? {};
  if (!Object.hasOwn(params, REASONING_FIELD)) return { ...params };
  const copy = { ...params };
  delete copy[REASONING_FIELD];
  return copy;
}

const DISPLAY_TEXT_LIMIT = 180;

function clip(text: string): string {
  return text.length <= DISPLAY_TEXT_LIMIT ? text : `${text.slice(0, DISPLAY_TEXT_LIMIT - 1)}…`;
}

export function displayPurpose(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const value = params[REASONING_FIELD];
  if (typeof value !== "string") return undefined;
  const text = oneLine(value);
  return text.length > 0 ? clip(text) : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = oneLine(value);
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstText(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["query", "url", "command", "path", "source", "code"]) {
    const found = firstText(value[key]);
    if (found) return found;
  }
  return undefined;
}

/**
 * One concrete target for line 2. `ctx_execute` stores the command in `code`,
 * not `command`. Search and fetch prefer the first query or URL.
 */
export function displayTarget(toolName: string, params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const target = toolName === "bash"
    ? firstText(params.command)
    : toolName === "ctx_execute"
      ? firstText(params.code) ?? firstText(params.command)
      : toolName === "read" || toolName === "ctx_execute_file"
        ? firstText(params.path)
        : toolName === "ctx_search"
          ? firstText(params.queries) ?? firstText(params.query)
          : toolName === "ctx_fetch_and_index"
            ? firstText(params.url) ?? firstText(params.requests)
            : firstText(params.path) ?? firstText(params.source) ?? firstText(params.command) ?? firstText(params.commands);
  return target ? clip(target) : undefined;
}

/** Pi-side schema only. A tool that already owns the field keeps its schema. */
export function selectDisplaySchema(schema: unknown, enabled: boolean): { schema: unknown; injected: boolean } {
  if (enabled !== true) return { schema, injected: false };
  const display = withDisplayReasoning(schema);
  return display.injected ? display : { schema, injected: false };
}

export interface DisplayTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
}

export interface DisplayResult {
  content?: Array<{ type?: string; text?: string } | undefined>;
  isError?: boolean;
}

export function shortResult(toolName: string, result: DisplayResult | undefined, partial: boolean): string {
  if (partial) return toolName.startsWith("ctx_") ? "indexing/searching..." : "running...";
  const output = (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item!.text as string)
    .join("\n");
  const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  if (firstLine && firstLine.length <= 180) return firstLine;
  return `${toolName} completed`;
}

export function fullResultText(result: DisplayResult | undefined): string {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item!.text as string)
    .join("\n");
}

function paint(theme: DisplayTheme, color: string, text: string, bold = false): string {
  const body = bold ? theme.bold(text) : text;
  return theme.fg(color, body);
}

export function renderTidyLines(
  toolName: string,
  params: unknown,
  result: DisplayResult | undefined,
  options: { expanded: boolean; isPartial: boolean; isError?: boolean },
  theme: DisplayTheme,
): string {
  if (options.expanded && !options.isPartial) {
    return paint(theme, "toolOutput", fullResultText(result));
  }
  const purpose = displayPurpose(params);
  const target = displayTarget(toolName, params);
  const headline = purpose ?? target;
  const summary = shortResult(toolName, result, options.isPartial);
  const name = paint(theme, "toolTitle", toolName, true);
  const line1 = headline ? `${name} ${paint(theme, "toolOutput", headline)}` : name;
  const line2 = target
    ? `${paint(theme, "muted", target)} ${paint(theme, "toolOutput", summary)}`
    : paint(theme, options.isPartial ? "warning" : "toolOutput", summary);
  const bg = options.isPartial ? "toolPendingBg" : options.isError ? "toolErrorBg" : "toolSuccessBg";
  const lines = [line1, line2].map((line) => (theme.bg ? theme.bg(bg, line) : line));
  return lines.join("\n");
}

interface MutableText {
  setText(text: string): void;
}

/** Shared call/result split: Pi stacks both renderers, so the idle one must be blank. */
export function createTidyRenderers<T extends MutableText>(
  toolName: string,
  TextComponent: new () => T,
) {
  const reuse = (last: unknown): T => (last instanceof TextComponent ? last : new TextComponent());
  return {
    renderShell: "self" as const,
    renderCall(args: unknown, theme: DisplayTheme, context: { lastComponent?: unknown; isPartial?: boolean } = {}) {
      const text = reuse(context.lastComponent);
      text.setText(context.isPartial === false
        ? ""
        : renderTidyLines(toolName, args, undefined, { expanded: false, isPartial: true }, theme));
      return text;
    },
    renderResult(
      result: DisplayResult | undefined,
      options: { expanded: boolean; isPartial: boolean },
      theme: DisplayTheme,
      context: { lastComponent?: unknown; args?: unknown; isError?: boolean } = {},
    ) {
      const text = reuse(context.lastComponent);
      text.setText(options.isPartial
        ? ""
        : renderTidyLines(toolName, context.args, result, {
          expanded: options.expanded,
          isPartial: false,
          isError: context.isError === true || result?.isError === true,
        }, theme));
      return text;
    },
  };
}
