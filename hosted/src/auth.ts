// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
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
// Cursor / Grok Bot presents this metadata document URL. The document, not this
// allow-list, declares its callbacks. Admission is the exact URL only.
export const CURSOR_CONNECTOR_CLIENT_ID = "https://cursor.com/oauth/mcp-client.json";
// Meta Muse's connector form asks for a pre-issued client id. It does not present
// a client-metadata document, so this id must not be an HTTPS URL and must not
// be added to the metadata allow-list above.
export const MUSE_CONNECTOR_CLIENT_ID = "kairos-journal-meta-muse";
export const MUSE_CONNECTOR_REDIRECT_URI = "https://agent.meta.ai/api/hatch/oauth/callback";
export const isStagingClientAllowed = (clientId: string, baseURL?: string): boolean =>
  clientId === CLAUDE_CONNECTOR_CLIENT_ID || clientId === CHATGPT_CONNECTOR_CLIENT_ID || clientId === GROK_CONNECTOR_CLIENT_ID ||
  clientId === CURSOR_CONNECTOR_CLIENT_ID ||
  (baseURL !== undefined && isGeminiConnectorClientId(clientId, baseURL));

const MUSE_SCOPES = ["openid", "offline_access", "journal:read", "journal:write"] as const;
const MUSE_GRANTS = ["authorization_code", "refresh_token"] as const;
const stagingBaseURLs = new WeakMap<object, string>();

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
    // Account recovery has owner-bound, single-use records and atomic cleanup in
    // accountAccess.ts. Raw library routes would bypass those invariants.
    disabledPaths: ["/token", "/change-email", "/verify-email", "/send-verification-email",
      "/request-password-reset", "/reset-password", "/change-password"],
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
        // Cache only the pre-registered Muse client. CIMD clients stay uncached so
        // their metadata can refresh. The cache also refuses client-management edits.
        ...(options.staging ? { cachedTrustedClients: new Set([MUSE_CONNECTOR_CLIENT_ID]) } : {}),
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
  if (options.staging) stagingBaseURLs.set(auth, baseURL);
  return { auth, database };
}
export type KairosAuth = ReturnType<typeof makeAuth>["auth"];

/**
 * Selects a serialization lock, never authorizes a grant. Better Auth 1.7.7's
 * default storeTokens hasher is SHA-256 UTF-8 encoded as unpadded base64url.
 * makeAuth keeps that default and configures no token prefix or custom format.
 * The provider still consumes/verifies the token, client and PKCE inside the
 * lock. Keep this lookup aligned when upgrading the pinned provider.
 */
export function oauthGrantOwner(database: Database.Database, input: Record<string, string>): string | undefined {
  const grant = input.grant_type?.trim();
  const token = grant === "refresh_token" ? input.refresh_token : grant === "authorization_code" ? input.code : undefined;
  if (!token) return;
  const identifier = createHash("sha256").update(token).digest("base64url");
  if (grant === "refresh_token") {
    return (database.prepare('SELECT userId FROM "oauthRefreshToken" WHERE token = ?').get(identifier) as { userId: string } | undefined)?.userId;
  }
  const row = database.prepare('SELECT value FROM "verification" WHERE identifier = ?').get(identifier) as { value: string } | undefined;
  if (!row) return;
  try {
    const value = JSON.parse(row.value);
    if (value?.type === "authorization_code" && typeof value.userId === "string") return value.userId;
  } catch { /* The provider will reject malformed verification records. */ }
}

type MuseClientRow = {
  name?: string | null; redirectUris?: unknown; tokenEndpointAuthMethod?: string | null;
  grantTypes?: unknown; responseTypes?: unknown; applicationType?: string | null; scopes?: unknown;
  disabled?: boolean | number | null; skipConsent?: boolean | number | null; requirePKCE?: boolean | number | null;
  clientSecret?: string | null; clientDiscoveryId?: string | null; jwks?: string | null; jwksUri?: string | null;
  clientCredentialsScopes?: unknown;
};

const textList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
const sameList = (value: unknown, expected: readonly string[]): boolean => {
  const list = textList(value);
  return !!list && list.length === expected.length && list.every((item, index) => item === expected[index]);
};
const enabledFlag = (value: unknown): boolean => value === true || value === 1;
const blank = (value: unknown): boolean => value == null || value === "";

/**
 * Idempotently records the one Meta Muse public client for invited staging.
 * Better Auth 1.7.7 can cache a trusted client id, but it will not create that
 * row from a chosen id. Client ID Metadata Documents are the wrong seam: a
 * non-URL id with a discovery owner is ignored, and Muse does not publish a
 * metadata document. The existing schema version stays in place so an already
 * migrated staging database still receives the client on process start.
 * Dynamic registration and the metadata allow-list are unchanged.
 */
