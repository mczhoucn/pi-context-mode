import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = resolve(root, "skills/context-mode");
const source = readFileSync(resolve(skillDir, "SKILL.md"), "utf8");
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
if (!match) throw new Error("context-mode skill must have frontmatter and a body");
const [, frontmatter, body] = match;
const description = frontmatter.match(/^description: [|>]-?\r?\n((?:[ \t]+[^\n]*(?:\n|$))*)/m)?.[1]
  ?.split("\n").map((line) => line.trim()).join(" ").trim() ?? "";
const reference = (name: string) => readFileSync(resolve(skillDir, "references", name), "utf8");

describe("context-mode progressive disclosure contract", () => {
  it("keeps the resident description short without XML-escape expansion", () => {
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(500);
    // Pi escapes all five characters in skill metadata, not in the body.
    expect(description).not.toMatch(/["'&<>]/);
    for (const branch of ["command", "file", "test", "log", "API", "browser", "dependency", "infrastructure", "data", "MCP", "20 lines", "ctx_batch_execute"]) {
      expect(description).toContain(branch);
    }
  });

  it("keeps common rules inline within the main-body budget", () => {
    expect(body.length).toBeLessThanOrEqual(6000);
    for (const rule of [
      /Bash whitelist/, /file mutations/i, /git writes/i, /navigation/i,
      /process control/i, /package management/i, /simple output/i,
      /files? (?:you need )?to edit/i, /normal.*read/i,
      /print.*findings/i, /IDs/, /line numbers/, /exact values/,
      /already in context/i, /ctx_index\(path/, /small inline text/i,
      /preserve.*full output/i, /2.?4 specific technical terms/i,
      /OR semantics/, /queries.*array/i, /source.*multiple/i,
      /raw\.githubusercontent\.com/, /PreToolUse/, /filename/,
    ]) expect(body).toMatch(rule);
  });

  it("loads references only on explicit task branches with resolvable links", () => {
    expect(body).toMatch(/Read only the reference matching the current task/i);
    expect(body).toMatch(/Before.*browser.*\[.*\]\(\.\/references\/browser\.md\)/i);
    expect(body).toMatch(/When.*(?:capture|routing).*\[.*\]\(\.\/references\/anti-patterns\.md\)/i);
    for (const language of ["javascript", "python", "shell"]) {
      expect(body).toMatch(new RegExp(`Only when.*example.*\\[.*\\]\\(\\./references/patterns-${language}\\.md\\)`, "i"));
    }
    const links = [...body.matchAll(/\]\((\.\/references\/[^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
    expect(new Set(links).size).toBe(5);
    for (const link of links) {
      const file = resolve(skillDir, link);
      expect(existsSync(file), link).toBe(true);
      expect(readFileSync(file, "utf8")).not.toMatch(/^---\r?\n/);
    }
    expect(body).not.toMatch(/browser_snapshot\(filename:|const resp = await fetch/);
  });

  it("retains browser branches and isolation caveats in the browser reference", () => {
    const browser = reference("browser.md");
    for (const rule of [
      /browser_snapshot\(filename:/, /ctx_index\(path:/, /ctx_search\(queries:/,
      /ctx_execute_file\(path:/, /FILE_CONTENT/, /browser_console_messages/,
      /browser_network_requests/, /browser_navigate/, /auto.*snapshot/i,
      /shared browser/i, /agent-browser/, /distinct.*session/i,
    ]) expect(browser).toMatch(rule);
  });

  it("keeps referenced guidance consistent with current tools and capture modes", () => {
    const pitfalls = reference("anti-patterns.md");
    expect(pitfalls).toMatch(/one-shot/i);
    expect(pitfalls).toMatch(/full output/i);
    expect(pitfalls).toContain("ctx_batch_execute");
    for (const file of ["anti-patterns.md", "patterns-javascript.md", "patterns-python.md", "patterns-shell.md"]) {
      const text = reference(file);
      expect(text, file).not.toMatch(/summary_prompt|timeout_ms/);
      expect(text, file).not.toMatch(/otherwise use Bash|under ~20 lines.*use Bash|Do every narrowing step downstream/i);
    }
  });
});
