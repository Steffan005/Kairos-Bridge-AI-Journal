// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** SQLite's OS lock excludes cooperating writers and is released on process exit. */
export function acquireDataLease(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, ".kairos-data-lease.db");
  const db = new Database(path);
  try {
    chmodSync(path, 0o600);
    db.pragma("busy_timeout = 0");
    db.pragma("journal_mode = DELETE");
    db.exec("CREATE TABLE IF NOT EXISTS lease_guard(id INTEGER PRIMARY KEY CHECK(id=1)); BEGIN EXCLUSIVE");
  } catch { db.close(); throw new Error("Kairos data is leased or its maintenance lock is invalid. Stop the service before offline maintenance; never delete a live lock file."); }
  let released = false;
  return () => {
    if (released) return;
    try { db.exec("ROLLBACK"); } finally { db.close(); released = true; }
  };
}
