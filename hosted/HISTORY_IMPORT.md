# Owner-authorized historical journal import

`POST /api/journal/import-history` imports reviewed historical records into the journal selected by the existing authenticated owner session. It is an owner API, not an AI tool. A journal OAuth bearer token does not authorize it, even when that token has read/write permission. Import does not issue grants, change consent, disconnect clients, copy auth records, or select another account.

The mutation requires the exact service `Origin` as well as the existing owner cookie. Host and HTTPS edge checks remain in place. The per-account lock prevents import, owner writes, deletion, and AI operations for that journal from overtaking each other. A deleted journal returns 410 and cannot be silently recreated by import.

## Request and response

The JSON body has one field, `records`, containing 1–50 records. This route alone accepts at most 512 KiB; ordinary owner, auth and MCP request bodies retain the 64 KiB limit. Existing 15-second request and 10-second header timeouts remain in place.

```json
{
  "records": [
    {
      "source_store": "synthetic-legacy-store",
      "source_id": "synthetic-record-1",
      "original_timestamp": "2026-01-02T12:30:00",
      "original_actor": "Dr. Claude Summers",
      "source_file_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "canonical_actor": "claude_summers",
      "timezone": "unspecified",
      "text": "Synthetic historical example.",
      "kind": "note",
      "tags": ["project-archive"],
      "source_metadata": { "lane": "self" }
    }
  ]
}
```

| Field | Limit / meaning |
| --- | --- |
| `source_store` | 1–128 characters, stable source-store identity. |
| `source_id` | 1–512 characters, stable original record identity. |
| `original_timestamp` | 1–128 characters; a strictly validated ISO calendar date/time, optional seconds/fractions and explicit offset. Future or impossible dates are refused. |
| `original_actor` | Original source attribution, 1–512 characters or `null` when missing. |
| `source_file_sha256` | Lowercase 64-character SHA-256 of the preserved source snapshot. |
| `canonical_actor` | `claude_summers`, `gemini_word`, `grok_ops`, `gpt_codex`, `operator` / `steffan`, `system`, `unknown`, or `null` for unknown attribution. The original actor and canonical identity remain in provenance. The journal actor is the compatible `claude`, `gemini`, `grok`, `chatgpt`, `you`, `system`, or `unknown` label. |
| `timezone` | `unspecified`, `UTC`, or a validated explicit `+HH:MM` / `-HH:MM` offset. It must agree with any suffix in the original timestamp. A naive historical timestamp is not assigned an invented timezone. |
| `text` | Nonempty note text, at most 8,000 characters, preserved without truncation. Secret-bearing text is refused by the engine. |
| `kind` | Optional existing journal kind; defaults to `note`. |
| `tags` | Optional at most 16 tags, at most 48 characters each; normal journal tag normalization applies without silent truncation. |
| `source_metadata` | Optional allowlisted flat JSON object, at most 4,096 UTF-8 bytes. See below. |

Allowed source metadata fields are `source_context_sha256`, `source_record_sha256`, `original_record_hash`, `original_value_hash`, `original_parent_id`, `original_parents`, `original_timestamp_value`, `original_key`, `lane`, `scope`, `recipient`, `source_category`, `author_conflict`, `source_actor`, and `source_role`. Values may be strings of at most 1,024 characters, finite numbers, booleans, null, or arrays of at most 32 such values. Nested objects, unknown fields and secret-bearing strings are rejected. Source context is represented by a digest rather than an unreviewed raw context dump.

The server supplies `imported_by: "owner"`; the client cannot set it. The engine supplies `imported_at` using the actual import clock. Provenance is part of the new entry's hash. Imported entries append to the integrity chain while retrieval follows their historical chronology. Existing entry IDs, text, signed fields, hashes and pins are preserved.

Successful first import and an exact replay both return HTTP 200:

```json
{ "inserted": 1, "skipped": 0, "ids": ["new-journal-id"], "headHash": "chain-head" }
```

An exact replay of `(source_store, source_id)` returns the existing journal ID without appending another entry. Different content or provenance under that identity returns 409. Each batch is one transaction: a conflict or invalid record saves none of its records. Multiple HTTP batches are not one transaction; an interrupted operator run should resume using the same reviewed records and source identities. Keep the operator manifest and per-batch receipts so partial progress is explicit.

Errors are generic and do not contain note text, source IDs, database paths, credentials or stack traces. Invalid fields/dates/text return 400, missing owner session 401, missing/wrong Origin 403, conflicts 409, deleted journals 410, and oversized bodies 413. The API exposes no unrestricted migration status or filesystem route.

## Chronology and export

The engine sorts history by its normalized original chronology key, using append sequence as the tie breaker. Unknown historical timezones remain unknown; relative order between naive and explicitly zoned records is a documented display convention, not a claim that the missing offset was recovered. The append sequence and hash chain continue to describe when records entered this journal.

