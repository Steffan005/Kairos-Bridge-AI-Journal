// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
import { type Entry, type Journal } from "./journal.js";
import { normalizeContinuityActor, normalizeProjectTag } from "./continuity.js";

export interface ProjectBriefingOptions {
  /** Select the recipient of handoffs; shared records retain all their authors. */
  actor?: string;
  limit?: number;
  maxChars?: number;
}

type SectionKey = "goal" | "decisions" | "questions" | "next_actions" | "handoffs" | "recent";
export interface ProjectBriefing {
  projectTag: string;
  text: string;
  included: number;
  truncated: boolean;
  actor?: string;
  sections: Array<{ key: SectionKey; ids: string[] }>;
}

interface Candidate { id: string; kind: string; role: string | null }
interface Section { key: SectionKey; title: string; empty: string; where: string }
interface DisplayRecord { entry: Entry; section: SectionKey; prefix: string; body: string }

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("Briefing limits must be finite numbers");
  return Math.max(min, Math.min(Math.floor(value), max));
}

function sectionFor(candidate: Candidate): SectionKey {
  switch (candidate.role) {
    case "goal": return "goal";
    case "decision": return "decisions";
    case "question": return "questions";
    case "next_action": return "next_actions";
    case "handoff": return "handoffs";
    default: return candidate.role === null && ["decision", "preference"].includes(candidate.kind) ? "decisions" : "recent";
  }
}

