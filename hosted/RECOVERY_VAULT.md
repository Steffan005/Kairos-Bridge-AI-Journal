# Encrypted off-host recovery vault

These operator helpers wrap an existing, consistent recovery capture in an `age` encrypted tar/gzip stream. The host needs only the public recipient. Keep the private age identity on the operator Mac and in a separately protected recovery location. No helper installs software, sends network requests, or prints database contents or identity material.

This is a packaging and opening workflow. It does not schedule backups, upload them, prove deletion-witness freshness, replace controlled restore validation, or recover data written after capture. The capture receipt is an integrity pin when retained independently; it is not a signature or an external source of deletion authority. Anyone with the public recipient can encrypt a different archive.

## Requirements and private layout

Install the official [`age` CLI](https://github.com/FiloSottile/age#installation) through the operator's approved installation process. The implementation follows its documented [recipient encryption and identity decryption interface](https://filippo.io/age/age.1). Set `AGE_BIN` to its absolute executable path. Packaging uses Node 20+ and `/usr/bin/tar` (`TAR_BIN` can select another absolute executable). Opening uses Python 3 and the age executable on the Mac. The tests use `AGE_KEYGEN_BIN` and optionally `PYTHON_BIN`.

The input must be a completed capture with exactly this layout:

```text
capture-root/                     0700
  backup/                         0700
    manifest.json                 0600
    auth.db                       0600
    control.db                    0600
    journal-<sha256>.db            0600, when present
  witness.json                    0600, capture-time deletion state
```

The control utility's coordinated capture produces this layout. When using the offline recovery utility, stop and drain the matching service before creating both parts; keep it stopped until both are complete. The packer rejects extra files, missing files, symbolic or hard links, unexpected database names, and database hashes or sizes that differ from the manifest. It checks the source again after encryption. Capture inputs must stay immutable throughout packing; a process with permission to change files during the operation is outside this filesystem trust boundary.

Create the private identity on the Mac, in an existing private directory. The explicit `age-keygen -o` command below requires a new filename. Its diagnostic public recipient is safe to carry to the host; its `AGE-SECRET-KEY-1...` identity stays off-host.

```sh
umask 077
/absolute/age-keygen -o /absolute/private-vault/recovery-identity.txt
/absolute/age-keygen -y /absolute/private-vault/recovery-identity.txt
```

The helpers deliberately support one native `age1...` recipient and one native unencrypted identity file, with private permissions. The identity's enclosing storage needs its own protection and a tested separate recovery copy. An encrypted volume or a protected offline device can supply that boundary. The host's service authentication secret needs its existing separate recovery procedure; the age identity does not replace it.

## Package on the host and retain off-host

```sh
AGE_BIN=/absolute/age node hosted/scripts/recovery-pack.mjs \
  /absolute/completed-capture \
  age1PUBLIC_RECIPIENT \
  /absolute/new-encrypted-vault
```

The output must be a new absolute directory outside the capture root. The helper reserves it with mode 0700 and refuses to replace any existing path. It streams tar/gzip directly into age without writing a plaintext archive. It writes these mode 0600 files:

- `archive.tar.gz.age`: encrypted backup and capture-time `witness.json`.
- `capture-receipt.json`: ciphertext SHA-256/size, manifest SHA-256, capture witness SHA-256, content size and file count, source revision, capture identifiers, and a hash of the public recipient. No user identities, journal contents, tokens, or private key material are included in this receipt.

Failures and handled termination signals remove the newly reserved output. A power loss or `SIGKILL` can leave a private partial directory; a directory without a valid final receipt is not a completed vault. Do not reuse such a directory as an output. Completed input captures remain plaintext and must follow the operator's explicit retention/deletion policy.

Transfer the encrypted file and receipt to the chosen protected off-host store, preserving private permissions. Retain the receipt independently of the hosted capture/rollback domain, then compare the transferred ciphertext's SHA-256 and size to that receipt. A copy on the same Render disk does not satisfy this step. Actual transfer, independently retained pins, destination access control and retention are operator responsibilities; packaging success does not assert that transfer happened.

Retain deletion witnesses separately as deletion state advances. A witness bundled in a backup proves only what was captured then. Restoring requires the latest operator-trusted deletion state from a source that has not rolled back with the backup, plus its independently selected SHA-256. A filename, later timestamp or matching hash does not establish that it is latest. If current deletion history is unavailable, stop the restore.

## Open only on the operator Mac

Select the independently retained capture receipt, the encrypted archive, and the latest independently trusted witness. Supply all paths and the trusted latest witness hash explicitly:

```sh
AGE_BIN=/absolute/age python3 hosted/scripts/recovery-unpack.py \
  /absolute/private-vault/archive.tar.gz.age \
  /absolute/independent-receipts/capture-receipt.json \
  /absolute/private-vault/recovery-identity.txt \
  /absolute/new-opened-capture \
  /absolute/independent-witnesses/latest-witness.json \
  TRUSTED_LATEST_WITNESS_SHA256
```

The opener checks the ciphertext against the retained receipt before decrypting. It writes only into a newly created 0700 directory, streams each ordinary file with mode 0600, and rejects unlisted paths, duplicates, path traversal, symbolic links, hard links, special files, sparse files and extended metadata. It checks the complete age process result after consuming the stream, so a failure in the last encrypted chunk removes earlier plaintext too. It then checks exact archive membership, all manifest hashes and sizes, and the independently selected latest witness hash. No `tar extract` or `extractall` is used.

The result contains `backup/`, the historical `witness.json`, and a `vault-open-receipt.json`. Opening proves encrypted byte integrity and file hashes. It does not perform SQLite integrity, journal-chain, schema, ownership or deletion-generation validation; the controlled restore utility performs those checks next. The latest witness remains at the independently supplied external path. The opener records its hash and does not infer freshness or silently substitute the archive's witness.

```sh
# From hosted/, after building the matching source revision:
npm run recovery -- restore \
  /absolute/new-opened-capture/backup \
  /absolute/new-restored-data \
  /absolute/independent-witnesses/latest-witness.json \
  TRUSTED_LATEST_WITNESS_SHA256
```

Review the controlled restore receipt before selecting restored data for startup. It must confirm account/token invalidation and deletion handling. Never start a service directly from the opened backup. A later deletion, recreation or new account may make an older capture unsuitable; the matching restore implementation decides from the complete inventories and generations.

## Synthetic acceptance

```sh
AGE_BIN=/absolute/age AGE_KEYGEN_BIN=/absolute/age-keygen \
  PYTHON_BIN=/absolute/python3 \
  node --test hosted/test/recovery-vault.test.mjs
```

The test creates disposable identities and synthetic database bytes. It exercises encryption/opening, private modes, exact hash pins, separate capture/current witnesses, wrong/missing identity, insecure identity permissions, missing receipt/witness, wrong witness hash, ciphertext tampering both before and after recomputing the receipt hash, missing tools, tar failure, overwrite refusal, source mutation, links, traversal and duplicate/unexpected archive members. It deliberately uses enough random data to span age payload chunks. These tests do not claim that arbitrary fixture bytes are valid databases; run the controlled recovery suite for database and access-revocation acceptance.
