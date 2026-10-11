// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Journal, SCHEMA_VERSION } from "../../src/journal.js";
import { acquireDataLease } from "./dataLease.js";
import type { Account } from "./accounts.js";

const AUTH_SCHEMA = "better-auth-1.7.7";
const AUTH_TABLES = ["account", "jwks", "kairos_auth_schema", "oauthAccessToken", "oauthClient", "oauthClientAssertion", "oauthClientResource", "oauthConsent", "oauthRefreshToken", "oauthResource", "session", "user", "verification"];
const CLEAR_ON_RESTORE = ["session", "oauthAccessToken", "oauthRefreshToken", "oauthConsent", "verification", "oauthClientAssertion", "jwks"];
const DB_NAME = /^(?:auth|control|journal-[a-f0-9]{64})\.db$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const journalName = (id: string): string => `journal-${digest(id)}.db`;

type Description = { users: string[]; accounts: Account[]; journals: Array<{ name: string; count: number; head: string }> };
type FileRecord = { name: string; sha256: string; bytes: number };
export type BackupManifest = Description & {
  format: "kairos-offline-backup-v1"; id: string; captured_at: string; source_revision: string;
  auth_schema: string; journal_schema: number; files: FileRecord[];
};
export type DeletionWitness = {
  format: "kairos-deletion-witness-v1"; id: string; captured_at: string; accounts: Account[]; users: string[];
};
export type RestoreReceipt = {
  format: "kairos-controlled-restore-v1"; backup_id: string; witness_id: string; witness_sha256: string;
  restored_at: string; reauthorization_required: true; discarded_deleted_journals: number;
  accounts: number; journals: number; entries: number;
  limits: string;
};

