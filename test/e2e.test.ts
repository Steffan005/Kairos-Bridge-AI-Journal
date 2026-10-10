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
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Journal } from "../src/journal.js";
import { tempDbPath } from "../test-utils/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, "../src/server.js");
const EXPECTED_TOOLS = [
  "journal_about",
  "journal_continue",
  "journal_export",
  "journal_pin",
  "journal_search",
  "journal_unpin",
  "journal_verify",
  "journal_wake",
  "journal_write",
];

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

describe("MCP over stdio (end to end)", () => {
  test("lists tools, then write -> wake -> search -> verify", async () => {
    const db = tempDbPath();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, KAIROS_JOURNAL_DB: db } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e-test-client", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
      for (const t of tools) assert.ok((t.description ?? "").length > 60, `${t.name} needs a real description`);
      const wakeTool = tools.find((t) => t.name === "journal_wake")!;
      assert.equal(wakeTool.annotations?.readOnlyHint, true);
      assert.ok(client.getInstructions()?.includes("journal_wake"));

      const w = await client.callTool({
        name: "journal_write",
        arguments: { text: "Steffan wants every explanation simple enough for his grandma.", kind: "preference", tags: ["style"], pin: true },
      });
      assert.ok(!w.isError, textOf(w));
      const saved = JSON.parse(textOf(w));
      assert.equal(saved.saved, true);
      assert.equal(saved.entry.actor, "e2e-test-client", "defaults actor to the client's name");
      assert.equal(saved.entry.pinned, true);

      const w2 = await client.callTool({ name: "journal_write", arguments: { text: "Filed patent paperwork plan with Claude.", kind: "decision", actor: "claude", tags: ["project-patent"] } });
      assert.ok(!w2.isError);

      const secret = await client.callTool({ name: "journal_write", arguments: { text: "api key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ" } });
      assert.equal(secret.isError, true);
      assert.match(textOf(secret), /secret/);

      const bad = await client.callTool({ name: "journal_write", arguments: { text: "x", kind: "gossip" } });
      assert.equal(bad.isError, true, "schema validation rejects unknown kinds");

      const wake = await client.callTool({ name: "journal_wake", arguments: {} });
      const brief = textOf(wake);
      assert.match(brief, /grandma/);
      assert.match(brief, /Pinned/);
      assert.match(brief, /patent paperwork/);
      assert.match(brief, /2 entries total/);

      const s = await client.callTool({ name: "journal_search", arguments: { query: "patent" } });
      assert.equal(JSON.parse(textOf(s)).count, 1);

      const continuation = await client.callTool({ name: "journal_continue", arguments: { project: "Patent" } });
      assert.ok(!continuation.isError, textOf(continuation));
      assert.match(textOf(continuation), /Filed patent paperwork plan/);
      assert.match(textOf(continuation), /claude/);
      assert.match(textOf(continuation), /decision/);
      assert.doesNotMatch(textOf(continuation), /grandma/);

      const v = await client.callTool({ name: "journal_verify", arguments: {} });
      const report = JSON.parse(textOf(v));
      assert.equal(report.ok, true);
      assert.equal(report.checked, 2);
      // AGPL notices and source offer reach every client.
      const info = client.getServerVersion();
      assert.equal(info?.name, "kairos-journal");
      assert.equal(info?.title, "Kairos Journal, created by Steffan Douglas Haskins");
      assert.match(client.getInstructions() ?? "", /AGPL-3\.0-or-later/);
      assert.match(client.getInstructions() ?? "", /Copyright \(C\) 2026 Steffan Douglas Haskins/);
      const ab = await client.callTool({ name: "journal_about", arguments: {} });
      assert.ok(!ab.isError);
      const a = JSON.parse(textOf(ab));
      assert.equal(a.license.spdx, "AGPL-3.0-or-later");
      assert.equal(a.copyright, "Copyright (C) 2026 Steffan Douglas Haskins");
      assert.equal(a.attribution, "Kairos Journal, created by Steffan Douglas Haskins");
      assert.match(a.additionalTerms, /7\(b\)/);
      assert.match(a.patent, /63\/912,083/);
      assert.equal(a.name, "Kairos-Bridge AI Journal");
      assert.equal(a.source.url, "https://github.com/Steffan005/Kairos-Bridge-AI-Journal");
      assert.equal(a.source.configuredBy, "package.json");
      assert.equal(a.contact, "steffan.haskins@gmail.com");
      assert.equal(a.commercialLicensing.contact, "steffan.haskins@gmail.com");
      assert.match(a.commercialLicensing.summary, /commercial license/);
      assert.match(a.commercialLicensing.summary, /63\/912,083/);
      assert.match(client.getInstructions() ?? "", /Commercial licenses.*steffan\.haskins@gmail\.com/);
      const res = await client.readResource({ uri: "kairos-journal://about" });
      assert.equal(JSON.parse((res.contents[0] as any).text).license.spdx, "AGPL-3.0-or-later");
    } finally {
      await client.close();
    }
    // The data really is in the file on disk.
    const j = Journal.open(db);
    assert.equal(j.count(), 2);
    assert.equal(j.verify().ok, true);
    j.close();
  });
});

