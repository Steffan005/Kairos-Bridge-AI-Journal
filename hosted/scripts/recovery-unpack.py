#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Steffan Douglas Haskins
"""Mac/off-host opener. Never run with the recovery identity on the hosted service."""
import hashlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile

META_LIMIT = 16 * 1024 * 1024
HASH = re.compile(r"[a-f0-9]{64}\Z")
DB = re.compile(r"backup/(?:auth|control|journal-[a-f0-9]{64})\.db\Z")

class VaultError(Exception):
    pass

def fail(message):
    raise VaultError(message)

def ordinary(path, private=False):
    if not path.is_absolute():
        fail("Use absolute input paths.")
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        fail("Vault inputs must be ordinary files without links.")
    if private and st.st_mode & 0o077:
        fail("The private age identity must have 0600 or stricter permissions.")
    return st

def read_metadata(path):
    if ordinary(path).st_size > META_LIMIT:
        fail("Vault metadata exceeds the size limit.")
    with path.open("rb") as stream:
        return stream.read(META_LIMIT + 1)

def measure(path):
    ordinary(path)
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size

def load_json(data):
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError):
        fail("Invalid vault metadata.")
    if not isinstance(value, dict):
        fail("Invalid vault metadata.")
    return value

def private_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())

def normalize_new_directory(path):
    # Call only after this invocation's exclusive mkdir. Clear inherited setgid
    # on a descriptor without ever chmod'ing an existing operator directory.
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            fail("The new output directory must belong to this Unix user.")
        os.fchmod(descriptor, 0o700)
        if stat.S_IMODE(os.fstat(descriptor).st_mode) != 0o700:
            fail("Could not make the new output directory private.")
    finally:
        os.close(descriptor)

