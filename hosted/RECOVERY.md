# Controlled offline recovery — local development acceptance

This operator utility has passed local synthetic checks. It is not an automatic hosted backup service, customer password-reset feature, or proof against an unannounced platform rollback. It has not been run on the Render staging disk. The app and its matching recovery utility must use this revision's data lease and deletion-generation schema.

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
