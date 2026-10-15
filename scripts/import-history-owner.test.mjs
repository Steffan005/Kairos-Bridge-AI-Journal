// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkedOrigin, IMPORT_LIMITS, ownerImportBatches, runOwnerHistoryImport } from './import-history-owner.mjs';

const origin = 'https://synthetic-journal.example.test', revision = 'c'.repeat(40), cookie = 'synthetic-owner-cookie=PRIVATE_SYNTHETIC_COOKIE';
const hash = value => createHash('sha256').update(value).digest('hex');
const record = index => ({ source_store: 'synthetic-store', source_id: String(index), original_timestamp: '2026-01-01T12:00:00', original_actor: 'gpt_codex', canonical_actor: 'gpt_codex', source_file_sha256: 'a'.repeat(64), timezone: 'unspecified', text: `SYNTHETIC PRIVATE MEMORY ${index}` });
const entry = index => ({ seq: index, id: String(index).padStart(16, '0'), created_at: '2026-10-14T16:00:00.000Z', tick: 5, actor: 'you', kind: 'note', text: `SYNTHETIC CURRENT OWNER NOTE ${index}`, tags: [], parent_hash: '0'.repeat(64), hash: hash('entry-' + index), pinned: false });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kairos-import-uploader-'));
  const baselineEntries = [entry(1), entry(2)], credentials = join(root, 'credentials.json'), records = join(root, 'records.jsonl'), baseline = join(root, 'baseline.json'), output = join(root, 'output');
  await writeFile(credentials, JSON.stringify({ cookie, unused_password: 'PRIVATE_UNUSED_PASSWORD' }), { mode: 0o600 });
  await writeFile(records, Array.from({ length: 121 }, (_, i) => JSON.stringify(record(i))).join('\n') + '\n', { mode: 0o600 });
  await writeFile(baseline, JSON.stringify({ chain_ok: true, head_hash: baselineEntries.at(-1).hash, entries: baselineEntries, entry_count: baselineEntries.length }), { mode: 0o600 });
  return { root, baselineEntries, options: { origin, credentials, records, baseline, output, revision } };
}

