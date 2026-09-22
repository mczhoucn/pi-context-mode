import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolvePiGlobalSettingsPath, resolveProjectSettingsPaths } from "../../util/claude-config.js";
import { ADMINISTRATIVE_CTX_TOOL_NAMES, CTX_TOOL_NAMES } from "../../ctx-tool-catalog.js";

/**
 * Pi built-in feature suppression.
 *
 * The five administrative ctx_* operations exist for a human at the terminal.
 * Asking an agent's model to pay for their schemas in every session is a host
 * policy decision, so this fork expresses it as configuration instead of
 * filtering the shared MCP registry: the MCP server keeps its full catalog and
 * the Pi adapter decides what the Pi agent may see and call.
 */
export interface BuiltinFeatureSettings {
  /** Exact ctx_* tool names hidden from Pi's agent-facing tool catalog. */
  readonly disabledTools: readonly string[];
  /** True when post-compaction recovery preparation/injection is disabled. */
  readonly compactRecoveryDisabled: boolean;
}

/** Administrative tools stay hidden from Pi agents unless explicitly re-enabled. */
export const DEFAULT_DISABLED_BUILTIN_FEATURES: readonly string[] = [...ADMINISTRATIVE_CTX_TOOL_NAMES];

/** Feature id that suppresses context-mode's own post-compaction recovery. */
export const COMPACT_RECOVERY_FEATURE = "compactRecovery";

/** Every feature id this setting accepts: the ctx_* tools plus recovery. */
const KNOWN_FEATURES: ReadonlySet<string> = new Set<string>([
  ...CTX_TOOL_NAMES,
  COMPACT_RECOVERY_FEATURE,
]);

export type BuiltinFeatureWarning = (message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defaults: administrative tools hidden, post-compaction recovery enabled. */
export function defaultBuiltinFeatureSettings(): BuiltinFeatureSettings {
  return {
    disabledTools: [...DEFAULT_DISABLED_BUILTIN_FEATURES],
    compactRecoveryDisabled: false,
  };
}

/**
 * One decoder for the `disabledBuiltinFeatures` list with global < project
 * precedence. The field is replaced wholesale by the higher-priority tier —
 * unlike `toolReplacements`, there is no per-entry merge, because an explicit
 * list is a complete statement of what the host wants hidden.
 *
 * Invalid explicit configuration in either tier fails closed to the defaults,
 * so a typo can neither expose the administrative tools nor silently disable
 * post-compaction recovery.
 */
export function normalizeBuiltinFeatureSettings(
  documents: readonly unknown[],
  warn: BuiltinFeatureWarning,
): BuiltinFeatureSettings {
  let configured: string[] | undefined;
  let invalid = false;

  for (const document of documents) {
    // `null` is the loader's sentinel for a settings file it already reported
    // as unreadable, so the path is named exactly once. Any OTHER non-object is
    // a genuinely wrong-shaped document this decoder must not swallow silently:
    // valid JSON such as `[]` or `"ctx_stats"` is a user error worth a warning.
    if (document === null) {
      invalid = true;
      continue;
    }
    if (!isRecord(document)) {
      warn("Invalid context-mode settings object; using default disabledBuiltinFeatures.");
      invalid = true;
      continue;
    }
    if (!("disabledBuiltinFeatures" in document)) continue;
    const value = document.disabledBuiltinFeatures;
    if (!Array.isArray(value)) {
      warn("Invalid disabledBuiltinFeatures (expected an array of feature names); using defaults.");
      invalid = true;
      continue;
    }

    const unknown: string[] = [];
    let nonString = false;
    for (const entry of value) {
      if (typeof entry !== "string") {
        nonString = true;
        break;
      }
      if (!KNOWN_FEATURES.has(entry)) unknown.push(entry);
    }
    if (nonString) {
      warn("Invalid disabledBuiltinFeatures entry (expected feature names); using defaults.");
      invalid = true;
      continue;
    }
    if (unknown.length > 0) {
      warn(`Unknown disabledBuiltinFeatures entries (${unknown.join(", ")}); using defaults.`);
      invalid = true;
      continue;
    }

    configured = [...new Set(value)];
  }

  if (invalid || configured === undefined) return defaultBuiltinFeatureSettings();
  return {
    disabledTools: configured.filter((feature) => feature !== COMPACT_RECOVERY_FEATURE),
    compactRecoveryDisabled: configured.includes(COMPACT_RECOVERY_FEATURE),
  };
}

/** Read only context-mode's Pi settings, never Pi/Claude/Trellis settings. */
export function loadBuiltinFeatureSettings(
  projectDir: string,
  warn: BuiltinFeatureWarning,
  home: string = homedir(),
): BuiltinFeatureSettings {
  const documents: unknown[] = [];
  for (const path of [resolvePiGlobalSettingsPath(home), ...resolveProjectSettingsPaths(projectDir, "pi")]) {
    try {
      documents.push(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      warn(
        `Cannot read context-mode settings ${path}; disabledBuiltinFeatures ignored ` +
          `(${error instanceof Error ? error.message : String(error)}).`,
      );
      documents.push(null);
    }
  }
  return normalizeBuiltinFeatureSettings(documents, warn);
}
