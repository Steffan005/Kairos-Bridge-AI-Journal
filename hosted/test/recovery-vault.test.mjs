// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts");
const age = process.env.AGE_BIN, keygen = process.env.AGE_KEYGEN_BIN;
const python = process.env.PYTHON_BIN ?? "/usr/bin/python3";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function run(command, args, env = {}) { return spawnSync(command, args, { encoding: "utf8", env: { ...process.env, AGE_BIN: age, ...env }, maxBuffer: 1024 * 1024 }); }
function okay(result) { assert.equal(result.status, 0, result.stderr); return result; }

test("age vault synthetic acceptance", async t => {
  assert.ok(age && keygen, "Set AGE_BIN and AGE_KEYGEN_BIN to installed absolute age executables; tests never install tools.");
  const root = mkdtempSync(join(tmpdir(), "kairos-vault-test-")); chmodSync(root, 0o700);
  const capture = join(root, "capture"), backup = join(capture, "backup"), vault = join(root, "vault");
  mkdirSync(capture, { mode: 0o700 }); mkdirSync(backup, { mode: 0o700 });
  const identity = join(root, "identity.txt"), wrongIdentity = join(root, "wrong-identity.txt");
  okay(run(keygen, ["-o", identity])); okay(run(keygen, ["-o", wrongIdentity]));
  chmodSync(identity, 0o600); chmodSync(wrongIdentity, 0o600);
  const recipient = okay(run(keygen, ["-y", identity])).stdout.trim();
  // More than one age payload chunk: corruption in the final chunk must remove
  // any already extracted plaintext. Fixture bytes are deliberately synthetic.
  const data = new Map([["auth.db", randomBytes(150000)], ["control.db", Buffer.from("synthetic control fixture")]]);
  for (const [name, bytes] of data) writeFileSync(join(backup, name), bytes, { mode: 0o600 });
  const manifest = { format: "kairos-offline-backup-v1", id: "synthetic-backup", source_revision: "a".repeat(40), captured_at: "2026-01-01T00:00:00Z", files: [...data].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) })) };
  writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  const witness = { format: "kairos-deletion-witness-v1", id: "capture-witness", captured_at: "2026-01-01T00:00:01Z", users: ["synthetic-user"], accounts: [{ user_id: "synthetic-user", epoch: 1, deleted: 0, journal_generation: 1 }] };
  writeFileSync(join(capture, "witness.json"), JSON.stringify(witness), { mode: 0o600 });
  const latest = join(root, "independently-retained-latest.json");
  writeFileSync(latest, JSON.stringify({ ...witness, id: "later-witness", captured_at: "2026-01-02T00:00:00Z", accounts: [{ ...witness.accounts[0], deleted: 1 }] }), { mode: 0o600 });
  const latestHash = sha(readFileSync(latest));
  const pack = (out = vault, env = {}) => run(process.execPath, [join(scripts, "recovery-pack.mjs"), capture, recipient, out], env);
  const archive = join(vault, "archive.tar.gz.age"), receiptPath = join(vault, "capture-receipt.json");
  const unpack = (output, overrides = {}) => run(python, [join(scripts, "recovery-unpack.py"), overrides.archive ?? archive, overrides.receipt ?? receiptPath, overrides.identity ?? identity, output, overrides.latest ?? latest, overrides.latestHash ?? latestHash]);
  function rejected(result, output) { assert.notEqual(result.status, 0); assert.equal(existsSync(output), false, "Failure must remove its new output"); assert.ok(!result.stdout.includes("AGE-SECRET-KEY")); }
  try {
    await t.test("pack and open round trip with private permissions and separate current witness", () => {
      okay(pack());
      assert.deepEqual(readdirSync(vault).sort(), ["archive.tar.gz.age", "capture-receipt.json"]);
      assert.equal(statSync(vault).mode & 0o777, 0o700);
      for (const name of readdirSync(vault)) assert.equal(statSync(join(vault, name)).mode & 0o777, 0o600);
      const receipt = JSON.parse(readFileSync(receiptPath));
      assert.equal(receipt.archive_sha256, sha(readFileSync(archive)));
      assert.equal(receipt.manifest_sha256, sha(readFileSync(join(backup, "manifest.json"))));
      assert.equal(receipt.capture_witness_sha256, sha(readFileSync(join(capture, "witness.json"))));
      assert.notEqual(receipt.capture_witness_sha256, latestHash);
      assert.equal(JSON.stringify(receipt).includes("synthetic-user"), false);
      const output = join(root, "opened"); okay(unpack(output));
      for (const [name, bytes] of data) { assert.deepEqual(readFileSync(join(output, "backup", name)), bytes); assert.equal(statSync(join(output, "backup", name)).mode & 0o777, 0o600); }
      assert.equal(statSync(output).mode & 0o777, 0o700);
      assert.equal(statSync(join(output, "backup")).mode & 0o777, 0o700);
      const opened = JSON.parse(readFileSync(join(output, "vault-open-receipt.json")));
      assert.equal(opened.selected_latest_witness_sha256, latestHash);
      assert.equal(opened.restore_required, true);
      const prior = readFileSync(archive);
      assert.notEqual(pack().status, 0); assert.deepEqual(readFileSync(archive), prior);
      assert.notEqual(unpack(output).status, 0); assert.deepEqual(readFileSync(join(output, "backup/auth.db")), data.get("auth.db"));
    });
    await t.test("missing or wrong private identity never retains plaintext", () => {
      for (const [name, key] of [["missing-key", join(root, "absent.key")], ["wrong-key", wrongIdentity]]) {
        const output = join(root, name); rejected(unpack(output, { identity: key }), output);
      }
    });
    await t.test("publicly readable identity is refused", () => {
      chmodSync(identity, 0o644);
      try { const output = join(root, "insecure-key"); rejected(unpack(output), output); } finally { chmodSync(identity, 0o600); }
    });
    await t.test("missing receipt, missing current witness, and wrong current witness hash are refused", () => {
      for (const [name, overrides] of [["missing-receipt", { receipt: join(root, "absent-receipt") }], ["missing-witness", { latest: join(root, "absent-witness") }], ["wrong-witness-hash", { latestHash: "0".repeat(64) }]]) {
        const output = join(root, name); rejected(unpack(output, overrides), output);
      }
    });
    await t.test("ciphertext corruption is caught by receipt and by age authentication", () => {
      const corrupt = join(root, "corrupt.age"), bytes = Buffer.from(readFileSync(archive)); bytes[bytes.length - 1] ^= 1; writeFileSync(corrupt, bytes, { mode: 0o600 });
      let output = join(root, "corrupt-hash"); rejected(unpack(output, { archive: corrupt }), output);
      const changedReceipt = join(root, "changed-receipt.json");
      const receipt = JSON.parse(readFileSync(receiptPath)); receipt.archive_sha256 = sha(bytes);
      writeFileSync(changedReceipt, JSON.stringify(receipt), { mode: 0o600 });
      output = join(root, "corrupt-authentication"); rejected(unpack(output, { archive: corrupt, receipt: changedReceipt }), output);
      const truncated = bytes.subarray(0, bytes.length - 32), truncatedPath = join(root, "truncated.age");
      writeFileSync(truncatedPath, truncated, { mode: 0o600 });
      writeFileSync(changedReceipt, JSON.stringify({ ...receipt, archive_sha256: sha(truncated), archive_bytes: truncated.length }), { mode: 0o600 });
      output = join(root, "truncated-authentication"); rejected(unpack(output, { archive: truncatedPath, receipt: changedReceipt }), output);
    });
    await t.test("missing age and failed tar do not retain a vault", () => {
      let output = join(root, "missing-age"); rejected(pack(output, { AGE_BIN: "" }), output);
      output = join(root, "failed-tar"); rejected(pack(output, { TAR_BIN: "/usr/bin/false" }), output);
    });
    await t.test("source extras, symlinks, and modified database bytes are refused", () => {
      const extra = join(capture, "unexpected.txt"); writeFileSync(extra, "synthetic");
      let output = join(root, "extra-source"); rejected(pack(output), output); rmSync(extra);
      const source = join(backup, "control.db"), original = readFileSync(source); rmSync(source); symlinkSync(join(backup, "auth.db"), source);
      output = join(root, "linked-source"); rejected(pack(output), output); rmSync(source); writeFileSync(source, original, { mode: 0o600 });
      writeFileSync(source, "changed synthetic fixture"); output = join(root, "changed-source"); rejected(pack(output), output); writeFileSync(source, original, { mode: 0o600 });
    });
    await t.test("unsafe, linked, duplicate, and unexpected archive members are refused", () => {
      const receipt = JSON.parse(readFileSync(receiptPath));
      for (const [index, kind] of ["traversal", "absolute", "symlink", "hardlink", "duplicate", "unexpected"].entries()) {
        const syntheticTar = join(root, `unsafe-${index}.tar.gz`), encrypted = join(root, `unsafe-${index}.age`), pin = join(root, `unsafe-${index}.json`);
        const fixture = `import io,tarfile,sys\nwith tarfile.open(sys.argv[1], 'w:gz', format=tarfile.USTAR_FORMAT) as t:\n kind=sys.argv[2]\n name={'traversal':'../escaped','absolute':'/tmp/escaped','unexpected':'other.txt'}.get(kind,'backup/auth.db')\n m=tarfile.TarInfo(name);m.size=1\n if kind in ('symlink','hardlink'):\n  m.type=tarfile.SYMTYPE if kind=='symlink' else tarfile.LNKTYPE;m.linkname='../escaped';m.size=0\n t.addfile(m,io.BytesIO(b'x'))\n if kind=='duplicate':t.addfile(m,io.BytesIO(b'x'))\n`;
        okay(run(python, ["-c", fixture, syntheticTar, kind]));
        okay(run(age, ["--encrypt", "--recipient", recipient, "--output", encrypted, syntheticTar]));
        writeFileSync(pin, JSON.stringify({ ...receipt, archive_sha256: sha(readFileSync(encrypted)), archive_bytes: statSync(encrypted).size }), { mode: 0o600 });
        const output = join(root, `unsafe-output-${index}`); rejected(unpack(output, { archive: encrypted, receipt: pin }), output);
      }
      assert.equal(existsSync(join(root, "escaped")), false);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
