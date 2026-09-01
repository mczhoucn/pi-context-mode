/**
 * Claude Code config directory resolver and host settings path helpers.
 *
 * Claude-specific callers use this module to honor CLAUDE_CONFIG_DIR. The
 * security reader also uses the host-aware helpers below: Pi is deliberately
 * isolated from Claude's settings, while other adapters retain their native
 * compatibility behavior.
 *
 * Mirrors the contract of `hooks/session-helpers.mjs::resolveConfigDir` and
 * `ClaudeCodeAdapter.getConfigDir` for Claude Code:
 *   - env unset, empty string, or whitespace-only → ~/.claude
 *   - env starts with `~`, `~/`, or `~\` → expanded against homedir()
 *   - otherwise → resolved to absolute (relative paths anchor to cwd)
 *
 * Whitespace guard: shells that quote-pad CLAUDE_CONFIG_DIR (`" "`) would
 * otherwise resolve to `cwd/<spaces>` — silently writing settings into the
 * project tree. Trim before the truthy check so quote-padding falls back to
 * `~/.claude` like a sane default.
 *
 * Cross-platform note: tilde regex strips a single leading `/` OR `\` so
 * `~\Users\foo` works on Windows. `path.resolve` handles drive-letter joining.
 */
import { resolve } from "node:path";
import { homedir } from "node:os";
import { detectPlatform, getSessionDirSegments } from "../adapters/detect.js";

export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const envVal = env.CLAUDE_CONFIG_DIR;
  if (envVal && envVal.trim() !== "") {
    if (envVal.startsWith("~")) {
      return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    }
    return resolve(envVal);
  }
  return resolve(homedir(), ".claude");
}

/** Resolve the Pi-owned global context-mode settings path. */
export function resolvePiGlobalSettingsPath(home: string = homedir()): string {
  return resolve(home, ".pi", "agents", "context-mode", "settings.json");
}

/**
 * Resolve project settings for the active host.
 *
 * Pi deliberately has one context-mode-owned project file and no Claude
 * compatibility tier. Other adapters retain their native project hierarchy.
 * The optional platform argument keeps this pure and easy to test; callers
 * normally omit it and use the detected platform.
 */
export function resolveProjectSettingsPaths(
  projectDir: string,
  platform: string = detectPlatform().platform,
): string[] {
  if (platform === "pi") {
    return [resolve(projectDir, ".pi", "context-mode", "settings.json")];
  }
  return [
    resolve(projectDir, ".claude", "settings.local.json"),
    resolve(projectDir, ".claude", "settings.json"),
  ];
}

/** Resolve the Claude global settings.json path, honoring CLAUDE_CONFIG_DIR. */
export function resolveClaudeGlobalSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(resolveClaudeConfigDir(env), "settings.json");
}

/**
 * Issue #451 round-3: cross-adapter deny-policy parity.
 *
 * The security policy reader needs the global settings path(s) for the
 * detected host. For non-Pi adapters this helper returns the union of:
 *
 *   1. The currently-detected adapter's home-rooted settings.json (when the
 *      adapter is non-Claude — Claude is already covered by entry 2).
 *   2. The Claude global settings.json (defense in depth).
 *
 * Pi is the intentional exception: it returns only the context-mode-owned
 * `~/.pi/agents/context-mode/settings.json`, with no Claude or generic Pi
 * settings fallback.
 *
 * Static import of `../adapters/detect.js` is safe — detect.ts only imports
 * `node:` builtins, `./types.js` (type-only), and `./client-map.js` (pure
 * data). It does NOT import claude-config back, so no cycle.
 *
 * History: this used `createRequire(import.meta.url).resolve(...)` to lazy-
 * load detect at call time. That pattern requires `require(esm)`, which is
 * flag-gated on Node 22.x before 22.12 (`--experimental-require-module`).
 * CI run 25877550371 on Node 22.5 silently failed every detect.* call —
 * the catch block ate the error and every cross-adapter deny-policy test
 * returned an empty policy list. Static import sidesteps the require(esm)
 * gate entirely, so the same code works on every supported Node version
 * (20.x, 22.5, 22.12+, 24+) without needing the experimental flag.
 *
 * For non-Pi hosts the returned array is deduplicated and order-stable:
 * adapter-specific path first (most specific), Claude global second. Pi
 * receives one path only.
 */
export function resolveAdapterGlobalSettingsPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = detectPlatform().platform,
  home: string = homedir(),
): string[] {
  // Pi is an extension-owned integration. It must never consult Claude's
  // global settings or the generic ~/.pi/settings.json file.
  if (platform === "pi") {
    return [resolvePiGlobalSettingsPath(home)];
  }

  const paths: string[] = [];

  if (platform !== "claude-code") {
    const segments = getSessionDirSegments(platform);
    if (segments && segments.length > 0) {
      paths.push(resolve(home, ...segments, "settings.json"));
    }
  }

  // Non-Pi hosts retain the Claude global fallback (defense in depth).
  const claudePath = resolveClaudeGlobalSettingsPath(env);
  if (!paths.includes(claudePath)) {
    paths.push(claudePath);
  }

  return paths;
}
