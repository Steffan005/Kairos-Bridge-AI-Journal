# Invited Kairos staging — live development service

**Date:** October 10, 2026

**Owner:** ChatGPT / `gpt_codex`

**Purpose:** Give the first Claude iPhone OAuth check a stable HTTPS address and persistent journal. This is development staging, not the customer launch.

## Observed deployment, October 10, 2026

The invited service is live at **https://kairos-journal-staging.onrender.com**. Its first deployed source was `84969ba1c565f3a7c21deac7afb5468abecdc863`. The owner approved the final Render review of **$7.25/month base** ($7 compute plus a 1 GB disk at $0.25), before taxes or additional usage. Both Blueprint automatic sync and service automatic deployment are off. Read `/about` for the exact source of the running version.

Actual HTTPS acceptance passed for two disposable accounts: isolated journals, owner-only export, read-only AI access, live Claude client-metadata fetch, consent and PKCE token exchange, a new official MCP SDK client recovering a saved note, persistence across a Render service restart, browser sign-out preserving approved AI access, token refresh, immediate owner Disconnect, and deletion of a disposable active journal. The scripted test did not visit Claude's callback or use its mobile app. A subsequent actual Claude browser connection completed the sign-in path: Claude displayed the connector as connected and listed all eight tools; the owner journal recorded the published Claude client with read, write and offline scopes. A later fresh Safari sign-in and return to the original tab also visibly displayed the journal and consent, without a source or security-settings change. The initial blank page's cause remains unknown.

The physical Claude iPhone read/write check passed by operator report with an independent owner API confirmation of the new note's exact text, timestamp, actor, ID and tag. Another fresh iPhone chat retrieved that note after Safari owner sign-out, without adding a note. Owner Disconnect then removed the approved connection and retained all three notes; the next fresh phone conversation asked Steffan to reconnect, and he stopped there. The raw provider HTTP error was not captured. See [the deployment receipt](DEPLOYMENT_RECEIPT_2026-10-10.md). This was Mac-assisted connector setup, not phone-only onboarding or native-app acceptance.

