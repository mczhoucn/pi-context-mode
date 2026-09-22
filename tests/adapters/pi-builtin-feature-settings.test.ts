import "../setup-home";
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  COMPACT_RECOVERY_FEATURE,
  DEFAULT_DISABLED_BUILTIN_FEATURES,
  defaultBuiltinFeatureSettings,
  loadBuiltinFeatureSettings,
  normalizeBuiltinFeatureSettings,
} from "../../src/adapters/pi/builtin-feature-settings.js";

const asDocument = (features: unknown) => ({ disabledBuiltinFeatures: features });
const normalize = (documents: readonly unknown[]) => normalizeBuiltinFeatureSettings(documents, vi.fn());

describe("Pi builtin feature settings", () => {
  it("hides the five administrative tools and keeps compaction recovery on by default", () => {
    expect(defaultBuiltinFeatureSettings()).toEqual({
      disabledTools: [...DEFAULT_DISABLED_BUILTIN_FEATURES],
      compactRecoveryDisabled: false,
    });
    expect(normalize([])).toEqual(defaultBuiltinFeatureSettings());
    expect(normalize([{}, { toolReplacements: { bash: { enabled: true } } }])).toEqual(defaultBuiltinFeatureSettings());
  });

  it("classifies every supported feature id into the right channel", () => {
    const result = normalize([asDocument(["ctx_stats", COMPACT_RECOVERY_FEATURE, "ctx_purge"])]);
    expect(result.disabledTools).toEqual(["ctx_stats", "ctx_purge"]);
    expect(result.compactRecoveryDisabled).toBe(true);
  });

  it("treats an explicit project list as a complete replacement of the global list", () => {
    expect(normalize([asDocument([])])).toEqual({ disabledTools: [], compactRecoveryDisabled: false });
    expect(normalize([asDocument(["ctx_doctor"]), asDocument([])])).toEqual({
      disabledTools: [],
      compactRecoveryDisabled: false,
    });
    expect(normalize([asDocument([]), asDocument(["ctx_search"])])).toEqual({
      disabledTools: ["ctx_search"],
      compactRecoveryDisabled: false,
    });
    // A document without the field must not erase a lower tier's value.
    expect(normalize([asDocument([COMPACT_RECOVERY_FEATURE]), {}])).toEqual({
      disabledTools: [],
      compactRecoveryDisabled: true,
    });
  });

  it("accepts an agent-facing tool name so hosts can narrow the exposed set", () => {
    expect(normalize([asDocument(["ctx_execute", "ctx_search"])])).toEqual({
      disabledTools: ["ctx_execute", "ctx_search"],
      compactRecoveryDisabled: false,
    });
  });

  it("deduplicates repeated entries", () => {
    expect(normalize([asDocument(["ctx_stats", "ctx_stats", COMPACT_RECOVERY_FEATURE])])).toEqual({
      disabledTools: ["ctx_stats"],
      compactRecoveryDisabled: true,
    });
  });

  it.each([
    ["non-array", { disabledBuiltinFeatures: "ctx_stats" }],
    ["null field", { disabledBuiltinFeatures: null }],
    ["object field", { disabledBuiltinFeatures: { ctx_stats: true } }],
    ["non-string entry", { disabledBuiltinFeatures: ["ctx_stats", 1] }],
    ["null entry", { disabledBuiltinFeatures: [null] }],
    ["unknown entry", { disabledBuiltinFeatures: ["ctx_stats", "nope"] }],
    ["misspelled entry", { disabledBuiltinFeatures: ["ctxStats"] }],
  ])("fails closed to the defaults on %s", (_label, document) => {
    const warn = vi.fn();
    const result = normalizeBuiltinFeatureSettings([document, { disabledBuiltinFeatures: [] }], warn);
    expect(result).toEqual(defaultBuiltinFeatureSettings());
    expect(warn).toHaveBeenCalledOnce();
  });

  it("fails closed on an unreadable settings document without double-reporting", () => {
    // The loader reports the unreadable path and passes `null` as the sentinel,
    // so the decoder must fail closed silently rather than warn twice.
    const warn = vi.fn();
    expect(normalizeBuiltinFeatureSettings([null], warn)).toEqual(defaultBuiltinFeatureSettings());
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["[]", "\"ctx_stats\"", "42", "true"]) (
    "warns and fails closed on a valid-JSON wrong-shaped document: %s",
    (json) => {
      // Distinct from the `null` sentinel: the loader never reported this path,
      // so the decoder itself must surface it. Silently ignoring a stray array
      // would leave the user believing their configuration was applied.
      const warn = vi.fn();
      const result = normalizeBuiltinFeatureSettings([JSON.parse(json)], warn);
      expect(result).toEqual(defaultBuiltinFeatureSettings());
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it("warns about unknown entries instead of silently ignoring them", () => {
    const warn = vi.fn();
    normalizeBuiltinFeatureSettings([asDocument(["ctx_sats"])], warn);
    expect(warn.mock.calls[0][0]).toContain("ctx_sats");
  });

  it("loads only Pi context-mode settings, treats ENOENT as absence, and reports unreadable files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-builtin-features-"));
    const home = join(dir, "home");
    const project = join(dir, "project");
    const put = (path: string, body: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    };
    const warn = vi.fn();
    try {
      // Paths the extension must NOT read for this feature.
      put(join(home, ".pi/agent/settings.json"), JSON.stringify(asDocument([])));
      put(join(project, ".pi/settings.json"), JSON.stringify(asDocument([])));
      put(join(project, ".claude/settings.json"), JSON.stringify(asDocument([])));
      expect(loadBuiltinFeatureSettings(project, warn, home)).toEqual(defaultBuiltinFeatureSettings());

      put(join(home, ".pi/agent/context-mode/settings.json"), JSON.stringify(asDocument([COMPACT_RECOVERY_FEATURE])));
      expect(loadBuiltinFeatureSettings(project, warn, home)).toEqual({
        disabledTools: [],
        compactRecoveryDisabled: true,
      });

      const local = join(project, ".pi/context-mode/settings.json");
      put(local, JSON.stringify(asDocument(["ctx_purge"])));
      expect(loadBuiltinFeatureSettings(project, warn, home)).toEqual({
        disabledTools: ["ctx_purge"],
        compactRecoveryDisabled: false,
      });

      put(local, "{");
      expect(loadBuiltinFeatureSettings(project, warn, home)).toEqual(defaultBuiltinFeatureSettings());
      expect(warn).toHaveBeenCalledOnce();

      // A directory where a file is expected is an unreadable settings source.
      rmSync(local);
      mkdirSync(local);
      expect(loadBuiltinFeatureSettings(project, warn, home)).toEqual(defaultBuiltinFeatureSettings());
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the default global path from homedir() when no home is injected", () => {
    const warn = vi.fn();
    // No settings exist under the suite-wide fake HOME: defaults must apply
    // without touching the developer's real Pi configuration.
    expect(loadBuiltinFeatureSettings(join(homedir(), "nonexistent-project"), warn)).toEqual(
      defaultBuiltinFeatureSettings(),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
