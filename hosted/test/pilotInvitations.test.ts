// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { restoreBackup } from "../src/recovery.js";
import { MUSE_CONNECTOR_CLIENT_ID } from "../src/auth.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStaging } from "../src/service.js";
import { invitationHash, parsePilotInvitations, pilotInvitationsFromEnvironment } from "../src/pilotInvitations.js";
import { page } from "../src/pages.js";
import type { AccountMail } from "../src/accountAccess.js";

test("pilot invitations require explicit valid configuration and join pages never embed a code", () => {
  const invitation = { email: "alice@beta-fixture.net", codeHash: "a".repeat(64), expiresAt: Date.now() + 60_000 };
  assert.equal(pilotInvitationsFromEnvironment({}), undefined);
  assert.equal(parsePilotInvitations([invitation]).length, 1);
  for (const input of [[], {}, [invitation, invitation], [{ ...invitation, email: "Alice@beta-fixture.net" }],
    [{ ...invitation, email: "owner@example.test" }], [{ ...invitation, expiresAt: NaN }], [{ ...invitation, code: "secret" }]]) {
    assert.throws(() => parsePilotInvitations(input));
  }
  const output = page("join", undefined, { staging: true, accountRecovery: true });
  assert.match(output.html, /Create my account/);
  assert.match(output.html, /api\/pilot\/register/);
  assert.doesNotMatch(output.html, /localStorage|KAIROS_STAGING_INVITE|emailVerified:true/);
  assert.match(output.csp, /form-action 'self'/);
});

