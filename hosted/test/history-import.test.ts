// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { createPreview } from "../src/service.js";
import { Journal, type Entry, type HistoricalRecord } from "../../src/journal.js";
import { MAX_HISTORY_IMPORT_BODY } from "../src/historyImport.js";

async function freePort(): Promise<number> {
  const socket = net.createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve())); return port;
}
const record = (id: string, date = "2026-01-02T12:30:00"): HistoricalRecord => ({
  source_store: "synthetic-legacy-kairos", source_id: id, original_timestamp: date,
  original_actor: "Dr. Claude Summers", source_file_sha256: "a".repeat(64), canonical_actor: "claude_summers",
  timezone: "unspecified", text: `SYNTHETIC recovered historical memory ${id}`, kind: "note", tags: ["project-archive"],
  source_metadata: { lane: "self", source_record_sha256: "b".repeat(64), original_parents: ["parent-synthetic"] },
});

test("owner history import: atomic, isolated, replayable provenance without changing current notes or grants", { timeout: 90_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-hosted-history-import-"));
  const baseURL = `http://127.0.0.1:${await freePort()}`;
  const options = { baseURL, directory, secret: randomBytes(32).toString("hex") };
  let preview = await createPreview(options); await preview.listen();
  const request = (path: string, opts: RequestInit = {}) => fetch(baseURL + path, { redirect: "manual", ...opts, headers: { connection: "close", ...opts.headers } });
  const post = (path: string, value: unknown, cookie?: string) => request(path, { method: "POST", headers: {
    origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}),
  }, body: JSON.stringify(value) });
  const signup = async (email: string) => {
    const response = await post("/api/auth/sign-up/email", { email, name: "Synthetic import tester", password: "synthetic-testing-password" });
    assert.equal(response.status, 200);
    return { cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; "), id: (await response.json()).user.id as string };
  };
  const importBatch = (cookie: string, records: unknown) => post("/api/journal/import-history", { records }, cookie);
  const state = async (cookie: string) => {
    const response = await request("/api/journal", { headers: { cookie } }); assert.equal(response.status, 200); return response.json();
  };
  const journalSnapshot = (id: string) => {
    const journal = Journal.open(preview.accounts.path(id));
    try { return { count: journal.count(), head: journal.verify().headHash, ok: journal.verify().ok }; }
    finally { journal.close(); }
  };
  let alice!: Awaited<ReturnType<typeof signup>>, bob!: Awaited<ReturnType<typeof signup>>;
  let current!: Entry, token = "", originalConnections: unknown, originalAccount: unknown;
  let importedIds: string[] = [];
  try {
    await t.test("owner session is required and the importing account is never supplied by the payload", async () => {
      assert.equal((await post("/api/journal/import-history", { records: [record("one")] })).status, 401);
      assert.equal((await request("/api/journal/import-history", { method: "POST", headers: { origin: baseURL, authorization: "Bearer invalid", "content-type": "application/json" }, body: JSON.stringify({ records: [record("one")] }) })).status, 401);
      alice = await signup("history-alice@example.test"); bob = await signup("history-bob@example.test");
      const saved = await post("/api/journal/notes", { text: "SYNTHETIC current note remains intact", tags: ["project-current"] }, alice.cookie);
      assert.equal(saved.status, 201); current = await saved.json();
      const spoof = await post("/api/journal/import-history", { records: [record("one")], user_id: bob.id }, alice.cookie);
      assert.equal(spoof.status, 400); assert.equal(journalSnapshot(alice.id).count, 1); assert.equal(journalSnapshot(bob.id).count, 0);
    });
    await t.test("same-origin mutation protection rejects missing and hostile Origin", async () => {
      for (const origin of [undefined, "https://hostile.example.test"]) {
        const response = await request("/api/journal/import-history", { method: "POST", headers: { cookie: alice.cookie, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ records: [record("one")] }) });
        assert.equal(response.status, 403);
      }
      assert.equal(journalSnapshot(alice.id).count, 1);
    });
    await t.test("a real approved AI bearer cannot call the owner import route or an import tool", async () => {
      const redirectUri = "https://synthetic-import-ai.example.test/callback";
      const registered = await post("/api/auth/oauth2/register", { client_name: "Synthetic import boundary AI", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "journal:read journal:write offline_access" });
      assert.equal(registered.status, 201); const client = await registered.json();
      const verifier = randomBytes(32).toString("base64url");
      const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", scope: "journal:read journal:write offline_access", resource: baseURL + "/mcp", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "synthetic", prompt: "consent" });
      const authorize = await request("/api/auth/oauth2/authorize?" + query, { mode: "same-origin", headers: { cookie: alice.cookie, accept: "text/html" } });
      assert.equal(authorize.status, 302); const consent = new URL(authorize.headers.get("location")!, baseURL);
      assert.equal(consent.pathname, "/consent");
      const approved = await post("/api/auth/oauth2/consent", { accept: true, oauth_query: consent.search.slice(1) }, alice.cookie);
      assert.equal(approved.status, 200); const code = new URL((await approved.json()).url).searchParams.get("code")!;
      const exchanged = await request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri, code, code_verifier: verifier, resource: baseURL + "/mcp" }) });
      assert.equal(exchanged.status, 200); token = (await exchanged.json()).access_token; assert.ok(token);
      const denied = await request("/api/journal/import-history", { method: "POST", headers: { authorization: `Bearer ${token}`, origin: baseURL, "content-type": "application/json" }, body: JSON.stringify({ records: [record("one")] }) });
      assert.equal(denied.status, 401);
      const tools = await request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      assert.equal(tools.status, 200); assert.ok(!(await tools.json()).result.tools.some((tool: { name: string }) => /import/i.test(tool.name)));
      originalConnections = (await state(alice.cookie)).connections; originalAccount = { ...preview.accounts.get(alice.id) };
    });
    await t.test("batches preserve original attribution, dates, signed current entries and approvals", async () => {
      const response = await importBatch(alice.cookie, [record("one"), record("two", "2025-11-10T07:00:00")]);
      assert.equal(response.status, 200); const output = await response.json(); assert.equal(output.inserted, 2); assert.equal(output.skipped, 0); importedIds = output.ids;
      assert.equal(importedIds.length, 2);
      const snapshot = await state(alice.cookie);
      assert.equal(snapshot.count, 3); assert.deepEqual(snapshot.entries[0], current, "older imports do not displace the current note in the legacy envelope");
      assert.deepEqual(snapshot.connections, originalConnections); assert.deepEqual(preview.accounts.get(alice.id), originalAccount);
      const imported = snapshot.entries.find((entry: Entry) => entry.id === importedIds[0]);
      assert.equal(imported.actor, "claude"); assert.ok(imported.created_at.startsWith("2026-01-02T12:30:00"));
      assert.equal(imported.provenance.original_actor, "Dr. Claude Summers"); assert.equal(imported.provenance.original_timestamp, "2026-01-02T12:30:00");
      assert.equal(imported.provenance.timezone, "unspecified"); assert.equal(imported.provenance.imported_by, "owner");
      assert.equal(imported.provenance.canonical_actor, "claude_summers"); assert.deepEqual(imported.provenance.source_metadata, record("one").source_metadata);
      assert.ok(imported.provenance.imported_at.endsWith("Z")); assert.equal(imported.provenance.source_file_sha256, "a".repeat(64));
      const read = await request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "journal_continue", arguments: { project: "current" } } }) });
      assert.equal(read.status, 200); assert.match(JSON.stringify(await read.json()), /current note remains intact/);
      const exported = await request("/api/journal/export", { headers: { cookie: alice.cookie } });
      assert.equal(exported.status, 200); const exportText = await exported.text(); assert.match(exportText, /original_timestamp/); assert.match(exportText, /Dr. Claude Summers/);
      assert.equal(journalSnapshot(alice.id).ok, true); assert.equal(journalSnapshot(bob.id).count, 0);
    });
    await t.test("replaying a batch is idempotent, including after restart", async () => {
      const before = journalSnapshot(alice.id);
      await preview.close(); preview = await createPreview(options); await preview.listen();
      const replay = await importBatch(alice.cookie, [record("one"), record("two", "2025-11-10T07:00:00")]);
      assert.equal(replay.status, 200); const output = await replay.json(); assert.equal(output.inserted, 0); assert.equal(output.skipped, 2); assert.deepEqual(output.ids, importedIds);
      assert.deepEqual(journalSnapshot(alice.id), before);
      assert.deepEqual((await state(alice.cookie)).connections, originalConnections);
    });
    await t.test("conflicts roll the whole transaction back and return no source text", async () => {
      const before = journalSnapshot(alice.id);
      const response = await importBatch(alice.cookie, [record("would-be-new"), { ...record("one"), text: "SYNTHETIC CONFLICT PRIVATE TEXT" }]);
      assert.equal(response.status, 409); const text = await response.text(); assert.doesNotMatch(text, /PRIVATE TEXT|synthetic-legacy|history-alice|\.db/);
      assert.deepEqual(journalSnapshot(alice.id), before);
    });
    await t.test("unknown fields, malformed metadata and oversized batches are rejected without writes", async () => {
      const before = journalSnapshot(alice.id);
      const candidates: unknown[] = [[], Array.from({ length: 51 }, (_, i) => record(`too-many-${i}`)),
        [{ ...record("bad"), metadata: { access_token: "not-accepted" } }], [{ ...record("bad"), imported_by: "spoofed" }],
        [{ ...record("bad"), source_file_sha256: "BAD" }], [{ ...record("bad"), text: "x".repeat(8001) }],
        [{ ...record("bad"), source_metadata: { password: "unsupported" } }], [{ ...record("bad"), source_metadata: { lane: { nested: "unsupported" } } }],
        [{ ...record("bad"), source_metadata: { original_parents: Array.from({ length: 33 }, () => "parent") } }],
        [{ ...record("bad"), tags: ["x".repeat(49)] }], [{ ...record("bad"), timezone: "+99:99" }],
        [{ ...record("bad"), original_timestamp: "2026-02-30T12:00:00" }], [{ ...record("bad"), canonical_actor: 5 }],
        [record("valid-first"), { ...record("bad-second"), text: null }]];
      for (const candidate of candidates) {
        const response = await importBatch(alice.cookie, candidate); assert.equal(response.status, 400);
        assert.doesNotMatch(await response.text(), /not-accepted|synthetic-legacy|\.db/);
      }
      assert.deepEqual(journalSnapshot(alice.id), before);
    });
    await t.test("only this route gets the larger body cap; server timeouts are retained", async () => {
      const before = journalSnapshot(alice.id);
      const large = Array.from({ length: 10 }, (_, i) => ({ ...record(`large-${i}`), text: `SYNTHETIC large ${i} ` + "x".repeat(7300) }));
      const response = await importBatch(alice.cookie, large); assert.equal(response.status, 200);
      assert.equal((await response.json()).inserted, 10); assert.equal(journalSnapshot(alice.id).count, before.count + 10);
      const oversized = await request("/api/journal/import-history", { method: "POST", headers: { cookie: alice.cookie, origin: baseURL, "content-type": "application/json" }, body: " ".repeat(MAX_HISTORY_IMPORT_BODY + 1) });
      assert.equal(oversized.status, 413);
      const ordinary = await post("/api/journal/notes", { text: "x".repeat(70_000) }, alice.cookie); assert.equal(ordinary.status, 413);
      assert.equal(preview.server.requestTimeout, 15_000); assert.equal(preview.server.headersTimeout, 10_000);
    });
    await t.test("v2 chronology cursors keep owner and tamper checks", async () => {
      const first = await request("/api/journal/search?limit=1", { headers: { cookie: alice.cookie } }); assert.equal(first.status, 200);
      const value = await first.json(); assert.equal(value.entries[0].id, current.id); assert.ok(value.next_cursor);
      const [payload, signature] = value.next_cursor.split(".");
      const cursor = JSON.parse(Buffer.from(payload, "base64url").toString()); assert.equal(cursor.version, 2);
      cursor.before_date = "9999-01-01T00:00:00.000";
      const tampered = Buffer.from(JSON.stringify(cursor)).toString("base64url") + "." + signature;
      for (const [cookie, wire] of [[alice.cookie, tampered], [bob.cookie, value.next_cursor]]) {
        assert.equal((await request("/api/journal/search?limit=1&cursor=" + encodeURIComponent(wire), { headers: { cookie } })).status, 400);
      }
      const lateImport = await importBatch(alice.cookie, [record("arrives-after-snapshot", "2026-10-01T12:00:00")]); assert.equal(lateImport.status, 200);
      const lateId = (await lateImport.json()).ids[0];
      const seen = [value.entries[0].id]; let next = value.next_cursor;
      while (next) {
        const response = await request("/api/journal/search?limit=1&cursor=" + encodeURIComponent(next), { headers: { cookie: alice.cookie } }); assert.equal(response.status, 200);
        const page = await response.json(); assert.equal(page.total, value.total); seen.push(...page.entries.map((entry: Entry) => entry.id)); next = page.next_cursor;
      }
      assert.equal(seen.length, value.total); assert.equal(new Set(seen).size, value.total); assert.ok(!seen.includes(lateId), "snapshot excludes later imports with old source dates");
    });
    await t.test("a deleted journal cannot be repopulated by import; other owners remain isolated", async () => {
      const deleteResponse = await request("/api/journal", { method: "DELETE", headers: { cookie: alice.cookie, origin: baseURL } }); assert.equal(deleteResponse.status, 200);
      assert.equal((await importBatch(alice.cookie, [record("deleted-cannot-import")])).status, 410);
      assert.equal((await state(alice.cookie)).deleted, true);
      const bobImport = await importBatch(bob.cookie, [record("one")]); assert.equal(bobImport.status, 200); assert.equal((await bobImport.json()).inserted, 1);
      assert.equal((await state(bob.cookie)).count, 1);
      assert.equal((await post("/api/journal/create", {}, alice.cookie)).status, 201); assert.equal((await state(alice.cookie)).count, 0);
    });
  } finally { await preview.close(); rmSync(directory, { recursive: true, force: true }); }
});
