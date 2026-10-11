// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { Accounts } from "../src/accounts.js";
import { acquireDataLease } from "../src/dataLease.js";
import { captureBackup, captureDeletionWitness, restoreBackup, type BackupManifest } from "../src/recovery.js";
import { createPreview } from "../src/service.js";
import { Journal } from "../../src/journal.js";

async function freePort(): Promise<number> {
  const s = net.createServer(); await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(r => s.close(() => r())); return port;
}
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

test("controlled offline recovery: real credentials, deletion history and incomplete bundles", { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "kairos-recovery-acceptance-"));
  const source = join(root, "service"), bundle = join(root, "backup"), witness = join(root, "deletion-witness.json"), restored = join(root, "restored");
  const baseURL = `http://127.0.0.1:${await freePort()}`, secret = randomBytes(32).toString("hex");
  let service: Awaited<ReturnType<typeof createPreview>> | undefined;
  const start = async (directory: string) => { service = await createPreview({ baseURL, directory, secret }); await service.listen(); return service; };
  const stop = async () => { if (service) { await service.close(); service = undefined; } };
  const request = (path: string, opts: RequestInit = {}) => fetch(baseURL + path, { redirect: "manual", ...opts, headers: { connection: "close", ...opts.headers } });
  const post = (path: string, value: unknown, cookie?: string) => request(path, { method: "POST", headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value) });
  const cookies = (r: Response) => r.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
  const password = "synthetic-recovery-test-password";
  const signup = async (email: string) => { const r = await post("/api/auth/sign-up/email", { email, name: "Synthetic recovery", password }); assert.equal(r.status, 200); return { cookie: cookies(r), user: (await r.json()).user }; };
  const signin = async (email: string) => { const r = await post("/api/auth/sign-in/email", { email, password }); assert.equal(r.status, 200); return cookies(r); };
  const grant = async (clientId: string, cookie: string) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: "https://synthetic-ai.example.test/callback", response_type: "code", scope: "journal:read journal:write offline_access", resource: baseURL + "/mcp", code_challenge: sha(verifier) });
    query.set("code_challenge", createHash("sha256").update(verifier).digest("base64url")); query.set("code_challenge_method", "S256"); query.set("prompt", "consent");
    const a = await request("/api/auth/oauth2/authorize?" + query, { mode: "same-origin", headers: { cookie, accept: "text/html" } });
    assert.equal(a.status, 302);
    const consent = new URL(a.headers.get("location")!, baseURL); assert.equal(consent.pathname, "/consent");
    const approved = await post("/api/auth/oauth2/consent", { accept: true, oauth_query: consent.search.slice(1) }, cookie); assert.equal(approved.status, 200);
    const code = new URL((await approved.json()).url).searchParams.get("code")!;
    const r = await request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: "https://synthetic-ai.example.test/callback", code, code_verifier: verifier, resource: baseURL + "/mcp" }) });
    assert.equal(r.status, 200); return r.json();
  };
  const call = (token: string) => request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "journal_continue", arguments: { project: "kitchen" } } }) });
  const refresh = (token: string, clientId: string) => request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId, resource: baseURL + "/mcp" }) });
  let a: Awaited<ReturnType<typeof signup>>, b: Awaited<ReturnType<typeof signup>>, at: any, bt: any, clientId: string, manifest: BackupManifest, witnessHash: string;
  try {
    await t.test("old control schema migrates without changing its access generation", () => {
      const legacy = join(root, "legacy"); const lease = acquireDataLease(legacy); lease();
      const db = new Database(join(legacy, "control.db")); db.exec("CREATE TABLE accounts(user_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0); INSERT INTO accounts VALUES('legacy',7,0)"); db.close();
      const accounts = new Accounts(legacy); try { assert.deepEqual(accounts.get("legacy"), { user_id: "legacy", epoch: 7, deleted: 0, journal_generation: 1 }); } finally { accounts.close(); }
    });
    await t.test("service finishes plugin initialization before immediate close", async () => {
      const s = await createPreview({ baseURL, directory: source, secret }); await s.close();
      const release = acquireDataLease(source); release();
    });
    await t.test("active service excludes another service and all offline maintenance", async () => {
      await start(source);
      await assert.rejects(createPreview({ baseURL, directory: source, secret }), /leased/);
      await assert.rejects(captureBackup(source, bundle, "a".repeat(40)), /leased/);
      assert.throws(() => captureDeletionWitness(source, witness), /leased/);
      assert.ok(!existsSync(bundle));
    });
    await t.test("two isolated users write notes and obtain actual PKCE grants before backup", async () => {
      a = await signup("recover-a@example.test"); b = await signup("recover-b@example.test");
      assert.equal((await post("/api/journal/notes", { text: "SYNTHETIC: A kitchen tile is cobalt blue", tags: ["project-kitchen"] }, a.cookie)).status, 201);
      assert.equal((await post("/api/journal/notes", { text: "SYNTHETIC: B kitchen tile is terracotta", tags: ["project-kitchen"] }, b.cookie)).status, 201);
      const r = await post("/api/auth/oauth2/register", { client_name: "Synthetic recovery AI", redirect_uris: ["https://synthetic-ai.example.test/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "journal:read journal:write offline_access" }); assert.equal(r.status, 201); clientId = (await r.json()).client_id;
      at = await grant(clientId, a.cookie); bt = await grant(clientId, b.cookie);
      assert.equal((await call(at.access_token)).status, 200); await stop();
    });
    await t.test("offline backup captures every database, verifies chains and refuses overwrites", async () => {
      manifest = await captureBackup(source, bundle, "a".repeat(40));
      assert.equal(manifest.users.length, 2); assert.equal(manifest.journals.length, 2); assert.equal(manifest.files.length, 4);
      assert.deepEqual(readdirSync(bundle).sort(), [...manifest.files.map(f => f.name), "manifest.json"].sort());
      assert.equal(statSync(bundle).mode & 0o777, 0o700);
      for (const f of manifest.files) { assert.equal(sha(readFileSync(join(bundle, f.name))), f.sha256); assert.equal(statSync(join(bundle, f.name)).mode & 0o777, 0o600); }
      const prior = sha(readFileSync(join(bundle, "manifest.json")));
      await assert.rejects(captureBackup(source, bundle, "a".repeat(40)), /overwrite/); assert.equal(sha(readFileSync(join(bundle, "manifest.json"))), prior);
    });
    await t.test("complete recovery preserves two active journals and their owner isolation", async () => {
      const path = join(root, "baseline-witness.json"), current = captureDeletionWitness(source, path);
      const directory = join(root, "both-restored");
      const receipt = restoreBackup({ backup: bundle, output: directory, witness: path, expectedWitnessSha256: current.sha256 });
      assert.equal(receipt.entries, 2); assert.equal(receipt.journals, 2);
      await start(directory);
      for (const [email, wanted, absent] of [["recover-a@example.test", "cobalt blue", "terracotta"], ["recover-b@example.test", "terracotta", "cobalt blue"]]) {
        const cookie = await signin(email), response = await request("/api/journal", { headers: { cookie } });
        assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.count, 1); assert.match(JSON.stringify(data), new RegExp(wanted)); assert.doesNotMatch(JSON.stringify(data), new RegExp(absent));
      }
      await stop();
    });
    await t.test("later disconnect and deletion are captured separately from the backup", async () => {
      await start(source);
      assert.equal((await post("/api/journal/disconnect", {}, a.cookie)).status, 200);
      assert.equal((await request("/api/journal", { method: "DELETE", headers: { origin: baseURL, cookie: b.cookie } })).status, 200);
      assert.equal((await call(at.access_token)).status, 401); await stop();
      const result = captureDeletionWitness(source, witness); witnessHash = result.sha256;
      assert.equal(result.witness.accounts.find(x => x.user_id === b.user.id)!.deleted, 1);
      assert.equal(result.witness.accounts.find(x => x.user_id === a.user.id)!.journal_generation, 1);
    });
    await t.test("controlled restore recovers A notes, discards deleted B notes and removes all old authorization", async () => {
      // Deliberately sign a collision fixture using the ORIGINAL key but the
      // generation the restored process will use. Epoch mismatch cannot be the
      // reason this token fails after fresh consent.
      const original = await start(source);
      const witnessState = JSON.parse(readFileSync(witness, "utf8"));
      const restoredEpoch = witnessState.accounts.find((x: { user_id: string }) => x.user_id === a.user.id).epoch + 1;
      const collision = await original.auth.api.signJWT({ body: { payload: { ...decodeJwt(at.access_token), kairos_epoch: restoredEpoch } } });
      await stop();
      const result = restoreBackup({ backup: bundle, output: restored, witness, expectedWitnessSha256: witnessHash });
      assert.equal(result.entries, 1); assert.equal(result.discarded_deleted_journals, 1); assert.equal(result.reauthorization_required, true);
      const db = new Database(join(restored, "auth.db"), { readonly: true }); try { for (const table of ["session", "jwks", "verification", "oauthConsent", "oauthAccessToken", "oauthRefreshToken"]) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n, 0); } finally { db.close(); }
      assert.ok(!existsSync(join(restored, `journal-${sha(b.user.id)}.db`)));
      await start(restored);
      assert.equal((await request("/api/journal", { headers: { cookie: a.cookie } })).status, 401);
      assert.equal((await call(at.access_token)).status, 401); assert.equal((await call(bt.access_token)).status, 401);
      assert.ok(!(await refresh(at.refresh_token, clientId)).ok);
      const ac = await signin("recover-a@example.test"), bc = await signin("recover-b@example.test");
      const aj = await (await request("/api/journal", { headers: { cookie: ac } })).json(); assert.equal(aj.count, 1); assert.match(aj.entries[0].text, /cobalt blue/); assert.doesNotMatch(JSON.stringify(aj), /terracotta/);
      const bj = await (await request("/api/journal", { headers: { cookie: bc } })).json(); assert.equal(bj.deleted, true); assert.equal(bj.entries.length, 0);
      const fresh = await grant(clientId, ac); const response = await call(fresh.access_token); assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /cobalt blue/);
      assert.notEqual(decodeJwt(fresh.access_token).kairos_epoch, decodeJwt(at.access_token).kairos_epoch);
      assert.equal(decodeJwt(fresh.access_token).kairos_epoch, decodeJwt(collision.token).kairos_epoch);
      assert.notEqual(decodeProtectedHeader(fresh.access_token).kid, decodeProtectedHeader(collision.token).kid);
      assert.equal((await call(collision.token)).status, 401, "fresh signing material rejects an old-key token even when its epoch matches");
      // An independent client process reads the restored note over real MCP.
      const code = `import {Client} from '@modelcontextprotocol/sdk/client/index.js'; import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'; const c=new Client({name:'Synthetic recovery reader',version:'1'}); await c.connect(new StreamableHTTPClientTransport(new URL(${JSON.stringify(baseURL + "/mcp")}),{requestInit:{headers:{authorization:'Bearer '+process.env.KAIROS_TEST_RECOVERY_ACCESS}}})); try{console.log(JSON.stringify(await c.callTool({name:'journal_continue',arguments:{project:'kitchen'}})));} finally{await c.close();}`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, KAIROS_TEST_RECOVERY_ACCESS: fresh.access_token }, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", bytes => { output += bytes.toString(); });
      const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      assert.equal(exit, 0); assert.match(output, /cobalt blue/); assert.doesNotMatch(output, /terracotta/);
      // Even after new consent, a historical token signed with the restored key must not revive.
      assert.equal((await call(at.access_token)).status, 401); assert.ok(!(await refresh(at.refresh_token, clientId)).ok);
      await stop();
    });
    await t.test("missing or replaced files and mismatched schemas leave no partial output", () => {
      for (const kind of ["missing", "bytes", "schema", "chain", "mixed"]) {
        const copy = join(root, "broken-" + kind); cpSync(bundle, copy, { recursive: true });
        const manifestPath = join(copy, "manifest.json"); const m = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
        if (kind === "missing") rmSync(join(copy, m.journals[0].name));
        if (kind === "bytes") writeFileSync(join(copy, m.journals[0].name), "corrupt synthetic bytes");
        if (kind === "schema") m.auth_schema = "unknown";
        if (kind === "mixed") cpSync(join(source, "control.db"), join(copy, "control.db"));
        if (kind === "chain") {
          const name = m.journals[0].name, db = new Database(join(copy, name)); db.exec("DROP TRIGGER entries_no_update; UPDATE entries SET text='altered synthetic note'"); db.close();
          const file = m.files.find(f => f.name === name)!; const bytes = readFileSync(join(copy, name)); file.sha256 = sha(bytes); file.bytes = bytes.length;
        }
        writeFileSync(manifestPath, JSON.stringify(m));
        const out = join(root, "bad-output-" + kind);
        assert.throws(() => restoreBackup({ backup: copy, output: out, witness, expectedWitnessSha256: witnessHash })); assert.ok(!existsSync(out));
      }
    });
    await t.test("witness is mandatory, outside the bundle, hash-matched and not older", () => {
      assert.throws(() => captureDeletionWitness(source, join(source, "..hidden-output.json")), /outside/);
      assert.throws(() => restoreBackup({ backup: bundle, output: join(root, "no-witness"), witness: join(root, "absent"), expectedWitnessSha256: witnessHash }));
      assert.throws(() => restoreBackup({ backup: bundle, output: join(root, "bad-witness"), witness, expectedWitnessSha256: "0".repeat(64) }), /selected hash/);
      const old = JSON.parse(readFileSync(witness, "utf8")); old.captured_at = "2000-01-01T00:00:00Z";
      const older = join(root, "older-witness.json"); writeFileSync(older, JSON.stringify(old));
      assert.throws(() => restoreBackup({ backup: bundle, output: join(root, "old-witness"), witness: older, expectedWitnessSha256: sha(readFileSync(older)) }), /predates/);
      const inside = join(bundle, "witness.json"); cpSync(witness, inside);
      try { assert.throws(() => restoreBackup({ backup: bundle, output: join(root, "inside-witness"), witness: inside, expectedWitnessSha256: witnessHash }), /outside/); } finally { rmSync(inside); }
    });
    await t.test("deletion followed by recreation blocks a backup of the previous journal", async () => {
      await start(source); const cookie = await signin("recover-b@example.test");
      assert.equal((await post("/api/journal/create", {}, cookie)).status, 201); await stop();
      const later = join(root, "after-recreation.json"), result = captureDeletionWitness(source, later);
      assert.throws(() => restoreBackup({ backup: bundle, output: join(root, "resurrected"), witness: later, expectedWitnessSha256: result.sha256 }), /deleted and recreated/);
      assert.ok(!existsSync(join(root, "resurrected")));
    });
    await t.test("restores do not overwrite an existing directory and corrupt lock files fail closed", async () => {
      assert.throws(() => restoreBackup({ backup: bundle, output: restored, witness, expectedWitnessSha256: witnessHash }), /overwrite/);
      writeFileSync(join(source, ".kairos-data-lease.db"), "invalid lock, deliberately synthetic");
      await assert.rejects(captureBackup(source, join(root, "lease-backup"), "a".repeat(40)), /leased/);
      assert.equal(readFileSync(join(source, ".kairos-data-lease.db"), "utf8"), "invalid lock, deliberately synthetic");
    });
    await t.test("kernel lock survives competing processes and releases after a crash", async () => {
      const directory = join(root, "crash-lease");
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import {acquireDataLease} from ${JSON.stringify(new URL("../src/dataLease.js", import.meta.url).href)}; acquireDataLease(${JSON.stringify(directory)}); console.log('lease ready'); setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.once("data", bytes => bytes.toString().includes("lease ready") ? resolve() : reject(new Error("Child did not acquire its lease")));
          child.once("error", reject); child.once("exit", () => reject(new Error("Child exited before ready")));
        });
        assert.throws(() => acquireDataLease(directory), /leased/);
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
        const release = acquireDataLease(directory); release();
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    });
  } finally { await stop(); rmSync(root, { recursive: true, force: true }); }
});
