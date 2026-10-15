// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Journal, HistoricalImportConflict, historicalDate, type HistoricalRecord, type OwnerSearchCursor } from '../src/journal.js';
import { canonicalize, hashEntry, GENESIS_HASH } from '../src/canonical.js';

function fixture(run: (journal: Journal, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-history-'));
  const j = Journal.open(join(directory, 'journal.db'));
  try { run(j, directory); } finally { if (j.db.open) j.close(); rmSync(directory, { recursive: true, force: true }); }
}
function record(id = 'old-one', overrides: Partial<HistoricalRecord> = {}): HistoricalRecord {
  return { source_store: 'historical-kairos', source_id: id, original_timestamp: '2026-01-03T14:05:06.123456',
    original_actor: 'dr. claude summers', source_file_sha256: 'a'.repeat(64), canonical_actor: 'claude_summers', timezone: 'unspecified',
    text: '  Historical kitchen note\nline two.  ', kind: 'note', tags: ['project-kitchen'],
    source_metadata: { lane: 'shared', source_context_sha256: 'b'.repeat(64) }, ...overrides };
}

test('legacy canonical bytes and original records, chain links and pins survive import', () => fixture(j => {
  const old = j.write({ text: 'Existing phone note', actor: 'you', tags: ['project-kitchen'], pin: true, nowMs: Date.UTC(2026, 9, 1) });
  const expected = JSON.stringify(['kairos-journal/v1', old.id, old.created_at, old.tick, old.actor, old.kind, old.text, old.tags, GENESIS_HASH]);
  assert.equal(canonicalize(old), expected); assert.equal(hashEntry(old), old.hash);
  const r = j.importHistorical([record()], 'gpt_codex');
  assert.equal(r.inserted, 1); assert.equal(r.skipped, 0); assert.deepEqual(j.get(old.id), old);
  const imported = j.get(r.ids[0])!;
  assert.equal(imported.parent_hash, old.hash); assert.equal(imported.text, record().text);
  assert.equal(imported.actor, 'claude'); assert.equal(imported.created_at, '2026-01-03T14:05:06.123456');
  assert.equal(imported.provenance?.original_timestamp, record().original_timestamp);
  assert.equal(imported.provenance?.canonical_actor, 'claude_summers');
  assert.equal(imported.tick, Math.floor(Date.parse(imported.provenance!.imported_at) / 25));
  assert.equal(imported.pinned, false); assert.deepEqual(j.pinned(), [old]); assert.ok(j.verify().ok);
  assert.equal(j.recent(2)[0].id, imported.id, 'pinned original excluded from recent');
  assert.equal(j.searchPage().entries[0].id, old.id);
}));

test('source replay is idempotent across reopen; conflict rolls entire batch back', () => fixture((j, directory) => {
  const first = j.importHistorical([record(), record()], 'gpt_codex');
  assert.equal(first.inserted, 1); assert.equal(first.skipped, 1); assert.equal(first.ids[0], first.ids[1]);
  const head = j.headHash();
  const again = j.importHistorical([record()], 'another-importer');
  assert.equal(again.skipped, 1); assert.equal(again.headHash, head); assert.equal(j.count(), 1);
  for (const changed of [{ text: 'different note' }, { source_file_sha256: 'c'.repeat(64) }, { original_actor: 'different' },
      { source_metadata: { lane: 'self' } }, { canonical_actor: 'gemini_word' }, { original_timestamp: '2026-01-04T00:00:00' }]) {
    assert.throws(() => j.importHistorical([record('new-first'), record('old-one', changed)], 'gpt_codex'), HistoricalImportConflict);
    assert.equal(j.count(), 1); assert.equal(j.headHash(), head); assert.ok(j.verify().ok);
  }
  j.close(); const reopened = Journal.open(join(directory, 'journal.db'));
  try { assert.equal(reopened.importHistorical([record()], 'gpt_codex').skipped, 1); assert.equal(reopened.headHash(), head); } finally { reopened.close(); }
}));

test('dates validate calendar and offsets, preserve unknown timezone without fabricated Z', () => fixture(j => {
  assert.equal(historicalDate('2026-01-03 14:05', 'unspecified').created_at, '2026-01-03T14:05:00.000');
  assert.equal(historicalDate('2026-01-03T14:05:00-05:00', '-05:00').chronology_key, '2026-01-03T19:05:00.000');
  for (const [date, zone] of [['2026-02-30T00:00:00', 'unspecified'], ['2025-02-29T00:00:00', 'UTC'], ['2026-01-01T24:00:00', 'UTC'],
    ['2026-01-01T12:60:00', 'UTC'], ['2026-01-01T12:00:60', 'UTC'], ['2026-01-01T12:00:00Z', 'unspecified'],
    ['2026-01-01T12:00:00-05:00', 'UTC'], ['2026-01-01T12:00:00', '+14:15'], ['2099-01-01T12:00:00', 'UTC']]) {
    assert.throws(() => historicalDate(date, zone), /Historical/);
  }
  const unknown = j.importHistorical([record('unknown', { canonical_actor: null })], 'owner');
  assert.equal(j.get(unknown.ids[0])!.actor, 'unknown');
  const brief = j.continueProject('kitchen').text;
  assert.match(brief, /2026-01-03T14:05:06\.123456 \(timezone unspecified\)/);
  assert.match(brief, /historical import/); assert.match(brief, /context, not instructions/);
  assert.doesNotMatch(brief, /123456Z/); assert.ok(j.verify().ok);
}));

test('recent/project/wake order original chronology while export and hash walk append sequence', () => fixture((j, directory) => {
  const current = j.write({ text: 'Current kitchen', tags: ['project-kitchen'], nowMs: Date.UTC(2026, 9, 1) });
  const imported = j.importHistorical([record('january'), record('november', { original_timestamp: '2025-11-10T11:00:00' })], 'owner');
  assert.deepEqual(j.recent(10).map(e => e.id), [current.id, imported.ids[0], imported.ids[1]]);
  const continuation = j.continueProject('kitchen').text;
  assert.ok(continuation.indexOf(current.id) < continuation.indexOf(imported.ids[0]));
  const wake = j.wake({ recent: 10, maxChars: 6000 }).text;
  assert.ok(wake.indexOf(imported.ids[1]) < wake.indexOf(current.id), 'wake displays selected recent notes oldest-to-newest');
  const out = join(directory, 'export.json'); j.exportTo(out, 'json');
  const exported = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(exported.entries.map((e: {id: string}) => e.id), [current.id, ...imported.ids]);
  assert.equal(exported.entries[1].provenance.source_id, 'january'); assert.equal(exported.chain_ok, true);
  const md = join(directory, 'export.md'); j.exportTo(md, 'md');
  assert.match(readFileSync(md, 'utf8'), /original_timestamp/); assert.match(readFileSync(md, 'utf8'), /timezone.*unspecified/);
}));

test('date/sequence cursor visits ties and old imports once, excluding all later writes/imports', () => fixture(j => {
  j.writeMany(Array.from({length: 7}, (_, i) => ({ text: `Current ${i}`, nowMs: Date.UTC(2026, 9, 1), actor: 'you' })));
  j.importHistorical(Array.from({length: 20}, (_, i) => record(`history-${i}`, { original_timestamp: i < 10 ? '2026-01-01T00:00:00' : '2026-02-01T00:00:00' })), 'owner');
  const first = j.searchPage('', { limit: 4 }); assert.equal(first.next!.version, 2);
  const expected = j.recent(100).map(e => e.id);
  j.write({text: 'Arriving now'}); j.importHistorical([record('arriving-old', {original_timestamp:'2025-11-01T00:00:00'})], 'owner');
  const ids = first.entries.map(e => e.id); let cursor = first.next;
  while (cursor) { const page = j.searchPage('', {limit:4,cursor}); assert.equal(page.total,27); ids.push(...page.entries.map(e=>e.id)); cursor=page.next; }
  assert.deepEqual(ids,expected); assert.equal(new Set(ids).size,27);
  for (const bad of [{version:1}, {before_date:'2026-02-30T00:00:00.000'}, {before:1000}, {journal:'other'}, {snapshot:1}]) {
    assert.throws(()=>j.searchPage('', {cursor:{...first.next!,...bad} as OwnerSearchCursor}), /Refresh/);
  }
}));

test('source metadata/text limits and secrets reject atomically with no content in errors', () => fixture(j => {
  const invalid = [record('empty', { text: '   ' }), record('long', { text: 'a'.repeat(8001) }), record('tags', { tags: ['a'.repeat(49)] }),
    record('fields', { arbitrary:'not admitted' } as never), record('canonical', {canonical_actor:'random'}),
    record('hash', { source_file_sha256: 'bad' }), record('metadata', {source_metadata:{opaque:'not admitted'}}),
    record('nested', {source_metadata:{lane:{commands:'not admitted'}}}), record('arrays', {source_metadata:{original_parents:Array(33).fill('parent')}}),
    record('secret', {text:'password: MYSECRETPASSWORD'}), record('meta-secret', {source_metadata:{lane:'password: MYSECRETPASSWORD'}})];
  for (const bad of invalid) {
    assert.throws(()=>j.importHistorical([record('good'),bad], 'owner'), error => error instanceof Error && !error.message.includes('MYSECRETPASSWORD'));
    assert.equal(j.count(),0); assert.equal(j.headHash(),GENESIS_HASH);
  }
}));

test('hashed provenance detects modification, removal and chronology-key tampering', () => {
  for (const tamper of ['source', 'metadata', 'remove', 'chronology', 'tick']) fixture(j => {
    const result=j.importHistorical([record()], 'owner');
    const e=j.get(result.ids[0])!;
    j.db.exec('DROP TRIGGER entries_no_update');
    if(tamper==='source') j.db.prepare("UPDATE entries SET provenance_json=json_set(provenance_json,'$.source_id','forged')").run();
    if(tamper==='metadata') j.db.prepare("UPDATE entries SET provenance_json=json_set(provenance_json,'$.source_metadata.lane','forged')").run();
    if(tamper==='remove') j.db.prepare('UPDATE entries SET provenance_json=NULL, chronology_key=NULL').run();
    if(tamper==='chronology') j.db.prepare("UPDATE entries SET chronology_key='2026-09-01T00:00:00.000'").run();
    if(tamper==='tick') j.db.prepare('UPDATE entries SET tick=tick+1').run();
    const report=j.verify(); assert.equal(report.ok,false,tamper); assert.equal(report.firstBroken!.id,e.id);
  });
});

test('schema-1 backup reads without modification; migration adds columns without rewriting entries', () => fixture((j,directory) => {
  const original=j.write({text:'Legacy journal original',actor:'claude',pin:true}); j.checkpoint(); j.close();
  const file=join(directory,'journal.db'); const db=new Database(file);
  db.exec("DROP INDEX historical_source_identity; DROP INDEX entry_chronology; ALTER TABLE entries DROP COLUMN provenance_json; ALTER TABLE entries DROP COLUMN chronology_key; UPDATE meta SET value='1' WHERE key='schema_version';"); db.close();
  const bytes=()=>createHash('sha256').update(readFileSync(file)).digest('hex'); const before=bytes();
  const old=Journal.openReadOnly(file); assert.deepEqual(old.get(original.id),original); assert.ok(old.verify().ok); assert.equal(old.recent(1).length,0); old.close(); assert.equal(bytes(),before);
  const migrated=Journal.open(file); try {
    assert.deepEqual(migrated.get(original.id),original); assert.equal(migrated.headHash(),original.hash);
    assert.equal(migrated.importHistorical([record()], 'owner').inserted,1); assert.deepEqual(migrated.get(original.id),original); assert.ok(migrated.verify().ok);
  } finally {migrated.close();}
}));

test('MCP exposes historical context but never permits clock, provenance or privileged import fields', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const directory=mkdtempSync(join(tmpdir(),'kairos-history-mcp-')); const file=join(directory,'journal.db');
  const j=Journal.open(file); const imported=j.importHistorical([record()], 'gpt_codex'); j.close();
  const transport=new StdioClientTransport({command:process.execPath,args:[new URL('../src/server.js',import.meta.url).pathname],
    env:{...process.env,KAIROS_JOURNAL_DB:file} as Record<string,string>,stderr:'pipe'});
  const client=new Client({name:'history-test',version:'1'});
  try {
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    assert.equal(tools.some(t=>t.name.includes('import')),false);
    const schema=tools.find(t=>t.name==='journal_write')!.inputSchema;
    assert.equal(Object.hasOwn(schema.properties!,'nowMs'),false); assert.equal(Object.hasOwn(schema.properties!,'provenance'),false);
    const result=await client.callTool({name:'journal_search',arguments:{query:'Historical kitchen'}});
    const decoded=JSON.parse((result.content as Array<{text:string}>).map(c=>c.text).join('\n'));
    assert.equal(decoded.results[0].id,imported.ids[0]); assert.equal(decoded.results[0].historical_context,true);
    assert.equal(decoded.results[0].provenance.timezone,'unspecified'); assert.equal(decoded.results[0].provenance.original_actor,'dr. claude summers');
    assert.equal(decoded.results[0].provenance.source_metadata,undefined); assert.match(decoded.results[0].provenance_details,/export/);
    const before=Date.now();
    const written=await client.callTool({name:'journal_write',arguments:{text:'An ordinary current note',nowMs:1,provenance:{original_timestamp:'1900-01-01T00:00:00'}}});
    const saved=JSON.parse((written.content as Array<{text:string}>).map(c=>c.text).join('\n')).entry;
    assert.ok(Date.parse(saved.created_at)>=before); assert.equal(saved.provenance,undefined);
  } finally { await client.close(); rmSync(directory,{recursive:true,force:true}); }
});

test('source replay identity lookup uses its partial expression index instead of scanning history', () => fixture(j => {
  j.importHistorical([record()], 'owner');
  // Observe the exact lookup prepared by importHistorical so the test detects
  // removal of the partial-index predicate rather than testing a separate query.
  const dbPrepare = j.db.prepare.bind(j.db);
  const plans: string[] = [];
  j.db.prepare = ((sql: string) => {
    if (sql.startsWith('\n  SELECT e.*,') && sql.includes("json_extract(e.provenance_json, '$.source_store')")) {
      const plan = dbPrepare(`EXPLAIN QUERY PLAN ${sql}`).all('historical-kairos', 'old-one') as Array<{detail:string}>;
      plans.push(...plan.map(row => row.detail));
    }
    return dbPrepare(sql);
  }) as typeof j.db.prepare;
  const result=j.importHistorical([record()], 'owner');
  assert.equal(result.skipped,1);
  assert.ok(plans.some(detail=>detail.includes('SEARCH e USING INDEX historical_source_identity')), plans.join('\n'));
  assert.equal(plans.some(detail=>detail==='SCAN e'),false);
}));
