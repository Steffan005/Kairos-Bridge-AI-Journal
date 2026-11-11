// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Synthetic signed grants test the hosted write boundary, not a live provider chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { Journal } from "../../src/journal.js";
import { createStaging } from "../src/service.js";
import { CLAUDE_CONNECTOR_CLIENT_ID, CHATGPT_CONNECTOR_CLIENT_ID, CURSOR_CONNECTOR_CLIENT_ID, GROK_CONNECTOR_CLIENT_ID } from "../src/auth.js";
import { oauthWriteOrigin } from "../src/writeOrigin.js";

const baseURL = "https://journal.example.test";
const gemini = "https://accountlinking.google.com/clientidmetadata/user_bound_provider/user_bound_custom-mcp-123456789012345678901-journal_example_test";
const clients = [
  [CLAUDE_CONNECTOR_CLIENT_ID, "claude"], [CHATGPT_CONNECTOR_CLIENT_ID, "chatgpt"],
  [GROK_CONNECTOR_CLIENT_ID, "grok"], [gemini, "gemini"],
] as const;

test("provider attribution uses exact admitted client identities, never similar URLs or labels", () => {
  for (const [clientId, provider] of clients) {
    assert.equal(oauthWriteOrigin(clientId, baseURL).provider, provider);
    for (const lookalike of [clientId + "/", clientId + "?copy=1", clientId + "#fragment",
      clientId.replace("https://", "http://"), clientId.replace(new URL(clientId).hostname, new URL(clientId).hostname + ".evil.test"),
      clientId.replace("https://", "https://user@"), clientId.replace(new URL(clientId).hostname, new URL(clientId).hostname + ":443")]) {
      const stamp = oauthWriteOrigin(lookalike, baseURL);
      assert.equal(stamp.provider, null, lookalike);
      assert.equal(stamp.client_id, lookalike, "unrecognized identities are retained exactly");
    }
  }
  assert.equal(oauthWriteOrigin(CURSOR_CONNECTOR_CLIENT_ID, baseURL).provider, null);
  assert.equal(oauthWriteOrigin(CURSOR_CONNECTOR_CLIENT_ID, baseURL).client_id, CURSOR_CONNECTOR_CLIENT_ID);
  assert.equal(oauthWriteOrigin("Claude", baseURL).provider, null);
  assert.equal(oauthWriteOrigin("chatgpt", baseURL).provider, null);
  assert.equal(oauthWriteOrigin(gemini.replace("journal_example_test", "other_example_test"), baseURL).provider, null);
  assert.equal(oauthWriteOrigin(gemini, "http://journal.example.test").provider, null);
});

