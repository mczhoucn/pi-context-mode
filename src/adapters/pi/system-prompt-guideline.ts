/**
 * Pi-only removal of Pi's hardcoded Bash file-exploration guideline.
 *
 * Pi's default system prompt adds exactly one of these bullets whenever a Bash
 * tool is active and none of grep/find/ls is (Pi 0.85.1
 * `dist/core/system-prompt.js:54-70`):
 *
 *   - Use bash for file operations like ls, rg, find
 *   - Use bash or PowerShell for file operations like listing, searching, and finding files
 *   - Use PowerShell for file operations like listing, searching, and finding files
 *
 * The recovery replacement clears the native `promptSnippet`, which hides Bash
 * from Pi's textual Available/Core tools summary without disabling the callable
 * tool. Pi decides this separate guideline from ACTIVE TOOL NAMES ONLY, so an
 * extension cannot suppress it through prompt metadata: `promptGuidelines` are
 * appended and de-duplicated, never removed. Re-registering `bash` as
 * context-mode's recovery channel would otherwise leave the prompt
 * self-contradictory: one bullet presents bash as the tool for file exploration
 * while the ctx_execute routing guideline presents it as the last resort.
 *
 * Removal runs at the `before_provider_request` payload seam (the same seam
 * remove-pi-system uses) for two reasons:
 *
 *   1. `before_agent_start` handlers receive a prompt snapshot that goes stale
 *      when a later handler changes the active tool set — context-mode itself
 *      registers ctx_* tools from that hook.
 *   2. Earlier payload handlers rewrite the system text before we see it, so a
 *      payload-level handler is NOT guaranteed to observe a string equal to
 *      `ctx.getSystemPrompt()`. Removal is therefore content-addressed: the
 *      exact bullet line inside known instruction slots, never a whole-string
 *      equality check against the host's prompt.
 */

/** Cheap, specific pre-filter: every Pi variant contains this phrase. */
const FILE_OPERATIONS_MARKER = "for file operations like";

/** Exact bullet lines Pi can emit, matched whole so unrelated guidance that
 * also mentions file operations is never affected. */
export const PI_BASH_FILE_OPERATIONS_BULLETS: readonly string[] = [
  "- Use bash for file operations like ls, rg, find",
  "- Use bash or PowerShell for file operations like listing, searching, and finding files",
  "- Use PowerShell for file operations like listing, searching, and finding files",
];

/**
 * Remove Pi's Bash file-exploration bullet lines from a system prompt string.
 *
 * Pure and idempotent. Returns the input reference when no bullet is present;
 * otherwise every other line is preserved byte for byte, including blank lines
 * and a trailing newline.
 */
export function stripBashFileOperationsGuideline(text: string): string {
  if (!text.includes(FILE_OPERATIONS_MARKER)) return text;
  const lines = text.split("\n");
  const kept = lines.filter((line) => !PI_BASH_FILE_OPERATIONS_BULLETS.includes(line));
  return kept.length === lines.length ? text : kept.join("\n");
}

/** A provider payload object. Values stay `unknown`: shapes vary per provider. */
type Payload = Record<string, unknown>;

type Strip = (text: string) => string;

/** Plain string instruction slots used by Pi's provider families: the
 * openai-responses `instructions` field, provider variants of the same idea,
 * and the anthropic-compatible top-level `system`. */
const INSTRUCTION_TEXT_SLOTS = ["instructions", "systemInstruction", "systemPrompt", "system"];

/** Slots holding chat-style messages. Only system/developer roles are treated
 * as instructions; user/assistant/tool history is never rewritten. */
const INSTRUCTION_MESSAGE_SLOTS = ["messages", "input"];
const INSTRUCTION_ROLES = new Set(["system", "developer"]);

/**
 * Read an own DATA property without invoking getters, matching the defensive
 * read remove-pi-system uses for the same provider payloads.
 */
function ownValue(target: unknown, key: string): unknown {
  if (target === null || typeof target !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Apply `strip` to a string or to an array of text blocks. Copy-on-write:
 * returns the input reference when nothing changed.
 */
function stripTextContent(content: unknown, strip: Strip): unknown {
  if (typeof content === "string") return strip(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const blocks = content.map((block) => {
    const text = ownValue(block, "text");
    if (typeof text !== "string") return block;
    const stripped = strip(text);
    if (stripped === text) return block;
    changed = true;
    return { ...(block as Payload), text: stripped };
  });
  return changed ? blocks : content;
}

/** Copy-on-write replace of one instruction slot's text content. */
function stripInstructionSlot(container: Payload, slot: string, strip: Strip): Payload {
  const current = ownValue(container, slot);
  const stripped = stripTextContent(current, strip);
  return stripped === current ? container : { ...container, [slot]: stripped };
}

/** Copy-on-write replace of the instruction-role messages inside a slot. */
function stripMessageSlot(container: Payload, slot: string, strip: Strip): Payload {
  const messages = ownValue(container, slot);
  if (!Array.isArray(messages)) return container;
  let changed = false;
  const stripped = messages.map((message) => {
    const role = ownValue(message, "role");
    if (typeof role !== "string" || !INSTRUCTION_ROLES.has(role)) return message;
    const content = ownValue(message, "content");
    const nextContent = stripTextContent(content, strip);
    if (nextContent === content) return message;
    changed = true;
    return { ...(message as Payload), content: nextContent };
  });
  return changed ? { ...container, [slot]: stripped } : container;
}

/**
 * Remove Pi's hardcoded Bash file-exploration bullets from a provider payload.
 *
 * Copy-on-write and fail-closed: the input reference is returned whenever no
 * instruction slot contains a bullet, on unknown payload shapes, and on any
 * error. Non-instruction content — conversation history, tool schemas, and
 * sampling fields — is never rewritten. Provider-level changes are invisible to
 * `ctx.getSystemPrompt()` by design; that is Pi's documented contract for this
 * seam.
 */
export function filterProviderPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  try {
    let next = payload as Payload;
    for (const slot of INSTRUCTION_TEXT_SLOTS) {
      next = stripInstructionSlot(next, slot, stripBashFileOperationsGuideline);
    }
    for (const slot of INSTRUCTION_MESSAGE_SLOTS) {
      next = stripMessageSlot(next, slot, stripBashFileOperationsGuideline);
    }
    const context = ownValue(next, "context");
    if (context !== null && typeof context === "object" && !Array.isArray(context)) {
      const nextContext = stripInstructionSlot(context as Payload, "systemPrompt", stripBashFileOperationsGuideline);
      if (nextContext !== context) next = { ...next, context: nextContext };
    }
    return next;
  } catch {
    // Custom payloads may use proxies or exotic objects. Leave them untouched
    // rather than risking a malformed provider request.
    return payload;
  }
}
