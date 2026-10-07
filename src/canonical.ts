// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Kairos Journal: a portable, user-owned memory journal for AI apps, served over MCP.
 * Copyright (C) 2026  Steffan Douglas Haskins
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Additional terms under AGPLv3 section 7(b) apply: the notice
 * "Kairos Journal, created by Steffan Douglas Haskins" and the copyright
 * notice above must be preserved. See the NOTICE file for the full terms.
 */
import { createHash } from "node:crypto";

/** The parent_hash of the very first entry in a journal. */
export const GENESIS_HASH = "0".repeat(64);

/** Bumped only if the canonical form ever changes; it is part of every hash. */
export const CHAIN_VERSION = "kairos-journal/v1";

/** Length of one tick in milliseconds. tick = floor(unix_ms / 25). */
export const TICK_MS = 25;

export const KINDS = ["note", "fact", "preference", "decision", "summary"] as const;
export type Kind = (typeof KINDS)[number];

/** The fields that are covered by an entry's hash. */
export interface HashedFields {
  id: string;
  created_at: string; // ISO 8601 UTC, e.g. 2026-10-07T14:42:00.123Z
  tick: number; // floor(unix_ms / 25)
  actor: string;
  kind: Kind;
  text: string;
  tags: string[];
  parent_hash: string; // previous entry's hash, or GENESIS_HASH
}

/**
 * Canonical serialization: a JSON array with a fixed field order, so the same
 * entry always produces the same bytes regardless of object key order.
 *
 *   ["kairos-journal/v1", id, created_at, tick, actor, kind, text, [tags...], parent_hash]
 *
 * JSON.stringify of strings/integers/arrays is deterministic in every
 * spec-compliant JS engine, and easy to reproduce in any other language.
 */
export function canonicalize(f: HashedFields): string {
  return JSON.stringify([
    CHAIN_VERSION,
    f.id,
    f.created_at,
    f.tick,
    f.actor,
    f.kind,
    f.text,
    f.tags,
    f.parent_hash,
  ]);
}

export function hashEntry(f: HashedFields): string {
  return createHash("sha256").update(canonicalize(f), "utf8").digest("hex");
}

export function tickFromMs(ms: number): number {
  return Math.floor(ms / TICK_MS);
}
