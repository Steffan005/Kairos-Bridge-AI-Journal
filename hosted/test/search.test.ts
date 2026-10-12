// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { createPreview } from "../src/service.js";
import { Journal, type Entry, type OwnerSearchMatchMode } from "../../src/journal.js";

interface SearchResponse {
  entries: Entry[];
  next_cursor: string | null;
  matched_mode: OwnerSearchMatchMode;
  total: number;
  snapshot_seq: number;
  projects: string[];
  authors: string[];
}

async function freePort(): Promise<number> {
  const socket = net.createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve())); return port;
}

test("owner search HTTP: whole-history snapshots and tenant-bound signed cursors", { timeout: 60_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-hosted-search-"));
  const baseURL = `http://127.0.0.1:${await freePort()}`;
  const options = { baseURL, directory, secret: randomBytes(32).toString("hex") };
  let preview = await createPreview(options); await preview.listen();
  const request = (path: string, opts: RequestInit = {}) => fetch(baseURL + path, { redirect: "manual", ...opts, headers: { connection: "close", ...opts.headers } });
  const post = (path: string, value: unknown, cookie?: string) => request(path, {
    method: "POST", headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value),
  });
  const signup = async (email: string) => {
    const response = await post("/api/auth/sign-up/email", { email, name: "Synthetic search tester", password: "synthetic-testing-password" });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    return { cookie, id: (await response.json()).user.id as string };
  };
  const search = (cookie: string, query: Record<string, string> = {}) => request("/api/journal/search?" + new URLSearchParams(query), { headers: { cookie } });
  const page = async (cookie: string, query: Record<string, string> = {}): Promise<SearchResponse> => {
    const response = await search(cookie, query); const value = await response.json(); assert.equal(response.status, 200, value.error); return value;
  };
  let alice!: Awaited<ReturnType<typeof signup>>, bob!: Awaited<ReturnType<typeof signup>>;
  let archived!: Entry, bobNote!: Entry, snapshotCursor = "", searchCursor = "";
  const completeText = 'SYNTHETIC CAFÉ—JARDIN archival running plan. Quote "blue tile". '.repeat(90).trim();
  try {
    await t.test("search requires an owner session and uses only its journal", async () => {
      assert.equal((await request("/api/journal/search?q=violet")).status, 401);
      assert.equal((await request("/api/journal/search", { headers: { authorization: "Bearer synthetic-invalid" } })).status, 401);
      alice = await signup("search-alice@example.test"); bob = await signup("search-bob@example.test");
      const a = Journal.open(preview.accounts.path(alice.id));
      try {
        archived = a.write({ text: completeText, actor: "archived-author", tags: ["project-archive"], pin: true, nowMs: 1_000 });
        a.writeMany(Array.from({ length: 107 }, (_, i) => ({ text: `SYNTHETIC violet cabinetry entry ${i}`, actor: i % 2 ? "claude" : "you", tags: [i % 2 ? "project-kitchen" : "project-kitchen-remodel"], nowMs: 1_000 })));
        a.write({ text: `SYNTHETIC mentions ${archived.id} and project-archive`, actor: "you" });
      } finally { a.close(); }
      const b = Journal.open(preview.accounts.path(bob.id));
      try { bobNote = b.write({ text: "SYNTHETIC Bob terracotta cabinetry", actor: "bob-only-author", tags: ["project-bob-only"] }); } finally { b.close(); }
      const first = await page(alice.cookie);
      assert.equal(first.entries.length, 15); assert.equal(first.total, 109); assert.equal(first.snapshot_seq, 109); assert.equal(first.matched_mode, "history");
      assert.deepEqual(first.projects, ["project-archive", "project-kitchen", "project-kitchen-remodel"]);
      assert.deepEqual(first.authors, ["archived-author", "claude", "you"]);
      assert.ok(first.next_cursor); snapshotCursor = first.next_cursor;
      assert.ok(!JSON.stringify(first).includes("bob-only"));
      assert.deepEqual((await page(bob.cookie)).entries, [bobNote]);
      assert.equal((await page(alice.cookie, { q: bobNote.id, mode: "id" })).total, 0);
      assert.equal((await page(bob.cookie, { q: archived.id, mode: "id" })).total, 0);
      const old = await (await request("/api/journal", { headers: { cookie: alice.cookie } })).json();
      assert.equal(old.count, 109); assert.equal(old.entries.length, 50); assert.ok(Array.isArray(old.connections));
    });
    await t.test("Show more reaches every original note once and preserves complete fields", async () => {
      const initial = await page(alice.cookie);
      const arriving = await post("/api/journal/notes", { text: "SYNTHETIC later arrival", tags: ["project-later"] }, alice.cookie);
      assert.equal(arriving.status, 201); const newEntry = await arriving.json();
      const entries = [...initial.entries]; let cursor = initial.next_cursor;
      while (cursor) {
        const next = await page(alice.cookie, { cursor });
        assert.equal(next.total, 109); assert.equal(next.snapshot_seq, 109); assert.ok(!next.projects.includes("project-later"));
        entries.push(...next.entries); cursor = next.next_cursor;
      }
      assert.equal(entries.length, 109); assert.equal(new Set(entries.map(entry => entry.id)).size, 109);
      assert.deepEqual(entries.map(entry => entry.seq), Array.from({ length: 109 }, (_, i) => 109 - i));
      assert.deepEqual(entries.at(-1), archived); assert.equal(entries.at(-1)?.text, completeText);
      const refreshed = await page(alice.cookie); assert.equal(refreshed.total, 110); assert.equal(refreshed.entries[0].id, newEntry.id);
    });
    await t.test("Words match across all history with exact project/author filters and explicit fallback", async () => {
      const first = await page(alice.cookie, { q: "violet cabinetry", limit: "12" });
      assert.equal(first.matched_mode, "all"); assert.equal(first.total, 107); assert.ok(first.next_cursor); searchCursor = first.next_cursor;
      const ids = first.entries.map(entry => entry.id); let cursor: string | null = first.next_cursor;
      while (cursor) {
        const next = await page(alice.cookie, { q: "violet cabinetry", limit: "12", cursor });
        assert.equal(next.matched_mode, "all"); assert.equal(next.total, 107); ids.push(...next.entries.map(entry => entry.id)); cursor = next.next_cursor;
      }
      assert.equal(ids.length, 107); assert.equal(new Set(ids).size, 107);
      const filtered = await page(alice.cookie, { q: "violet cabinetry", project: "project-kitchen", author: "claude" });
      assert.equal(filtered.total, 53); assert.ok(filtered.entries.every(entry => entry.actor === "claude" && entry.tags.includes("project-kitchen")));
      const archive = await page(alice.cookie, { project: "project-archive" });
      assert.deepEqual(archive.entries, [archived]); assert.equal(archive.next_cursor, null);
      assert.equal((await page(alice.cookie, { q: "running plans", mode: "words" })).matched_mode, "all");
      const fallback = await page(alice.cookie, { q: "violet absentword" });
      assert.equal(fallback.matched_mode, "any"); assert.equal(fallback.total, 107);
      assert.equal((await page(alice.cookie, { q: 'violet "OR" absentword' })).matched_mode, "any");
      assert.equal((await page(alice.cookie, { q: '* ")' })).total, 0);
    });
    await t.test("literal Unicode phrases and complete IDs retrieve old full text, not mentions", async () => {
      const phrase = await page(alice.cookie, { q: "cafe\u0301—jardin", mode: "exact" });
      assert.equal(phrase.matched_mode, "phrase"); assert.deepEqual(phrase.entries, [archived]);
      assert.equal((await page(alice.cookie, { q: "café jardin", mode: "exact" })).total, 0);
      const byId = await page(alice.cookie, { q: archived.id.toUpperCase(), mode: "id" });
      assert.equal(byId.matched_mode, "id"); assert.deepEqual(byId.entries, [archived]); assert.equal(byId.next_cursor, null);
      assert.equal((await page(alice.cookie, { q: archived.id, mode: "id", author: "you" })).total, 0);
      assert.equal((await search(alice.cookie, { q: archived.id.slice(0, 8), mode: "id" })).status, 400);
      assert.equal((await search(alice.cookie, { q: archived.hash, mode: "id" })).status, 400);
    });
    await t.test("cursors cannot be tampered, replayed by another owner, or reused for another search", async () => {
      const [payload, signature] = snapshotCursor.split(".");
      const state = JSON.parse(Buffer.from(payload, "base64url").toString());
      state.before = 999;
      const tampered = Buffer.from(JSON.stringify(state)).toString("base64url") + "." + signature;
      for (const cursor of [tampered, "invalid", "x".repeat(2049), snapshotCursor.slice(0, -1) + ".", ""]) {
        const response = await search(alice.cookie, { cursor }); assert.equal(response.status, 400); assert.match((await response.json()).error, /Refresh the journal/);
      }
      assert.equal((await search(bob.cookie, { cursor: snapshotCursor })).status, 400);
      const changedQueries: Record<string, string>[] = [{ q: "changed", cursor: snapshotCursor }, { q: "violet cabinetry", mode: "exact", cursor: searchCursor },
        { q: "violet cabinetry", project: "project-kitchen", cursor: searchCursor }, { q: "violet cabinetry", author: "you", cursor: searchCursor }];
      for (const query of changedQueries) {
        assert.equal((await search(alice.cookie, query)).status, 400);
      }
      await preview.close(); preview = await createPreview(options); await preview.listen();
      assert.equal((await search(alice.cookie, { cursor: snapshotCursor })).status, 200, "same-source restart preserves valid cursor");
    });
    await t.test("validation is bounded and reads do not append notes or alter the chain", async () => {
      const invalidQueries: Record<string, string>[] = [{ limit: "0" }, { limit: "51" }, { limit: "1.5" }, { limit: "" }, { limit: "999999999999999" },
        { q: "x".repeat(513) }, { mode: "meaning" }, { project: "kitchen" }, { author: "" }];
      for (const query of invalidQueries) {
        const response = await search(alice.cookie, query); assert.equal(response.status, 400);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const message = (await response.json()).error; assert.equal(typeof message, "string"); assert.ok(!message.includes(directory));
      }
      const journal = Journal.open(preview.accounts.path(alice.id));
      try { assert.equal(journal.count(), 110); assert.ok(journal.verify().ok); } finally { journal.close(); }
    });
    await t.test("deletion prevents search, recreation rejects the old cursor, and sign-out closes owner access", async () => {
      const response = await request("/api/journal", { method: "DELETE", headers: { cookie: alice.cookie, origin: baseURL } });
      assert.equal(response.status, 200);
      assert.equal((await search(alice.cookie)).status, 410);
      const tombstone = await (await request("/api/journal", { headers: { cookie: alice.cookie } })).json(); assert.equal(tombstone.deleted, true);
      assert.equal((await post("/api/journal/create", {}, alice.cookie)).status, 201);
      assert.equal((await page(alice.cookie)).total, 0);
      assert.equal((await search(alice.cookie, { cursor: snapshotCursor })).status, 400);
      assert.deepEqual((await page(bob.cookie)).entries, [bobNote]);
      assert.equal((await post("/api/auth/sign-out", {}, alice.cookie)).status, 200);
      assert.equal((await search(alice.cookie)).status, 401);
    });
  } finally { await preview.close(); rmSync(directory, { recursive: true, force: true }); }
});
