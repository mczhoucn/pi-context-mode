import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolvePiGlobalSettingsPath, resolveProjectSettingsPaths } from "../../util/claude-config.js";
import type { TidyToolDisplaySettings } from "./tidy-tool-display.js";

export type TidyDisplayWarning = (message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Field-wise global < project precedence for this switch only.
 * An invalid explicit value fails closed even if another tier is valid.
 * This decoder never changes Bash/Read replacement state.
 */
export function normalizeTidyToolDisplay(
  settings: readonly unknown[],
  warn: TidyDisplayWarning,
): TidyToolDisplaySettings {
  let enabled = false;
  let invalid = false;
  for (const document of settings) {
    if (!isRecord(document)) {
      warn("Invalid context-mode settings object; tidy tool display disabled.");
      invalid = true;
      continue;
    }
    if (!("tidyToolDisplay" in document)) continue;
    const section = document.tidyToolDisplay;
    if (!isRecord(section)) {
      warn("Invalid tidyToolDisplay object; tidy tool display disabled.");
      invalid = true;
      continue;
    }
    if (!("enabled" in section)) continue;
    if (typeof section.enabled === "boolean") enabled = section.enabled;
    else {
      warn("Invalid tidyToolDisplay.enabled (expected boolean); tidy tool display disabled.");
      invalid = true;
    }
  }
  return { enabled: invalid ? false : enabled };
}

/** Read only context-mode's Pi settings, never Pi/Claude/Trellis or tidy settings. */
export function loadTidyToolDisplaySettings(
  projectDir: string,
  warn: TidyDisplayWarning,
  home: string = homedir(),
): TidyToolDisplaySettings {
  const documents: unknown[] = [];
  for (const path of [resolvePiGlobalSettingsPath(home), ...resolveProjectSettingsPaths(projectDir, "pi")]) {
    try {
      documents.push(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      warn(`Cannot read context-mode settings ${path}; tidy tool display disabled (${error instanceof Error ? error.message : String(error)}).`);
      documents.push(null);
    }
  }
  return normalizeTidyToolDisplay(documents, warn);
}
