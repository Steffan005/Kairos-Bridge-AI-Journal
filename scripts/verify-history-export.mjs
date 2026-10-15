#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
// Independent streaming check against the already rehearsed private source.
import fs from 'node:fs';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Journal, historicalDate, entryChronologyKey } from '../dist/src/journal.js';
import { hashEntry, GENESIS_HASH } from '../dist/src/canonical.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!['export','baseline','rehearsal','samples','out'].includes(key) || !process.argv[i + 1] || args[key]) throw new Error('Invalid verification arguments');
  args[key] = process.argv[i + 1];
}
for (const key of ['export','baseline','rehearsal','samples','out']) if (!args[key]) throw new Error(`Missing --${key}`);
const baseline = JSON.parse(fs.readFileSync(args.baseline,'utf8'));
assert.equal(baseline.chain_ok,true);
const baselineByID = new Map(baseline.entries.map(e=>[e.id,e]));
const sampleInput = JSON.parse(fs.readFileSync(args.samples,'utf8'));
const sampleKeys = new Set((Array.isArray(sampleInput)?sampleInput:sampleInput.records).map(r=>r.source_store+'\0'+r.source_id));
const reference = Journal.openReadOnly(args.rehearsal);
const lookup = reference.db.prepare("SELECT * FROM entries WHERE provenance_json IS NOT NULL AND json_extract(provenance_json,'$.source_store')=? AND json_extract(provenance_json,'$.source_id')=?");
const expectedHistory = reference.db.prepare('SELECT count(*) AS n FROM entries WHERE provenance_json IS NOT NULL').get().n;
const start = performance.now(), fingerprint = createHash('sha256');
let parent = GENESIS_HASH, checked = 0, imported = 0, earliest = null, latest = null;
const seenBaseline = new Set(), seenOrigin = new Set(), ids = new Set(), samples = [], bySource = {}, byActor = {}, byMonth = {}, byTimezone = {}, metadata = {};
const bump = (obj,key)=>{obj[key]=(obj[key]??0)+1;};
try {
  const input = fs.createReadStream(args.export);
  input.on('data', bytes=>fingerprint.update(bytes));
  const lines = readline.createInterface({input,crlfDelay:Infinity});
  for await (const raw of lines) {
    const line = raw.trim().replace(/,$/,'');
    if (line.startsWith('{"seq":')) {
      const entry = JSON.parse(line); checked++;
      assert.equal(entry.seq,checked,'Export append sequence gap'); assert.ok(!ids.has(entry.id),'Duplicate current ID'); ids.add(entry.id);
      assert.equal(entry.parent_hash,parent,'Export chain parent mismatch'); assert.equal(hashEntry(entry),entry.hash,'Export hash mismatch'); parent=entry.hash;
      if (baselineByID.has(entry.id)) { assert.deepEqual(entry,baselineByID.get(entry.id),'Existing entry changed'); seenBaseline.add(entry.id); }
      if (entry.provenance) {
        const p=entry.provenance, origin=p.source_store+'\0'+p.source_id;
        assert.ok(!seenOrigin.has(origin),'Duplicate imported source identity'); seenOrigin.add(origin);
        const expected=lookup.get(p.source_store,p.source_id); assert.ok(expected,'Unplanned imported source');
        const expectedProvenance=JSON.parse(expected.provenance_json);
        for (const k of ['version','source_store','source_id','original_timestamp','original_actor','source_file_sha256','canonical_actor','timezone','chronology_key','source_metadata']) assert.deepEqual(p[k],expectedProvenance[k],`Imported provenance mismatch (${k})`);
        for (const k of ['created_at','actor','kind','text']) assert.equal(entry[k],expected[k],`Imported field mismatch (${k})`);
        assert.deepEqual(entry.tags,JSON.parse(expected.tags)); assert.equal(entry.pinned,false); assert.equal(p.imported_by,'owner');
        assert.equal(entry.tick,Math.floor(Date.parse(p.imported_at)/25));
        const date=historicalDate(p.original_timestamp,p.timezone); assert.equal(entry.created_at,date.created_at); assert.equal(p.chronology_key,date.chronology_key);
        imported++; bump(bySource,p.source_store); bump(byActor,p.canonical_actor??'unattributed'); bump(byMonth,p.original_timestamp.slice(0,7)); bump(byTimezone,p.timezone);
        if (sampleKeys.has(origin)) samples.push({id:entry.id,actor:entry.actor,source_store:p.source_store,source_id:p.source_id,original_timestamp:p.original_timestamp,text_sha256:createHash('sha256').update(entry.text).digest('hex')});
        if (!earliest || p.chronology_key<earliest.chronology_key) earliest={id:entry.id,source_store:p.source_store,source_id:p.source_id,original_timestamp:p.original_timestamp,chronology_key:p.chronology_key};
      } else { assert.equal(entry.tick,Math.floor(Date.parse(entry.created_at)/25)); }
      const key=entryChronologyKey(entry);
      if (!latest || key>latest.chronology_key || (key===latest.chronology_key && entry.seq>latest.seq)) latest={id:entry.id,seq:entry.seq,actor:entry.actor,created_at:entry.created_at,chronology_key:key};
    } else if (/^"(?:format|chain_ok|head_hash|entry_count)":/.test(line)) Object.assign(metadata,JSON.parse('{'+line+'}'));
  }
  assert.equal(metadata.format,'kairos-journal-export/v1'); assert.equal(metadata.chain_ok,true); assert.equal(metadata.head_hash,parent); assert.equal(metadata.entry_count,checked);
  assert.equal(seenBaseline.size,baselineByID.size); assert.equal(imported,expectedHistory); assert.equal(samples.length,sampleKeys.size);
  const receipt={observed_at:new Date().toISOString(),actor_id:'gpt_codex',scope:'kairos_bridge',method:'Streaming full downloaded export; recomputed every entry hash and parent; compared every historical row to the private full rehearsal source, including text, dates, aliases and metadata.',chain_ok:true,checked,head_hash:parent,baseline_count:baselineByID.size,baseline_preserved:seenBaseline.size,imported_verified:imported,source_identity_duplicates:0,by_source:bySource,by_canonical_actor:byActor,by_original_month:byMonth,by_timezone:byTimezone,earliest_historical:earliest,latest_by_original_chronology:latest,samples_verified:samples,export_sha256:fingerprint.digest('hex'),elapsed_ms:Math.round(performance.now()-start),limits:'Old source timezone omissions remain unspecified. Comparison validates the recovered five-store packet, not completeness of inaccessible remote stores or excluded/quarantined records.'};
  fs.writeFileSync(args.out,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(receipt,null,2));
} finally {reference.close();}
