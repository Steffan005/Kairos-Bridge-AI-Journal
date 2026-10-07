// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Kairos Journal: a portable, user-owned memory journal for AI apps, served over MCP.
 * Copyright (C) 2026  Steffan Douglas Haskins
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Additional terms under AGPLv3 section 7(b) apply: the notice
 * "Kairos Journal, created by Steffan Douglas Haskins" and the copyright
 * notice above must be preserved. See the NOTICE file for the full terms.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Journal } from "../src/journal.js";
import { GENESIS_HASH, hashEntry, canonicalize, tickFromMs } from "../src/canonical.js";
import { resolveExportPath } from "../src/exportPath.js";
import { tempDbPath, tempDir } from "../test-utils/helpers.js";

function seed(j: Journal, n: number) {
  for (let i = 0; i < n; i++) {
    j.write({
      text: `Entry number ${i}: the user mentioned topic-${i % 7} and likes ${i % 2 ? "tea" : "coffee"}.`,
      kind: (["note", "fact", "preference", "decision", "summary"] as const)[i % 5],
      actor: ["claude", "chatgpt", "steffan"][i % 3],
      tags: [`t${i % 4}`],
    });
  }
}

/** Open the raw file the way an attacker with disk access could, removing the append-only guards. */
function rawTamper(dbPath: string, fn: (db: Database.Database) => void) {
  const db = new Database(dbPath);
  db.exec("DROP TRIGGER entries_no_update; DROP TRIGGER entries_no_delete;");
  fn(db);
  db.close();
}

describe("hash chain", () => {
  test("first entry links to 64 zeros, every later entry links to the one before", () => {
    const j = Journal.open(tempDbPath());
    seed(j, 25);
    const rows = j.db.prepare("SELECT * FROM entries ORDER BY seq").all() as any[];
    assert.equal(rows.length, 25);
    assert.equal(rows[0].parent_hash, GENESIS_HASH);
    assert.equal(GENESIS_HASH, "0".repeat(64));
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].parent_hash, rows[i - 1].hash);
    for (const r of rows) {
      const recomputed = hashEntry({ ...r, tags: JSON.parse(r.tags) });
      assert.equal(recomputed, r.hash);
      assert.match(r.hash, /^[0-9a-f]{64}$/);
    }
    const v = j.verify();
    assert.equal(v.ok, true);
    assert.equal(v.checked, 25);
    assert.equal(v.headHash, rows[24].hash);
    j.close();
  });

  test("tick is floor(ms / 25) of created_at, and the canonical form is stable", () => {
    const j = Journal.open(tempDbPath());
    const ms = Date.UTC(2026, 9, 7, 14, 42, 0, 123);
    const e = j.write({ text: "clock check", nowMs: ms });
    assert.equal(e.created_at, "2026-10-07T14:42:00.123Z");
    assert.equal(e.tick, Math.floor(ms / 25));
    assert.equal(e.tick, tickFromMs(Date.parse(e.created_at)));
    assert.equal(
      canonicalize({ id: "a", created_at: "t", tick: 1, actor: "x", kind: "note", text: "hi", tags: ["k"], parent_hash: GENESIS_HASH }),
      `["kairos-journal/v1","a","t",1,"x","note","hi",["k"],"${GENESIS_HASH}"]`,
    );
    j.close();
  });

  test("new journals use 16 KB pages and WAL mode", () => {
    const j = Journal.open(tempDbPath());
    assert.equal(j.db.pragma("page_size", { simple: true }), 16384);
    assert.equal(j.db.pragma("journal_mode", { simple: true }), "wal");
    j.close();
  });

  test("an empty journal verifies as intact", () => {
    const j = Journal.open(tempDbPath());
    assert.deepEqual(j.verify(), { ok: true, checked: 0, headHash: GENESIS_HASH });
    j.close();
  });

  test("the database refuses edits and deletes (append-only)", () => {
    const j = Journal.open(tempDbPath());
    seed(j, 3);
    assert.throws(() => j.db.prepare("UPDATE entries SET text = 'x' WHERE seq = 1").run(), /append-only/);
    assert.throws(() => j.db.prepare("DELETE FROM entries WHERE seq = 1").run(), /append-only/);
    assert.equal(j.verify().ok, true);
    j.close();
  });

  test("survives reopening and keeps chaining across sessions", () => {
    const p = tempDbPath();
    let j = Journal.open(p);
    seed(j, 5);
    j.close();
    j = Journal.open(p);
    seed(j, 5);
    assert.equal(j.count(), 10);
    assert.equal(j.verify().ok, true);
    j.close();
  });
});

