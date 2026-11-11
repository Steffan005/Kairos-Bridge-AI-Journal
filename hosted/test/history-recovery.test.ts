// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createPreview } from "../src/service.js";
import { captureBackup, captureDeletionWitness, restoreBackup } from "../src/recovery.js";
import { Journal } from "../../src/journal.js";

// Only used before a fixture has schema 3 metadata. Dropping these columns
// restores the real earlier layout rather than merely relabeling a modern DB.
function earlierSchema(file: string, schema: 1 | 2): void {
  const db = new Database(file);
  try {
    db.exec("DROP INDEX entry_continuity_seq; DROP INDEX entry_continuity_role; ALTER TABLE entries DROP COLUMN origin_json; ALTER TABLE entries DROP COLUMN continuity_json");
    if (schema === 1) db.exec("DROP INDEX entry_chronology; DROP INDEX historical_source_identity; ALTER TABLE entries DROP COLUMN provenance_json; ALTER TABLE entries DROP COLUMN chronology_key");
    db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(schema));
  } finally { db.close(); }
}
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("offline recovery accepts genuine schemas 1/2/3 without rewriting history and rejects manifest/schema disagreement", async () => {
  const root = mkdtempSync(join(tmpdir(), "kairos-history-recovery-")), directory = join(root, "service");
  const service = await createPreview({ baseURL: "http://127.0.0.1:18798", directory, secret: randomBytes(32).toString("hex") });
  let closed = false;
  try {
    const a = await service.auth.api.signUpEmail({ body: { email: "schema-a@example.test", name: "Synthetic schema A", password: "synthetic-schema-testing-password" } });
    const b = await service.auth.api.signUpEmail({ body: { email: "schema-b@example.test", name: "Synthetic schema B", password: "synthetic-schema-testing-password" } });
    const c = await service.auth.api.signUpEmail({ body: { email: "schema-c@example.test", name: "Synthetic schema C", password: "synthetic-schema-testing-password" } });
    const ids = [a.user.id, b.user.id, c.user.id]; ids.forEach(id => service.accounts.get(id));
    const paths = ids.map(id => service.accounts.path(id));
    const originals = paths.map((file, index) => { const journal = Journal.open(file); try { return journal.write({ text: `SYNTHETIC original schema one note ${index}`, actor: "you" }); } finally { journal.close(); } });
    await service.close(); closed = true;
    paths.forEach(file => earlierSchema(file, 1));
    const originalV1Digests = paths.map(digest);
    const v1Bundle = join(root, "backup-v1"), v1 = await captureBackup(directory, v1Bundle, "a".repeat(40));
    assert.equal(v1.journal_schema, 1);
    const v1Witness = join(root, "witness-v1.json"), witness1 = captureDeletionWitness(directory, v1Witness);
    const restored1 = join(root, "restored-v1"); assert.equal(restoreBackup({ backup: v1Bundle, output: restored1, witness: v1Witness, expectedWitnessSha256: witness1.sha256 }).entries, 3);
    assert.deepEqual(paths.map(digest), originalV1Digests, "capture, verification and restore never migrate original schema 1 databases");
    for (let i = 0; i < paths.length; i++) {
      const journal = Journal.openReadOnly(join(restored1, v1.journals.find(j => j.name === paths[i].split("/").at(-1))!.name));
      try { assert.ok(journal.verify().ok); assert.deepEqual(journal.recent(1)[0], originals[i]); } finally { journal.close(); }
    }
    const current = Journal.open(paths[0]); let imported;
    try {
      imported = current.importHistorical([{ source_store: "synthetic-old-store", source_id: "old-record", original_timestamp: "2026-01-01T12:00:00", original_actor: "gemini_word", canonical_actor: "gemini_word", timezone: "unspecified", source_file_sha256: "b".repeat(64), text: "SYNTHETIC imported note survives backup and restore" }], "owner");
    } finally { current.close(); }
    earlierSchema(paths[0], 2);
    const originalV2Digests = paths.map(digest);
    const mixedBundle = join(root, "backup-mixed"), mixed = await captureBackup(directory, mixedBundle, "c".repeat(40));
    assert.equal(mixed.journal_schema, 2);
    const witnessPath = join(root, "witness-mixed.json"), witness = captureDeletionWitness(directory, witnessPath);
    const restored = join(root, "restored-mixed"); assert.equal(restoreBackup({ backup: mixedBundle, output: restored, witness: witnessPath, expectedWitnessSha256: witness.sha256 }).entries, 4);
    assert.deepEqual(paths.map(digest), originalV2Digests, "schema 2 capture and restore are also read-only for the source");
    const restoredJournal = Journal.openReadOnly(join(restored, paths[0].split("/").at(-1)!));
    try { assert.ok(restoredJournal.verify().ok); const old = restoredJournal.get(imported.ids[0]); assert.equal(old?.provenance?.original_actor, "gemini_word"); assert.equal(old?.provenance?.original_timestamp, "2026-01-01T12:00:00"); assert.deepEqual(restoredJournal.get(originals[0].id), originals[0]); } finally { restoredJournal.close(); }
    const manifestPath = join(mixedBundle, "manifest.json"), originalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const schema of [1, 3, 4]) {
      writeFileSync(manifestPath, JSON.stringify({ ...originalManifest, journal_schema: schema }));
      assert.throws(() => restoreBackup({ backup: mixedBundle, output: join(root, `invalid-${schema}`), witness: witnessPath, expectedWitnessSha256: witness.sha256 }), /schema/);
    }
    writeFileSync(manifestPath, JSON.stringify(originalManifest));
    // Keep one genuine schema 2 file and one genuine schema 1 file alongside a
    // migrated journal whose old and new canonical entry formats coexist.
    const schema2 = Journal.open(paths[2]); schema2.close(); earlierSchema(paths[2], 2);
    const latest = Journal.open(paths[0]);
    let stamped;
    try {
      stamped = latest.write({ text: "SYNTHETIC authenticated decision survives offline recovery", actor: "claude", tags: ["project-recovery"],
        writeOrigin: { version: 1, channel: "oauth", client_id: "https://chatgpt.com/oauth/client.json", provider: "chatgpt", received_at: new Date().toISOString() },
        continuity: { version: 1, role: "decision", actor_id: "claude_summers" } });
      assert.deepEqual(latest.get(originals[0].id), originals[0]);
    } finally { latest.close(); }
    const originalV3Digests = paths.map(digest);
    const v3Bundle = join(root, "backup-v3"), v3 = await captureBackup(directory, v3Bundle, "d".repeat(40));
    assert.equal(v3.journal_schema, 3);
    const witness3Path = join(root, "witness-v3.json"), witness3 = captureDeletionWitness(directory, witness3Path);
    const restored3 = join(root, "restored-v3"), backupDigests = v3.files.map(file => digest(join(v3Bundle, file.name)));
    assert.equal(restoreBackup({ backup: v3Bundle, output: restored3, witness: witness3Path, expectedWitnessSha256: witness3.sha256 }).entries, 5);
    assert.deepEqual(paths.map(digest), originalV3Digests);
    assert.deepEqual(v3.files.map(file => digest(join(v3Bundle, file.name))), backupDigests, "verification and restore never migrate selected backup files");
    for (let i = 0; i < paths.length; i++) {
      const file = join(restored3, paths[i].split("/").at(-1)!);
      const db = new Database(file, { readonly: true });
      try { assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, ["3", "1", "2"][i]); } finally { db.close(); }
      const journal = Journal.openReadOnly(file);
      try {
        assert.ok(journal.verify().ok); assert.deepEqual(journal.get(originals[i].id), originals[i]);
        if (i === 0) {
          assert.deepEqual(journal.get(stamped.id), stamped);
          assert.equal(journal.get(imported.ids[0])?.provenance?.original_actor, "gemini_word");
        }
      } finally { journal.close(); }
    }
    for (const schema of [1, 2, 4]) {
      writeFileSync(join(v3Bundle, "manifest.json"), JSON.stringify({ ...v3, journal_schema: schema }));
      assert.throws(() => restoreBackup({ backup: v3Bundle, output: join(root, `invalid-v3-${schema}`), witness: witness3Path, expectedWitnessSha256: witness3.sha256 }), /schema/);
    }
    const future = new Database(paths[0]);
    try { future.exec("UPDATE meta SET value='4' WHERE key='schema_version'"); } finally { future.close(); }
    await assert.rejects(captureBackup(directory, join(root, "future-schema"), "e".repeat(40)), /schema/);
  } finally { if (!closed) await service.close(); rmSync(root, { recursive: true, force: true }); }
});
