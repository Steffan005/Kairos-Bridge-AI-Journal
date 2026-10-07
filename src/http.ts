// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Kairos Journal: a portable, user-owned memory journal for AI apps, served over MCP.
 * Copyright (C) 2026  Steffan Douglas Haskins
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Additional terms under AGPLv3 section 7(b) apply: the notice
 * "Kairos Journal, created by Steffan Douglas Haskins" and the copyright
 * notice above must be preserved. See the NOTICE file for the full terms.
 */
import http from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Journal } from "./journal.js";
import { createJournalServer, type ServerOptions, SERVER_VERSION } from "./tools.js";
import { about } from "./about.js";

export interface HttpOptions extends ServerOptions {
  host: string;
  port: number;
  /** If set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Extra Host header values to accept (e.g. a tunnel hostname) when no token is set. */
  allowedHosts?: string[];
  log?: (msg: string) => void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

function hostOnly(hostHeader: string): string {
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0];
}

function tokenMatches(given: string, expected: string): boolean {
  // Compare fixed-length digests so the comparison time does not leak length.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Serve the journal over MCP Streamable HTTP at POST /mcp (stateless: each
 * request gets a fresh MCP server bound to the same journal file).
 */
export function startHttpServer(journal: Journal, opts: HttpOptions): Promise<http.Server> {
  const log = opts.log ?? ((m: string) => process.stderr.write(m + "\n"));
  const allowed = new Set([...LOOPBACK, ...(opts.allowedHosts ?? []).map((h) => h.toLowerCase())]);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://placeholder");
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      // License, copyright and where to get the source (AGPLv3 section 13). Contains no journal data.
      if (url.pathname === "/about" && (req.method === "GET" || req.method === "HEAD")) return send(res, 200, about(SERVER_VERSION));
      if (url.pathname !== "/mcp") return send(res, 404, { error: "not found; the MCP endpoint is /mcp (license and source: /about)" });

      if (opts.token) {
        const auth = req.headers.authorization ?? "";
        const m = /^Bearer\s+(.+)$/i.exec(auth);
        if (!m || !tokenMatches(m[1].trim(), opts.token)) {
          return send(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="kairos-journal"' });
        }
      } else {
        // No token: only accept requests addressed to this machine by a local
        // name (protects against DNS-rebinding attacks from web pages).
        const host = hostOnly(String(req.headers.host ?? "").toLowerCase());
        if (!allowed.has(host)) {
          return send(res, 403, { error: `host "${host}" not allowed; set a token or KAIROS_JOURNAL_ALLOWED_HOSTS` });
        }
        const origin = req.headers.origin;
        if (origin) {
          let oh = "";
          try {
            oh = new URL(origin).hostname.toLowerCase();
          } catch {
            /* invalid origin */
          }
          if (!allowed.has(oh) && !allowed.has(`[${oh}]`)) return send(res, 403, { error: "origin not allowed" });
        }
      }

      if (req.method !== "POST") {
        return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)" }, id: null }, { allow: "POST" });
      }

      const mcp = createJournalServer(journal, opts);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log(`[kairos-journal] HTTP error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
