import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { PiRecovery, RECOVERY_TYPE, projectRecoveryEvents, renderRecovery, type RecoveryEvent } from "../../src/adapters/pi/recovery.js";
const event = (category: string, type = category, data = `${category}-evidence`): RecoveryEvent => ({ category, type, data });
const fixture = ["role", "intent", "plan", "task", "goal", "user-prompt", "file", "decision", "rule", "error", "skill", "mcp", "cwd", "env", "subagent", "data"].map(c => event(c));
fixture.push(event("git", "git_commit", "commit-only-evidence"), event("git", "git_branch", "branch-named-commit"), event("rule", "rule_content", "FULL RULE DO NOT REPLAY"));

describe("Pi recovery projection and shared guide", () => {
  for (const reason of ["resume", "compact"] as const) for (const flag of [false, true]) {
    it(`${reason} blackhole=${flag} applies every policy category`, async () => {
      const text = await renderRecovery(resolve("."), fixture, reason, flag);
      const trim = reason === "compact" && flag;
      for (const excluded of ["role", "intent", "plan", "task"]) expect(text).not.toContain(`${excluded}-evidence`);
      for (const kept of ["decision", "rule", "cwd", "env", "subagent", "data"]) expect(text).toContain(`${kept}-evidence`);
      for (const optional of ["goal", "user-prompt", "file", "error", "skill", "mcp"]) expect(text.includes(`${optional}-evidence`)).toBe(!trim);
      expect(text.includes("commit-only-evidence")).toBe(!trim);
      expect(text).toContain("branch-named-commit");
      expect(text).not.toContain("FULL RULE");
      expect(text).not.toContain("Unresolved Errors");
      expect(text).not.toContain("call the Skill tool");
      if (trim) expect(text).not.toContain("SKILL.md");
      expect(text).not.toContain("<continue_from>");
      expect(text).toContain("Historical Environment");
      expect(text).toContain("Historical Subagent Records");
    });
  }
  it("only canonical types determine omissions; data stays bounded", async () => {
    const events = [event("decision", "decision", "commit skill error role intent plan"), event("data", "data", "x".repeat(30000))];
    expect(projectRecoveryEvents(events, "compact", true)).toEqual(events);
    const text = await renderRecovery(resolve("."), events, "compact", true);
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain('ctx_search');
  });
  it("Pi data hints describe captured records rather than a fictitious full-output index", async () => {
    const text = await renderRecovery(resolve("."), Array.from({ length: 12 }, () => event("data", "data", "x".repeat(1000))), "resume", false);
    expect(text).toContain('ctx_search(queries: [...], sort: "timeline")');
    expect(text).toContain("4 older captured event records may be available in project history");
    expect(text).not.toContain("kept in the sandbox");
    expect(text).not.toContain("session-events");
    expect(text).not.toContain("already indexed");
  });
  it("empty, excluded-only and unknown events have no generic footer fallback", async () => {
    for (const events of [[], [event("role")], [event("pi")], [event("rule", "rule_content")]]) {
      expect(await renderRecovery(resolve("."), events, "resume", false)).toBe("");
    }
    await expect(renderRecovery("/missing-helper", [event("decision")], "resume", false)).rejects.toThrow();
  });
  it("shared Claude defaults remain identical with omitted versus empty options", async () => {
    const { buildSessionDirective, groupEvents } = await import("../../hooks/session-directive.mjs");
    const grouped = groupEvents(fixture);
    const original = buildSessionDirective("compact", grouped);
    expect(original).toBe(readFileSync(resolve("tests/fixtures/pi-recovery-claude-guide.txt"), "utf8"));
    expect(buildSessionDirective("compact", grouped, undefined, {})).toBe(original);
    expect(original).toContain("## Unresolved Errors");
    expect(original).toContain("## Session Intent");
    expect(original).not.toContain("Recorded Goal");
  });
});

