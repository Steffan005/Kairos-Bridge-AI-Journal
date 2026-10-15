#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const IMPORT_LIMITS = Object.freeze({ batchRecords: 50, batchBytes: 350 * 1024 - 1, lineBytes: 64 * 1024, baselineBytes: 32 * 1024 * 1024, exportBytes: 2 * 1024 * 1024 * 1024, attempts: 3 });
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(sortJSON(value));
function sortJSON(value) {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJSON(value[key])]));
  return value;
}
export class OwnerImportError extends Error {
  constructor(code, status) { super('Historical owner import could not finish.'); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new OwnerImportError(code, status); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function checkedOrigin(value) {
  let url; try { url = new URL(value); } catch { fail('invalid_origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin !== value.replace(/\/$/, '')) fail('invalid_origin');
  return url.origin;
}
async function privateJSON(file, value, exclusive = true) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
  await chmod(file, 0o600);
}
async function hashFile(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function* boundedLines(file, allowPartialTail = false, maxLineBytes = IMPORT_LIMITS.lineBytes) {
  let pending = Buffer.alloc(0), lineNumber = 0, consumed = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    pending = Buffer.concat([pending, chunk]); let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const bytes = pending.subarray(0, newline); pending = pending.subarray(newline + 1); consumed += newline + 1; lineNumber++;
      if (bytes.length > maxLineBytes) fail('record_line_limit');
      yield { text: bytes.toString('utf8').replace(/\r$/, ''), lineNumber, endOffset: consumed, complete: true };
    }
    if (pending.length > maxLineBytes) fail('record_line_limit');
  }
  if (pending.length) yield { text: pending.toString('utf8'), lineNumber: lineNumber + 1, endOffset: consumed, complete: !allowPartialTail, tailBytes: pending.length };
}
export async function* ownerImportBatches(file) {
  let records = [], bytes = 14, index = 0, firstRecord = 0, recordOffset = 0;
  for await (const line of boundedLines(file)) {
    if (!line.text.trim()) continue;
    let record; try { record = JSON.parse(line.text); } catch { fail('invalid_record_json'); }
    if (!object(record) || typeof record.source_store !== 'string' || typeof record.source_id !== 'string' || !hex(record.source_file_sha256, 64)) fail('invalid_record_identity');
    const length = Buffer.byteLength(JSON.stringify(record), 'utf8') + (records.length ? 1 : 0);
    if (length + 14 > IMPORT_LIMITS.batchBytes) fail('record_body_limit');
    if (records.length && (records.length >= IMPORT_LIMITS.batchRecords || bytes + length > IMPORT_LIMITS.batchBytes)) {
      yield makeBatch(records, index++, firstRecord); records = []; bytes = 14; firstRecord = recordOffset;
    }
    records.push(record); bytes += Buffer.byteLength(JSON.stringify(record), 'utf8') + (records.length > 1 ? 1 : 0); recordOffset++;
  }
  if (records.length) yield makeBatch(records, index, firstRecord);
}
function makeBatch(records, index, offset) {
  const payload = JSON.stringify({ records });
  if (Buffer.byteLength(payload, 'utf8') > IMPORT_LIMITS.batchBytes) fail('batch_body_limit');
  return { records, index, offset, payload, fingerprint: sha(payload), fingerprints: records.map(record => sha(canonical(record))) };
}
async function limitedJSON(response, max = 2 * 1024 * 1024) {
  const chunks = []; let bytes = 0;
  if (!response.body) fail('empty_response');
  for await (const chunk of response.body) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > max) fail('response_limit'); chunks.push(buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_response_json'); }
}
async function fetchBounded(fetchFn, url, init, attempts = IMPORT_LIMITS.attempts, timeout = 30_000) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try { response = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
    catch { if (attempt + 1 === attempts) fail('network_retry_exhausted'); await delay(250 * (attempt + 1)); continue; }
    if (response.status >= 500 && response.status <= 599) {
      await response.body?.cancel(); if (attempt + 1 === attempts) fail('server_retry_exhausted', response.status); await delay(250 * (attempt + 1)); continue;
    }
    if (!response.ok) { await response.body?.cancel(); fail('http_refused', response.status); }
    return response;
  }
  fail('network_retry_exhausted');
}
async function getJSON(fetchFn, origin, cookie, path, max) {
  const response = await fetchBounded(fetchFn, origin + path, { headers: { cookie, accept: 'application/json' } }); return limitedJSON(response, max);
}
function signedEntryFingerprint(entry) {
  const keys = ['seq', 'id', 'created_at', 'tick', 'actor', 'kind', 'text', 'tags', 'parent_hash', 'hash', 'provenance'];
  if (!object(entry) || !hex(entry.id, 16) || !hex(entry.hash, 64) || !Number.isSafeInteger(entry.seq)) fail('invalid_baseline_entry');
  return sha(canonical(Object.fromEntries(keys.filter(key => entry[key] !== undefined).map(key => [key, entry[key]]))));
}
async function checkKnownEntries(fetchFn, origin, cookie, entries) {
  for (const entry of entries) {
    const page = await getJSON(fetchFn, origin, cookie, '/api/journal/search?mode=id&q=' + entry.id + '&limit=1', 64 * 1024);
    if (!Array.isArray(page.entries) || page.entries.length !== 1 || signedEntryFingerprint(page.entries[0]) !== signedEntryFingerprint(entry)) fail('baseline_owner_or_entry_mismatch');
  }
}
function connectionsFingerprint(connections) {
  if (!Array.isArray(connections) || connections.some(item => !object(item) || typeof item.clientId !== 'string' || !Array.isArray(item.scopes) || item.scopes.some(scope => typeof scope !== 'string'))) fail('invalid_owner_state');
  const normalized = connections.map(item => ({ clientId: item.clientId, scopes: [...item.scopes].sort() })).sort((a, b) => a.clientId.localeCompare(b.clientId));
  return { connections: normalized, fingerprint: sha(canonical(normalized)) };
}
async function downloadOwnerExport(fetchFn, origin, cookie, destination) {
  const temporary = destination + '.partial';
  for (let attempt = 0; attempt < IMPORT_LIMITS.attempts; attempt++) {
    const hash = createHash('sha256'); let bytes = 0;
    try {
      const response = await fetchBounded(fetchFn, origin + '/api/journal/export', { headers: { cookie, accept: 'application/json' } }, 1, 120_000);
      if (!response.body) fail('empty_export');
      const contentLength = Number(response.headers.get('content-length') ?? 0); if (contentLength > IMPORT_LIMITS.exportBytes) fail('export_limit');
      const measure = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > IMPORT_LIMITS.exportBytes) return callback(new OwnerImportError('export_limit')); hash.update(chunk); callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      await rename(temporary, destination); await chmod(destination, 0o600); return { bytes, sha256: hash.digest('hex') };
    } catch (error) {
      await rm(temporary, { force: true });
      if (error instanceof OwnerImportError && !['network_retry_exhausted', 'server_retry_exhausted'].includes(error.code)) throw error;
      if (attempt + 1 === IMPORT_LIMITS.attempts) fail('export_retry_exhausted'); await delay(250 * (attempt + 1));
    }
  }
}
async function readAcknowledgments(file, output) {
  const ledger = new Map(); let lastEnd = 0;
  try { await stat(file); } catch (error) { if (error.code === 'ENOENT') return ledger; throw error; }
  for await (const line of boundedLines(file, true, IMPORT_LIMITS.batchBytes)) {
    if (!line.complete) {
      await privateJSON(join(output, `ledger-tail-repair-${Date.now()}.json`), { discarded_bytes: line.tailBytes, tail_sha256: sha(line.text) });
      await truncate(file, lastEnd); break;
    }
    lastEnd = line.endOffset;
    let row; try { row = JSON.parse(line.text); } catch { fail('invalid_acknowledgment_ledger'); }
    if (!object(row) || !Number.isSafeInteger(row.batch_index) || ledger.has(row.batch_index) || !hex(row.batch_sha256, 64) || !Array.isArray(row.records) || row.records.length > 50 || row.records.some(record => !hex(record.record_sha256, 64) || !hex(record.entry_id, 16)) || !Number.isSafeInteger(row.inserted) || !Number.isSafeInteger(row.skipped) || row.inserted < 0 || row.skipped < 0 || row.inserted + row.skipped !== row.records.length) fail('invalid_acknowledgment_ledger');
    ledger.set(row.batch_index, row);
  }
  return ledger;
}
async function appendAcknowledgment(file, row) {
  const descriptor = await open(file, 'a', 0o600);
  try { await descriptor.writeFile(JSON.stringify(row) + '\n'); await descriptor.sync(); }
  finally { await descriptor.close(); }
  await chmod(file, 0o600);
}
export async function runOwnerHistoryImport(options, dependencies = {}) {
  const started = Date.now(), fetchFn = dependencies.fetchFn ?? fetch, progress = dependencies.progress ?? (() => {});
  const origin = checkedOrigin(options.origin), output = resolve(options.output), recordsFile = resolve(options.records), baselineFile = resolve(options.baseline);
  if (options.revision !== undefined && !hex(options.revision, 40)) fail('invalid_revision');
  const credentialStat = await stat(options.credentials); if (!credentialStat.isFile() || credentialStat.size > 64 * 1024 || (credentialStat.mode & 0o077)) fail('credentials_not_private');
  let credential; try { credential = JSON.parse(await readFile(options.credentials, 'utf8')); } catch { fail('invalid_credentials_file'); }
  const cookie = credential.cookie;
  if (typeof cookie !== 'string' || !cookie.trim() || cookie.length > 16 * 1024 || /[\r\n]/.test(cookie)) fail('invalid_owner_cookie');
  credential = undefined;
  const baselineStat = await stat(baselineFile); if (!baselineStat.isFile() || baselineStat.size > IMPORT_LIMITS.baselineBytes) fail('baseline_limit');
  let baseline; try { baseline = JSON.parse(await readFile(baselineFile, 'utf8')); } catch { fail('invalid_baseline_json'); }
  if (!object(baseline) || baseline.chain_ok !== true || !Array.isArray(baseline.entries) || baseline.entries.length < 1 || baseline.entry_count !== baseline.entries.length || !hex(baseline.head_hash, 64) || new Set(baseline.entries.map(entry => entry.id)).size !== baseline.entries.length) fail('invalid_baseline_export');
  baseline.entries.forEach(signedEntryFingerprint);
  const inputSHA = await hashFile(recordsFile), baselineSHA = await hashFile(baselineFile);
  await mkdir(output, { recursive: true, mode: 0o700 }); const outputStat = await lstat(output); if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) fail('unsafe_output_directory'); await chmod(output, 0o700);
  const stateFile = join(output, 'import-state.json'), ledgerFile = join(output, 'acknowledgments.jsonl');
  let state;
  if (options.resume) {
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch { fail('missing_resume_state'); }
    if (state.version !== 1 || state.origin !== origin || state.records_sha256 !== inputSHA || state.baseline_sha256 !== baselineSHA || state.expected_revision !== (options.revision ?? null) || !Number.isSafeInteger(state.initial_count) || state.initial_count < baseline.entries.length || connectionsFingerprint(state.initial_connections).fingerprint !== state.connections_sha256) fail('resume_input_mismatch');
  } else {
    try { await stat(stateFile); fail('output_already_initialized'); } catch (error) { if (error instanceof OwnerImportError || error.code !== 'ENOENT') throw error; }
  }
  const about = await getJSON(fetchFn, origin, cookie, '/about', 32 * 1024);
  if (options.revision && (typeof about.source !== 'string' || !about.source.endsWith('/tree/' + options.revision))) fail('deployed_revision_mismatch');
  const observed = await getJSON(fetchFn, origin, cookie, '/api/journal');
  if (observed.deleted !== false || !Number.isSafeInteger(observed.count) || observed.count < baseline.entries.length) fail('invalid_owner_state');
  const connections = connectionsFingerprint(observed.connections);
  await checkKnownEntries(fetchFn, origin, cookie, baseline.entries);
  if (!state) {
    state = { version: 1, origin, records_sha256: inputSHA, baseline_sha256: baselineSHA, expected_revision: options.revision ?? null, initial_count: observed.count, baseline_entries: baseline.entries.length, initial_connections: connections.connections, connections_sha256: connections.fingerprint, created_at: new Date().toISOString() };
    await privateJSON(stateFile, state); await copyFile(baselineFile, join(output, 'known-baseline-export.json'), constants.COPYFILE_EXCL); await chmod(join(output, 'known-baseline-export.json'), 0o600);
  } else if (state.connections_sha256 !== connections.fingerprint) fail('connections_changed_before_resume');
  const planFile = join(output, 'records-input.jsonl');
  try { await copyFile(recordsFile, planFile, constants.COPYFILE_EXCL); await chmod(planFile, 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if ((await lstat(planFile)).isSymbolicLink() || await hashFile(planFile) !== inputSHA) fail('private_plan_snapshot_mismatch');
  const ledger = await readAcknowledgments(ledgerFile, output);
  const acknowledgedInserted = [...ledger.values()].reduce((sum, row) => sum + row.inserted, 0);
  if (observed.count < state.initial_count + acknowledgedInserted) fail('journal_count_below_acknowledged_minimum');
  const runID = Date.now().toString() + '-' + randomBytes(4).toString('hex');
  const preExport = await downloadOwnerExport(fetchFn, origin, cookie, join(output, `pre-import-owner-export-${runID}.json`));
  await privateJSON(join(output, `preflight-${runID}.json`), { observed_count: observed.count, baseline_entries: baseline.entries.length, connections: connections.connections, pre_export: preExport, started_at: new Date().toISOString() });
  let processed = 0, inserted = 0, skipped = 0, batches = 0;
  for await (const batch of ownerImportBatches(planFile)) {
    let acknowledgment = ledger.get(batch.index);
    if (acknowledgment) {
      if (acknowledgment.batch_sha256 !== batch.fingerprint || acknowledgment.records.length !== batch.records.length || acknowledgment.records.some((row, i) => row.record_sha256 !== batch.fingerprints[i])) fail('resume_batch_mismatch');
    } else {
      let result;
      for (let attempt = 0; attempt < IMPORT_LIMITS.attempts; attempt++) {
        const response = await fetchBounded(fetchFn, origin + '/api/journal/import-history', { method: 'POST', headers: { cookie, origin, accept: 'application/json', 'content-type': 'application/json' }, body: batch.payload });
        try {
          result = await limitedJSON(response, 32 * 1024);
          if (!object(result) || !Number.isSafeInteger(result.inserted) || !Number.isSafeInteger(result.skipped) || result.inserted < 0 || result.skipped < 0 || result.inserted + result.skipped !== batch.records.length || !Array.isArray(result.ids) || result.ids.length !== batch.records.length || result.ids.some(id => !hex(id, 16)) || !hex(result.headHash, 64)) fail('invalid_import_acknowledgment');
          break;
        } catch { if (attempt + 1 === IMPORT_LIMITS.attempts) fail('ambiguous_import_acknowledgment'); await delay(250 * (attempt + 1)); }
      }
      acknowledgment = { batch_index: batch.index, first_record: batch.offset, batch_sha256: batch.fingerprint, acknowledged_at: new Date().toISOString(), inserted: result.inserted, skipped: result.skipped, head_hash: result.headHash,
        records: batch.records.map((record, i) => ({ source_store: record.source_store, source_id: record.source_id, source_file_sha256: record.source_file_sha256, ...(record.source_metadata?.source_record_sha256 ? { source_record_sha256: record.source_metadata.source_record_sha256 } : {}), record_sha256: batch.fingerprints[i], entry_id: result.ids[i] })) };
      await appendAcknowledgment(ledgerFile, acknowledgment); ledger.set(batch.index, acknowledgment);
    }
    processed += batch.records.length; inserted += acknowledgment.inserted; skipped += acknowledgment.skipped; batches++;
    if (batches % 10 === 0) progress({ acknowledged_records: processed, inserted, skipped, elapsed_ms: Date.now() - started });
  }
  if (!batches || ledger.size !== batches) fail('empty_or_changed_record_plan');
  const after = await getJSON(fetchFn, origin, cookie, '/api/journal');
  if (after.deleted !== false || !Number.isSafeInteger(after.count) || after.count < state.initial_count + inserted) fail('post_import_count_mismatch');
  if (connectionsFingerprint(after.connections).fingerprint !== state.connections_sha256) fail('connections_changed_during_import');
  await checkKnownEntries(fetchFn, origin, cookie, baseline.entries);
  const postExport = await downloadOwnerExport(fetchFn, origin, cookie, join(output, `post-import-owner-export-${runID}.json`));
  const report = { version: 1, acknowledged_records: processed, inserted, skipped, batches, baseline_entries_preserved: baseline.entries.length, connections_preserved: connections.connections.length, initial_count: state.initial_count, observed_count: after.count, expected_minimum_count: state.initial_count + inserted, post_export: postExport, elapsed_ms: Date.now() - started, completed_at: new Date().toISOString(), verification: 'Owner baseline signed fields and connection metadata matched. Verify the downloaded export chain and every imported provenance/ID independently before accepting the migration.' };
  await privateJSON(join(output, `owner-import-report-${runID}.json`), report); return report;
}

function argumentsFor(argv) {
  const result = {}; const allowed = new Set(['origin', 'credentials', 'records', 'baseline', 'output', 'revision']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (argv[i] === '--resume') { result.resume = true; continue; }
    if (!argv[i].startsWith('--') || !allowed.has(name) || result[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_arguments');
    result[name] = argv[++i];
  }
  if (!['origin', 'credentials', 'records', 'baseline', 'output'].every(name => result[name])) fail('missing_arguments'); return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runOwnerHistoryImport(argumentsFor(process.argv.slice(2)), { progress: value => process.stdout.write(JSON.stringify(value) + '\n') });
    process.stdout.write(JSON.stringify({ acknowledged_records: report.acknowledged_records, inserted: report.inserted, skipped: report.skipped, observed_count: report.observed_count, elapsed_ms: report.elapsed_ms }) + '\n');
  } catch (error) {
    process.stderr.write(`Historical owner import stopped (${error instanceof OwnerImportError ? error.code + (error.status ? ':' + error.status : '') : 'local_operation_failed'}). Keep the private receipts; fix the cause and resume with the identical input.\n`); process.exitCode = 1;
  }
}
