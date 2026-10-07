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
import fs from "node:fs";
import path from "node:path";
import { defaultDataDir, expandHome } from "./config.js";

/**
 * Decide where an export may be written when an AI asks for one.
 * Rules (to keep an AI from clobbering files):
 *  - default location: ~/.kairos-journal/exports/journal-<timestamp>.<ext>
 *  - a custom path must be absolute (or start with ~), end in .json or .md,
 *    point into an existing folder owned by the current user, and not already exist.
 */
export function resolveExportPath(requested: string | undefined, format: "json" | "md"): string {
  const ext = format === "json" ? ".json" : ".md";
  if (!requested) {
    const dir = path.join(defaultDataDir(), "exports");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
    return path.join(dir, `journal-${stamp}${ext}`);
  }
  const p = expandHome(requested.trim());
  if (!path.isAbsolute(p)) throw new Error("Export path must be absolute (or start with ~/).");
  const resolved = path.resolve(p);
  if (path.extname(resolved).toLowerCase() !== ext) {
    throw new Error(`Export path must end in ${ext} for format "${format}".`);
  }
  const dir = path.dirname(resolved);
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new Error(`Folder does not exist: ${dir}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a folder: ${dir}`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`Folder is not owned by the current user: ${dir}`);
  }
  if (fs.existsSync(resolved)) {
    throw new Error(`A file already exists at ${resolved}. Exports never overwrite; choose a new name.`);
  }
  return resolved;
}
