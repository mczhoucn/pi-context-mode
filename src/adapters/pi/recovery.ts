import { readPiSessionId } from "./session-identity.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const RECOVERY_TYPE = "context-mode-recovery";
export type RecoveryReason = "resume" | "compact";
export interface RecoveryEvent { category: string; type: string; data: string; created_at?: string }
const baseline = new Set(["goal", "prompt", "file", "git", "decision", "rule", "error", "skill", "mcp", "cwd", "env", "subagent", "data"]);
const trimmed = new Set(["goal", "prompt", "file", "error", "skill", "mcp"]);

/** Project BEFORE any rendering. Unknown categories never become a raw fallback. */
export function projectRecoveryEvents(events: readonly RecoveryEvent[], reason: RecoveryReason, blackhole: boolean): RecoveryEvent[] {
  return events.map(e => e.category === "user-prompt" ? { ...e, category: "prompt" } : e).filter(e =>
    baseline.has(e.category) && e.data.trim() && e.type !== "rule_content" &&
    !(reason === "compact" && blackhole && (trimmed.has(e.category) || (e.category === "git" && e.type === "git_commit"))));
}

export async function renderRecovery(pluginRoot: string, events: readonly RecoveryEvent[], reason: RecoveryReason, blackhole: boolean): Promise<string> {
  const projected = projectRecoveryEvents(events, reason, blackhole);
  if (!projected.length) return "";
  const { groupEvents, buildSessionDirective } = await import(pathToFileURL(join(pluginRoot, "hooks/session-directive.mjs")).href);
  // The guide already contains decisions and skills. Do not duplicate them in a
  // standing behavioral block (or suggest Claude's nonexistent Pi Skill tool).
  const skillHint = projected.some(e => e.category === "skill") ? " Read a skill's SKILL.md if needed." : "";
  return `Historical session evidence only; not current state or authorization.${skillHint}\n` +
    buildSessionDirective(reason, groupEvents(projected), (name: string) => name, {
      historical: true, includeGoal: true,
      dataSearchHint: 'ctx_search(queries: [...], sort: "timeline")',
      dataOlderHint: 'older captured event records may be available in project history',
      searchHint: 'Use ctx_search(queries: [...], sort: "timeline") to search captured event records and available indexed content. Project history may include other sessions; verify provenance. Records may be summaries or metadata, not full tool outputs.',
    });
}

