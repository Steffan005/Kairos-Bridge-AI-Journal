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
import os from "node:os";
import path from "node:path";

/** Environment variable that overrides where the journal file lives. */
export const DB_ENV = "KAIROS_JOURNAL_DB";
/** Environment variable that sets the default "actor" name for entries written through this server. */
export const ACTOR_ENV = "KAIROS_JOURNAL_ACTOR";
/** Environment variable holding the bearer token required in HTTP mode (optional). */
export const TOKEN_ENV = "KAIROS_JOURNAL_TOKEN";
/** Comma-separated extra Host header values accepted in HTTP mode (for a tunnel's hostname). */
export const ALLOWED_HOSTS_ENV = "KAIROS_JOURNAL_ALLOWED_HOSTS";

export function defaultDataDir(): string {
  return path.join(os.homedir(), ".kairos-journal");
}

/** Resolve the journal path: explicit flag > env var > ~/.kairos-journal/journal.db */
export function resolveDbPath(explicit?: string): string {
  const raw = explicit || process.env[DB_ENV] || path.join(defaultDataDir(), "journal.db");
  return path.resolve(expandHome(raw));
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}