The legacy `GET /api/journal` envelope retains its 50-entry cap and connection metadata, but follows chronology rather than re-sorting by append sequence. Whole-journal search uses signed version 2 cursors with a chronological date-and-sequence boundary and a maximum append-sequence snapshot. The existing MAC still binds the cursor to its owner, journal and search; an old cursor requires a refresh.

The existing owner JSON export includes complete imported provenance. Preserve a pre-import export and source snapshots privately. A migration rehearsal should compare every current entry and approval before/after, exact expected inserted/skipped counts, imported attribution/date samples, chronology pagination, and whole-chain verification before using the live endpoint.

The HTTP export streams its temporary file to the response rather than loading the complete export into RAM. Cleanup runs after completion or an aborted downstream connection. Offline backup manifests record the highest actual journal schema in the bundle, including mixed schema 1/2 stores; restore admits supported older backups while checking that the manifest agrees with the actual files. Restoring a backup retains the existing explicit reauthorization policy.

## Private operator commands

Use Node 20.19 or later. Keep source snapshots, the reviewed JSONL plan, credentials, exports and all receipts outside Git. The credential JSON supplies only the existing owner session cookie through a `cookie` string; the uploader never prints it or uses an AI bearer. The file must be private (no group/other permissions).

Rehearse the reviewed records against the known owner baseline:

```sh
node scripts/rehearse-history-import.mjs --baseline /private/tmp/BASELINE.json --records /private/tmp/RECORDS.jsonl --samples /private/tmp/SAMPLES.json --out /private/tmp/NEW_REHEARSAL
```

After deploying and observing the exact executable revision, submit the same reviewed JSONL plan using an already-authorized owner cookie:

```sh
node scripts/import-history-owner.mjs --origin https://journal.example.test --credentials /private/tmp/OWNER_COOKIE.json --records /private/tmp/RECORDS.jsonl --baseline /private/tmp/BASELINE.json --output /private/tmp/OWNER_IMPORT --revision 0123456789abcdef0123456789abcdef01234567
```

This invocation is a template with synthetic paths/host/revision. Supply the existing selected owner's actual private files and the observed revision. `--revision` verifies `/about` before any import. The uploader requires every known baseline ID and signed field to match that owner's live journal before writing; it does not accept an empty baseline. It copies the reviewed plan privately and hashes the snapshot so a concurrent change to the source file cannot change a running migration.

The operator streams the plan in batches of at most 50 records and less than 350 KiB. Each accepted response produces a fsynced private acknowledgment ledger mapping source identity and record fingerprint to the returned journal ID in input order. The ledger contains no note text or cookie. stdout contains counts and elapsed time only. Before/after exports download directly into private files with streaming SHA-256 fingerprints; they are not parsed wholesale in memory. Owner connection metadata and known baseline signed fields are checked again afterward.

If an HTTP response is lost after a successful write, the operator retries the identical batch; engine source identities prevent duplication. Network/5xx retries are bounded; 400/401/403/409 and other non-success client responses stop the run. Keep all receipts and fix the cause. Resume only with the identical origin, baseline, reviewed records and expected revision:

```sh
node scripts/import-history-owner.mjs --origin https://journal.example.test --credentials /private/tmp/OWNER_COOKIE.json --records /private/tmp/RECORDS.jsonl --baseline /private/tmp/BASELINE.json --output /private/tmp/OWNER_IMPORT --revision 0123456789abcdef0123456789abcdef01234567 --resume
```

Completed ledger batches are skipped after fingerprint checks. A crash-truncated last acknowledgment is hashed into a repair receipt and safely replayed. Reported inserted/skipped counts describe acknowledged server responses: an ambiguously successful first attempt can return `skipped` on retry. The observed journal count is retained separately, and ordinary simultaneous owner/AI writes can increase it. Treat the uploader as transport evidence; independently verify the final downloaded export and every historical provenance/ID against the rehearsal:

```sh
node scripts/verify-history-export.mjs --export /private/tmp/LIVE_EXPORT.json --baseline /private/tmp/BASELINE.json --rehearsal /private/tmp/NEW_REHEARSAL/rehearsal.db --samples /private/tmp/SAMPLES.json --out /private/tmp/VERIFY.json
```

`LIVE_EXPORT.json` should be the uploader's actual post-import export file. Acceptance requires that independent verification to pass, plus the owner phone display/provider retrieval checks. The transport script does not claim those outcomes.

## Validation scope

`hosted/test/history-import.test.ts` uses two isolated synthetic owners and a real local OAuth flow. It checks owner-only access, a real AI bearer's denial, same-origin enforcement, strict payload limits/metadata, current note and consent preservation, cross-owner isolation, restart replay, conflict transaction rollback, body-cap isolation, signed version 2 cursor tampering, export provenance, and refusal to repopulate a deleted journal. The full local hosted suite passed 88 checks on October 14, 2026 after streaming-export and schema 1/2 recovery integration. `scripts/import-history-owner.test.mjs` separately passed three network-free scripted-fetch fixtures for bounded batches, safe replay/resume, and preflight refusal. These fixtures are local behavior checks; actual hosted import, source completeness, physical iPhone display and provider retrieval require separate receipts.
