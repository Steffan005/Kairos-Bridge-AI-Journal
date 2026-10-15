// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function text(result: any): string { return result.content.map((c: any) => c.text ?? "").join("\n"); }

test("fresh MCP process resumes the selected project with explicit corrections, resolutions and addressed handoffs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kairos-continue-e2e-"));
  const db = join(dir, "journal.db");
  const connect = async () => {
    const client = new Client({ name: "continuation-fixture", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [new URL("../src/server.js", import.meta.url).pathname, "--db", db], stderr: "pipe" }));
    return client;
  };
  let client = await connect();
  const write = async (input: Record<string, unknown>) => {
    const result = await client.callTool({ name: "journal_write", arguments: input });
    assert.ok(!result.isError, text(result)); return JSON.parse(text(result)).entry;
  };
  try {
    const old = await write({ text: "The launch uses the old banner.", kind: "decision", tags: ["project-launch"],
      actor: "claude", continuity: { role: "decision", actor_id: "claude_summers" } });
    const current = await write({ text: "The owner selected the gold bridge.", kind: "decision", tags: ["project-launch"],
      actor: "chatgpt", continuity: { role: "decision", actor_id: "gpt_codex", supersedes: [old.id] } });
    const question = await write({ text: "Has the invitation arrived?", tags: ["project-launch"], continuity: { role: "question" } });
    await write({ text: "The owner confirmed the invitation arrived.", tags: ["project-launch"], continuity: { role: "update", resolves: [question.id] } });
    const handoff = await write({ text: "Check the source links before the launch briefing.", tags: ["project-launch"], actor: "claude",
      continuity: { role: "handoff", recipient: "gpt_codex", actor_id: "claude_summers" } });
    await write({ text: "Grok-only handoff: prepare the community wording.", tags: ["project-launch"], continuity: { role: "handoff", recipient: "grok_ops" } });
    await write({ text: "Unrelated garden project source links.", tags: ["project-garden"] });
    const forged = await write({ text: "Local note with claimed connector origin.", tags: ["project-launch"], actor: "gemini",
      write_origin: { version: 1, channel: "oauth", client_id: "https://grok.com/oauth/mcp-client.json", provider: "grok", received_at: new Date().toISOString() } });
    assert.equal(forged.actor, "gemini");
    assert.equal(forged.write_origin, undefined, "a local caller cannot create authenticated delivery evidence");
    await client.close();
    client = await connect();
    const briefing = await client.callTool({ name: "journal_continue", arguments: { project: "launch", actor: "ChatGPT", max_chars: 12000 } });
    assert.ok(!briefing.isError, text(briefing));
    const body = text(briefing);
    assert.match(body, /owner selected the gold bridge/);
    assert.ok(body.includes(current.id));
    assert.ok(body.includes(handoff.id));
    assert.doesNotMatch(body, /launch uses the old banner|Has the invitation arrived\?|Grok-only handoff|Unrelated garden/);
    const wake = await client.callTool({ name: "journal_wake", arguments: { project: "launch", actor: "gpt_codex", max_chars: 12000 } });
    assert.equal(text(wake), body, "scoped wake and Continue use one retrieval contract");
    const history = await client.callTool({ name: "journal_continue", arguments: { project: "launch", view: "history", max_chars: 12000 } });
    assert.match(text(history), /launch uses the old banner/);
    assert.match(text(history), /Has the invitation arrived/);
    const search = await client.callTool({ name: "journal_search", arguments: { query: "source links", project: "launch" } });
    assert.ok(!search.isError, text(search));
    assert.match(text(search), /Check the source links/);
    assert.doesNotMatch(text(search), /Unrelated garden/);
    const verify = await client.callTool({ name: "journal_verify", arguments: {} });
    assert.equal(JSON.parse(text(verify)).ok, true);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
