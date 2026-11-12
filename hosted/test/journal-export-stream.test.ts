// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamJournalExport } from "../src/journalExport.js";

test("journal export streams exact bytes and releases the temporary file on completion or client abort", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kairos-export-stream-test-"));
  const content = Buffer.from(JSON.stringify({ format: "synthetic-export", entries: [{ text: "SYNTHETIC export text" }] }));
  let finished!: () => void, completed = new Promise<void>(resolve => { finished = resolve; });
  let hadError = false;
  const server = http.createServer(async (req, res) => {
    const folder = mkdtempSync(join(root, "export-")), file = join(folder, "journal.json");
    writeFileSync(file, req.url === "/abort" ? Buffer.alloc(16 * 1024 * 1024, "a") : content, { mode: 0o600 });
    try { await streamJournalExport(res, file); }
    catch { hadError = true; }
    finally { rmSync(folder, { recursive: true, force: true }); assert.equal(existsSync(folder), false); finished(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/complete`, { headers: { connection: "close" } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-length"), String(content.length));
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.match(response.headers.get("content-disposition")!, /kairos-journal\.json/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content); await completed; assert.equal(hadError, false);
    completed = new Promise<void>(resolve => { finished = resolve; });
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${port}/abort`, { headers: { connection: "close" } }, response => {
        response.once("data", () => { response.destroy(); request.destroy(); resolve(); });
      }); request.once("error", reject);
    });
    await completed; assert.equal(hadError, true, "an interrupted downstream stream rejects before cleanup");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
