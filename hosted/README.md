# Hosted Kairos Journal

**One journal for the AI connections you approve.**

Save context in one supported AI app and bring it into your next conversation in another. Hosted Kairos adds account sign-in, consent and owner controls to the Journal engine. Each account has its own journal; approved connections can read notes and, when granted write access, save notes in that record.

**Status: invited hosted pilot.** The owner has completed shared-journal read/write paths with Claude, ChatGPT and Grok, with their notes independently matched and visible in the native iPhone companion. Gemini's initial phone round trip also passed; after a later app update, the owner reported the connector missing on iPhone. Further Gemini phone troubleshooting and live renewal are on hold, with current documented Gemini use scoped to the computer browser. Independent onboarding and public customer signup remain ahead.

## What is implemented

- **Project resumption.** The shared Journal engine selects recorded goals, decisions, explicit open work and addressed handoffs, with dates and source IDs. This engine feature also works through local MCP without the account adapter.
- **History with explicit corrections.** The same engine supports replacement and resolution links in local and account-service operation; original records remain available in History.
- **Delivery evidence.** Hosted writes include the server-observed authenticated connection separately from the declared Author. New fields participate in the entry hash; they do not identify a particular model or establish the truth of a note.
- **Owner controls.** Download the journal, disconnect all AI access, or delete the active journal. Signing out and disconnecting have different effects; retention details are below.
- **Journal search.** The owner API supports Words, Exact phrase and Note ID searches with snapshot paging for the native client.