test("operator preparation writes private files outside Git and never prints the code", () => {
  const root = mkdtempSync(join(tmpdir(), "kairos-invite-files-"));
  const script = fileURLToPath(new URL("../../../scripts/prepare-pilot-invitation.mjs", import.meta.url));
  try {
    const directory = join(root, "new"), args = [script, "--email", "alice@beta-fixture.net", "--out", directory];
    const run = spawnSync(process.execPath, args, { encoding: "utf8" }); assert.equal(run.status, 0, run.stderr);
    const invitation = readFileSync(join(directory, "invitation.txt"), "utf8");
    const code = invitation.match(/Personal invitation code: ([A-Za-z0-9_-]{43})/)![1];
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest[0].codeHash, invitationHash(code)); assert.ok(!JSON.stringify(manifest).includes(code));
    assert.ok(!run.stdout.includes(code)); assert.equal(statSync(directory).mode & 0o777, 0o700);
    for (const name of ["manifest.json", "invitation.txt"]) assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
    assert.notEqual(spawnSync(process.execPath, args).status, 0, "refuse overwrites");
    const forbidden = fileURLToPath(new URL("../../../../private-invite-must-not-exist", import.meta.url));
    assert.notEqual(spawnSync(process.execPath, [script, "--email", "alice@beta-fixture.net", "--out", forbidden]).status, 0);
    assert.equal(existsSync(forbidden), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("per-person signup, concurrency, restart, verification and isolation", { timeout: 90_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-friends-test-"));
  const socket = net.createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const baseURL = "https://friends.example.test", codeA = randomBytes(32).toString("base64url"), codeB = randomBytes(32).toString("base64url");
  const expired = randomBytes(32).toString("base64url"), unused = randomBytes(32).toString("base64url"), emailA = "alice@beta-fixture.net", emailB = "bob@beta-fixture.net";
  const mail: AccountMail[] = []; // Local delivery capture only. No external email.
  const options = { baseURL, port, directory, secret: randomBytes(32).toString("hex"), inviteCode: randomBytes(32).toString("hex"),
    sourceRevision: "1".repeat(40), accountDelivery: { send: async (message: AccountMail) => { mail.push(message); } },
    pilotInvitations: [
      { email: emailA, codeHash: invitationHash(codeA), expiresAt: Date.now() + 60_000 },
      { email: emailB, codeHash: invitationHash(codeB), expiresAt: Date.now() + 60_000 },
      { email: "expired@beta-fixture.net", codeHash: invitationHash(expired), expiresAt: Date.now() - 1 },
      { email: "unused@beta-fixture.net", codeHash: invitationHash(unused), expiresAt: Date.now() + 60_000 },
    ],
  };
  let service = await createStaging(options); await service.listen();
  const request = (path: string, body?: unknown, cookie?: string, overrides: Record<string, string> = {}): Promise<Response> => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { host: "friends.example.test", "x-forwarded-proto": "https", origin: baseURL,
        "content-type": "application/json", connection: "close", ...(cookie ? { cookie } : {}), ...overrides },
    }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => { const headers = new Headers(); for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers })); });
      res.on("error", reject);
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const cookie = (r: Response) => r.headers.getSetCookie().map(c => c.split(";", 1)[0]).join("; ");
  const password = "synthetic-beta-password-123";
  const register = (email: string, invite_code: string, extra = {}) => request("/api/pilot/register", { email, invite_code, password, ...extra });
  let ownerCookie = "", aliceCookie = "", bobCookie = "", aliceID = "", ownerToken = "";
  const ownerRead = () => request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "journal_wake", arguments: {} } }, undefined,
    { authorization: "Bearer " + ownerToken, accept: "application/json, text/event-stream" });
  const recoveryRoot = mkdtempSync(join(dirname(directory), "kairos-friends-recovery-test-"));
  try {
    await t.test("normal-address signup stays closed without the personal route; no origin or broad grant bypass", async () => {
      assert.equal((await request("/api/auth/sign-up/email", { email: emailA, password, name: "Test", invite_code: options.inviteCode })).status, 400);
      for (const path of ["/api/auth/sign-up/email/", "/api/auth/sign-up/email//", "/api/auth/%73ign-up/email"]) {
        const denied = await request(path, { email: emailA, password, name: "Test", invite_code: options.inviteCode });
        assert.ok(denied.status >= 400, path);
      }
      assert.equal((await request("/api/pilot/register", { email: emailA, password, invite_code: codeA }, undefined, { origin: "https://evil.example.test" })).status, 403);
      assert.equal((await register(emailB, codeA)).status, 403);
      assert.equal((await register("expired@beta-fixture.net", expired)).status, 403);
      assert.equal((await register(emailA, codeA, { password: "short" })).status, 400);
      const owner = await request("/api/auth/sign-up/email", { email: "owner@example.test", password, name: "Owner", invite_code: options.inviteCode });
      assert.equal(owner.status, 200); ownerCookie = cookie(owner);
      const ownerID = (await owner.json()).user.id;
      const { adapter } = await service.auth.$context;
      await adapter.create({ model: "oauthConsent", data: { clientId: MUSE_CONNECTOR_CLIENT_ID, userId: ownerID,
        scopes: ["journal:read", "journal:write"], createdAt: new Date(), updatedAt: new Date() } });
      ownerToken = (await service.auth.api.signJWT({ body: { payload: { iss: baseURL + "/api/auth", aud: baseURL + "/mcp", sub: ownerID,
        azp: MUSE_CONNECTOR_CLIENT_ID, scope: "journal:read journal:write", kairos_epoch: service.accounts.get(ownerID).epoch,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 } } })).token;
      assert.equal((await request("/api/journal/notes", { text: "SYNTHETIC OWNER NOTE — preserve", tags: ["project-owner"] }, ownerCookie)).status, 201);
      assert.equal((await request("/api/pilot/register", { email: emailA, invite_code: codeA, password }, ownerCookie)).status, 409);
      assert.equal((await ownerRead()).status, 200);
    });
    await t.test("one concurrent attempt wins; caller cannot inject verified email or redirect fields", async () => {
      const responses = await Promise.all([register(emailA, codeA, { emailVerified: true, callbackURL: "https://evil.example.test" }), register(emailA, codeA)]);
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 403]);
      const created = responses.find(r => r.status === 200)!; aliceCookie = cookie(created);
      assert.ok(created.headers.getSetCookie().some(c => /Secure/.test(c) && /HttpOnly/.test(c)));
      const account = await (await request("/api/account", undefined, aliceCookie)).json();
      assert.equal(account.emailVerified, false); assert.equal(account.recoveryAvailable, false); aliceID = account.id;
      assert.equal((await request("/api/journal/notes", { text: "SYNTHETIC ALICE ONLY", tags: [] }, aliceCookie)).status, 201);
      const owner = await (await request("/api/journal", undefined, ownerCookie)).json(); assert.equal(owner.count, 1); assert.match(owner.entries[0].text, /OWNER NOTE/);
    });
    await t.test("a second recipient has an independent account and journal", async () => {
      const created = await register(emailB, codeB); assert.equal(created.status, 200); bobCookie = cookie(created);
      const journal = await (await request("/api/journal", undefined, bobCookie)).json(); assert.equal(journal.count, 0); assert.deepEqual(journal.connections, []);
      const alice = await (await request("/api/journal", undefined, aliceCookie)).json(); assert.equal(alice.count, 1); assert.match(alice.entries[0].text, /ALICE ONLY/);
    });
    await t.test("same-email verification is bound to that account and enables existing recovery", async () => {
      assert.equal((await request("/api/account/email-change", { newEmail: emailA, currentPassword: password }, aliceCookie)).status, 200);
      assert.equal(mail.length, 1); assert.equal(mail[0].to, emailA);
      const token = new URLSearchParams(new URL(mail[0].url).hash.slice(1)).get("token");
      assert.equal((await request("/api/account/confirm-email", { token }, bobCookie)).status, 400);
      assert.equal((await request("/api/account/confirm-email", { token }, aliceCookie)).status, 200);
      const account = await (await request("/api/account", undefined, aliceCookie)).json(); assert.equal(account.id, aliceID); assert.equal(account.emailVerified, true); assert.equal(account.recoveryAvailable, true);
      assert.equal((await request("/api/account/confirm-email", { token }, aliceCookie)).status, 400);
      assert.equal((await request("/api/account/forgot-password", { email: emailA })).status, 200);
    });
    await t.test("consumption survives restart; existing sessions and notes remain; raw invitation codes are absent from DB", async () => {
      await service.close(); service = await createStaging(options); await service.listen();
      assert.equal((await register(emailA, codeA)).status, 403);
      const owner = await (await request("/api/journal", undefined, ownerCookie)).json(); assert.equal(owner.count, 1);
      const alice = await (await request("/api/journal", undefined, aliceCookie)).json(); assert.equal(alice.count, 1);
      assert.equal((await ownerRead()).status, 200, "the existing owner's signed AI grant still works after signup and restart");
      const bytes = readFileSync(join(directory, "auth.db")); assert.equal(bytes.includes(Buffer.from(codeA)), false); assert.equal(bytes.includes(Buffer.from(codeB)), false);
    });
    await t.test("controlled recovery captures the optional ledger and retires unconsumed codes", async () => {
      const backup = join(recoveryRoot, "backup"), witness = join(recoveryRoot, "witness.json"), restored = join(recoveryRoot, "restored");
      await service.captureRecovery({ backup, witness, sourceRevision: options.sourceRevision });
      const sha = createHash("sha256").update(readFileSync(witness)).digest("hex");
      const receipt = restoreBackup({ backup, witness, output: restored, expectedWitnessSha256: sha });
      assert.equal(receipt.entries, 2);
      await service.close(); service = await createStaging({ ...options, directory: restored }); await service.listen();
      assert.equal((await register("unused@beta-fixture.net", unused)).status, 403);
      assert.equal((await ownerRead()).status, 401, "controlled restore retains its existing reauthorization requirement");
    });
    await t.test("unconfigured service has no join or pilot-registration endpoint", async () => {
      await service.close(); service = await createStaging({ ...options, pilotInvitations: undefined }); await service.listen();
      assert.equal((await request("/join")).status, 404); assert.equal((await register(emailA, codeA)).status, 404);
      const owner = await (await request("/api/journal", undefined, ownerCookie)).json(); assert.equal(owner.count, 1);
    });
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); rmSync(recoveryRoot, { recursive: true, force: true }); }
});
