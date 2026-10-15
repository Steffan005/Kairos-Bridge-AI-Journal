// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapAlias, resolveActor, parseHistoricalTimestamp, prepareRecord, deduplicateOrigins, secretReason, prepareHistory } from './prepare-legacy-history.mjs';

const hash = 'a'.repeat(64);
const settings = { sourceStore: 'synthetic', sourceHash: hash };
const row = overrides => ({ id: 1, source: 'dr_claude_summers', text: 'Historical fixture only.', timestamp: '2026-01-02T03:04:05.123456', context: {}, ...overrides });

test('explicit aliases follow provider prefixes without inferring from paths or shared hash', () => {
  for (const s of ['Dr. Claude Summers', 'dr_claude_summers_session_241', 'claude_code:ARCHITECT', 'claude_session:abc']) assert.equal(mapAlias(s), 'claude_summers');
  for (const s of ['Gemini_3', 'gemini_word', 'gemini_auditor', 'GEMINI_CHP']) assert.equal(mapAlias(s), 'gemini_word');
  assert.equal(mapAlias('grok_ops'), 'grok_ops'); assert.equal(mapAlias('gpt-5.2-thinking'), 'gpt_codex');
  assert.equal(mapAlias('CODEX_TEST'), 'gpt_codex');
  for (const s of ['1393e324be57014d', 'the_word_1393e324be57014d', 'archive:SteffanOpus4.5.txt', 'CRITICAL_UNITY_DOC_CLAUDE.md', 'cc_hook:abc', 'dr_claude_db:quote']) assert.equal(mapAlias(s), null);
});
test('conflicting explicit actor labels remain unattributed', () => {
  const a = resolveActor({ source: 'gpt_codex', context: { source: 'gemini_word' } });
  assert.equal(a.canonical, null); assert.equal(a.status, 'conflicting_explicit_actor_labels');
  assert.equal(resolveActor({ source: 'claude', context: { source: 'Dr. Claude Summers' } }).canonical, 'claude_summers');
});
test('generic source with explicit actor is mapped; filename-only archives are not', () => {
  assert.equal(resolveActor({ source: 'cc_hook:abc', context: { actor_id: 'gpt_codex' } }).canonical, 'gpt_codex');
  assert.equal(resolveActor({ source: 'archive:SteffanGemini.txt' }).canonical, null);
});
test('conversation source is not the author of every message', () => {
  assert.equal(resolveActor({ source: 'claude_code', role: 'user' }).canonical, 'operator');
  assert.equal(resolveActor({ source: 'claude_code', role: 'assistant' }).canonical, 'claude_summers');
  assert.equal(resolveActor({ source: 'gpt', role: 'conversation' }).canonical, null);
});
test('naive date and microseconds remain exact without invented UTC', () => {
  const d = parseHistoricalTimestamp('2026-01-02 03:04:05.123456');
  assert.equal(d.original_timestamp, '2026-01-02 03:04:05.123456'); assert.equal(d.timezone, 'unspecified');
  assert.equal(parseHistoricalTimestamp('2026-01-02T03:04:05Z').timezone, 'UTC');
  assert.equal(parseHistoricalTimestamp('2026-01-02T03:04:05-05:00').timezone, '-05:00');
});
test('known Unix timestamps provide UTC evidence, invalid calendars are rejected', () => {
  assert.equal(parseHistoricalTimestamp(1763337600).original_timestamp, '2025-11-17T00:00:00.000Z');
  for (const value of ['2026-02-30T00:00:00', '2026-01-02T25:00:00', '2026-01-02T00:00:00+99:00', null]) assert.ok(parseHistoricalTimestamp(value).error);
});
test('original text whitespace and source hashes survive; metadata is engine allowlisted', () => {
  const x = prepareRecord(row({ text: '  Original\ntext.  ', source_hashes: { record_hash: 'b'.repeat(64), value_hash: 'c'.repeat(64), parent_id: 12, parents: [4, 8] } }), settings);
  assert.equal(x.record.text, '  Original\ntext.  '); assert.equal(x.record.original_timestamp, '2026-01-02T03:04:05.123456');
  assert.equal(x.record.source_metadata.original_record_hash, 'b'.repeat(64));
  assert.deepEqual(x.record.source_metadata.original_parents, [4, 8]); assert.equal(x.record.source_metadata.source_context_sha256.length, 64);
  assert.ok(!Object.hasOwn(x.record, 'provenance')); assert.equal(x.record.canonical_actor, 'claude_summers');
});
test('body and metadata credential gates quarantine entire record with IDs and reason only', () => {
  const fake = 'sk-' + 'x'.repeat(32);
  const a = prepareRecord(row({ text: 'Do not store ' + fake }), settings);
  assert.match(a.rejected.reason, /^text_secret:/); assert.equal(a.record, undefined);
  assert.ok(!JSON.stringify(a).includes(fake));
  const b = prepareRecord(row({ raw: { id: 1, metadata: { api_key: fake } } }), settings);
  assert.match(b.rejected.reason, /^source_metadata_secret:/); assert.ok(!JSON.stringify(b).includes(fake));
  assert.equal(secretReason('Bearer ' + 'z'.repeat(64)), 'bearer credential');
  assert.equal(secretReason('record_hash=' + 'd'.repeat(64)), null);
  assert.equal(secretReason({ nested: { password: 'synthetic-private-value' } }), 'password assignment');
  assert.equal(secretReason({ context: JSON.stringify({ api_key: 'y'.repeat(64) }) }), 'credential assignment');
});
test('oversize text is quarantined without splitting or truncation', () => {
  const x = prepareRecord(row({ text: 'x'.repeat(8001) }), settings);
  assert.equal(x.rejected.reason, 'text_exceeds_8000_chars_no_truncation');
});
test('tag projection retains raw tags in sidecar and accounts for projection limits', () => {
  const tags = ['#Kitchen project', 'x'.repeat(49), ...Array.from({ length: 20 }, (_, i) => 'tag-' + i)];
  const x = prepareRecord(row({ tags }), settings);
  assert.equal(x.record.tags.length, 16); assert.ok(x.record.tags.includes('kitchen-project')); assert.deepEqual(x.provenance.source_tags, tags);
  assert.ok(x.provenance.tag_projection_reasons.includes('oversize_tag_preserved_in_provenance'));
  assert.ok(x.provenance.tag_projection_reasons.includes('excess_tags_preserved_in_provenance'));
});
test('same event text at distinct source identities stays separate; identical origin is accounted', () => {
  const a = prepareRecord(row(), settings), b = prepareRecord(row({ id: 2 }), settings);
  const x = deduplicateOrigins([a, b, a]);
  assert.equal(x.records.length, 2); assert.equal(x.omitted.length, 1); assert.equal(x.omitted[0].reason, 'duplicate_origin_exact');
});
test('conflicting copies of same origin are explicitly reported', () => {
  const a = prepareRecord(row(), settings), b = prepareRecord(row({ text: 'Changed safe historical text.' }), settings);
  const x = deduplicateOrigins([a, b]); assert.equal(x.omitted[0].reason, 'conflicting_origin_payload');
});
test('telemetry is classified but remains an eligible import record', () => {
  const x = prepareRecord(row({ source: null, context: { expected: 1, found: 0 } }), { ...settings, repeatCount: 100 });
  assert.equal(x.classification, 'repeated_mechanical_telemetry'); assert.equal(x.record.canonical_actor, null);
});
test('full private preparation reconciles counts, preserves sources and batches safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kairos-adapter-test-'));
  const input = join(dir, 'source.json'), output = join(dir, 'private-output');
  await writeFile(input, JSON.stringify({ memories: [
    { id: 1, value: 'Old safe fixture.', timestamp: '2026-01-02 00:00:00', source: 'gemini_word' },
    { id: 2, value: 'x'.repeat(8001), timestamp: '2026-01-03 00:00:00', source: 'claude' },
  ] }));
  const result = await prepareHistory({ output, sources: [{ path: input, store: 'synthetic-trinity', type: 'trinity-v27' }], batch_records: 1 });
  assert.equal(result.counts.input, 2); assert.equal(result.counts.prepared, 1); assert.equal(result.counts.excluded, 1); assert.equal(result.batch_count, 1);
  const manifest = JSON.parse(await readFile(result.manifest_path)); assert.equal(manifest.sources[0].input, 2); assert.equal(manifest.counts.by_actor.gemini_word, 1);
  assert.equal((await stat(result.manifest_path)).mode & 0o777, 0o600); assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(manifest.sources[0].snapshot_path)).mode & 0o777, 0o600);
  assert.ok((await readFile(manifest.outputs.quarantine, 'utf8')).includes('text_exceeds_8000_chars_no_truncation'));
});
