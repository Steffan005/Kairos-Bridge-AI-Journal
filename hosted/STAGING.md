# Invited Kairos staging — prepared, not deployed

**Date:** October 10, 2026

**Owner:** ChatGPT / `gpt_codex`

**Purpose:** Give the first Claude iPhone OAuth check a stable HTTPS address and persistent journal. This is development staging, not the customer launch.

## Proposed service

[render.yaml](../render.yaml) proposes one Render Node web service on the `chatgpt/private-journal-service` branch, with one 1 GB persistent disk at `/var/data`. Automatic deployments are off. The paid compute plan is `0.5c-512mb`; confirm the actual recurring compute/disk price and approve it in Render before creating resources. No account, service, disk or billing commitment has been created by this file.

The built adapter listens on `0.0.0.0:$PORT` behind Render's HTTPS edge. The public port must never be exposed directly. Outside `/healthz`, it requires the exact canonical Host and `X-Forwarded-Proto: https`; it does not derive its issuer or redirect URL from an untrusted forwarded host. `/healthz` returns mode and a minimal process-liveness response, without notes or account data; it is not a database recovery check.

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

- Account creation requires the invitation and a development address ending in `.test`. There is no verified email or customer password recovery yet.
- Public dynamic client registration is disabled. The only permitted client metadata URL is `https://claude.ai/oauth/mcp-oauth-client-metadata`, with the library's SSRF-resistant fetching and metadata validation. Grok reported a successful public GET and its documented callback `https://claude.ai/api/mcp/auth_callback`; this is research evidence, not our hosted runtime result. Claude Code is not enabled. Verify document reachability from the deployed server, including its advertised grant types, then observe the actual iPhone client's authorization before claiming compatibility. Do not replace a failed metadata fetch with a silently pinned copy or broaden registration to force a pass.
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