The deployed correction is `a421bb0eceb8e65a623d9ae43e0ecdddf0da28e9`, live on October 10 at 9:50:40 PM EDT. The initial host's default forwarded-IP parser rejected Render's proxy chain. The Render entry point now explicitly selects the single Cloudflare address header, with 34 desktop and 21 hosted tests passing locally and in [CI 38102827556](https://github.com/Steffan005/Kairos-Bridge-AI-Journal/actions/runs/38102827556). Actual HTTPS acceptance confirmed the original saved note survived this update. Client-supplied `cf-connecting-ip` was rejected at the edge with HTTP 403; forged `x-forwarded-for` and `x-real-ip` did not change the address recorded by auth. A fourth sign-in received HTTP 429 despite rotating those headers. This was one real source network; independence between different source networks has not been experimentally demonstrated.

## Service configuration

[render.yaml](../render.yaml) defines the one Render Node web service on the `chatgpt/private-journal-service` branch, with one 1 GB persistent disk at `/var/data`. Automatic deployments are off. The paid compute plan is `0.5c-512mb`. The approved service and disk have been created; do not add resources or change their paid sizing without owner authorization.

The built adapter listens on `0.0.0.0:$PORT` behind Render's HTTPS edge. The public port must never be exposed directly. Outside `/healthz`, it requires the exact canonical Host and `X-Forwarded-Proto: https`; it does not derive its issuer or redirect URL from an untrusted forwarded host. `/healthz` returns mode and a minimal process-liveness response, without notes or account data; it is not a database recovery check.

When `RENDER=true`, the staging entry point configures Better Auth with only `cf-connecting-ip` for client-address tracking. Generic staging and local preview retain the library's conservative default. Missing/invalid headers retain the shared-bucket fallback; rate limiting, TLS, Host and Origin checks remain enabled. This trust depends on the origin being reachable through Render's edge, which [Render documents as passing through Cloudflare](https://render.com/articles/how-render-handles-ddos-attacks). [Cloudflare documents its single-address header](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip), and [Better Auth documents why an appending forwarded chain is unsafe to trust by default](https://better-auth.com/docs/concepts/rate-limit).

Use one writer/instance. Do not add replicas or run another process against these databases. Disk-backed deployment can briefly stop the service while changing builds. This is a pilot architecture, not a scale claim.

## Configuration outside Git

| Variable | Meaning |
| --- | --- |
| `KAIROS_STAGING_URL` | Optional canonical public HTTPS origin; otherwise `RENDER_EXTERNAL_URL` |
| `KAIROS_STAGING_DATA` | `/var/data/kairos`; absolute persistent directory |
| `KAIROS_STAGING_SECRET` | Cryptographically generated authentication secret; keep stable for these databases |
| `KAIROS_STAGING_INVITE` | Cryptographically generated private invitation secret, at least 32 characters |
| `KAIROS_SOURCE_REVISION` | Exact 40-character Git commit; otherwise `RENDER_GIT_COMMIT` |
| `PORT` | Platform listen port; default `10000` |

The Blueprint uses Render-generated secret values. Never copy those values into chat, commits, URLs, screenshots or receipts. A test-account invitation is entered only in the signup form body and stripped before the auth handler. A shared development invitation is not the final customer signup system. Rotating it does not revoke existing accounts or their approved connections.

Build: `npm ci --include=dev && npm --prefix hosted ci --include=dev && npm --prefix hosted run build`

Start: `npm --prefix hosted run start:staging`

## First connection boundary

The October 10 notes below describe the first Claude deployment. Current source also admits the ChatGPT, Grok, and Gemini clients recorded in their acceptance notes, and seeds the pre-registered Muse client described in [Muse preparation](MUSE_ACCEPTANCE.md). Seeding runs when the staging process starts. A manual deploy of `chatgpt/private-journal-service` is enough: no new Render environment variable and no hand-written database step. Automatic deployment remains off.

- Account creation requires the invitation and a development address ending in `.test`. There is no verified email or customer password recovery yet.
- Public dynamic client registration is disabled. At the October 10 deployment, the only permitted client metadata URL was `https://claude.ai/oauth/mcp-oauth-client-metadata`, with the library's SSRF-resistant fetching and metadata validation. The actual host fetched it and completed synthetic consent/PKCE acceptance using its declared callback `https://claude.ai/api/mcp/auth_callback`; the fixture never visited that callback. A later actual Claude browser sign-in returned to Claude and its interface showed the connector connected with five read tools and three write/pin tools. No request header or manually pasted API key was used. Initial tool settings were Needs approval; a later UI observation showed Always allow, without Codex changing them. Claude Code is not enabled. The physical iPhone read/write passed, but the completed browser setup used a Mac and does not prove phone-only onboarding. Do not replace a failed metadata fetch with a silently pinned copy or broaden registration to force a pass.
- Discovery requests `journal:read journal:write`; users may grant read-only access. The consent screen shows the account, client ID, redirect host, permissions and cloud-provider privacy sentence.
- Browser sign-out preserves approved AI access. Owner Disconnect invalidates all AI connections for that account. Per-provider disconnect is not implemented.
- `/about` offers source at the exact deployed revision. Preserve AGPL and NOTICE attribution.

## Deployment and phone acceptance, in order

1. Publish the reviewed commit and confirm both suites in CI. Confirm the chosen Render account, current price and resource creation before deployment.
2. Deploy that commit. Read `/healthz`, `/about`, both OAuth discovery documents and the unauthenticated `/mcp` challenge at the actual HTTPS address. Verify proxy headers, secure cookies and issuer/resource consistency. Do not relax Host/protocol checks to force a pass.
3. Create two invited development accounts. Write distinct notes; restart/redeploy the one service and independently confirm persistence and account isolation. Keep private personal records out. Approved non-sensitive Kairos build notes may be used for our own continuity, with consent.
4. In Claude, choose the published-identity sign-in path. Record the actual metadata URL, redirect, granted scopes and remaining setup steps without capturing authorization codes, tokens or passwords. Verify it from an iPhone browser, then a fresh Claude iPhone chat.
5. Retrieve a dated, attributed known note, save a new one and independently verify it. Sign out of Kairos: approved Claude access should remain. Disconnect all AI access: the next journal call must fail. Confirm the other account remains separate.
6. Export and verify the journal. Exercise deletion on disposable synthetic data only. Update the North Star receipt with exact source, observed time and limitations. Repeat with a second person before calling setup simple.

## Retention and recovery limits

Active journal deletion disconnects AI access and removes journal/WAL/SHM files. Account/control metadata remain. Downloads are owner-managed. Render disk snapshots can retain deleted data; the staging UI and deletion response disclose that. There is no approved customer retention schedule or account deletion flow.

Disk snapshots are not a demonstrated consistent multi-database SQLite backup. Before customer data, implement and restore-test consistent backups of auth, control and per-account journals, protect the authentication secret and signing state, and demonstrate that a restore cannot silently revive revoked access. No independent journal-head anchor or anti-rollback recovery service is implemented. Do not treat a successful signature or disk snapshot as proof of freshness or factual truth.

## Primary references checked October 10, 2026

- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render web services](https://render.com/docs/web-services)
- [Render persistent disks](https://render.com/docs/disks)
- [Claude connector authentication](https://claude.com/docs/connectors/building/authentication)
- [Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider)