export async function ensureMuseConnectorClient(auth: KairosAuth, baseURL: string): Promise<void> {
  const { adapter } = await auth.$context;
  const resource = `${baseURL}/mcp`;
  // Plugin init can race the first migration and skip its resource insert. Re-apply
  // the configured MCP resource so this client's link has the same token policy.
  if (!await adapter.findOne({ model: "oauthResource", where: [{ field: "identifier", value: resource }] })) {
    const plugin = auth.options.plugins?.find(item => item.id === "oauth-provider") as { options?: { resources?: Array<string | { identifier: string; name?: string; accessTokenTtl?: number; allowedScopes?: string[]; disabled?: boolean }> } } | undefined;
    const configured = plugin?.options?.resources?.map(entry => typeof entry === "string" ? { identifier: entry } : entry).find(entry => entry.identifier === resource);
    if (!configured) throw new Error("The Kairos MCP resource is not configured");
    const now = new Date();
    try {
      await adapter.create({ model: "oauthResource", data: {
        identifier: resource, name: configured.name ?? resource, accessTokenTtl: configured.accessTokenTtl ?? null,
        allowedScopes: configured.allowedScopes ?? null, disabled: configured.disabled ?? false,
        dpopBoundAccessTokensRequired: false, policyVersion: 1, createdAt: now, updatedAt: now,
      } });
    } catch (error) {
      if (!/unique|duplicate/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  const canonical = {
    name: "Meta Muse", redirectUris: [MUSE_CONNECTOR_REDIRECT_URI], tokenEndpointAuthMethod: "none",
    grantTypes: [...MUSE_GRANTS], responseTypes: ["code"], applicationType: "web", scopes: [...MUSE_SCOPES],
    disabled: false, skipConsent: false, requirePKCE: true, clientSecret: null, clientDiscoveryId: null,
    jwks: null, jwksUri: null, clientCredentialsScopes: [] as string[],
  };
  const current = await adapter.findOne<MuseClientRow>({ model: "oauthClient", where: [{ field: "clientId", value: MUSE_CONNECTOR_CLIENT_ID }] });
  const aligned = !!current && current.name === canonical.name && sameList(current.redirectUris, canonical.redirectUris) &&
    current.tokenEndpointAuthMethod === canonical.tokenEndpointAuthMethod && sameList(current.grantTypes, canonical.grantTypes) &&
    sameList(current.responseTypes, canonical.responseTypes) && current.applicationType === canonical.applicationType &&
    sameList(current.scopes, canonical.scopes) && !enabledFlag(current.disabled) && !enabledFlag(current.skipConsent) &&
    enabledFlag(current.requirePKCE) && blank(current.clientSecret) && blank(current.clientDiscoveryId) &&
    blank(current.jwks) && blank(current.jwksUri) && sameList(current.clientCredentialsScopes ?? [], canonical.clientCredentialsScopes);
  if (!current) {
    const now = new Date();
    await adapter.create({ model: "oauthClient", data: { clientId: MUSE_CONNECTOR_CLIENT_ID, ...canonical, createdAt: now, updatedAt: now } });
  } else if (!aligned) {
    const updated = await adapter.update<MuseClientRow>({ model: "oauthClient", where: [{ field: "clientId", value: MUSE_CONNECTOR_CLIENT_ID }], update: { ...canonical, updatedAt: new Date() } });
    if (!updated) throw new Error("The pre-registered Muse client could not be restored");
  }
  const links = await adapter.findMany<{ resourceId: string }>({ model: "oauthClientResource", where: [{ field: "clientId", value: MUSE_CONNECTOR_CLIENT_ID }] });
  for (const link of links) {
    if (link.resourceId === resource) continue;
    await adapter.delete({ model: "oauthClientResource", where: [{ field: "clientId", value: MUSE_CONNECTOR_CLIENT_ID }, { field: "resourceId", value: link.resourceId }] });
  }
  if (!links.some(link => link.resourceId === resource)) {
    await adapter.create({ model: "oauthClientResource", data: { clientId: MUSE_CONNECTOR_CLIENT_ID, resourceId: resource, createdAt: new Date() } });
  }
}

export async function migrateAuth(auth: KairosAuth, database: Database.Database): Promise<void> {
  // Exact dependency versions own this schema. Run their migration once, not on every restart.
  // SQLite stores array columns as TEXT; re-introspection otherwise produces spurious type warnings.
  database.exec("CREATE TABLE IF NOT EXISTS kairos_auth_schema (version TEXT PRIMARY KEY)");
  const installed = database.prepare("SELECT version FROM kairos_auth_schema").get() as { version: string } | undefined;
  if (installed && installed.version !== "better-auth-1.7.7") throw new Error("An explicit, tested authentication database migration is required");
  if (!installed) {
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    database.prepare("INSERT INTO kairos_auth_schema(version) VALUES (?)").run("better-auth-1.7.7");
  }
  // Already-migrated staging databases still need the Muse client. This is not a schema version change.
  const baseURL = stagingBaseURLs.get(auth);
  if (baseURL) await ensureMuseConnectorClient(auth, baseURL);
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
