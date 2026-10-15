#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Encrypt a stopped, already captured bundle. This does not capture live SQLite.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, closeSync, createReadStream, createWriteStream, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const HASH = /^[a-f0-9]{64}$/;
const DB = /^(?:auth|control|journal-[a-f0-9]{64})\.db$/;
const META_LIMIT = 16 * 1024 * 1024;
class VaultError extends Error {}
const fail = message => { throw new VaultError(message); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function ordinary(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail("Vault inputs must be ordinary files without links.");
  return st;
}
function metadata(path) {
  if (ordinary(path).size > META_LIMIT) fail("Vault metadata exceeds the size limit.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
async function measure(path) {
  ordinary(path);
  const hash = createHash("sha256"); let bytes = 0;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = createReadStream(path, { fd, autoClose: true });
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}
function directory(path) {
  if (!isAbsolute(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail("Use existing absolute directories without symbolic links.");
  return realpathSync(path);
}
function sameMembers(path, expected) {
  if (JSON.stringify(readdirSync(path).sort()) !== JSON.stringify([...expected].sort())) fail("Unexpected or missing capture files.");
}
async function inspect(root) {
  sameMembers(root, ["backup", "witness.json"]);
  const backup = directory(join(root, "backup"));
  const manifestBytes = metadata(join(backup, "manifest.json"));
  const witnessBytes = metadata(join(root, "witness.json"));
  let manifest, witness;
  try { manifest = JSON.parse(manifestBytes); witness = JSON.parse(witnessBytes); } catch { fail("Capture metadata is not JSON."); }
  if (manifest.format !== "kairos-offline-backup-v1" || !Array.isArray(manifest.files)
      || typeof manifest.id !== "string" || !/^[a-f0-9]{40}$/.test(manifest.source_revision)
      || witness.format !== "kairos-deletion-witness-v1" || typeof witness.id !== "string"
      || !Array.isArray(witness.accounts) || !Array.isArray(witness.users)) fail("Unsupported capture metadata.");
  const names = manifest.files.map(file => file.name);
  if (!names.includes("auth.db") || !names.includes("control.db") || new Set(names).size !== names.length
      || names.some(name => typeof name !== "string" || !DB.test(name))) fail("Invalid backup inventory.");
  sameMembers(backup, ["manifest.json", ...names]);
  let contentBytes = manifestBytes.length + witnessBytes.length;
  for (const file of manifest.files) {
    if (!HASH.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail("Invalid file metadata.");
    const actual = await measure(join(backup, file.name));
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) fail("Backup file does not match its manifest.");
    contentBytes += actual.bytes;
  }
  if (!Number.isSafeInteger(contentBytes)) fail("Capture exceeds supported size.");
  return { manifest_sha256: digest(manifestBytes), capture_witness_sha256: digest(witnessBytes),
    content_bytes: contentBytes, file_count: names.length + 2, backup_id: manifest.id,
    source_revision: manifest.source_revision, capture_witness_id: witness.id,
    members: ["backup/manifest.json", ...names.sort().map(name => `backup/${name}`), "witness.json"] };
}
function executable(path, label) {
  if (!path || !isAbsolute(path)) fail(`Set ${label} to an absolute executable path; this helper never installs tools.`);
  const resolved = realpathSync(path), st = lstatSync(resolved);
  if (!st.isFile() || !(st.mode & 0o111)) fail(`${label} is not executable.`);
  return resolved;
}
function completed(child, label) {
  child.stderr.resume(); // Never echo tool diagnostics, which may contain input paths.
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new VaultError(`${label} could not start.`)));
    child.once("close", code => code === 0 ? resolve() : reject(new VaultError(`${label} failed; no vault was retained.`)));
  });
}
function sync(path) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }

let output, reserved = false, children = [];
function cleanup() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  if (reserved) rmSync(output, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { cleanup(); process.exit(1); });
try {
  const [source, recipient, destination, ...extra] = process.argv.slice(2);
  if (!source || !recipient || !destination || extra.length) fail("Usage: AGE_BIN=/absolute/age node recovery-pack.mjs ABS_CAPTURE_ROOT age1PUBLIC_RECIPIENT ABS_NEW_VAULT_DIR");
  process.umask(0o077);
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) fail("Use one native age public recipient; keep its private identity off-host.");
  const age = executable(process.env.AGE_BIN, "AGE_BIN"), tar = executable(process.env.TAR_BIN ?? "/usr/bin/tar", "TAR_BIN");
  const root = directory(source);
  if (!isAbsolute(destination)) fail("Use an absolute new output directory.");
  output = join(directory(dirname(destination)), basename(destination));
  const rel = relative(root, output);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) fail("Keep the vault outside the capture directory.");
  const before = await inspect(root);
  try { mkdirSync(output, { mode: 0o700 }); reserved = true; } catch { fail("Vault output must be a new directory; overwrites are refused."); }
  const archive = join(output, "archive.tar.gz.age");
  const fd = openSync(archive, "wx", 0o600), sink = createWriteStream(archive, { fd, autoClose: true });
  const encoder = spawn(age, ["--encrypt", "--recipient", recipient], { stdio: ["pipe", "pipe", "pipe"] });
  const packer = spawn(tar, ["--format=ustar", "-czf", "-", "-C", root, "--", ...before.members],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1", TAR_OPTIONS: "" } });
  children = [encoder, packer];
  try { await Promise.all([completed(encoder, "age encryption"), completed(packer, "Archive creation"), pipeline(packer.stdout, encoder.stdin), pipeline(encoder.stdout, sink)]); }
  catch { cleanup(); throw new VaultError("Archive encryption failed; no vault was retained."); }
  const after = await inspect(root);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail("Capture changed during encryption; no vault was retained.");
  const encrypted = await measure(archive);
  const { members, ...pins } = before;
  const receipt = { format: "kairos-encrypted-capture-v1", sealed_at: new Date().toISOString(), encryption: "age",
    archive_format: "tar+gzip", archive_sha256: encrypted.sha256, archive_bytes: encrypted.bytes,
    recipient_sha256: digest(recipient), ...pins,
    witness_scope: "capture-time only; restore requires a separately trusted latest deletion witness" };
  writeFileSync(join(output, "capture-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  sync(archive); sync(join(output, "capture-receipt.json")); sync(output); sync(dirname(output));
  reserved = false;
  console.log(JSON.stringify({ status: "encrypted_capture_ready", files: receipt.file_count }));
} catch (error) {
  cleanup();
  console.error(error instanceof VaultError ? error.message : "Recovery vault packaging failed; inspect private inputs and tool configuration.");
  process.exitCode = 1;
}