test("hosted writes record authenticated origins separately from supplied authors and preserve grant controls", { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-write-origin-"));
  const socket = net.createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const invitation = randomBytes(32).toString("hex");
  const service = await createStaging({ baseURL, directory, port, secret: randomBytes(32).toString("hex"), inviteCode: invitation, sourceRevision: "a".repeat(40) });
  await service.listen();
  // Simulates a trusted HTTPS edge over local HTTP. No remote metadata or live credentials.
  const request = (path: string, opts: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
    const headers = new Headers({ host: "journal.example.test", "x-forwarded-proto": "https", connection: "close", ...opts.headers });
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method: opts.method ?? "GET", headers: Object.fromEntries(headers) }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }));
      }); res.on("error", reject);
    }); req.on("error", reject); req.end(opts.body?.toString());
  });
  const post = (path: string, input: unknown, cookie?: string) => request(path, { method: "POST", headers: { "content-type": "application/json", origin: baseURL, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(input) });
  const call = (token: string, name: string, args: Record<string, unknown>) => request("/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  try {
    const signup = await post("/api/auth/sign-up/email", { email: "origin-fixture@example.test", name: "Synthetic test", password: "synthetic-write-origin-password", invite_code: invitation });
    assert.equal(signup.status, 200);
    const userId = (await signup.json()).user.id;
    const cookie = signup.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const account = service.accounts.get(userId);
    const legacyJournal = Journal.open(service.accounts.path(userId));
    const legacy = legacyJournal.write({ text: "SYNTHETIC earlier entry with declared author only", actor: "claude" });
    legacyJournal.close();
    assert.equal(legacy.write_origin, undefined);
    const { adapter } = await service.auth.$context;
    // Seed synthetic client/consent records, then use real issuer signatures and
    // production verifyGrant on every HTTP request. CIMD onboarding is exercised
    // by the independent provider authorization acceptance tests.
    const grant = async (clientId: string, scopes = ["journal:read", "journal:write"]) => {
      await adapter.create({ model: "oauthClient", data: { clientId, name: "Claude", redirectUris: ["https://synthetic.example.test/callback"], disabled: false, createdAt: new Date(), updatedAt: new Date() } });
      await adapter.create({ model: "oauthConsent", data: { clientId, userId, scopes, createdAt: new Date(), updatedAt: new Date() } });
      const { token } = await service.auth.api.signJWT({ body: { payload: {
        iss: baseURL + "/api/auth", aud: baseURL + "/mcp", sub: userId, azp: clientId,
        scope: scopes.join(" "), kairos_epoch: account.epoch, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900,
      } } });
      return token;
    };
    const tokens = new Map<string, string>();
    const saved: Array<{ id: string; write_origin?: unknown }> = [];
    await t.test("all four known grants preserve declared authors but stamp the actual client", async () => {
      for (const [clientId, provider] of clients) {
        const token = await grant(clientId); tokens.set(clientId, token);
        const before = Date.now();
        const response = await call(token, "journal_write", { text: `SYNTHETIC ${provider} transport with another declared author`, actor: "gemini_word", tags: ["project-origin"] });
        assert.equal(response.status, 200);
        const result = (await response.json()).result; assert.ok(!result.isError, result.content[0].text);
        const entry = JSON.parse(result.content[0].text).entry; saved.push(entry);
        assert.equal(entry.actor, "gemini_word");
        assert.deepEqual(entry.write_origin, { version: 1, channel: "oauth", client_id: clientId, provider, received_at: entry.write_origin.received_at });
        assert.ok(Date.parse(entry.write_origin.received_at) >= before && Date.parse(entry.write_origin.received_at) <= Date.now());
      }
    });
    await t.test("unknown client display name and forged caller origin cannot impersonate a provider", async () => {
      const clientId = "synthetic-client-with-claude-name";
      const token = await grant(clientId); tokens.set(clientId, token);
      const forged = { version: 1, channel: "oauth", client_id: CLAUDE_CONNECTOR_CLIENT_ID, provider: "claude", received_at: "2000-01-01T00:00:00.000Z" };
      const response = await call(token, "journal_write", { text: "SYNTHETIC unknown connector", actor: "Claude", write_origin: forged, writeOrigin: forged });
      assert.equal(response.status, 200);
      const result = (await response.json()).result;
      // A future stricter input schema may reject the extra fields; it must never
      // allow them to control the authenticated origin.
      if (!result.isError) {
        const entry = JSON.parse(result.content[0].text).entry; saved.push(entry);
        assert.equal(entry.actor, "claude"); assert.equal(entry.write_origin.channel, "oauth");
        assert.equal(entry.write_origin.client_id, clientId); assert.equal(entry.write_origin.provider, null);
        assert.notEqual(entry.write_origin.received_at, forged.received_at);
      }
      const ordinary = await call(token, "journal_write", { text: "SYNTHETIC ordinary unknown connector", actor: "ChatGPT" });
      const ordinaryResult = (await ordinary.json()).result; assert.ok(!ordinaryResult.isError);
      const entry = JSON.parse(ordinaryResult.content[0].text).entry; saved.push(entry);
      assert.equal(entry.write_origin.client_id, clientId); assert.equal(entry.write_origin.provider, null);
      const spoofedHeader = await request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://claude.ai", "content-type": "application/json" }, body: "{}" });
      assert.equal(spoofedHeader.status, 403);
    });
    await t.test("native owner writes have an owner stamp and exports retain all origin fields", async () => {
      const forged = { version: 1, channel: "oauth", client_id: GROK_CONNECTOR_CLIENT_ID, provider: "grok", received_at: "2000-01-01T00:00:00.000Z" };
      const response = await post("/api/journal/notes", { text: "SYNTHETIC owner note", actor: "Grok", tags: ["project-origin"],
        continuity: { version: 1, role: "goal", actor_id: "gpt_codex" }, write_origin: forged, writeOrigin: forged }, cookie);
      assert.equal(response.status, 201); const entry = await response.json(); saved.push(entry);
      assert.equal(entry.actor, "you");
      assert.deepEqual(entry.continuity, { version: 1, role: "goal", actor_id: "gpt_codex" });
      assert.deepEqual(entry.write_origin, { version: 1, channel: "owner", client_id: null, provider: null, received_at: entry.write_origin.received_at });
      const invalid = await post("/api/journal/notes", { text: "SYNTHETIC invalid owner metadata", tags: ["project-origin"], continuity: { version: 1, role: "fabricated-role" } }, cookie);
      assert.equal(invalid.status, 400, "the engine validates owner-supplied continuity before append");
      const exported = await request("/api/journal/export", { headers: { cookie } }); assert.equal(exported.status, 200);
      const data = await exported.json();
      for (const entry of saved) assert.deepEqual(data.entries.find((row: { id: string }) => row.id === entry.id).write_origin, entry.write_origin);
      assert.deepEqual(data.entries.find((row: { id: string }) => row.id === legacy.id), legacy);
      assert.doesNotMatch(JSON.stringify(data), /origin-fixture@example\.test|synthetic-write-origin-password|Bearer /);
      for (const token of tokens.values()) assert.ok(!JSON.stringify(data).includes(token));
    });
    await t.test("read-only grants and revoked connections cannot create entries", async () => {
      const token = await grant("synthetic-readonly-client", ["journal:read"]);
      const readCount = () => { const journal = Journal.openReadOnly(service.accounts.path(userId)); try { return journal.count(); } finally { journal.close(); } };
      const count = readCount();
      const denied = await call(token, "journal_write", { text: "SYNTHETIC forbidden write", actor: "Claude" });
      assert.equal(denied.status, 200); const body = await denied.json(); assert.ok(body.error || body.result?.isError);
      assert.equal(readCount(), count);
      assert.equal((await post("/api/journal/disconnect", {}, cookie)).status, 200);
      assert.equal((await call(tokens.get(CLAUDE_CONNECTOR_CLIENT_ID)!, "journal_write", { text: "SYNTHETIC revoked write" })).status, 401);
      assert.equal((await call(token, "journal_write", { text: "SYNTHETIC revoked readonly write" })).status, 401);
      assert.equal(readCount(), count);
      const journal = Journal.openReadOnly(service.accounts.path(userId));
      try { assert.ok(journal.verify().ok); assert.deepEqual(journal.get(legacy.id), legacy); } finally { journal.close(); }
    });
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
