# Grok connection preparation — October 11, 2026 ET

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

## Actual-provider gate — pending

1. Deployed source and preserved notes passed the preflight above. Recheck them
   whenever the service changes.
2. Complete the prepared Grok linking; inspect the real account, client, callback
   and scopes at Kairos consent. The owner deliberately approves that access.
3. In a NEW Grok conversation, retrieve a known saved project note with text,
   timestamp, actor and ID. Save one explicitly requested note and independently
   match the owner record. A new conversation must retrieve it.
4. Confirm native journal display, approved access after sign-out, and refusal
   after owner Disconnect while all notes remain.
5. Test Grok on the actual iPhone app separately. Do not infer phone support from
   the web UI or metadata. Grok Bot is another client surface, not automatically
   covered by the consumer Grok connector.

Actor labels remain client-supplied attribution. No consciousness, identity,
market-size or production-readiness conclusion follows from these checks.
