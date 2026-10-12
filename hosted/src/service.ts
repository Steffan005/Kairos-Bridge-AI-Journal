// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { oauthProviderAuthServerMetadata, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { fromNodeHeaders } from "better-auth/node";
import { Journal, JournalError, type OwnerSearchCursor, type OwnerSearchMode } from "../../src/journal.js";
import { createJournalServer } from "../../src/tools.js";
import { ATTRIBUTION, COPYRIGHT, LICENSE_SPDX, LICENSE_URL } from "../../src/about.js";
import { Accounts } from "./accounts.js";
import { AccessError, disconnect, makeAuth, migrateAuth, verifyGrant } from "./auth.js";
import { page } from "./pages.js";
import { acquireDataLease } from "./dataLease.js";
import { previewSettings, stagingSettings, type PreviewOptions, type StagingOptions, type ServiceSettings } from "./deployment.js";
export type { PreviewOptions, StagingOptions } from "./deployment.js";

const MAX_BODY = 64 * 1024;
async function body(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk); size += b.length;
    if (size > MAX_BODY) throw new AccessError(413, "Request is too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value));
}

// The wire cursor contains no query text. Its MAC binds continuation state to
// the authenticated owner without adding keys or mutable journal metadata.
function cursorSignature(payload: string, userId: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(JSON.stringify(["kairos-owner-search-v1", userId, payload])).digest();
}
function encodeCursor(cursor: OwnerSearchCursor, userId: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${cursorSignature(payload, userId, secret).toString("base64url")}`;
}
function decodeCursor(value: string | null, userId: string, secret: string): OwnerSearchCursor | undefined {
  if (value === null) return undefined;
  const invalid = () => new AccessError(400, "This page is no longer available. Refresh the journal and try again.");
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw invalid();
  const [payload, signature] = value.split(".");
  const supplied = Buffer.from(signature, "base64url"), expected = cursorSignature(payload, userId, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw invalid();
  try {
    const cursor: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw invalid();
    return cursor as OwnerSearchCursor;
  } catch { throw invalid(); }
}
async function forward(res: http.ServerResponse, response: Response): Promise<void> {
  response.headers.forEach((value, name) => { if (name !== "set-cookie") res.setHeader(name, value); });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("set-cookie", cookies);
  res.writeHead(response.status); res.end(Buffer.from(await response.arrayBuffer()));
}

/** Deliberately restricted to loopback: this is not a public customer service yet. */
export async function createPreview(options: PreviewOptions) {
  return createService(previewSettings(options));
}
/** Explicit, invitation-gated development staging behind an HTTPS-terminating proxy. */
export async function createStaging(options: StagingOptions) {
  return createService(stagingSettings(options));
}
async function createService(options: ServiceSettings) {
  const url = new URL(options.baseURL), baseURL = url.origin;
  const staging = options.kind === "hosted-invited-staging";
  const backupNotice = staging
    ? "Hosting disk snapshots may retain deleted data; invited development staging"
    : "No automatic backups in this preview";
  const releaseLease = acquireDataLease(options.directory);
  let accounts: Accounts;
  try { accounts = new Accounts(options.directory); }
  catch (error) { releaseLease(); throw error; }
  let initialized: ReturnType<typeof makeAuth>;
  try { initialized = makeAuth(baseURL, options.secret, accounts, { staging, trustedEdge: options.trustedEdge }); }
  catch (error) { accounts.close(); releaseLease(); throw error; }
  const { auth, database } = initialized;
  try {
    await migrateAuth(auth, database);
    // Plugin initialization may still query SQLite; finish it before returning a
    // service that callers are allowed to close immediately.
    await auth.$context;
  } catch (error) { database.close(); accounts.close(); releaseLease(); throw error; }
  const metadataHandler = oauthProviderAuthServerMetadata(auth);
  const owner = async (req: http.IncomingMessage) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) throw new AccessError(401, "Please sign in to Kairos");
    return session.user.id;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      const target = new URL(req.url ?? "/", baseURL);
      const path = target.pathname, method = req.method ?? "GET";
      // The platform's internal probe needs no journal/auth access or public Host header.
      if (path === "/healthz" && method === "GET") return json(res, 200, { ok: true, mode: options.kind });
      if (req.headers.host !== url.host) throw new AccessError(403, "Host is not allowed");
      // The public listener must sit behind the trusted edge, never expose this port directly.
      if (staging && req.headers["x-forwarded-proto"] !== "https") throw new AccessError(403, "Use the secure Kairos address");
      if (req.headers.origin && req.headers.origin !== baseURL) throw new AccessError(403, "Origin is not allowed");
      if (path === "/about" && method === "GET") return json(res, 200, {
        attribution: ATTRIBUTION, copyright: COPYRIGHT, license: LICENSE_SPDX, license_url: LICENSE_URL,
        source: options.sourceURL,
        status: staging ? "Invited development staging; no customer service or native iPhone app released" : "Local development preview; no public service or native iPhone app released",
      });
      if (["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(path) && method === "GET") return json(res, 200, {
        resource: `${baseURL}/mcp`, authorization_servers: [`${baseURL}/api/auth`],
        scopes_supported: ["journal:read", "journal:write"], bearer_methods_supported: ["header"], resource_name: "Kairos Journal",
      });
      const headers = fromNodeHeaders(req.headers);
      if (["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/auth"].includes(path) && method === "GET") {
        return forward(res, await metadataHandler(new Request(target, { headers })));
      }
      if (path.startsWith("/api/auth/")) {
        let bytes = ["GET", "HEAD"].includes(method) ? undefined : await body(req);
        if (path === "/api/auth/sign-up/email") {
          const input = JSON.parse(bytes!.toString());
          if (typeof input.email !== "string" || !input.email.toLowerCase().endsWith(".test")) throw new AccessError(400, "Use a synthetic email ending in .test for this preview");
          if (staging) {
            const supplied = Buffer.from(typeof input.invite_code === "string" ? input.invite_code : "");
            const expected = Buffer.from(options.inviteCode!);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AccessError(403, "A staging invitation is required to create a test account");
            delete input.invite_code; // Never forward/store the invitation in account metadata.
            bytes = Buffer.from(JSON.stringify(input));
          }
        }
        // Removing/changing a library consent also invalidates already-issued JWTs.
        const consentMutation = ["/api/auth/oauth2/delete-consent", "/api/auth/oauth2/update-consent"].includes(path);
        const sessionOwner = consentMutation ? await owner(req) : undefined;
        const response = await auth.handler(new Request(target, { method, headers, ...(bytes ? { body: new Uint8Array(bytes) } : {}) }));
        if (response.ok && sessionOwner) await accounts.locked(sessionOwner, () => disconnect(auth, accounts, sessionOwner));
        return forward(res, response);
      }
      if (path === "/mcp") {
        let grant;
        try { grant = await verifyGrant(auth, accounts, baseURL, req.headers.authorization); }
        catch (e) {
          res.setHeader("www-authenticate", `Bearer resource_metadata="${baseURL}/.well-known/oauth-protected-resource/mcp", scope="journal:read journal:write"${req.headers.authorization ? ', error="invalid_token"' : ''}`);
          throw e;
        }
        if (method !== "POST") { res.setHeader("allow", "POST"); throw new AccessError(405, "Use POST for this stateless MCP endpoint"); }
        const input = JSON.parse((await body(req)).toString());
        return await accounts.locked(grant.userId, async () => {
          // Check again after waiting/body upload: disconnect must take effect on the next action.
          const current = await verifyGrant(auth, accounts, baseURL, req.headers.authorization);
          const journal = Journal.open(accounts.path(current.userId));
          chmodSync(accounts.path(current.userId), 0o600);
          const mcp = createJournalServer(journal, { storage: "hosted", readOnly: current.readOnly, defaultActor: "assistant" });
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          try { await mcp.connect(transport); await transport.handleRequest(req, res, input); }
          finally { await transport.close(); await mcp.close(); journal.close(); }
        });
      }
      if (path === "/" || path === "/sign-in" || path === "/journal" || path === "/consent") {
        if (method !== "GET") throw new AccessError(405, "Use GET");
        if (path === "/") { res.writeHead(302, { location: "/journal" }); return res.end(); }
        let consent;
        if (path === "/consent") {
          const context = await auth.$context;
          if (!await verifyOAuthQueryParams(target.search.slice(1), context.secret)) throw new AccessError(400, "This connection request has expired or changed. Start again from your AI app.");
          const session = await auth.api.getSession({ headers });
          if (!session) throw new AccessError(401, "Please sign in to Kairos");
          const client = await auth.api.getOAuthClientPublic({ headers, query: { client_id: target.searchParams.get("client_id") ?? "" } });
          const clientId = target.searchParams.get("client_id") ?? "";
          consent = { client: client.client_name ?? "AI app", clientId, email: session.user.email,
            redirectHost: new URL(target.searchParams.get("redirect_uri")!).hostname,
            scopes: (target.searchParams.get("scope") ?? "").split(" ").filter(Boolean) };
        }
        if (path === "/journal") {
          try { await owner(req); } catch { res.writeHead(302, { location: "/sign-in" }); return res.end(); }
        }
        const output = page(path === "/sign-in" ? "sign-in" : path === "/consent" ? "consent" : "journal", consent, { staging });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": output.csp }); return res.end(output.html);
      }
      if (path.startsWith("/api/journal")) {
        const userId = await owner(req);
        if (!["GET", "HEAD"].includes(method) && req.headers.origin !== baseURL) throw new AccessError(403, "Open Kairos to change your journal");
        const bytes = ["GET", "HEAD"].includes(method) ? undefined : await body(req);
        return await accounts.locked(userId, async () => {
          if (path === "/api/journal/disconnect" && method === "POST") { await disconnect(auth, accounts, userId); return json(res, 200, { disconnected: true }); }
          if (path === "/api/journal" && method === "DELETE") { await disconnect(auth, accounts, userId); accounts.delete(userId); return json(res, 200, { deleted: true, backups: backupNotice }); }
          if (path === "/api/journal/create" && method === "POST") { accounts.recreate(userId); return json(res, 201, { created: true }); }
          const account = accounts.get(userId);
          if (account.deleted) {
            if (path === "/api/journal" && method === "GET") return json(res, 200, { deleted: true, entries: [], connections: [] });
            throw new AccessError(410, "This journal was deleted");
          }
          const journal = Journal.open(accounts.path(userId));
          chmodSync(accounts.path(userId), 0o600);
          try {
            if (path === "/api/journal/search" && method === "GET") {
              const suppliedLimit = target.searchParams.get("limit");
              if (suppliedLimit !== null && !/^[0-9]{1,2}$/.test(suppliedLimit)) throw new AccessError(400, "Page size must be between 1 and 50");
              const result = journal.searchPage(target.searchParams.get("q") ?? "", {
                mode: (target.searchParams.get("mode") ?? "words") as OwnerSearchMode,
                project: target.searchParams.get("project") ?? undefined,
                author: target.searchParams.get("author") ?? undefined,
                limit: suppliedLimit === null ? 15 : Number(suppliedLimit),
                cursor: decodeCursor(target.searchParams.get("cursor"), userId, options.secret),
              });
              const { next, ...output } = result;
              return json(res, 200, { ...output, next_cursor: next ? encodeCursor(next, userId, options.secret) : null });
            }
            if (path === "/api/journal" && method === "GET") {
              const { adapter } = await auth.$context;
              const consents = await adapter.findMany<{ clientId: string; scopes: string[] }>({ model: "oauthConsent", where: [{ field: "userId", value: userId }] });
              const entries = [...new Map([...journal.pinned(), ...journal.recent(50)].map(entry => [entry.id, entry])).values()].sort((a, b) => b.seq - a.seq).slice(0, 50);
              return json(res, 200, { deleted: false, entries, connections: consents.map(c => ({ clientId: c.clientId, scopes: c.scopes })), count: journal.count() });
            }
            if (path === "/api/journal/notes" && method === "POST") {
              const input = JSON.parse(bytes!.toString());
              return json(res, 201, journal.write({ text: input.text, tags: input.tags, actor: "You", kind: "note" }));
            }
            if (path === "/api/journal/export" && method === "GET") {
              const tmp = mkdtempSync(join(accounts.directory, "export-"));
              try {
                const out = join(tmp, "journal.json"); journal.exportTo(out, "json");
                res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="kairos-journal.json"' });
                return res.end(readFileSync(out));
              } finally { rmSync(tmp, { recursive: true, force: true }); }
            }
            throw new AccessError(404, "This journal action is not available");
          } finally { journal.close(); }
        });
      }
      throw new AccessError(404, "Page not found");
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof AccessError) return json(res, e.status, { error: e.message });
      if (e instanceof SyntaxError) return json(res, 400, { error: "Invalid JSON" });
      if (e instanceof JournalError) return json(res, 400, { error: e.message });
      // Never send database paths, token details, or stack traces to the client.
      json(res, 500, { error: "Kairos could not finish that request. Please try again." });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    server, auth, accounts,
    listen: () => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.listenPort, options.listenHost, () => { server.off("error", reject); resolve(); }); }),
    close: async () => { if (server.listening) await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeIdleConnections(); }); database.close(); accounts.close(); releaseLease(); },
  };
}
