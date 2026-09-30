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
 * One concrete target. `ctx_execute` stores the command in `code`,
 * not `command`. Search and fetch prefer the first query or URL.
 */
function concreteTarget(toolName: string, params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  if (toolName === "bash") return firstText(params.command);
  if (toolName === "ctx_execute") return firstText(params.code) ?? firstText(params.command);
  if (toolName === "read" || toolName === "ctx_execute_file") return firstText(params.path);
  if (toolName === "ctx_search") return firstText(params.queries) ?? firstText(params.query);
  if (toolName === "ctx_fetch_and_index") return firstText(params.url) ?? firstText(params.requests);
  return firstText(params.path) ?? firstText(params.source) ?? firstText(params.command) ?? firstText(params.commands);
}

export function displayTarget(toolName: string, params: unknown): string | undefined {
  const target = concreteTarget(toolName, params);
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

/**
 * Same terminal codes tidy hardcodes. Pi theme tokens are different colors.
 * read and file analysis use the book; shell tools use the lightning bolt.
 */
const TIDY_CYAN = "\x1b[36m";
const TIDY_MAGENTA = "\x1b[35m";
const TIDY_GREEN = "\x1b[32m";
const TIDY_RED = "\x1b[31m";
const TIDY_DIM = "\x1b[2m";
const TIDY_BOLD = "\x1b[1m";
const TIDY_RESET = "\x1b[0m";
/** Body text. `toolOutput` is gray. */
const PURPOSE_COLOR = "text";
const LINE_TARGET_CAP = 2000;

const startedAtByCallId = new Map<string, number>();
const finishedElapsedByCallId = new Map<string, number>();

export function noteToolStarted(id: string | undefined, now = Date.now()): void {
  if (!id || startedAtByCallId.has(id)) return;
  startedAtByCallId.set(id, now);
}

export function noteToolFinished(id: string | undefined, now = Date.now()): void {
  if (!id || finishedElapsedByCallId.has(id)) return;
  const started = startedAtByCallId.get(id);
  if (started === undefined) return;
  finishedElapsedByCallId.set(id, Math.max(0, now - started));
}

export function clearToolElapsed(): void {
  startedAtByCallId.clear();
  finishedElapsedByCallId.clear();
}

function elapsedNow(id: string | undefined, now = Date.now()): number {
  if (!id) return 0;
  const finished = finishedElapsedByCallId.get(id);
  if (finished !== undefined) return finished;
  const started = startedAtByCallId.get(id);
  return started === undefined ? 0 : Math.max(0, now - started);
}



function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1000) return "<1s";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${(seconds % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

function toolFace(toolName: string): { icon: string; color: string } {
  if (toolName === "read" || toolName === "ctx_execute_file") return { icon: "\u{1F4D6}", color: TIDY_CYAN };
  if (toolName === "bash" || toolName === "ctx_execute" || toolName === "ctx_batch_execute") return { icon: "\u26A1", color: TIDY_MAGENTA };
  return { icon: "\u25C6", color: TIDY_MAGENTA };
}

function paintToolName(toolName: string): string {
  const face = toolFace(toolName);
  return `${face.color}${face.icon} ${TIDY_BOLD}${toolName}${TIDY_RESET}`;
}

function paintRaw(color: string, text: string): string {
  return `${color}${text}${TIDY_RESET}`;
}

function inElapsed(label: string, elapsed: string, color: string): string {
  return `${paintRaw(color, label)} ${paintRaw(TIDY_DIM, `in ${elapsed}`)}`;
}

function errorLine(result: DisplayResult | undefined): string {
  const text = fullResultText(result);
  const line = text.split(/\r?\n/).find((item) => item.trim().length > 0)?.trim() ?? "error";
  const flat = oneLine(line);
  return flat.length <= 500 ? flat : flat.slice(0, 500);
}

function outputLines(result: DisplayResult | undefined): number {
  return fullResultText(result).split("\n").length;
}

function commandCount(params: unknown): number {
  return isRecord(params) && Array.isArray(params.commands) ? params.commands.length : 0;
}

function hitCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.startsWith("### ")).length;
}

function sectionStat(text: string): string {
  const match = text.match(/(\d+)\s+sections?\b/);
  if (!match) return paintRaw(TIDY_GREEN, "done");
  const count = Number(match[1]);
  return paintRaw(TIDY_GREEN, `${count} ${count === 1 ? "section" : "sections"}`);
}