describe("tamper detection", () => {
  test("changing an entry's text is caught at that entry", () => {
    const p = tempDbPath();
    const j = Journal.open(p);
    seed(j, 20);
    j.close();
    rawTamper(p, (db) => db.prepare("UPDATE entries SET text = 'I never said that' WHERE seq = 10").run());
    const j2 = Journal.open(p);
    const v = j2.verify();
    assert.equal(v.ok, false);
    assert.equal(v.checked, 9);
    assert.equal(v.firstBroken?.seq, 10);
    assert.match(v.firstBroken!.reason, /modified/);
    j2.close();
  });

  test("re-hashing a modified entry still breaks the link to the next one", () => {
    const p = tempDbPath();
    const j = Journal.open(p);
    seed(j, 20);
    j.close();
    rawTamper(p, (db) => {
      const r = db.prepare("SELECT * FROM entries WHERE seq = 10").get() as any;
      const forged = { ...r, text: "forged", tags: JSON.parse(r.tags) };
      db.prepare("UPDATE entries SET text = ?, hash = ? WHERE seq = 10").run("forged", hashEntry(forged));
    });
    const j2 = Journal.open(p);
    const v = j2.verify();
    assert.equal(v.ok, false);
    assert.equal(v.firstBroken?.seq, 11);
    assert.match(v.firstBroken!.reason, /parent_hash/);
    j2.close();
  });

  test("changing actor, kind, tags or time is caught", () => {
    for (const sql of [
      "UPDATE entries SET actor = 'someone-else' WHERE seq = 4",
      "UPDATE entries SET kind = 'summary' WHERE seq = 4",
      `UPDATE entries SET tags = '["edited"]' WHERE seq = 4`,
      "UPDATE entries SET created_at = '2020-01-01T00:00:00.000Z' WHERE seq = 4",
    ]) {
      const p = tempDbPath();
      const j = Journal.open(p);
      seed(j, 6);
      j.close();
      rawTamper(p, (db) => db.prepare(sql).run());
      const j2 = Journal.open(p);
      const v = j2.verify();
      assert.equal(v.ok, false, sql);
      assert.equal(v.firstBroken?.seq, 4, sql);
      j2.close();
    }
  });

  test("deleting an entry from the middle is caught", () => {
    const p = tempDbPath();
    const j = Journal.open(p);
    seed(j, 10);
    j.close();
    rawTamper(p, (db) => db.prepare("DELETE FROM entries WHERE seq = 5").run());
    const j2 = Journal.open(p);
    const v = j2.verify();
    assert.equal(v.ok, false);
    assert.equal(v.firstBroken?.seq, 6);
    assert.match(v.firstBroken!.reason, /missing/);
    j2.close();
  });

  test("deleting the newest entries is caught", () => {
    const p = tempDbPath();
    const j = Journal.open(p);
    seed(j, 10);
    j.close();
    rawTamper(p, (db) => db.prepare("DELETE FROM entries WHERE seq >= 9").run());
    const j2 = Journal.open(p);
    const v = j2.verify();
    assert.equal(v.ok, false);
    assert.equal(v.checked, 8);
    assert.match(v.firstBroken!.reason, /removed from the end/);
    j2.close();
  });
});

describe("search", () => {
  test("finds entries by words, with stemming, filters and limits", () => {
    const j = Journal.open(tempDbPath());
    j.write({ text: "Steffan is traveling to Denver next week for a conference.", kind: "fact", actor: "claude", tags: ["travel"] });
    j.write({ text: "Prefers window seats on long flights.", kind: "preference", actor: "chatgpt", tags: ["travel"] });
    j.write({ text: "Grandma's pie recipe uses butter, not shortening.", kind: "fact", actor: "steffan", tags: ["family"] });
    seed(j, 30);

    const hits = j.search("travel Denver");
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /Denver/);

    const stemmed = j.search("travels");
    assert.ok(stemmed.some((h) => /traveling/.test(h.text)), "porter stemming should match traveling");

    const tagged = j.search("travel", { limit: 10 });
    assert.equal(tagged.length, 2, "tag text is searchable too");

    assert.equal(j.search("travel", { kind: "preference" }).length, 1);
    assert.equal(j.search("travel", { actor: "Claude" }).length, 1);
    assert.equal(j.search("coffee", { limit: 3 }).length, 3);

    // filler words are ignored when the query has real words in it
    assert.equal(j.search("what is the plan for Denver")[0]?.text.includes("Denver"), true);

    // falls back to OR when not every word matches
    const orHits = j.search("pie zebra");
    assert.equal(orHits.length, 1);
    assert.match(orHits[0].text, /pie/);
    j.close();
  });

  test("odd input never throws (quotes, operators, punctuation, empty)", () => {
    const j = Journal.open(tempDbPath());
    seed(j, 5);
    for (const q of ['"', "AND OR NOT", "topic-1 *", "NEAR(", "'; DROP TABLE entries; --", "???", "   ", "émoji 🎉 café"]) {
      assert.doesNotThrow(() => j.search(q), q);
    }
    assert.deepEqual(j.search("???"), []);
    assert.equal(j.count(), 5);
    j.close();
  });
});

