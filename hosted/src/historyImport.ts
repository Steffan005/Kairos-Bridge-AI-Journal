// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { KINDS } from "../../src/canonical.js";
import type { HistoricalRecord } from "../../src/journal.js";
import { AccessError } from "./auth.js";

export const MAX_HISTORY_IMPORT_BODY = 512 * 1024;
export const MAX_HISTORY_IMPORT_RECORDS = 50;
const REQUIRED_FIELDS = ["source_store", "source_id", "original_timestamp", "original_actor", "source_file_sha256", "canonical_actor", "timezone", "text"];
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, "kind", "tags", "source_metadata"]);
const METADATA_FIELDS = new Set(["source_context_sha256", "source_record_sha256", "original_record_hash", "original_value_hash", "original_parent_id", "original_parents", "original_timestamp_value", "original_key", "lane", "scope", "recipient", "source_category", "author_conflict", "source_actor", "source_role"]);
const invalid = () => new AccessError(400, "Invalid historical import. Check the record fields and limits.");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const primitive = (value: unknown) => value === null || typeof value === "boolean" || (typeof value === "string" && value.length <= 1024) || (typeof value === "number" && Number.isFinite(value));

/** Owner-only wire envelope. Semantic timestamps, secrets and replay checks live in the journal transaction. */
export function parseHistoryImport(value: unknown): HistoricalRecord[] {
  if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.records)) throw invalid();
  if (value.records.length < 1 || value.records.length > MAX_HISTORY_IMPORT_RECORDS) throw invalid();
  for (const record of value.records) {
    if (!object(record) || REQUIRED_FIELDS.some(field => !(field in record)) || Object.keys(record).some(field => !ALLOWED_FIELDS.has(field))) throw invalid();
    if (!text(record.source_store, 128) || !text(record.source_id, 512) || !text(record.original_timestamp, 128) || !text(record.text, 8000)) throw invalid();
    if (record.original_actor !== null && !text(record.original_actor, 512)) throw invalid();
    if (record.canonical_actor !== null && !text(record.canonical_actor, 64)) throw invalid();
    if (typeof record.source_file_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.source_file_sha256)) throw invalid();
    if (record.timezone !== "unspecified" && record.timezone !== "UTC" && (typeof record.timezone !== "string" || !/^[+-]\d{2}:\d{2}$/.test(record.timezone))) throw invalid();
    if (record.kind !== undefined && !KINDS.includes(record.kind as typeof KINDS[number])) throw invalid();
    if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.length > 16 || !record.tags.every(tag => text(tag, 48)))) throw invalid();
    if (record.source_metadata !== undefined) {
      if (!object(record.source_metadata) || Buffer.byteLength(JSON.stringify(record.source_metadata), "utf8") > 4096) throw invalid();
      if (Object.entries(record.source_metadata).some(([field, value]) => !METADATA_FIELDS.has(field) || !(primitive(value) || (Array.isArray(value) && value.length <= 32 && value.every(primitive))))) throw invalid();
    }
  }
  return value.records as HistoricalRecord[];
}
