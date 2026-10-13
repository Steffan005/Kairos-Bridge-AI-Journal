// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPreview } from "../src/service.js";
import { Journal } from "../../src/journal.js";

async function freePort(): Promise<number> {
  const s = net.createServer(); await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(r => s.close(() => r())); return port;
}
test("private journal preview: real OAuth and two isolated synthetic users", { timeout: 90_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-hosted-acceptance-"));
  const baseURL = `http://127.0.0.1:${await freePort()}`;
  const secret = randomBytes(32).toString("hex");
  let preview = await createPreview({ baseURL, directory, secret });
  await preview.listen();
  const request = (path: string, opts: RequestInit = {}) => fetch(baseURL + path, { redirect: "manual", ...opts, headers: { connection: "close", ...opts.headers } });
  const post = (path: string, value: unknown, cookie?: string) => request(path, {
    method: "POST", headers: { "content-type": "application/json", origin: baseURL, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value),
  });
  const cookieFrom = (r: Response) => r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const signup = async (email: string) => {
    const r = await post("/api/auth/sign-up/email", { email, password: "synthetic-testing-password", name: "Synthetic tester" });
    assert.equal(r.status, 200, "account creation should succeed");
    const cookie = cookieFrom(r); assert.ok(cookie); return { cookie, user: (await r.json()).user };
  };
  const register = async () => {
    const r = await post("/api/auth/oauth2/register", {
      client_name: "Synthetic AI client", redirect_uris: ["https://synthetic-ai.example.test/callback"],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], scope: "journal:read journal:write offline_access",
    });
    const result = await r.json();
    assert.equal(r.status, 201, "dynamic registration should succeed: " + (result.error_description ?? result.message ?? result.error ?? "")); return result;
  };
  const startAuthorization = async (client: { client_id: string }, cookie?: string, scopes = "journal:read journal:write offline_access") => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://synthetic-ai.example.test/callback", response_type: "code", scope: scopes,
      resource: baseURL + "/mcp", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "synthetic-state", prompt: "consent" });
    const r = await request("/api/auth/oauth2/authorize?" + query, { mode: "same-origin", headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });
    assert.equal(r.status, 302, "authorization should redirect");
    return { verifier, redirect: new URL(r.headers.get("location")!, baseURL) };
  };
  const tokenExchange = async (clientId: string, code: string, verifier: string) => request("/api/auth/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: "https://synthetic-ai.example.test/callback", code, code_verifier: verifier, resource: baseURL + "/mcp" }),
  });
  const authorize = async (client: { client_id: string }, cookie: string, scopes?: string) => {
    const started = await startAuthorization(client, cookie, scopes);
    assert.equal(started.redirect.pathname, "/consent");
    const page = await request(started.redirect.pathname + started.redirect.search, { headers: { cookie } });
    assert.equal(page.status, 200, "signed consent request renders");
    const r = await post("/api/auth/oauth2/consent", { accept: true, oauth_query: started.redirect.search.slice(1) }, cookie);
    assert.equal(r.status, 200, "owner approves scopes");
    const target = new URL((await r.json()).url);
    assert.equal(target.searchParams.get("state"), "synthetic-state");
    const code = target.searchParams.get("code")!;
    const exchanged = await tokenExchange(client.client_id, code, started.verifier);
    assert.equal(exchanged.status, 200, "PKCE code exchange succeeds");
    const token = await exchanged.json(); assert.ok(token.access_token); return { ...token, code, verifier: started.verifier };
  };
  const mcpRequest = (token?: string, name = "journal_search", args: Record<string, unknown> = { query: "kitchen" }) => request("/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await mcpRequest(token, name, args); assert.equal(r.status, 200); return (await r.json()).result;
  };
  const sdk = async (token: string) => {
    const client = new Client({ name: "Synthetic AI client", version: "1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseURL + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } })); return client;
  };
  try {
    let a!: Awaited<ReturnType<typeof signup>>, b!: Awaited<ReturnType<typeof signup>>, client!: Awaited<ReturnType<typeof register>>;
    let at!: Awaited<ReturnType<typeof authorize>>, bt!: Awaited<ReturnType<typeof authorize>>, ro!: Awaited<ReturnType<typeof authorize>>;
    let aNoteId = "", bNoteId = "";
    await t.test("account and metadata endpoints; reject real email and unsigned access", async () => {
      assert.equal((await post("/api/auth/sign-up/email", { email: "real@example.com", name: "Real", password: "synthetic-testing-password" })).status, 400);
      a = await signup("alice@example.test"); b = await signup("bob@example.test"); assert.notEqual(a.user.id, b.user.id);
      client = await register();
      const metadata = await (await request("/.well-known/oauth-authorization-server/api/auth")).json();
      assert.equal(metadata.issuer, baseURL + "/api/auth"); assert.equal(metadata.code_challenge_methods_supported[0], "S256");
      const noAccess = await mcpRequest(); assert.equal(noAccess.status, 401); assert.match(noAccess.headers.get("www-authenticate")!, /resource_metadata/); assert.match(noAccess.headers.get("www-authenticate")!, /scope="journal:read journal:write offline_access"/);
      assert.equal((await request("/api/journal")).status, 401);
      assert.equal((await request("/api/journal", { headers: { origin: "https://hostile.example" } })).status, 403);
      assert.equal((await request("/consent?client_id=changed", { headers: { cookie: a.cookie } })).status, 400);
    });
    await t.test("sign-in round trip continues to a signed consent request", async () => {
      const started = await startAuthorization(client);
      assert.equal(started.redirect.pathname, "/sign-in");
      const response = await post("/api/auth/sign-in/email", { email: "alice@example.test", password: "synthetic-testing-password", oauth_query: started.redirect.search.slice(1) });
      assert.equal(response.status, 200); const signedIn = await response.json();
      assert.ok(signedIn.url, "provider continues OAuth after sign-in"); assert.equal(new URL(signedIn.url, baseURL).pathname, "/consent");
      a.cookie = cookieFrom(response);
    });
    await t.test("explicit consent, PKCE exchange, and rejection of replayed codes", async () => {
      at = await authorize(client, a.cookie); bt = await authorize(client, b.cookie, "openid journal:read journal:write offline_access");
      assert.equal((await tokenExchange(client.client_id, at.code, at.verifier)).status, 400);
      const pending = await startAuthorization(client, a.cookie, "journal:read");
      const rejected = await post("/api/auth/oauth2/consent", { accept: false, oauth_query: pending.redirect.search.slice(1) }, a.cookie);
      const target = new URL((await rejected.json()).url); assert.equal(target.searchParams.get("error"), "access_denied"); assert.equal(target.searchParams.get("code"), null);
      const claims = decodeJwt(at.access_token); assert.equal(claims.sub, a.user.id); assert.equal(claims.kairos_epoch, 1); assert.ok(claims.sid);
    });
    await t.test("real MCP SDK handshake, write and fresh-client project retrieval", async () => {
      const aClient = await sdk(at.access_token);
      assert.ok((await aClient.listTools()).tools.some(t => t.name === "journal_continue"));
      assert.ok(!(await aClient.listTools()).tools.some(t => t.name === "journal_export"));
      const result = await aClient.callTool({ name: "journal_write", arguments: { text: "SYNTHETIC: Alice kitchen tile is cobalt blue", tags: ["project-kitchen"], actor: "Claude" } });
      assert.ok(!result.isError); const content = result.content as Array<{ text: string }>;
      aNoteId = JSON.parse(content[0].text).entry.id; assert.ok(aNoteId); await aClient.close();
      const resumed = await sdk(at.access_token);
      const continuation = await resumed.callTool({ name: "journal_continue", arguments: { project: "kitchen" } });
      assert.match(JSON.stringify(continuation), /cobalt blue/); assert.match(JSON.stringify(continuation), /claude/); assert.match(JSON.stringify(continuation), /2026/);
      await resumed.close();
      const bob = await tool(bt.access_token, "journal_write", { text: "SYNTHETIC: Bob kitchen tile is terracotta", tags: ["project-kitchen"], actor: "ChatGPT" });
      bNoteId = JSON.parse(bob.content[0].text).entry.id;
    });
    await t.test("tenant isolation for read, search, write, pin, unpin, verify and export", async () => {
      await tool(at.access_token, "journal_pin", { id: aNoteId });
      const ownerView = await (await request("/api/journal", { headers: { cookie: a.cookie } })).json();
      assert.equal(ownerView.entries.filter((entry: { id: string }) => entry.id === aNoteId).length, 1, "a pinned recent entry appears once in the owner's journal");
      for (const name of ["journal_wake", "journal_search", "journal_continue", "journal_verify"]) {
        const args = name === "journal_search" ? { query: "terracotta" } : name === "journal_continue" ? { project: "kitchen" } : {};
        const result = await tool(at.access_token, name, { ...args, owner_id: b.user.id });
        assert.doesNotMatch(JSON.stringify(result), /Bob kitchen tile is terracotta/);
        if (name === "journal_search") assert.equal(JSON.parse(result.content[0].text).count, 0);
      }
      for (const name of ["journal_pin", "journal_unpin"]) {
        const result = await tool(at.access_token, name, { id: bNoteId, owner_id: b.user.id }); assert.ok(result.isError);
      }
      await tool(at.access_token, "journal_write", { text: "Alice attempted tenant redirect", actor: b.user.id, owner_id: b.user.id, tags: ["project-kitchen"] });
      assert.doesNotMatch(JSON.stringify(await tool(bt.access_token, "journal_wake")), /attempted tenant redirect|cobalt blue/);
      const exported = await request("/api/journal/export?owner_id=" + b.user.id, { headers: { cookie: a.cookie } });
      assert.equal(exported.status, 200); assert.match(exported.headers.get("content-disposition")!, /attachment/);
      const data = await exported.json(); assert.equal(data.entry_count, 2); assert.doesNotMatch(JSON.stringify(data), /terracotta|journal-.*\.db/);
      assert.equal((await request("/api/journal/export", { headers: { authorization: `Bearer ${at.access_token}` } })).status, 401);
      assert.equal((await post("/api/journal/notes", { text: "Owner note" }, a.cookie)).status, 201);
      assert.equal((await request("/api/journal/notes", { method: "POST", headers: { cookie: a.cookie, "content-type": "application/json" }, body: '{"text":"CSRF"}' })).status, 403);
      const db = Journal.open(preview.accounts.path(b.user.id)); try { assert.equal(db.count(), 1); assert.ok(db.verify().ok); } finally { db.close(); }
    });
    await t.test("read-only discovery and direct write calls are denied", async () => {
      const readonlyClient = await register(); ro = await authorize(readonlyClient, a.cookie, "journal:read");
      const c = await sdk(ro.access_token); const tools = (await c.listTools()).tools.map(t => t.name);
      for (const name of ["journal_write", "journal_pin", "journal_unpin", "journal_export"]) {
        assert.ok(!tools.includes(name)); const result = await tool(ro.access_token, name, { text: "Forbidden", id: aNoteId, path: "/tmp/forbidden" });
        assert.ok(result === undefined || result.isError, "unknown/disabled tool cannot perform a write");
      }
      await c.close();
    });
    await t.test("invalid signatures and resource-bound access are rejected", async () => {
      assert.equal((await mcpRequest(at.access_token.slice(0, -10) + "invalidsig")).status, 401);
      assert.equal((await mcpRequest("not-a-jwt")).status, 401);
      const payload = decodeJwt(at.access_token);
      const valid = await preview.auth.api.signJWT({ body: { payload } });
      assert.equal((await mcpRequest(valid.token)).status, 200, "control token signed with the same claims is valid");
      for (const override of [{ iss: "https://another-issuer.example" }, { aud: "https://another-resource.example" }, { exp: 1 }, { azp: "nonexistent-client" }, { kairos_epoch: 999 }, { scope: "journal:write" }]) {
        // Sign with the actual server's key, so this tests claims rather than just a broken signature.
        const signed = await preview.auth.api.signJWT({ body: { payload: { ...payload, ...override } } });
        for (const [key, value] of Object.entries(override)) assert.deepEqual(decodeJwt(signed.token)[key], value);
        assert.ok([401, 403].includes((await mcpRequest(signed.token)).status));
      }
      assert.equal((await post("/api/auth/token", {})).status, 404);
    });
    await t.test("wrong PKCE verifier and unapproved scope escalation cannot issue access", async () => {
      const pending = await startAuthorization(client, a.cookie);
      const approved = await post("/api/auth/oauth2/consent", { accept: true, oauth_query: pending.redirect.search.slice(1) }, a.cookie);
      const code = new URL((await approved.json()).url).searchParams.get("code")!;
      assert.equal((await tokenExchange(client.client_id, code, randomBytes(32).toString("base64url"))).status, 401);
      const readonlyClient = await register(); const read = await startAuthorization(readonlyClient, a.cookie, "journal:read");
      const escalated = await post("/api/auth/oauth2/consent", { accept: true, scope: "journal:read journal:write", oauth_query: read.redirect.search.slice(1) }, a.cookie);
      assert.equal(escalated.status, 400);
    });
    await t.test("restart preserves accounts, authorization keys and each journal", async () => {
      await preview.close(); preview = await createPreview({ baseURL, directory, secret }); await preview.listen();
      assert.match(JSON.stringify(await tool(at.access_token, "journal_continue", { project: "kitchen" })), /cobalt blue/);
      assert.match(JSON.stringify(await tool(bt.access_token, "journal_continue", { project: "kitchen" })), /terracotta/);
    });
    await t.test("browser sign-out and expiry preserve approved AI access; refresh retries reuse the response", async () => {
      // The earlier deliberate authorization-code replay revoked that code's refresh token.
      // Use a new, unreplayed grant to isolate the sign-out behavior.
      at = await authorize(client, a.cookie);
      const { adapter } = await preview.auth.$context;
      assert.ok(at.refresh_token, "offline grant includes a refresh token");
      const rowsBefore = await adapter.findMany<{ userId: string; clientId: string; scopes: string[] }>({ model: "oauthRefreshToken", where: [{ field: "userId", value: a.user.id }] });
      assert.ok(rowsBefore.some(r => r.clientId === client.client_id && r.scopes.includes("offline_access")));
      const bobSession = decodeJwt(bt.access_token).sid as string;
      await adapter.update({ model: "session", where: [{ field: "id", value: bobSession }], update: { expiresAt: new Date(1) } });
      assert.equal((await mcpRequest(bt.access_token)).status, 200, "expired browser session is not an AI disconnect");
      await adapter.update({ model: "session", where: [{ field: "id", value: bobSession }], update: { expiresAt: new Date(Date.now() + 86_400_000) } });
      assert.equal((await post("/api/auth/sign-out", {}, a.cookie)).status, 200);
      const rowsAfter = await adapter.findMany<{ userId: string; clientId: string; scopes: string[] }>({ model: "oauthRefreshToken", where: [{ field: "userId", value: a.user.id }] });
      assert.ok(rowsAfter.some(r => r.clientId === client.client_id && r.scopes.includes("offline_access")), "offline authorization survives browser sign-out");
      assert.equal((await request("/api/journal", { headers: { cookie: a.cookie } })).status, 401, "browser cookie is no longer authorized");
      assert.equal((await mcpRequest(at.access_token)).status, 200, "approved AI remains authorized after browser sign-out");
      const originalRefresh = at.refresh_token;
      const refresh = () => request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: originalRefresh, resource: baseURL + "/mcp" }) });
      const first = await refresh(); const renewed = await first.json(); assert.equal(first.status, 200, renewed.error_description ?? renewed.error ?? "refresh succeeds");
      assert.notEqual(renewed.refresh_token, originalRefresh, "refresh token rotates");
      assert.ok(renewed.expires_in > 800 && renewed.expires_in <= 900, "access lifetime is fifteen minutes");
      const retry = await refresh(); assert.equal(retry.status, 200); const repeated = await retry.json();
      assert.equal(repeated.access_token, renewed.access_token); assert.equal(repeated.refresh_token, renewed.refresh_token);
      assert.equal((await mcpRequest(renewed.access_token)).status, 200, "new token works without the former browser session");
      at = { ...at, ...renewed };
      const signedIn = await post("/api/auth/sign-in/email", { email: "alice@example.test", password: "synthetic-testing-password" });
      assert.equal(signedIn.status, 200); a.cookie = cookieFrom(signedIn);
    });
    await t.test("disconnect rejects existing JWTs and refresh tokens on next request", async () => {
      const pending = await startAuthorization(client, a.cookie);
      const approved = await post("/api/auth/oauth2/consent", { accept: true, oauth_query: pending.redirect.search.slice(1) }, a.cookie);
      const pendingCode = new URL((await approved.json()).url).searchParams.get("code")!;
      const disconnected = await post("/api/journal/disconnect", {}, a.cookie); assert.equal(disconnected.status, 200);
      assert.equal((await mcpRequest(at.access_token)).status, 401); assert.equal((await mcpRequest(ro.access_token)).status, 401);
      const refreshed = await request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: at.refresh_token, resource: baseURL + "/mcp" }) });
      assert.equal(refreshed.status, 400);
      assert.equal((await tokenExchange(client.client_id, pendingCode, pending.verifier)).status, 400, "a pending pre-disconnect code is invalidated too");
      assert.equal((await mcpRequest(bt.access_token)).status, 200, "Bob stays connected");
      const newToken = await authorize(client, a.cookie); assert.equal((await mcpRequest(newToken.access_token)).status, 200); assert.equal((await mcpRequest(at.access_token)).status, 401, "old JWT never revives after new consent");
      at = newToken;
    });
    await t.test("deletion removes active files, denies access and recreates an empty journal", async () => {
      const path = preview.accounts.path(a.user.id); assert.ok(existsSync(path));
      const deleted = await request("/api/journal", { method: "DELETE", headers: { cookie: a.cookie, origin: baseURL } }); assert.equal(deleted.status, 200);
      for (const suffix of ["", "-wal", "-shm"]) assert.ok(!existsSync(path + suffix));
      assert.equal((await mcpRequest(at.access_token)).status, 401); assert.equal((await request("/api/journal/export", { headers: { cookie: a.cookie } })).status, 410);
      assert.equal((await post("/api/journal/create", {}, a.cookie)).status, 201);
      const empty = await (await request("/api/journal", { headers: { cookie: a.cookie } })).json(); assert.equal(empty.count, 0);
      assert.equal((await mcpRequest(at.access_token)).status, 401); assert.match(JSON.stringify(await tool(bt.access_token, "journal_wake")), /terracotta/);
    });
  } finally { await preview.close(); rmSync(directory, { recursive: true, force: true }); }
});
