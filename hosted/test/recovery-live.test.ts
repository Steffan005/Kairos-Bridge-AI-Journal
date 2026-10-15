// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import http from "node:http";
import net from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreview } from "../src/service.js";
import { acquireDataLease, type DataLease } from "../src/dataLease.js";
import { captureBackup, captureRecoveryWhileLeased, restoreBackup } from "../src/recovery.js";
import { createRecoveryControl, requestRecoveryCapture } from "../src/recoveryControl.js";
import { Journal } from "../../src/journal.js";

async function freePort(): Promise<number> {
  const server = net.createServer(); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(r => server.close(() => r())); return port;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test("live capture drains an upload and auth work, preserves deletion state and resumes the same service", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kairos-live-capture-")), directory = join(root, "data");
  const baseURL = `http://127.0.0.1:${await freePort()}`;
  const service = await createPreview({ baseURL, directory, secret: randomBytes(32).toString("hex") });
  await service.listen();
  const request = (path: string, options: RequestInit = {}) => fetch(baseURL + path, { ...options, headers: { connection: "close", ...options.headers } });
  const post = (path: string, data: unknown, cookie?: string) => request(path, { method: "POST", headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(data) });
  const signup = async (email: string) => {
    const response = await post("/api/auth/sign-up/email", { email, name: "Synthetic live recovery", password: "synthetic-live-recovery-password" });
    assert.equal(response.status, 200);
    return { cookie: response.headers.getSetCookie().map(v => v.split(";")[0]).join("; "), user: (await response.json()).user };
  };
  const background = deferred();
  let upload: http.ClientRequest | undefined;
  try {
    const owner = await signup("live-owner@example.test"), deleted = await signup("live-deleted@example.test");
    assert.equal((await post("/api/journal/notes", { text: "SYNTHETIC baseline" }, owner.cookie)).status, 201);
    assert.equal((await post("/api/journal/notes", { text: "SYNTHETIC deleted contents" }, deleted.cookie)).status, 201);
    assert.equal((await request("/api/journal", { method: "DELETE", headers: { origin: baseURL, cookie: deleted.cookie } })).status, 200);

    const bytes = JSON.stringify({ text: "SYNTHETIC upload admitted before capture" });
    const admitted = new Promise<void>(resolve => service.server.once("request", () => resolve()));
    const uploaded = new Promise<number>((resolve, reject) => {
      upload = http.request(baseURL + "/api/journal/notes", { method: "POST", headers: { origin: baseURL, cookie: owner.cookie, "content-type": "application/json", "content-length": Buffer.byteLength(bytes), connection: "close" } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
      upload.on("error", reject); upload.write(bytes.slice(0, -1));
    });
    await admitted;
    const context = await service.auth.$context;
    context.runInBackground(background.promise.then(async () => {
      await context.adapter.create({ model: "verification", data: { identifier: "synthetic-background", value: "finished", expiresAt: new Date(Date.now() + 60_000) } });
    }));
    const backup = join(root, "backup"), witness = join(root, "witness.json");
    let settled = false;
    const capture = service.captureRecovery({ backup, witness, sourceRevision: "a".repeat(40) }).finally(() => { settled = true; });
    const busy = await request("/api/journal", { headers: { cookie: owner.cookie } });
    assert.equal(busy.status, 503); assert.equal(busy.headers.get("retry-after"), "5");
    assert.equal((await request("/healthz")).status, 200);
    const offlineFailure = captureBackup(directory, join(root, "offline"), "a".repeat(40));
    await assert.rejects(offlineFailure, /leased/);
    upload!.end(bytes.slice(-1)); assert.equal(await uploaded, 201);
    assert.equal(settled, false, "auth background work still holds capture");
    background.resolve();
    const result = await capture;
    assert.equal(result.manifest.users.length, 2); assert.equal(result.manifest.journals.length, 1);
    assert.equal(result.manifest.journals[0].count, 2);
    assert.equal(result.manifest.accounts.find(a => a.user_id === deleted.user.id)?.deleted, 1);
    const copiedAuth = new Database(join(backup, "auth.db"), { readonly: true });
    try { assert.equal((copiedAuth.prepare("SELECT value FROM verification WHERE identifier=?").get("synthetic-background") as { value: string }).value, "finished"); }
    finally { copiedAuth.close(); }
    assert.equal(createHash("sha256").update(readFileSync(witness)).digest("hex"), result.witnessSha256);
    const witnessData = JSON.parse(readFileSync(witness, "utf8"));
    assert.deepEqual(witnessData.accounts, result.manifest.accounts);
    assert.ok(Date.parse(witnessData.captured_at) >= Date.parse(result.manifest.captured_at));
    const receipt = restoreBackup({ backup, output: join(root, "restored"), witness, expectedWitnessSha256: result.witnessSha256 });
    assert.equal(receipt.entries, 2); assert.equal(receipt.journals, 1);
    assert.equal((await post("/api/journal/notes", { text: "SYNTHETIC after capture" }, owner.cookie)).status, 201);
    const live = await request("/api/journal", { headers: { cookie: owner.cookie } }); assert.equal(live.status, 200); assert.equal((await live.json()).count, 3);
    const copied = Journal.openReadOnly(join(backup, result.manifest.journals[0].name));
    try { assert.equal(copied.count(), 2); assert.equal(copied.verify().ok, true); } finally { copied.close(); }
    await assert.rejects(service.captureRecovery({ backup, witness: join(root, "other-witness.json"), sourceRevision: "a".repeat(40) }), /overwrite/);
    assert.equal((await request("/api/journal", { headers: { cookie: owner.cookie } })).status, 200);
    assert.equal((await request("/recovery")).status, 404, "recovery is not exposed by a public route");
    const operatorRoot = mkdtempSync(join(realpathSync("/tmp"), "kri-"));
    const control = await createRecoveryControl({ socketPath: join(operatorRoot, "operator.sock"), outputDirectory: join(root, "operator-output"), sourceRevision: "a".repeat(40), capture: paths => service.captureRecovery(paths) });
    try {
      const receipt = await requestRecoveryCapture({ socketPath: join(operatorRoot, "operator.sock") });
      assert.equal(receipt.accounts, 2); assert.equal(receipt.journals, 1);
      const socketManifest = JSON.parse(readFileSync(join(receipt.backup, "manifest.json"), "utf8"));
      assert.equal(socketManifest.journals[0].count, 3, "the local operator control reaches the running service capture");
      assert.equal((await request("/api/journal", { headers: { cookie: owner.cookie } })).status, 200);
    } finally { await control.close(); rmSync(operatorRoot, { recursive: true, force: true }); }
  } finally { upload?.destroy(); background.resolve(); await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("online copy requires an authentic held lease for the same source", async () => {
  const root = mkdtempSync(join(tmpdir(), "kairos-recovery-capability-")), directory = join(root, "data"), other = join(root, "other");
  const lease = acquireDataLease(directory), wrong = acquireDataLease(other);
  const options = { backup: join(root, "backup"), witness: join(root, "witness"), sourceRevision: "a".repeat(40) };
  try {
    await assert.rejects(captureRecoveryWhileLeased(directory, options, (() => {}) as DataLease), /held lease/);
    await assert.rejects(captureRecoveryWhileLeased(directory, options, wrong), /held lease/);
    lease(); await assert.rejects(captureRecoveryWhileLeased(directory, options, lease), /held lease/);
    assert.equal(existsSync(options.backup), false); assert.equal(existsSync(options.witness), false);
  } finally { lease(); wrong(); rmSync(root, { recursive: true, force: true }); }
});

test("health stays available during large journal verification and capture deadlines release workers", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kairos-capture-health-")), directory = join(root, "data");
  const baseURL = `http://127.0.0.1:${await freePort()}`, secret = randomBytes(32).toString("hex");
  const service = await createPreview({ baseURL, directory, secret });
  await service.listen();
  let closed = false;
  try {
    const owner = await service.auth.api.signUpEmail({ body: { email: "large-recovery@example.test", name: "Synthetic large recovery", password: "synthetic-large-recovery-password" } });
    service.accounts.get(owner.user.id);
    const journal = Journal.open(service.accounts.path(owner.user.id));
    try {
      for (let batch = 0; batch < 20; batch++) journal.writeMany(Array.from({ length: 500 }, (_, i) => ({ text: `SYNTHETIC ${batch * 500 + i} ` + "sample journal text ".repeat(40), actor: "you" })));
    } finally { journal.close(); }
    let completed = false, probes = 0;
    const capture = service.captureRecovery({ backup: join(root, "backup"), witness: join(root, "witness.json"), sourceRevision: "b".repeat(40) }).finally(() => { completed = true; });
    while (!completed) {
      const response = await fetch(baseURL + "/healthz", { headers: { connection: "close" } });
      assert.equal(response.status, 200); await response.arrayBuffer();
      const data = await fetch(baseURL + "/api/journal", { headers: { connection: "close" } });
      if (!completed) { assert.equal(data.status, 503); probes++; }
      await data.arrayBuffer();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await capture).manifest.journals[0].count, 10_000);
    assert.ok(probes >= 3, "health and maintenance responses were served repeatedly during verification");
    await service.close(); closed = true;
    const lease = acquireDataLease(directory);
    try {
      await assert.rejects(captureRecoveryWhileLeased(directory, { backup: join(root, "expired"), witness: join(root, "expired-witness.json"), sourceRevision: "b".repeat(40) }, lease, 1), /deadline/);
      assert.equal(existsSync(join(root, "expired")), false);
      assert.equal(existsSync(join(root, "expired-witness.json")), false);
      assert.throws(() => acquireDataLease(directory), /leased/, "terminating inspection never releases the owner's lease");
    } finally { lease(); }
    const restarted = await createPreview({ baseURL, directory, secret }); await restarted.close();
  } finally { if (!closed) await service.close(); rmSync(root, { recursive: true, force: true }); }
});