interface Entry { id: string; parentId?: string | null; type: string; customType?: string; details?: unknown }
export interface RecoveryManager {
  getSessionFile(): string | undefined;
  getSessionId(): string;
  getBranch(): Entry[];
  getEntries(): Entry[];
}
export interface RecoveryContext { sessionManager?: RecoveryManager }
interface SessionKey { file: string; host: string }
interface Identity extends SessionKey {
  key: string;
  branch: Entry[];
  ids: Set<string>;
  segment: string;
  unambiguous: boolean;
}
interface Provenance { version: 2; file: string; host: string; boundary: string; segment: string; reason: RecoveryReason; profile: "baseline" | "blackhole" }
interface Message { role?: string; customType?: string; details?: unknown; content?: unknown }
interface Dependencies {
  events(key: string): RecoveryEvent[];
  blackhole(): boolean;
  /** Optional so existing unit harnesses keep the historical behavior.
   *  The Pi extension always supplies it from `disabledBuiltinFeatures`. */
  compactRecoveryDisabled?(): boolean;
  render(events: RecoveryEvent[], reason: RecoveryReason, blackhole: boolean): Promise<string>;
  send(message: { customType: string; content: string; display: false; details: Provenance }, options: { triggerTurn: false }): void;
  warn(message: string): void;
}
const owned = (e: { customType?: string }) => e.customType === RECOVERY_TYPE;
function sessionKey(ctx: RecoveryContext): SessionKey | undefined {
  try {
    const manager = ctx.sessionManager;
    const file = manager?.getSessionFile();
    const host = readPiSessionId(ctx);
    if (!manager || typeof file !== "string" || !file.trim() || !host) return;
    return { file, host };
  } catch { return; }
}
function isNativeConversationEntry(entry: Entry): boolean {
  return entry.type === "message" || entry.type === "compaction" ||
    entry.type === "custom_message" || entry.type === "branch_summary";
}
function hasNativeConversation(ctx: RecoveryContext): boolean {
  try {
    const branch = ctx.sessionManager?.getBranch();
    return !!branch?.some(isNativeConversationEntry);
  } catch { return false; }
}
function metadata(value: unknown): Provenance | undefined {
  if (!value || typeof value !== "object") return;
  const p = value as Provenance;
  if (p.version === 2 && typeof p.file === "string" && typeof p.host === "string" &&
      typeof p.boundary === "string" && typeof p.segment === "string" && (p.reason === "resume" || p.reason === "compact") &&
      (p.profile === "baseline" || (p.reason === "compact" && p.profile === "blackhole"))) return p;
}
function identity(ctx: RecoveryContext): Identity | undefined {
  try {
    const manager = ctx.sessionManager;
    const key = sessionKey(ctx);
    if (!manager || !key) return;
    const branch = manager.getBranch();
    const ids = new Set<string>();
    let latestCompaction: string | undefined;
    for (const entry of branch) {
      ids.add(entry.id);
      if (entry.type === "compaction") latestCompaction = entry.id;
    }
    // SessionDB rows have no branch provenance. Any divergent history makes
    // rebuilding from those rows unsafe, even if a sibling looks irrelevant.
    const unambiguous = manager.getEntries().every(e => ids.has(e.id));
    return { ...key, branch, ids, segment: latestCompaction ?? "initial", unambiguous, key: key.host };
  } catch { return; }
}
function segment(i: Identity): string { return i.segment; }
function same(a: SessionKey | undefined, b: SessionKey | undefined): boolean { return !!a && !!b && a.file === b.file && a.host === b.host; }
function valid(p: Provenance | undefined, i: Identity): p is Provenance {
  return !!p && p.file === i.file && p.host === i.host && p.segment === segment(i) &&
    i.ids.has(p.boundary);
}
/** Instance-scoped lifecycle owner. Public context hooks only FILTER; never append.
 * Empty custom messages are durable retirement markers, not recovery bodies.
 * Legacy resume XML and v1 (path-key) bodies cannot prove native-ID provenance.
 */
