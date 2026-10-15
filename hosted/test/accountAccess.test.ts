// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.js";
import { AccessError, makeAuth, migrateAuth, verifyGrant } from "../src/auth.js";
import { createAccountAccess, realAccountEmail, type AccountDelivery, type AccountMail } from "../src/accountAccess.js";
import { Journal } from "../../src/journal.js";

const password = "synthetic-account-access-password";
const nextPassword = "synthetic-recovered-account-password";
const email = "owner@recovery-fixture.org";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const tokenFrom = (message: AccountMail) => new URLSearchParams(new URL(message.url).hash.slice(1)).get("token")!;
const cookieFrom = (response: Response) => response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kairos-account-access-"));
  const baseURL = "http://127.0.0.1:32991", accounts = new Accounts(directory);
  const { auth, database } = makeAuth(baseURL, randomBytes(32).toString("hex"), accounts);
  await migrateAuth(auth, database);
  const context = await auth.$context;
  await context.checkSchema?.();
  t.after(() => { database.close(); accounts.close(); rmSync(directory, { recursive: true, force: true }); });
  const messages: AccountMail[] = [];
  const delivery: AccountDelivery = { send: async message => { messages.push(message); } };
  const access = createAccountAccess({ auth, database, accounts, baseURL, delivery });
  const requestAuth = (path: string, input?: unknown, cookie?: string) => auth.handler(new Request(baseURL + "/api/auth" + path, {
    method: input === undefined ? "GET" : "POST", headers: { origin: baseURL, ...(input === undefined ? { accept: "text/html" } : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }));
  let requestId = 0;
  const request = async (path: string, input?: unknown, cookie?: string, settings: {
    handler?: typeof access; method?: string; origin?: string; rateKey?: string;
  } = {}) => {
    try {
      return await (settings.handler ?? access).handle({ path: "/api/account" + path,
        method: settings.method ?? (input === undefined ? "GET" : "POST"), headers: new Headers({ origin: settings.origin ?? baseURL, ...(cookie ? { cookie } : {}) }),
        body: input, rateKey: settings.rateKey ?? `synthetic-${++requestId}` });
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
      return new Response(JSON.stringify({ error: error.message }), { status: error.status });
    }
  };
  const signup = async (address: string) => {
    const response = await requestAuth("/sign-up/email", { email: address, password, name: "Synthetic account recovery" });
    assert.equal(response.status, 200);
    const result = await response.json(); accounts.get(result.user.id);
    return { id: result.user.id as string, cookie: cookieFrom(response) };
  };
  const promote = async (owner: { id: string; cookie: string }, address = email) => {
    assert.equal((await request("/email-change", { newEmail: address, currentPassword: password }, owner.cookie)).status, 200);
    const token = tokenFrom(messages.at(-1)!);
    assert.equal((await request("/confirm-email", { token }, owner.cookie)).status, 200);
  };
  const resetLink = async (address = email) => {
    const before = messages.length;
    assert.equal((await request("/forgot-password", { email: address })).status, 200);
    assert.equal(messages.length, before + 1);
    assert.equal(messages.at(-1)!.kind, "password-reset");
    return tokenFrom(messages.at(-1)!);
  };
  return { directory, baseURL, accounts, auth, database, context, messages, delivery, access, requestAuth, request, signup, promote, resetLink };
}

test("email confirmation and password reset preserve the same journal and approved OAuth access", { timeout: 60_000 }, async t => {
  const f = await fixture(t), owner = await f.signup("owner@example.test"), other = await f.signup("other@example.test");
  const journalPath = f.accounts.path(owner.id), journal = Journal.open(journalPath);
  journal.write({ text: "SYNTHETIC private note survives account recovery", actor: "you" }); journal.close();
  const beforeJournal = sha(readFileSync(journalPath)), beforeAccount = f.accounts.get(owner.id);
  const initial = await (await f.request("", undefined, owner.cookie)).json();
  assert.deepEqual(initial, { id: owner.id, email: "owner@example.test", emailVerified: false, recoveryAvailable: false, emailChangeAvailable: true });

  const registration = await f.requestAuth("/oauth2/register", { client_name: "Synthetic recovery client", redirect_uris: ["https://ai.example.test/callback"],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "journal:read journal:write offline_access" });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const authorize = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://ai.example.test/callback", response_type: "code",
      scope: "journal:read journal:write offline_access", resource: f.baseURL + "/mcp", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "synthetic-recovery", prompt: "consent" });
    const started = await f.requestAuth("/oauth2/authorize?" + query, undefined, owner.cookie);
    assert.equal(started.status, 302);
    const consentURL = new URL(started.headers.get("location")!, f.baseURL);
    const approved = await f.requestAuth("/oauth2/consent", { accept: true, oauth_query: consentURL.search.slice(1) }, owner.cookie);
    assert.equal(approved.status, 200);
    return { code: new URL((await approved.json()).url).searchParams.get("code")!, verifier };
  };
  const exchange = (grant: { code: string; verifier: string }) => f.auth.handler(new Request(f.baseURL + "/api/auth/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id,
      redirect_uri: "https://ai.example.test/callback", code: grant.code, code_verifier: grant.verifier, resource: f.baseURL + "/mcp" }),
  }));
  const issued = await exchange(await authorize()); assert.equal(issued.status, 200); const tokens = await issued.json();
  assert.ok(tokens.refresh_token);
  const session = await f.auth.api.getSession({ headers: new Headers({ cookie: owner.cookie }) }); assert.ok(session);
  // A stored opaque access token exercises the nullable foreign key even when
  // this provider's normal access-token representation is a signed JWT.
  await f.context.adapter.create({ model: "oauthAccessToken", data: { token: "synthetic-stored-access-token", clientId: client.client_id, userId: owner.id,
    sessionId: session.session.id, scopes: ["journal:read"], createdAt: new Date(), expiresAt: new Date(Date.now() + 900_000) } });
  const beforeConsents = f.database.prepare('SELECT * FROM "oauthConsent" WHERE userId = ? ORDER BY id').all(owner.id);

  assert.equal((await f.request("/email-change", { newEmail: email, currentPassword: "incorrect-password" }, owner.cookie)).status, 403);
  assert.equal((await f.request("/email-change", { newEmail: email.toUpperCase(), currentPassword: password }, owner.cookie)).status, 200);
  const confirmation = f.messages.at(-1)!; assert.equal(confirmation.to, email); assert.equal(confirmation.kind, "email-change");
  assert.equal(new URL(confirmation.url).origin, f.baseURL); assert.equal(new URL(confirmation.url).search, "");
  const emailToken = tokenFrom(confirmation);
  assert.equal((await (await f.request("", undefined, owner.cookie)).json()).email, "owner@example.test");
  assert.equal((await f.request("/confirm-email", { token: emailToken }, owner.cookie, { method: "GET" })).status, 405);
  assert.equal((await f.request("/confirm-email", { token: emailToken }, other.cookie)).status, 400);
  assert.equal((await f.request("/confirm-email", { token: emailToken }, owner.cookie)).status, 200);
  assert.equal((await f.request("/confirm-email", { token: emailToken }, owner.cookie)).status, 400);
  const account = await (await f.request("", undefined, owner.cookie)).json();
  assert.equal(account.id, owner.id); assert.equal(account.email, email); assert.equal(account.recoveryAvailable, true);
  assert.deepEqual(f.database.prepare('SELECT * FROM "oauthConsent" WHERE userId = ? ORDER BY id').all(owner.id), beforeConsents);
  assert.equal((await f.requestAuth("/sign-in/email", { email: "owner@example.test", password })).status, 401);
  const signIn = await f.requestAuth("/sign-in/email", { email, password }); assert.equal(signIn.status, 200);
  assert.equal((await signIn.clone().json()).user.id, owner.id); const secondCookie = cookieFrom(signIn);

  const pending = await authorize(), resetOne = await f.resetLink(), resetTwo = await f.resetLink();
  // The explicit second approval above legitimately updates the consent's
  // timestamp. Recovery must preserve that most recently approved record.
  const beforeResetConsents = f.database.prepare('SELECT * FROM "oauthConsent" WHERE userId = ? ORDER BY id').all(owner.id);
  const verificationRows = f.database.prepare('SELECT identifier, value FROM "verification"').all();
  assert.doesNotMatch(JSON.stringify(verificationRows), new RegExp(resetOne + "|" + resetTwo));
  await f.context.adapter.create({ model: "verification", data: { identifier: "other-owner-pending", value: JSON.stringify({ type: "authorization_code", userId: other.id }), expiresAt: new Date(Date.now() + 60_000) } });
  const beforeRefresh = f.database.prepare('SELECT id, token, revoked FROM "oauthRefreshToken" WHERE userId = ? ORDER BY id').all(owner.id);
  const resetRace = await Promise.all([f.request("/reset-password", { token: resetOne, newPassword: nextPassword }), f.request("/reset-password", { token: resetTwo, newPassword: "different-synthetic-new-password" })]);
  assert.deepEqual(resetRace.map(r => r.status).sort(), [200, 400]);
  assert.equal(resetRace[0].status, 200, "first owner lock wins deterministically");
  assert.equal((await f.request("/reset-password", { token: resetOne, newPassword: nextPassword })).status, 400);
  assert.equal((await f.request("", undefined, owner.cookie)).status, 401);
  assert.equal((await f.request("", undefined, secondCookie)).status, 401);
  assert.equal((await f.request("", undefined, other.cookie)).status, 200);
  assert.deepEqual(f.database.prepare('SELECT * FROM "oauthConsent" WHERE userId = ? ORDER BY id').all(owner.id), beforeResetConsents);
  assert.deepEqual(f.database.prepare('SELECT id, token, revoked FROM "oauthRefreshToken" WHERE userId = ? ORDER BY id').all(owner.id), beforeRefresh);
  for (const table of ["oauthAccessToken", "oauthRefreshToken"]) {
    const rows = f.database.prepare(`SELECT sessionId, revoked FROM "${table}" WHERE userId = ?`).all(owner.id) as Array<{ sessionId: string | null; revoked: string | null }>;
    assert.ok(rows.length); assert.ok(rows.every(row => row.sessionId === null && row.revoked === null));
  }
  assert.ok(f.database.prepare('SELECT id FROM "verification" WHERE identifier = ?').get("other-owner-pending"));
  assert.equal((await exchange(pending)).status, 400, "stored pre-reset authorization code is consumed by recovery cleanup");
  assert.equal((await verifyGrant(f.auth, f.accounts, f.baseURL, "Bearer " + tokens.access_token)).userId, owner.id);
  const refresh = await f.auth.handler(new Request(f.baseURL + "/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource: f.baseURL + "/mcp" }) }));
  assert.equal(refresh.status, 200); const renewed = await refresh.json();
  assert.equal((await verifyGrant(f.auth, f.accounts, f.baseURL, "Bearer " + renewed.access_token)).userId, owner.id);
  assert.equal((await f.requestAuth("/sign-in/email", { email, password })).status, 401);
  const restored = await f.requestAuth("/sign-in/email", { email, password: nextPassword }); assert.equal(restored.status, 200);
  assert.equal((await restored.json()).user.id, owner.id);
  assert.deepEqual(f.accounts.get(owner.id), beforeAccount);
  assert.equal(sha(readFileSync(journalPath)), beforeJournal);
  const read = Journal.open(journalPath); try { assert.equal(read.count(), 1); assert.equal(read.verify().ok, true); } finally { read.close(); }
});

