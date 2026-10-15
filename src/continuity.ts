// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../NOTICE.
import { findSecret } from "./secrets.js";

export const CONTINUITY_ROLES = ["goal", "decision", "question", "next_action", "handoff", "update"] as const;
export type ContinuityRole = (typeof CONTINUITY_ROLES)[number];

/** Semantic attribution and links, supplied explicitly by the writer. */
export interface ContinuityRecord {
  version: 1;
  role: ContinuityRole;
  actor_id?: string;
  recipient?: string;
  supersedes?: string[];
  resolves?: string[];
}

/** Set only by the authenticated server adapter, never by an MCP argument. */
export interface WriteOrigin {
  version: 1;
  channel: "oauth" | "owner";
  client_id: string | null;
  provider: "claude" | "chatgpt" | "grok" | "gemini" | null;
  received_at: string;
}

const ACTOR_ALIASES: Record<string, string> = {
  gpt_codex: "gpt_codex", chatgpt: "gpt_codex", gpt: "gpt_codex", codex: "gpt_codex",
  claude_summers: "claude_summers", claude: "claude_summers", dr_claude_summers: "claude_summers",
  gemini_word: "gemini_word", gemini: "gemini_word",
  grok_ops: "grok_ops", grok: "grok_ops",
};

export function normalizeContinuityActor(value: unknown): string {
  if (typeof value !== "string") throw new Error("Continuity actor must be a slug");
  const actor = value.normalize("NFC").trim().toLowerCase();
  if (actor.length > 64 || !/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(actor) || findSecret(actor)) {
    throw new Error("Continuity actor must be a slug of 1 to 64 characters");
  }
  return Object.hasOwn(ACTOR_ALIASES, actor) ? ACTOR_ALIASES[actor] : actor;
}

/** Exact filters must not silently broaden, truncate or rename a stored tag. */
export function validateExactProjectTag(value: unknown): string {
  if (typeof value !== "string" || value.length > 48 || value !== value.normalize("NFC").trim().toLowerCase() ||
      !/^project-[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(value)) {
    throw new Error("Choose a complete normalized project tag, such as project-kitchen (at most 48 characters)");
  }
  return value;
}

export function normalizeProjectTag(value: unknown): string {
  if (typeof value !== "string") throw new Error("project is required");
  let tag = value.normalize("NFC").trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
  if (!tag.startsWith("project-")) tag = `project-${tag}`;
  return validateExactProjectTag(tag);
}

/** Ambiguous or malformed project membership never supplies link scope. */
export function soleProjectTag(tags: readonly string[]): string | undefined {
  const projects = tags.filter(tag => typeof tag === "string" && tag.startsWith("project-"));
  if (projects.length !== 1) return undefined;
  try { return validateExactProjectTag(projects[0]); } catch { return undefined; }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function validateWriteOrigin(value: unknown): WriteOrigin {
  const input = plainObject(value, "Write origin");
  const allowed = ["version", "channel", "client_id", "provider", "received_at"];
  if (Object.keys(input).some(key => !allowed.includes(key)) || input.version !== 1 ||
      !["oauth", "owner"].includes(input.channel as string) ||
      ![null, "claude", "chatgpt", "grok", "gemini"].includes(input.provider as null | string)) {
    throw new Error("Write origin has invalid or unsupported fields");
  }
  if (input.channel === "owner") {
    if (input.client_id !== null || input.provider !== null) throw new Error("Owner write origin cannot claim an OAuth client or provider");
  } else if (typeof input.client_id !== "string" || !input.client_id.trim() || input.client_id.length > 2048 ||
      /[\u0000-\u0020\u007f]/.test(input.client_id) || findSecret(input.client_id)) {
    throw new Error("OAuth write origin requires a valid client ID");
  }
  if (typeof input.received_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.received_at) ||
      !Number.isFinite(Date.parse(input.received_at)) || new Date(input.received_at).toISOString() !== input.received_at) {
    throw new Error("Write origin requires a valid UTC receipt time");
  }
  return { version: 1, channel: input.channel as WriteOrigin["channel"], client_id: input.client_id as string | null,
    provider: input.provider as WriteOrigin["provider"], received_at: input.received_at };
}

export function validateContinuity(value: unknown, tags: readonly string[]): ContinuityRecord {
  const input = plainObject(value, "Continuity");
  const allowed = ["version", "role", "actor_id", "recipient", "supersedes", "resolves"];
  if (Object.keys(input).some(key => !allowed.includes(key)) || input.version !== 1 ||
      !CONTINUITY_ROLES.includes(input.role as ContinuityRole)) throw new Error("Continuity has invalid or unsupported fields");
  if (!soleProjectTag(tags)) throw new Error("Continuity requires exactly one valid project tag");
  if (input.role === "handoff" ? input.recipient === undefined : input.recipient !== undefined) {
    throw new Error("Continuity handoff requires a recipient; only handoffs accept a recipient");
  }
  const result: ContinuityRecord = { version: 1, role: input.role as ContinuityRole };
  if (input.actor_id !== undefined) result.actor_id = normalizeContinuityActor(input.actor_id);
  if (input.recipient !== undefined) result.recipient = normalizeContinuityActor(input.recipient);
  for (const field of ["supersedes", "resolves"] as const) {
    if (input[field] === undefined) continue;
    const refs = input[field];
    if (!Array.isArray(refs) || refs.length > 8 || refs.some(id => typeof id !== "string" || !/^[a-f0-9]{16}$/.test(id)) ||
        new Set(refs).size !== refs.length) throw new Error(`Continuity ${field} requires at most 8 distinct complete Note IDs`);
    result[field] = [...refs];
  }
  if (result.supersedes?.some(id => result.resolves?.includes(id))) throw new Error("Continuity references cannot overlap between supersedes and resolves");
  return result;
}