test('uploader accepts exact HTTPS origins and bounds streamed JSONL by bytes and count', async () => {
  assert.equal(checkedOrigin(origin), origin); assert.equal(checkedOrigin(origin + '/'), origin);
  for (const value of ['http://example.test', origin + '/path', 'https://user:password@example.test/', origin + '?token=secret', origin + '#secret', 'not-an-origin']) assert.throws(() => checkedOrigin(value), /could not finish/);
  const data = await fixture();
  try {
    const batches = []; for await (const batch of ownerImportBatches(data.options.records)) batches.push(batch);
    assert.deepEqual(batches.map(batch => batch.records.length), [50, 50, 21]);
    assert.deepEqual(batches.map(batch => batch.offset), [0, 50, 100]);
    await writeFile(data.options.records, Array.from({ length: 31 }, (_, i) => JSON.stringify({ ...record(i), text: '😀'.repeat(4000) })).join('\n') + '\n');
    const lengths = []; for await (const batch of ownerImportBatches(data.options.records)) { assert.ok(Buffer.byteLength(batch.payload) < 350 * 1024); assert.ok(batch.records.length <= 50); lengths.push(batch.records.length); }
    assert.equal(lengths.reduce((a, b) => a + b), 31); assert.ok(lengths.length > 1);
    await writeFile(data.options.records, 'x'.repeat(IMPORT_LIMITS.lineBytes + 1));
    await assert.rejects(async () => { for await (const _batch of ownerImportBatches(data.options.records)) {} }, error => error.code === 'record_line_limit');
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('owner uploader resumes acknowledged batches and replays an ambiguous write without duplicates', async () => {
  const data = await fixture(), saved = new Map(), posts = [], exports = [];
  const connections = [{ clientId: 'synthetic-client-b', scopes: ['journal:write', 'journal:read'] }, { clientId: 'synthetic-client-a', scopes: ['journal:read'] }];
  let failLast = true, firstAmbiguous = true, secondAttempts = 0;
  const fetchFn = async (url, options) => {
    const parsed = new URL(url); assert.equal(parsed.origin, origin); assert.equal(options.headers.cookie, cookie); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    if (parsed.pathname === '/about') return response({ source: 'https://github.com/synthetic/repo/tree/' + revision });
    if (parsed.pathname === '/api/journal' && !options.method) return response({ deleted: false, count: data.baselineEntries.length + saved.size, entries: data.baselineEntries, connections });
    if (parsed.pathname === '/api/journal/search') return response({ entries: data.baselineEntries.filter(entry => entry.id === parsed.searchParams.get('q')) });
    if (parsed.pathname === '/api/journal/export') {
      const bytes = Buffer.from(JSON.stringify({ chain_ok: true, entries: [...data.baselineEntries, ...saved.values()] })); exports.push(bytes.length);
      return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 137) controller.enqueue(bytes.subarray(i, i + 137)); controller.close(); } }), { headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } });
    }
    assert.equal(parsed.pathname, '/api/journal/import-history'); assert.equal(options.method, 'POST'); assert.equal(options.headers.origin, origin); assert.equal(options.headers.authorization, undefined);
    const batch = JSON.parse(options.body).records; posts.push(batch[0].source_id); assert.ok(Buffer.byteLength(options.body) < 350 * 1024);
    if (batch[0].source_id === '50' && secondAttempts++ < 2) return new Response('{}', { status: 503 });
    if (batch[0].source_id === '100' && failLast) return new Response('{"error":"private note must not be printed"}', { status: 400 });
    let inserted = 0, skipped = 0;
    const ids = batch.map(record => {
      const key = record.source_store + ':' + record.source_id;
      if (saved.has(key)) skipped++;
      else { inserted++; saved.set(key, { id: hash(key).slice(0, 16), text: record.text, provenance: { source_store: record.source_store, source_id: record.source_id } }); }
      return saved.get(key).id;
    });
    if (batch[0].source_id === '0' && firstAmbiguous) { firstAmbiguous = false; throw new Error('connection dropped after successful write'); }
    return response({ inserted, skipped, ids, headHash: 'f'.repeat(64) });
  };
  try {
    await assert.rejects(runOwnerHistoryImport(data.options, { fetchFn }), error => error.code === 'http_refused' && error.status === 400);
    assert.equal(saved.size, 100); assert.deepEqual(posts, ['0', '0', '50', '50', '50', '100']);
    const ledger = await readFile(join(data.options.output, 'acknowledgments.jsonl'), 'utf8'); assert.doesNotMatch(ledger, /PRIVATE MEMORY|PRIVATE_SYNTHETIC_COOKIE|PRIVATE_UNUSED_PASSWORD/);
    assert.equal(ledger.trim().split('\n').length, 2);
    await writeFile(join(data.options.output, 'acknowledgments.jsonl'), ledger + '{"partial":', { mode: 0o600 });
    failLast = false; const priorPosts = posts.length;
    const report = await runOwnerHistoryImport({ ...data.options, resume: true }, { fetchFn });
    assert.equal(saved.size, 121); assert.deepEqual(posts.slice(priorPosts), ['100']);
    assert.equal(report.acknowledged_records, 121); assert.equal(report.inserted, 71); assert.equal(report.skipped, 50); assert.equal(report.observed_count, 123);
    assert.equal(report.baseline_entries_preserved, 2); assert.equal(report.connections_preserved, 2); assert.ok(report.post_export.sha256); assert.ok(exports.length >= 3);
    const names = await readdir(data.options.output); assert.ok(names.some(name => name.startsWith('ledger-tail-repair-')));
    for (const name of names) assert.equal((await stat(join(data.options.output, name))).mode & 0o777, 0o600);
    assert.equal((await stat(data.options.output)).mode & 0o777, 0o700);
    const beforeReplay = posts.length; const replay = await runOwnerHistoryImport({ ...data.options, resume: true }, { fetchFn }); assert.equal(replay.acknowledged_records, 121); assert.equal(posts.length, beforeReplay);
    await writeFile(data.options.records, JSON.stringify(record(999)) + '\n');
    await assert.rejects(runOwnerHistoryImport({ ...data.options, resume: true }, { fetchFn }), error => error.code === 'resume_input_mismatch');
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('wrong baseline owner, revision and public credential file stop before any import', async () => {
  const data = await fixture(); let mutations = 0;
  const fetchFn = async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'POST') mutations++;
    if (path === '/about') return response({ source: 'https://github.com/synthetic/repo/tree/' + revision });
    if (path === '/api/journal') return response({ deleted: false, count: 5, connections: [] });
    if (path === '/api/journal/search') return response({ entries: [] });
    throw new Error('unexpected request');
  };
  try {
    await assert.rejects(runOwnerHistoryImport(data.options, { fetchFn }), error => error.code === 'baseline_owner_or_entry_mismatch'); assert.equal(mutations, 0);
    await assert.rejects(runOwnerHistoryImport({ ...data.options, revision: 'd'.repeat(40) }, { fetchFn }), error => error.code === 'deployed_revision_mismatch'); assert.equal(mutations, 0);
    await writeFile(data.options.credentials, JSON.stringify({ cookie }), { mode: 0o644 });
    // writeFile mode does not change an existing file, so explicitly simulate a public credential file.
    const { chmod } = await import('node:fs/promises'); await chmod(data.options.credentials, 0o644);
    await assert.rejects(runOwnerHistoryImport(data.options, { fetchFn }), error => error.code === 'credentials_not_private'); assert.equal(mutations, 0);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});
