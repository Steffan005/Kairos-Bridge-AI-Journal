// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Synthetic CIMD fixture: validates the protocol, not an actual ChatGPT conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Accounts } from "../src/accounts.js";
import { CHATGPT_CONNECTOR_CLIENT_ID, disconnect, makeAuth, migrateAuth, verifyGrant } from "../src/auth.js";

test("ChatGPT-shaped CIMD: exact callback, signed client exchange, PKCE and owner revocation", { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-chatgpt-auth-"));
  const baseURL = "https://journal.example.test";
  const clientId = CHATGPT_CONNECTOR_CLIENT_ID;
  const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
  const jwksURL = "https://chatgpt.com/oauth/jwks.json";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic-only", use: "sig", alg: "RS256" };
  // Public metadata shape observed at the official URL on 2026-10-11.
  // Keys below are generated for this isolated fixture; they are not OpenAI's keys.
  const metadata = { client_id: clientId, client_uri: "https://chatgpt.com/", client_name: "ChatGPT",
    redirect_uris: [callback], token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_signing_alg: "RS256", jwks_uri: jwksURL,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  const fetched: string[] = [];
  const accounts = new Accounts(directory);
  const { auth, database } = makeAuth(baseURL, randomBytes(32).toString("hex"), accounts, {
    staging: true,
    metadataFetcher: async input => {
      const url = input instanceof Request ? input.url : input.toString(); fetched.push(url);
      assert.ok([clientId, jwksURL].includes(url), "fixture never fetches an unapproved resource");
      return Response.json(url === clientId ? metadata : { keys: [jwk] }, { headers: { "cache-control": "max-age=3600" } });
    },
  });
  const request = (path: string, opts: RequestInit = {}) => auth.handler(new Request(baseURL + "/api/auth" + path, opts));
  const post = (path: string, value: unknown, cookie?: string) => request(path, { method: "POST", headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value) });
  let cookie = "", userId = "", token = "", refreshToken = "";
  const pending = async (redirect = callback) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code",
      scope: "journal:read journal:write offline_access", resource: baseURL + "/mcp", prompt: "consent", state: "synthetic-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    const r = await request("/oauth2/authorize?" + query, { headers: { cookie, accept: "text/html" } });
    return { r, verifier };
  };
  const approve = async () => {
    const { r, verifier } = await pending(); assert.equal(r.status, 302);
    const location = new URL(r.headers.get("location")!, baseURL); assert.equal(location.pathname, "/consent");
    const consent = await post("/oauth2/consent", { accept: true, oauth_query: location.search.slice(1) }, cookie);
    assert.equal(consent.status, 200);
    const target = new URL((await consent.json()).url);
    assert.equal(target.origin + target.pathname, callback); assert.equal(target.searchParams.get("state"), "synthetic-state");
    assert.equal(target.searchParams.get("iss"), baseURL + "/api/auth");
    return { code: target.searchParams.get("code")!, verifier };
  };
  const assertion = () => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(clientId).setSubject(clientId).setAudience(baseURL + "/api/auth/oauth2/token")
    .setIssuedAt().setExpirationTime("60s").setJti(randomUUID()).sign(privateKey);
  const exchange = (fields: Record<string, string>) => request("/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, resource: baseURL + "/mcp", ...fields }) });
  const signedFields = async () => ({ client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await assertion() });
  try {
    await migrateAuth(auth, database); await auth.$context;
    const signup = await post("/sign-up/email", { email: "chatgpt-fixture@example.test", password: "synthetic-testing-password", name: "Synthetic test" });
    assert.equal(signup.status, 200); userId = (await signup.json()).user.id;
    cookie = signup.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    await t.test("discovery uses the exact published identity and signed token method", async () => {
      await approve(); assert.ok(fetched.includes(clientId));
      const { adapter } = await auth.$context;
      const client = await adapter.findOne<{ tokenEndpointAuthMethod: string }>({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] });
      assert.equal(client?.tokenEndpointAuthMethod, "private_key_jwt");
      const wrongCallback = await pending(callback + "/other");
      assert.equal(wrongCallback.r.status, 302);
      const refusal = new URL(wrongCallback.r.headers.get("location")!, baseURL);
      assert.equal(refusal.origin, baseURL, "unregistered callbacks only reach our own error page");
      assert.equal(refusal.pathname, "/api/auth/error");
      assert.equal(refusal.searchParams.get("error"), "invalid_redirect");
      assert.equal(refusal.searchParams.get("code"), null);
    });
    await t.test("unsigned and wrong-PKCE exchanges cannot mint journal access", async () => {
      const unsigned = await approve();
      assert.ok((await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: unsigned.code, code_verifier: unsigned.verifier })).status >= 400);
      const badPkce = await approve();
      assert.ok((await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: badPkce.code, code_verifier: randomBytes(32).toString("base64url"), ...await signedFields() })).status >= 400);
    });
    await t.test("signed exchange and signed refresh produce owner-bound grants", async () => {
      const approved = await approve();
      const exchanged = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: approved.code, code_verifier: approved.verifier, ...await signedFields() });
      const result = await exchanged.json(); assert.equal(exchanged.status, 200, result.error_description ?? result.error);
      token = result.access_token; refreshToken = result.refresh_token;
      assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).userId, userId);
      const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: refreshToken, ...await signedFields() });
      const fresh = await refreshed.json(); assert.equal(refreshed.status, 200, fresh.error_description ?? fresh.error);
      token = fresh.access_token; refreshToken = fresh.refresh_token;
      assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).clientId, clientId);
      assert.ok(fetched.includes(jwksURL));
    });
    await t.test("sign-out preserves a grant; owner disconnect denies access and refresh", async () => {
      assert.equal((await post("/sign-out", {}, cookie)).status, 200);
      assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).userId, userId);
      await disconnect(auth, accounts, userId);
      await assert.rejects(verifyGrant(auth, accounts, baseURL, "Bearer " + token), /disconnected/);
      assert.ok((await exchange({ grant_type: "refresh_token", refresh_token: refreshToken, ...await signedFields() })).status >= 400);
    });
  } finally { database.close(); accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});
