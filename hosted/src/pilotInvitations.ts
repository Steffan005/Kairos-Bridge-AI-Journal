// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { AccessError, type KairosAuth } from "./auth.js";
import { realAccountEmail } from "./accountAccess.js";

export type PilotInvitation = { bindingHash: string; codeHash: string; expiresAt: number };
export const invitationHash = (code: string): string => createHash("sha256").update(code).digest("hex");
export const invitationBinding = (email: string, code: string): string => invitationHash(email + "\0" + code);
const invalid = () => new AccessError(403, "This invitation is unavailable. Check the email and code, or ask for a new invitation.");

/** No defaults, public issuance route, shared secret, or customer-wide signup. */
export function parsePilotInvitations(value: unknown): PilotInvitation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new Error("Configure between 1 and 50 private pilot invitations");
  const seen = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "bindingHash,codeHash,expiresAt" ||
        typeof row.bindingHash !== "string" || !/^[a-f0-9]{64}$/.test(row.bindingHash) || typeof row.codeHash !== "string" || !/^[a-f0-9]{64}$/.test(row.codeHash) ||
        !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0 || seen.has(row.codeHash)) {
      throw new Error("Invalid pilot invitation configuration");
    }
    seen.add(row.codeHash);
    return { bindingHash: row.bindingHash, codeHash: row.codeHash, expiresAt: row.expiresAt };
  });
}

export function pilotInvitationsFromEnvironment(env: NodeJS.ProcessEnv = process.env): PilotInvitation[] | undefined {
  if (env.KAIROS_PILOT_INVITATIONS === undefined) return;
  return parsePilotInvitations(JSON.parse(env.KAIROS_PILOT_INVITATIONS));
}

/** One writer is enforced by the service data lease. Claim before awaiting auth;
 * a crash or uncertain failure burns the code rather than replaying registration.
 * This ledger is in auth.db, so existing coordinated recovery captures include it.
 */
export function createPilotRegistration(options: {
  auth: KairosAuth; database: Database.Database; baseURL: string; invitations: PilotInvitation[];
}) {
  const invitations = parsePilotInvitations(options.invitations);
  const { database, auth, baseURL } = options;
  database.exec(`CREATE TABLE IF NOT EXISTS kairos_pilot_invitations (
    codeHash TEXT PRIMARY KEY, bindingHash TEXT NOT NULL, expiresAt INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('ready','claimed','used')), userId TEXT
  )`);
  database.transaction(() => {
    for (const row of invitations) {
      database.prepare("INSERT OR IGNORE INTO kairos_pilot_invitations(codeHash,bindingHash,expiresAt,state) VALUES (?,?,?,'ready')").run(row.codeHash, row.bindingHash, row.expiresAt);
      const saved = database.prepare("SELECT bindingHash,expiresAt FROM kairos_pilot_invitations WHERE codeHash=?").get(row.codeHash) as PilotInvitation;
      if (saved.bindingHash !== row.bindingHash || saved.expiresAt !== row.expiresAt) throw new Error("A pilot invitation cannot be rebound or extended; issue a new code");
    }
  })();
  const active = new Map(invitations.map(row => [row.codeHash, row]));
  // Bound failed admission attempts by the service's trusted source address.
  // A single peer must not exhaust a shared bucket for all invited testers.
  const limits = new Map<string, { until: number; attempts: number }>();
  return async (input: unknown, headers: Headers, rateKey: string): Promise<Response> => {
    if (headers.get("origin") !== baseURL) throw new AccessError(403, "Open Kairos to create your account");
    const now = Date.now();
    const source = invitationHash(rateKey);
    let bucket = limits.get(source);
    if (!bucket || bucket.until <= now) {
      if (limits.size >= 10_000) {
        for (const [key, value] of limits) if (value.until <= now) limits.delete(key);
        if (limits.size >= 10_000 && !bucket) throw new AccessError(429, "Signup is busy. Wait one minute and try again.");
      }
      bucket = { until: now + 60_000, attempts: 0 };
      limits.set(source, bucket);
    }
    if (++bucket.attempts > 20) throw new AccessError(429, "Too many attempts. Wait one minute and try again.");
    if (await auth.api.getSession({ headers })) throw new AccessError(409, "You are already signed in. Use your own signed-out browser to create a separate account.");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
    const value = input as Record<string, unknown>;
    const email = realAccountEmail(value.email);
    if (!email || typeof value.invite_code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.invite_code)) throw invalid();
    const codeHash = invitationHash(value.invite_code), invitation = active.get(codeHash);
    if (!invitation || invitation.bindingHash !== invitationBinding(email, value.invite_code) || invitation.expiresAt <= now) throw invalid();
    const context = await auth.$context;
    if (typeof value.password !== "string" || value.password.length < context.password.config.minPasswordLength || value.password.length > context.password.config.maxPasswordLength) {
      throw new AccessError(400, "Use a password between 12 and 128 characters");
    }
    // Never alter, merge with, or recover an existing account through an invite.
    if (database.prepare('SELECT id FROM "user" WHERE email=? COLLATE NOCASE').get(email)) throw invalid();
    const claimed = database.prepare("UPDATE kairos_pilot_invitations SET state='claimed' WHERE codeHash=? AND state='ready' AND expiresAt>?").run(codeHash, Date.now());
    if (claimed.changes !== 1) throw invalid();
    const response = await auth.handler(new Request(baseURL + "/api/auth/sign-up/email", {
      method: "POST", headers,
      // Whitelist library input. Invitation, emailVerified, redirects, OAuth
      // queries, account IDs and other caller-supplied fields never reach auth.
      body: JSON.stringify({ email, password: value.password, name: "Kairos beta tester" }),
    }));
    if (response.ok) {
      const user = database.prepare('SELECT id FROM "user" WHERE email=? COLLATE NOCASE').get(email) as { id: string } | undefined;
      if (!user) throw new AccessError(503, "Account creation could not be confirmed. Ask for help before trying again.");
      database.prepare("UPDATE kairos_pilot_invitations SET state='used',userId=? WHERE codeHash=? AND state='claimed'").run(user.id, codeHash);
    }
    return response;
  };
}