def main():
    if len(sys.argv) != 7:
        fail("Usage: AGE_BIN=/absolute/age python3 recovery-unpack.py ABS_ARCHIVE ABS_TRUSTED_CAPTURE_RECEIPT ABS_PRIVATE_IDENTITY ABS_NEW_OUTPUT_DIR ABS_LATEST_WITNESS TRUSTED_LATEST_WITNESS_SHA256")
    archive, receipt_path, identity, output, latest = map(Path, sys.argv[1:6])
    latest_hash = sys.argv[6]
    os.umask(0o077)
    age = Path(os.environ.get("AGE_BIN", ""))
    if not age.is_absolute() or not age.is_file() or not os.access(age, os.X_OK):
        fail("Set AGE_BIN to an absolute executable path; this helper never installs tools.")
    ordinary(identity, private=True)
    lines = [line.strip() for line in read_metadata(identity).decode("ascii").splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if len(lines) != 1 or not re.fullmatch(r"AGE-SECRET-KEY-1[0-9A-Z]+", lines[0]):
        fail("Use one native, unencrypted age identity stored only off-host.")
    del lines
    receipt = load_json(read_metadata(receipt_path))
    if receipt.get("format") != "kairos-encrypted-capture-v1" or receipt.get("encryption") != "age" or receipt.get("archive_format") != "tar+gzip":
        fail("Unsupported capture receipt.")
    for key in ("archive_sha256", "manifest_sha256", "capture_witness_sha256"):
        if not isinstance(receipt.get(key), str) or not HASH.fullmatch(receipt[key]):
            fail("Invalid capture receipt hashes.")
    for key in ("archive_bytes", "content_bytes", "file_count"):
        if type(receipt.get(key)) is not int or receipt[key] < 1:
            fail("Invalid capture receipt inventory.")
    if measure(archive) != (receipt["archive_sha256"], receipt["archive_bytes"]):
        fail("Encrypted archive does not match the independently retained receipt.")
    if not HASH.fullmatch(latest_hash):
        fail("Supply the independently selected latest witness SHA-256.")
    latest_bytes = read_metadata(latest)
    if hashlib.sha256(latest_bytes).hexdigest() != latest_hash:
        fail("Latest witness does not match the independently selected hash.")
    latest_value = load_json(latest_bytes)
    if latest_value.get("format") != "kairos-deletion-witness-v1":
        fail("Unsupported latest witness.")
    if not output.is_absolute() or output.name in ("", ".", ".."):
        fail("Use an absolute new output directory.")
    parent = output.parent.resolve(strict=True)
    output = parent / output.name
    # mkdir is the no-overwrite reservation. On failure only this newly created
    # directory is removed, including partial authenticated-stream plaintext.
    try:
        output.mkdir(mode=0o700)
    except FileExistsError:
        fail("Unpack output must be a new directory; overwrites are refused.")
    child = None
    succeeded = False
    def interrupted(_signum, _frame):
        raise VaultError("Vault opening interrupted; no output was retained.")
    for name in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(name, interrupted)
    try:
        normalize_new_directory(output)
        (output / "backup").mkdir(mode=0o700)
        normalize_new_directory(output / "backup")
        child = subprocess.Popen([str(age), "--decrypt", "--identity", str(identity), str(archive)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        seen = set()
        total = 0
        with tarfile.open(fileobj=child.stdout, mode="r|gz") as contents:
            for member in contents:
                name = member.name
                if (name not in ("backup/manifest.json", "witness.json") and not DB.fullmatch(name)) or name in seen:
                    fail("Archive contains an unexpected, duplicate, or unsafe path.")
                if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or member.issparse() or member.pax_headers:
                    fail("Archive links, special files, and extended metadata are refused.")
                if member.size < 0 or member.size + total > receipt["content_bytes"]:
                    fail("Archive exceeds its retained receipt inventory.")
                if name in ("backup/manifest.json", "witness.json") and member.size > META_LIMIT:
                    fail("Archive metadata exceeds the size limit.")
                if len(seen) >= receipt["file_count"]:
                    fail("Archive exceeds its retained receipt inventory.")
                stream = contents.extractfile(member)
                if stream is None:
                    fail("Archive member is unreadable.")
                target = output / name
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as dest:
                    shutil.copyfileobj(stream, dest, length=1024 * 1024)
                    dest.flush()
                    os.fsync(dest.fileno())
                seen.add(name)
                total += member.size
        # tar can reach its end markers before age authenticates the final
        # encrypted chunk. Drain and wait before retaining any plaintext.
        while child.stdout.read(1024 * 1024):
            pass
        child.stdout.close()
        if child.wait() != 0:
            fail("age authentication failed; no output was retained.")
        if len(seen) != receipt["file_count"] or total != receipt["content_bytes"]:
            fail("Archive inventory differs from the retained receipt.")
        manifest_path = output / "backup/manifest.json"
        witness_path = output / "witness.json"
        manifest_bytes = read_metadata(manifest_path)
        captured_witness = read_metadata(witness_path)
        if hashlib.sha256(manifest_bytes).hexdigest() != receipt["manifest_sha256"] or hashlib.sha256(captured_witness).hexdigest() != receipt["capture_witness_sha256"]:
            fail("Capture metadata does not match the retained receipt.")
        manifest = load_json(manifest_bytes)
        if manifest.get("format") != "kairos-offline-backup-v1" or not isinstance(manifest.get("files"), list):
            fail("Unsupported backup manifest.")
        expected = {"backup/manifest.json", "witness.json"}
        for file in manifest["files"]:
            if not isinstance(file, dict) or not isinstance(file.get("name"), str) or not DB.fullmatch("backup/" + file["name"]):
                fail("Invalid manifest inventory.")
            name = "backup/" + file["name"]
            if name in expected:
                fail("Duplicate manifest inventory.")
            expected.add(name)
            if measure(output / name) != (file.get("sha256"), file.get("bytes")):
                fail("Extracted database does not match its manifest.")
        if expected != seen or not {"backup/auth.db", "backup/control.db"}.issubset(seen):
            fail("Extracted inventory does not match its manifest.")
        # Re-check independently supplied material after decryption. This proves
        # selection/integrity, not global freshness or authority of the witness.
        if measure(latest)[0] != latest_hash:
            fail("Selected latest witness changed while opening the vault.")
        private_json(output / "vault-open-receipt.json", {
            "format": "kairos-opened-vault-v1", "opened_at": datetime.now(timezone.utc).isoformat(),
            "archive_sha256": receipt["archive_sha256"],
            "capture_manifest_sha256": receipt["manifest_sha256"],
            "capture_witness_sha256": receipt["capture_witness_sha256"],
            "selected_latest_witness_sha256": latest_hash,
            "restore_required": True,
            "limits": "Opening authenticates archive bytes and hashes only. Run controlled restore with the independently retained latest witness; the bundled witness is capture-time history."
        })
        for directory in (output / "backup", output, parent):
            descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        succeeded = True
        print(json.dumps({"status": "vault_opened_for_controlled_restore", "files": len(seen)}))
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait()
        if not succeeded:
            shutil.rmtree(output)

if __name__ == "__main__":
    try:
        main()
    except VaultError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Recovery vault opening failed; no new output was retained. Check private inputs and tool configuration.", file=sys.stderr)
        sys.exit(1)
