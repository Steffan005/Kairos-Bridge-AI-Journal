// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

declare const leaseBrand: unique symbol;
/** Callable release handle. Only acquireDataLease can create a valid held capability. */
export interface DataLease { (): void; readonly [leaseBrand]: true }
const heldLeases = new WeakMap<DataLease, { directory: string; held: boolean }>();

export function assertHeldDataLease(lease: DataLease, directory: string): void {
  const state = heldLeases.get(lease);
  if (!state?.held || state.directory !== realpathSync(directory)) throw new Error("Recovery requires the held lease for this data directory");
}

/** SQLite's OS lock excludes cooperating writers and is released on process exit. */
export function acquireDataLease(directory: string): DataLease {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, ".kairos-data-lease.db");
  const db = new Database(path);
  try {
    chmodSync(path, 0o600);
    db.pragma("busy_timeout = 0");
    db.pragma("journal_mode = DELETE");
    db.exec("CREATE TABLE IF NOT EXISTS lease_guard(id INTEGER PRIMARY KEY CHECK(id=1)); BEGIN EXCLUSIVE");
  } catch { db.close(); throw new Error("Kairos data is leased or its maintenance lock is invalid. Stop the service before offline maintenance; never delete a live lock file."); }
  const state = { directory: realpathSync(directory), held: true };
  const release = (() => {
    if (!state.held) return;
    try { db.exec("ROLLBACK"); } finally { db.close(); state.held = false; }
  }) as DataLease;
  heldLeases.set(release, state);
  return release;
}
