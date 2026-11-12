// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import Database from "better-sqlite3";
import { createPreview } from "../src/service.js";
import type { AccountMail } from "../src/accountAccess.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext, deliver?: (message: AccountMail) => Promise<void>) {
  const socket = net.createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const directory = mkdtempSync(join(tmpdir(), "kairos-account-races-")), baseURL = `http://127.0.0.1:${port}`, mail: AccountMail[] = [];
  const service = await createPreview({ baseURL, directory, secret: randomBytes(32).toString("hex"), accountDelivery: { send: async message => { mail.push(message); await deliver?.(message); } } });
  await service.listen();
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (path: string, options: RequestInit = {}) => fetch(baseURL + path, { redirect: "manual", ...options, headers: { connection: "close", ...options.headers } });
  const post = (path: string, input: unknown, cookie?: string) => request(path, { method: "POST", headers: { "content-type": "application/json", origin: baseURL, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(input) });
  const signedIn = await post("/api/auth/sign-up/email", { email: "race@example.test", password: "synthetic-race-password", name: "Synthetic race" });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.getSetCookie().map(c => c.split(";")[0]).join("; "), user = (await signedIn.json()).user;
  const tokenFrom = (message: AccountMail) => new URLSearchParams(new URL(message.url).hash.slice(1)).get("token")!;
  assert.equal((await post("/api/account/email-change", { newEmail: "race@recovery-fixture.org", currentPassword: "synthetic-race-password" }, cookie)).status, 200);
  assert.equal((await post("/api/account/confirm-email", { token: tokenFrom(mail.at(-1)!) }, cookie)).status, 200);
  const context = await service.auth.$context;
  const resetLink = async () => {
    assert.equal((await post("/api/account/forgot-password", { email: "race@recovery-fixture.org" })).status, 200);
    // Tracked delivery may finish just after the neutral HTTP response.
    while (mail.at(-1)?.kind !== "password-reset") await setImmediate();
    return tokenFrom(mail.at(-1)!);
  };
  const reset = (token: string) => post("/api/account/reset-password", { token, newPassword: "synthetic-recovered-race-password" });
  const tokenRequest = (input: Record<string, string>) => request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(input) });
  const grant = async () => {
    const registered = await post("/api/auth/oauth2/register", { client_name: "Synthetic race client", redirect_uris: ["https://ai.example.test/callback"],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "journal:read offline_access" });
    assert.equal(registered.status, 201); const client = await registered.json();
    const verifier = randomBytes(32).toString("base64url"), query = new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://ai.example.test/callback", response_type: "code",
      scope: "journal:read offline_access", resource: baseURL + "/mcp", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "consent" });
    const started = await request("/api/auth/oauth2/authorize?" + query, { mode: "same-origin", headers: { cookie, accept: "text/html" } }); assert.equal(started.status, 302);
    const consent = new URL(started.headers.get("location")!, baseURL);
    const approved = await post("/api/auth/oauth2/consent", { accept: true, oauth_query: consent.search.slice(1) }, cookie); assert.equal(approved.status, 200);
    return { clientId: client.client_id as string, code: new URL((await approved.json()).url).searchParams.get("code")!, verifier };
  };
  return { service, directory, baseURL, cookie, user, context, request, post, grant, tokenRequest, resetLink, reset };
}

test("OAuth grants cannot bypass owner locking through media types or path aliases", { timeout: 20_000 }, async t => {
  const f = await fixture(t), grant = await f.grant();
  const input = { grant_type: "authorization_code", client_id: grant.clientId, redirect_uri: "https://ai.example.test/callback", code: grant.code,
    code_verifier: grant.verifier, resource: f.baseURL + "/mcp" };
  for (const contentType of ["application/json", "application/jsonapplication/x-www-form-urlencoded", "application/json+application/x-www-form-urlencoded"]) {
    // Better Call can treat an ambiguous media type as JSON, while the provider
    // reparses the same bytes as form data for client authentication.
    const response = await f.request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": contentType },
      body: JSON.stringify({ ...input, padding: `&client_id=${grant.clientId}&` }) });
    assert.equal(response.status, 415, `unsupported media type must not issue a grant: ${contentType}`);
  }
  for (const path of ["/api/auth/oauth2/token/", "/api/auth/oauth2//token", "/api/auth//oauth2/token", "/api/auth/oauth2/%74oken"]) {
    const response = await f.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(input) });
    assert.equal(response.status, 404, `path alias must not issue a grant: ${path}`);
  }
  const locked: string[] = [], originalLock = f.service.accounts.locked.bind(f.service.accounts);
  f.service.accounts.locked = (id, action) => { locked.push(id); return originalLock(id, action); };
  const issued = await f.request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8" }, body: new URLSearchParams(input) });
  assert.equal(issued.status, 200); assert.ok(locked.includes(f.user.id));
});