test("account challenges reject stale credentials, expired links, email races and malformed inputs", async t => {
  const f = await fixture(t), a = await f.signup("a@example.test"), b = await f.signup("b@example.test");
  const target = "shared@recovery-fixture.org";
  for (const owner of [a, b]) assert.equal((await f.request("/email-change", { newEmail: target, currentPassword: password }, owner.cookie)).status, 200);
  const [aToken, bToken] = f.messages.map(tokenFrom);
  const collision = await Promise.all([f.request("/confirm-email", { token: aToken }, a.cookie), f.request("/confirm-email", { token: bToken }, b.cookie)]);
  assert.deepEqual(collision.map(r => r.status).sort(), [200, 400]);
  assert.equal((f.database.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email = ?').get(target) as { n: number }).n, 1);
  assert.equal((await (await f.request("", undefined, b.cookie)).json()).id, b.id);
  assert.equal((await f.request("/email-change", { newEmail: "expires@recovery-fixture.org", currentPassword: password }, b.cookie)).status, 200);
  const expired = tokenFrom(f.messages.at(-1)!);
  f.database.prepare('UPDATE "verification" SET expiresAt = ? WHERE identifier = ?').run(new Date(1).toISOString(), "kairos-account-access-v1:" + sha(expired));
  assert.equal((await f.request("/confirm-email", { token: expired }, b.cookie)).status, 400);
  assert.equal((await f.request("/email-change", { newEmail: "stale@recovery-fixture.org", currentPassword: password }, b.cookie)).status, 200);
  const stale = tokenFrom(f.messages.at(-1)!);
  f.database.prepare('UPDATE "account" SET password = ? WHERE userId = ? AND providerId = ?').run(await f.context.password.hash(nextPassword), b.id, "credential");
  assert.equal((await f.request("/confirm-email", { token: stale }, b.cookie)).status, 400);
  const reset = await f.resetLink(target);
  f.database.prepare('UPDATE "user" SET email = ? WHERE id = ?').run("changed@recovery-fixture.org", a.id);
  assert.equal((await f.request("/reset-password", { token: reset, newPassword: nextPassword })).status, 400, "link binds current email and immutable owner");
  assert.equal((await f.request("/reset-password", { token: "malformed", newPassword: nextPassword })).status, 400);
  assert.equal((await f.request("/email-change", { newEmail: "x@example.test", currentPassword: nextPassword }, b.cookie)).status, 400);
  assert.equal((await f.request("/email-change", { newEmail: email, currentPassword: password }, a.cookie, { origin: "https://hostile.example" })).status, 403);
  assert.equal((await f.request("/confirm-email", { token: aToken })).status, 401);
  for (const path of ["/change-email", "/verify-email", "/send-verification-email", "/request-password-reset", "/reset-password", "/change-password"]) {
    assert.equal((await f.requestAuth(path, {})).status, 404, path + " cannot bypass account wrapper");
  }
  for (const invalid of ["a@example.test", "a@example.com", "a@localhost", "a@thing.invalid", "a@thing.example", "a@-bad.org", "a@bad-.org", "a@bad..org", "a\r\nb@site.org"]) assert.equal(realAccountEmail(invalid), undefined);
});

test("forgot-password is generic for unverified, unknown, synthetic and disabled delivery; delivery failures leave no valid challenge", async t => {
  const f = await fixture(t), owner = await f.signup("recovery@example.test");
  const generic = await (await f.request("/forgot-password", { email })).json();
  for (const address of ["recovery@example.test", "absent@recovery-fixture.org", "invalid", "a@example.com"]) assert.deepEqual(await (await f.request("/forgot-password", { email: address })).json(), generic);
  f.database.prepare('UPDATE "user" SET email = ? WHERE id = ?').run(email, owner.id);
  assert.deepEqual(await (await f.request("/forgot-password", { email })).json(), generic); assert.equal(f.messages.length, 0, "unverified real mailbox is ineligible");
  f.database.prepare('UPDATE "user" SET email = ?, emailVerified = 1 WHERE id = ?').run("recovery@example.test", owner.id);
  assert.deepEqual(await (await f.request("/forgot-password", { email: "recovery@example.test" })).json(), generic); assert.equal(f.messages.length, 0);
  const disabled = createAccountAccess({ auth: f.auth, database: f.database, accounts: f.accounts, baseURL: f.baseURL });
  assert.equal((await (await f.request("", undefined, owner.cookie, { handler: disabled })).json()).emailChangeAvailable, false);
  assert.equal((await f.request("/email-change", { newEmail: email, currentPassword: password }, owner.cookie, { handler: disabled })).status, 503);
  assert.deepEqual(await (await f.request("/forgot-password", { email }, undefined, { handler: disabled })).json(), generic);
  const failed = createAccountAccess({ auth: f.auth, database: f.database, accounts: f.accounts, baseURL: f.baseURL, delivery: { send: async () => { throw new Error("synthetic transport failure"); } } });
  assert.equal((await f.request("/email-change", { newEmail: email, currentPassword: password }, owner.cookie, { handler: failed })).status, 503);
  assert.equal((f.database.prepare('SELECT COUNT(*) AS n FROM "verification" WHERE identifier LIKE ?').get("kairos-account-access-v1:%") as { n: number }).n, 0);
  assert.equal((await (await f.request("", undefined, owner.cookie)).json()).email, "recovery@example.test");
  f.database.prepare('UPDATE "user" SET email = ?, emailVerified = 1 WHERE id = ?').run(email, owner.id);
  assert.deepEqual(await (await f.request("/forgot-password", { email }, undefined, { handler: failed })).json(), generic);
  assert.equal((f.database.prepare('SELECT COUNT(*) AS n FROM "verification" WHERE identifier LIKE ?').get("kairos-account-access-v1:%") as { n: number }).n, 0);
});

test("password-reset tokens expire, bind the current password and allow one winner for simultaneous use", async t => {
  const f = await fixture(t), owner = await f.signup("reset-races@example.test");
  await f.promote(owner);
  const expired = await f.resetLink();
  f.database.prepare('UPDATE "verification" SET expiresAt = ? WHERE identifier = ?').run(new Date(1).toISOString(), "kairos-account-access-v1:" + sha(expired));
  assert.equal((await f.request("/reset-password", { token: expired, newPassword: nextPassword })).status, 400);
  const stale = await f.resetLink();
  f.database.prepare('UPDATE "account" SET password = ? WHERE userId = ? AND providerId = ?').run(await f.context.password.hash("synthetic-intermediate-password"), owner.id, "credential");
  assert.equal((await f.request("/reset-password", { token: stale, newPassword: nextPassword })).status, 400);
  const token = await f.resetLink();
  assert.equal((await f.request("/reset-password", { token, newPassword: "too-short" })).status, 400);
  assert.equal((await f.request("/reset-password", { token, newPassword: "x".repeat(129) })).status, 400);
  const results = await Promise.all([f.request("/reset-password", { token, newPassword: nextPassword }), f.request("/reset-password", { token, newPassword: nextPassword })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  const signedIn = await f.requestAuth("/sign-in/email", { email, password: nextPassword });
  assert.equal(signedIn.status, 200); assert.equal((await signedIn.json()).user.id, owner.id);
});

test("account limits bound password checks and email delivery, and issuance awaits transport completion", async t => {
  const f = await fixture(t), owner = await f.signup("limits@example.test");
  for (let i = 0; i < 5; i++) assert.equal((await f.request("/email-change", { newEmail: email, currentPassword: "incorrect-password" }, owner.cookie)).status, 403);
  assert.equal((await f.request("/email-change", { newEmail: email, currentPassword: password }, owner.cookie)).status, 429);
  for (let i = 0; i < 30; i++) assert.equal((await f.request("/forgot-password", { email: "unknown@recovery-fixture.org" }, undefined, { rateKey: "one-ip" })).status, 200);
  assert.equal((await f.request("/forgot-password", { email: "unknown@recovery-fixture.org" }, undefined, { rateKey: "one-ip" })).status, 429);
  f.database.prepare('UPDATE "user" SET email = ?, emailVerified = 1 WHERE id = ?').run(email, owner.id);
  for (let i = 0; i < 4; i++) assert.equal((await f.request("/forgot-password", { email })).status, 200);
  assert.equal(f.messages.length, 3, "email-specific limit does not reveal recipient existence in response");
  let complete!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { complete = resolve; }), sending = new Promise<void>(resolve => { entered = resolve; });
  const delayed = createAccountAccess({ auth: f.auth, database: f.database, accounts: f.accounts, baseURL: f.baseURL,
    delivery: { send: async () => { entered(); await waiting; } } });
  let settled = false;
  const pending = f.request("/email-change", { newEmail: "delayed@recovery-fixture.org", currentPassword: password }, owner.cookie, { handler: delayed }).then(result => { settled = true; return result; });
  await sending; assert.equal(settled, false); complete(); assert.equal((await pending).status, 200);
});
