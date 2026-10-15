// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { createRecoveryControl, requestRecoveryCapture, type RecoveryControlOptions } from "../src/recoveryControl.js";
import type { BackupManifest } from "../src/recovery.js";

const revision = "a".repeat(40), nonce = "b".repeat(64);
const request = (extra = {}) => JSON.stringify({ version: 1, command: "capture", nonce, ...extra }) + "\n";
function fixture() {
  // Keep Unix socket paths under macOS's 104-byte sockaddr_un limit.
  const root = mkdtempSync(join(realpathSync("/tmp"), "krc-"));
  chmodSync(root, 0o700);
  return { root, socketPath: join(root, "operator.sock"), outputDirectory: join(root, "captures"), sourceRevision: revision };
}
function manifest(): BackupManifest {
  return { format: "kairos-offline-backup-v1", id: randomUUID(), captured_at: new Date().toISOString(), source_revision: revision,
    auth_schema: "test", journal_schema: 3, users: ["PRIVATE-ACCOUNT-ID"], accounts: [], journals: [{ name: "private-journal.db", count: 7, head: "PRIVATE-HEAD" }], files: [{ name: "auth.db", bytes: 100, sha256: "c".repeat(64) }] };
}
const capture: RecoveryControlOptions["capture"] = async ({ backup, witness, sourceRevision }) => {
  assert.equal(sourceRevision, revision);
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(witness), false);
  mkdirSync(backup, { mode: 0o700 });
  const m = manifest();
  writeFileSync(join(backup, "manifest.json"), JSON.stringify(m), { flag: "wx", mode: 0o600 });
  writeFileSync(witness, "PRIVATE-WITNESS-CONTENT", { flag: "wx", mode: 0o600 });
  return { manifest: m, witnessSha256: "d".repeat(64) };
};
async function raw(path: string, body: string | Buffer): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path });
    let output = "";
    socket.once("connect", () => {
      assert.equal(socket.remoteAddress, undefined, "operator connection has no TCP peer");
      assert.equal(socket.localAddress, undefined, "operator connection has no TCP listener");
      socket.end(body);
    });
    socket.on("data", chunk => { output += chunk.toString(); });
    socket.once("error", reject);
    socket.once("end", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
}

test("operator socket uses private filesystem permissions, fixed unique outputs, and whitelisted receipts", async () => {
  const f = fixture();
  const control = await createRecoveryControl({ ...f, capture });
  try {
    assert.equal(lstatSync(f.root).mode & 0o7777, 0o700);
    assert.equal(lstatSync(f.outputDirectory).mode & 0o7777, 0o700);
    assert.equal(lstatSync(f.socketPath).mode & 0o7777, 0o600);
    assert.equal(lstatSync(f.socketPath).isSocket(), true);
    assert.equal(lstatSync(f.socketPath).uid, process.getuid!());
    const first = await requestRecoveryCapture({ socketPath: f.socketPath, nonce });
    const second = await raw(f.socketPath, request());
    assert.equal(first.accounts, 1); assert.equal(first.journals, 1); assert.equal(first.files, 1);
    assert.equal(first.source_revision, revision); assert.equal(first.witness_sha256, "d".repeat(64));
    assert.equal(first.backup, join(first.operation, "backup")); assert.equal(first.witness, join(first.operation, "witness.json"));
    assert.equal(first.operation.startsWith(f.outputDirectory + "/"), true);
    assert.notEqual(first.operation, second.operation);
    assert.equal(lstatSync(first.operation).mode & 0o7777, 0o700);
    assert.equal(readFileSync(first.witness, "utf8"), "PRIVATE-WITNESS-CONTENT");
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE-|private-journal|auth_schema/);
    assert.equal(readdirSync(f.outputDirectory).length, 2);
  } finally { await control.close(); assert.equal(existsSync(f.socketPath), false); rmSync(f.root, { recursive: true, force: true }); }
});