Local storage and self-hosting are core Journal choices. This account adapter is a service operators can deploy; the existing managed invited pilot is one deployment. The [local desktop package](../README.md#run-the-local-journal), this hosted adapter and the [native iPhone companion](https://github.com/Steffan005/Kairos-Bridge-iOS) have separate setup and release states. The native Kairos app presents its journal as **Anamnesis — Your journal**. The latest documented owner-accepted native beta is 0.1.0 build 6, October 14, 2026. This adapter's browser screens support the invited pilot; they are not the final app design.

## Start with the evidence

| Question | Read |
|---|---|
| How does project resumption work? | [Continue and authenticated delivery contract](CONTINUE.md) |
| Which actual provider paths passed? | [Deployment and Claude evidence](DEPLOYMENT_RECEIPT_2026-10-10.md), [ChatGPT](CHATGPT_ACCEPTANCE.md), [Grok](GROK_ACCEPTANCE.md), [Gemini and its current phone hold](GEMINI_ACCEPTANCE.md) |
| What changed for additional clients? | [Meta Muse preparation](MUSE_ACCEPTANCE.md) and the client-specific rules below. Preparation and local tests are distinct from provider acceptance. |
| How do native searches reach older records? | [Whole-journal owner search](OWNER_SEARCH.md) |
| How is imported history attributed? | [Owner-authorized history import](HISTORY_IMPORT.md) |
| What recovery has been demonstrated? | [October 15 hosted recovery rehearsal](RECOVERY_ACCEPTANCE_2026-10-15.md): a manual controlled restore preserved all 131,820 baseline owner entries. Automatic backup scheduling and customer recovery remain separate work. |
| How do I run or inspect the service? | [Local acceptance checks](#run-the-acceptance-checks), [local screens](#run-the-local-screens), [hosting configuration](STAGING.md), and [source and references](#source-and-references) |

The local development entry point accepts loopback HTTP; invited staging requires HTTPS. New development accounts must use addresses ending in `.test`; existing accounts sign in with their current Kairos email. Keep account credentials, invitations, private journal content and recovery bundles out of Git and public screenshots.

## Run the acceptance checks

Requires Node 20.19 or later and the root package dependencies:

```sh
npm ci
cd hosted
npm ci
npm test
```

The tests start real HTTP servers on free local ports. They create two synthetic accounts through Better Auth, register a public OAuth client in the local fixture, perform sign-in/consent and S256 PKCE code exchanges, then connect the actual MCP SDK. They check tenant isolation, source/date retrieval, owner export, read-only grants, invalid tokens, scope escalation, restart, sign-out, refresh retries, disconnection, pending-code invalidation, and journal deletion/recreation. A separate staging fixture simulates the HTTPS proxy boundary and checks invitations, discovery, cookies, and registration restrictions. Test databases and credentials are ephemeral and removed afterward. No external AI service is called; the proxy fixture is not actual Render/TLS evidence.

Run `npm test` from the root separately for the original local Journal regression suite.

The separate [whole-journal owner search API](OWNER_SEARCH.md) adds snapshot paging, Words, literal Exact phrase and exact Note ID lookup for native clients. Its local synthetic fixtures cover history beyond 50 entries, exact filters, complete text, Unicode phrase matching and authenticated cursor isolation. The initial October 12 search deployment used executable source 235b48e: read-only paging reached all 59 then-existing notes with every signed field retained, and the three modes found an older note beyond the former preview. Exact-source CI and 42 engine/56 hosted checks passed. Native build 5 is processed and Testing in the existing owner group; on October 13 the owner confirmed the full requested iPhone update/search/Show more check worked. This is operator-reported acceptance; independent onboarding and physical fault checks remain open. See OWNER_SEARCH.md for the dated evidence and limits.

## Project continuation and delivery evidence

See [CONTINUE.md](CONTINUE.md) for source-linked project briefings, explicit correction/resolution links and addressed handoffs. These are features of this branch's shared engine, available through [local MCP operation](../README.md#run-the-local-journal) as well as this adapter; they are absent from the older main snapshot. Schema 3 preserves existing records and hashes. On the authenticated account-service path, new notes separately record the connection that delivered them; the Author label remains declared attribution. Local MCP operation has no invented authenticated origin and uses an explicit recipient selector for addressed handoffs. Delivery origin is server-observed evidence, not provider-signed note content. These engine changes do not add a native briefing screen.

## Run the local screens

Build with `npm run build` inside `hosted/`. Set these environment variables outside Git:

- `KAIROS_PREVIEW_DATA`: an absolute path to a private development-data directory.
- `KAIROS_PREVIEW_SECRET`: a cryptographically random secret of at least 32 characters. Keep it unchanged for a given data directory; it protects authentication state and stored signing keys.
- `KAIROS_PREVIEW_URL`: optional; defaults to `http://127.0.0.1:18790`.

Then run `npm start` inside `hosted/` and open that URL. Create a `.test` account, save a note, view it, download the journal, disconnect all AI access, or delete it. No Apple key is involved. Keep this entry point on loopback. Synthetic notes are appropriate for acceptance tests; Steffan has separately authorized using non-sensitive Kairos build notes for our own continuity. Customer accounts, private personal records and credentials are outside this development scope.

## Prepared hosting path

See [STAGING.md](STAGING.md), the [Render Blueprint](../render.yaml), and the [deployment receipt](DEPLOYMENT_RECEIPT_2026-10-10.md). The separate `npm run start:staging` entry point requires a canonical HTTPS origin, persistent directory, authentication and invitation secrets, and the exact deployed source revision. It does not turn on public customer registration. The reviewed one-instance staging was approved and deployed; phone signup/reconnection and Grok Safari connector creation passed. Independent onboarding, other providers' initial phone connector creation and customer recovery remain pending.

## Boundaries that are implemented

- The journal path is derived from the **verified account ID**, never from a journal ID, project, tool argument, or actor label. A separate file serves each account.
- Better Auth 1.7.7 owns password hashing, sessions, OAuth client registration, consent, PKCE, signing keys, access-token expiry, and refresh-token rotation. Authentication dependencies live in their own locked package so they do not force the local MCP package from Zod 3 to Zod 4.
- OAuth resource discovery points to the authorization server. The resource validates JWT signature, issuer, audience, expiry, required claims, active account/client/consent, and a durable account generation on **every request**. AI authorization is independent of the browser session after consent. Generic account-token minting over HTTP is disabled. Machine/client-credentials grants and client/resource administration by ordinary accounts are disabled.
- Discovery requests read/write and the existing `offline_access` renewal scope; a user can grant read-only access. Existing read/write tokens remain valid without renewal permission. Access tokens last 15 minutes; refresh tokens are issued only when renewal is explicitly requested and consented. Refresh tokens rotate, with a 30-second retry interval that returns the same response for a matching retry; this is not general permission to reuse old tokens.
- Local fixtures permit dynamic client registration. Invited staging disables it. This source admits exactly `https://claude.ai/oauth/mcp-oauth-client-metadata`, `https://chatgpt.com/oauth/client.json`, `https://grok.com/oauth/mcp-client.json` and `https://cursor.com/oauth/mcp-client.json`, plus Google's strictly host-bound consumer identity shape described in [Gemini compatibility](GEMINI_ACCEPTANCE.md), through the library's SSRF-resistant fetcher. The Cursor document observed October 22, 2026 is a public client named Cursor. Its redirect URIs include `https://www.cursor.com/agents/mcp/oauth/callback`, plus the bot callback, Grok's connector callback, and two loopback HTTP callbacks. Better Auth's MCP metadata profile accepts that document without a Kairos-specific exception, so those exact URIs are trusted with the client. Writes from that client stay unclassified. Meta Muse has no metadata document. Invited staging seeds one public client, `kairos-journal-meta-muse`, bound only to `https://agent.meta.ai/api/hatch/oauth/callback`. See [Muse preparation](MUSE_ACCEPTANCE.md). That seed is not dynamic registration and does not widen the metadata allow-list. Actual Claude, ChatGPT and Grok iPhone read/write passed on the same owner journal. [Grok Safari approval, another fresh phone retrieval, visible Mac connector tool result and native Kairos display passed](GROK_ACCEPTANCE.md); its actual native Sign out/Disconnect checks remain open. ChatGPT native display, another fresh web retrieval, direct Codex tools, sign-out survival and actual Disconnect refusal also passed. Gemini's initial owner iPhone round trip, another fresh retrieval and native visibility passed; its later missing mobile app and live renewal are on hold at the owner’s direction, with current use scoped to the computer browser. See GEMINI_ACCEPTANCE.md. Claude Code and callback-specific OpenAI identities are not enabled. Consent displays the signed-in account, client ID and redirect host; a client-supplied name is not vendor verification.
- `journal:read` is required. A grant without `journal:write` cannot discover or invoke write, pin, or unpin tools. Hosted MCP never offers filesystem export; an authenticated owner gets an actual downloadable JSON file instead.
- Disconnection currently means **disconnect all AI access for this account**, not one selected provider. It increments the generation and removes consents, access/refresh records, and pending authorization codes. Old JWTs cannot revive after reconnection. Another account stays connected.
- Deletion disconnects access first, then removes the account's active journal, WAL, and SHM files. A tombstone prevents automatic recreation by an AI. Only the owner can start a new empty journal; old credentials remain invalid.
- Same-account journal requests and owner disconnection/deletion are serialized. The resource rechecks access after reading the body and acquiring that lock.
- Owner mutations require same-origin browser requests and a live cookie session. Request size is bounded. Responses are not cached; internal errors do not disclose database paths or token details.
- [Existing-account email change and password recovery](ACCOUNT_RECOVERY.md) use current-password proof, verified-mailbox one-use links and the same immutable account ID. Recovery signs out browser/app sessions while preserving approved AI connections. Delivery is optional and disabled until the operator configures a verified sender; isolated checks are separate from live email acceptance.
- Entries remain data rather than instructions. Actor labels are attribution supplied by the client; they are **not verified vendor identities** or access-control boundaries. This build makes no consciousness, identity, 40 Hz performance, or patent-novelty claim.

## Precisely what remains unproven

- Independent-user onboarding and first-time Claude/ChatGPT connector creation entirely on an iPhone. Grok custom-connector creation in Safari passed for the owner. Phone signup and reconnection of an existing Claude connector passed; the earlier fixed-token spike is separate evidence.
- Automatic backup scheduling, current deletion authority, retention/erasure, monitoring and customer-scale load behavior. The [October 15 hosted recovery rehearsal](RECOVERY_ACCEPTANCE_2026-10-15.md) restored an actual encrypted capture into an isolated process; it did not replace the live journal or establish automatic backups. One-process SQLite remains a staging architecture.
- Real email delivery and owner acceptance of the [new email/recovery flow](ACCOUNT_RECOVERY.md), public customer signup, account deletion, per-provider disconnect controls, and independent review before real customer data. New signup remains limited to invited test addresses; a verified change keeps that existing account's journal.
- Public App Store release and independent native onboarding. A separate signed iOS client has been installed through TestFlight by the owner, and its Claude round trip, reopen, sign-out, Disconnect, export and bounded offline checks passed. Updated-build fault cases and independent-user acceptance remain open. The Journal adapter does not package or sign that client.

## Revocation, retention, and integrity details

The owner **Disconnect all AI access** control is the immediate invalidation path tested here. The library's standard `/oauth2/revoke` endpoint supports refresh-token revocation but explicitly rejects direct JWT access-token revocation with `unsupported_token_type`; do not represent that endpoint as an immediate journal disconnect. Library consent removal/update is also wired to invalidate this account's AI access. **Signing out closes the owner's browser session; it does not disconnect an approved AI.** The local test checks both continued access and offline refresh after sign-out. Browser-session expiry is tested separately. A fresh physical Claude iPhone conversation also retrieved the saved note after owner sign-out; after Disconnect, another fresh conversation requested reconnection.

The local preview creates **no automatic backups**. Render staging can retain deleted data in hosting disk snapshots; the staging screens and deletion response disclose this. Journal deletion removes active note data immediately; it retains the sign-in account, control tombstone/generation, and authentication metadata. Downloaded exports are outside that deletion boundary. Removing the entire development data directory after closing the process removes its local authentication and control records too. This is not a production account-deletion policy. Consistent backups, restore tests and a deletion schedule must be demonstrated before customer data is accepted.

Journal verification is the existing hash-chain check. OAuth signatures authenticate credentials, not the factual truth of a note. The account generation is an access-revocation control, not a cryptographic proof of journal history. The new local [controlled restore utility](RECOVERY.md) removes restored authorization and signing keys and requires an operator-trusted deletion witness outside the backup. That witness is not maintained automatically. Restoring every database behind the application's back can still restore old state; no independent trusted-head service or automatic rollback detector is implemented or claimed here.

## Source and references

AGPL-3.0-or-later; preserve the attribution and copyright in [NOTICE](../NOTICE). Corresponding source includes both this adapter and the root engine. The preview is published on the `chatgpt/private-journal-service` branch; deployment must offer its actual source revision.

Primary references checked October 10, 2026:

- [Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider)
- [Better Auth CIMD](https://better-auth.com/docs/plugins/cimd)
- [Better Auth email/password](https://better-auth.com/docs/authentication/email-password)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Claude connector authentication](https://claude.com/docs/connectors/building/authentication)
- [Render web services](https://render.com/docs/web-services)
- [Render persistent disks](https://render.com/docs/disks)

Installed library types and implementations were also inspected. A generic OAuth/MCP fixture passing is not evidence of every provider's interoperability.


## Guided Claude setup

Invited staging offers **Connect Claude** using Anthropic's [documented prefilled install link](https://claude.com/docs/connectors/building/directory-vs-custom). Only the display name and service address enter that link. It prepares a form; it does not add a connector or grant access automatically. The owner still checks the Kairos account and grants permission, then enables the connector in a fresh Claude conversation.

When Kairos already records a Claude grant, the button opens Claude's existing connections instead. Kairos cannot observe whether tools are enabled in the current chat. If Claude says the server is already added, the page explains how to use its existing connector and reconnect if requested; the label can still contain “test.” Account journals remain separate. Revoking a previous account's approval still requires Disconnect in that account. Actual phone prefill/first-time creation remains to be tested; this UI is not a one-tap-install claim.
