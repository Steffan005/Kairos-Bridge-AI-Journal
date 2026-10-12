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

## Actual-provider gate — pending

1. Deploy reviewed source on the existing approved service and confirm exact
   source, all owner notes and existing revocation state.
2. Reuse the prepared Grok connector; inspect the real account, client, callback
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
