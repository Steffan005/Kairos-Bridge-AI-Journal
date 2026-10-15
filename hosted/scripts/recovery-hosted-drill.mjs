#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Disposable synthetic recovery drill. Never accepts an existing data directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

class DrillError extends Error {}
const fail = message => { throw new DrillError(message); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const moduleURL = name => new URL(`../dist/hosted/src/${name}.js`, import.meta.url).href;
const within = (parent, child) => { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };
let stage = "arguments", root, ownedRoot = false, service, control, restoredProcess, statusCheck;
let stopping;

function saveReceipt(name, value) {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(root, "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
  return path;
}
async function stopChild() {
  const child = restoredProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveStopped => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => { clearTimeout(timer); resolveStopped(); });
    if (child.connected) child.send({ type: "stop" }, () => {});
    else child.kill("SIGTERM");
  });
}
function cleanup() {
  return stopping ??= (async () => {
    try { await stopChild(); }
    finally { try { await control?.close(); } finally { await service?.close(); } }
  })();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => {
  cleanup().finally(() => { process.stderr.write("Synthetic recovery drill interrupted.\n"); process.exit(1); });
});

async function freePort() {
  const listener = net.createServer();
  await new Promise((ready, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", ready); });
  const port = listener.address().port;
  await new Promise((closed, reject) => listener.close(error => error ? reject(error) : closed()));
  return port;
}

async function startRestoredProcess(options) {
  // Credentials stay in process memory and the private IPC channel. No inherited
  // deployment environment, credential command-line arguments, or child logs.
  const code = `
    import { createPreview } from ${JSON.stringify(moduleURL("service"))};
    let service, stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; try { await service?.close(); } finally { process.exit(0); } };
    process.on('disconnect', stop);
    process.on('message', async message => {
      if (message?.type === 'stop') return stop();
      if (message?.type !== 'start' || service || stopping) return;
      try { service = await createPreview(message.options); await service.listen(); process.send({type:'ready',pid:process.pid}); }
      catch { process.send?.({type:'failed'}); process.exit(1); }
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  restoredProcess = child;
  await new Promise((ready, reject) => {
    const timeout = setTimeout(() => reject(new DrillError("Restored process did not become ready")), 30_000);
    const failed = () => { clearTimeout(timeout); reject(new DrillError("Restored process did not become ready")); };
    child.once("error", failed); child.once("exit", failed);
    child.once("message", message => {
      clearTimeout(timeout); child.off("exit", failed);
      if (message?.type !== "ready" || message.pid === process.pid) return failed();
      ready();
    });
    child.send({ type: "start", options }, error => { if (error) failed(); });
  });
  return child.pid;
}

try {
  const [destination, sourceRevision, ...extra] = process.argv.slice(2);
  if (!destination || !sourceRevision || extra.length || !/^[a-f0-9]{40}$/.test(sourceRevision)) fail("Usage: node hosted/scripts/recovery-hosted-drill.mjs ABS_NEW_ROOT EXACT_40_CHARACTER_SOURCE_SHA");
  if (!isAbsolute(destination) || resolve(destination) !== destination || /[\x00-\x1f\x7f]/.test(destination)) fail("Drill root must be a normalized absolute new directory");
  const parent = realpathSync(dirname(destination));
  if (!lstatSync(parent).isDirectory()) fail("Drill parent must be a directory");
  root = join(parent, basename(destination));
  if (within(realpathSync(fileURLToPath(new URL("../..", import.meta.url))), root)) fail("Keep disposable drill data outside the repository");
  if (Buffer.byteLength(join(root, "operator.sock")) > 100) fail("Use a shorter drill root so its Unix socket path fits within 100 bytes");
  process.umask(0o077);
  try { mkdirSync(root, { mode: 0o700 }); ownedRoot = true; }
  catch { fail("Drill root must be entirely new; existing paths are never reused or replaced"); }
  chmodSync(root, 0o700);
  if (typeof process.getuid !== "function" || lstatSync(root).uid !== process.getuid() || (lstatSync(root).mode & 0o7777) !== 0o700) fail("Drill root must be privately owned with mode 0700");

  stage = "load_built_modules";
  const [{ createPreview }, { createRecoveryControl, requestRecoveryCapture }, { restoreBackup }] = await Promise.all([
    import(moduleURL("service")), import(moduleURL("recoveryControl")), import(moduleURL("recovery")),
  ]);
  const startedAt = new Date().toISOString(), started = performance.now();
  const directory = join(root, "source"), restoredDirectory = join(root, "restored");
  const baseURL = `http://127.0.0.1:${await freePort()}`;
  const secret = randomBytes(32).toString("hex"), password = randomBytes(32).toString("base64url");
  const suffix = randomUUID();
  const emailA = `recovery-a-${suffix}@example.test`, emailB = `recovery-b-${suffix}@example.test`;
  const textA = "SYNTHETIC RECOVERY DRILL: A kitchen tile is cobalt blue.";
  const textB = "SYNTHETIC RECOVERY DRILL: B kitchen tile is terracotta.";
  const checks = {};
  const request = (path, options = {}) => {
    if (!path.startsWith("/") || path.startsWith("//")) fail("Drill requests must stay on loopback");
    return fetch(baseURL + path, { redirect: "manual", signal: AbortSignal.timeout(30_000), ...options, headers: { connection: "close", ...options.headers } });
  };
  const post = (path, value, cookie) => request(path, { method: "POST", headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(value) });
  const cookies = response => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const signup = async email => {
    const response = await post("/api/auth/sign-up/email", { email, name: "Synthetic recovery drill", password });
    assert.equal(response.status, 200); return { cookie: cookies(response), user: (await response.json()).user };
  };
  const signin = async email => { const response = await post("/api/auth/sign-in/email", { email, password }); assert.equal(response.status, 200); return cookies(response); };
  const journal = async cookie => { const response = await request("/api/journal", { headers: { cookie } }); assert.equal(response.status, 200); return response.json(); };
  const callback = "https://synthetic-ai.example.test/callback";
  const grant = async (clientId, cookie) => {
    const grantStage = stage;
    const expect = (response, expected) => { statusCheck = { expected, actual: response.status }; assert.equal(response.status, expected); statusCheck = undefined; };
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code", scope: "journal:read journal:write offline_access", resource: baseURL + "/mcp", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "consent" });
    stage = grantStage + "_authorize";
    const authorization = await request("/api/auth/oauth2/authorize?" + query, { mode: "same-origin", headers: { cookie, accept: "text/html" } });
    expect(authorization, 302);
    const consent = new URL(authorization.headers.get("location"), baseURL);
    assert.equal(consent.origin, baseURL); assert.equal(consent.pathname, "/consent");
    stage = grantStage + "_consent";
    const approved = await post("/api/auth/oauth2/consent", { accept: true, oauth_query: consent.search.slice(1) }, cookie); expect(approved, 200);
    const redirect = new URL((await approved.json()).url);
    assert.equal(redirect.origin + redirect.pathname, callback);
    const code = redirect.searchParams.get("code"); assert.ok(code);
    stage = grantStage + "_token";
    const response = await request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: callback, code, code_verifier: verifier, resource: baseURL + "/mcp" }) });
    expect(response, 200);
    const result = await response.json(); assert.ok(result.access_token); assert.ok(result.refresh_token); stage = grantStage; return result;
  };
  const call = token => request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "journal_continue", arguments: { project: "kitchen" } } }) });
  const refresh = (token, clientId) => request("/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId, resource: baseURL + "/mcp" }) });
  const capture = () => requestRecoveryCapture({ socketPath: join(root, "operator.sock") });
  const decode = (token, part) => JSON.parse(Buffer.from(token.split(".")[part], "base64url").toString("utf8"));

  stage = "start_disposable_source";
  service = await createPreview({ baseURL, directory, secret }); await service.listen();
  control = await createRecoveryControl({ socketPath: join(root, "operator.sock"), outputDirectory: join(root, "captures"), sourceRevision, capture: paths => service.captureRecovery(paths) });
  stage = "create_synthetic_accounts";
  const a = await signup(emailA), b = await signup(emailB);
  stage = "write_synthetic_notes_and_metadata";
  const writtenA = await post("/api/journal/notes", { text: textA, tags: ["project-kitchen", "synthetic-drill"], continuity: { version: 1, role: "goal", actor_id: "gpt_codex" } }, a.cookie);
  assert.equal(writtenA.status, 201); const originalA = await writtenA.json();
  const writtenB = await post("/api/journal/notes", { text: textB, tags: ["project-kitchen", "synthetic-drill"] }, b.cookie);
  assert.equal(writtenB.status, 201); const originalB = await writtenB.json();
  stage = "register_synthetic_pkce_client";
  const register = await post("/api/auth/oauth2/register", { client_name: "Synthetic recovery drill", redirect_uris: [callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "journal:read journal:write offline_access" });
  assert.equal(register.status, 201); const clientId = (await register.json()).client_id;
  stage = "grant_synthetic_pkce_clients";
  const oldA = await grant(clientId, a.cookie), oldB = await grant(clientId, b.cookie);
  stage = "verify_initial_owner_isolation";
  for (const [cookie, wanted, absent] of [[a.cookie, originalA, textB], [b.cookie, originalB, textA]]) {
    const own = await journal(cookie); assert.equal(own.count, 1); assert.deepEqual(own.entries, [wanted]); assert.ok(!JSON.stringify(own).includes(absent));
  }
  stage = "verify_initial_mcp_access";
  assert.equal((await call(oldA.access_token)).status, 200); assert.equal((await call(oldB.access_token)).status, 200);
  checks.two_isolated_owners_before_capture = true;

  stage = "first_online_capture_through_private_socket";
  const first = await capture(); assert.equal(first.accounts, 2); assert.equal(first.journals, 2);
  checks.first_capture_via_private_socket = true;
  stage = "later_disconnect_deletion_and_witness";
  assert.equal((await post("/api/journal/disconnect", {}, a.cookie)).status, 200);
  assert.equal((await request("/api/journal", { method: "DELETE", headers: { origin: baseURL, cookie: b.cookie } })).status, 200);
  assert.equal((await call(oldA.access_token)).status, 401); assert.equal((await call(oldB.access_token)).status, 401);
  const later = await capture(); assert.equal(later.accounts, 2); assert.equal(later.journals, 1);
  const witness = JSON.parse(readFileSync(later.witness, "utf8"));
  assert.equal(witness.accounts.find(account => account.user_id === b.user.id).deleted, 1);
  assert.equal(digest(readFileSync(later.witness)), later.witness_sha256);
  checks.later_witness_includes_disconnect_and_deletion = true;
  await control.close(); control = undefined; await service.close(); service = undefined;

  stage = "controlled_restore_with_later_witness";
  const restoreStarted = performance.now();
  const restored = restoreBackup({ backup: first.backup, output: restoredDirectory, witness: later.witness, expectedWitnessSha256: later.witness_sha256 });
  const restoreMs = Math.round(performance.now() - restoreStarted);
  assert.equal(restored.accounts, 2); assert.equal(restored.entries, 1); assert.equal(restored.journals, 1); assert.equal(restored.discarded_deleted_journals, 1); assert.equal(restored.reauthorization_required, true);
  stage = "start_restored_service_in_new_process";
  const restoredPID = await startRestoredProcess({ baseURL, directory: restoredDirectory, secret });
  assert.notEqual(restoredPID, process.pid);
  checks.restored_in_distinct_process_same_origin_and_auth_secret = true;
  stage = "reject_all_historical_credentials";
  for (const cookie of [a.cookie, b.cookie]) assert.equal((await request("/api/journal", { headers: { cookie } })).status, 401);
  for (const token of [oldA, oldB]) {
    assert.equal((await call(token.access_token)).status, 401);
    const renewed = await refresh(token.refresh_token, clientId); assert.ok(renewed.status >= 400 && renewed.status < 500);
  }
  checks.old_sessions_access_and_refresh_rejected = true;
  stage = "verify_exact_restored_note_metadata_and_owner_isolation";
  const freshA = await signin(emailA), freshB = await signin(emailB);
  const aj = await journal(freshA), bj = await journal(freshB);
  assert.equal(aj.count, 1); assert.deepEqual(aj.entries, [originalA]); assert.ok(!JSON.stringify(aj).includes(textB));
  assert.equal(bj.deleted, true); assert.deepEqual(bj.entries, []); assert.ok(!JSON.stringify(bj).includes(textA));
  checks.note_and_all_metadata_match_exactly = true; checks.deleted_owner_remains_empty_and_isolated = true;
  stage = "fresh_consent_and_old_credential_recheck";
  const fresh = await grant(clientId, freshA), freshCall = await call(fresh.access_token);
  assert.equal(freshCall.status, 200); const freshBody = await freshCall.json();
  assert.ok(!freshBody.result?.isError); assert.ok(JSON.stringify(freshBody).includes(textA)); assert.ok(!JSON.stringify(freshBody).includes(textB));
  assert.notEqual(decode(fresh.access_token, 0).kid, decode(oldA.access_token, 0).kid);
  assert.notEqual(decode(fresh.access_token, 1).kairos_epoch, decode(oldA.access_token, 1).kairos_epoch);
  for (const token of [oldA, oldB]) {
    assert.equal((await call(token.access_token)).status, 401);
    const renewed = await refresh(token.refresh_token, clientId); assert.ok(renewed.status >= 400 && renewed.status < 500);
  }
  for (const cookie of [a.cookie, b.cookie]) assert.equal((await request("/api/journal", { headers: { cookie } })).status, 401);
  checks.fresh_pkce_consent_and_mcp_read_succeed = true;
  checks.signing_key_and_access_generation_changed = true;
  checks.historical_credentials_still_rejected_after_fresh_consent = true;
  await cleanup();

  stage = "save_sanitized_receipt";
  const describeCapture = receipt => ({ operation: receipt.operation, backup: receipt.backup, witness: receipt.witness,
    backup_id: receipt.backup_id, manifest_sha256: digest(readFileSync(join(receipt.backup, "manifest.json"))), witness_sha256: receipt.witness_sha256,
    captured_at: receipt.captured_at, source_revision: receipt.source_revision, accounts: receipt.accounts, journals: receipt.journals, files: receipt.files,
    drain_ms: receipt.drain_ms, capture_ms: receipt.capture_ms, paused_ms: receipt.paused_ms });
  const receipt = { format: "kairos-synthetic-hosted-recovery-drill-v1", ok: true, started_at: startedAt, finished_at: new Date().toISOString(),
    source_revision: sourceRevision, synthetic_only: true, distinct_restored_process: true, credentials_persisted_in_receipt: false,
    root, source_data: directory, restored_data: restoredDirectory, first_capture: describeCapture(first), later_capture: describeCapture(later),
    restore: { accounts: restored.accounts, journals: restored.journals, entries: restored.entries, discarded_deleted_journals: restored.discarded_deleted_journals, reauthorization_required: restored.reauthorization_required, restore_ms: restoreMs },
    total_ms: Math.round(performance.now() - started), checks };
  const receiptPath = saveReceipt("drill-receipt.json", receipt);
  process.stdout.write(JSON.stringify({ ok: true, receipt: receiptPath, source_revision: sourceRevision, accounts: 2, restored_entries: 1, checks: Object.keys(checks).length }) + "\n");
} catch (error) {
  await cleanup().catch(() => {});
  if (ownedRoot) {
    try { saveReceipt("drill-failure.json", { format: "kairos-synthetic-hosted-recovery-drill-failure-v1", ok: false, failed_at: new Date().toISOString(), stage, ...(statusCheck ? { status_check: statusCheck } : {}), synthetic_only: true }); } catch {}
  }
  // Never echo assertion details, provider bodies, tokens, cookies or raw errors.
  process.stderr.write(error instanceof DrillError && stage === "arguments" ? error.message + "\n" : `Synthetic recovery drill failed at ${stage}; private artifacts were retained.\n`);
  process.exitCode = 1;
}