test("operator control rejects malformed frames, paths, shell input, excess keys and oversized requests before capture", async () => {
  const f = fixture(); let calls = 0;
  const control = await createRecoveryControl({ ...f, capture: async paths => { calls++; return capture(paths); } });
  try {
    for (const value of ["", "{}\n", "not-json\n", "[]\n", request({ version: 2 }), request({ command: "restore" }), request({ nonce: "short" }), request({ nonce: "F".repeat(64) }), request({ backup: "/etc/passwd" }), request({ command: "capture; rm -rf /" }), request() + request(), request().trimEnd(), request() + "extra"]) {
      const response = await raw(f.socketPath, value);
      assert.equal(response.ok, false, value); assert.equal(response.error, "INVALID_REQUEST", value);
    }
    assert.equal((await raw(f.socketPath, Buffer.alloc(4097, 120))).error, "REQUEST_TOO_LARGE");
    assert.equal(calls, 0); assert.deepEqual(readdirSync(f.outputDirectory), []);
    assert.equal((await requestRecoveryCapture({ socketPath: f.socketPath })).ok, true);
  } finally { await control.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("operator framing waits for EOF so an appended second command cannot trigger capture", async () => {
  const f = fixture(); let calls = 0;
  const control = await createRecoveryControl({ ...f, capture: async paths => { calls++; return capture(paths); } });
  try {
    const socket = net.createConnection({ path: f.socketPath });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(request());
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 0);
    const ended = new Promise<string>(resolve => { let output = ""; socket.on("data", chunk => { output += chunk; }); socket.once("end", () => resolve(output)); });
    socket.end(request());
    assert.equal(JSON.parse(await ended).error, "INVALID_REQUEST"); assert.equal(calls, 0);
  } finally { await control.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("only one capture can run at a time, and shutdown awaits the active capture", async () => {
  const f = fixture(); let release!: () => void, entered!: () => void, calls = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const control = await createRecoveryControl({ ...f, capture: async paths => { calls++; entered(); await blocked; return capture(paths); } });
  try {
    const first = requestRecoveryCapture({ socketPath: f.socketPath });
    await started;
    await assert.rejects(requestRecoveryCapture({ socketPath: f.socketPath }), /BUSY/);
    assert.equal(calls, 1); assert.equal(readdirSync(f.outputDirectory).length, 1);
    let closed = false;
    const closing = control.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release();
    assert.equal((await first).ok, true); await closing; assert.equal(closed, true);
    await control.close();
  } finally { release(); await control.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("capture failures return a generic code and permit a subsequent independent capture", async () => {
  const f = fixture(); let calls = 0;
  const control = await createRecoveryControl({ ...f, capture: async paths => { if (calls++ === 0) throw new Error("PRIVATE-TOKEN /secret/database PRIVATE-NOTE"); return capture(paths); } });
  try {
    const failed = await raw(f.socketPath, request());
    assert.deepEqual(failed, { version: 1, ok: false, nonce, error: "CAPTURE_FAILED" });
    const result = await requestRecoveryCapture({ socketPath: f.socketPath });
    assert.equal(result.ok, true); assert.equal(readdirSync(f.outputDirectory).length, 1);
  } finally { await control.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("failed partial and published captures are removed only after their callback settles", async () => {
  const f = fixture();
  let operation: string | undefined, release!: () => void, entered!: () => void, complete = false;
  let pending = new Promise<void>(resolve => { release = resolve; });
  let started = new Promise<void>(resolve => { entered = resolve; });
  const control = await createRecoveryControl({ ...f, capture: async paths => {
    operation = dirname(paths.backup);
    if (complete) await capture(paths);
    else { mkdirSync(paths.backup, { mode: 0o700 }); writeFileSync(join(paths.backup, "partial.db"), "PRIVATE PARTIAL", { mode: 0o600 }); }
    entered(); await pending;
    throw new Error("Synthetic failure after creating plaintext backup");
  } });
  const unrelated = join(f.outputDirectory, "unrelated-existing-capture");
  mkdirSync(unrelated, { mode: 0o700 }); writeFileSync(join(unrelated, "keep"), "UNRELATED", { mode: 0o600 });
  try {
    for (complete of [false, true]) {
      const requested = raw(f.socketPath, request());
      await started;
      assert.ok(operation && existsSync(operation), "cleanup must wait for the capture callback to settle");
      if (complete) assert.ok(existsSync(join(operation, "backup", "manifest.json")));
      release();
      assert.equal((await requested).error, "CAPTURE_FAILED");
      assert.equal(existsSync(operation), false);
      assert.deepEqual(readdirSync(f.outputDirectory), ["unrelated-existing-capture"]);
      assert.equal(readFileSync(join(unrelated, "keep"), "utf8"), "UNRELATED");
      pending = new Promise<void>(resolve => { release = resolve; });
      started = new Promise<void>(resolve => { entered = resolve; });
    }
  } finally { release(); await control.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("operator receipts retain only valid optional capture timings", async () => {
  const f = fixture(); let calls = 0;
  const control = await createRecoveryControl({ ...f, capture: async paths => ({ ...(await capture(paths)), drainMs: 1.5, captureMs: 17, pausedMs: calls++ === 0 ? 18.5 : -1 }) });
  try {
    const receipt = await requestRecoveryCapture({ socketPath: f.socketPath });
    assert.equal(receipt.drain_ms, 1.5); assert.equal(receipt.capture_ms, 17); assert.equal(receipt.paused_ms, 18.5);
    await assert.rejects(requestRecoveryCapture({ socketPath: f.socketPath }), /CAPTURE_FAILED/);
  } finally { await control.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("failure cleanup refuses to remove a replacement at the operation path", async () => {
  const f = fixture(); let replaced: string | undefined;
  const control = await createRecoveryControl({ ...f, capture: async paths => {
    await capture(paths);
    replaced = dirname(paths.backup);
    renameSync(replaced, replaced + "-moved");
    mkdirSync(replaced, { mode: 0o700 }); writeFileSync(join(replaced, "keep"), "REPLACEMENT", { mode: 0o600 });
    throw new Error("Synthetic replacement before failure");
  } });
  try {
    await assert.rejects(requestRecoveryCapture({ socketPath: f.socketPath }), /CAPTURE_FAILED/);
    assert.ok(replaced);
    assert.equal(readFileSync(join(replaced, "keep"), "utf8"), "REPLACEMENT");
    assert.ok(existsSync(join(replaced + "-moved", "backup", "manifest.json")));
  } finally { await control.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("existing sockets and files are never removed or replaced", async () => {
  const f = fixture();
  const control = await createRecoveryControl({ ...f, capture });
  try {
    const before = lstatSync(f.socketPath).ino;
    await assert.rejects(createRecoveryControl({ ...f, capture }), /existing socket/);
    assert.equal(lstatSync(f.socketPath).ino, before);
    assert.equal((await requestRecoveryCapture({ socketPath: f.socketPath })).ok, true);
  } finally { await control.close(); }
  try {
    writeFileSync(f.socketPath, "do-not-remove", { mode: 0o600 });
    await assert.rejects(createRecoveryControl({ ...f, capture }), /existing socket/);
    assert.equal(readFileSync(f.socketPath, "utf8"), "do-not-remove");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("insecure or symbolic-link directories and sockets fail closed", async () => {
  const f = fixture();
  try {
    chmodSync(f.root, 0o755);
    await assert.rejects(createRecoveryControl({ ...f, capture }), /0700/);
    chmodSync(f.root, 0o700);
    mkdirSync(f.outputDirectory, { mode: 0o755 }); chmodSync(f.outputDirectory, 0o755);
    await assert.rejects(createRecoveryControl({ ...f, capture }), /0700/);
    rmSync(f.outputDirectory, { recursive: true });
    const target = join(f.root, "target"); mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, f.outputDirectory);
    await assert.rejects(createRecoveryControl({ ...f, capture }), /0700/);
    rmSync(f.outputDirectory);
    const socketDir = join(f.root, "linked"); symlinkSync(target, socketDir);
    await assert.rejects(createRecoveryControl({ ...f, socketPath: join(socketDir, "operator.sock"), capture }), /0700/);
    symlinkSync(join(target, "missing"), f.socketPath);
    await assert.rejects(createRecoveryControl({ ...f, capture }), /existing socket/);
    await assert.rejects(requestRecoveryCapture({ socketPath: f.socketPath }));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("client refuses insecure socket permissions and invalid paths or nonces", async () => {
  const f = fixture(); const control = await createRecoveryControl({ ...f, capture });
  try {
    chmodSync(f.socketPath, 0o666);
    await assert.rejects(requestRecoveryCapture({ socketPath: f.socketPath }), /0600/);
    chmodSync(f.socketPath, 0o600);
    await assert.rejects(requestRecoveryCapture({ socketPath: f.socketPath, nonce: "bad" }), /nonce/);
    await assert.rejects(requestRecoveryCapture({ socketPath: "localhost:8056" }), /absolute/);
    await assert.rejects(createRecoveryControl({ ...f, sourceRevision: "main", capture }), /source revision/);
    assert.equal((await requestRecoveryCapture({ socketPath: f.socketPath })).ok, true);
  } finally { await control.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("new recovery directories clear inherited SGID without changing existing SGID directories", async t => {
  const f = fixture(), parent = join(f.root, "sgid-parent");
  let control: Awaited<ReturnType<typeof createRecoveryControl>> | undefined;
  try {
    mkdirSync(parent, { mode: 0o700 });
    // macOS /tmp can assign a group this user does not belong to, in which case
    // chmod correctly strips SGID. Use this process's own group for the fixture.
    chownSync(parent, process.getuid!(), process.getgid!()); chmodSync(parent, 0o2770);
    assert.equal(lstatSync(parent).mode & 0o7777, 0o2770);
    const probe = join(parent, "inheritance-probe"); mkdirSync(probe, { mode: 0o700 });
    const inherited = (lstatSync(probe).mode & 0o2000) !== 0;
    t.diagnostic(inherited ? "Filesystem inherited SGID on mkdir; normalization path exercised." : "Filesystem did not inherit SGID; Linux CI exercises actual inheritance.");
    if (process.platform === "linux") assert.equal(inherited, true, "Linux SGID parent must reproduce the deployment condition");
    rmSync(probe, { recursive: true });
    const socketParent = join(parent, "operator"), outputDirectory = join(parent, "captures");
    const socketPath = join(socketParent, "control.sock");
    control = await createRecoveryControl({ socketPath, outputDirectory, sourceRevision: revision, capture });
    assert.equal(lstatSync(socketParent).mode & 0o7777, 0o700);
    assert.equal(lstatSync(outputDirectory).mode & 0o7777, 0o700);
    assert.equal(lstatSync(parent).mode & 0o7777, 0o2770);
    assert.equal((await requestRecoveryCapture({ socketPath })).ok, true);
    await control.close(); control = undefined;
    chmodSync(socketParent, 0o2700);
    await assert.rejects(createRecoveryControl({ socketPath, outputDirectory, sourceRevision: revision, capture }), /0700/);
    assert.equal(lstatSync(socketParent).mode & 0o7777, 0o2700);
    chmodSync(socketParent, 0o700); chmodSync(outputDirectory, 0o2700);
    await assert.rejects(createRecoveryControl({ socketPath, outputDirectory, sourceRevision: revision, capture }), /0700/);
    assert.equal(lstatSync(outputDirectory).mode & 0o7777, 0o2700);
  } finally { await control?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("client CLI runs as a separate operator process and emits only a receipt", async () => {
  const f = fixture(); const control = await createRecoveryControl({ ...f, capture });
  try {
    const child = spawn(process.execPath, [new URL("../src/recovery-client.js", import.meta.url).pathname, f.socketPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, stderr); assert.equal(stderr, ""); assert.equal(JSON.parse(stdout).ok, true);
    assert.doesNotMatch(stdout, /PRIVATE-/);
  } finally { await control.close(); rmSync(f.root, { recursive: true, force: true }); }
});
