import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolvePiGlobalSettingsPath, resolveProjectSettingsPaths } from "../../util/claude-config.js";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Invalid explicit configuration in either tier disables trimming, never recovery. */
export function normalizeRecoverySettings(documents: readonly unknown[], warn: (message: string) => void): boolean {
  let enabled = false;
  let invalid = false;
  for (const document of documents) {
    let value: unknown = document;
    for (const key of ["recovery", "blackhole", "enabled"]) {
      if (!record(value)) { invalid = true; break; }
      if (!(key in value)) { value = undefined; break; }
      value = value[key];
      if (key === "enabled") {
        if (typeof value === "boolean") enabled = value;
        else invalid = true;
      }
    }
  }
  if (invalid) warn("Invalid context-mode recovery.blackhole.enabled configuration; trimming disabled.");
  return !invalid && enabled;
}

export function loadRecoverySettings(projectDir: string, warn: (message: string) => void, home = homedir()): boolean {
  const documents: unknown[] = [];
  for (const path of [resolvePiGlobalSettingsPath(home), ...resolveProjectSettingsPaths(projectDir, "pi")]) {
    try { documents.push(JSON.parse(readFileSync(path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") documents.push(null);
    }
  }
  return normalizeRecoverySettings(documents, warn);
}
