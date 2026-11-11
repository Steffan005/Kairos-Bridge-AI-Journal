# ChatGPT web and iPhone shared-journal acceptance — October 11–12, 2026 ET

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

- At the October11 deployment, exact executable source `ebad6d1deb102f18bea761155b640049d31f31b6` was deployed
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
- Another new ChatGPT web conversation recovered the write without saving or
  reconnecting. The owner confirmed it appeared in the native TestFlight app.
- Kairos tools became available in the Codex task. Actual read/write and readback
  matched the same owner journal. After native owner sign-out, an actual Codex
  read still returned the saved kitchen note.
- After native owner Disconnect, an actual Codex call was refused with
  `UNAUTHORIZED` / `oauth_token_invalid_grant`. No reconnection was triggered.
  Independent owner reads and hash-chain recomputation confirmed all 18 records
  remained and no AI connections were approved.

The initial approval selected an older synthetic account because Chrome reused
its Kairos login. No notes crossed accounts. The owner explicitly selected the
phone account before the successful read/write. Customer onboarding still needs
a clear way to choose another Kairos account at consent.

## Actual iPhone acceptance — October12 morning ET

- After the owner deployed source `f7467b13b1a6844a72e2bf27db0740bb91738b37`,
  live source discovery and health succeeded. An independent owner read confirmed
  all18 predeployment notes unchanged and current Claude/ChatGPT approvals.
- The owner initially reported a ChatGPT iPhone internal error, then a successful
  kitchen read matching the saved copper-kettle entry. The error's cause was not
  captured; recovery does not establish that deployment caused or fixed it.
- A NEW ChatGPT iPhone conversation saved once and read back
  “Synthetic ChatGPT iPhone acceptance: the kitchen window faces east.”
  An independent authenticated owner API read confirmed exactly one matching
  entry, ID `534e5fc17915cd3a`, timestamp `2026-10-12T13:11:54.893Z`,
  actor `chatgpt`, tag `project-kitchen`.
- An actual Codex `journal_continue` call independently retrieved that same
  kitchen note. The owner refreshed the native Kairos app and confirmed it visible.

Phone UI/tool execution and native visibility are operator reports, independently
matched to the persisted record; a raw iPhone tool trace was not captured. This
passes the invited owner's ChatGPT phone read/write/readback and native display
slice. It does not establish brand-new connector setup entirely on an iPhone or
an independent user's onboarding. Project continuation returns the newest record
within its requested project, not the newest note across every project.

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
5. Repeat the completed owner controls when changing the release: native display,
   another fresh retrieval, sign-out preserving approved access, and Disconnect
   refusing actual calls while preserving notes. The observed post-sign-out and
   post-Disconnect calls were made through the actual Codex Kairos connector.

The existing connected ChatGPT iPhone app passed the slice above. Brand-new phone
connector setup remains untested. This is a private development plugin, not a
published plugin or customer release.

Gemini remains a separate actual-provider acceptance gate. [Grok iPhone
read/write, fresh retrieval and native display subsequently passed](GROK_ACCEPTANCE.md).
Direct Codex tools passed in the observed task; a second user's Codex setup is not established.
Actor labels on entries remain client-supplied attribution, not vendor attestation.