describe("License and source offer (AGPL section 13)", () => {
  test("a configured source URL is reported in journal_about, serverInfo and instructions", async () => {
    const url = "https://example.org/kairos-journal-mcp/source";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, KAIROS_JOURNAL_DB: tempDbPath(), KAIROS_JOURNAL_SOURCE_URL: url } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "about-client", version: "1.0.0" });
    await client.connect(transport);
    try {
      assert.equal(client.getServerVersion()?.websiteUrl, url);
      assert.ok(client.getInstructions()?.includes(url));
      const a = JSON.parse(textOf(await client.callTool({ name: "journal_about", arguments: {} })));
      assert.equal(a.source.url, url);
      assert.equal(a.source.configuredBy, "env");
    } finally {
      await client.close();
    }
  });
});

function startHttp(db: string, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER, "--http", "--port", "0"], {
      env: { ...process.env, KAIROS_JOURNAL_DB: db, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server did not start: " + buf)), 10_000);
    proc.stderr!.on("data", (d) => {
      buf += d.toString();
      const m = /listening on (http:\/\/\S+\/mcp)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, url: m[1] });
      }
    });
    proc.on("exit", (code) => reject(new Error(`server exited ${code}: ${buf}`)));
  });
}

describe("MCP over Streamable HTTP", () => {
  test("bearer token is enforced, and tools work with it", async () => {
    const db = tempDbPath();
    const { proc, url } = await startHttp(db, { KAIROS_JOURNAL_TOKEN: "test-token-123", KAIROS_JOURNAL_SOURCE_URL: "https://example.org/src" });
    try {
      const noAuth = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(noAuth.status, 401);
      const wrong = await fetch(url, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
      assert.equal(wrong.status, 401);

      // Remote users can always see the license and where to get the source (no journal data here).
      const aboutRes = await fetch(url.replace(/\/mcp$/, "/about"));
      assert.equal(aboutRes.status, 200);
      const about = await aboutRes.json();
      assert.equal(about.license.spdx, "AGPL-3.0-or-later");
      assert.equal(about.source.url, "https://example.org/src");
      assert.equal(about.commercialLicensing.contact, "steffan.haskins@gmail.com");
      assert.match(about.commercialLicensing.summary, /without the AGPL/);

      const client = new Client({ name: "http-client", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer test-token-123" } } }),
      );
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
      const w = await client.callTool({ name: "journal_write", arguments: { text: "Written over HTTP.", actor: "chatgpt" } });
      assert.ok(!w.isError, textOf(w));
      const wake = await client.callTool({ name: "journal_wake", arguments: {} });
      assert.match(textOf(wake), /Written over HTTP/);
      const v = await client.callTool({ name: "journal_verify", arguments: {} });
      assert.equal(JSON.parse(textOf(v)).ok, true);
      await client.close();

      // A fresh MCP client should recover only the requested project's notes.
      const writer = new Client({ name: "http-project-writer", version: "1.0.0" });
      await writer.connect(
        new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer test-token-123" } } }),
      );
      const kitchen = await writer.callTool({
        name: "journal_write",
        arguments: { text: "Synthetic kitchen note: blue tile selected.", tags: ["project-kitchen"] },
      });
      assert.ok(!kitchen.isError, textOf(kitchen));
      const garden = await writer.callTool({
        name: "journal_write",
        arguments: { text: "Synthetic garden note: tomato beds planned.", tags: ["project-garden"] },
      });
      assert.ok(!garden.isError, textOf(garden));
      await writer.close();

      const fresh = new Client({ name: "http-fresh-chat", version: "1.0.0" });
      await fresh.connect(
        new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer test-token-123" } } }),
      );
      const resumed = await fresh.callTool({ name: "journal_continue", arguments: { project: "kitchen" } });
      assert.ok(!resumed.isError, textOf(resumed));
      assert.match(textOf(resumed), /blue tile selected/);
      assert.doesNotMatch(textOf(resumed), /tomato beds planned/);
      await fresh.close();
    } finally {
      proc.kill();
    }
  });

  test("without a token, only local Host names are accepted", async () => {
    const db = tempDbPath();
    const { proc, url } = await startHttp(db);
    try {
      const client = new Client({ name: "local-client", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      assert.equal((await client.listTools()).tools.length, EXPECTED_TOOLS.length);
      await client.close();

      const port = new URL(url).port;
      // Simulate a DNS-rebinding request: right IP, foreign Host header.
      const evil = await new Promise<number>((resolve, reject) => {
        import("node:http").then(({ request }) => {
          const req = request(
            { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example.com", "content-type": "application/json" } },
            (res) => resolve(res.statusCode ?? 0),
          );
          req.on("error", reject);
          req.end("{}");
        });
      });
      assert.equal(evil, 403);
      const badOrigin = await fetch(url, { method: "POST", headers: { origin: "https://evil.example.com" }, body: "{}" });
      assert.equal(badOrigin.status, 403);
    } finally {
      proc.kill();
    }
  });

  test("refuses to listen on a public address without a token", async () => {
    const proc = spawn(process.execPath, [SERVER, "--http", "--host", "0.0.0.0", "--port", "0"], {
      env: { ...process.env, KAIROS_JOURNAL_DB: tempDbPath(), KAIROS_JOURNAL_TOKEN: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    proc.stderr!.on("data", (d) => (err += d.toString()));
    const code = await new Promise<number | null>((r) => proc.on("exit", r));
    assert.equal(code, 1);
    assert.match(err, /without a token/);
  });
});
