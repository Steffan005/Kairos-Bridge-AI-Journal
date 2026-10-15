// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { oauthProvider } from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { Accounts } from "./accounts.js";
import { geminiMetadataFetcher, isGeminiConnectorClientId } from "./gemini.js";
export { isGeminiConnectorClientId } from "./gemini.js";

// Exact consumer connector identities. Claude Code and callback-specific OpenAI
// identities are distinct clients and are not enabled by this staging allow-list.
export const CLAUDE_CONNECTOR_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
export const CHATGPT_CONNECTOR_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
export const GROK_CONNECTOR_CLIENT_ID = "https://grok.com/oauth/mcp-client.json";
export const isStagingClientAllowed = (clientId: string, baseURL?: string): boolean =>
  clientId === CLAUDE_CONNECTOR_CLIENT_ID || clientId === CHATGPT_CONNECTOR_CLIENT_ID || clientId === GROK_CONNECTOR_CLIENT_ID ||
  (baseURL !== undefined && isGeminiConnectorClientId(clientId, baseURL));

export function makeAuth(baseURL: string, secret: string, accounts: Accounts, options: {
  staging?: boolean; trustedEdge?: "render-cloudflare";
  /** In-process fixture transport only; no service route or environment setting exposes this override. */
  metadataFetcher?: typeof fetchClientMetadataResource;
  /** Track library background work so maintenance can wait for its completion. */
  backgroundTaskHandler?: (promise: Promise<unknown>) => void;
} = {}) {
  if (secret.length < 32) throw new Error("Provide a random authentication secret of at least 32 characters");
  const database = new Database(join(accounts.directory, "auth.db"));
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  chmodSync(join(accounts.directory, "auth.db"), 0o600);
  const auth = betterAuth({
    appName: "Kairos Journal preview", baseURL, secret, database,
    trustedOrigins: [baseURL],
    disabledPaths: ["/token"], // Never expose a generic account JWT as a journal credential.
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    session: { cookieCache: { enabled: false } },
    // Render's public edge routes through Cloudflare. Use its single overwritten
    // address, never an untrusted leftmost X-Forwarded-For value. This option is
    // selected only by the Render staging entry point; generic/local hosts keep
    // Better Auth's conservative defaults. Missing/invalid headers fail to the
    // library's shared bucket; rate limiting is never disabled.
    advanced: {
      ...(options.trustedEdge === "render-cloudflare" ? { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } } : {}),
      ...(options.backgroundTaskHandler ? { backgroundTasks: { handler: options.backgroundTaskHandler } } : {}),
    },
    plugins: [
      jwt({ jwt: { issuer: `${baseURL}/api/auth` } }),
      oauthProvider({
        loginPage: "/sign-in", consentPage: "/consent",
        scopes: ["openid", "offline_access", "journal:read", "journal:write"],
        grantTypes: ["authorization_code", "refresh_token"],
        refreshTokenReuseInterval: 30,
        resources: [{ identifier: `${baseURL}/mcp`, allowedScopes: ["openid", "journal:read", "journal:write", "offline_access"], accessTokenTtl: 900 }],
        clientRegistrationDefaultResources: [`${baseURL}/mcp`],
        allowDynamicClientRegistration: !options.staging,
        allowUnauthenticatedClientRegistration: !options.staging,
        clientPrivileges: () => false, resourcePrivileges: () => false,
        customAccessTokenClaims: ({ user }) => ({ kairos_epoch: user ? accounts.get(user.id).epoch : -1 }),
      }),
      cimd({ fetchClientMetadataResource: geminiMetadataFetcher(baseURL, options.metadataFetcher ?? fetchClientMetadataResource), metadataProfile: "mcp-2026-07-28",
        // Official client documents, not arbitrary same-host URLs. The runtime
        // fetcher pins approved public DNS addresses and refuses redirects; the
        // library validates metadata, exact callbacks and signed client assertions.
        isMetadataDocumentUrlAllowed: clientId => !options.staging || isStagingClientAllowed(clientId, baseURL),
      }),
    ],
  });
  return { auth, database };
}
export type KairosAuth = ReturnType<typeof makeAuth>["auth"];

