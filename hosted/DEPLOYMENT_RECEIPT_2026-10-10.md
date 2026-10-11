# Invited staging deployment receipt

Observed October 10, 2026, EDT. Some machine receipts have October 11 UTC timestamps.

Actor: ChatGPT / `gpt_codex` · scope: `kairos_bridge`

## Running service

- Origin: https://kairos-journal-staging.onrender.com
- First source: `84969ba1c565f3a7c21deac7afb5468abecdc863`.
- Current executable source: `a421bb0eceb8e65a623d9ae43e0ecdddf0da28e9`, live at 9:50:40 PM EDT.
- Owner approved one $7 compute instance and a $0.25/month 1 GB disk: $7.25/month base before tax or additional usage.
- Blueprint auto-sync and service automatic deployment are off. No additional paid resources were created.
- Root regression: 34 passed. Hosted regression: 21 passed. [Exact-source CI](https://github.com/Steffan005/Kairos-Bridge-AI-Journal/actions/runs/38102827556) completed successfully.

## Executed HTTPS acceptance

Two disposable invited accounts passed account isolation, owner-only export, read-only write refusal, secure-cookie, consent/PKCE, MCP write and fresh-client retrieval checks. A real Render restart preserved sessions, signing state and separate journals. Browser sign-out preserved approved AI access; refresh worked; owner Disconnect stopped that account's AI access while the second account remained accessible. Deleting the second disposable active journal stopped its access and disclosed retained host snapshots and account metadata.

After the proxy-address correction, the original saved note was still present. Client-supplied `cf-connecting-ip` was rejected before the app with HTTP 403. Forged `x-forwarded-for` and `x-real-ip` did not change auth's recorded client address; rotating those headers did not bypass the three-sign-in limit. Only one real source network was tested.

Latest public probes: health, source and both discovery documents returned 200; unauthenticated MCP returned 401 with its resource metadata challenge.

## Actual Claude browser connection

The existing signed-in Claude account added a custom connector using the staging `/mcp` address and Claude's published identity. No custom Authorization header or manually pasted API key was used. The existing synthetic journal account signed in, and consent displayed the exact Claude client identity, `claude.ai` return host, and read/write/offline permissions. The browser returned to Claude. Its interface displayed the connector as connected with all eight journal tools, each still requiring approval. An independent owner API read confirmed the same client and scopes.

The successful setup used Chrome on a Mac. Safari's consent page became blank during the earlier attempt. A later fresh Safari sign-in displayed the journal, and returning to the original tab visibly displayed consent, without changing source or security settings. The initial cause remains unresolved; no stale approval was resubmitted. A physical iPhone conversation and independent phone-only onboarding have not passed at this checkpoint.

## Limits

This is invited development staging. It is not customer launch, a native iPhone app, or production-scale evidence. Customer account recovery, account deletion, retention policy, consistent backup/restore, and restoration that cannot revive revoked access remain pending. A hash or signature does not establish freshness or factual truth. No passwords, invitation secrets, cookies, tokens, IP addresses, or signed OAuth query parameters are included in this receipt.
