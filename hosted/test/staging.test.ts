// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createStaging } from "../src/service.js";
import { stagingSettings } from "../src/deployment.js";
import { CLAUDE_CONNECTOR_CLIENT_ID, CHATGPT_CONNECTOR_CLIENT_ID, isStagingClientAllowed } from "../src/auth.js";

const baseURL = "https://journal.example.test";
const revision = "1".repeat(40);
test("staging configuration rejects ambiguous or insecure deployment settings", () => {
  assert.equal(isStagingClientAllowed(CLAUDE_CONNECTOR_CLIENT_ID), true);
  assert.equal(isStagingClientAllowed(CHATGPT_CONNECTOR_CLIENT_ID), true);
  for (const clientId of ["https://claude.ai", "https://claude.ai/oauth/claude-code-client-metadata", CLAUDE_CONNECTOR_CLIENT_ID + "?copy=1", "https://claude.ai.evil.example/oauth/mcp-oauth-client-metadata",
    CHATGPT_CONNECTOR_CLIENT_ID + "?copy=1", CHATGPT_CONNECTOR_CLIENT_ID + "#copy", CHATGPT_CONNECTOR_CLIENT_ID + "/",
    "https://chatgpt.com.evil.example/oauth/client.json", "https://user@chatgpt.com/oauth/client.json", "http://chatgpt.com/oauth/client.json",
    "https://chatgpt.com/oauth/client/other-callback.json", "https://chatgpt.com/oauth/jwks.json"]) assert.equal(isStagingClientAllowed(clientId), false);
  const settings = { baseURL, directory: "/var/data/kairos", secret: "s".repeat(32), inviteCode: "i".repeat(32), sourceRevision: revision, port: 10000 };
  assert.equal(stagingSettings(settings).listenHost, "0.0.0.0");
  assert.equal(stagingSettings(settings).trustedEdge, undefined);
  assert.equal(stagingSettings({ ...settings, trustedEdge: "render-cloudflare" }).trustedEdge, "render-cloudflare");
  assert.throws(() => stagingSettings({ ...settings, trustedEdge: "untrusted" as never }));
  for (const baseURL of ["http://journal.example.test", "https://localhost", "https://127.0.0.1", "https://journal.local", "https://journal.internal", "https://journal.example.test/path", "https://journal.example.test?x=1", "https://user:pass@journal.example.test", "https://journal.example.test:8443"]) {
    assert.throws(() => stagingSettings({ ...settings, baseURL }));
  }
  for (const overrides of [{ directory: "relative" }, { port: 0 }, { port: 65536 }, { port: NaN }, { inviteCode: "short" }, { sourceRevision: "main" }]) assert.throws(() => stagingSettings({ ...settings, ...overrides }));
});

