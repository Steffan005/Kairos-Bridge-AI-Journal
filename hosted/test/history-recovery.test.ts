// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createPreview } from "../src/service.js";
import { captureBackup, captureDeletionWitness, restoreBackup } from "../src/recovery.js";
import { Journal } from "../../src/journal.js";

test("offline recovery accepts genuine schema 1 and mixed 1/2 imported journals, rejecting manifest/schema disagreement", async () => {
  const root = mkdtempSync(join(tmpdir(), "kairos-history-recovery-")), directory = join(root, "service");
  const service = await createPreview({ baseURL: "http://127.0.0.1:18798", directory, secret: randomBytes(32).toString("hex") });
  let closed = false;
  try {
    const a = await service.auth.api.signUpEmail({ body: { email: "schema-a@example.test", name: "Synthetic schema A", password: "synthetic-schema-testing-password" } });
    const b = await service.auth.api.signUpEmail({ body: { email: "schema-b@example.test", name: "Synthetic schema B", password: "synthetic-schema-testing-password" } });
    const ids = [a.user.id, b.user.id]; ids.forEach(id => service.accounts.get(id));
    const paths = ids.map(id => service.accounts.path(id));
    const originals = paths.map((file, index) => { const journal = Journal.open(file); try { return journal.write({ text: `SYNTHETIC original schema one note ${index}`, actor: "you" }); } finally { journal.close(); } });
    await service.close(); closed = true;
    for (const file of paths) {
      const db = new Database(file);
      try { db.exec("DROP INDEX entry_chronology; DROP INDEX historical_source_identity; ALTER TABLE entries DROP COLUMN provenance_json; ALTER TABLE entries DROP COLUMN chronology_key; UPDATE meta SET value='1' WHERE key='schema_version'"); }
      finally { db.close(); }
    }
    const v1Bundle = join(root, "backup-v1"), v1 = await captureBackup(directory, v1Bundle, "a".repeat(40));
    assert.equal(v1.journal_schema, 1);
    const v1Witness = join(root, "witness-v1.json"), witness1 = captureDeletionWitness(directory, v1Witness);
    const restored1 = join(root, "restored-v1"); assert.equal(restoreBackup({ backup: v1Bundle, output: restored1, witness: v1Witness, expectedWitnessSha256: witness1.sha256 }).entries, 2);
    for (let i = 0; i < paths.length; i++) {
      const journal = Journal.openReadOnly(join(restored1, v1.journals.find(j => j.name === paths[i].split("/").at(-1))!.name));
      try { assert.ok(journal.verify().ok); assert.deepEqual(journal.recent(1)[0], originals[i]); } finally { journal.close(); }
    }
    const current = Journal.open(paths[0]); let imported;
    try {
      imported = current.importHistorical([{ source_store: "synthetic-old-store", source_id: "old-record", original_timestamp: "2026-01-01T12:00:00", original_actor: "gemini_word", canonical_actor: "gemini_word", timezone: "unspecified", source_file_sha256: "b".repeat(64), text: "SYNTHETIC imported note survives backup and restore" }], "owner");
    } finally { current.close(); }
    const mixedBundle = join(root, "backup-mixed"), mixed = await captureBackup(directory, mixedBundle, "c".repeat(40));
    assert.equal(mixed.journal_schema, 2);
    const witnessPath = join(root, "witness-mixed.json"), witness = captureDeletionWitness(directory, witnessPath);
    const restored = join(root, "restored-mixed"); assert.equal(restoreBackup({ backup: mixedBundle, output: restored, witness: witnessPath, expectedWitnessSha256: witness.sha256 }).entries, 3);
    const restoredJournal = Journal.openReadOnly(join(restored, paths[0].split("/").at(-1)!));
    try { assert.ok(restoredJournal.verify().ok); const old = restoredJournal.get(imported.ids[0]); assert.equal(old?.provenance?.original_actor, "gemini_word"); assert.equal(old?.provenance?.original_timestamp, "2026-01-01T12:00:00"); assert.deepEqual(restoredJournal.get(originals[0].id), originals[0]); } finally { restoredJournal.close(); }
    const manifestPath = join(mixedBundle, "manifest.json"), originalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const schema of [1, 3]) {
      writeFileSync(manifestPath, JSON.stringify({ ...originalManifest, journal_schema: schema }));
      assert.throws(() => restoreBackup({ backup: mixedBundle, output: join(root, `invalid-${schema}`), witness: witnessPath, expectedWitnessSha256: witness.sha256 }), /schema/);
    }
  } finally { if (!closed) await service.close(); rmSync(root, { recursive: true, force: true }); }
});
