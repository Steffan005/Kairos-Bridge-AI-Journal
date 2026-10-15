# Private historical-memory preparation

`prepare-legacy-history.mjs` is an operator-only, offline adapter. It never contacts the hosted service and never overwrites a source. Its output contains private journal data and must stay outside Git.

Run the synthetic adapter tests:

```sh
node --test scripts/prepare-legacy-history.test.mjs
```

Prepare records with a private configuration file:

```sh
node scripts/prepare-legacy-history.mjs --config /private/tmp/PRIVATE_CONFIG.json
```

Configuration shape (paths below are synthetic):

```json
{
  "output": "/private/tmp/private-history-packets",
  "batch_records": 50,
  "batch_bytes": 350000,
  "sources": [
    { "store": "kairos-daemon-moments", "type": "kairos-state", "path": "/private/tmp/source-snapshot.db" },
    { "store": "trinity-v27-memories", "type": "trinity-v27", "path": "/private/tmp/trinity.json" },
    { "store": "unity-november-memories", "type": "unity-memories", "path": "/private/tmp/unity.json" },
    { "store": "kairos-unified-context", "type": "unified-context", "path": "/private/tmp/context.db" },
    { "store": "unity-october-orchestrator", "type": "unity-october", "path": "/private/tmp/october.json" }
  ]
}
```

Store names identify a stable origin; they must not include a run timestamp. Historical import idempotence uses `(source_store, source_id)`, and rejects a different payload for the same origin. Source files are copied or SQLite-backup-snapshotted privately before preparation. SQLite backup can produce different physical file bytes while retaining the same rows; imported fingerprints identify the exact frozen snapshot used.

Output files and source snapshots have mode `0600`, and containing directories have mode `0700`:

- `all-safe-records.jsonl`: complete safe-record stream using the engine's `HistoricalRecord` contract.
- `batches/batch-00001.json` onward: `{ "records": [...] }`, at most 50 records and approximately 350 KiB before envelope overhead.
- `provenance-manifest.jsonl`: richer, private provenance keyed by origin. Includes original tags, exact text fingerprints, raw author labels, context fingerprint, classification and tag projection reasons.
- `quarantine-manifest.jsonl`: source IDs, row fingerprints and explicit exclusion reasons only. No raw body or credential values.
- `january-actor-rehearsal.json`: up to four safe January records per confirmed provider actor.
- `summary-manifest.json`: source fingerprints, counts, category/actor/month/timezone breakdowns, packet fingerprints and count reconciliation.

## Preservation rules

Text is retained exactly, including whitespace. Original date strings are retained; naive dates remain timezone-unspecified. Unix timestamps carry UTC evidence and their original numeric value. Full context is retained in frozen source snapshots, fingerprinted in imported provenance, and not indiscriminately uploaded. Explicit source labels and context actor IDs determine attribution; a filename, application origin or shared identity hash does not identify every speaker. Conversation `user` rows map to the operator; `assistant` with explicit Claude source maps to Claude; mixed conversation archives remain unattributed.

Repeated events at different origin IDs remain distinct. Mechanical telemetry is classified and retained by default. Exact duplicate origin copies are accounted separately. Conflicting copies are flagged and not silently substituted. Corpus/crystal exports known to repeat primary IDs remain excluded as overlapping snapshots; their cleaned canonical source wins over old credential-bearing variants.

The adapter loads the exact current engine `findSecret` code via TypeScript transpilation and additionally checks bearer credentials, generic credential assignments and credentials embedded in URLs. It scans body and source metadata. Secret-bearing, empty and oversize records are quarantined without truncation or partial import. This is a best-effort gate, not a guarantee that every historical value has been independently reviewed.

Tags are normalized using the journal's public tag conventions. Oversize or excess tags are retained in private provenance with explicit projection reasons; the import payload never silently slices a tag string. Original record/value hashes, parent fields, raw actor labels, lane, scope, recipient, role and context/row fingerprints use the engine's bounded `source_metadata` allowlist. Metadata that cannot fit its bounds is quarantined rather than truncated.

Use a separate database containing the current journal baseline for a full import rehearsal before uploading packets. Verify exact counts, existing IDs/notes/pins, hash-chain integrity, actor/project/search retrieval, original-date ordering and idempotent retry. This adapter does not perform that hosted upload or deployment.
