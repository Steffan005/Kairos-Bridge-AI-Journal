// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
// Local developer utility: use approved project notes, never credentials or private personal records.
// node examples/project-checkpoint.mjs JOURNAL.db PACKET.json RECEIPT.json
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [database, packetFile, receiptFile] = process.argv.slice(2);
if (!database || !packetFile || !receiptFile) throw Error("Supply the local journal, approved packet and receipt paths");
const packet = JSON.parse(readFileSync(packetFile, "utf8"));
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packet.project) || !Array.isArray(packet.notes) || !packet.notes.length) throw Error("Packet requires a project slug and notes");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/src/server.js"), "--db", resolve(database), "--actor", "ChatGPT"], stderr: "pipe" });
  const client = new Client({ name: "ChatGPT", version: "checkpoint-1" });
  await client.connect(transport); return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw Error(JSON.stringify(result.content));
  return result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}
let client = await connect();
const writes = [];
try {
  for (const note of packet.notes) {
    if (typeof note.text !== "string" || !note.text.trim() || note.text.length > 1000) throw Error("Each checkpoint note requires 1-1000 characters so search can compare the complete text");
    const existing = JSON.parse(await call(client, "journal_search", { query: note.text.slice(0, 180), limit: 20 }));
    const match = existing.results?.find(e => e.text === note.text && e.tags.includes("project-" + packet.project));
    if (match) { writes.push({ saved: false, existing: match }); continue; }
    writes.push(JSON.parse(await call(client, "journal_write", { text: note.text, kind: note.kind ?? "summary", tags: ["project-" + packet.project, ...(note.tags ?? [])], actor: "ChatGPT", pin: note.pin ?? false })));
  }
} finally { await client.close(); }
// A new client launches a new server process; the earlier process's memory is gone.
client = await connect();
let continuation, verification;
try {
  continuation = await call(client, "journal_continue", { project: packet.project, max_chars: 12000 });
  verification = JSON.parse(await call(client, "journal_verify"));
} finally { await client.close(); }
const receipt = { observed_at: new Date().toISOString(), actor_id: "gpt_codex", journal_actor: "chatgpt", lane: "self", scope: "kairos_bridge", recipient: "gpt_codex", kind: "checkpoint", parent_cursor: packet.parent_cursor ?? null,
  project: packet.project, transport: "local MCP stdio", fresh_server_process: true, writes, continuation, verification,
  limits: "Proves stored notes are retrieved by a fresh local process. Does not prove a model context reset, physical iPhone setup or remote-provider OAuth." };
writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ receipt: resolve(receiptFile), saved: writes.filter(w => w.saved).length, verification, continuation }, null, 2));
