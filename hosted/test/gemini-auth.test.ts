// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
// Synthetic consumer-Gemini CIMD fixture. No real Google account identifier,
// production signing key, external network, or owner journal is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { Accounts } from "../src/accounts.js";
import { disconnect, makeAuth, migrateAuth, verifyGrant } from "../src/auth.js";

test("Gemini-shaped CIMD: host-bound identity, signed client, PKCE and exact user consent", { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-gemini-auth-"));
  const baseURL = "https://journal.example.test";
  const slug = "user_bound_custom-mcp-123456789012345678901-journal_example_test";
  const clientId = `https://accountlinking.google.com/clientidmetadata/user_bound_provider/${slug}`;
  const callback = `https://oauth-redirect.googleusercontent.com/r/${slug}`;
  const jwksURL = "https://www.gstatic.com/account-linking/.well-known/client-assertion-signature-verification-key.json";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const { privateKey: wrongKey } = await generateKeyPair("RS256");
  const rotated = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic-google-only", use: "sig", alg: "RS256" };
  const rotatedJwk = { ...await exportJWK(rotated.publicKey), kid: "synthetic-google-rotated", use: "sig", alg: "RS256" };
  const auxiliaryKeys = await Promise.all(Array.from({ length: 4 }, async (_, i) => {
    const pair = await generateKeyPair("RS256");
    return { ...await exportJWK(pair.publicKey), kid: `synthetic-auxiliary-${i}`, use: "sig", alg: "RS256" };
  }));
  let keySet = [jwk, ...auxiliaryKeys];
  let activeSigningKey = privateKey, activeKid = jwk.kid;
  // Shape observed in Google's public metadata; every account/key value here
  // is synthetic. In particular, no client_uri or offline_access is added.
  const metadata = {
    client_id: clientId, client_name: "Google", token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "RS256", jwks_uri: jwksURL,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    scope: "journal:read journal:write",
    redirect_uris: ["oauth-redirect.googleusercontent.com", "oauth-redirect-sandbox.googleusercontent.com", "oauth-redirect-test.googleusercontent.com"]
      .flatMap(host => ["r", "a"].map(route => `https://${host}/${route}/${slug}`)),
  };
  const fetched: string[] = [];
  const accounts = new Accounts(directory);
  const authSecret = randomBytes(32).toString("hex");
  const { auth, database } = makeAuth(baseURL, authSecret, accounts, {
    staging: true,
    metadataFetcher: async input => {
      const url = input instanceof Request ? input.url : input.toString(); fetched.push(url);
      assert.ok([clientId, jwksURL].includes(url), "fixture must not fetch another metadata or key URL");
      return Response.json(url === clientId ? metadata : { keys: keySet }, { headers: { "cache-control": "max-age=3600" } });
    },
  });
  const request = (path: string, opts: RequestInit = {}) => auth.handler(new Request(baseURL + "/api/auth" + path, opts));
  const post = (path: string, value: unknown, cookie?: string) => request(path, { method: "POST",
    headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value) });
  let cookie = "", userId = "", token = "", refreshToken: string | undefined;
  const pending = async (redirect = callback, identity = clientId, scopes = "journal:read journal:write") => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: identity, redirect_uri: redirect, response_type: "code",
      scope: scopes, resource: baseURL + "/mcp", prompt: "consent", state: "synthetic-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    return { r: await request("/oauth2/authorize?" + query, { headers: { cookie, accept: "text/html" } }), verifier };
  };
  const approve = async (scopes = "journal:read journal:write") => {
    const { r, verifier } = await pending(callback, clientId, scopes);
    assert.equal(r.status, 302, await r.clone().text());
    const location = new URL(r.headers.get("location")!, baseURL); assert.equal(location.pathname, "/consent");
    const consent = await post("/oauth2/consent", { accept: true, oauth_query: location.search.slice(1) }, cookie);
    assert.equal(consent.status, 200, await consent.clone().text());
    const target = new URL((await consent.json()).url);
    assert.equal(target.origin + target.pathname, callback); assert.equal(target.searchParams.get("state"), "synthetic-state");
    assert.equal(target.searchParams.get("iss"), baseURL + "/api/auth");
    return { code: target.searchParams.get("code")!, verifier };
  };
  const assertion = (key = activeSigningKey, kid = activeKid) => {
    // Explicit timestamps use the same synthetic clock as provider checks;
    // jose's duration/default helpers use new Date(), which Date.now mocks do
    // not advance. Security lifetimes remain sixty seconds in both clocks.
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({}).setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(clientId).setSubject(clientId).setAudience(baseURL + "/api/auth/oauth2/token")
      .setIssuedAt(now).setExpirationTime(now + 60).setJti(randomUUID()).sign(key);
  };
  const signedFields = async (key = activeSigningKey, kid = activeKid) => ({ client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await assertion(key, kid) });
  const exchange = (fields: Record<string, string>) => request("/oauth2/token", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, resource: baseURL + "/mcp", ...fields }) });
  try {
    await migrateAuth(auth, database); await auth.$context;
    const signup = await post("/sign-up/email", { email: "gemini-fixture@example.test", password: "synthetic-testing-password", name: "Synthetic Gemini test" });
    assert.equal(signup.status, 200); userId = (await signup.json()).user.id;
    cookie = signup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    await t.test("metadata without client_uri preserves exact bound callbacks and private-key auth", async () => {
      await approve(); assert.ok(fetched.includes(clientId));
      const { adapter } = await auth.$context;
      const client = await adapter.findOne<{ tokenEndpointAuthMethod: string; redirectUris: string[]; jwks: string }>({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] });
      assert.equal(client?.tokenEndpointAuthMethod, "private_key_jwt");
      assert.deepEqual(client?.redirectUris, metadata.redirect_uris);
      assert.deepEqual(JSON.parse(client!.jwks).keys.map((key: { kid: string }) => key.kid), keySet.map(key => key.kid), "all five public keys are retained");
      for (const redirect of [callback + "/extra", callback.replace("123456789012345678901", "987654321098765432109")]) {
        const rejected = await pending(redirect); assert.equal(rejected.r.status, 302);
        const refusal = new URL(rejected.r.headers.get("location")!, baseURL);
        assert.equal(refusal.origin, baseURL); assert.equal(refusal.searchParams.get("error"), "invalid_redirect");
        assert.equal(refusal.searchParams.get("code"), null);
      }
      const before = fetched.length;
      const hostile = await pending(callback, clientId + "?copy=1");
      assert.ok(hostile.r.status >= 400 && hostile.r.status < 500); assert.equal(fetched.length, before);
    });
    await t.test("unsigned exchanges, wrong PKCE and assertions signed by another key are denied", async () => {
      const unsigned = await approve();
      const noSignature = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: unsigned.code, code_verifier: unsigned.verifier });
      assert.ok(noSignature.status >= 400 && noSignature.status < 500);
      const wrongPkce = await approve();
      const deniedPkce = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: wrongPkce.code,
        code_verifier: randomBytes(32).toString("base64url"), ...await signedFields() });
      assert.ok(deniedPkce.status >= 400 && deniedPkce.status < 500);
      const wrongSignature = await approve();
      const deniedSignature = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: wrongSignature.code,
        code_verifier: wrongSignature.verifier, ...await signedFields(wrongKey) });
      assert.ok(deniedSignature.status >= 400 && deniedSignature.status < 500);
    });
    await t.test("signed exchange binds the owner and grants only the two consented scopes", async () => {
      const approved = await approve();
      const exchanged = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: approved.code,
        code_verifier: approved.verifier, ...await signedFields() });
      const result = await exchanged.json(); assert.equal(exchanged.status, 200, result.error_description ?? result.error);
      token = result.access_token; refreshToken = result.refresh_token;
      const grant = await verifyGrant(auth, accounts, baseURL, "Bearer " + token);
      assert.equal(grant.userId, userId); assert.equal(grant.clientId, clientId); assert.equal(grant.readOnly, false);
      assert.deepEqual(String(decodeJwt(token).scope).split(" ").sort(), ["journal:read", "journal:write"]);
      const { adapter } = await auth.$context;
      const consent = await adapter.findOne<{ scopes: string[] }>({ model: "oauthConsent", where: [{ field: "userId", value: userId }, { field: "clientId", value: clientId }] });
      assert.deepEqual(consent?.scopes.slice().sort(), ["journal:read", "journal:write"]);
      assert.ok(fetched.includes(jwksURL), "private-key validation uses generated keys from the exact Google key URL");
      if (typeof refreshToken === "string" && refreshToken.length > 0) {
        t.diagnostic("Installed provider returned a refresh token for the observed journal:read journal:write scopes.");
        const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: refreshToken, ...await signedFields() });
        const fresh = await refreshed.json(); assert.equal(refreshed.status, 200, fresh.error_description ?? fresh.error);
        token = fresh.access_token; refreshToken = fresh.refresh_token ?? refreshToken;
        assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).userId, userId);
        assert.deepEqual(String(decodeJwt(token).scope).split(" ").sort(), ["journal:read", "journal:write"]);
      } else {
        refreshToken = undefined;
        t.diagnostic("Installed provider returned no refresh token for the observed journal:read journal:write scopes.");
      }
    });
    await t.test("expired CIMD metadata reloads the exact key resource before signed token verification", async () => {
      keySet = [rotatedJwk, ...auxiliaryKeys];
      const before = fetched.filter(url => url === jwksURL).length;
      // Only this isolated test process changes Date.now; restore it before the
      // next fixture step. No wall-clock wait, external key or service is used.
      const advancedNow = Date.now() + 61_000;
      const clock = t.mock.method(Date, "now", () => advancedNow);
      try {
        activeSigningKey = rotated.privateKey; activeKid = rotatedJwk.kid;
        const approved = await approve();
        const exchanged = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: approved.code,
          code_verifier: approved.verifier, ...await signedFields() });
        const result = await exchanged.json(); assert.equal(exchanged.status, 200, result.error_description ?? result.error);
        token = result.access_token;
        assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).userId, userId);
        assert.ok(fetched.filter(url => url === jwksURL).length > before, "key resource is reloaded after the 60-second snapshot expires");
        const { adapter } = await auth.$context;
        const client = await adapter.findOne<{ jwks: string }>({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] });
        assert.deepEqual(JSON.parse(client!.jwks).keys.map((key: { kid: string }) => key.kid), keySet.map(key => key.kid));
      } finally { clock.mock.restore(); }
    });
    await t.test("a full keyset exceeding the inline metadata cap is rejected without replacing the client", async () => {
      const overflowKeys = Array.from({ length: 12 }, (_, i) => ({ ...rotatedJwk, kid: `synthetic-overflow-${i}` }));
      const overflow = makeAuth(baseURL, authSecret, accounts, { staging: true, metadataFetcher: async input => {
        const url = input instanceof Request ? input.url : input.toString();
        assert.ok([clientId, jwksURL].includes(url));
        return Response.json(url === clientId ? metadata : { keys: overflowKeys });
      } });
      try {
        await overflow.auth.$context;
        const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code",
          scope: "journal:read journal:write", resource: baseURL + "/mcp", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
        const response = await overflow.auth.handler(new Request(baseURL + "/api/auth/oauth2/authorize?" + query, { headers: { cookie, accept: "application/json" } }));
        assert.equal(response.status, 400);
        const body = await response.json(); assert.equal(body.error, "invalid_client");
        const { adapter } = await auth.$context;
        const client = await adapter.findOne<{ jwks: string }>({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] });
        assert.deepEqual(JSON.parse(client!.jwks).keys.map((key: { kid: string }) => key.kid), keySet.map(key => key.kid), "overflow neither truncates keys nor replaces the valid client");
      } finally { overflow.database.close(); }
    });
    await t.test("synthetic offline_access negotiation supports signed refresh without changing observed Google metadata", async () => {
      // This explicitly requested scope is an interoperability fixture, not a
      // claim that the actual consumer Gemini request currently includes it.
      assert.equal(metadata.scope, "journal:read journal:write");
      const scopes = "journal:read journal:write offline_access";
      const approved = await approve(scopes);
      const exchanged = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: approved.code,
        code_verifier: approved.verifier, ...await signedFields() });
      const result = await exchanged.json(); assert.equal(exchanged.status, 200, result.error_description ?? result.error);
      assert.equal(typeof result.refresh_token, "string"); assert.ok(result.refresh_token.length > 0);
      const expectedScopes = ["journal:read", "journal:write", "offline_access"].sort();
      assert.deepEqual(String(decodeJwt(result.access_token).scope).split(" ").sort(), expectedScopes);
      const { adapter } = await auth.$context;
      const consent = await adapter.findOne<{ scopes: string[] }>({ model: "oauthConsent", where: [{ field: "userId", value: userId }, { field: "clientId", value: clientId }] });
      assert.deepEqual(consent?.scopes.slice().sort(), expectedScopes);
      const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: result.refresh_token, ...await signedFields() });
      const fresh = await refreshed.json(); assert.equal(refreshed.status, 200, fresh.error_description ?? fresh.error);
      token = fresh.access_token; refreshToken = fresh.refresh_token;
      assert.equal(typeof refreshToken, "string"); assert.ok(refreshToken!.length > 0);
      assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).userId, userId);
      assert.deepEqual(String(decodeJwt(token).scope).split(" ").sort(), expectedScopes);
      t.diagnostic("Synthetic explicit offline_access negotiation issued a refresh token and signed refresh succeeded; actual observed Google request remains read/write-only.");
    });
    await t.test("sign-out preserves approved access; Disconnect rejects access, available refresh and a pending code", async () => {
      // Keep the current negotiated consent while preparing a pending code;
      // consenting to fewer scopes would independently invalidate that token.
      const pendingCode = await approve(String(decodeJwt(token).scope));
      assert.equal((await post("/sign-out", {}, cookie)).status, 200);
      assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + token)).userId, userId);
      await disconnect(auth, accounts, userId);
      await assert.rejects(verifyGrant(auth, accounts, baseURL, "Bearer " + token), /disconnected/);
      if (refreshToken) assert.ok((await exchange({ grant_type: "refresh_token", refresh_token: refreshToken, ...await signedFields() })).status >= 400);
      assert.ok((await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: pendingCode.code,
        code_verifier: pendingCode.verifier, ...await signedFields() })).status >= 400);
    });
  } finally { database.close(); accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});
