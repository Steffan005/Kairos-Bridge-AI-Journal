#!/usr/bin/env node
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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AddressInfo } from "node:net";
import { Journal } from "./journal.js";
import { createJournalServer, SERVER_VERSION } from "./tools.js";
import { startHttpServer, isLoopback } from "./http.js";
import { resolveDbPath, TOKEN_ENV, ALLOWED_HOSTS_ENV, ACTOR_ENV, DB_ENV } from "./config.js";
import { legalNoticeText, sourceInfo, SOURCE_URL_ENV } from "./about.js";

const HELP = `kairos-journal-mcp ${SERVER_VERSION}: your AI memory journal, served over MCP.

Usage:
  kairos-journal-mcp                     Run over stdio (for Claude Desktop, Cursor, etc.)
  kairos-journal-mcp --http [--port N]   Run over Streamable HTTP at http://127.0.0.1:N/mcp

Options:
  --db PATH        Journal file (default ~/.kairos-journal/journal.db, or $${DB_ENV})
  --actor NAME     Default author name for entries (or $${ACTOR_ENV}; else the client app's name)
  --http           Use Streamable HTTP instead of stdio
  --port N         HTTP port (default 8787; 0 picks a free port)
  --host H         HTTP bind address (default 127.0.0.1). Non-local addresses require a token.
  -h, --help       Show this help
  -v, --version    Show version

HTTP security:
  $${TOKEN_ENV}            If set, every HTTP request needs "Authorization: Bearer <token>".
  $${ALLOWED_HOSTS_ENV}    Comma-separated extra hostnames accepted when no token is set.
  $${SOURCE_URL_ENV}       Where network users can download this program's source (AGPL section 13).
`;

function parseArgs(argv: string[]) {
  const o: { http: boolean; port: number; host: string; db?: string; actor?: string; help: boolean; version: boolean } = {
    http: false,
    port: 8787,
    host: "127.0.0.1",
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--http") o.http = true;
    else if (a === "--port") o.port = Number(next());
    else if (a === "--host") o.host = next();
    else if (a === "--db") o.db = next();
    else if (a === "--actor") o.actor = next();
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-v" || a === "--version") o.version = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error("--port must be 0-65535");
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void process.stdout.write(HELP + "\n" + legalNoticeText(SERVER_VERSION) + "\n");
  if (args.version) return void process.stdout.write(SERVER_VERSION + "\n" + legalNoticeText(SERVER_VERSION) + "\n");

  const dbPath = resolveDbPath(args.db);
  const journal = Journal.open(dbPath);
  const log = (m: string) => process.stderr.write(`[kairos-journal] ${m}\n`); // never stdout: stdout is the MCP channel
  const shutdown = () => {
    try {
      journal.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (args.http) {
    const token = process.env[TOKEN_ENV]?.trim() || undefined;
    if (!isLoopback(args.host) && !token) {
      throw new Error(`Refusing to listen on ${args.host} without a token. Set ${TOKEN_ENV}, or keep the default 127.0.0.1.`);
    }
    const allowedHosts = (process.env[ALLOWED_HOSTS_ENV] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const srv = await startHttpServer(journal, { host: args.host, port: args.port, token, allowedHosts, defaultActor: args.actor, log });
    const port = (srv.address() as AddressInfo).port;
    log(`journal: ${dbPath}`);
    if (!sourceInfo().url) {
      log(`note: no public source URL configured. If you modified this program and others use it over the network, AGPL section 13 requires offering them the source: set ${SOURCE_URL_ENV}.`);
    }
    log(`listening on http://${args.host.includes(":") ? `[${args.host}]` : args.host}:${port}/mcp (${token ? "bearer token required" : "no token: local requests only"})`);
  } else {
    const server = createJournalServer(journal, { defaultActor: args.actor });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stdin.on("end", shutdown); // client went away
    log(`ready on stdio; journal: ${dbPath}`);
  }
}

main().catch((err) => {
  process.stderr.write(`[kairos-journal] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
