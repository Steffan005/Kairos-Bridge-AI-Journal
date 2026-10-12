# Grok shared-journal acceptance — October 11–12, 2026 ET

## Observed identity

The actual signed-in Grok consumer interface exposed New Connector → Custom.
Its OAuth request to the existing Kairos `/mcp` service used:

- Client ID `https://grok.com/oauth/mcp-client.json`.
- Callback `https://grok.com/connectors-oauth-exchange-code/`.
- S256 PKCE, the canonical MCP resource, and openid/offline_access/journal read/write scopes.

The then-deployed two-client source refused this unadmitted identity. That was
the expected fetch-policy boundary, not a successful Grok connection.

The installed SSRF-resistant metadata fetcher returned the official JSON with
HTTP 200. It declares public-client token authentication `none`, code and refresh
grants, and two explicit callbacks: the observed consumer callback and
`https://console.x.ai/connectors-oauth-exchange-code/`.

Sources: [official metadata](https://grok.com/oauth/mcp-client.json) and
[xAI custom-connector instructions](https://docs.x.ai/grok/connectors).

## Implemented preparation

This source adds only the exact observed Grok metadata URL to the staging
allow-list. Public DCR remains disabled. Existing Claude/ChatGPT identities,
account isolation, scopes, signing keys and revocation behavior are retained.
No new hosting service, API key or journal migration is needed.

Redirects must match a URI declared by the trusted metadata document. A blanket
same-origin check on every declared callback would reject Grok's real document
because its console callback uses another origin. Do not substitute that rule
for exact callback matching without checking provider compatibility.

## Executed local evidence

- A Grok-shaped synthetic CIMD fixture checks the actual public-client metadata
  shape, exact consumer callback, same-server error refusal for an unregistered
  callback, denied client-ID variants without an outbound metadata fetch, wrong
  PKCE refusal, code/refresh exchange, owner-bound access, sign-out preservation,
  and Disconnect rejection of access, refresh and a previously approved code.
- The ChatGPT unregistered-callback assertion now requires the server's own
  `invalid_redirect` error page with no authorization code, rather than accepting
  any response that happens not to reach consent.
- All 48 hosted checks pass. Fixtures use isolated temporary databases and no
  provider account or production key.
- A separate real-metadata component check used the production-default fetcher
  and reached `/consent` with authentication method `none`. Consent was not
  approved and Grok's callback was not visited.

These are local protocol/component results, not a hosted Grok conversation.

## Deployed preparation and actual linking attempt — October12 morning ET

- Live source discovery confirms exact
  `f7467b13b1a6844a72e2bf27db0740bb91738b37`; health succeeds. Independent
  owner preflight confirmed25 preserved records and existing Claude/ChatGPT
  approvals, with no Grok grant.
- Actual consumer setup reached the hosted Kairos consent screen on the intended
  phone-owner account. It displayed the exact Grok identity and consumer return
  host, with account identification, offline access and journal read/write scopes.
  The owner explicitly confirmed approval intent.
- The Mac attempt did not finish: computer-use click dispatch failed or the
  permission popup closed before approval completed. The locally opened Grok
  app is a Chrome-installed web app; it subsequently displayed “Connection
  failed.” An independent owner read still found no Grok approval.
- The owner was asked to finish custom-connector setup directly in iPhone Safari,
  stopping at Connected or the first error, without duplicating a listed connector.

Approval intent and a displayed consent page are not a completed grant. The
Mac failure's cause is unisolated. No actual Grok note retrieval/write or native
iPhone Grok acceptance is established by this attempt. Existing approvals remain
intact; no executable change or new deployment is needed for the phone retry.

## Superseding actual-provider acceptance — October12 morning ET

The owner added Kairos-Bridge through iPhone Safari. An independent authenticated
owner API read confirmed the exact Grok approval on the same journal as Claude
and ChatGPT, with journal read/write and offline scopes. Both existing approvals
remained and the25 preflight records were unchanged.

- A NEW actual Grok iPhone conversation retrieved the prior ChatGPT kitchen note
  `534e5fc17915cd3a`, with matching text, displayed timestamp and actor.
- That conversation saved once and separately read back
  “Synthetic Grok iPhone acceptance: the kitchen curtains are linen.” Independent
  owner API verification found exactly one matching entry: `c5bbceab828402c9`,
  timestamp `2026-10-12T14:47:57.544Z`, actor `grok`, tag `project-kitchen`.
- An actual Codex `journal_continue` call independently retrieved that record.
- ANOTHER new Grok iPhone conversation retrieved the same note without a write
  or reconnection. The owner refreshed native Kairos and confirmed it visible.
- A separate new conversation in the Mac Grok web app also retrieved the note.
  Its visible tool activity was inspected: `journal_continue` with project
  `kitchen`, limit1 returned the matching ID and text. A generic web search was
  visible before that connector call; the prompt had supplied no expected text
  or ID. No write was requested there.

Phone actions are operator reports independently matched to stored records;
a raw phone tool trace was not captured. The Mac connector request/result was
observed in its visible tool card. These results supersede pending-linking and
phone-untested statements above while preserving the earlier failed attempt.

## Remaining gates

- Repeat Grok's actual native owner Sign out/Disconnect checks. The Grok-shaped
  local fixture passed those controls; actual Grok refusal after native
  Disconnect has not been measured. Existing approvals are currently retained.
- Independent-user onboarding and a guided native Grok setup flow. Owner Safari
  connector creation passed; the native Kairos app currently guides Claude.
- Grok Bot is a separate client surface and has not been connected by these
  consumer Grok tests.
- Customer account recovery, production retention and wider release remain open.

Actor labels remain client-supplied attribution. No consciousness, identity,
market-size or production-readiness conclusion follows from these checks.
