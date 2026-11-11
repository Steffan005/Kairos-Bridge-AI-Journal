// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { Journal, JournalError, type Entry, type HistoricalRecord, type WriteOrigin } from "../src/journal.js";
import { canonicalize, hashEntry, GENESIS_HASH } from "../src/canonical.js";

const origin: WriteOrigin = { version: 1, channel: "oauth", client_id: "authorized-client", provider: "claude", received_at: "2026-10-14T12:00:00.000Z" };
const historical: HistoricalRecord = { source_store: "fixture", source_id: "one", original_timestamp: "2026-01-01T00:00:00", original_actor: "claude_summers",
  source_file_sha256: "a".repeat(64), canonical_actor: "claude_summers", timezone: "unspecified", text: "Historical kitchen", tags: ["project-kitchen"] };
function fixture(run: (j: Journal, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "kairos-origin-"));
  const j = Journal.open(join(dir, "journal.db"));
  try { run(j, dir); } finally { if (j.db.open) j.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("origin is separate from attribution, copied, hashed and retained by read/search/export", () => fixture((j, dir) => {
  const supplied = { ...origin };
  const e = j.write({ text: "Kitchen plan", actor: "Steffan", tags: ["project-kitchen"], writeOrigin: supplied,
    continuity: { version: 1, role: "goal", actor_id: "ChatGPT" } });
  supplied.client_id = "changed-after-write";
  assert.equal(e.actor, "steffan"); assert.deepEqual(e.write_origin, origin); assert.equal(e.continuity!.actor_id, "gpt_codex");
  assert.match(canonicalize(e), /^\["kairos-journal\/continuity-v1"/); assert.equal(hashEntry(e), e.hash);
  assert.equal(canonicalize(e), JSON.stringify(["kairos-journal/continuity-v1", e.id, e.created_at, e.tick, e.actor, e.kind, e.text, e.tags, e.parent_hash,
    null, [1, "oauth", "authorized-client", "claude", origin.received_at], [1, "goal", "gpt_codex", null, null, null]]));
  for (const read of [j.get(e.id), j.recent(1)[0], j.search("Kitchen", { project: "project-kitchen" })[0], j.searchPage().entries[0]]) {
    assert.deepEqual(read!.write_origin, origin); assert.deepEqual(read!.continuity, e.continuity);
  }
  const imported = j.get(j.importHistorical([historical], "gpt_codex").ids[0])!;
  assert.equal(imported.write_origin, undefined); assert.equal(imported.continuity, undefined);
  const out = join(dir, "journal.json"); j.exportTo(out, "json");
  const exported = JSON.parse(readFileSync(out, "utf8"));
  let parent = GENESIS_HASH;
  for (const entry of exported.entries as Entry[]) {
    assert.equal(entry.parent_hash, parent); assert.equal(hashEntry(entry), entry.hash); parent = entry.hash;
    assert.deepEqual(entry, j.get(entry.id));
  }
  assert.equal(parent, exported.head_hash); assert.equal(exported.chain_ok, true);
  const md = join(dir, "journal.md"); j.exportTo(md, "md");
  assert.match(readFileSync(md, "utf8"), /"client_id": "authorized-client"/);
  assert.match(readFileSync(md, "utf8"), /"actor_id": "gpt_codex"/);
}));

test("owner origin and bounded long OAuth client identifiers preserve authentication facts", () => fixture(j => {
  const owner: WriteOrigin = { version: 1, channel: "owner", client_id: null, provider: null, received_at: origin.received_at };
  assert.deepEqual(j.write({ text: "Owner note", writeOrigin: owner }).write_origin, owner);
  const long = { ...origin, client_id: "https://" + "a".repeat(360) + "/oauth/client", provider: null };
  assert.deepEqual(j.write({ text: "Unclassified authenticated connector", writeOrigin: long }).write_origin, long);
  assert.ok(j.verify().ok);
}));

test("malformed or forged origin fields reject the whole transaction without storing notes", () => fixture(j => {
  const invalid: unknown[] = [null, [], "oauth", {}, { ...origin, version: 2 }, { ...origin, channel: "local" },
    { ...origin, client_id: null }, { ...origin, client_id: " " }, { ...origin, client_id: "a\nclient" }, { ...origin, client_id: "x".repeat(2049) },
    { ...origin, provider: "other" }, { ...origin, provider: undefined }, { ...origin, channel: "owner" },
    { ...origin, received_at: "2026-02-30T00:00:00.000Z" }, { ...origin, received_at: "2026-10-14" },
    { ...origin, received_at: "2026-10-14T12:00:00+00:00" }, { ...origin, injected: true },
    { ...origin, client_id: "password: SUPERSECRET" }];
  for (const value of invalid) {
    assert.throws(() => j.writeMany([{ text: "Good first entry" }, { text: "Must not persist", writeOrigin: value as WriteOrigin }]),
      error => error instanceof JournalError && !error.message.includes("SUPERSECRET"));
    assert.equal(j.count(), 0); assert.equal(j.headHash(), GENESIS_HASH); assert.ok(j.verify().ok);
  }
}));

test("mixed legacy, imported and metadata entries detect origin changes and removal", () => {
  for (const tamper of ["client", "provider", "time", "remove", "invalid-json"]) fixture(j => {
    const old = j.write({ text: "Legacy note" });
    const imported = j.get(j.importHistorical([historical], "gpt_codex").ids[0])!;
    const modern = j.write({ text: "Modern note", writeOrigin: origin });
    j.write({ text: "Later legacy-shaped note" });
    assert.equal(canonicalize(old).split(",")[0], '["kairos-journal/v1"');
    assert.equal(canonicalize(imported).split(",")[0], '["kairos-journal/history-v1"');
    assert.ok(j.verify().ok);
    j.db.exec("DROP TRIGGER entries_no_update");
    if (tamper === "remove") j.db.prepare("UPDATE entries SET origin_json = NULL WHERE id = ?").run(modern.id);
    else if (tamper === "invalid-json") j.db.prepare("UPDATE entries SET origin_json = '{' WHERE id = ?").run(modern.id);
    else {
      const changed = { ...origin, ...(tamper === "client" ? { client_id: "another-client" } : tamper === "provider" ? { provider: "chatgpt" } : { received_at: "2026-10-14T12:00:00.001Z" }) };
      j.db.prepare("UPDATE entries SET origin_json = ? WHERE id = ?").run(JSON.stringify(changed), modern.id);
    }
    const report = j.verify(); assert.equal(report.ok, false, tamper); assert.equal(report.firstBroken?.id, modern.id); assert.equal(report.checked, 2);
  });
});

test("true schema 1 and 2 backups open read-only unchanged and migrate without rewriting hashes", () => {
  for (const version of [1, 2]) fixture((j, dir) => {
    const old = j.write({ text: "Legacy pinned note", pin: true, nowMs: Date.UTC(2026, 9, 1) });
    const entries = [old];
    if (version === 2) entries.push(j.get(j.importHistorical([historical], "gpt_codex").ids[0])!);
    const bytes = entries.map(canonicalize); const head = j.headHash();
    j.checkpoint(); j.close();
    const file = join(dir, "journal.db"); const raw = new Database(file);
    raw.exec("DROP INDEX entry_continuity_seq; DROP INDEX entry_continuity_role; ALTER TABLE entries DROP COLUMN origin_json; ALTER TABLE entries DROP COLUMN continuity_json;");
    if (version === 1) raw.exec("DROP INDEX historical_source_identity; DROP INDEX entry_chronology; ALTER TABLE entries DROP COLUMN provenance_json; ALTER TABLE entries DROP COLUMN chronology_key;");
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version)); raw.close();
    const digest = () => createHash("sha256").update(readFileSync(file)).digest("hex"); const before = digest();
    const read = Journal.openReadOnly(file);
    try { assert.ok(read.verify().ok); assert.equal(read.headHash(), head); for (const e of entries) assert.deepEqual(read.get(e.id), e); }
    finally { read.close(); }
    assert.equal(digest(), before, "read-only inspection must leave the backup bytes unchanged");
    const upgraded = Journal.open(file);
    try {
      assert.equal((upgraded.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {value:string}).value, "3");
      assert.equal(upgraded.headHash(), head);
      entries.forEach((e, i) => { assert.deepEqual(upgraded.get(e.id), e); assert.equal(canonicalize(upgraded.get(e.id)!), bytes[i]); });
      const next = upgraded.write({ text: "After migration", writeOrigin: origin }); assert.equal(next.parent_hash, head);
      assert.ok(upgraded.verify().ok);
    } finally { upgraded.close(); }
  });
});

test("history-v1 canonical tuple stays byte-for-byte unchanged", () => fixture(j => {
  const entry = j.get(j.importHistorical([historical], "gpt_codex").ids[0])!; const p = entry.provenance!;
  const expected = JSON.stringify(["kairos-journal/history-v1", entry.id, entry.created_at, entry.tick, entry.actor, entry.kind, entry.text, entry.tags,
    entry.parent_hash, [p.version, p.source_store, p.source_id, p.original_timestamp, p.original_actor, p.source_file_sha256, p.canonical_actor,
      p.timezone, p.chronology_key, p.imported_at, p.imported_by, null]]);
  assert.equal(canonicalize(entry), expected); assert.equal(createHash("sha256").update(expected).digest("hex"), entry.hash);
}));

test("schema version and column mismatches are rejected without modifying read-only backups", () => {
  for (const version of ["1", "2", "4"]) fixture((j, dir) => {
    j.write({ text: "Preserved backup" }); j.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(version);
    j.checkpoint(); j.close(); const file = join(dir, "journal.db");
    const before = readFileSync(file);
    assert.throws(() => Journal.openReadOnly(file), /schema/); assert.deepEqual(readFileSync(file), before);
    assert.throws(() => Journal.open(file), /schema/);
  });
});