function harness() {
  let name = "A";
  let branch: any[] = [{ id: "user-1", type: "message", parentId: null }];
  let extra: any[] = [];
  let events = [event("decision")];
  let blackhole = false;
  const ctx = { sessionManager: {
    getSessionFile: () => `/sessions/${name}.jsonl`, getSessionId: () => name,
    getBranch: () => [...branch], getEntries: () => [...branch, ...extra],
  } };
  const queued: any[] = [];
  const deps = {
    events: vi.fn(() => events), blackhole: () => blackhole,
    render: vi.fn(async (e: RecoveryEvent[], r: "resume" | "compact", f: boolean) => projectRecoveryEvents(e, r, f).map(e => e.data).join("\n")),
    send: vi.fn((message: any, options: any) => { expect(options).toEqual({ triggerTurn: false }); queued.push(message); }), warn: vi.fn(),
  };
  const controller = new PiRecovery(deps);
  const flush = () => { for (const m of queued.splice(0)) branch.push({ ...m, id: `recovery-${branch.length}`, type: "custom_message", parentId: branch.at(-1)?.id }); };
  const messages = () => branch.filter(e => e.type === "custom_message").map(e => ({ role: "custom", customType: e.customType, details: e.details, content: e.content }));
  const compact = async (id: string, prepare = true) => { if (prepare) controller.prepare(ctx); branch.push({ id, type: "compaction", parentId: branch.at(-1)?.id }); await controller.compact(id, ctx); };
  return { ctx, deps, controller, flush, messages, compact, queued, branch,
    setEvents: (e: RecoveryEvent[]) => { events = e; }, setFlag: (v: boolean) => { blackhole = v; },
    switchSession: () => { name = "B"; branch = [{ id: "other", type: "message" }]; },
    diverge: () => { extra = [{ id: "sibling", type: "message" }]; },
  };
}

