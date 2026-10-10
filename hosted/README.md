# Kairos private journal service — local synthetic preview

This adapter reuses the existing Journal engine. It adds account sign-in, OAuth consent, one SQLite journal per account, and owner controls. It is **not a deployed customer service, native iPhone app, or tested Claude OAuth integration**. It deliberately accepts only a loopback HTTP base URL and synthetic email addresses ending in `.test`.

The desktop package remains separate and retains its original install and stdio/HTTP behavior. The public Next.js App repository remains separate too. This minimal adapter UI is for acceptance work; it is not the final app design.

## Run the acceptance checks

Requires Node 20.19 or later and the root package dependencies:

```sh
npm ci
cd hosted
npm ci
npm test
```

The test starts a real HTTP server on a free loopback port. It creates two synthetic accounts through Better Auth, registers a public OAuth client, performs sign-in/consent and S256 PKCE code exchanges, then connects the actual MCP SDK. It checks tenant isolation, source/date retrieval, owner export, read-only grants, invalid tokens, scope escalation, restart, disconnection, pending-code invalidation, and journal deletion/recreation. Test databases and credentials are ephemeral and removed afterward. No external AI service is called.

Run `npm test` from the root separately for the original local Journal regression suite.

## Run the local screens

Build with `npm run build` inside `hosted/`. Set these environment variables outside Git:

- `KAIROS_PREVIEW_DATA`: an absolute path to an empty, private synthetic-data directory.
- `KAIROS_PREVIEW_SECRET`: a cryptographically random secret of at least 32 characters. Keep it unchanged for a given data directory; it protects authentication state and stored signing keys.
- `KAIROS_PREVIEW_URL`: optional; defaults to `http://127.0.0.1:18790`.

Then run `npm start` inside `hosted/` and open that URL. Create a `.test` account, save a synthetic note, view it, download the journal, disconnect all AI access, or delete it. No Apple key is involved. Do not tunnel this preview or put real journal information into it.

## Boundaries that are implemented

- The journal path is derived from the **verified account ID**, never from a journal ID, project, tool argument, or actor label. A separate file serves each account.
- Better Auth 1.7.7 owns password hashing, sessions, OAuth client registration, consent, PKCE, signing keys, access-token expiry, and refresh-token rotation. Authentication dependencies live in their own locked package so they do not force the local MCP package from Zod 3 to Zod 4.
- OAuth resource discovery points to the authorization server. The resource validates JWT signature, issuer, audience, expiry, required claims, active account/session/client/consent, and a durable account generation on **every request**. Generic account-token minting over HTTP is disabled. Machine/client-credentials grants and client/resource administration by ordinary accounts are disabled.
- `journal:read` is required. A grant without `journal:write` cannot discover or invoke write, pin, or unpin tools. Hosted MCP never offers filesystem export; an authenticated owner gets an actual downloadable JSON file instead.
- Disconnection currently means **disconnect all AI access for this account**, not one selected provider. It increments the generation and removes consents, access/refresh records, and pending authorization codes. Old JWTs cannot revive after reconnection. Another account stays connected.
- Deletion disconnects access first, then removes the account's active journal, WAL, and SHM files. A tombstone prevents automatic recreation by an AI. Only the owner can start a new empty journal; old credentials remain invalid.
- Same-account journal requests and owner disconnection/deletion are serialized. The resource rechecks access after reading the body and acquiring that lock.
- Owner mutations require same-origin browser requests and a live cookie session. Request size is bounded. Responses are not cached; internal errors do not disclose database paths or token details.
- Entries remain data rather than instructions. Actor labels are attribution supplied by the client; they are **not verified vendor identities** or access-control boundaries. This build makes no consciousness, identity, 40 Hz performance, or patent-novelty claim.

## Precisely what remains unproven

- A real Claude connector completing this OAuth flow, including its published client identity/CIMD path. The standard library's SSRF-resistant CIMD fetcher is configured; the local tests exercise dynamic registration instead of fetching Anthropic metadata.
- Setup entirely through an iPhone browser, then memory retrieval/write in a fresh Claude iPhone conversation, followed by independent verification. The earlier fixed-token mobile spike is separate evidence.
- Permanent HTTPS hosting, persistent volumes, production secret/key operations, backups, recovery, monitoring, and load behavior. One-process SQLite is a preview architecture, not a claim of readiness for millions of users.
- Verified customer email, account recovery, account deletion, per-provider disconnect controls, and independent review before real customer data. Email/password here is for made-up test accounts only.
- Native iOS packaging, App Store Connect app record/signing, and TestFlight. Apple membership activation is already recorded in the product plan; it does not depend on this server.

## Revocation, retention, and integrity details

The owner **Disconnect all AI access** control is the immediate invalidation path tested here. The library's standard `/oauth2/revoke` endpoint supports refresh-token revocation but explicitly rejects direct JWT access-token revocation with `unsupported_token_type`; do not represent that endpoint as an immediate journal disconnect. Library consent removal/update is also wired to invalidate this account's AI access. Signing out/expiry of the authorizing browser session can make its session-bound AI credentials unusable.

This local preview creates **no automatic backups**. Journal deletion removes active note data immediately; it retains the sign-in account, control tombstone/generation, and authentication metadata. Downloaded exports are outside that deletion boundary. Removing the entire preview data directory after closing the process removes its local authentication and control records too. This is not a production account-deletion policy. Hosting backups and a deletion schedule must be defined and demonstrated before customer data is accepted.

Journal verification is the existing hash-chain check. OAuth signatures authenticate credentials, not the factual truth of a note. The account generation is an access-revocation/freshness control, not a cryptographic proof of journal history. Restoring every database from an old backup can restore old state; no independent trusted-head service is implemented or claimed here.

## Source and references

AGPL-3.0-or-later; preserve the attribution and copyright in [NOTICE](../NOTICE). Corresponding source includes both this adapter and the root engine. The preview is published on the `chatgpt/private-journal-service` branch; deployment must offer its actual source revision.

Primary references checked October 10, 2026:

- [Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider)
- [Better Auth CIMD](https://better-auth.com/docs/plugins/cimd)
- [Better Auth email/password](https://better-auth.com/docs/authentication/email-password)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Installed library types and implementations were also inspected. A generic OAuth/MCP fixture passing is not evidence of every provider's interoperability.
