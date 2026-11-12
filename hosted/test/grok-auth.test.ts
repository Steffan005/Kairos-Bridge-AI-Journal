// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Synthetic fixture matching official Grok metadata observed October 11 ET.
// No Grok account, production key, or real journal is used by this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Accounts } from "../src/accounts.js";
import { GROK_CONNECTOR_CLIENT_ID, disconnect, makeAuth, migrateAuth, verifyGrant } from "../src/auth.js";

test("Grok-shaped CIMD: public client, exact callbacks, PKCE, refresh and owner revocation", { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-grok-auth-"));
  const baseURL = "https://journal.example.test";
  const callback = "https://grok.com/connectors-oauth-exchange-code/";
  const metadata = { client_id: GROK_CONNECTOR_CLIENT_ID, client_name: "Grok", client_uri: "https://grok.com",
    redirect_uris: [callback, "https://console.x.ai/connectors-oauth-exchange-code/"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  const accounts = new Accounts(directory);
  const fetched: string[] = [];
  const { auth, database } = makeAuth(baseURL, randomBytes(32).toString("hex"), accounts, {
    staging: true,
    metadataFetcher: async input => {
      const url = input instanceof Request ? input.url : input.toString(); fetched.push(url);
      assert.equal(url, GROK_CONNECTOR_CLIENT_ID, "fixture never fetches another metadata document");
      return Response.json(metadata, { headers: { "cache-control": "max-age=3600" } });
    },
  });
  const request = (path: string, opts: RequestInit = {}) => auth.handler(new Request(baseURL + "/api/auth" + path, opts));
  const post = (path: string, value: unknown, cookie?: string) => request(path, { method: "POST",
    headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value) });
  let cookie = "", userId = "", token = "", refreshToken = "";
  const pending = async (redirect = callback, clientId = GROK_CONNECTOR_CLIENT_ID) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code",
      scope: "openid offline_access journal:read journal:write", resource: baseURL + "/mcp", prompt: "consent", state: "synthetic-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    return { r: await request("/oauth2/authorize?" + query, { headers: { cookie, accept: "text/html" } }), verifier };
  };
  const approve = async () => {
    const { r, verifier } = await pending(); assert.equal(r.status, 302);
    const location = new URL(r.headers.get("location")!, baseURL); assert.equal(location.pathname, "/consent");
    const approved = await post("/oauth2/consent", { accept: true, oauth_query: location.search.slice(1) }, cookie);
    assert.equal(approved.status, 200);
    const target = new URL((await approved.json()).url);
    assert.equal(target.origin + target.pathname, callback);
    assert.equal(target.searchParams.get("state"), "synthetic-state");
    assert.equal(target.searchParams.get("iss"), baseURL + "/api/auth");
    return { code: target.searchParams.get("code")!, verifier };
  };
  const exchange = (fields: Record<string, string>) => request("/oauth2/token", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GROK_CONNECTOR_CLIENT_ID, resource: baseURL + "/mcp", ...fields }) });
  try {
    await migrateAuth(auth, database); await auth.$context;
    const signup = await post("/sign-up/email", { email: "grok-fixture@example.test", password: "synthetic-testing-password", name: "Synthetic test" });
    assert.equal(signup.status, 200); userId = (await signup.json()).user.id;
    cookie = signup.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    await t.test("published metadata admits the consumer callback; variants are rejected without fetching", async () => {
      await approve(); assert.deepEqual(fetched, [GROK_CONNECTOR_CLIENT_ID]);
      const { adapter } = await auth.$context;
      const client = await adapter.findOne<{ tokenEndpointAuthMethod: string }>({ model: "oauthClient", where: [{ field: "clientId", value: GROK_CONNECTOR_CLIENT_ID }] });
      assert.equal(client?.tokenEndpointAuthMethod, "none");
      const wrong = await pending(callback + "other");
      assert.equal(wrong.r.status, 302);
      const refusal = new URL(wrong.r.headers.get("location")!, baseURL);
      assert.equal(refusal.origin, baseURL, "never follow an unregistered callback");
      assert.equal(refusal.pathname, "/api/auth/error");
      assert.equal(refusal.searchParams.get("error"), "invalid_redirect");
      assert.equal(refusal.searchParams.get("code"), null);
      const before = fetched.length;
      const untrusted = await pending(callback, GROK_CONNECTOR_CLIENT_ID + "?copy=1");
      assert.ok(untrusted.r.status >= 400 && untrusted.r.status < 500); assert.equal(fetched.length, before);
    });
    await t.test("public client still requires correct PKCE; code and refresh bind the owner and resource", async () => {
      const invalid = await approve();
      const denied = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: invalid.code, code_verifier: randomBytes(32).toString("base64url") });
      assert.ok(denied.status >= 400 && denied.status < 500);
      const approved = await approve();
      const r = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: approved.code, code_verifier: approved.verifier });
      const value = await r.json(); assert.equal(r.status, 200, value.error_description ?? value.error);
      token = value.access_token; refreshToken = value.refresh_token;
      const grant = await verifyGrant(auth, accounts, baseURL, "Bearer " + token);
      assert.equal(grant.userId, userId); assert.equal(grant.clientId, GROK_CONNECTOR_CLIENT_ID);
      const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
      const fresh = await refreshed.json(); assert.equal(refreshed.status, 200, fresh.error_description ?? fresh.error);
      token = fresh.access_token; refreshToken = fresh.refresh_token;
      assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).userId, userId);
    });
    await t.test("sign-out preserves access; Disconnect denies access, refresh and a previously approved code", async () => {
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