describe("Pi lifecycle persistent ownership", () => {
  it("duplicate activation preserves both in-flight and unflushed reservations", async () => {
    const h = harness(); let done!: (value: string) => void;
    h.deps.render.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const pending = h.controller.activate("resume", h.ctx);
    await h.controller.activate("reload", h.ctx);
    expect(h.deps.render).toHaveBeenCalledOnce();
    done("first render"); await pending;
    expect(h.deps.send).toHaveBeenCalledOnce();
    await h.controller.activate("resume", h.ctx);
    expect(h.deps.send).toHaveBeenCalledOnce();
    h.flush();
    expect(h.controller.filter(h.messages(), h.ctx)).toHaveLength(1);
  });
  it("new host ID on the same file invalidates an in-flight render and reads only the new key", async () => {
    const h = harness(); let done!: (value: string) => void;
    h.ctx.sessionManager.getSessionFile = () => "/sessions/reused.jsonl";
    h.deps.render.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const pending = h.controller.activate("resume", h.ctx);
    h.switchSession();
    await h.controller.activate("startup", h.ctx);
    done("stale A"); await pending;
    expect(h.deps.events.mock.calls).toEqual([["A"], ["B"]]);
    expect(h.deps.send).toHaveBeenCalledOnce();
    expect(h.queued[0].details.host).toBe("B");
    expect(h.queued[0].content).not.toContain("stale A");
  });
  it("changed boundary invalidates an in-flight reservation", async () => {
    const h = harness(); let done!: (value: string) => void;
    h.deps.render.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const pending = h.controller.activate("resume", h.ctx);
    h.branch.push({ id: "u2", type: "message" });
    await h.controller.activate("resume", h.ctx);
    done("stale"); await pending;
    expect(h.deps.send).toHaveBeenCalledOnce();
    expect(h.queued[0].details.boundary).toBe("u2");
  });
  it("empty resume does not send; empty compact persists exactly one retirement marker", async () => {
    const h = harness(); h.setEvents([event("role")]);
    await h.controller.activate("resume", h.ctx); h.flush();
    expect(h.deps.send).not.toHaveBeenCalled();
    expect(h.messages()).toHaveLength(0);
    await h.compact("c1"); h.flush();
    expect(h.deps.send).toHaveBeenCalledOnce();
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0].content).toBe("");
    expect(h.controller.filter(h.messages(), h.ctx)).toEqual([]);
  });
  it("provenance filtering visits branch properties only linearly per call", async () => {
    const h = harness(); await h.controller.activate("resume", h.ctx); h.flush();
    const template = h.branch.at(-1);
    let reads = 0;
    const n = 400;
    for (let j = 0; j < n; j++) h.branch.push({
      ...template, get id() { reads++; return `old-${j}`; },
      get type() { reads++; return "custom_message"; },
    });
    const messages = h.messages();
    for (let j = 0; j < 2; j++) {
      reads = 0;
      expect(h.controller.filter(messages, h.ctx)).toHaveLength(1);
      expect(reads).toBeGreaterThanOrEqual(n);
      expect(reads).toBeLessThan(n * 10);
    }
  });
  it("version-1 path-key bodies are rejected without rewriting transcript entries", async () => {
    const h = harness(); await h.controller.activate("resume", h.ctx); h.flush();
    const old = h.branch.at(-1);
    old.details = { ...old.details, version: 1 };
    old.content = "UNBOUND VERSION ONE";
    expect(h.controller.filter(h.messages(), h.ctx)).toEqual([]);
    const restarted = new PiRecovery(h.deps);
    await restarted.activate("reload", h.ctx); h.flush();
    expect(h.messages()).toHaveLength(2);
    expect(h.messages()[0].content).toBe("UNBOUND VERSION ONE");
    expect(restarted.filter(h.messages(), h.ctx)).toHaveLength(1);
    expect(restarted.filter(h.messages(), h.ctx)[0].details.version).toBe(2);
  });
  it("in-memory sessions never qualify for persistent recovery", async () => {
    const h = harness();
    const ctx = { sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => undefined } };
    await h.controller.activate("resume", ctx);
    h.controller.prepare(ctx);
    await h.controller.compact("c1", ctx);
    expect(h.deps.events).not.toHaveBeenCalled();
    expect(h.deps.send).not.toHaveBeenCalled();
  });
  it("new sessions never read another history; own resume reads only native host key", async () => {
    const h = harness();
    await h.controller.activate("new", h.ctx);
    expect(h.deps.events).not.toHaveBeenCalled();
    expect(h.deps.send).not.toHaveBeenCalled();
    await h.controller.activate("resume", h.ctx);
    expect(h.deps.events).toHaveBeenCalledExactlyOnceWith("A");
    h.flush();
    expect(h.controller.filter(h.messages(), h.ctx)).toHaveLength(1);
  });
  it("preparation does not send; successful inline compact queues once and requires persisted delivery", async () => {
    const h = harness(); await h.controller.activate("new", h.ctx);
    h.controller.prepare(h.ctx); expect(h.deps.send).not.toHaveBeenCalled();
    await h.compact("c1");
    expect(h.queued).toHaveLength(1);
    expect(h.controller.filter([{ role: "custom", ...h.queued[0] }], h.ctx)).toEqual([]);
    h.flush();
    for (let i = 0; i < 4; i++) expect(h.controller.filter(h.messages(), h.ctx)).toHaveLength(1);
    await h.controller.compact("c1", h.ctx);
    expect(h.deps.send).toHaveBeenCalledOnce();
    expect(h.deps.render).toHaveBeenCalledOnce();
  });
  it("two compactions and empty replacement retire retained old tails across restart", async () => {
    const h = harness(); await h.controller.activate("resume", h.ctx); h.flush();
    await h.compact("c1"); h.flush();
    expect(h.messages()).toHaveLength(2);
    expect(h.controller.filter(h.messages(), h.ctx)).toHaveLength(1);
    h.setEvents([event("role")]); await h.compact("c2"); h.flush();
    expect(h.messages()).toHaveLength(3);
    expect(h.controller.filter(h.messages(), h.ctx)).toEqual([]);
    const restarted = new PiRecovery(h.deps);
    await restarted.activate("reload", h.ctx); h.flush();
    expect(restarted.filter(h.messages(), h.ctx)).toEqual([]);
  });
  it("resume uses baseline even after trimmed compact and reuses baseline on duplicate reload", async () => {
    const h = harness(); h.setEvents([event("goal")]); h.setFlag(true);
    await h.controller.activate("new", h.ctx); await h.compact("c1"); h.flush();
    expect(h.controller.filter(h.messages(), h.ctx)).toEqual([]);
    await h.controller.activate("resume", h.ctx); h.flush();
    expect(h.controller.filter(h.messages(), h.ctx)[0].content).toContain("goal-evidence");
    await h.controller.activate("reload", h.ctx);
    expect(h.deps.send).toHaveBeenCalledTimes(2);
  });
  it("failure leaves prior recovery active; unrelated messages and tool ordering survive", async () => {
    const h = harness(); await h.controller.activate("resume", h.ctx); h.flush();
    h.controller.prepare(h.ctx); h.controller.failed();
    const unrelated = [{ role: "assistant", content: "tool call" }, { role: "toolResult", content: "result" }, { role: "custom", customType: "todo", content: "tasks" }, { role: "user", content: "<session_knowledge>not ours" }];
    expect(h.controller.filter([...unrelated, ...h.messages()], h.ctx)).toEqual([...unrelated, ...h.messages()]);
    const old = h.messages();
    h.switchSession();
    expect(h.controller.filter([...unrelated, ...old], h.ctx)).toEqual(unrelated);
  });
  it("omits missing identity, divergent legacy provenance and malformed owned messages", async () => {
    const h = harness(); h.diverge();
    await h.controller.activate("resume", h.ctx);
    expect(h.deps.events).not.toHaveBeenCalled();
    expect(h.controller.filter([{ role: "custom", customType: RECOVERY_TYPE, details: { snapshot: "raw XML" }, content: "BAD" }], h.ctx)).toEqual([]);
    await h.controller.activate("resume", {});
    expect(h.deps.send).not.toHaveBeenCalled();
  });
  it("stale asynchronous render never sends to a changed session", async () => {
    const h = harness(); let done!: (v: string) => void;
    h.deps.render.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const pending = h.controller.activate("resume", h.ctx);
    h.switchSession(); done("stale"); await pending;
    expect(h.deps.send).not.toHaveBeenCalled();
  });
  it("read/send failures are nonfatal and an undelivered boundary can retry", async () => {
    const h = harness(); h.deps.events.mockImplementationOnce(() => { throw new Error("db unavailable"); });
    await h.controller.activate("resume", h.ctx);
    expect(h.deps.send).not.toHaveBeenCalled();
    h.deps.send.mockImplementationOnce(() => { throw new Error("host unavailable"); });
    await h.controller.activate("reload", h.ctx);
    expect(h.queued).toHaveLength(0);
    await h.controller.activate("reload", h.ctx);
    expect(h.queued).toHaveLength(1);
    expect(h.deps.warn).toHaveBeenCalledTimes(2);
  });
  it("fork/tree reset and missing preparation never restore foreign events", async () => {
    const h = harness(); await h.controller.activate("resume", h.ctx); h.flush();
    const old = h.messages(); h.controller.reset();
    expect(h.controller.filter(old, h.ctx)).toEqual([]);
    await h.controller.activate("fork", h.ctx);
    expect(h.deps.send).toHaveBeenCalledOnce();
    await h.compact("c1", false); h.flush();
    expect(h.controller.filter(h.messages(), h.ctx)).toHaveLength(1);
  });
  it("renderer failure never substitutes legacy history or prevents later retry", async () => {
    const h = harness(); h.deps.render.mockRejectedValueOnce(new Error("missing helper"));
    await h.controller.activate("resume", h.ctx);
    expect(h.deps.send).not.toHaveBeenCalled(); expect(h.deps.warn).toHaveBeenCalledOnce();
    await h.controller.activate("reload", h.ctx); expect(h.deps.send).toHaveBeenCalledOnce();
  });
});
