// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, type OwnerSearchCursor, type OwnerSearchOptions } from "../src/journal.js";

function fixture(run: (journal: Journal) => void) {
  const directory = mkdtempSync(join(tmpdir(), "kairos-owner-search-"));
  const journal = Journal.open(join(directory, "journal.db"));
  try { run(journal); } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("owner history pages all 123 entries without pin duplicates, excluding later arrivals", () => fixture(j => {
  const completeText = "SYNTHETIC: archival shared journal note. ".repeat(150).trim();
  const oldest = j.write({ text: completeText, actor: "archive", tags: ["project-old-only"], nowMs: 1_000 });
  j.writeMany(Array.from({ length: 122 }, (_, i) => ({ text: `SYNTHETIC history ${i}`, actor: "current", tags: ["project-current"], nowMs: 1_000 })));
  j.pin(oldest.id);
  const first = j.searchPage();
  assert.equal(first.entries.length, 15); assert.equal(first.total, 123); assert.equal(first.matched_mode, "history");
  assert.equal(first.snapshot_seq, 123); assert.deepEqual(first.projects, ["project-current", "project-old-only"]);
  assert.deepEqual(first.authors, ["archive", "current"]); assert.ok(first.next);
  const arriving = j.write({ text: "SYNTHETIC arriving later", actor: "later", tags: ["project-later"] });
  const unchangedHead = j.headHash();
  const found = [...first.entries];
  let cursor: OwnerSearchCursor | null = first.next;
  while (cursor) {
    const page = j.searchPage("", { cursor });
    assert.equal(page.total, 123); assert.equal(page.snapshot_seq, 123);
    assert.ok(!page.projects.includes("project-later")); assert.ok(!page.authors.includes("later"));
    found.push(...page.entries); cursor = page.next;
  }
  assert.equal(found.length, 123); assert.equal(new Set(found.map(e => e.id)).size, 123);
  assert.deepEqual(found.map(e => e.seq), Array.from({ length: 123 }, (_, i) => 123 - i));
  assert.equal(found.at(-1)?.text, completeText); assert.deepEqual(found.at(-1), { ...oldest, pinned: true });
  assert.equal(j.searchPage().entries[0].id, arriving.id);
  assert.equal(j.headHash(), unchangedHead); assert.equal(j.count(), 124); assert.ok(j.verify().ok);
}));

test("owner Words pages all full-history matches and preserves chosen fallback", () => fixture(j => {
  j.writeMany(Array.from({ length: 81 }, (_, i) => ({ text: `SYNTHETIC: run plan ${i}`, actor: "claude", tags: ["project-kitchen"] })));
  const first = j.searchPage("running plans", { limit: 13 });
  assert.equal(first.total, 81); assert.equal(first.matched_mode, "all");
  const ids = first.entries.map(e => e.id);
  let cursor = first.next;
  while (cursor) {
    const page = j.searchPage("running plans", { limit: 13, cursor });
    assert.equal(page.matched_mode, "all"); assert.equal(page.total, 81);
    ids.push(...page.entries.map(e => e.id)); cursor = page.next;
  }
  assert.equal(ids.length, 81); assert.equal(new Set(ids).size, 81);
  const fallback = j.searchPage("run missingword", { limit: 10 });
  assert.equal(fallback.matched_mode, "any"); assert.equal(fallback.total, 81); assert.ok(fallback.next);
  j.write({ text: "SYNTHETIC run missingword" });
  const continued = j.searchPage("run missingword", { cursor: fallback.next });
  assert.equal(continued.matched_mode, "any"); assert.equal(continued.total, 81);
  assert.equal(j.searchPage("run missingword").matched_mode, "all");
}));

test("exact project and author filters run before all-to-any choice, without mention leakage", () => fixture(j => {
  const exact = j.write({ text: "SYNTHETIC violet cabinetry", tags: ["project-kitchen"], actor: "claude" });
  j.write({ text: "SYNTHETIC cobalt cabinetry", tags: ["project-kitchen-remodel"], actor: "claude" });
  j.write({ text: "SYNTHETIC project-kitchen violet cabinetry", tags: ["misc"], actor: "claude" });
  j.write({ text: "SYNTHETIC cobalt cabinetry", tags: ["project-kitchen"], actor: "claude-code" });
  const page = j.searchPage("cobalt cabinetry", { project: "project-kitchen", author: "claude" });
  assert.equal(page.matched_mode, "any"); assert.equal(page.total, 1); assert.equal(page.entries[0].id, exact.id);
  assert.equal(j.searchPage("", { project: "project-kitchen", author: "Claude" }).total, 0, "author filtering is exact");
  assert.equal(j.searchPage("", { project: "project-kitchen" }).total, 2);
  assert.equal(j.searchPage("", { project: "project-absent" }).total, 0);
}));

test("Exact phrase preserves punctuation and Unicode case, without stemming or reordered words", () => fixture(j => {
  const exact = j.write({ text: 'SYNTHETIC: CAFÉ—JARDIN, running river. Quote: "blue tile".', tags: ["project-kitchen"] });
  j.write({ text: "SYNTHETIC: café jardin, run river; river running; blue tiles.", tags: ["project-other"] });
  j.write({ text: "SYNTHETIC unrelated", tags: ["project-café—jardin"] });
  const page = j.searchPage("cafe\u0301—jardin", { mode: "exact" });
  assert.equal(page.matched_mode, "phrase"); assert.equal(page.total, 1); assert.equal(page.entries[0].id, exact.id);
  assert.equal(j.searchPage("running river", { mode: "exact" }).total, 1);
  assert.equal(j.searchPage('"blue tile"', { mode: "exact" }).total, 1);
  assert.equal(j.searchPage("*", { mode: "exact" }).total, 0);
}));

test("Note ID opens exactly one complete ID and never returns mentions or fingerprints", () => fixture(j => {
  const target = j.write({ text: "SYNTHETIC primary note", tags: ["project-kitchen"], actor: "claude" });
  j.write({ text: `SYNTHETIC mention ${target.id}`, actor: "you" });
  const page = j.searchPage(target.id.toUpperCase(), { mode: "id" });
  assert.equal(page.matched_mode, "id"); assert.equal(page.total, 1); assert.deepEqual(page.entries, [target]); assert.equal(page.next, null);
  assert.equal(j.searchPage(target.id, { mode: "id", author: "you" }).total, 0);
  assert.equal(j.searchPage("0000000000000000", { mode: "id" }).total, 0);
  assert.throws(() => j.searchPage(target.id.slice(0, 8), { mode: "id" }), /complete 16-character/);
  assert.throws(() => j.searchPage(target.hash, { mode: "id" }), /complete 16-character/);
}));

test("Words input treats FTS operators, columns, punctuation and SQL as literal tokens", () => fixture(j => {
  const operatorText = j.write({ text: "SYNTHETIC needle OR unrelated NOT other NEAR text kind DROP TABLE entries" });
  j.write({ text: "SYNTHETIC needle" });
  j.write({ text: "SYNTHETIC unrelated" });
  for (const q of ['needle "OR" unrelated', "needle NOT other", "NEAR(needle, unrelated)", "text:needle", "kind:needle", "DROP TABLE entries; --"]) {
    const page = j.searchPage(q);
    assert.equal(page.matched_mode, "all", q); assert.deepEqual(page.entries.map(e => e.id), [operatorText.id], q);
  }
  assert.equal(j.searchPage('* ")').total, 0);
  assert.equal(j.count(), 3); assert.ok(j.verify().ok);
}));

test("cursor context rejects a changed query, mode, filter, journal or invalid boundary", () => fixture(j => {
  j.writeMany(Array.from({ length: 30 }, () => ({ text: "SYNTHETIC violet words", tags: ["project-kitchen"], actor: "claude" })));
  const cursor = j.searchPage("violet", { limit: 5, project: "project-kitchen" }).next!;
  for (const opts of [{ cursor, project: "project-other" }, { cursor, project: "project-kitchen", author: "claude" },
    { cursor, project: "project-kitchen", mode: "exact" }]) {
    assert.throws(() => j.searchPage("violet", opts as OwnerSearchOptions), /no longer matches/);
  }
  assert.throws(() => j.searchPage("words", { cursor, project: "project-kitchen" }), /no longer matches/);
  for (const change of [{ journal: "another" }, { before: 0 }, { snapshot: 31 }, { matched_mode: "history" }, { version: 2 }]) {
    assert.throws(() => j.searchPage("violet", { cursor: { ...cursor, ...change } as OwnerSearchCursor, project: "project-kitchen" }), /no longer matches/);
  }
  fixture(other => {
    other.writeMany(Array.from({ length: 30 }, () => ({ text: "SYNTHETIC violet" })));
    assert.throws(() => other.searchPage("violet", { cursor, project: "project-kitchen" }), /no longer matches/);
  });
}));

test("owner search validates bounded inputs and handles empty journals", () => fixture(j => {
  assert.deepEqual(j.searchPage(), { entries: [], next: null, matched_mode: "history", total: 0, snapshot_seq: 0, projects: [], authors: [] });
  for (const limit of [0, 51, 1.5, NaN]) assert.throws(() => j.searchPage("", { limit }), /Page size/);
  assert.throws(() => j.searchPage("a".repeat(513)), /512/);
  assert.throws(() => j.searchPage(Array.from({ length: 33 }, (_, i) => `word${i}`).join(" ")), /32/);
  assert.throws(() => j.searchPage("x", { mode: "meaning" as never }), /Choose Words/);
  assert.throws(() => j.searchPage("", { project: "kitchen" }), /complete project tag/);
  assert.throws(() => j.searchPage("", { author: "" }), /Author/);
}));
