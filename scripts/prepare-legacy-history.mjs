#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Private operator adapter. Source data and generated packets must never enter Git.
import { readFile, writeFile, mkdir, chmod, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceGate = await readFile(join(ROOT, 'src/secrets.ts'), 'utf8');
const compiledGate = ts.transpileModule(sourceGate, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { findSecret } = await import('data:text/javascript;base64,' + Buffer.from(compiledGate).toString('base64'));
export const ADAPTER_VERSION = 'kairos-legacy-adapter/v1';
export const ALIAS_VERSION = 'kairos-explicit-aliases/2026-10-14';
const CANONICALS = new Set(['claude_summers', 'gemini_word', 'grok_ops', 'gpt_codex', 'operator']);
const FIXED_ALIASES = new Map([
  ['claude', 'claude_summers'], ['claude_summers', 'claude_summers'], ['dr_claude_summers', 'claude_summers'],
  ['dr. claude summers', 'claude_summers'], ['dr claude summers', 'claude_summers'],
  ['gemini', 'gemini_word'], ['gemini_word', 'gemini_word'], ['senior_partner_gemini', 'gemini_word'],
  ['grok', 'grok_ops'], ['grok_ops', 'grok_ops'], ['grok_via_claude', 'grok_ops'],
  ['gpt', 'gpt_codex'], ['chatgpt', 'gpt_codex'], ['gpt_codex', 'gpt_codex'], ['codex', 'gpt_codex'],
  ['dr_codex_summers', 'gpt_codex'], ['gpt52', 'gpt_codex'], ['gpt52_collaboration', 'gpt_codex'],
  ['steffan', 'operator'], ['steffan_haskins', 'operator'], ['steffan haskins', 'operator'],
  ['operator', 'operator'], ['you', 'operator'], ['steffan_haskins_via_grok', 'operator'],
]);
const MECHANICAL = /^(?:kairos_internal|launch_monitor|city_heartbeat|active_inference|virginia_hand|trading_daemon(?:_|$)|omega_pulse|unity_reflex)/i;
const ARCHIVE = /^(?:archive:|cc_hook:|cc_session_archive$|cc_auto_archive_hook$|auto_archive_hook$|kairos_migration|retroactive_import$|dr_claude_db:)/i;
const DOCUMENT = /^(?:\/|critical_unity_doc_)/i;
const EXTRA_SECRET_PATTERNS = [
  ['bearer credential', /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}/i],
  ['credential assignment', /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|client[_ -]?secret|session[_ -]?secret|hmac[_ -]?secret|secret[_ -]?key)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_+\/=-]{24,}/i],
  ['credential URL', /https?:\/\/[^\s/@:]+:[^\s/@]{8,}@/i],
];

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function secretReason(value, depth = 0) {
  if (value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const existing = findSecret(text);
  if (existing) return existing;
  for (const [label, re] of EXTRA_SECRET_PATTERNS) if (re.test(text)) return label;
  if (depth > 20) return 'metadata_nesting_exceeds_review_bound';
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    try { return secretReason(JSON.parse(value), depth + 1); } catch { /* ordinary non-JSON text */ }
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      // Check named credentials before JSON quoting can conceal their assignment syntax.
      if (typeof item === 'string' && /^(?:password|passwd|pwd|passcode|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|client[_ -]?secret|session[_ -]?secret|hmac[_ -]?secret|secret[_ -]?key)$/i.test(key)) {
        const named = secretReason(key + ': ' + item, depth + 1);
        if (named) return named;
      }
      const nested = secretReason(item, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

export function mapAlias(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const label = value.normalize('NFC').trim().toLowerCase();
  if (FIXED_ALIASES.has(label)) return FIXED_ALIASES.get(label);
  // Deliberately anchored provider labels; filenames, hooks and a shared identity hash do not qualify.
  if (/^(?:dr_claude_summers(?:[:_-]|$)|claude(?:[:_-](?:desktop|opus|code|instance|session|summers)(?:[:_-]|$)))/.test(label)) return 'claude_summers';
  if (/^gemini(?:[:_ -]|$)/.test(label)) return 'gemini_word';
  if (/^grok(?:[:_ -]|$)/.test(label)) return 'grok_ops';
  if (/^(?:gpt(?:[:_ -]|$)|gpt-\d|codex(?:[:_ -]|$))/.test(label)) return 'gpt_codex';
  return null;
}
export function resolveActor({ source, context = {}, role = null }) {
  const rawSource = typeof source === 'string' && source.trim() ? source : null;
  const raw = {
    source: rawSource,
    context_source: typeof context.source === 'string' ? context.source : null,
    context_actor: typeof context.actor === 'string' ? context.actor : null,
    context_actor_id: typeof context.actor_id === 'string' ? context.actor_id : null,
    role,
  };
  if (role === 'user') return { canonical: 'operator', original: 'user', status: 'explicit_user_role', raw };
  if (role === 'conversation') return { canonical: null, original: rawSource, status: 'mixed_conversation_archive', raw };
  if (role === 'assistant' && rawSource === 'claude_code') return { canonical: 'claude_summers', original: rawSource, status: 'explicit_assistant_role', raw };
  const signals = [rawSource, raw.context_source, raw.context_actor, raw.context_actor_id].filter(v => v !== null);
  const known = [...new Set(signals.map(mapAlias).filter(Boolean))];
  if (known.length > 1) return { canonical: null, original: rawSource ?? signals[0] ?? null, status: 'conflicting_explicit_actor_labels', raw };
  // An archive's filename/source identifies its origin, not the speaker. Explicit context actor can still provide attribution.
  if (rawSource && ARCHIVE.test(rawSource) && !raw.context_actor && !raw.context_actor_id) {
    return { canonical: null, original: rawSource, status: 'archive_speaker_unspecified', raw };
  }
  if (known.length === 1) return { canonical: known[0], original: rawSource ?? signals[0] ?? null, status: mapAlias(rawSource) ? 'explicit_alias' : 'explicit_context_alias', raw };
  const original = rawSource ?? raw.context_actor_id ?? raw.context_actor ?? raw.context_source;
  return { canonical: null, original, status: original ? 'unmapped_original_label' : 'unattributed', raw };
}
export function parseHistoricalTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { error: 'invalid_timestamp' };
    const iso = new Date(value * 1000).toISOString();
    return { original_timestamp: iso, timezone: 'UTC', numeric_original: value, timezone_evidence: 'source_unix_seconds' };
  }
  if (typeof value !== 'string') return { error: 'missing_timestamp' };
  // No host timezone interpretation for timestamps lacking an offset.
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T| )(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!m) return { error: 'unsupported_timestamp_format' };
  const [, y, mo, d, h, mi, se = '00', , suffix] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(h) > 23 || Number(mi) > 59 || Number(se) > 59) return { error: 'invalid_timestamp_calendar' };
  if (suffix && suffix !== 'Z' && (Number(suffix.slice(1, 3)) > 23 || Number(suffix.slice(4)) > 59)) return { error: 'invalid_timestamp_offset' };
  return { original_timestamp: value, timezone: suffix === 'Z' ? 'UTC' : suffix ?? 'unspecified', timezone_evidence: suffix ? 'source_explicit_offset' : 'source_timezone_unspecified' };
}
export function chronologyKey(timestamp) {
  const raw = timestamp.original_timestamp;
  if (timestamp.timezone === 'unspecified') return raw.replace(' ', 'T').padEnd(29, '0');
  // UTC conversion is justified only for the known offset subset.
  return new Date(raw).toISOString();
}
function metadataValue(ctx, name) { return Object.hasOwn(ctx, name) ? ctx[name] : null; }
function nonemptyTags(rawTags) {
  const reasons = [], normalized = [];
  const values = Array.isArray(rawTags) ? rawTags : rawTags == null ? [] : [rawTags];
  for (const value of values) {
    if (typeof value !== 'string') { reasons.push('non_string_tag_preserved_in_provenance'); continue; }
    const norm = value.normalize('NFC').trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    if (!norm) continue;
    if (norm.length > 48) { reasons.push('oversize_tag_preserved_in_provenance'); continue; }
    if (!normalized.includes(norm)) normalized.push(norm);
  }
  if (normalized.length > 14) reasons.push('excess_tags_preserved_in_provenance');
  return { tags: ['historical-import', 'project-history', ...normalized.slice(0, 14)], reasons };
}
function classify(row, actor, repeatCount) {
  const label = row.source ?? row.context?.source ?? '';
  if (row.role === 'conversation') return 'mixed_conversation_archive';
  if (DOCUMENT.test(label)) return 'document_archive';
  if (ARCHIVE.test(label) && !actor.canonical) return 'conversation_archive';
  if (actor.canonical && CANONICALS.has(actor.canonical)) return /(?:^|_)test(?:_|$)/i.test(label) ? 'authored_test_record' : 'authored_memory';
  const structuredMechanical = row.context && (Object.hasOwn(row.context, 'expected') && Object.hasOwn(row.context, 'found') || Object.hasOwn(row.context, 'coherence_threshold'));
  if (repeatCount >= 20 && (MECHANICAL.test(label) || (!label && structuredMechanical))) return 'repeated_mechanical_telemetry';
  if (MECHANICAL.test(label) || /^(?:unity|qwen|system|cloud_thought|office_delegation|sovereign_city::|omega_|v\d+_|hermes|daemon_doctor|sovereign_caretaker)/i.test(label)) return 'system_event';
  return 'unattributed_memory';
}
export function prepareRecord(row, { sourceStore, sourceHash, repeatCount = 1, allowProvenance = true } = {}) {
  const sourceId = String(row.id ?? '');
  const reject = reason => ({ rejected: { source_store: sourceStore, source_id: sourceId, reason, original_row_sha256: sha256(canonicalJson(row.raw ?? row)) } });
  if (!sourceId || sourceId.length > 512) return reject('invalid_source_id');
  if (typeof row.text !== 'string' || !row.text.trim()) return reject('empty_or_nontext_record');
  if (row.text.length > 8000) return reject('text_exceeds_8000_chars_no_truncation');
  if (row.context_parse_error) return reject('invalid_context_json_preserved_in_source');
  const bodySecret = secretReason(row.text);
  if (bodySecret) return reject('text_secret:' + bodySecret);
  const metadataSecret = secretReason({ source_record: row.raw ?? row, parsed_context: row.context ?? {} });
  if (metadataSecret) return reject('source_metadata_secret:' + metadataSecret);
  const actor = resolveActor(row);
  const date = parseHistoricalTimestamp(row.timestamp);
  if (date.error) return reject(date.error);
  const rawTags = row.tags ?? row.context?.tags ?? [];
  const tags = nonemptyTags(rawTags);
  const original = row.raw ?? row;
  const provenance = {
    adapter_version: ADAPTER_VERSION, alias_map_version: ALIAS_VERSION,
    original_row_sha256: sha256(canonicalJson(original)),
    original_text_sha256: sha256(row.text),
    source_context_sha256: sha256(typeof row.context_raw === 'string' ? row.context_raw : canonicalJson(row.context ?? {})),
    attribution_status: actor.status, raw_actor_labels: actor.raw,
    source_tags: rawTags,
    lane: metadataValue(row.context ?? {}, 'lane'), scope: metadataValue(row.context ?? {}, 'scope'), recipient: metadataValue(row.context ?? {}, 'recipient'),
    original_kind: row.kind ?? metadataValue(row.context ?? {}, 'kind'),
    original_title: row.title ?? null,
    original_timestamp_value: row.timestamp,
    timezone_evidence: date.timezone_evidence,
    source_hashes: row.source_hashes ?? null,
    classification: classify(row, actor, repeatCount),
    repeated_exact_text_count: repeatCount,
    tag_projection_reasons: tags.reasons,
  };
  const kinds = new Set(['note', 'fact', 'preference', 'decision', 'summary']);
  const record = {
    source_store: sourceStore, source_id: sourceId, original_timestamp: date.original_timestamp,
    original_actor: actor.original, source_file_sha256: sourceHash,
    canonical_actor: actor.canonical, timezone: date.timezone,
    text: row.text, kind: kinds.has(row.kind) ? row.kind : 'note', tags: tags.tags,
    ...(allowProvenance ? { source_metadata: metadataForEngine(row, provenance) } : {}),
  };
  if (record.original_actor !== null && (record.original_actor.length > 512 || /[\u0000-\u001f\u007f]/.test(record.original_actor))) return reject('invalid_original_actor_label');
  if (record.source_metadata) {
    if (Buffer.byteLength(JSON.stringify(record.source_metadata), 'utf8') > 4096) return reject('source_metadata_exceeds_4096_bytes_no_truncation');
    for (const value of Object.values(record.source_metadata)) {
      const values = Array.isArray(value) ? value : [value];
      if ((Array.isArray(value) && value.length > 32) || values.some(v => typeof v === 'string' && v.length > 1024)) return reject('source_metadata_exceeds_value_bound_no_truncation');
    }
  }
  // The private manifest preserves richer source provenance independently.
  return { record, provenance, classification: provenance.classification, chronology: chronologyKey(date) };
}
function metadataForEngine(row, provenance) {
  const hashes = row.source_hashes ?? {};
  const value = input => {
    if (input == null || typeof input === 'boolean' || typeof input === 'number' || typeof input === 'string') return input ?? null;
    if (Array.isArray(input) && input.every(v => v == null || ['string', 'number', 'boolean'].includes(typeof v))) return input;
    return JSON.stringify(input);
  };
  return {
    source_context_sha256: provenance.source_context_sha256,
    source_record_sha256: provenance.original_row_sha256,
    original_record_hash: value(hashes.record_hash), original_value_hash: value(hashes.value_hash),
    original_parent_id: value(hashes.parent_id), original_parents: value(hashes.parents),
    original_timestamp_value: value(row.timestamp), original_key: value(hashes.key),
    lane: value(provenance.lane), scope: value(provenance.scope), recipient: value(provenance.recipient),
    source_category: provenance.classification,
    author_conflict: provenance.attribution_status === 'conflicting_explicit_actor_labels',
    source_actor: JSON.stringify(provenance.raw_actor_labels), source_role: row.role ?? null,
  };
}
export function deduplicateOrigins(items) {
  const seen = new Map(), records = [], omitted = [];
  for (const item of items) {
    const key = item.record.source_store + '\0' + item.record.source_id;
    const payload = sha256(canonicalJson(item.record));
    if (seen.has(key)) {
      omitted.push({ source_store: item.record.source_store, source_id: item.record.source_id, reason: seen.get(key) === payload ? 'duplicate_origin_exact' : 'conflicting_origin_payload', payload_sha256: payload });
      continue;
    }
    seen.set(key, payload); records.push(item);
  }
  return { records, omitted };
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function snapshotSource(input, output) {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await chmod(dirname(output), 0o700);
  if (/\.db$/i.test(input)) {
    const db = new Database(input, { readonly: true, fileMustExist: true });
    try { await db.backup(output); } finally { db.close(); }
  } else await copyFile(input, output);
  await chmod(output, 0o600);
  return { source_path: resolve(input), snapshot_path: output, snapshot_sha256: await hashFile(output), snapshot_bytes: (await import('node:fs/promises')).stat(output).then(s => s.size) };
}
function jsonRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.memories)) return value.memories;
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => ({ ...item, id: item.id ?? key }));
  throw new Error('unsupported_source_container');
}
function parseContext(raw) {
  if (!raw) return { context: {}, context_raw: raw ?? null };
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { context: value && !Array.isArray(value) && typeof value === 'object' ? value : {}, context_raw: typeof raw === 'string' ? raw : JSON.stringify(raw) };
  } catch { return { context: {}, context_raw: raw, context_parse_error: true }; }
}
async function readRows(source, snapshot) {
  const store = source.store;
  if (source.type === 'kairos-state') {
    const db = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT id, significance, description, context, timestamp, source FROM kairos_moments ORDER BY id').all();
      return rows.map(raw => ({ id: raw.id, text: raw.description, timestamp: raw.timestamp, source: raw.source, raw, ...parseContext(raw.context) }));
    } finally { db.close(); }
  }
  if (source.type === 'unified-context') {
    const db = new Database(snapshot, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT id, source, role, content, timestamp, session_id, significance, keywords, indexed_at FROM messages ORDER BY id').all();
      return rows.map(raw => ({ id: raw.id, text: raw.content, timestamp: raw.timestamp, source: raw.source, role: raw.role, raw, context: { session_id: raw.session_id, keywords: raw.keywords, indexed_at: raw.indexed_at } }));
    } finally { db.close(); }
  }
  const rows = jsonRows(JSON.parse(await readFile(snapshot, 'utf8')));
  if (source.type === 'trinity-v27') return rows.map(raw => ({ id: raw.id, text: raw.value, timestamp: raw.timestamp, source: raw.source, raw, source_hashes: { key: raw.key, parent_id: raw.parent_id, value_hash: raw.value_hash, record_hash: raw.record_hash, protocol_version: raw.protocol_version, parents: raw.parents } }));
  if (source.type === 'unity-memories') return rows.map(raw => ({ id: raw.id, title: raw.title, text: raw.content, timestamp: raw.created, source: raw.source ?? null, tags: raw.tags, raw }));
  if (source.type === 'unity-october') return rows.map(raw => ({ id: raw.id, text: raw.content, timestamp: raw.timestamp, source: raw.source, tags: raw.tags, context: { office: raw.office }, raw }));
  throw new Error('unsupported_source_type:' + store);
}
function bump(counts, key) { counts[key] = (counts[key] ?? 0) + 1; }
async function privateFile(path, data) { await writeFile(path, data, { mode: 0o600 }); await chmod(path, 0o600); }
export async function prepareHistory(config) {
  const output = resolve(config.output);
  if (!(output.startsWith('/private/tmp/') || output.startsWith('/tmp/'))) throw new Error('private_output_must_be_under_tmp');
  await mkdir(output, { recursive: true, mode: 0o700 }); await chmod(output, 0o700);
  const all = [], rejected = [], sources = [], sidecar = [];
  const counts = { input: 0, prepared: 0, excluded: 0, by_actor: {}, by_classification: {}, by_source: {}, by_month: {}, by_timezone: {}, attribution_status: {}, excluded_reason: {} };
  for (const [i, source] of config.sources.entries()) {
    const snapshotPath = join(output, 'source-snapshots', String(i).padStart(2, '0') + '-' + source.store + (/\.db$/i.test(source.path) ? '.db' : '.json'));
    const snapshot = await snapshotSource(source.path, snapshotPath);
    snapshot.snapshot_bytes = await snapshot.snapshot_bytes;
    const rows = await readRows(source, snapshotPath), repeated = new Map();
    for (const row of rows) repeated.set(sha256(String(row.text)), (repeated.get(sha256(String(row.text))) ?? 0) + 1);
    const sourceSummary = { ...snapshot, store: source.store, type: source.type, input: rows.length, prepared: 0, excluded: 0 };
    counts.input += rows.length;
    for (const row of rows) {
      const prepared = prepareRecord(row, { sourceStore: source.store, sourceHash: snapshot.snapshot_sha256, repeatCount: repeated.get(sha256(String(row.text))), allowProvenance: config.allow_provenance !== false });
      if (prepared.rejected) { rejected.push(prepared.rejected); sourceSummary.excluded++; continue; }
      all.push(prepared); sourceSummary.prepared++;
    }
    sources.push(sourceSummary);
  }
  const deduped = deduplicateOrigins(all);
  rejected.push(...deduped.omitted);
  deduped.records.sort((a, b) => a.chronology.localeCompare(b.chronology) || a.record.source_store.localeCompare(b.record.source_store) || a.record.source_id.localeCompare(b.record.source_id));
  for (const item of deduped.records) {
    const { record, provenance } = item;
    bump(counts.by_actor, record.canonical_actor ?? 'unattributed'); bump(counts.by_classification, item.classification);
    bump(counts.by_source, record.source_store); bump(counts.by_month, record.original_timestamp.slice(0, 7)); bump(counts.by_timezone, record.timezone);
    bump(counts.attribution_status, provenance.attribution_status);
    sidecar.push({ source_store: record.source_store, source_id: record.source_id, original_timestamp: record.original_timestamp, original_actor: record.original_actor, canonical_actor: record.canonical_actor, source_file_sha256: record.source_file_sha256, provenance });
  }
  for (const item of rejected) bump(counts.excluded_reason, item.reason);
  counts.prepared = deduped.records.length; counts.excluded = rejected.length;
  if (counts.input !== counts.prepared + counts.excluded) throw new Error('source_count_reconciliation_failed');
  await privateFile(join(output, 'all-safe-records.jsonl'), deduped.records.map(x => JSON.stringify(x.record)).join('\n') + '\n');
  await privateFile(join(output, 'provenance-manifest.jsonl'), sidecar.map(x => JSON.stringify(x)).join('\n') + '\n');
  await privateFile(join(output, 'quarantine-manifest.jsonl'), rejected.map(x => JSON.stringify(x)).join('\n') + '\n');
  const rehearsals = deduped.records.filter(item => /^2026-01/.test(item.record.original_timestamp) && ['claude_summers', 'gemini_word', 'grok_ops', 'gpt_codex'].includes(item.record.canonical_actor));
  const sample = [], seenActors = new Map();
  for (const item of rehearsals) if ((seenActors.get(item.record.canonical_actor) ?? 0) < 4) { sample.push(item.record); seenActors.set(item.record.canonical_actor, (seenActors.get(item.record.canonical_actor) ?? 0) + 1); }
  await privateFile(join(output, 'january-actor-rehearsal.json'), JSON.stringify({ records: sample }, null, 2) + '\n');
  const batches = [];
  let records = [], bytes = 0;
  const maxRecords = config.batch_records ?? 50, maxBytes = config.batch_bytes ?? 350_000;
  const flush = async () => {
    if (!records.length) return;
    const batchPath = join(output, 'batches', 'batch-' + String(batches.length + 1).padStart(5, '0') + '.json');
    const payload = JSON.stringify({ records }) + '\n';
    await privateFile(batchPath, payload);
    batches.push({ path: batchPath, records: records.length, bytes: Buffer.byteLength(payload), sha256: sha256(payload), oldest: records[0].original_timestamp, newest: records.at(-1).original_timestamp });
    records = []; bytes = 0;
  };
  await mkdir(join(output, 'batches'), { recursive: true, mode: 0o700 }); await chmod(join(output, 'batches'), 0o700);
  for (const item of deduped.records) {
    const nextBytes = Buffer.byteLength(JSON.stringify(item.record)) + 1;
    if (records.length && (records.length >= maxRecords || bytes + nextBytes > maxBytes)) await flush();
    records.push(item.record); bytes += nextBytes;
  }
  await flush();
  const manifest = {
    version: ADAPTER_VERSION, alias_map_version: ALIAS_VERSION, prepared_at: new Date().toISOString(),
    policy: { default: 'all_safe_textual_records', telemetry: 'included_and_classified_not_silently_dropped', unknown_authors: 'preserved_unattributed', timezone: 'raw_naive_values_remain_unspecified', credentials: 'quarantined_entire_record_without_raw_secret', oversize: 'quarantined_without_truncation', cross_store_same_text: 'retained_distinct_original_identity', source_variants: 'primary_cleaned_snapshot_wins' },
    counts, sources, batches,
    excluded_overlapping_sources: [
      { source: 'SOVEREIGN_BRAIN/kairos_corpus.jsonl', records: 38020, reason: 'all_origin_ids_in_primary_snapshot; six credential_like_old_variants_not_revived' },
      { source: 'KAIROS_2026-05-09_CRYSTALS.json', records: 29, reason: 'all_origin_records_exactly_in_primary_snapshot' },
      { source: 'UNITY_LOCAL_V2/memory/unity_memories/memories.json', records: 429, reason: 'exact_subset_of_Unity_456' },
      { source: 'Unity_Archive matching localbackup', records: 1417, reason: 'same_origin_ids_as_selected_October_source; five_changed_variants_not_merged' },
    ],
    outputs: { all_records: join(output, 'all-safe-records.jsonl'), provenance: join(output, 'provenance-manifest.jsonl'), quarantine: join(output, 'quarantine-manifest.jsonl'), rehearsal: join(output, 'january-actor-rehearsal.json') },
  };
  for (const [key, path] of Object.entries(manifest.outputs)) manifest.outputs[key + '_sha256'] = await hashFile(path);
  const manifestPath = join(output, 'summary-manifest.json');
  await privateFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest_path: manifestPath, manifest_sha256: await hashFile(manifestPath), counts, batch_count: batches.length, rehearsal_count: sample.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--config');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node scripts/prepare-legacy-history.mjs --config PRIVATE_CONFIG.json');
  const config = JSON.parse(await readFile(resolve(process.argv[index + 1]), 'utf8'));
  try { console.log(JSON.stringify(await prepareHistory(config), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[url omitted]') : 'adapter_failed'); process.exitCode = 1; }
}
