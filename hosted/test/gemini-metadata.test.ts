// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Isolated generated-key fixtures; no Google credentials or account identifiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair } from "jose";
import { GEMINI_JWKS_URL, geminiMetadataFetcher } from "../src/gemini.js";

test("Google metadata adapter pins identity, callbacks, public keys and bounded freshness", async t => {
  const baseURL = "https://journal.example.test";
  const slug = "user_bound_custom-mcp-123456789012345678901-journal_example_test";
  const clientId = "https://accountlinking.google.com/clientidmetadata/user_bound_provider/" + slug;
  const { publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), alg: "RS256", kid: "synthetic-only", use: "sig" };
  const metadata = { client_id: clientId, client_name: "Google", scope: "journal:read journal:write",
    redirect_uris: ["oauth-redirect", "oauth-redirect-sandbox", "oauth-redirect-test"].flatMap(host =>
      ["r", "a"].map(path => `https://${host}.googleusercontent.com/${path}/${slug}`)),
    token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_signing_alg: "RS256",
    jwks_uri: GEMINI_JWKS_URL, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  const run = (document: object = metadata, keyset: object = { keys: [jwk] }) => {
    const calls: { url: string; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
    const fetcher = geminiMetadataFetcher(baseURL, async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
      assert.ok([clientId, GEMINI_JWKS_URL].includes(url));
      return Response.json(url === clientId ? document : keyset, { headers: {
        "cache-control": "max-age=3000, s-maxage=6000", etag: "synthetic-etag", "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
      } });
    });
    return { calls, response: async () => await fetcher(clientId, { headers: { "if-none-match": "old", "if-modified-since": "old", accept: "application/json" } }) };
  };
  await t.test("inlines the complete public set without expanding browser origins or preserving stale validators", async () => {
    const f = run(); const response = await f.response(); const adapted = await response.json();
    assert.equal(adapted.client_id, clientId); assert.deepEqual(adapted.redirect_uris, metadata.redirect_uris);
    assert.equal(adapted.token_endpoint_auth_method, "private_key_jwt");
    assert.equal(adapted.jwks_uri, undefined); assert.deepEqual(adapted.jwks.keys, [jwk]);
    assert.equal(response.headers.get("cache-control"), "max-age=60");
    assert.equal(response.headers.get("etag"), null); assert.equal(response.headers.get("last-modified"), null);
    assert.deepEqual(f.calls.map(c => c.url), [clientId, GEMINI_JWKS_URL]);
    assert.ok(f.calls.every(c => c.redirect === "error"));
    assert.equal(f.calls[0].headers.has("if-none-match"), false);
    assert.equal(f.calls[0].headers.has("if-modified-since"), false);
  });
  await t.test("refuses an identity mismatch, different bound callback or non-pinned key URL before fetching keys", async () => {
    for (const changed of [
      { ...metadata, client_id: clientId + "?copy=1" },
      { ...metadata, redirect_uris: metadata.redirect_uris.map((u, i) => i ? u : u + "/other") },
      { ...metadata, jwks_uri: "https://www.gstatic.com/unrelated-keys.json" },
      { ...metadata, token_endpoint_auth_method: "none" },
      { ...metadata, scope: "journal:read journal:write openid" },
    ]) {
      const f = run(changed); await assert.rejects(f.response(), /observed host-bound signed connector profile/);
      assert.equal(f.calls.length, 1);
    }
  });
  await t.test("preserves a declared renewal scope for explicit owner consent", async () => {
    const scope = "journal:read journal:write offline_access";
    const response = await run({ ...metadata, scope }).response();
    assert.equal((await response.json()).scope, scope);
  });
  await t.test("rejects private key material, empty or unsupported sets", async () => {
    for (const keys of [[], [{ ...jwk, d: "private" }], [{ ...jwk, alg: "HS256" }], [{ ...jwk, use: "enc" }]]) {
      await assert.rejects(run(metadata, { keys }).response(), /only public RSA signing keys/);
    }
  });
  await t.test("fails closed on transformed metadata overflow instead of discarding keys", async () => {
    const padding = 5 * 1024 - Buffer.byteLength(JSON.stringify({ ...metadata, description: "" })) - 1;
    const padded = { ...metadata, description: "x".repeat(padding) };
    assert.ok(Buffer.byteLength(JSON.stringify(padded)) < 5 * 1024);
    await assert.rejects(run(padded).response(), /metadata size cap/);
  });
  await t.test("does not alter the existing providers' metadata transport", async () => {
    const url = "https://chatgpt.com/oauth/client.json"; const original = Response.json({ original: true });
    const fetcher = geminiMetadataFetcher(baseURL, async (input, init) => {
      assert.equal(input.toString(), url); assert.equal(new Headers(init?.headers).get("if-none-match"), "preserved");
      return original;
    });
    assert.equal(await fetcher(url, { headers: { "if-none-match": "preserved" } }), original);
  });
});