describe("wake briefing", () => {
  test("includes pinned entries first, then recent ones oldest to newest", () => {
    const j = Journal.open(tempDbPath());
    const pin = j.write({ text: "Name: Steffan. Likes plain language.", kind: "preference", pin: true });
    seed(j, 5);
    const last = j.write({ text: "Most recent thing." });
    const b = j.wake({ recent: 3 });
    const iPin = b.text.indexOf(pin.id);
    const iLast = b.text.indexOf(last.id);
    assert.ok(iPin > 0 && iLast > iPin);
    assert.equal(b.pinnedIncluded, 1);
    assert.equal(b.recentIncluded, 3);
    assert.match(b.text, /more not shown/);
    j.close();
  });

  test("never exceeds the size cap, even with huge entries and many pins", () => {
    const j = Journal.open(tempDbPath());
    const big = "word ".repeat(1500);
    for (let i = 0; i < 40; i++) j.write({ text: `pinned ${i} ${big}`, pin: i % 2 === 0 });
    for (let i = 0; i < 200; i++) j.write({ text: `recent ${i} ${big}` });
    for (const cap of [200, 500, 1000, 2000, 6000, 20000]) {
      const b = j.wake({ maxChars: cap, recent: 200 });
      assert.ok(b.text.length <= cap, `cap ${cap} exceeded: ${b.text.length}`);
      assert.equal(b.chars, b.text.length);
    }
    const def = j.wake();
    assert.ok(def.text.length <= 6000);
    assert.equal(def.truncated, true);
    j.close();
  });

  test("unpinning removes an entry from the pinned section without deleting it", () => {
    const j = Journal.open(tempDbPath());
    const e = j.write({ text: "Temporary preference.", pin: true });
    assert.equal(j.pinned().length, 1);
    j.unpin(e.id);
    assert.equal(j.pinned().length, 0);
    assert.ok(j.get(e.id));
    assert.equal(j.verify().ok, true);
    j.close();
  });

  test("empty journal gives a friendly message", () => {
    const j = Journal.open(tempDbPath());
    assert.match(j.wake().text, /empty/);
    j.close();
  });
});

describe("input safety", () => {
  test("refuses obvious secrets and oversize text, normalizes tags and actor", () => {
    const j = Journal.open(tempDbPath());
    for (const bad of [
      "my password: hunter2xx",
      "key is sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "card 4111 1111 1111 1111",
    ]) {
      assert.throws(() => j.write({ text: bad }), /secret/, bad);
    }
    assert.throws(() => j.write({ text: "x".repeat(8001) }), /limit/);
    assert.throws(() => j.write({ text: "   " }), /empty/);
    const e = j.write({ text: "ok", actor: "  Claude Desktop ", tags: ["#Travel", "travel", "Long Trips"] });
    assert.equal(e.actor, "claude-desktop");
    assert.deepEqual(e.tags, ["travel", "long-trips"]);
    assert.equal(j.count(), 1);
    j.close();
  });
});

describe("export", () => {
  test("writes JSON and Markdown, and never overwrites", () => {
    const j = Journal.open(tempDbPath());
    seed(j, 12);
    j.pin(j.recent(1)[0].id);
    const dir = tempDir();
    const jsonPath = path.join(dir, "out.json");
    const r = j.exportTo(resolveExportPath(jsonPath, "json"), "json");
    assert.equal(r.entries, 12);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(parsed.entry_count, 12);
    assert.equal(parsed.chain_ok, true);
    assert.equal(parsed.entries[0].parent_hash, GENESIS_HASH);
    assert.equal(parsed.entries.filter((e: any) => e.pinned).length, 1);
    // the exported entries can be re-verified independently of SQLite
    let prev = GENESIS_HASH;
    for (const e of parsed.entries) {
      assert.equal(e.parent_hash, prev);
      assert.equal(hashEntry(e), e.hash);
      prev = e.hash;
    }
    assert.throws(() => resolveExportPath(jsonPath, "json"), /already exists/);
    assert.throws(() => j.exportTo(jsonPath, "json"), /EEXIST/);
    assert.throws(() => resolveExportPath("relative.json", "json"), /absolute/);
    assert.throws(() => resolveExportPath(path.join(dir, "x.txt"), "json"), /\.json/);
    assert.throws(() => resolveExportPath(path.join(dir, "nope", "x.json"), "json"), /does not exist/);

    const mdPath = path.join(dir, "out.md");
    j.exportTo(resolveExportPath(mdPath, "md"), "md");
    const md = fs.readFileSync(mdPath, "utf8");
    assert.match(md, /# Journal export/);
    assert.match(md, /## Pinned/);
    assert.match(md, /Chain check: intact/);
    j.close();
  });
});
