import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadRecoverySettings, normalizeRecoverySettings } from "../../src/adapters/pi/recovery-settings.js";
const config = (enabled: unknown) => ({ recovery: { blackhole: { enabled } } });
describe("Pi recovery settings", () => {
  it("defaults off and merges only explicit project fields", () => {
    const warn = vi.fn();
    expect(normalizeRecoverySettings([], warn)).toBe(false);
    expect(normalizeRecoverySettings([config(true), {}], warn)).toBe(true);
    expect(normalizeRecoverySettings([config(true), config(false)], warn)).toBe(false);
    expect(normalizeRecoverySettings([config(false), config(true)], warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([null, [], { recovery: null }, { recovery: { blackhole: [] } }, config("true"), config(null), config(1)])("invalid explicit input fails closed: %j", value => {
    const warn = vi.fn();
    expect(normalizeRecoverySettings([value, config(true)], warn)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
  it("loads only Pi context-mode settings, treats ENOENT as absence and malformed/unreadable files as invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-recovery-settings-"));
    const home = join(dir, "home"), project = join(dir, "project");
    const put = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
    const warn = vi.fn();
    try {
      put(join(home, ".pi/agent/settings.json"), JSON.stringify(config(true)));
      put(join(project, ".claude/settings.json"), JSON.stringify(config(true)));
      put(join(project, ".pi/settings.json"), JSON.stringify(config(true)));
      expect(loadRecoverySettings(project, warn, home)).toBe(false);
      put(join(home, ".pi/agent/context-mode/settings.json"), JSON.stringify(config(true)));
      expect(loadRecoverySettings(project, warn, home)).toBe(true);
      const local = join(project, ".pi/context-mode/settings.json");
      put(local, JSON.stringify(config(false)));
      expect(loadRecoverySettings(project, warn, home)).toBe(false);
      put(local, "{");
      expect(loadRecoverySettings(project, warn, home)).toBe(false);
      rmSync(local); mkdirSync(local);
      expect(loadRecoverySettings(project, warn, home)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
