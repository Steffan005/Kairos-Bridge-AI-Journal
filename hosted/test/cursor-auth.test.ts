// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Synthetic fixture matching the Cursor metadata document fetched October 22, 2026.
// No Cursor account, production key, or real journal is used by this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { validateCimdMetadata } from "@better-auth/cimd";
import { Accounts } from "../src/accounts.js";
import { CURSOR_CONNECTOR_CLIENT_ID, disconnect, isStagingClientAllowed, makeAuth, migrateAuth, verifyGrant } from "../src/auth.js";
import { oauthWriteOrigin } from "../src/writeOrigin.js";

const callback = "https://www.cursor.com/agents/mcp/oauth/callback";
const metadata = {
  client_id: CURSOR_CONNECTOR_CLIENT_ID, client_name: "Cursor", client_uri: "https://cursor.com",
  logo_uri: "https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/uploads/cursorlogomcpv3.svg",
  redirect_uris: [callback, "https://www.cursor.com/bot/mcp/oauth/callback", "https://grok.com/connectors-oauth-exchange-code/",
    "http://localhost:8787/callback", "http://127.0.0.1:8787/callback"],
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
};

test("Cursor CIMD URL is permitted; unrelated client URLs stay refused", { timeout: 30_000 }, async t => {
  assert.equal(CURSOR_CONNECTOR_CLIENT_ID, "https://cursor.com/oauth/mcp-client.json");
  assert.equal(isStagingClientAllowed(CURSOR_CONNECTOR_CLIENT_ID), true);
  assert.equal(metadata.redirect_uris.includes(callback), true);
  const validated = validateCimdMetadata(CURSOR_CONNECTOR_CLIENT_ID, metadata, { metadataProfile: "mcp-2026-07-28" });
  assert.equal(validated.valid, true, validated.valid ? "" : validated.error);
  assert.equal(oauthWriteOrigin(CURSOR_CONNECTOR_CLIENT_ID, "https://journal.example.test").provider, null);
  for (const clientId of [callback, "https://www.cursor.com/oauth/mcp-client.json", "https://evil.example/oauth/client.json",
    CURSOR_CONNECTOR_CLIENT_ID + "?copy=1", CURSOR_CONNECTOR_CLIENT_ID + "/"]) {
    assert.equal(isStagingClientAllowed(clientId), false, clientId);
  }

  const directory = mkdtempSync(join(tmpdir(), "kairos-cursor-auth-"));
  const baseURL = "https://journal.example.test";
  const accounts = new Accounts(directory);
  const fetched: string[] = [];
  const { auth, database } = makeAuth(baseURL, randomBytes(32).toString("hex"), accounts, {
    staging: true,
    metadataFetcher: async input => {
      const url = input instanceof Request ? input.url : input.toString(); fetched.push(url);
      assert.equal(url, CURSOR_CONNECTOR_CLIENT_ID, "fixture never fetches another metadata document");
      return Response.json(metadata, { headers: { "cache-control": "max-age=3600" } });
    },
  });
  const request = (path: string, opts: RequestInit = {}) => auth.handler(new Request(baseURL + "/api/auth" + path, opts));
  const post = (path: string, value: unknown, cookie?: string) => request(path, { method: "POST",
    headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value) });
  let cookie = "";
  const scope = "journal:read journal:write offline_access";
  const pending = async (redirect = callback, clientId = CURSOR_CONNECTOR_CLIENT_ID, accept = "text/html") => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code",
      scope, resource: baseURL + "/mcp", prompt: "consent", state: "synthetic-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    return { r: await request("/oauth2/authorize?" + query, { headers: { cookie, accept } }), verifier };
  };
  try {
    await migrateAuth(auth, database); await auth.$context;
    const signup = await post("/sign-up/email", { email: "cursor-fixture@example.test", password: "synthetic-testing-password", name: "Synthetic test" });
    assert.equal(signup.status, 200);
    const userId = (await signup.json()).user.id;
    cookie = signup.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    await t.test("the observed agents callback reaches consent; other client URLs are refused without a fetch", async () => {
      const { r } = await pending();
      assert.equal(r.status, 302, await r.clone().text());
      const location = new URL(r.headers.get("location")!, baseURL);
      assert.equal(location.pathname, "/consent");
      assert.deepEqual(fetched, [CURSOR_CONNECTOR_CLIENT_ID]);
      const approved = await post("/oauth2/consent", { accept: true, oauth_query: location.search.slice(1) }, cookie);
      assert.equal(approved.status, 200);
      const target = new URL((await approved.json()).url);
      assert.equal(target.origin + target.pathname, callback);
      assert.equal(target.searchParams.get("iss"), baseURL + "/api/auth");
      const code = target.searchParams.get("code");
      assert.ok(code);
      const exchange = (fields: Record<string, string>) => request("/oauth2/token", { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CURSOR_CONNECTOR_CLIENT_ID, resource: baseURL + "/mcp", ...fields }) });
      const denied = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: code!, code_verifier: randomBytes(32).toString("base64url") });
      assert.ok(denied.status >= 400 && denied.status < 500);
      const again = await pending();
      const consent = new URL(again.r.headers.get("location")!, baseURL);
      const second = await post("/oauth2/consent", { accept: true, oauth_query: consent.search.slice(1) }, cookie);
      const issued = new URL((await second.json()).url);
      const tokens = await exchange({ grant_type: "authorization_code", redirect_uri: callback, code: issued.searchParams.get("code")!, code_verifier: again.verifier });
      const value = await tokens.json();
      assert.equal(tokens.status, 200, value.error_description ?? value.error);
      assert.equal(value.expires_in, 900);
      assert.equal((await verifyGrant(auth, accounts, baseURL, "Bearer " + value.access_token)).userId, userId);
      const before = fetched.length;
      for (const clientId of ["https://evil.example/oauth/client.json", "https://www.cursor.com/oauth/mcp-client.json", CURSOR_CONNECTOR_CLIENT_ID + "?copy=1", callback]) {
        const untrusted = await pending(callback, clientId, "application/json");
        assert.equal(untrusted.r.status, 400, clientId);
        const body = await untrusted.r.json();
        assert.equal(body.error, "invalid_client");
        assert.match(body.error_description, /not permitted by the server's fetch policy/);
      }
      assert.equal(fetched.length, before);
      const wrong = await pending(callback + "/other");
      const refusal = new URL(wrong.r.headers.get("location")!, baseURL);
      assert.equal(refusal.origin, baseURL);
      assert.equal(refusal.searchParams.get("error"), "invalid_redirect");
      assert.equal(refusal.searchParams.get("code"), null);
    });
    await t.test("dynamic registration stays disabled", async () => {
      const registered = await post("/oauth2/register", { client_name: "Untrusted", redirect_uris: ["https://evil.example.test/callback"], token_endpoint_auth_method: "none" });
      assert.ok(registered.status >= 400 && registered.status < 500);
      await disconnect(auth, accounts, userId);
    });
  } finally { database.close(); accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});