function fail(message: string): never { throw new Error(message); }
function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function checkDirectory(path: string): string {
  if (!isAbsolute(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail("Use an existing absolute data directory, not a symbolic link");
  return realpathSync(path);
}
function destination(path: string, source: string): string {
  if (!isAbsolute(path)) fail("Use an absolute output path");
  const parent = realpathSync(dirname(path));
  const out = join(parent, basename(path));
  if (isWithin(source, out)) fail("Keep maintenance output outside the service data directory");
  if (existsSync(out)) fail("Maintenance refuses to overwrite an existing output");
  return out;
}
function ordinaryFile(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Recovery accepts ordinary files only");
  return stat.size;
}
function fileBytes(path: string): Buffer {
  if (ordinaryFile(path) > 16 * 1024 * 1024) fail("Recovery metadata is too large");
  return readFileSync(path);
}
function fileDigest(path: string): FileRecord {
  const bytes = ordinaryFile(path), hash = createHash("sha256"), fd = openSync(path, "r"), buffer = Buffer.alloc(64 * 1024);
  try { for (;;) { const n = readSync(fd, buffer); if (!n) break; hash.update(buffer.subarray(0, n)); } }
  finally { closeSync(fd); }
  return { name: basename(path), bytes, sha256: hash.digest("hex") };
}
function syncFile(path: string): void {
  chmodSync(path, 0o600);
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readDB(path: string): Database.Database {
  ordinaryFile(path); // Reject symlinks before SQLite follows the path.
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") fail("SQLite integrity check failed");
    return db;
  } catch (error) { db.close(); throw error; }
}
function checkAccounts(value: unknown): Account[] {
  if (!Array.isArray(value)) fail("Invalid account inventory");
  const seen = new Set<string>();
  for (const a of value) {
    if (!a || typeof a.user_id !== "string" || !a.user_id || seen.has(a.user_id)
      || !Number.isSafeInteger(a.epoch) || a.epoch < 1 || !Number.isSafeInteger(a.journal_generation) || a.journal_generation < 1
      || ![0, 1].includes(a.deleted)) fail("Invalid account generation or deletion inventory");
    seen.add(a.user_id);
  }
  return value as Account[];
}
function checkUsers(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v) || new Set(value).size !== value.length) fail("Invalid account identity inventory");
  return value as string[];
}
function describe(directory: string): Description {
  const auth = readDB(join(directory, "auth.db")), control = readDB(join(directory, "control.db"));
  let users: string[], accounts: Account[];
  try {
    const tables = (auth.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
    if (JSON.stringify(tables) !== JSON.stringify(AUTH_TABLES)) fail("Authentication schema changed; recovery requires an explicit migration");
    const versions = auth.prepare("SELECT version FROM kairos_auth_schema").all() as Array<{ version: string }>;
    if (versions.length !== 1 || versions[0].version !== AUTH_SCHEMA) fail("Unsupported authentication schema");
    const columns = (control.pragma("table_info(accounts)") as Array<{ name: string }>).map(c => c.name);
    if (JSON.stringify(columns) !== JSON.stringify(["user_id", "epoch", "deleted", "journal_generation"])) fail("Deletion generations are required; run the matching service migration before backup");
    users = checkUsers((auth.prepare('SELECT id FROM "user" ORDER BY id').all() as Array<{ id: string }>).map(u => u.id));
    accounts = checkAccounts(control.prepare("SELECT * FROM accounts ORDER BY user_id").all());
    if (accounts.some(a => !users.includes(a.user_id))) fail("Control and authentication accounts disagree");
  } finally { auth.close(); control.close(); }
  const owners = new Map(accounts.map(a => [journalName(a.user_id), a]));
  const journals: Description["journals"] = [];
  for (const name of readdirSync(directory).filter(n => /^journal-.*\.db$/.test(n)).sort()) {
    const owner = owners.get(name);
    if (!DB_NAME.test(name) || !owner || owner.deleted) fail("Journal inventory disagrees with active accounts");
    const db = readDB(join(directory, name)); db.close();
    const journal = Journal.openReadOnly(join(directory, name));
    try {
      const report = journal.verify();
      if (!report.ok) fail("A journal hash chain is broken");
      journals.push({ name, count: report.checked, head: report.headHash });
    } finally { journal.close(); }
  }
  return { users, accounts, journals };
}

/** The service must be stopped. All participating writers obey the same exclusive lease. */
export async function captureBackup(directory: string, output: string, sourceRevision: string): Promise<BackupManifest> {
  const source = checkDirectory(directory), target = destination(output, source);
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) fail("Record an exact 40-character source revision");
  const release = acquireDataLease(source);
  const work = mkdtempSync(join(dirname(target), ".kairos-backup-")); chmodSync(work, 0o700);
  try {
    const original = describe(source);
    const names = ["auth.db", "control.db", ...original.journals.map(j => j.name)];
    for (const name of names) {
      const db = readDB(join(source, name));
      try { await db.backup(join(work, name)); } finally { db.close(); }
      // A self-contained bundle uses rollback-journal mode. A WAL-mode header
      // can otherwise create sidecars even when a verifier opens it read-only.
      // Change only the private backup copy, never the service database.
      const copy = new Database(join(work, name));
      try { if (copy.pragma("journal_mode = DELETE", { simple: true }) !== "delete") fail("Backup could not become self-contained"); }
      finally { copy.close(); }
      syncFile(join(work, name));
    }
    const captured = describe(work);
    if (JSON.stringify(captured) !== JSON.stringify(original) || JSON.stringify(describe(source)) !== JSON.stringify(original)) fail("Data changed during backup; refusing to publish a mixed capture");
    const files = names.sort().map(name => fileDigest(join(work, name)));
    const manifest: BackupManifest = { format: "kairos-offline-backup-v1", id: randomUUID(), captured_at: new Date().toISOString(), source_revision: sourceRevision,
      auth_schema: AUTH_SCHEMA, journal_schema: SCHEMA_VERSION, ...captured, files };
    writeFileSync(join(work, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    syncFile(join(work, "manifest.json")); syncDirectory(work);
    if (existsSync(target)) fail("Backup destination appeared; refusing to replace it");
    renameSync(work, target); syncDirectory(dirname(target)); return manifest;
  } finally { rmSync(work, { recursive: true, force: true }); release(); }
}

/** Operator-selected deletion history, stored outside the data and backup being restored. Not an automatic trusted-head service. */
export function captureDeletionWitness(directory: string, output: string): { sha256: string; witness: DeletionWitness } {
  const source = checkDirectory(directory), target = destination(output, source), release = acquireDataLease(source);
  try {
    const state = describe(source);
    const witness: DeletionWitness = { format: "kairos-deletion-witness-v1", id: randomUUID(), captured_at: new Date().toISOString(), accounts: state.accounts, users: state.users };
    const bytes = JSON.stringify(witness, null, 2) + "\n";
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 }); syncFile(target); syncDirectory(dirname(target));
    return { sha256: digest(bytes), witness };
  } finally { release(); }
}

