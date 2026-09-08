import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolvePiGlobalSettingsPath, resolveProjectSettingsPaths } from "../../util/claude-config.js";

export interface ToolReplacementSettings {
  bash: { enabled: boolean };
  read: { enabled: boolean; maxLines: number; maxBytes: number };
}

export const DEFAULT_READ_LIMITS = { maxLines: 300, maxBytes: 10_240 } as const;
export type ReplacementWarning = (message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One decoder for field-wise global < project precedence. Invalid explicit
 * values fail closed for that feature, including invalid lower-priority values.
 */
export function normalizeToolReplacements(
  settings: readonly unknown[],
  warn: ReplacementWarning,
): ToolReplacementSettings {
  const result: ToolReplacementSettings = {
    bash: { enabled: false },
    read: { enabled: false, ...DEFAULT_READ_LIMITS },
  };
  const invalid = new Set<"bash" | "read">();
  for (const document of settings) {
    if (!isRecord(document)) {
      warn("Invalid context-mode settings object; Bash and Read replacements disabled.");
      invalid.add("bash");
      invalid.add("read");
      continue;
    }
    if (!("toolReplacements" in document)) continue;
    const section = document.toolReplacements;
    if (!isRecord(section)) {
      warn("Invalid toolReplacements object; Bash and Read replacements disabled.");
      invalid.add("bash");
      invalid.add("read");
      continue;
    }
    for (const feature of ["bash", "read"] as const) {
      if (!(feature in section)) continue;
      const value = section[feature];
      if (!isRecord(value)) {
        invalid.add(feature);
        warn(`Invalid toolReplacements.${feature}; replacement disabled.`);
        continue;
      }
      if ("enabled" in value) {
        if (typeof value.enabled === "boolean") result[feature].enabled = value.enabled;
        else {
          invalid.add(feature);
          warn(`Invalid toolReplacements.${feature}.enabled (expected boolean); replacement disabled.`);
        }
      }
      if (feature === "read") {
        for (const key of ["maxLines", "maxBytes"] as const) {
          if (!(key in value)) continue;
          const cap = value[key];
          if (typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0) result.read[key] = cap;
          else {
            invalid.add(feature);
            warn(`Invalid toolReplacements.read.${key} (expected positive safe integer); Read replacement disabled.`);
          }
        }
      }
    }
  }
  for (const feature of invalid) result[feature].enabled = false;
  return result;
}

/** Read only context-mode's Pi settings, never Pi/Claude/Trellis settings. */
export function loadToolReplacementSettings(
  projectDir: string,
  warn: ReplacementWarning,
  home: string = homedir(),
): ToolReplacementSettings {
  const documents: unknown[] = [];
  for (const path of [resolvePiGlobalSettingsPath(home), ...resolveProjectSettingsPaths(projectDir, "pi")]) {
    try {
      documents.push(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      warn(`Cannot read context-mode settings ${path}; replacements disabled (${error instanceof Error ? error.message : String(error)}).`);
      // Unknown configuration cannot safely opt in, even if another tier enables it.
      documents.push(null);
    }
  }
  return normalizeToolReplacements(documents, warn);
}