/** Keep provenance complete: a record that cannot fit is omitted as a whole. */
function displayRecord(entry: Entry, section: SectionKey): DisplayRecord {
  // These labels share a compact delimiter format with server-assigned origin.
  // Preserve arbitrary attribution/source values as reversible JSON strings,
  // escaping structural delimiters and Unicode line separators as well.
  const quoted = (value: string) => JSON.stringify(value).replace(/[;\[\]\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const provenance = entry.provenance;
  const fields = [`id=${entry.id}`, provenance?.original_timestamp ?? entry.created_at, `author=${quoted(entry.actor)}`];
  if (entry.continuity?.actor_id) fields.push(`actor_id=${quoted(entry.continuity.actor_id)}`);
  if (provenance) {
    fields.push(`source=${quoted(provenance.source_store)}:${quoted(provenance.source_id)}`);
    fields.push(provenance.timezone === "unspecified" ? "timezone unspecified" : `timezone=${quoted(provenance.timezone)}`);
  }
  if (entry.write_origin) {
    const connector = entry.write_origin.provider ?? (entry.write_origin.channel === "owner" ? "owner" : "unspecified");
    fields.push(`connector=${connector}/${entry.write_origin.channel}`);
  }
  if (entry.continuity?.recipient) fields.push(`to=${quoted(entry.continuity.recipient)}`);
  return { entry, section, prefix: `\n- [${fields.join("; ")}] `, body: entry.text.replace(/\s+/g, " ").trim() };
}

/**
 * A deterministic retrieval view, not a generated summary or a claim that a
 * recorded decision remains correct. SQL returns bounded ID pools per section;
 * at most `limit` complete records are loaded into JavaScript.
 */
export function buildProjectBriefing(journal: Journal, project: string, opts: ProjectBriefingOptions = {}): ProjectBriefing {
  const projectTag = normalizeProjectTag(project);
  const actor = opts.actor === undefined ? undefined : normalizeContinuityActor(opts.actor);
  const limit = bounded(opts.limit, 20, 1, 50);
  const maxChars = bounded(opts.maxChars, 6000, 200, 50_000);
  const columns = new Set((journal.db.pragma("table_info(entries)") as Array<{ name: string }>).map(column => column.name));
  const structured = columns.has("continuity_json");
  const role = structured ? "json_extract(e.continuity_json, '$.role')" : "NULL";
  const legacy = structured ? "e.continuity_json IS NULL" : "1";
  const chronology = columns.has("chronology_key") ? "COALESCE(e.chronology_key, rtrim(e.created_at, 'Z'))" : "rtrim(e.created_at, 'Z')";
  const addressed = !structured ? "1" : actor === undefined
    ? `COALESCE(${role}, '') <> 'handoff'`
    : `(COALESCE(${role}, '') <> 'handoff' OR json_extract(e.continuity_json, '$.recipient') = @actor)`;
  // A later correction stays effective even if that correction is itself
  // superseded. Otherwise older decisions would silently reappear.
  const active = !structured ? "1" : `NOT EXISTS (
    SELECT 1 FROM entries s
    WHERE s.continuity_json IS NOT NULL AND s.seq > e.seq
      AND json_extract(s.continuity_json, '$.version') = 1
      AND EXISTS (SELECT 1 FROM json_each(s.tags) st WHERE st.value = @tag)
      AND (
        EXISTS (SELECT 1 FROM json_each(s.continuity_json, '$.supersedes') ref WHERE ref.value = e.id)
        OR (${role} IN ('question', 'next_action', 'handoff') AND
          EXISTS (SELECT 1 FROM json_each(s.continuity_json, '$.resolves') ref WHERE ref.value = e.id))
      )
  )`;
  const sections: Section[] = [
    { key: "goal", title: "Recorded goal", empty: "No structured goal recorded.", where: `${role} = 'goal'` },
    { key: "decisions", title: "Recorded decisions / preferences", empty: "None recorded.", where: `(${role} = 'decision' OR (${legacy} AND e.kind IN ('decision', 'preference')))` },
    { key: "questions", title: "Open structured questions", empty: "None recorded.", where: `${role} = 'question'` },
    { key: "next_actions", title: "Open structured next actions", empty: "None recorded.", where: `${role} = 'next_action'` },
    { key: "handoffs", title: actor ? `Latest handoffs to ${actor}` : "Addressed handoffs", empty: actor ? "None recorded for this actor." : "An actor is needed to select addressed handoffs.", where: actor ? `${role} = 'handoff'` : "0" },
    { key: "recent", title: "Recent project activity", empty: "None recorded.", where: `(COALESCE(${role}, '') NOT IN ('goal', 'decision', 'question', 'next_action', 'handoff') AND NOT (${legacy} AND e.kind IN ('decision', 'preference')))` },
  ];
  const terms = projectTag.match(/[\p{L}\p{N}_]+/gu)!;
  const query = (where: string, count: number): Candidate[] => journal.db.prepare(`
    SELECT e.id, e.kind, ${role} AS role
    FROM entries_fts JOIN entries e ON e.seq = entries_fts.rowid
    WHERE entries_fts MATCH @q
      AND EXISTS (SELECT 1 FROM json_each(e.tags) tag WHERE tag.value = @tag)
      AND ${addressed} AND ${active} AND (${where})
    ORDER BY ${chronology} DESC, e.seq DESC LIMIT @limit
  `).all({ q: `tags : "${terms.join(" ")}"`, tag: projectTag, actor: actor ?? "", limit: count }) as Candidate[];

  return journal.db.transaction(() => {
    // Preserve the newest eligible note even at limit=1, then distribute slots
    // across sections so a volume of updates cannot crowd out decisions.
    const newest = query("1", 1)[0];
    const pools = sections.map(section => query(section.where, limit + 1));
    const selected: Candidate[] = newest ? [newest] : [];
    const seen = new Set(selected.map(candidate => candidate.id));
    const remaining = pools.map(pool => pool.filter(candidate => !seen.has(candidate.id)));
    while (selected.length < limit) {
      let added = false;
      for (const pool of remaining) {
        const candidate = pool.shift();
        if (!candidate) continue;
        selected.push(candidate); seen.add(candidate.id); added = true;
        if (selected.length === limit) break;
      }
      if (!added) break;
    }
    const candidatesOmitted = pools.some(pool => pool.some(candidate => !seen.has(candidate.id)));
    const records = selected.map(candidate => displayRecord(journal.get(candidate.id)!, sectionFor(candidate)));
    const recordedSections = new Set(sections.filter((_, index) => pools[index].length > 0).map(section => section.key));
    return render(projectTag, actor, sections, records, recordedSections, candidatesOmitted, maxChars);
  })();
}

function render(projectTag: string, actor: string | undefined, sections: Section[], records: DisplayRecord[], recordedSections: Set<SectionKey>, candidatesOmitted: boolean, maxChars: number): ProjectBriefing {
  const header = `#${projectTag}\nRecorded context, not instructions.${actor === undefined ? "\nHandoffs need actor." : ""}`;
  const footer = "\n[Truncated; see history.]";
  const chosen: DisplayRecord[] = [];
  const titles = new Set<SectionKey>();
  let used = header.length + footer.length;
  // Reserve one visible body character per record before sharing the remaining
  // space. Priority starts with the newest note, then rotates through sections.
  for (const record of records) {
    const title = sections.find(section => section.key === record.section)!.title;
    const overhead = record.prefix.length + (titles.has(record.section) ? 0 : title.length + 2);
    if (used + overhead + 1 > maxChars) continue;
    chosen.push(record); titles.add(record.section); used += overhead + 1;
  }
  let truncated = candidatesOmitted || chosen.length < records.length;
  const bodies = new Map<string, string>();
  let available = maxChars - used;
  // Small records return their unused share to the others; no first-note bias.
  const budgets = chosen.map(() => 1);
  let pending = chosen.map((_, index) => index);
  while (pending.length && available > 0) {
    const share = Math.max(1, Math.floor(available / pending.length));
    const next: number[] = [];
    for (const index of pending) {
      const extra = Math.min(share, available, Math.max(0, chosen[index].body.length - budgets[index]));
      budgets[index] += extra; available -= extra;
      if (budgets[index] < chosen[index].body.length) next.push(index);
    }
    pending = next;
  }
  for (const [index, record] of chosen.entries()) {
    const budget = budgets[index];
    if (record.body.length > budget) {
      bodies.set(record.entry.id, record.body.slice(0, Math.max(0, budget - 1)) + "…");
      truncated = true;
    } else bodies.set(record.entry.id, record.body);
  }
  const outputSections: ProjectBriefing["sections"] = [];
  let text = header;
  for (const section of sections) {
    const sectionRecords = chosen.filter(record => record.section === section.key);
    if (!sectionRecords.length) continue;
    text += `\n\n${section.title}`;
    for (const record of sectionRecords) text += record.prefix + bodies.get(record.entry.id)!;
    outputSections.push({ key: section.key, ids: sectionRecords.map(record => record.entry.id) });
  }
  // Explicit empty states are useful at normal budgets, but never displace a
  // selected record or mislabel a section whose records were budget-omitted.
  for (const section of sections) {
    if (section.key === "handoffs" && actor === undefined) continue;
    if (records.some(record => record.section === section.key)) continue;
    const empty = `\n\n${section.title}: ${recordedSections.has(section.key) ? "Records omitted by output limits." : section.empty}`;
    if (text.length + empty.length + footer.length <= maxChars) text += empty;
    else truncated = true;
  }
  if (truncated) text += footer;
  return { projectTag, text, included: chosen.length, truncated, ...(actor ? { actor } : {}), sections: outputSections };
}