/** Builds a new private directory only. Never modifies a running service or a selected backup. */
export function restoreBackup(options: { backup: string; output: string; witness: string; expectedWitnessSha256: string }): RestoreReceipt {
  const backup = checkDirectory(options.backup), target = destination(options.output, backup);
  if (!isAbsolute(options.witness) || !HASH.test(options.expectedWitnessSha256)) fail("A separately trusted deletion witness and its selected hash are required");
  const witnessPath = realpathSync(dirname(options.witness));
  if (isWithin(backup, join(witnessPath, basename(options.witness)))) fail("Deletion witness must be outside the backup being restored");
  const witnessBytes = fileBytes(options.witness);
  if (digest(witnessBytes) !== options.expectedWitnessSha256) fail("Deletion witness does not match the operator-selected hash");
  const witness = JSON.parse(witnessBytes.toString()) as DeletionWitness;
  if (witness.format !== "kairos-deletion-witness-v1") fail("Unsupported deletion witness");
  checkAccounts(witness.accounts); checkUsers(witness.users);
  const manifest = JSON.parse(fileBytes(join(backup, "manifest.json")).toString()) as BackupManifest;
  if (manifest.format !== "kairos-offline-backup-v1" || manifest.auth_schema !== AUTH_SCHEMA || manifest.journal_schema !== SCHEMA_VERSION) fail("Unsupported backup schema");
  const captured = Date.parse(manifest.captured_at), witnessed = Date.parse(witness.captured_at);
  if (!Number.isFinite(captured) || !Number.isFinite(witnessed) || witnessed < captured) fail("The deletion witness predates this backup");
  if (!Array.isArray(manifest.files) || !manifest.files.every(f => DB_NAME.test(f.name) && HASH.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes > 0)) fail("Invalid backup file inventory");
  const expected = manifest.files.map(f => f.name).sort();
  if (new Set(expected).size !== expected.length || !expected.includes("auth.db") || !expected.includes("control.db")) fail("Incomplete backup inventory");
  if (JSON.stringify(readdirSync(backup).sort()) !== JSON.stringify([...expected, "manifest.json"].sort())) fail("Backup is incomplete or contains unexpected files");
  for (const f of manifest.files) {
    const measured = fileDigest(join(backup, f.name));
    if (measured.bytes !== f.bytes || measured.sha256 !== f.sha256) fail("Backup file integrity failed");
  }
  const original = describe(backup);
  if (JSON.stringify(original) !== JSON.stringify({ users: manifest.users, accounts: manifest.accounts, journals: manifest.journals })) fail("Manifest disagrees with captured state");
  if (JSON.stringify(original.users) !== JSON.stringify(witness.users)) fail("Accounts changed since backup; an explicit account-recovery plan is required");
  const current = new Map(witness.accounts.map(a => [a.user_id, a]));
  for (const a of original.accounts) {
    const latest = current.get(a.user_id);
    if (!latest || latest.epoch < a.epoch || latest.journal_generation < a.journal_generation) fail("Deletion witness is missing or older than an account");
    if (!latest.deleted && latest.journal_generation !== a.journal_generation) fail("A journal was deleted and recreated after backup; refusing to revive its earlier contents");
    if (a.deleted && !latest.deleted) fail("A deleted journal changed after backup; explicit recovery is required");
  }
  if (witness.accounts.some(a => !witness.users.includes(a.user_id))) fail("Deletion witness has unknown accounts");
  const work = mkdtempSync(join(dirname(target), ".kairos-restore-")); chmodSync(work, 0o700);
  try {
    for (const f of manifest.files) {
      copyFileSync(join(backup, f.name), join(work, f.name)); syncFile(join(work, f.name));
      const measured = fileDigest(join(work, f.name));
      if (measured.bytes !== f.bytes || measured.sha256 !== f.sha256) fail("Backup changed while copying; refusing to publish a restore");
    }
    const auth = new Database(join(work, "auth.db"));
    try {
      auth.transaction(() => { for (const table of CLEAR_ON_RESTORE) auth.exec(`DELETE FROM "${table}"`); })();
      // New process startup provisions fresh keys. Do not retain an old pinned resource key.
      auth.exec("UPDATE oauthResource SET signingKeyId = NULL");
    } finally { auth.close(); }
    const control = new Database(join(work, "control.db")); let discarded = 0;
    try {
      control.transaction(() => {
        const put = control.prepare("INSERT INTO accounts(user_id,epoch,deleted,journal_generation) VALUES (@user_id,@epoch,@deleted,@journal_generation) ON CONFLICT(user_id) DO UPDATE SET epoch=excluded.epoch,deleted=excluded.deleted,journal_generation=excluded.journal_generation");
        for (const a of witness.accounts) {
          if (a.epoch === Number.MAX_SAFE_INTEGER) fail("Access generation is exhausted");
          put.run({ ...a, epoch: a.epoch + 1 });
          if (a.deleted && existsSync(join(work, journalName(a.user_id)))) { rmSync(join(work, journalName(a.user_id))); discarded++; }
        }
      })();
    } finally { control.close(); }
    const restored = describe(work);
    const receipt: RestoreReceipt = { format: "kairos-controlled-restore-v1", backup_id: manifest.id, witness_id: witness.id, witness_sha256: options.expectedWitnessSha256,
      restored_at: new Date().toISOString(), reauthorization_required: true, discarded_deleted_journals: discarded,
      accounts: restored.users.length, journals: restored.journals.length, entries: restored.journals.reduce((n, j) => n + j.count, 0),
      limits: "Controlled offline restore using an operator-trusted deletion witness. No automated off-host backup, account-password recovery, or unannounced rollback detection is proved." };
    writeFileSync(join(work, "restore-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    for (const name of readdirSync(work)) syncFile(join(work, name));
    syncDirectory(work);
    if (existsSync(target)) fail("Restore destination appeared; refusing to replace it");
    renameSync(work, target); syncDirectory(dirname(target)); return receipt;
  } finally { rmSync(work, { recursive: true, force: true }); }
}
