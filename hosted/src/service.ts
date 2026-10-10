// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import http from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { oauthProviderAuthServerMetadata, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { fromNodeHeaders } from "better-auth/node";
import { Journal, JournalError } from "../../src/journal.js";
import { createJournalServer } from "../../src/tools.js";
import { ATTRIBUTION, COPYRIGHT, LICENSE_SPDX, LICENSE_URL } from "../../src/about.js";
import { Accounts } from "./accounts.js";
import { AccessError, disconnect, makeAuth, migrateAuth, verifyGrant } from "./auth.js";
import { page } from "./pages.js";

export interface PreviewOptions { baseURL: string; directory: string; secret: string }
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
async function forward(res: http.ServerResponse, response: Response): Promise<void> {
  response.headers.forEach((value, name) => { if (name !== "set-cookie") res.setHeader(name, value); });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("set-cookie", cookies);
  res.writeHead(response.status); res.end(Buffer.from(await response.arrayBuffer()));
}

/** Deliberately restricted to loopback: this is not a public customer service yet. */
export async function createPreview(options: PreviewOptions) {
  const url = new URL(options.baseURL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.pathname !== "/" || url.search || url.username || url.password) {
    throw new Error("The synthetic preview requires a loopback HTTP base URL");
  }
  const baseURL = url.origin;
  const accounts = new Accounts(options.directory);
  const { auth, database } = makeAuth(baseURL, options.secret, accounts);
  await migrateAuth(auth, database);
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
      if (req.headers.host !== url.host) throw new AccessError(403, "Host is not allowed");
      const target = new URL(req.url ?? "/", baseURL);
      const path = target.pathname, method = req.method ?? "GET";
      if (req.headers.origin && req.headers.origin !== baseURL) throw new AccessError(403, "Origin is not allowed");
      if (path === "/healthz" && method === "GET") return json(res, 200, { ok: true, mode: "local-synthetic-preview" });
      if (path === "/about" && method === "GET") return json(res, 200, {
        attribution: ATTRIBUTION, copyright: COPYRIGHT, license: LICENSE_SPDX, license_url: LICENSE_URL,
        source: "https://github.com/Steffan005/Kairos-Bridge-AI-Journal/tree/chatgpt/private-journal-service",
        status: "Local synthetic preview; no public service or native iPhone app released",
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
        const bytes = ["GET", "HEAD"].includes(method) ? undefined : await body(req);
        if (path === "/api/auth/sign-up/email") {
          const input = JSON.parse(bytes!.toString());
          if (typeof input.email !== "string" || !input.email.toLowerCase().endsWith(".test")) throw new AccessError(400, "Use a synthetic email ending in .test for this preview");
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
          res.setHeader("www-authenticate", `Bearer resource_metadata="${baseURL}/.well-known/oauth-protected-resource/mcp", scope="journal:read"`);
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
          await owner(req);
          const client = await auth.api.getOAuthClientPublic({ headers, query: { client_id: target.searchParams.get("client_id") ?? "" } });
          consent = { client: client.client_name ?? "AI app", scopes: (target.searchParams.get("scope") ?? "").split(" ").filter(Boolean) };
        }
        if (path === "/journal") {
          try { await owner(req); } catch { res.writeHead(302, { location: "/sign-in" }); return res.end(); }
        }
        const output = page(path === "/sign-in" ? "sign-in" : path === "/consent" ? "consent" : "journal", consent);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": output.csp }); return res.end(output.html);
      }
      if (path.startsWith("/api/journal")) {
        const userId = await owner(req);
        if (!["GET", "HEAD"].includes(method) && req.headers.origin !== baseURL) throw new AccessError(403, "Open Kairos to change your journal");
        const bytes = ["GET", "HEAD"].includes(method) ? undefined : await body(req);
        return await accounts.locked(userId, async () => {
          if (path === "/api/journal/disconnect" && method === "POST") { await disconnect(auth, accounts, userId); return json(res, 200, { disconnected: true }); }
          if (path === "/api/journal" && method === "DELETE") { await disconnect(auth, accounts, userId); accounts.delete(userId); return json(res, 200, { deleted: true, backups: "No automatic backups in this preview" }); }
          if (path === "/api/journal/create" && method === "POST") { accounts.recreate(userId); return json(res, 201, { created: true }); }
          const account = accounts.get(userId);
          if (account.deleted) {
            if (path === "/api/journal" && method === "GET") return json(res, 200, { deleted: true, entries: [], connections: [] });
            throw new AccessError(410, "This journal was deleted");
          }
          const journal = Journal.open(accounts.path(userId));
          chmodSync(accounts.path(userId), 0o600);
          try {
            if (path === "/api/journal" && method === "GET") {
              const { adapter } = await auth.$context;
              const consents = await adapter.findMany<{ clientId: string; scopes: string[] }>({ model: "oauthConsent", where: [{ field: "userId", value: userId }] });
              const entries = [...journal.pinned(), ...journal.recent(50)].sort((a, b) => b.seq - a.seq).slice(0, 50);
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
    listen: () => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(url.port || 80), url.hostname, () => { server.off("error", reject); resolve(); }); }),
    close: async () => { if (server.listening) await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeIdleConnections(); }); database.close(); accounts.close(); },
  };
}