// This simulates a TLS edge over local HTTP; it is not proof of Render TLS/proxy behavior.
test("invited staging: proxy boundary, HTTPS metadata, signup gate and durable owner journal", { timeout: 60_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-staging-acceptance-"));
  const socket = net.createServer(); await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(r => socket.close(() => r()));
  const wire = `http://127.0.0.1:${port}`;
  const options = { baseURL, directory, port, secret: randomBytes(32).toString("hex"), inviteCode: randomBytes(32).toString("hex"), sourceRevision: revision, trustedEdge: "render-cloudflare" as const };
  let staging = await createStaging(options); await staging.listen();
  // Node's fetch intentionally ignores a custom Host header; a proxy fixture must preserve it.
  const request = (path: string, opts: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
    const headers = new Headers({ host: "journal.example.test", "x-forwarded-proto": "https", "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.66, 10.0.0.1", connection: "close", ...opts.headers });
    const req = http.request(wire + path, { method: opts.method ?? "GET", headers: Object.fromEntries(headers) }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }));
      }); res.on("error", reject);
    }); req.on("error", reject); req.end(opts.body?.toString());
  });
  const signup = (extra: object) => request("/api/auth/sign-up/email", { method: "POST", headers: { origin: baseURL, "content-type": "application/json" }, body: JSON.stringify({ email: "invited@example.test", password: "synthetic-testing-password", name: "Invited test", ...extra }) });
  let cookie = "", userId = "";
  try {
    await t.test("internal health has no private fields; exact secure Host and Origin required elsewhere", async () => {
      const health = await fetch(wire + "/healthz"); assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true, mode: "hosted-invited-staging" });
      assert.equal((await fetch(wire + "/about")).status, 403);
      assert.equal((await request("/about", { headers: { "x-forwarded-proto": "http" } })).status, 403);
      assert.equal((await request("/about", { headers: { origin: "https://hostile.example.test" } })).status, 403);
      assert.equal((await request("/about", { headers: { host: "another.example.test" } })).status, 403);
      const about = await (await request("/about")).json(); assert.equal(about.source, `https://github.com/Steffan005/Kairos-Bridge-AI-Journal/tree/${revision}`);
    });
    await t.test("canonical HTTPS discovery advertises CIMD, S256 and public-client tokens", async () => {
      const metadata = await (await request("/.well-known/oauth-authorization-server/api/auth")).json();
      assert.equal(metadata.issuer, baseURL + "/api/auth"); assert.equal(metadata.client_id_metadata_document_supported, true);
      assert.equal(metadata.authorization_response_iss_parameter_supported, true);
      assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
      assert.ok(metadata.token_endpoint_auth_methods_supported.includes("none"));
      assert.ok(metadata.token_endpoint_auth_methods_supported.includes("private_key_jwt"));
      const resource = await (await request("/.well-known/oauth-protected-resource/mcp")).json(); assert.equal(resource.resource, baseURL + "/mcp");
      const noToken = await request("/mcp", { method: "POST", body: "{}" }); assert.equal(noToken.status, 401); assert.match(noToken.headers.get("www-authenticate")!, /journal:read journal:write/);
      const badToken = await request("/mcp", { method: "POST", headers: { authorization: "Bearer invalid" }, body: "{}" }); assert.equal(badToken.status, 401); assert.match(badToken.headers.get("www-authenticate")!, /error="invalid_token"/);
    });
    await t.test("signup requires an invitation and development email; secure session cookie", async () => {
      assert.equal((await signup({})).status, 403);
      assert.equal((await signup({ invite_code: "incorrect" })).status, 403);
      assert.equal((await signup({ email: "actual@example.com", invite_code: options.inviteCode })).status, 400);
      const response = await signup({ invite_code: options.inviteCode }); assert.equal(response.status, 200);
      const cookies = response.headers.getSetCookie(); assert.ok(cookies.some(c => /; Secure/i.test(c) && /; HttpOnly/i.test(c)));
      cookie = cookies.map(c => c.split(";")[0]).join("; "); const result = await response.json(); userId = result.user.id;
      assert.doesNotMatch(JSON.stringify(result), new RegExp(options.inviteCode));
      const page = await (await request("/sign-in")).text(); assert.match(page, /invitation-field/); assert.ok(!page.includes(options.inviteCode));
      const authBytes = readFileSync(join(directory, "auth.db")); assert.equal(authBytes.includes(Buffer.from(options.inviteCode)), false);
    });
    await t.test("public DCR and other metadata hosts cannot create staging clients", async () => {
      const dcr = await request("/api/auth/oauth2/register", { method: "POST", headers: { origin: baseURL, "content-type": "application/json" }, body: JSON.stringify({ client_name: "Untrusted", redirect_uris: ["https://evil.example.test/callback"], token_endpoint_auth_method: "none" }) });
      assert.ok(dcr.status >= 400);
      const target = new URLSearchParams({ client_id: "https://evil.example.test/client.json", redirect_uri: "https://evil.example.test/callback", response_type: "code", scope: "journal:read", code_challenge: "a".repeat(43), code_challenge_method: "S256", resource: baseURL + "/mcp" });
      const denied = await request("/api/auth/oauth2/authorize?" + target, { headers: { cookie, accept: "application/json" } }); assert.ok(denied.status >= 400);
      const { adapter } = await staging.auth.$context;
      assert.equal((await adapter.findMany({ model: "oauthClient" })).length, 0);
    });
    await t.test("declared Render edge uses the single Cloudflare address, not the forwarded chain", async () => {
      assert.deepEqual(staging.auth.options.advanced?.ipAddress?.ipAddressHeaders, ["cf-connecting-ip"]);
      const session = await (await request("/api/auth/get-session", { headers: { cookie } })).json();
      assert.equal(session.session.ipAddress, "203.0.113.7");
      assert.notEqual(session.session.ipAddress, "198.51.100.66");
      // Local proxy fixture only: the real host must separately prove this header
      // is overwritten at the edge even when a client supplies a forged value.
    });
    await t.test("owner write, restart, export and active deletion preserve the declared boundaries", async () => {
      const saved = await request("/api/journal/notes", { method: "POST", headers: { cookie, origin: baseURL, "content-type": "application/json" }, body: JSON.stringify({ text: "SYNTHETIC: persistent staging note", tags: ["project-staging"] }) }); assert.equal(saved.status, 201);
      await staging.close(); staging = await createStaging(options); await staging.listen();
      const journal = await (await request("/api/journal", { headers: { cookie } })).json(); assert.equal(journal.count, 1); assert.equal(journal.entries[0].actor, "you");
      const exported = await request("/api/journal/export", { headers: { cookie } }); assert.equal(exported.status, 200); assert.match(await exported.text(), /persistent staging note/);
      const deleted = await request("/api/journal", { method: "DELETE", headers: { cookie, origin: baseURL } }); assert.equal(deleted.status, 200); assert.match((await deleted.json()).backups, /snapshots/);
      assert.equal(Boolean(staging.accounts.get(userId).deleted), true);
    });
  } finally { await staging.close(); rmSync(directory, { recursive: true, force: true }); }
});
