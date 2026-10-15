// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, JournalError, type ContinuityRecord } from "../src/journal.js";
import { hashEntry } from "../src/canonical.js";
import { normalizeContinuityActor, normalizeProjectTag, soleProjectTag } from "../src/continuity.js";

function fixture(run: (j: Journal) => void) {
  const dir = mkdtempSync(join(tmpdir(), "kairos-continuity-")); const j = Journal.open(join(dir, "journal.db"));
  try { run(j); } finally { j.close(); rmSync(dir, { recursive: true, force: true }); }
}
const tags = ["project-kitchen"];

test("typed metadata normalizes canonical actor aliases without changing note attribution", () => fixture(j => {
  for (const [alias, actor] of [["Claude", "claude_summers"], ["chatgpt", "gpt_codex"], ["gpt_codex", "gpt_codex"], ["gemini", "gemini_word"], ["grok", "grok_ops"], ["team-builder", "team-builder"]]) {
    const entry = j.write({ text: `A handoff for ${alias}`, actor: "writer-label", tags, continuity: { version: 1, role: "handoff", actor_id: alias, recipient: "ChatGPT" } });
    assert.equal(entry.actor, "writer-label"); assert.equal(entry.continuity!.actor_id, actor); assert.equal(entry.continuity!.recipient, "gpt_codex");
  }
  assert.equal(normalizeProjectTag(" #Project-Kitchen "), "project-kitchen");
  assert.equal(normalizeProjectTag("Kitchen plan"), "project-kitchen-plan");
  assert.equal(soleProjectTag(["project-kitchen", "other"]), "project-kitchen");
  assert.equal(soleProjectTag(["project-kitchen", "project-garden"]), undefined);
  for (const actor of ["", "two words", "bad.actor", "a".repeat(65), "-actor", "actor__two"]) assert.throws(() => normalizeContinuityActor(actor));
  assert.ok(j.verify().ok);
}));

test("explicit supersession and resolution preserve original records and complete links", () => fixture(j => {
  const goal = j.write({ text: "Original goal", tags, continuity: { version: 1, role: "goal" } });
  const question = j.write({ text: "Which layout?", tags, continuity: { version: 1, role: "question" } });
  const action = j.write({ text: "Measure the room", tags, continuity: { version: 1, role: "next_action" } });
  const handoff = j.write({ text: "Continue measurements", tags, continuity: { version: 1, role: "handoff", recipient: "claude" } });
  const revised = j.write({ text: "Revised goal", tags, continuity: { version: 1, role: "goal", supersedes: [goal.id], resolves: [question.id, action.id, handoff.id] } });
  assert.deepEqual(j.get(goal.id), goal); assert.deepEqual(j.get(question.id), question);
  assert.deepEqual(revised.continuity!.supersedes, [goal.id]); assert.deepEqual(revised.continuity!.resolves, [question.id, action.id, handoff.id]);
  assert.ok(j.verify().ok);
}));

test("legacy decisions can be explicitly superseded but untyped prose cannot be resolved", () => fixture(j => {
  const decision = j.write({ text: "Old decision", kind: "decision", tags });
  const note = j.write({ text: "Maybe this is a question?", tags });
  j.write({ text: "Explicit replacement", tags, continuity: { version: 1, role: "decision", supersedes: [decision.id] } });
  assert.throws(() => j.write({ text: "Unsupported inference", tags, continuity: { version: 1, role: "update", resolves: [note.id] } }), /typed question/);
  assert.throws(() => j.write({ text: "Wrong role replacement", tags, continuity: { version: 1, role: "goal", supersedes: [decision.id] } }), /semantic role/);
  assert.ok(j.verify().ok);
}));

