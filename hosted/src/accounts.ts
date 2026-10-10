// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";

export type Account = { user_id: string; epoch: number; deleted: number };

/** A journal path and generation are controlled by verified account identity only. */
export class Accounts {
  readonly db: Database.Database;
  private locks = new Map<string, Promise<void>>();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new Database(join(directory, "control.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec("CREATE TABLE IF NOT EXISTS accounts (user_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0)");
    chmodSync(join(directory, "control.db"), 0o600);
  }
  get(userId: string): Account {
    this.db.prepare("INSERT OR IGNORE INTO accounts(user_id) VALUES (?)").run(userId);
    return this.db.prepare("SELECT * FROM accounts WHERE user_id = ?").get(userId) as Account;
  }
  path(userId: string): string {
    return join(this.directory, `journal-${createHash("sha256").update(userId).digest("hex")}.db`);
  }
  invalidate(userId: string): void {
    this.get(userId);
    this.db.prepare("UPDATE accounts SET epoch = epoch + 1 WHERE user_id = ?").run(userId);
  }
  delete(userId: string): void {
    this.invalidate(userId); // Fail closed even if removing the file fails.
    this.db.prepare("UPDATE accounts SET deleted = 1 WHERE user_id = ?").run(userId);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(this.path(userId) + suffix, { force: true });
  }
  recreate(userId: string): void {
    if (!this.get(userId).deleted) throw new Error("The journal already exists");
    this.db.prepare("UPDATE accounts SET deleted = 0, epoch = epoch + 1 WHERE user_id = ?").run(userId);
  }
  /** Deletion, disconnection, and requests to the same journal cannot overtake each other. */
  async locked<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(r => { release = r; });
    this.locks.set(userId, current);
    await previous;
    try { return await fn(); }
    finally { release(); if (this.locks.get(userId) === current) this.locks.delete(userId); }
  }
  close(): void { this.db.close(); }
}
