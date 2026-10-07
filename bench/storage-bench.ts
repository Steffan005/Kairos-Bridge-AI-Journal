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
/**
 * Storage + latency benchmark.
 *
 *   node dist/bench/storage-bench.js [--entries 300000] [--keep]
 *
 * Inserts N synthetic but realistic journal entries (mixed lengths, average
 * ~500-1,000 characters) through the real hash-chain write path into a temp
 * journal, then measures file size on disk, bytes per entry, and how fast
 * wake / search / verify / single writes are.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Journal, type WriteInput } from "../src/journal.js";
import type { Kind } from "../src/canonical.js";

const args = process.argv.slice(2);
const N = Number(args[args.indexOf("--entries") + 1] || 0) || 300_000;
const KEEP = args.includes("--keep");
const BATCH = 5_000;

// ---------- deterministic pseudo-random generator ----------
let seed = 0x9e3779b9;
function rand(): number {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x100000000;
}
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];

// ---------- vocabulary: common words + domain words + many rarer tokens ----------
const COMMON = `the a and to of in is it that for on with as was at be this have from or by not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know get through back much go good new write our me man too any day same right look think also around another came come work three word must because does part even place well such here take why things help put years different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always looked show large often together asked house world going want school important until form food keep children feet land side without boy once animals life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light parts country father let night following picture being study second eyes soon times story boys since white days ever paper hard near sentence better best across during today others however sure means knew try told young miles sun ways thing whole hear example heard several change answer room sea against top turned learn point city play toward five using himself usually money seen car morning bed reason`.split(/\s+/);
const DOMAIN = `prefers decided remembers mentioned project patent filing deadline journal memory connector server laptop phone meeting call email draft budget invoice trip flight hotel airport grandma family dinner recipe garden truck drive road weather doctor appointment workout running coffee tea breakfast schedule calendar reminder birthday anniversary gift review contract partner investor demo video launch plan roadmap feature bug fix release website domain hosting backup export privacy settings password-free sync folder spreadsheet notes summary decision preference fact conversation session assistant claude chatgpt grok gemini cursor terminal script database index search wake verify chain hash entry write read update correction lesson insight idea question answer explain simple plain language small talk pitch one-pager outline slide deck customer market pricing free tier storage cost tiny kilobyte megabyte gigabyte`.split(/\s+/);
// ~8,000 rarer tokens (names, places, product words) so the full-text index sees a realistic vocabulary
const SYL = ["ka", "ri", "to", "men", "sa", "lo", "vi", "dan", "el", "or", "qu", "zen", "ta", "mi", "ro", "ber", "sh", "an", "is", "ul", "ford", "ville", "son", "ton"];
const RARE: string[] = [];
for (let i = 0; i < 8000; i++) {
  const n = 2 + Math.floor(rand() * 3);
  let w = "";
  for (let k = 0; k < n; k++) w += pick(SYL);
  RARE.push(i % 3 === 0 ? w[0].toUpperCase() + w.slice(1) : w);
}
// Zipf-ish draw: frequent words dominate, long tail of rare ones
const VOCAB = [...COMMON, ...DOMAIN, ...RARE];
function word(): string {
  const r = rand();
  if (r < 0.62) return COMMON[Math.floor(Math.pow(rand(), 2.2) * COMMON.length)];
  if (r < 0.86) return pick(DOMAIN);
  if (r < 0.97) return RARE[Math.floor(Math.pow(rand(), 1.5) * RARE.length)];
  return String(Math.floor(rand() * 1_000)); // short numbers (times, counts, prices)
}
function sentence(): string {
  const len = 6 + Math.floor(rand() * 16);
  const ws: string[] = [];
  for (let i = 0; i < len; i++) ws.push(word());
  let s = ws.join(" ");
  s = s[0].toUpperCase() + s.slice(1);
  if (rand() < 0.2) s = s.replace(/ (\w+) /, " $1, ");
  return s + (rand() < 0.9 ? "." : "?");
}
/** Target length drawn from a skewed distribution: many short notes, some long summaries. */
function targetLength(): number {
  const r = rand();
  if (r < 0.30) return 120 + rand() * 280; //  30% short notes    120-400
  if (r < 0.75) return 400 + rand() * 600; //  45% medium         400-1000
  if (r < 0.95) return 1000 + rand() * 800; // 20% long          1000-1800
  return 1800 + rand() * 1700; //               5% session summary 1800-3500
}
function text(): string {
  const target = targetLength();
  let t = "";
  while (t.length < target) t += (t ? " " : "") + sentence();
  return t;
}
const KINDS: Kind[] = ["note", "note", "note", "fact", "fact", "preference", "decision", "summary"];
const ACTORS = ["claude", "chatgpt", "grok", "gemini", "cursor", "steffan"];
const TAGS = ["travel", "family", "work", "patent", "health", "money", "food", "tech", "ideas", "people", "home", "learning"];

function makeEntry(i: number, startMs: number): WriteInput {
  const tags: string[] = [];
  const nt = Math.floor(rand() * 4);
  for (let k = 0; k < nt; k++) tags.push(pick(TAGS));
  return {
    text: text(),
    kind: pick(KINDS),
    actor: pick(ACTORS),
    tags,
    pin: i % 15_000 === 0, // ~20 pinned identity entries
    nowMs: startMs + i * 105_000, // spread over about a year
  };
}

