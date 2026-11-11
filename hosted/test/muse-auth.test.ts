// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Synthetic Meta Muse public client. No Meta account, token, or real journal is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Accounts } from "../src/accounts.js";
import { disconnect, isStagingClientAllowed, makeAuth, migrateAuth, MUSE_CONNECTOR_CLIENT_ID, MUSE_CONNECTOR_REDIRECT_URI, verifyGrant } from "../src/auth.js";
import { createPreview, createStaging } from "../src/service.js";
import { oauthWriteOrigin } from "../src/writeOrigin.js";

const baseURL = "https://journal.example.test";
const callback = MUSE_CONNECTOR_REDIRECT_URI;
const museScope = "journal:read journal:write offline_access";

test("Muse is a pre-registered public client, not another metadata document", () => {
  assert.equal(MUSE_CONNECTOR_CLIENT_ID, "kairos-journal-meta-muse");
  assert.equal(callback, "https://agent.meta.ai/api/hatch/oauth/callback");
  assert.equal(isStagingClientAllowed(MUSE_CONNECTOR_CLIENT_ID), false);
  assert.equal(isStagingClientAllowed(callback), false);
  assert.equal(isStagingClientAllowed("https://agent.meta.ai/oauth/client.json"), false);
  const origin = oauthWriteOrigin(MUSE_CONNECTOR_CLIENT_ID, baseURL);
  assert.equal(origin.provider, null);
  assert.equal(origin.client_id, MUSE_CONNECTOR_CLIENT_ID);
  assert.equal(origin.channel, "oauth");
});

