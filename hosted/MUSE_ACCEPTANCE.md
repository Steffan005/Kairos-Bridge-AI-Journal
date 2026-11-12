# Meta Muse connector preparation

Muse's custom-connector form asks the owner to paste a pre-issued client ID. It does not present a client-metadata document URL the way Claude, ChatGPT, and Grok do, and its identity is not Google's host-bound metadata shape. Public dynamic registration therefore stays disabled. This source does not add a metadata URL to the fetch allow-list.

## Pre-registered client

Invited staging records exactly one public client at process start:

| Field | Value |
| --- | --- |
| Client ID to paste | `kairos-journal-meta-muse` |
| Client name | Meta Muse |
| Redirect URI | `https://agent.meta.ai/api/hatch/oauth/callback` |
| Token authentication | `none` (public client, no secret) |
| Grants | authorization code and refresh token |
| Response type | `code` |
| PKCE | required; only S256 |
| Scopes the server already allows | `openid`, `offline_access`, `journal:read`, `journal:write` |
| Scope Muse asked to use | `journal:read journal:write offline_access` |

The consent page, scope set, and revocation behavior are unchanged. The first approval still shows the signed-in account, this client ID, the `agent.meta.ai` return host, and the requested permissions. A different redirect, a missing or non-S256 PKCE challenge, or a scope outside the existing set does not receive an authorization code. Browser sign-out still preserves an approved connection. Owner Disconnect still revokes it.

There is no client secret. Do not invent one, store one, or paste one into Muse.

## Why this is not another metadata client

Better Auth 1.7.7 can cache a trusted client ID and refuse later edits through its client-management endpoints. It does not create that row from a chosen ID. Its Client ID Metadata Document path stores a discovery owner and then resolves only IDs that discovery accepts. A non-URL ID with that owner is ignored, and Muse has no document to fetch.

The staging process therefore writes this one client into the existing authentication database after the current Better Auth schema is ready. The schema version stays `better-auth-1.7.7`, so the database already running on the staging disk does not need a new migration. Each staging start checks this client and restores its redirect, public-client authentication, PKCE requirement, grants, and consent requirement from source when they differ. Other clients are left alone. Local preview still uses dynamic registration and does not receive this client.

Journal attribution does not treat this client as Claude, ChatGPT, Grok, or Gemini. A Muse write keeps the authenticated client ID and a null provider. Actor labels remain whatever the client supplies.

## What to enter in Muse

MCP address: `https://kairos-journal-staging.onrender.com/mcp`

If the form asks for the OAuth endpoints, use the addresses this service advertises:

- Authorize: `https://kairos-journal-staging.onrender.com/api/auth/oauth2/authorize`
- Token: `https://kairos-journal-staging.onrender.com/api/auth/oauth2/token`

The issuer is `https://kairos-journal-staging.onrender.com/api/auth`. No registration endpoint is offered.

## Deploy

Render deploys the service `kairos-journal-staging` from branch `chatgpt/private-journal-service`. Automatic deployment is off. A manual deploy of the commit that contains this client is enough. No new environment variable is required, and nobody needs to edit the SQLite database. The process creates or restores the client on the existing disk when it starts. Keep the current authentication secret, invitation, and single instance.

This document does not record a live Muse conversation, a phone approval, or a journal read/write through Muse. A local fixture checked the protocol only. It did not call Meta.

## Risks

- The client ID is public. Anyone can start the flow. Only the exact Meta callback can receive the code, PKCE is required to exchange it, and the owner still has to approve the Kairos consent page.
- A direct edit of `auth.db` while the process is running does not change the copy this process already loaded. The next start puts the source-defined client back, including its one redirect. Do not rely on a database edit to widen it.
- If Meta changes that callback, this service will refuse the new one until the source is updated and redeployed.
- Staging remains one process on one disk. A second process against the same database is still unsupported.
- No production customer signup, account deletion, or per-provider disconnect is added here.