// ---------- stats helpers ----------
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const r2 = (x: number) => Math.round(x * 100) / 100;
function timeIt(fn: () => unknown, runs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}
const summary = (xs: number[]) => ({ p50_ms: r2(pct(xs, 50)), p95_ms: r2(pct(xs, 95)), max_ms: r2(Math.max(...xs)) });
const size = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
const MB = (b: number) => r2(b / 1024 / 1024);

// ---------- run ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kj-bench-"));
const dbPath = path.join(dir, "journal.db");
console.error(`Benchmark: ${N.toLocaleString()} entries -> ${dbPath}`);
let j = Journal.open(dbPath);

const startMs = Date.UTC(2025, 10, 5);
let textChars = 0;
let textBytes = 0;
let lengths: number[] = [];
const tInsert0 = performance.now();
for (let done = 0; done < N; done += BATCH) {
  const batch: WriteInput[] = [];
  for (let i = done; i < Math.min(N, done + BATCH); i++) {
    const e = makeEntry(i, startMs);
    textChars += e.text.length;
    textBytes += Buffer.byteLength(e.text, "utf8");
    lengths.push(e.text.length);
    batch.push(e);
  }
  j.writeMany(batch);
  if ((done / BATCH) % 10 === 0) console.error(`  ${(done + batch.length).toLocaleString()} written`);
}
const insertSec = (performance.now() - tInsert0) / 1000;
j.checkpoint();

const dbBytes = size(dbPath);
const walBytes = size(dbPath + "-wal");
const totalBytes = dbBytes + walBytes + size(dbPath + "-shm");

// space breakdown by table (SQLite dbstat)
const parts = j.db
  .prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC")
  .all() as Array<{ name: string; bytes: number }>;
const ftsBytes = parts.filter((p) => p.name.startsWith("entries_fts")).reduce((a, p) => a + p.bytes, 0);
const entriesBytes = parts.filter((p) => !p.name.startsWith("entries_fts")).reduce((a, p) => a + p.bytes, 0);

// Re-open (as a fresh MCP server would) and measure first wake (cold-ish: OS cache is still warm)
j.close();
const tOpen = performance.now();
j = Journal.open(dbPath);
const openMs = performance.now() - tOpen;
const firstWake = timeIt(() => j.wake(), 1)[0];
const wake = timeIt(() => j.wake(), 200);
const wakeBig = timeIt(() => j.wake({ recent: 200, maxChars: 50_000 }), 50);
const b = j.wake();

// search: mix of common words, domain words, rare words, multi-word
const queries: string[] = [];
for (let i = 0; i < 40; i++) queries.push(pick(DOMAIN));
for (let i = 0; i < 40; i++) queries.push(RARE[Math.floor(rand() * 2000)]);
for (let i = 0; i < 40; i++) queries.push(`${pick(DOMAIN)} ${pick(DOMAIN)}`);
for (let i = 0; i < 20; i++) queries.push(`${pick(COMMON.slice(0, 50))}`); // very common words (worst case)
for (let i = 0; i < 20; i++) queries.push(`${pick(DOMAIN)} ${RARE[Math.floor(rand() * 8000)]} ${pick(DOMAIN)}`);
const searchTimes: number[] = [];
let hits = 0;
for (const q of queries) {
  const t0 = performance.now();
  hits += j.search(q, { limit: 10 }).length;
  searchTimes.push(performance.now() - t0);
}
const commonTimes = searchTimes.slice(120, 140);

const tv = performance.now();
const v = j.verify();
const verifySec = (performance.now() - tv) / 1000;

// single writes the way an AI would do them (one transaction + fsync each)
const single = timeIt(() => j.write({ text: text(), kind: "note", actor: "bench" }), 200);

// export size
const exportPath = path.join(dir, "export.json");
const te = performance.now();
const exp = j.exportTo(exportPath, "json");
const exportSec = (performance.now() - te) / 1000;
j.close();

lengths.sort((a, b2) => a - b2);
const result = {
  date: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, ram_gb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, node: process.version },
  entries: N,
  text: {
    avg_chars: Math.round(textChars / N),
    median_chars: lengths[Math.floor(N / 2)],
    min_chars: lengths[0],
    max_chars: lengths[N - 1],
    total_text_mb: MB(textBytes),
  },
  storage: {
    file_bytes: totalBytes,
    file_mb: MB(totalBytes),
    bytes_per_entry: Math.round(totalBytes / N),
    raw_text_bytes_per_entry: Math.round(textBytes / N),
    overhead_ratio: r2(totalBytes / textBytes),
    entries_table_and_indexes_mb: MB(entriesBytes),
    full_text_index_mb: MB(ftsBytes),
    wal_bytes_after_checkpoint: walBytes,
    json_export_mb: MB(exp.bytes),
    per_table: parts.map((p) => ({ name: p.name, mb: MB(p.bytes) })),
  },
  latency: {
    insert_entries_per_sec: Math.round(N / insertSec),
    insert_total_sec: r2(insertSec),
    open_ms: r2(openMs),
    wake_first_ms: r2(firstWake),
    wake_default: summary(wake),
    wake_briefing_chars: b.chars,
    wake_max_size: summary(wakeBig),
    search_all: { queries: queries.length, ...summary(searchTimes), avg_hits: r2(hits / queries.length) },
    search_very_common_words: summary(commonTimes),
    single_write_with_fsync: summary(single),
    verify_full_chain_sec: r2(verifySec),
    verify_ok: v.ok,
    export_json_sec: r2(exportSec),
  },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../../bench-results");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `storage-bench-${N}.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
console.error(`Saved ${outFile}`);
if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
else console.error(`Kept ${dir}`);
