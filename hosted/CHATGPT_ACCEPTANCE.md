# ChatGPT web shared-journal acceptance — October 11, 2026 ET

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

## Actual-provider evidence

The owner supplied actual ChatGPT web conversation results. A separate authenticated
owner API read independently matched those results to the same synthetic journal
used by the native Kairos TestFlight app. This is actual-provider evidence, with an
operator report rather than a captured raw ChatGPT tool trace.

- Exact executable source `ebad6d1deb102f18bea761155b640049d31f31b6` is deployed
  on the existing invited service. Deployment preserved the nine then-existing
  phone-owner notes and created no AI approval by itself.
- A fresh ChatGPT web conversation retrieved the owner's tagged copper-kettle
  note with matching text, actor and ID. Its displayed minute timestamp matched
  the full stored timestamp `2026-10-12T01:48:50.485Z`.
- ChatGPT saved and read back the explicitly requested note
  “Synthetic ChatGPT shared-journal acceptance: ChatGPT recovered the copper kitchen kettle.”
  The owner API found exactly one matching entry, timestamp
  `2026-10-12T02:03:04.340Z`, actor `chatgpt`, tag `project-kitchen`.
- The owner API confirmed consent for the exact ChatGPT client identity with
  journal read/write scopes. The phone-owner journal contained 12 notes at this
  observation; earlier notes were preserved.

The initial approval selected an older synthetic account because Chrome reused
its Kairos login. No notes crossed accounts. The owner explicitly selected the
phone account before the successful read/write. Customer onboarding still needs
a clear way to choose another Kairos account at consent.

## Reproduction and remaining gate

1. Preserve the existing disk, authentication secret, invitation and approvals
   whenever updating staging. Verify exact source and health.
2. In ChatGPT web's custom MCP form, use name `Kairos-Bridge`, endpoint
   `https://kairos-journal-staging.onrender.com/mcp`, and OAuth. No manual bearer
   header, OpenAI API key or public unauthenticated access is needed.
3. Owner signs into the existing synthetic Kairos pilot account, checks the client,
   callback and requested journal scopes, then grants access deliberately.
4. Fresh actual ChatGPT conversation retrieves a known saved project note with
   exact text, timestamp, actor and ID; writes an explicitly requested synthetic
   note; independently confirm it via the journal owner's API.
5. **Pending:** confirm the new ChatGPT write in the native iPhone journal and
   retrieve it in another fresh ChatGPT conversation. Check that owner sign-out
   preserves approved ChatGPT access, while Disconnect stops it and preserves
   all notes. Local signed-client fixtures cover these controls; they do not
   substitute for the remaining actual ChatGPT checks.

ChatGPT iPhone app use is untested. Do not infer mobile support from the successful
web conversations. This is a private development plugin, not a published plugin
or customer release.

Gemini, Grok and Codex runtime tool availability remain separate acceptance gates.
Actor labels on entries remain client-supplied attribution, not vendor attestation.