export class PiRecovery {
  private epoch = 0;
  private current?: SessionKey;
  private prepared?: { identity: Identity; events: RecoveryEvent[]; blackhole: boolean; anchor: string };
  private scheduled?: Provenance;
  constructor(private readonly deps: Dependencies) {}
  reset(): void { this.epoch++; this.current = undefined; this.prepared = undefined; this.scheduled = undefined; }
  async activate(reason: string, ctx: RecoveryContext): Promise<void> {
    // Pi restores the native transcript when a session is resumed, so rebuilding
    // the same history from SessionDB only duplicates context. The initial
    // --continue/--resume path is reported as "startup"; a conversational branch
    // distinguishes it from a genuinely new session (which has only setup entries).
    const nativeKey = reason === "resume" || reason === "startup" ? sessionKey(ctx) : undefined;
    const nativeResume = reason === "resume" ||
      (reason === "startup" && !!nativeKey && hasNativeConversation(ctx));
    if (nativeResume) {
      // Invalidate a reload that is still rendering: a resume must never allow
      // an already-started historical injection to arrive after the boundary.
      this.reset();
      this.current = nativeKey;
      return;
    }
    const i = identity(ctx);
    const anchor = i?.branch.filter(e => !owned(e)).at(-1)?.id;
    // Preserve the first render/send reservation through duplicate host callbacks,
    // including the window before Pi flushes a queued custom message to its branch.
    if (i?.unambiguous && same(this.current, i) && ["startup", "reload"].includes(reason) &&
        valid(this.scheduled, i) && this.scheduled.reason === "resume" && this.scheduled.boundary === anchor) return;
    this.reset();
    this.current = i;
    if (!i || !i.unambiguous || !["startup", "reload"].includes(reason)) return;
    if (!anchor || !i.branch.some(e => e.type === "message")) return;
    try { await this.deliver(i, ctx, "resume", anchor, this.deps.events(i.key), false); }
    catch { this.deps.warn("Own-session recovery events unavailable; no history substituted."); }
  }
  prepare(ctx: RecoveryContext): void {
    this.prepared = undefined;
    const i = identity(ctx);
    if (!same(this.current, i) || !i?.unambiguous) return;
    const anchor = i.branch.at(-1)?.id;
    if (!anchor) return;
    try { this.prepared = { identity: i, anchor, events: this.deps.events(i.key), blackhole: this.deps.blackhole() }; }
    catch { this.deps.warn("Recovery preparation unavailable; compaction remains enabled."); }
  }
  failed(): void { this.prepared = undefined; }
  async compact(entryId: unknown, ctx: RecoveryContext): Promise<void> {
    const i = identity(ctx);
    const candidate = this.prepared;
    this.prepared = undefined;
    if (!same(this.current, i) || !i || typeof entryId !== "string" || segment(i) !== entryId) return;
    // Every successful compact retires the preceding generation, even when
    // provenance/settings/rendering make the replacement empty/unavailable.
    this.current = i;
    const usable = i.unambiguous && candidate && same(candidate.identity, i) && i.branch.some(e => e.id === candidate.anchor);
    try {
      await this.deliver(i, ctx, "compact", entryId,
        usable ? candidate.events : i.unambiguous ? this.deps.events(i.key) : [],
        usable ? candidate.blackhole : i.unambiguous ? this.deps.blackhole() : false);
    } catch { this.deps.warn("Recovery unavailable after compaction; prior segment retired."); }
  }
  private async deliver(i: Identity, ctx: RecoveryContext, reason: RecoveryReason, boundary: string, events: RecoveryEvent[], blackhole: boolean): Promise<void> {
    const details: Provenance = { version: 2, file: i.file, host: i.host, boundary, segment: segment(i), reason,
      profile: reason === "compact" && blackhole ? "blackhole" : "baseline" };
    const matches = (p: Provenance | undefined) => valid(p, i) && p.reason === reason && p.boundary === boundary;
    if (matches(this.scheduled) || i.branch.some(e => owned(e) && matches(metadata(e.details)))) return;
    const epoch = this.epoch;
    this.scheduled = details; // reserve boundary across asynchronous helper loading
    try {
      const content = await this.deps.render(events, reason, blackhole);
      const now = identity(ctx);
      if (epoch !== this.epoch || !same(i, now) || !now || segment(now) !== details.segment || now.branch.at(-1)?.id !== i.branch.at(-1)?.id) {
        if (this.scheduled === details) this.scheduled = undefined;
        return;
      }
      if (!content && reason === "resume") {
        if (this.scheduled === details) this.scheduled = undefined;
        return;
      }
      // Mark BEFORE public send so synchronous idle delivery/reentrancy is safe.
      this.scheduled = details;
      this.deps.send({ customType: RECOVERY_TYPE, content, display: false, details }, { triggerTurn: false });
    } catch {
      if (epoch === this.epoch && this.scheduled === details) this.scheduled = undefined;
      this.deps.warn("Recovery rendering/delivery unavailable; no legacy history substituted.");
    }
  }
  filter<T extends Message>(messages: T[], ctx: RecoveryContext): T[] {
    const i = identity(ctx);
    // A body injected before this feature was disabled must leave model context
    // too. Otherwise the switch would stop new writes while the old body kept
    // spending context tokens on every request — the feature would still be
    // active through its own output. Only compact-reason bodies retire here;
    // explicit-reload (resume) recovery is a separate lifecycle behavior.
    const retired = (m: Message): boolean =>
      owned(m) && metadata(m.details)?.reason === "compact" &&
      (this.deps.compactRecoveryDisabled?.() ?? false);
    if (!same(this.current, i)) { this.reset(); return messages.filter(m => !(m.role === "custom" && owned(m))); }
    if (!i) return messages.filter(m => !(m.role === "custom" && retired(m)));
    const entries = i.branch.filter(e => owned(e) && valid(metadata(e.details), i));
    const latest = metadata(entries.at(-1)?.details);
    // Only branch-persisted delivery is eligible. A queued send isn't proof.
    let kept = false;
    return messages.filter(m => {
      if (m.role !== "custom" || !owned(m)) return true;
      if (retired(m)) return false;
      const p = metadata(m.details);
      if (kept || !latest || !valid(p, i) || p.boundary !== latest.boundary || p.reason !== latest.reason || !m.content) return false;
      kept = true;
      return true;
    });
  }
}
