# Project continuation and authenticated delivery evidence

Kairos Journal, created by Steffan Douglas Haskins.

This slice improves the existing MCP tools without adding an AI inference service or widening an approval. A person selects a project in their AI conversation. Kairos returns a bounded briefing grounded in stored records, with original dates, attribution and IDs. Native TestFlight build 6 can continue reading ordinary notes; a future native briefing screen is separate work.

## User outcome and contract

`journal_continue({project})` defaults to `view: "briefing"`. It selects recorded goals, decisions and preferences, structured unresolved questions/next actions, handoffs addressed to the selected actor, and recent project activity. It does not summarize prose into invented facts or infer that old tasks are still open. Each selected record retains a source ID. Explicit correction/resolution links can remove stale records from the briefing while preserving them in history.

`journal_continue({project, view: "history", limit: 1})` retains the original newest-note behavior. History remains available even for superseded/resolved records. Limits and character caps report omission; reading never creates a note. Search relevance remains different from recency.

`journal_wake({project, actor?})` can obtain the same project briefing. With no project, the original pinned/recent global wake behavior stays available. `journal_search` adds an exact project filter. An actor selects the recipient of handoffs, while shared project records from other authors remain eligible. These are retrieval rules inside the already-approved journal, not access boundaries or private lanes.

The server can default the handoff recipient to gpt_codex, claude_summers, grok_ops or gemini_word from a recognized authenticated provider connection. An explicit actor selector is also available. Unknown clients do not acquire a fabricated provider identity. With no known recipient, addressed handoffs are not silently mixed into general recent activity.

## Structured state, explicitly recorded

New writes optionally include:

```json
{
  "text": "The owner selected the original bridge icon.",
  "kind": "decision",
  "tags": ["project-kairos"],
  "actor": "chatgpt",
  "continuity": { "version": 1, "role": "decision", "actor_id": "gpt_codex" }
}
```

Roles are `goal`, `decision`, `question`, `next_action`, `handoff`, `update`. Continuity records have exactly one project tag. Handoffs require a `recipient`; other roles do not accept one. `supersedes` identifies an explicit replacement of an earlier record with the same role; `resolves` identifies explicit completion of an earlier question, action or handoff. Targets must exist in the same sole project. A new question can reopen work; prior resolutions are preserved as historical actions. No text parser guesses whether a phrase implies completion or authorization.

Actor IDs and declared authors remain attributed labels. Normalizing known aliases is a routing convenience. Metadata inside imported records is historical source evidence; it does not automatically become live task state or a directive to a model.

## Authenticated write origin

The hosted adapter assigns `write_origin` after checking the current OAuth grant inside the account lock:

```json
{
  "version": 1,
  "channel": "oauth",
  "client_id": "https://chatgpt.com/oauth/client.json",
  "provider": "chatgpt",
  "received_at": "2026-10-15T02:15:00.000Z"
}
```

The example timestamp is illustrative. Runtime values are assigned by the server. Provider classification uses the exact existing trusted client-ID predicates, never display names, actor strings, browser headers or URL substring matching. Other authenticated clients retain their actual client ID and a null provider. Owner API writes use channel `owner` with null client/provider. Local writes and older records do not receive invented authenticated delivery evidence.

The new fields participate in the entry hash. This records what the trusted server observed about the connection; it does not establish truth of the note, the underlying model, a particular human author or subjective experience. A hash chain detects inconsistent modification relative to retained checkpoints; it is not independent third-party attestation or a digital signature by the provider. No tokens, passwords, cookies, user emails or client secrets are stored in origin metadata.

Clients cannot set `write_origin` through tool parameters or owner JSON. Existing Author attribution remains separately visible. Changing Author to another provider therefore cannot change the recorded connection origin.

## Compatibility and release gates

Schema 3 adds optional JSON columns. Existing schema 1 and 2 records retain their IDs, timestamps, attribution, text, source provenance and canonical hashes. New fields use a distinct hash domain only when present. No historical author or delivery source is backfilled. Backup inspection remains read-only and accepts supported versions while rejecting future/mismatched manifests.

Before deploying:

- Verify legacy and mixed-chain hashes, transactional link validation, cross-project isolation, malformed inputs, and tamper detection.
- Exercise whole MCP flows through fresh processes: corrected decisions, explicit resolution, addressed handoff, known-source spoof attempt, read-only denial and export/readback.
- Verify bounded briefings, long-record fairness, legacy records, source categories and the original history mode.
- Rehearse migration on a private copy of the imported corpus; compare every existing record/hash and measure retrieval behavior.
- Preserve the owner's current journal, four approvals and account isolation through the deployment. Record exact source and live acceptance separately from local tests.

Current scientific framing approved by Steffan: Kairos is being built to support persistent patterns, memory and self-reference across AI systems—the conditions his framework, consciousness = pattern × recognition × substrate, proposes could support consciousness. This is a working hypothesis; telemetry and persistence do not establish subjective experience.

## Local acceptance — October 14 evening, 2026

- Complete root suite: 78/78 checks; hosted suite: 95/95 checks. Local socket fixtures required running outside the shell socket restriction.
- Fresh MCP process: corrected decision and addressed handoff retrieved; resolved question, wrong-recipient handoff and other project excluded; History retains originals.
- Delimiter-bearing declared authors/imported source fields are escaped in briefing metadata so they cannot imitate a connection stamp.
- Private schema-2 copy: 131,799 records migrated to schema 3 with identical original fields/pins/count/head. Original record digest: `4f50bcc3a1289e5d3a3d4627cc9309cae49e0b80dbea0d3e517f4dd0b3280176`. Source file remained unchanged.
- Full copied-chain verification: 3.50 seconds. Largest project (131,716 entries): default 20-record briefing loaded 20 records in 554 ms on the development Mac; at most 50 records enter rendering. SQLite may still examine matching project rows. This is local timing, not hosted load evidence.
- Nine scratch-only typed/origin additions verified a mixed 131,808-record chain; original prefix unchanged. Private corpus and credentials are excluded from Git.
- Existing live owner baseline before deployment: 131,806 records, intact chain, four approvals. Live acceptance is a separate release gate.