export async function migrateAuth(auth: KairosAuth, database: Database.Database): Promise<void> {
  // Exact dependency versions own this schema. Run their migration once, not on every restart.
  // SQLite stores array columns as TEXT; re-introspection otherwise produces spurious type warnings.
  database.exec("CREATE TABLE IF NOT EXISTS kairos_auth_schema (version TEXT PRIMARY KEY)");
  const installed = database.prepare("SELECT version FROM kairos_auth_schema").get() as { version: string } | undefined;
  if (installed?.version === "better-auth-1.7.7") return;
  if (installed) throw new Error("An explicit, tested authentication database migration is required");
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  database.prepare("INSERT INTO kairos_auth_schema(version) VALUES (?)").run("better-auth-1.7.7");
}

export class AccessError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export type Grant = { userId: string; epoch: number; readOnly: boolean; clientId: string };

/** Signature, issuer/audience/expiry, active account/client/consent, and live generation all matter. */
export async function verifyGrant(auth: KairosAuth, accounts: Accounts, baseURL: string, authorization?: string): Promise<Grant> {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
  if (!match) throw new AccessError(401, "Connect Kairos and sign in to access your journal");
  let payload;
  try {
    const jwks = await auth.api.getJwks();
    ({ payload } = await jwtVerify(match[1], createLocalJWKSet(jwks), {
      issuer: `${baseURL}/api/auth`, audience: `${baseURL}/mcp`,
      requiredClaims: ["exp", "iat", "sub", "azp", "scope", "kairos_epoch"],
    }));
  } catch { throw new AccessError(401, "This connection is invalid or expired; reconnect Kairos"); }
  const { sub, azp, scope, kairos_epoch: epoch, cnf } = payload;
  if (typeof sub !== "string" || typeof azp !== "string" || typeof scope !== "string" || !Number.isSafeInteger(epoch) || cnf) {
    throw new AccessError(401, "Unsupported journal authorization");
  }
  const scopes = scope.split(" ");
  if (!scopes.includes("journal:read")) throw new AccessError(403, "Journal read permission is required");
  const { adapter } = await auth.$context;
  const [user, client, consent] = await Promise.all([
    adapter.findOne({ model: "user", where: [{ field: "id", value: sub }] }),
    adapter.findOne<{ disabled: boolean }>({ model: "oauthClient", where: [{ field: "clientId", value: azp }] }),
    adapter.findOne<{ scopes: string[] }>({ model: "oauthConsent", where: [{ field: "userId", value: sub }, { field: "clientId", value: azp }] }),
  ]);
  const account = accounts.get(sub);
  // Browser sign-out does not revoke an approved AI connection. Owner Disconnect does.
  if (!user || !client || client.disabled || !consent || !scopes.every(s => consent.scopes.includes(s)) || account.deleted || account.epoch !== epoch) {
    throw new AccessError(401, "This connection was disconnected; connect again to continue");
  }
  return { userId: sub, epoch: epoch as number, readOnly: !scopes.includes("journal:write"), clientId: azp };
}

/** Owner-requested disconnect invalidates JWTs immediately and removes future refresh access. */
export async function disconnect(auth: KairosAuth, accounts: Accounts, userId: string): Promise<void> {
  accounts.invalidate(userId);
  const { adapter } = await auth.$context;
  for (const model of ["oauthConsent", "oauthAccessToken", "oauthRefreshToken"]) {
    await adapter.deleteMany({ model, where: [{ field: "userId", value: userId }] });
  }
  // Also remove pending codes/consent prompts; a pre-disconnect code must not mint new access.
  const ids: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const pending = await adapter.findMany<{ id: string; value: string }>({ model: "verification", limit: 100, offset, sortBy: { field: "id", direction: "asc" } });
    for (const record of pending) {
      let value;
      try { value = JSON.parse(record.value); } catch { continue; }
      if (value.userId === userId && ["authorization_code", "consent"].includes(value.type)) ids.push(record.id);
    }
    if (pending.length < 100) break;
  }
  for (const id of ids) await adapter.delete({ model: "verification", where: [{ field: "id", value: id }] });
}