for (const kind of ["refresh", "authorization-code"] as const) test(`${kind} issuance and reset serialize without losing approved AI access`, { timeout: 20_000 }, async t => {
  const f = await fixture(t), grant = await f.grant();
  const exchange = { grant_type: "authorization_code", client_id: grant.clientId, redirect_uri: "https://ai.example.test/callback", code: grant.code, code_verifier: grant.verifier, resource: f.baseURL + "/mcp" };
  let request: Record<string, string> = exchange;
  if (kind === "refresh") {
    const response = await f.tokenRequest(exchange); assert.equal(response.status, 200); const tokens = await response.json();
    request = { grant_type: "refresh_token", client_id: grant.clientId, refresh_token: tokens.refresh_token, resource: f.baseURL + "/mcp" };
  }
  const resetToken = await f.resetLink(), read = deferred(), resume = deferred();
  const originalFind = f.context.adapter.findOne.bind(f.context.adapter);
  let armed = true;
  f.context.adapter.findOne = (async args => {
    const result = await originalFind(args);
    if (armed && args.model === (kind === "refresh" ? "oauthRefreshToken" : "session")) { armed = false; read.resolve(); await resume.promise; }
    return result;
  }) as typeof f.context.adapter.findOne;
  const issuance = f.tokenRequest(request);
  let recovery: Promise<Response> | undefined;
  try {
    await read.promise;
    const attempted = deferred(), originalLock = f.service.accounts.locked.bind(f.service.accounts);
    let first = true, resetEntered = false;
    f.service.accounts.locked = async (id, action) => {
      const isReset = first; first = false;
      if (isReset) attempted.resolve();
      return originalLock(id, async () => { if (isReset) resetEntered = true; return action(); });
    };
    recovery = f.reset(resetToken); await attempted.promise; await setImmediate();
    // Before the fix reset enters immediately and deletes the captured session;
    // after the fix it queues until the original grant has finished issuance.
    if (resetEntered) assert.equal((await recovery).status, 200);
    resume.resolve();
    const issued = await issuance; assert.equal(issued.status, 200, "issuance must not fail after revoking its predecessor");
    const tokens = await issued.json(); assert.ok(tokens.refresh_token);
    assert.equal((await recovery).status, 200);
    assert.equal((await f.request("/api/account", { headers: { cookie: f.cookie } })).status, 401);
    const refreshed = await f.tokenRequest({ grant_type: "refresh_token", client_id: grant.clientId, refresh_token: tokens.refresh_token, resource: f.baseURL + "/mcp" });
    assert.equal(refreshed.status, 200, "issued AI authorization survives browser-session deletion");
    const active = await f.context.adapter.findMany<{ revoked?: Date | null; sessionId?: string | null }>({ model: "oauthRefreshToken", where: [{ field: "userId", value: f.user.id }] });
    assert.ok(active.some(row => !row.revoked)); assert.ok(active.every(row => !row.sessionId));
  } finally {
    resume.resolve(); f.context.adapter.findOne = originalFind;
    await Promise.allSettled([issuance, ...(recovery ? [recovery] : [])]);
  }
});

