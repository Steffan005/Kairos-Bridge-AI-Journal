# Whole-journal owner search

This source adds a separate owner API for browsing and searching all authorized journal history. Local synthetic engine and HTTP fixtures test the implementation. Deployment and physical iPhone behavior require separate receipts.

## Invited staging acceptance — October 12, 2026

Executable source `235b48e0e8016f053f25440fb82fd9516c8df4b2` is deployed on the existing invited service; live source discovery matched. Its [exact-source CI run](https://github.com/Steffan005/Kairos-Bridge-AI-Journal/actions/runs/38306561503) passed, alongside 42 engine and 56 hosted local checks.

Independent read-only owner calls paged all 59 then-existing records in four pages, matching every signed field to a pre-deployment export. A record beyond the former 50-note preview was recovered by Words, literal Exact phrase and uppercase exact Note ID. Missing owner authentication returned 401 and a query-changed cursor returned 400. Existing Claude, ChatGPT and Grok approvals remained present. These checks did not create new test notes or alter grants. Later genuine progress checkpoints add records normally.

Actual native Simulator searches and exact Project/Author filtering passed against that service. Native build 5, compiled from 349d4f1, is processed and Testing in the existing Kairos Owner Pilot (one tester, five builds); the owner subsequently confirmed the full requested physical update/search/Show more check worked on October 13. This is operator-reported acceptance without a separate screenshot or per-control trace. This is one invited owner's bounded history, not production-scale performance or independent customer onboarding. Private exports and receipts stay outside Git.

`GET /api/journal/search` requires the existing live owner cookie session. An AI OAuth bearer token does not authorize this route. The account's existing isolated journal file determines the search boundary; project and author labels do not grant access.

## Request

| Parameter | Meaning |
| --- | --- |
| `q` | Optional search text. Empty or whitespace-only text browses history. Maximum 512 characters after NFC normalization and trimming. |
| `mode` | `words` (default), `exact`, or `id`. |
| `project` | Optional exact stored project tag from `projects`, for example `project-kitchen`. A text mention or `project-kitchen-remodel` does not match this filter. |
| `author` | Optional exact stored actor label from `authors`, for example `claude` or `you`. Labels are attribution supplied by clients, not verified vendor identities. |
| `limit` | Page size, 1–50; default 15. |
| `cursor` | Opaque `next_cursor` from the preceding page. Keep the same search text, mode and filters. |

Example: `/api/journal/search?q=violet%20cabinetry&mode=words&project=project-kitchen&author=claude&limit=15`.

All modes return newest journal append first (`seq` descending). They do not offer relevance ordering in this slice.

- **Words:** safely quoted terms search note text and tags through the existing Porter/Unicode FTS index. Words may match stemmed forms and the index removes diacritics. Every supplied letter/number/underscore token participates; no stopwords are silently removed. At most 32 different terms are accepted. All-word matching runs against the entire filtered snapshot first. Only when it finds zero matches does the query fall back to any-word matching. `matched_mode` declares `all` or `any`; continuation preserves that choice. Punctuation and operator-looking input never execute FTS instructions. Punctuation-only input returns zero matches.
- **Exact phrase:** a case-insensitive literal substring of note text, with punctuation, word order and interior whitespace preserved. Outer whitespace is trimmed and both query and stored text use NFC normalization. A deterministic JavaScript Unicode lowercase function handles matching; SQLite's ASCII-only `lower`/`LIKE` is not used. This is ordinary Unicode lowercase matching, not locale-specific case folding or accent removal. Quotes typed into the field are literal quotes. No stemming is applied.
- **Note ID:** one complete 16-character hexadecimal note ID, with letter case normalized. It queries the `id` column exactly and returns at most one entry. Partial IDs, fingerprints, and notes that merely mention an ID are not returned. Project/author filters still apply.
- **History:** an empty query pages every note, including pinned notes, once. Project/author filters still apply.

## Response

```json
{
  "entries": [],
  "next_cursor": null,
  "matched_mode": "history",
  "total": 0,
  "snapshot_seq": 0,
  "projects": [],
  "authors": []
}
```

`entries` contains complete existing `Entry` objects: full text, ID, actor, tags, full `created_at` timestamp, sequence, tick, kind, hash fields, and current pin preference. No card/text truncation occurs in this API. `total` counts all matches within the snapshot, not only this page. `projects` and `authors` cover the whole snapshot independently of the active search or filter, so old-only labels remain available.

The first request captures the current maximum sequence. Subsequent pages use that snapshot and an exclusive last-sequence boundary. Notes appended later are excluded until the client refreshes without a cursor. `next_cursor` is non-null only when another matching result exists; there are no offsets or artificial 50-record history ceiling. Pin changes may be visible on later pages because pins are a mutable preference outside the signed entries.

The hosted cursor is authenticated with an HMAC using the existing service secret. It binds the verified owner, journal identity, search/mode/filter digest, chosen match behavior, snapshot and page boundary. Its payload contains a query digest, not the query text. Changed searches, another owner, tampering or a recreated journal return a human-readable HTTP 400 error; refresh without a cursor. Restart with the same persistent journal and service secret preserves valid cursors. Deletion returns HTTP 410, and missing/expired owner sessions return HTTP 401.

## Scope and limits

Existing `GET /api/journal` remains compatible with older clients, including its 50-entry owner preview, connection metadata, and deletion tombstone. Export, notes, OAuth grants, sign-out, disconnect and whole-journal deletion behavior remain unchanged. No signed fields or database schema/indexes change. The search path does not append records or persist queries/history, and application code does not log search queries. This does not establish a hosting-provider request-log policy.

Exact phrases currently scan note text. Counts, filters and full snapshot catalogs also have work proportional to matching/history size. The fixtures establish behavior and isolation, not production latency or load capacity. Meaning search, embeddings, relevance ordering, date filters, partial IDs and fingerprint lookup are deferred.

Run `npm test` at the repository root for the engine regression suite and inside `hosted/` for the authenticated HTTP and existing auth/recovery/staging regression suite. New fixtures use isolated synthetic journals and temporary accounts only; no real owner notes or external AI services are used.
