#!/usr/bin/env node
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
import { Journal } from "./journal.js";
import { resolveDbPath, expandHome, DB_ENV } from "./config.js";
import { resolveExportPath } from "./exportPath.js";
import { SERVER_VERSION } from "./tools.js";
import { about, legalNoticeText } from "./about.js";

const HELP = `kairos-journal ${SERVER_VERSION}: manage your AI memory journal

Usage:
  kairos-journal init                 Create the journal file if it does not exist
  kairos-journal stats                Entry count, size on disk, who wrote what
  kairos-journal verify               Check every entry's fingerprint and chain link
  kairos-journal export [--format json|md] [--out PATH] [--force]
  kairos-journal path                 Print where the journal lives
  kairos-journal about                License, copyright and where to get the source

Global option:
  --db PATH    Use this journal file (default ~/.kairos-journal/journal.db, or $${DB_ENV})
`;

function human(bytes: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function take(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  argv.splice(i, 2);
  return v;
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP + "\n" + legalNoticeText(SERVER_VERSION) + "\n");
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write(SERVER_VERSION + "\n" + legalNoticeText(SERVER_VERSION) + "\n");
    return 0;
  }
  const db = take(argv, "--db");
  const cmd = argv.shift();
  const dbPath = resolveDbPath(db);

  switch (cmd) {
    case "about": {
      const a = about(SERVER_VERSION);
      process.stdout.write(
        [
          `${a.name} (${a.attribution}). Version ${a.version}.`,
          a.copyright,
          `License: ${a.license.spdx} (${a.license.name})`,
          `  ${a.license.url}  |  full text: ${a.license.file}`,
          a.additionalTerms,
          a.warranty,
          `Source: ${a.source.howToGet}`,
          `Commercial licensing: ${a.commercialLicensing.summary}`,
          a.patent,
        ].join("\n") + "\n",
      );
      return 0;
    }
    case "path":
      process.stdout.write(dbPath + "\n");
      return 0;
    case "init": {
      const existed = fs.existsSync(dbPath);
      const j = Journal.open(dbPath);
      const n = j.count();
      j.close();
      process.stdout.write(existed ? `Journal already exists at ${dbPath} (${n} entries).\n` : `Created a new journal at ${dbPath}\n`);
      return 0;
    }
    case "stats": {
      if (!fs.existsSync(dbPath)) {
        process.stdout.write(`No journal yet at ${dbPath}. Run "kairos-journal init".\n`);
        return 1;
      }
      const j = Journal.open(dbPath);
      const s = j.stats();
      j.close();
      const lines = [
        `Journal:      ${s.path}`,
        `Entries:      ${s.entries} (${s.pinned} pinned)`,
        `Size on disk: ${human(s.fileBytes)} (${s.fileBytes} bytes)${s.entries >= 1000 ? `, about ${Math.round(s.fileBytes / s.entries)} bytes per entry` : ""}`,
        `First entry:  ${s.firstAt ?? "-"}`,
        `Last entry:   ${s.lastAt ?? "-"}`,
        `By author:    ${Object.entries(s.byActor).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`,
        `By kind:      ${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`,
        `Chain head:   ${s.headHash}`,
      ];
      process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }
    case "verify": {
      if (!fs.existsSync(dbPath)) {
        process.stdout.write(`No journal at ${dbPath}.\n`);
        return 1;
      }
      const j = Journal.open(dbPath);
      const t0 = performance.now();
      const r = j.verify();
      const ms = performance.now() - t0;
      j.close();
      if (r.ok) {
        process.stdout.write(`OK: all ${r.checked} entries intact (checked in ${ms.toFixed(0)} ms).\nChain head: ${r.headHash}\n`);
        return 0;
      }
      process.stdout.write(
        `BROKEN: ${r.checked} entries check out, then entry #${r.firstBroken!.seq}${r.firstBroken!.id ? ` (id ${r.firstBroken!.id})` : ""} fails:\n  ${r.firstBroken!.reason}\n`,
      );
      return 2;
    }
    case "export": {
      const format = (take(argv, "--format") ?? "json") as "json" | "md";
      if (format !== "json" && format !== "md") throw new Error("--format must be json or md");
      const out = take(argv, "--out");
      const force = argv.includes("--force");
      const j = Journal.open(dbPath);
      let target: string;
      if (out && force) target = path.resolve(expandHome(out));
      else target = resolveExportPath(out ? path.resolve(expandHome(out)) : undefined, format);
      const r = j.exportTo(target, format, force);
      j.close();
      process.stdout.write(`Exported ${r.entries} entries to ${r.path} (${human(r.bytes)}). Chain ${r.chainOk ? "intact" : "BROKEN"}.\n`);
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`kairos-journal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