test("a journal upload authenticated before reset cannot mutate after reset revokes its browser session", { timeout: 20_000 }, async t => {
  const f = await fixture(t), resetToken = await f.resetLink();
  const read = deferred(), originalFind = f.context.internalAdapter.findSession.bind(f.context.internalAdapter);
  let armed = true;
  f.context.internalAdapter.findSession = async token => { const result = await originalFind(token); if (armed) { armed = false; read.resolve(); } return result; };
  const bytes = JSON.stringify({ text: "SYNTHETIC old-session write must not survive reset" });
  let upload!: http.ClientRequest;
  const result = new Promise<number>((resolve, reject) => {
    upload = http.request(f.baseURL + "/api/journal/notes", { method: "POST", headers: { cookie: f.cookie, origin: f.baseURL,
      "content-type": "application/json", "content-length": Buffer.byteLength(bytes), connection: "close" } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
    upload.on("error", reject); upload.write(bytes.slice(0, -1));
  });
  try {
    await read.promise;
    assert.equal((await f.reset(resetToken)).status, 200);
    upload.end(bytes.slice(-1)); assert.equal(await result, 401);
  } finally { upload.destroy(); f.context.internalAdapter.findSession = originalFind; await result.catch(() => {}); }
});

test("forgot-password hides mail latency while recovery capture and shutdown drain tracked delivery and cleanup", { timeout: 20_000 }, async t => {
  const sending = deferred(), finish = deferred();
  const f = await fixture(t, async message => {
    if (message.kind === "password-reset") { sending.resolve(); await finish.promise; throw new Error("Synthetic delayed delivery failure"); }
  });
  const output = mkdtempSync(join(tmpdir(), "kairos-account-mail-capture-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  let captured = false, closed = false;
  let capture: ReturnType<typeof f.service.captureRecovery> | undefined, close: Promise<void> | undefined;
  try {
    const known = await f.post("/api/account/forgot-password", { email: "race@recovery-fixture.org" });
    assert.equal(known.status, 200); await sending.promise;
    const unknown = await f.post("/api/account/forgot-password", { email: "unknown@recovery-fixture.org" });
    assert.equal(unknown.status, 200); assert.deepEqual(await known.json(), await unknown.json());
    // Both HTTP responses completed while the configured provider is still paused.
    capture = f.service.captureRecovery({ backup: join(output, "backup"), witness: join(output, "witness.json"), sourceRevision: "a".repeat(40) }).then(value => { captured = true; return value; });
    assert.equal((await f.request("/healthz")).status, 200);
    assert.equal((await f.request("/api/account", { headers: { cookie: f.cookie } })).status, 503);
    close = f.service.close().then(() => { closed = true; });
    await setImmediate(); assert.equal(captured, false); assert.equal(closed, false);
    finish.resolve(); await capture; await close;
    const backup = new Database(join(output, "backup", "auth.db"), { readonly: true });
    try {
      assert.equal((backup.prepare('SELECT COUNT(*) AS n FROM "verification" WHERE identifier LIKE ?').get("kairos-account-access-v1:%") as { n: number }).n, 0,
        "failed-mail challenge cleanup finishes before capture and database close");
    } finally { backup.close(); }
  } finally { finish.resolve(); await Promise.allSettled([...(capture ? [capture] : []), ...(close ? [close] : [])]); }
});

test("a concurrent raw get-session refresh cannot recreate a session removed by password reset", { timeout: 20_000 }, async t => {
  const f = await fixture(t), resetToken = await f.resetLink();
  const session = await f.service.auth.api.getSession({ headers: new Headers({ cookie: f.cookie }) }); assert.ok(session);
  await f.context.adapter.update({ model: "session", where: [{ field: "id", value: session.session.id }], update: { expiresAt: new Date(Date.now() + 3_600_000) } });
  const updating = deferred(), resume = deferred(), originalUpdate = f.context.internalAdapter.updateSession.bind(f.context.internalAdapter);
  f.context.internalAdapter.updateSession = async (token, values) => { updating.resolve(); await resume.promise; return originalUpdate(token, values); };
  const refresh = f.request("/api/auth/get-session", { headers: { cookie: f.cookie } });
  try {
    await updating.promise; assert.equal((await f.reset(resetToken)).status, 200); resume.resolve();
    assert.equal((await refresh).status, 401);
    assert.equal((await f.context.adapter.findMany({ model: "session", where: [{ field: "userId", value: f.user.id }] })).length, 0);
  } finally { resume.resolve(); f.context.internalAdapter.updateSession = originalUpdate; await refresh; }
});