test("staging seeds one Muse public client: exact redirect, PKCE, consent, refresh, and revocation", { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-muse-auth-"));
  const accounts = new Accounts(directory);
  const fetched: string[] = [];
  const { auth, database } = makeAuth(baseURL, randomBytes(32).toString("hex"), accounts, {
    staging: true,
    metadataFetcher: async input => {
      const url = input instanceof Request ? input.url : input.toString();
      fetched.push(url);
      throw new Error("Muse registration must not fetch client metadata");
    },
  });
  const request = (path: string, opts: RequestInit = {}) => auth.handler(new Request(baseURL + "/api/auth" + path, opts));
  const post = (path: string, value: unknown, cookie?: string) => request(path, { method: "POST",
    headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value) });
  let cookie = "", userId = "", token = "", refreshToken = "";
  const pending = async (redirect = callback, clientId = MUSE_CONNECTOR_CLIENT_ID, scope = museScope, pkce = true) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope,
      resource: baseURL + "/mcp", prompt: "consent", state: "synthetic-state" });
    if (pkce) {
      query.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      query.set("code_challenge_method", "S256");
    }
    return { r: await request("/oauth2/authorize?" + query, { headers: { cookie, accept: "text/html" } }), verifier };
  };
  const approve = async () => {
    const { r, verifier } = await pending();
    assert.equal(r.status, 302);
    const location = new URL(r.headers.get("location")!, baseURL);
    assert.equal(location.pathname, "/consent");
    assert.equal(location.origin, baseURL);
    const approved = await post("/oauth2/consent", { accept: true, oauth_query: location.search.slice(1) }, cookie);
    assert.equal(approved.status, 200);
    const target = new URL((await approved.json()).url);
    assert.equal(target.origin + target.pathname, callback);
    assert.equal(target.searchParams.get("state"), "synthetic-state");
    assert.equal(target.searchParams.get("iss"), baseURL + "/api/auth");
    assert.ok(target.searchParams.get("code"));
    return { code: target.searchParams.get("code")!, verifier };
  };
  const exchange = (fields: Record<string, string>) => request("/oauth2/token", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: MUSE_CONNECTOR_CLIENT_ID, resource: baseURL + "/mcp", ...fields }) });
  try {
    await migrateAuth(auth, database);
    await t.test("startup registers exactly Meta's redirect and does not fetch metadata", async () => {
      const { adapter } = await auth.$context;
      const clients = await adapter.findMany<{ clientId: string; name: string; redirectUris: string[]; tokenEndpointAuthMethod: string; grantTypes: string[]; responseTypes: string[]; scopes: string[]; skipConsent: boolean | null; disabled: boolean | null; requirePKCE: boolean | null; clientSecret: string | null; clientDiscoveryId: string | null }>({ model: "oauthClient" });
      assert.equal(clients.length, 1);
      const client = clients[0];
      assert.equal(client.clientId, MUSE_CONNECTOR_CLIENT_ID);
      assert.equal(client.name, "Meta Muse");
      assert.deepEqual(client.redirectUris, [callback]);
      assert.equal(client.tokenEndpointAuthMethod, "none");
      assert.deepEqual(client.grantTypes, ["authorization_code", "refresh_token"]);
      assert.deepEqual(client.responseTypes, ["code"]);
      assert.deepEqual(client.scopes, ["openid", "offline_access", "journal:read", "journal:write"]);
      assert.equal(Boolean(client.skipConsent), false);
      assert.equal(Boolean(client.disabled), false);
      assert.equal(Boolean(client.requirePKCE), true);
      assert.equal(client.clientSecret ?? null, null);
      assert.equal(client.clientDiscoveryId ?? null, null);
      const links = await adapter.findMany<{ resourceId: string }>({ model: "oauthClientResource", where: [{ field: "clientId", value: MUSE_CONNECTOR_CLIENT_ID }] });
      assert.deepEqual(links.map(link => link.resourceId), [baseURL + "/mcp"]);
      assert.deepEqual(fetched, []);
      const registered = await post("/oauth2/register", { client_name: "Untrusted", redirect_uris: ["https://evil.example.test/callback"], token_endpoint_auth_method: "none" });
      assert.ok(registered.status >= 400);
      assert.equal((await adapter.findMany({ model: "oauthClient" })).length, 1);
      await migrateAuth(auth, database);
      assert.equal((await adapter.findMany({ model: "oauthClient" })).length, 1);
    });
    const signup = await post("/sign-up/email", { email: "muse-fixture@example.test", password: "synthetic-testing-password", name: "Synthetic test" });
    assert.equal(signup.status, 200);
    userId = (await signup.json()).user.id;
    cookie = signup.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    await t.test("the consent page is required and only the exact callback can receive a code", async () => {
      await approve();
      assert.deepEqual(fetched, []);
      const wrong = await pending(callback + "/extra");
      assert.equal(wrong.r.status, 302);
      const refusal = new URL(wrong.r.headers.get("location")!, baseURL);
      assert.equal(refusal.origin, baseURL);
      assert.equal(refusal.pathname, "/api/auth/error");
      assert.equal(refusal.searchParams.get("error"), "invalid_redirect");
      assert.equal(refusal.searchParams.get("code"), null);
      const slash = await pending(callback + "/");
      const slashRefusal = new URL(slash.r.headers.get("location")!, baseURL);
      assert.equal(slashRefusal.origin, baseURL);
      assert.equal(slashRefusal.searchParams.get("code"), null);
      const before = fetched.length;
      const rejected = (response: Response) => {
        const location = response.headers.get("location");
        if (!location) { assert.ok(response.status >= 400 && response.status < 500); return; }
        const refused = new URL(location, baseURL);
        assert.equal(refused.origin, baseURL, "an unknown client never leaves this service");
        assert.equal(refused.searchParams.get("code"), null);
      };
      rejected((await pending(callback, MUSE_CONNECTOR_CLIENT_ID + "-copy")).r);
      rejected((await pending(callback, "https://agent.meta.ai/oauth/client.json")).r);
      assert.equal(fetched.length, before);
      const scope = await pending(callback, MUSE_CONNECTOR_CLIENT_ID, museScope + " journal:admin");
      const scopeError = new URL(scope.r.headers.get("location")!, baseURL);
      assert.equal(scopeError.origin + scopeError.pathname, callback);
      assert.equal(scopeError.searchParams.get("error"), "invalid_scope");
      assert.equal(scopeError.searchParams.get("code"), null);
    });
    await t.test("public client still requires S256 PKCE; code and refresh bind the owner and resource", async () => {
      const missing = await pending(callback, MUSE_CONNECTOR_CLIENT_ID, museScope, false);
      const missingError = new URL(missing.r.headers.get("location")!, baseURL);
      assert.equal(missingError.origin + missingError.pathname, callback);
      assert.equal(missingError.searchParams.get("error"), "invalid_request");
      assert.equal(missingError.searchParams.get("code"), null);
      const plain = await request("/oauth2/authorize?" + new URLSearchParams({ client_id: MUSE_CONNECTOR_CLIENT_ID, redirect_uri: callback, response_type: "code", scope: museScope, resource: baseURL + "/mcp", state: "synthetic-state", code_challenge: "plain-challenge", code_challenge_method: "plain" }), { headers: { cookie } });
      const plainError = new URL(plain.headers.get("location")!, baseURL);
      assert.equal(plainError.origin + plainError.pathname, callback);
      assert.equal(plainError.searchParams.get("error"), "invalid_request");
      assert.equal(plainError.searchParams.get("code"), null);
      const invalid = await approve();
      const denied = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: invalid.code, code_verifier: randomBytes(32).toString("base64url") });
      assert.ok(denied.status >= 400 && denied.status < 500);
      const approved = await approve();
      const r = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: approved.code, code_verifier: approved.verifier });
      const value = await r.json();
      assert.equal(r.status, 200, value.error_description ?? value.error);
      assert.equal(value.expires_in, 900);
      assert.equal(value.token_type.toLowerCase(), "bearer");
      token = value.access_token; refreshToken = value.refresh_token;
      const grant = await verifyGrant(auth, accounts, baseURL, "Bearer " + token);
      assert.equal(grant.userId, userId);
      assert.equal(grant.clientId, MUSE_CONNECTOR_CLIENT_ID);
      assert.equal(grant.readOnly, false);
      const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
      const fresh = await refreshed.json();
      assert.equal(refreshed.status, 200, fresh.error_description ?? fresh.error);
      token = fresh.access_token; refreshToken = fresh.refresh_token;
      assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).userId, userId);
    });
    await t.test("a tampered redirect, secret, or skipped consent is restored on the next startup", async () => {
      const { adapter } = await auth.$context;
      await adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: MUSE_CONNECTOR_CLIENT_ID }], update: {
        redirectUris: ["https://evil.example/callback", callback], skipConsent: true, disabled: true,
        tokenEndpointAuthMethod: "client_secret_post", clientSecret: "tampered-secret", clientDiscoveryId: "cimd",
        scopes: ["journal:admin"], requirePKCE: false,
      } });
      const now = new Date();
      await adapter.create({ model: "oauthResource", data: { identifier: "https://evil.example/mcp", name: "Evil resource", disabled: true, createdAt: now, updatedAt: now } });
      await adapter.create({ model: "oauthClientResource", data: { clientId: MUSE_CONNECTOR_CLIENT_ID, resourceId: "https://evil.example/mcp", createdAt: now } });
      await migrateAuth(auth, database);
      const client = await adapter.findOne<{ redirectUris: string[]; skipConsent: boolean | null; disabled: boolean | null; tokenEndpointAuthMethod: string; clientSecret: string | null; clientDiscoveryId: string | null; scopes: string[]; requirePKCE: boolean | null }>({ model: "oauthClient", where: [{ field: "clientId", value: MUSE_CONNECTOR_CLIENT_ID }] });
      assert.deepEqual(client?.redirectUris, [callback]);
      assert.equal(Boolean(client?.skipConsent), false);
      assert.equal(Boolean(client?.disabled), false);
      assert.equal(client?.tokenEndpointAuthMethod, "none");
      assert.equal(client?.clientSecret ?? null, null);
      assert.equal(client?.clientDiscoveryId ?? null, null);
      assert.equal(Boolean(client?.requirePKCE), true);
      assert.deepEqual(client?.scopes, ["openid", "offline_access", "journal:read", "journal:write"]);
      const links = await adapter.findMany<{ resourceId: string }>({ model: "oauthClientResource", where: [{ field: "clientId", value: MUSE_CONNECTOR_CLIENT_ID }] });
      assert.deepEqual(links.map(link => link.resourceId).sort(), [baseURL + "/mcp"]);
      const { r } = await pending();
      assert.equal(new URL(r.headers.get("location")!, baseURL).pathname, "/consent");
    });
    await t.test("sign-out preserves access; Disconnect denies access, refresh, and a previously approved code", async () => {
      const pendingCode = await approve();
      assert.equal((await post("/sign-out", {}, cookie)).status, 200);
      assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).userId, userId);
      await disconnect(auth, accounts, userId);
      await assert.rejects(verifyGrant(auth, accounts, baseURL, "Bearer " + token), /disconnected/);
      assert.ok((await exchange({ grant_type: "refresh_token", refresh_token: refreshToken })).status >= 400);
      assert.ok((await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: pendingCode.code, code_verifier: pendingCode.verifier })).status >= 400);
    });
  } finally { database.close(); accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("hosted staging shows the same consent page and local preview does not gain the Muse client", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-muse-page-"));
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const options = { baseURL, directory, port, secret: randomBytes(32).toString("hex"), inviteCode: randomBytes(32).toString("hex"), sourceRevision: "a".repeat(40) };
  const staging = await createStaging(options);
  await staging.listen();
  const request = (path: string, opts: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
    const headers = new Headers({ host: "journal.example.test", "x-forwarded-proto": "https", connection: "close", ...opts.headers });
    const req = http.request(`http://127.0.0.1:${port}` + path, { method: opts.method ?? "GET", headers: Object.fromEntries(headers) }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(opts.body?.toString());
  });
  const previewDirectory = mkdtempSync(join(tmpdir(), "kairos-muse-preview-"));
  const preview = await createPreview({ baseURL: "http://127.0.0.1:8765", directory: previewDirectory, secret: randomBytes(32).toString("hex") });
  try {
    const metadata = await (await request("/.well-known/oauth-authorization-server/api/auth")).json();
    assert.equal(metadata.issuer, baseURL + "/api/auth");
    assert.equal(metadata.authorization_endpoint, baseURL + "/api/auth/oauth2/authorize");
    assert.equal(metadata.token_endpoint, baseURL + "/api/auth/oauth2/token");
    assert.equal(metadata.registration_endpoint, undefined);
    const signup = await staging.auth.handler(new Request(baseURL + "/api/auth/sign-up/email", { method: "POST",
      headers: { origin: baseURL, "content-type": "application/json" },
      body: JSON.stringify({ email: "muse-page@example.test", password: "synthetic-testing-password", name: "Synthetic test" }) }));
    assert.equal(signup.status, 200);
    const cookie = signup.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: MUSE_CONNECTOR_CLIENT_ID, redirect_uri: callback, response_type: "code", scope: museScope,
      resource: baseURL + "/mcp", state: "synthetic-state", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    const started = await staging.auth.handler(new Request(baseURL + "/api/auth/oauth2/authorize?" + query, { headers: { cookie, accept: "text/html" } }));
    assert.equal(started.status, 302);
    const location = new URL(started.headers.get("location")!, baseURL);
    assert.equal(location.pathname, "/consent");
    const page = await request(location.pathname + location.search, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Meta Muse/);
    assert.match(html, new RegExp(MUSE_CONNECTOR_CLIENT_ID));
    assert.match(html, /agent\.meta\.ai/);
    assert.match(html, /Read your saved notes/);
    assert.match(html, /Save and pin notes in your journal/);
    assert.match(html, /Keep access between conversations/);
    assert.match(html, /Allow access/);
    const { adapter } = await preview.auth.$context;
    assert.equal((await adapter.findMany({ model: "oauthClient" })).length, 0);
    const registered = await preview.auth.handler(new Request("http://127.0.0.1:8765/api/auth/oauth2/register", { method: "POST",
      headers: { origin: "http://127.0.0.1:8765", "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Synthetic AI client", redirect_uris: ["https://synthetic-ai.example.test/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: museScope }) }));
    assert.equal(registered.status, 201);
    const created = await registered.json();
    assert.notEqual(created.client_id, MUSE_CONNECTOR_CLIENT_ID);
  } finally {
    await staging.close();
    await preview.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(previewDirectory, { recursive: true, force: true });
  }
});