function trailingStat(
  toolName: string,
  params: unknown,
  result: DisplayResult | undefined,
  options: { isPartial: boolean; isError?: boolean; elapsedMs?: number },
): string {
  const elapsed = formatElapsed(options.elapsedMs ?? 0);
  if (options.isPartial) return paintRaw(TIDY_DIM, elapsed);
  if (options.isError) {
    if (toolName === "bash" || toolName === "ctx_execute") return inElapsed("error", elapsed, TIDY_RED);
    return paintRaw(TIDY_RED, errorLine(result));
  }
  if (toolName === "read" || toolName === "ctx_execute_file") return paintRaw(TIDY_GREEN, `${outputLines(result)} lines`);
  if (toolName === "bash" || toolName === "ctx_execute") return inElapsed("done", elapsed, TIDY_GREEN);
  if (toolName === "ctx_batch_execute") {
    const count = commandCount(params);
    return inElapsed(`${count} ${count === 1 ? "command" : "commands"}`, elapsed, TIDY_GREEN);
  }
  if (toolName === "ctx_search") {
    const count = hitCount(fullResultText(result));
    return paintRaw(TIDY_GREEN, `${count} ${count === 1 ? "hit" : "hits"}`);
  }
  if (toolName === "ctx_index" || toolName === "ctx_fetch_and_index") return sectionStat(fullResultText(result));
  return paintRaw(TIDY_GREEN, "done");
}

function summaryLine(target: string | undefined, summary: string): string {
  const arrow = paintRaw(TIDY_DIM, "\u2192");
  if (!target) return `  ${arrow} ${summary}`;
  return `  ${paintRaw(TIDY_DIM, target)} ${arrow} ${summary}`;
}

export function displayBackground(partial: boolean, isError?: boolean): string {
  return partial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
}

export function renderTidyLines(
  toolName: string,
  params: unknown,
  result: DisplayResult | undefined,
  options: { expanded: boolean; isPartial: boolean; isError?: boolean; elapsedMs?: number },
  theme: DisplayTheme,
): string {
  const purpose = displayPurpose(params);
  const raw = concreteTarget(toolName, params);
  const target = raw && raw.length > LINE_TARGET_CAP ? raw.slice(0, LINE_TARGET_CAP) : raw;
  const headline = purpose ?? (target ? clip(target) : undefined);
  const summary = trailingStat(toolName, params, result, options);
  const name = paintToolName(toolName);
  const line1 = headline ? `${name} ${paint(theme, PURPOSE_COLOR, headline)}` : name;
  const lines = [line1, summaryLine(target, summary)];
  if (options.expanded && !options.isPartial) {
    const full = fullResultText(result);
    if (full.length > 0) lines.push(full);
  }
  return lines.join("\n");
}

interface MutableText {
  setText(text: string): void;
  setLineFill?(fill: ((line: string) => string) | undefined): void;
  setTailFit?(enabled: boolean): void;
}

interface RenderClock {
  lastComponent?: unknown;
  isPartial?: boolean;
  args?: unknown;
  isError?: boolean;
  toolCallId?: string;
}

function showBlock<T extends MutableText>(
  text: T,
  body: string,
  theme: DisplayTheme,
  partial: boolean,
  isError?: boolean,
): void {
  text.setText(body);
  text.setTailFit?.(body.length > 0);
  const background = displayBackground(partial, isError);
  text.setLineFill?.(body && theme.bg ? (line) => theme.bg!(background, line) : undefined);
}

/** Shared call/result split: Pi stacks both renderers, so the idle one must be blank. */
export function createTidyRenderers<T extends MutableText>(
  toolName: string,
  TextComponent: new () => T,
) {
  const reuse = (last: unknown): T => (last instanceof TextComponent ? last : new TextComponent());
  return {
    renderShell: "self" as const,
    renderCall(args: unknown, theme: DisplayTheme, context: RenderClock = {}) {
      const text = reuse(context.lastComponent);
      const running = context.isPartial !== false;
      showBlock(
        text,
        running
          ? renderTidyLines(toolName, args, undefined, {
            expanded: false,
            isPartial: true,
            elapsedMs: elapsedNow(context.toolCallId),
          }, theme)
          : "",
        theme,
        true,
      );
      return text;
    },
    renderResult(
      result: DisplayResult | undefined,
      options: { expanded: boolean; isPartial: boolean },
      theme: DisplayTheme,
      context: RenderClock = {},
    ) {
      const text = reuse(context.lastComponent);
      const isError = context.isError === true || result?.isError === true;
      showBlock(
        text,
        options.isPartial
          ? ""
          : renderTidyLines(toolName, context.args, result, {
            expanded: options.expanded,
            isPartial: false,
            isError,
            elapsedMs: elapsedNow(context.toolCallId),
          }, theme),
        theme,
        false,
        isError,
      );
      return text;
    },
  };
}
