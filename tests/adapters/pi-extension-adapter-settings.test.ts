import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadExtensionAdapterSettings, normalizeExtensionAdapterSettings } from "../../src/adapters/pi/extension-adapter-settings.js";
const config = (enabled: unknown) => ({ extensionAdapters: { blackhole: { enabled } } });
describe("Pi extension adapter settings", () => {
  it("defaults off and merges only explicit project fields", () => {
    const warn = vi.fn();
    expect(normalizeExtensionAdapterSettings([], warn)).toBe(false);
    expect(normalizeExtensionAdapterSettings([config(true), {}], warn)).toBe(true);
    expect(normalizeExtensionAdapterSettings([config(true), config(false)], warn)).toBe(false);
    expect(normalizeExtensionAdapterSettings([config(false), config(true)], warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([null, [], { extensionAdapters: null }, { extensionAdapters: { blackhole: [] } }, config("true"), config(null), config(1)])("invalid explicit input fails closed: %j", value => {
    const warn = vi.fn();
    expect(normalizeExtensionAdapterSettings([value, config(true)], warn)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
  it("ignores other extension entries and the retired recovery namespace", () => {
    const warn = vi.fn();
    expect(normalizeExtensionAdapterSettings([{ extensionAdapters: { other: { enabled: true } } }], warn)).toBe(false);
    expect(normalizeExtensionAdapterSettings([{ recovery: { blackhole: { enabled: true } } }], warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
  it("loads only Pi context-mode settings, treats ENOENT as absence and malformed/unreadable files as invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-extension-adapter-settings-"));
    const home = join(dir, "home"), project = join(dir, "project");
    const put = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
    const warn = vi.fn();
    try {
      put(join(home, ".pi/agent/settings.json"), JSON.stringify(config(true)));
      put(join(project, ".claude/settings.json"), JSON.stringify(config(true)));
      put(join(project, ".pi/settings.json"), JSON.stringify(config(true)));
      expect(loadExtensionAdapterSettings(project, warn, home)).toBe(false);
      put(join(home, ".pi/agent/context-mode/settings.json"), JSON.stringify(config(true)));
      expect(loadExtensionAdapterSettings(project, warn, home)).toBe(true);
      const local = join(project, ".pi/context-mode/settings.json");
      put(local, JSON.stringify(config(false)));
      expect(loadExtensionAdapterSettings(project, warn, home)).toBe(false);
      put(local, "{");
      expect(loadExtensionAdapterSettings(project, warn, home)).toBe(false);
      rmSync(local); mkdirSync(local);
      expect(loadExtensionAdapterSettings(project, warn, home)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
