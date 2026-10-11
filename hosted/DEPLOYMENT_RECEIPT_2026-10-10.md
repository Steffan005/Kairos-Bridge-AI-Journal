# Invited staging deployment receipt

Observed October 10, 2026, EDT. Some machine receipts have October 11 UTC timestamps.

Actor: ChatGPT / `gpt_codex` · scope: `kairos_bridge`

## Running service

- Origin: https://kairos-journal-staging.onrender.com
- First source: `84969ba1c565f3a7c21deac7afb5468abecdc863`.
- Current executable source: `d59e8392ed1cd0be570143242419c735078fee15`, live at 11:17:36 PM EDT. The earlier proxy correction a421bb0 went live at 9:50:40 PM EDT.
- Owner approved one $7 compute instance and a $0.25/month 1 GB disk: $7.25/month base before tax or additional usage.
- Blueprint auto-sync and service automatic deployment are off. No additional paid resources were created.
- Current root regression: 34 passed. Current hosted regression: 39 passed. [Exact-source CI](https://github.com/Steffan005/Kairos-Bridge-AI-Journal/actions/runs/38107574582) completed successfully. The original a421bb0 deployment passed 34 root and 21 hosted checks.

## Executed HTTPS acceptance

Two disposable invited accounts passed account isolation, owner-only export, read-only write refusal, secure-cookie, consent/PKCE, MCP write and fresh-client retrieval checks. A real Render restart preserved sessions, signing state and separate journals. Browser sign-out preserved approved AI access; refresh worked; owner Disconnect stopped that account's AI access while the second account remained accessible. Deleting the second disposable active journal stopped its access and disclosed retained host snapshots and account metadata.

After the proxy-address correction, the original saved note was still present. Client-supplied `cf-connecting-ip` was rejected before the app with HTTP 403. Forged `x-forwarded-for` and `x-real-ip` did not change auth's recorded client address; rotating those headers did not bypass the three-sign-in limit. Only one real source network was tested.

Latest public probes: health, source and both discovery documents returned 200; unauthenticated MCP returned 401 with its resource metadata challenge.

## Actual Claude browser connection

The existing signed-in Claude account added a custom connector using the staging `/mcp` address and Claude's published identity. No custom Authorization header or manually pasted API key was used. The existing synthetic journal account signed in, and consent displayed the exact Claude client identity, `claude.ai` return host, and read/write/offline permissions. The browser returned to Claude. Its interface displayed the connector as connected with all eight journal tools, each still requiring approval. An independent owner API read confirmed the same client and scopes.

The successful setup used Chrome on a Mac. Safari's consent page became blank during the earlier attempt. A later fresh Safari sign-in displayed the journal, and returning to the original tab visibly displayed consent, without changing source or security settings. The initial cause remains unresolved; no stale approval was resubmitted. A later Claude UI observation showed all eight tools set to Always allow; Codex did not make that change. Initial Needs approval and later Always allow are separate observations.

## Physical Claude iPhone acceptance

Steffan reported a new conversation in the Claude iPhone app retrieving both known kitchen notes and saving this exact third note: `Synthetic OAuth phone write-back: the countertop sample is white.` An independent authenticated owner API read confirmed ID `30b6e0034a8bbb6d`, timestamp `2026-10-11T02:17:40.406Z` (October 10, 10:17:40 PM EDT), actor `claude`, kind `note`, and tag `project-kitchen`. The seed IDs and contents also matched.

After the Kairos owner signed out in Safari, Steffan opened another fresh Claude iPhone conversation and reported retrieval of that exact new note and ID, without a write. The owner journal still contains three notes. The authorizing Chrome browser was also signed out; the phone call's exact ordering relative to that Chrome sign-out was not independently observed. This does not assert that every owner session was signed out.

Codex then signed into the existing synthetic owner account and clicked Disconnect all AI access in Chrome. The screen displayed no approved connections, and an independent owner API read confirmed zero connections with all three notes retained. In the next fresh Claude iPhone conversation, Steffan reported a request to reconnect and stopped there as instructed. This is a provider reconnection prompt, not a captured raw HTTP error or proof that previously copied text disappeared. Previously retrieved text can remain in Claude after journal access is revoked.

This proves the reported physical iPhone read/write and fresh-chat retrieval with independently checked journal evidence. Setup was assisted on a Mac; phone-only onboarding and a second tester remain unproven.

## Limits

This is invited development staging. It is not customer launch, a native iPhone app, or production-scale evidence. Customer account recovery, account deletion, retention policy and executed hosted backup/restore remain pending. Controlled offline recovery and refusal of old credentials have passed locally, as recorded below. A hash or signature does not establish freshness or factual truth. No passwords, invitation secrets, cookies, tokens, IP addresses, or signed OAuth query parameters are included in this receipt.


## Phone-created account and existing connector reconnection

Steffan subsequently followed the private test instructions entirely on his iPhone, created a distinct invited Kairos account and saved `Synthetic phone-only signup: the kitchen cabinet handles are brass.` Add connector reported “already added.” The first Claude chat had no active Kairos tools and did not read or write. Reconnecting the existing **Kairos journal test** from the phone then retrieved that new account's note and wrote `Synthetic phone-only AI write-back: the kitchen sink is stainless steel.`

Authenticated owner API reads independently confirmed exactly two records, newest first: `beceafa7937c91a6`, actor claude, `2026-10-11T02:59:50.817Z`; and `1d136df2b6f1b0ba`, actor you, `2026-10-11T02:52:34.776Z`. Both are project-kitchen notes. The new account has Claude's published client with read/write/offline access. The earlier account still has its three separate notes and zero approved AI connections. Reusing the provider configuration did not combine journals.

This proves phone signup and reconnection with independently checked mobile retrieval/write. It does not prove brand-new Claude connector creation, the install link's phone behavior, or setup by a second person. The provider label still says test. The exact reason Claude rejected duplicate creation was not inspected.

## Controlled recovery introduced before the guided update

Controlled offline recovery at `9dc559969a44e44d9fab4b9cfb8521e7f7a4dda7` passed 35 hosted and 34 desktop checks, locally and in [CI 38106850761](https://github.com/Steffan005/Kairos-Bridge-AI-Journal/actions/runs/38106850761). See [operator procedure](RECOVERY.md). It restores into a new directory, requires a separate operator-selected deletion witness and fresh authorization, and refuses old signing-key credentials. No hosted restore, automated deletion witness, encrypted off-host destination or customer account recovery was executed. The current deployed revision includes this implementation; deployment does not prove an executed hosted restore.


## Guided setup update — 11:17:36 PM EDT

Exact tested revision d59e8392ed1cd0be570143242419c735078fee15 was manually deployed to the existing instance and disk as Render deploy dep-db5fu7o473hc73b13h80. It adds a Connect Claude link, approved-access guidance and help for the already-added case. The link contains only the service address and display name, prepares the provider's form and does not grant access. Kairos approval is explicitly distinguished from enabling tools in the current Claude chat. A synthetic local browser fixture at width 390 had no horizontal overflow.

After the update, public health/source/discovery returned 200 and unauthenticated MCP returned 401 with its metadata challenge. Existing owner sessions still worked. Independent owner API checks confirmed the new phone account retained both notes and its Claude grant, while the earlier account retained all three notes and zero grants. A fresh physical phone MCP read after this update is requested and pending. No additional paid resource, customer signup permission or AI provider was added. The offline recovery code is included but was not run against the hosted disk.
