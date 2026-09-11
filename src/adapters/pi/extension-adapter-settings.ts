import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolvePiGlobalSettingsPath, resolveProjectSettingsPaths } from "../../util/claude-config.js";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Per-extension adaptation switches; `blackhole` is the only entry today.
 * Invalid explicit configuration in either tier disables trimming, never recovery. */
export function normalizeExtensionAdapterSettings(documents: readonly unknown[], warn: (message: string) => void): boolean {
  let enabled = false;
  let invalid = false;
  for (const document of documents) {
    let value: unknown = document;
    for (const key of ["extensionAdapters", "blackhole", "enabled"]) {
      if (!record(value)) { invalid = true; break; }
      if (!(key in value)) { value = undefined; break; }
      value = value[key];
      if (key === "enabled") {
        if (typeof value === "boolean") enabled = value;
        else invalid = true;
      }
    }
  }
  if (invalid) warn("Invalid context-mode extensionAdapters.blackhole.enabled configuration; trimming disabled.");
  return !invalid && enabled;
}

export function loadExtensionAdapterSettings(projectDir: string, warn: (message: string) => void, home = homedir()): boolean {
  const documents: unknown[] = [];
  for (const path of [resolvePiGlobalSettingsPath(home), ...resolveProjectSettingsPaths(projectDir, "pi")]) {
    try { documents.push(JSON.parse(readFileSync(path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") documents.push(null);
    }
  }
  return normalizeExtensionAdapterSettings(documents, warn);
}
