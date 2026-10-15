#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
// Private operator rehearsal. Never commit the input records or generated files.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Journal, compareEntryChronology, historicalDate } from '../dist/src/journal.js';
import { hashEntry, GENESIS_HASH } from '../dist/src/canonical.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (i % 2 === 0) pairs.push([arg.replace(/^--/, ''), all[i + 1]]);
  return pairs;
}, []));
for (const name of ['baseline', 'records', 'samples', 'out']) if (!args[name]) throw new Error(`Missing --${name}`);
const out = path.resolve(args.out);
fs.mkdirSync(out, { mode: 0o700 });
const baseline = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
assert.equal(baseline.chain_ok, true);
assert.equal(baseline.entries.length, baseline.entry_count);
let parent = GENESIS_HASH;
for (const e of baseline.entries) { assert.equal(e.parent_hash, parent); assert.equal(hashEntry(e), e.hash); parent = e.hash; }
assert.equal(parent, baseline.head_hash);
const sampleInput = JSON.parse(fs.readFileSync(args.samples, 'utf8'));
const samples = Array.isArray(sampleInput) ? sampleInput : sampleInput.records;
assert.ok(Array.isArray(samples) && samples.length > 0);
const sampleKey = r => `${r.source_store}\0${r.source_id}`;
const sampleKeys = new Set(samples.map(sampleKey));
const sampleIDs = new Map();
const journal = Journal.open(path.join(out, 'rehearsal.db'));
const start = performance.now();
const imported = { count: 0, batches: 0, bySource: {}, byActor: {}, byMonth: {}, byTimezone: {} };
const bump = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };
const mapping = fs.openSync(path.join(out, 'import-mapping.jsonl'), 'wx', 0o600);
try {
  // Trusted baseline restore is deliberately restricted to a newly created scratch DB.
  assert.equal(journal.count(), 0);
  const insert = journal.db.prepare('INSERT INTO entries(seq,id,created_at,tick,actor,kind,text,tags,parent_hash,hash) VALUES(@seq,@id,@created_at,@tick,@actor,@kind,@text,@tags,@parent_hash,@hash)');
  const pin = journal.db.prepare("INSERT INTO pins(entry_id,pinned_at,pinned_by) VALUES(?,?,'rehearsal-owner')");
  journal.db.transaction(() => { for (const e of baseline.entries) { insert.run({ ...e, tags: JSON.stringify(e.tags) }); if (e.pinned) pin.run(e.id, new Date().toISOString()); } })();
  assert.equal(journal.headHash(), baseline.head_hash);
  assert.equal(journal.verify().ok, true);
  const queryPlan = journal.db.prepare("EXPLAIN QUERY PLAN SELECT e.* FROM entries e WHERE e.provenance_json IS NOT NULL AND json_extract(e.provenance_json,'$.source_store')=? AND json_extract(e.provenance_json,'$.source_id')=?").all('store', 'id');
  assert.ok(queryPlan.some(p => p.detail.includes('USING INDEX historical_source_identity')));
  let batch = [], firstBatch, lastBatch, latestHistorical = null, earliestHistorical = null;
  const flush = () => {
    if (!batch.length) return;
    const result = journal.importHistorical(batch, 'owner');
    assert.equal(result.inserted, batch.length); assert.equal(result.skipped, 0);
    if (!firstBatch) firstBatch = batch;
    lastBatch = batch;
    batch.forEach((r, i) => {
      const id = result.ids[i];
      fs.writeSync(mapping, JSON.stringify({ source_store: r.source_store, source_id: r.source_id, id }) + '\n');
      if (sampleKeys.has(sampleKey(r))) sampleIDs.set(sampleKey(r), id);
      const key = historicalDate(r.original_timestamp, r.timezone).chronology_key;
      if (!earliestHistorical || key < earliestHistorical.key) earliestHistorical = { key, source_store: r.source_store, source_id: r.source_id, id };
      if (!latestHistorical || key > latestHistorical.key) latestHistorical = { key, id };
      bump(imported.bySource, r.source_store); bump(imported.byActor, r.canonical_actor ?? 'unattributed');
      bump(imported.byMonth, r.original_timestamp.slice(0, 7)); bump(imported.byTimezone, r.timezone);
    });
    imported.count += result.inserted; imported.batches++;
    if (imported.batches % 200 === 0) console.log(JSON.stringify({ phase: 'rehearsal_import', count: imported.count, seconds: Math.round((performance.now() - start) / 1000) }));
    batch = [];
  };
  const lines = readline.createInterface({ input: fs.createReadStream(args.records), crlfDelay: Infinity });
  const recordsHasher = createHash('sha256');
  for await (const line of lines) { if (!line) continue; recordsHasher.update(line + '\n'); batch.push(JSON.parse(line)); if (batch.length === 50) flush(); }
  flush();
  assert.ok(imported.count > 0);
  assert.equal(journal.count(), baseline.entry_count + imported.count);
  const importMs = performance.now() - start;
  const head = journal.headHash();
  for (const b of [firstBatch, lastBatch]) { const result = journal.importHistorical(b, 'owner'); assert.equal(result.inserted, 0); assert.equal(result.skipped, b.length); assert.equal(result.headHash, head); }
  for (const e of baseline.entries) assert.deepEqual(journal.get(e.id), e);
  const samplesVerified = [];
  for (const r of samples) {
    const id = sampleIDs.get(sampleKey(r)); assert.ok(id, 'Rehearsal sample not present');
    const e = journal.get(id); assert.equal(e.text, r.text); assert.equal(e.actor, ({ claude_summers:'claude', gemini_word:'gemini', grok_ops:'grok', gpt_codex:'chatgpt', operator:'you' })[r.canonical_actor] ?? 'unknown');
    assert.equal(e.provenance.original_timestamp, r.original_timestamp); assert.equal(e.provenance.source_file_sha256, r.source_file_sha256);
    assert.equal(e.provenance.original_actor, r.original_actor); assert.equal(e.provenance.canonical_actor, r.canonical_actor);
    samplesVerified.push({ source_store:r.source_store, source_id:r.source_id, id, actor:e.actor, original_timestamp:r.original_timestamp, text_sha256:createHash('sha256').update(e.text).digest('hex') });
  }
  const browseStart = performance.now();
  const page = journal.searchPage('', { limit: 15 });
  assert.equal(page.total, baseline.entry_count + imported.count);
  assert.ok(page.entries.every((e, i) => !i || compareEntryChronology(page.entries[i - 1], e) >= 0));
  const secondPage = journal.searchPage('', { limit:15, cursor:page.next });
  assert.equal(new Set([...page.entries, ...secondPage.entries].map(e => e.id)).size, page.entries.length + secondPage.entries.length);
  for (const e of journal.recent(20)) assert.ok(compareEntryChronology(e, journal.get(earliestHistorical.id)) > 0);
  const kitchen = journal.continueProject('kitchen', { limit:1 });
  assert.ok(kitchen.included > 0);
  const history = journal.searchPage('', { project:'project-history', limit:15 });
  assert.equal(history.total, imported.count);
  const browseMs = performance.now() - browseStart;
  const verifyStart = performance.now(), verified = journal.verify();
  assert.equal(verified.ok, true); assert.equal(verified.checked, journal.count());
  const verifyMs = performance.now() - verifyStart;
  const exportStart = performance.now();
  const exported = journal.exportTo(path.join(out,'rehearsal-export.json'),'json');
  const exportMs = performance.now() - exportStart;
  journal.checkpoint();
  const receipt = { observed_at:new Date().toISOString(), actor_id:'gpt_codex', scope:'kairos_bridge', baseline_count:baseline.entry_count, baseline_head:baseline.head_hash, existing_entries_unchanged:true,
    ...imported, total:journal.count(), head:verified.headHash, chain_ok:verified.ok, source_replay_skipped:true, query_plan:queryPlan.map(p=>p.detail),
    records_sha256:recordsHasher.digest('hex'), samples_verified:samplesVerified, earliest_historical:earliestHistorical, latest_historical:latestHistorical,
    first_page_ids:page.entries.map(e=>e.id), import_ms:Math.round(importMs), two_page_browse_ms:Math.round(browseMs), verify_ms:Math.round(verifyMs), export_ms:Math.round(exportMs), export_bytes:exported.bytes,
    db_bytes:fs.statSync(journal.path).size, peak_rss_bytes:process.resourceUsage().maxRSS * 1024,
    limits:'A scratch journal restored from the owner JSON baseline. No live imports or approvals changed. Unspecified source timezones remain unspecified.' };
  fs.writeFileSync(path.join(out,'rehearsal-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({ directory:out, ...receipt },null,2));
} finally { fs.closeSync(mapping); journal.close(); }
