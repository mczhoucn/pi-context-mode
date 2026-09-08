/**
 * Pi context-mode settings hierarchy.
 *
 * Pi owns its context-mode settings instead of inheriting Claude Code's
 * project/global files. This suite deliberately writes decoy Claude and
 * legacy Pi settings so a fallback read cannot pass accidentally.
 */
import { describe, test, beforeAll, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readBashPolicies,
  readToolDenyPatterns,
} from "../build/security.js";

let tmpBase: string;
let savedHome: string | undefined;
let savedUserprofile: string | undefined;
let savedPlatform: string | undefined;
let savedClaudeConfig: string | undefined;

beforeAll(() => {
  tmpBase = join(tmpdir(), `security-pi-settings-${Date.now()}`);
  mkdirSync(tmpBase, { recursive: true });
  savedHome = process.env.HOME;
  savedUserprofile = process.env.USERPROFILE;
  savedPlatform = process.env.CONTEXT_MODE_PLATFORM;
  savedClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserprofile;
  if (savedPlatform === undefined) delete process.env.CONTEXT_MODE_PLATFORM;
  else process.env.CONTEXT_MODE_PLATFORM = savedPlatform;
  if (savedClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfig;
  rmSync(tmpBase, { recursive: true, force: true });
});

function usePiEnvironment(fakeHome: string): void {
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.CONTEXT_MODE_PLATFORM = "pi";
  delete process.env.CLAUDE_CONFIG_DIR;
}

test("reads project and global Pi files, never Claude or legacy Pi files", () => {
  const fakeHome = join(tmpBase, "home");
  const projectDir = join(tmpBase, "project");
  const piProjectDir = join(projectDir, ".pi", "context-mode");
  const piGlobalDir = join(fakeHome, ".pi", "agent", "context-mode");
  mkdirSync(piProjectDir, { recursive: true });
  mkdirSync(piGlobalDir, { recursive: true });
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".pi"), { recursive: true });

  writeFileSync(
    join(piProjectDir, "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(pi-project *)", "Read(.env.pi)"] } }),
  );
  writeFileSync(
    join(piGlobalDir, "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(pi-global *)", "Read(.env.global-pi)"] } }),
  );
  writeFileSync(
    join(projectDir, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { deny: ["Bash(legacy-project-local *)"] } }),
  );
  writeFileSync(
    join(projectDir, ".claude", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(legacy-project-shared *)"] } }),
  );
  writeFileSync(
    join(fakeHome, ".claude", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(legacy-global *)"] } }),
  );
  writeFileSync(
    join(fakeHome, ".pi", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(legacy-pi-root *)"] } }),
  );
  usePiEnvironment(fakeHome);

  const policies = readBashPolicies(projectDir);
  assert.equal(policies.length, 2);
  assert.deepEqual(policies.map((policy) => policy.deny), [
    ["Bash(pi-project *)"],
    ["Bash(pi-global *)"],
  ]);
  const allBashDeny = policies.flatMap((policy) => policy.deny);
  assert.ok(!allBashDeny.some((pattern) => pattern.includes("legacy-")));

  const readPatterns = readToolDenyPatterns("Read", projectDir).flat();
  assert.deepEqual(readPatterns, [".env.pi", ".env.global-pi"]);
});

test("does not fall back when only Claude and legacy Pi files exist", () => {
  const fakeHome = join(tmpBase, "empty-home");
  const projectDir = join(tmpBase, "empty-project");
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".claude", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(should-not-load *)"] } }),
  );
  writeFileSync(
    join(fakeHome, ".claude", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(should-not-load-global *)"] } }),
  );
  writeFileSync(
    join(fakeHome, ".pi", "settings.json"),
    JSON.stringify({ permissions: { deny: ["Bash(should-not-load-legacy-pi *)"] } }),
  );
  usePiEnvironment(fakeHome);

  assert.deepEqual(readBashPolicies(projectDir), []);
  assert.deepEqual(readToolDenyPatterns("Read", projectDir), []);
});
