# Controlled recovery — operator capture and isolated restore

The offline utility has passed local synthetic checks. The coordinated capture and encrypted vault workflow below extend it for an operator-led hosted rehearsal. Actual hosted results belong in a dated acceptance receipt; implementation alone does not prove recovery. This is not an automatic backup service, customer password-reset feature, or proof against an unannounced platform rollback. Use the matching application and recovery revision.

## What it does

- The service and maintenance tools hold the same SQLite OS lock. An active process excludes another service or backup; a crashed process releases the lock. Never delete a live lock file. Older service revisions do not obey this lease and must be independently stopped before maintenance.
- Backup holds that lease while using SQLite's backup API for authentication, control and each journal. Copies are converted to self-contained rollback-journal mode, checked, hashed and atomically published as a new directory. The service source databases are not converted.
- Restore accepts a complete bundle and an **operator-trusted deletion witness outside that bundle**, with its independently selected SHA-256. The witness's timestamp and hash do not independently prove it is latest. The operator must obtain current deletion history from a trustworthy source that has not rolled back with the backup.
- A restore is built in a new private directory. It deletes restored browser sessions, AI consents/tokens, pending verifications and signing keys. The next process provisions fresh keys, and owners must sign in and approve AI access again.
- Journals deleted after the backup are discarded. If a journal was deleted and recreated, the earlier contents are refused. Changed account inventories, missing/older witnesses, partial or corrupt bundles, unsupported schemas and broken journal chains are rejected before an output directory is published.

The separate journal generation tracks deletion/recreation; the access generation continues to track Disconnect. Migrating an existing service preserves its current access generation and notes. This does not reconstruct pre-migration deletion history or account ownership.

## Repeat the local acceptance

From `hosted/`, run `npm test`. The recovery fixture creates two disposable accounts, obtains real local OAuth/PKCE credentials, saves notes, captures a backup, disconnects one account and deletes the other's journal. It restores with a later witness, signs in again, checks retained notes and isolation, and proves old access/refresh credentials remain refused even after new consent. A deliberately old-key token with the **same access generation as the restored system** is also refused. Separate injections cover missing, mixed and altered files, a recomputed file hash hiding a broken journal chain, stale witnesses, recreation, overwrite refusal, lock exclusion, and a killed competing process.

These local checks make no Claude-device or hosted-recovery claim. Existing desktop and hosted acceptance suites must pass too.

## Operator commands

Build with `npm run build` in `hosted/`. Stop and drain the sole matching service writer before backup or witness capture. Use absolute paths and new outputs outside its data directory. For example:

```sh
npm run recovery -- backup /private/stopped-data /private/new-bundle EXACT_SOURCE_SHA
npm run recovery -- witness /private/current-stopped-data /private/current-witness.json
npm run recovery -- restore /private/new-bundle /private/new-restored-data /private/current-witness.json TRUSTED_WITNESS_SHA256
```

The witness is captured from current stopped data, **after** the relevant disconnections/deletions. A witness bundled with the old backup cannot certify later deletions. Keep a trustworthy witness outside any rollback domain; choosing, updating and retaining that store remains an operator task, not an implemented product service.

Review the restore receipt before selecting the new directory for startup. Use the configured authentication secret from its separate private store; no secret is included in the command. Restore deliberately removes old keys rather than treating a restored counter increment as sufficient revocation. Source revisions are operator-supplied provenance, not inferred from a timestamp.

## Remaining launch gates

**Bundles contain sensitive authentication records and all included journals.** Permissions are 0700/0600, but the bundle is not encrypted by this utility. It must never be committed, offered as a customer export, or uploaded to a public URL. Choose and verify encrypted off-host storage, access control, deletion-history durability and retention before customer data. A same-disk copy cannot recover loss of that disk. The original authentication secret needs its own protected recovery procedure.

Data written after capture is outside that backup. A changed account inventory is refused; this utility does not recover a missing later account or reset an owner's password. It retains sign-in account metadata for deleted journals. It does not supply production account deletion or erasure of retained snapshots.

Next gates: independently exercised hosted synthetic recovery, an encrypted off-host destination, durable deletion/freshness authority, defined loss/retention bounds, and customer identity recovery. No additional hosting resources are provisioned by this utility.


## Coordinated capture while the service remains running

Enable only for an operator with authenticated shell access to the existing host:

- `KAIROS_RECOVERY_SOCKET=/tmp/kairos-recovery/control.sock`
- `KAIROS_RECOVERY_OUTPUT=/tmp/kairos-recovery-captures`

Both settings must be supplied together. Their immediate parent must exist; the socket and output roots are created with mode 0700 and must belong to the service Unix user. The socket itself is 0600, is never a TCP listener, and refuses to replace an existing socket. If a crash leaves a socket behind, establish that its process is gone before an operator removes it. Do not delete the data lease.

From an authenticated SSH session on that host:

```sh
node hosted/dist/hosted/src/recovery-client.js /tmp/kairos-recovery/control.sock
```

The client supplies a random correlation nonce. The service selects a new UUID operation directory and returns only paths, IDs, counts, hashes and timings. There is no caller-selected database or output path and no public backup endpoint. Record the output privately. A timeout is an unknown result: inspect the output directory before requesting another capture.

After a handled capture failure, the control removes only that request's newly created UUID directory, including a partial or already published backup, after the capture promise settles. It preserves other captures and refuses to remove a directory whose filesystem identity changed. A crash, power loss, or cleanup filesystem error can leave private plaintext remnants; inspect them before retrying. An interrupted client alone does not cancel an active capture.

Capture temporarily refuses new data requests with HTTP 503 and Retry-After while it drains already admitted requests and tracked authentication work. Existing tokens, sessions and notes are not invalidated. The process retains its database lease throughout capture. Health checks bypass admission. Capture failure resumes admission; service shutdown waits for active maintenance. Normal reads and writes resume automatically after the capture finishes.

Use [the encrypted vault workflow](RECOVERY_VAULT.md) to encrypt the completed capture with the Mac's public recipient and transfer the encrypted archive and receipt off-host. Keep the private identity off the host. `/tmp` is temporary staging, not durable backup storage. Never count a capture as protected until its off-host bytes match the retained receipt and an isolated restore succeeds.

## Recovery boundary and retention for this invited pilot

The operator records each successfully transferred capture, its independently retained receipt, latest separately obtained deletion witness, and restore evidence. Restore must target a new private directory and a private isolated process; this workflow never switches the live service directory. Existing live approvals remain untouched. All restored sessions, AI grants, pending verifications and signing keys are removed; restored users must authenticate and authorize again.

Data saved after a selected capture is outside its recovery boundary. No automatic backup interval or recovery-time guarantee is claimed. A capture-time witness is insufficient after later deletion/recreation. Obtain current deletion state from the still-live source before a rehearsal and retain it separately. If the source is lost and authoritative later deletion history is unavailable, refuse to treat an old witness as current. This fail-closed limitation is deliberate; unattended disaster recovery needs independently durable deletion history.

Retain the accepted encrypted pilot capture and its receipt in the private Mac vault while the operator selects a second protected key copy and a retention schedule. Plaintext staging captures and isolated restored copies must be removed after their evidence is recorded. Power-loss remnants require inspection; helpers do not silently purge them. This manual pilot workflow is not a customer backup-erasure policy. The authentication secret needs separate encrypted custody, and loss of the only decryption identity means the archive cannot be opened.