test("invalid shapes, ambiguous projects and reference sets reject atomically", () => fixture(j => {
  const q = j.write({ text: "Existing question", tags, continuity: { version: 1, role: "question" } });
  const initialHead = j.headHash();
  const values: unknown[] = [null, [], {}, { version: 2, role: "goal" }, { version: 1, role: "Goal" }, { version: 1, role: "handoff" },
    { version: 1, role: "goal", recipient: "claude" }, { version: 1, role: "goal", actor_id: "two words" },
    { version: 1, role: "handoff", recipient: "" }, { version: 1, role: "goal", unexpected: true },
    { version: 1, role: "goal", resolves: [q.id, q.id] }, { version: 1, role: "question", supersedes: [q.id], resolves: [q.id] },
    { version: 1, role: "question", supersedes: ["short-id"] }, { version: 1, role: "question", supersedes: ["A".repeat(16)] },
    { version: 1, role: "question", supersedes: ["f".repeat(16)] }, { version: 1, role: "question", supersedes: Array.from({length: 9}, (_, i) => i.toString(16).padStart(16, "0")) }];
  for (const continuity of values) {
    assert.throws(() => j.writeMany([{ text: "Must roll back too", pin: true }, { text: "Invalid", tags, continuity: continuity as ContinuityRecord }]), JournalError);
    assert.equal(j.count(), 1); assert.equal(j.headHash(), initialHead); assert.equal(j.pinned().length, 0); assert.ok(j.verify().ok);
  }
  for (const invalidTags of [[], ["project-"], ["project-kitchen", "project-garden"], ["project-bad.dot"]]) {
    assert.throws(() => j.write({ text: "No unambiguous scope", tags: invalidTags, continuity: { version: 1, role: "goal" } }), /exactly one valid project/);
  }
  for (const invalidTags of [["project-" + "x".repeat(49)], [...tags, ...Array(15).fill("other"), "project-garden"], [null]]) {
    assert.throws(() => j.write({ text: "Scope cannot be truncated", tags: invalidTags as string[], continuity: { version: 1, role: "goal" } }), /without truncation/);
  }
}));

test("links reject cross-project, overlapping project membership and substring matches", () => fixture(j => {
  const other = j.write({ text: "Other question", tags: ["project-kitchenette"], continuity: { version: 1, role: "question" } });
  const ambiguous = j.write({ text: "Ambiguous old decision", kind: "decision", tags: ["project-kitchen", "project-garden"] });
  const noProject = j.write({ text: "Unscoped old decision", kind: "decision" });
  for (const id of [ambiguous.id, noProject.id]) assert.throws(() => j.write({ text: "Bad scope", tags, continuity: { version: 1, role: "decision", supersedes: [id] } }), /same exact sole project/);
  assert.throws(() => j.write({ text: "Cross-project resolution", tags, continuity: { version: 1, role: "update", resolves: [other.id] } }), /same exact sole project/);
  assert.equal(j.count(), 3); assert.ok(j.verify().ok);
}));

test("verification detects changed metadata, removal and rehashed invalid links", () => {
  for (const tamper of ["role", "remove", "cross-project", "future-reference"]) fixture(j => {
    const question = j.write({ text: "Question", tags, continuity: { version: 1, role: "question" } });
    const update = j.write({ text: "Resolved", tags, continuity: { version: 1, role: "update", resolves: [question.id] } });
    const later = j.write({ text: "Later question", tags, continuity: { version: 1, role: "question" } });
    j.db.exec("DROP TRIGGER entries_no_update");
    if (tamper === "remove") j.db.prepare("UPDATE entries SET continuity_json = NULL WHERE id = ?").run(update.id);
    else if (tamper === "role") j.db.prepare("UPDATE entries SET continuity_json = ? WHERE id = ?").run(JSON.stringify({ ...update.continuity, role: "goal" }), update.id);
    else {
      const forged = { ...update, ...(tamper === "cross-project" ? { tags: ["project-other"] } : { continuity: { ...update.continuity!, resolves: [later.id] } }) };
      j.db.prepare("UPDATE entries SET tags = ?, continuity_json = ?, hash = ? WHERE id = ?").run(JSON.stringify(forged.tags), JSON.stringify(forged.continuity), hashEntry(forged), update.id);
    }
    const report = j.verify(); assert.equal(report.ok, false, tamper); assert.equal(report.firstBroken!.id, update.id);
  });
});

test("MCP engine search applies exact project filter before limit and OR fallback", () => fixture(j => {
  j.writeMany(Array.from({ length: 80 }, () => ({ text: "Needle plan", tags: ["project-kitchen-old"] })));
  const wanted = j.write({ text: "Needle plan", tags });
  j.write({ text: "Needle plan mentions project-kitchen", tags: ["project-garden"] });
  assert.deepEqual(j.search("Needle plan", { project: "project-kitchen", limit: 1 }).map(e => e.id), [wanted.id]);
  assert.deepEqual(j.search("Needle absentword", { project: "project-kitchen" }).map(e => e.id), [wanted.id]);
  assert.equal(j.search("Needle", { project: "project-missing" }).length, 0);
  for (const project of ["kitchen", "project-", "project-kitchen ", "Project-Kitchen", "project-bad.dot", "project-" + "x".repeat(50)]) {
    assert.throws(() => j.search("Needle", { project }), /complete normalized project tag/);
  }
}));
