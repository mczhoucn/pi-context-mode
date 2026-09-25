/**
 * A quiet WAL is not a dead owner. getStore() runs cleanupStaleContentDBs
 * on every new server. Deleting a DB another live server still has open
 * makes that server's later queries throw SQLite "disk I/O error".
 */

import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, utimesSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore, cleanupStaleContentDBs } from "../src/store.js";

const dirs: string[] = [];
const stores: ContentStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* connection may already be poisoned */ }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cleanupStaleContentDBs live database", () => {
  test("does not unlink a database whose WAL has been quiet for over an hour", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-live-db-"));
    dirs.push(dir);
    const dbPath = join(dir, "project.db");
    const store = new ContentStore(dbPath);
    stores.push(store);
    store.index({ content: "# Kept\n\nstill queryable", source: "live" });

    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).size).toBeGreaterThan(0);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(dbPath, twoHoursAgo, twoHoursAgo);
    utimesSync(walPath, twoHoursAgo, twoHoursAgo);

    const cleaned = cleanupStaleContentDBs(dir, 14);

    expect(cleaned).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(walPath)).toBe(true);
    expect(store.search("queryable", 5).length).toBeGreaterThan(0);
  });
});
