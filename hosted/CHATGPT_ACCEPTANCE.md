# ChatGPT connection preparation — October 11, 2026 ET

This change admits one additional exact client metadata URL in invited staging:
`https://chatgpt.com/oauth/client.json`. Claude's existing identity stays admitted.
Public dynamic registration remains disabled. Existing signing keys, account data,
consent records and access-generation rules are unchanged by this source change.

## Evidence before deployment

- The installed Better Auth 1.7.7 CIMD library fetched the real official document
  using its public-address-pinned, redirect-refusing transport. Authorization in
  an isolated synthetic database reached `/consent` without visiting ChatGPT's callback.
- The document specifies `private_key_jwt`, RS256, public key discovery at
  `https://chatgpt.com/oauth/jwks.json`, and exact callback
  `https://chatgpt.com/connector_platform_oauth_redirect`.
- A local synthetic key fixture checks exact redirect matching, unsigned refusal,
  wrong PKCE refusal, signed code exchange, signed refresh, owner-bound grants,
  sign-out persistence and immediate owner Disconnect. It does not use OpenAI's
  private key and is not a ChatGPT conversation.
- All 44 hosted checks and 34 existing desktop Journal checks pass locally.

Source: [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth)
and [the official client metadata](https://chatgpt.com/oauth/client.json), observed
October 11 ET. Our server advertises issuer identification, which selects the
stable ChatGPT client identity. Other client identities require separate observation.

## Actual-provider gate, still pending

1. Deploy the reviewed source on the existing invited service; preserve the disk,
   authentication secret, invitation and Claude approvals. Verify exact source and health.
2. In ChatGPT web's custom MCP form, use name `Kairos-Bridge`, endpoint
   `https://kairos-journal-staging.onrender.com/mcp`, and OAuth. No manual bearer
   header, OpenAI API key or public unauthenticated access is needed.
3. Owner signs into the existing synthetic Kairos pilot account, checks the client,
   callback and requested journal scopes, then grants access deliberately.
4. Fresh actual ChatGPT conversation retrieves a known saved project note with
   exact text, timestamp, actor and ID; writes an explicitly requested synthetic
   note; independently confirm it via the journal owner's API.
5. Fresh conversation retrieves the write; sign-out preserves approved access;
   Disconnect stops it and preserves all notes. Do not infer mobile support from
   a successful web conversation; that requires its own actual phone check.

Gemini, Grok and Codex runtime tool availability remain separate acceptance gates.
Actor labels on entries remain client-supplied attribution, not vendor attestation.
