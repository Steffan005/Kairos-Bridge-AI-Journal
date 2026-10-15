// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Accounts } from "./accounts.js";
import { AccessError, type KairosAuth } from "./auth.js";

export type AccountMail = { to: string; kind: "email-change" | "password-reset"; url: string };
export type AccountDelivery = { send(message: AccountMail): Promise<void> };
export type AccountAccessRequest = { path: string; method: string; headers: Headers; body?: unknown; rateKey: string };

const PREFIX = "kairos-account-access-v1:";
const LIFETIME = 30 * 60_000;
const WINDOW = 15 * 60_000;
const GENERIC_REQUEST = { status: true, message: "If this address has password recovery enabled, a reset link will arrive shortly." };
const EMAIL_REQUEST = { status: true, message: "If this address can be used, a confirmation link will arrive shortly. Your sign-in email changes after you confirm it." };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const invalidLink = () => new AccessError(400, "This link is invalid or has expired. Request a new link.");
const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
});

/** Syntax and reserved-domain checks; mailbox ownership is established by the link. */
export function realAccountEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 254) return;
  const email = value.trim().toLowerCase();
  if (!z.string().email().safeParse(email).success) return;
  const [local, domain] = email.split("@");
  if (local.length > 64 || !domain.includes(".") || domain.split(".").some(label =>
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return;
  if (/(?:^|\.)(?:test|invalid|localhost|example)$/.test(domain) ||
    /(?:^|\.)example\.(?:com|net|org)$/.test(domain)) return;
  return email;
}

type State = { id: string; email: string; emailVerified: number; credentialId: string; password: string };
type Ticket = {
  type: "kairos-account-access-v1"; kind: AccountMail["kind"]; userId: string;
  email: string; credential: string; newEmail?: string;
};
type TicketRow = { id: string; value: string; expiresAt: string };
type Session = { user: { id: string }; session: { id: string } };

/** Bounded process-local limits supplement Better Auth's HTTP-only rate limiter. */
class AccountLimits {
  private readonly buckets = new Map<string, { count: number; until: number }>();
  take(key: string, maximum: number): boolean {
    const now = Date.now(), hashed = digest(key);
    let bucket = this.buckets.get(hashed);
    if (!bucket || bucket.until <= now) {
      if (this.buckets.size >= 10_000) {
        for (const [id, entry] of this.buckets) if (entry.until <= now) this.buckets.delete(id);
        if (this.buckets.size >= 10_000 && !bucket) return false;
      }
      bucket = { count: 0, until: now + WINDOW };
      this.buckets.set(hashed, bucket);
    }
    if (bucket.count >= maximum) return false;
    bucket.count++;
    return true;
  }
  require(key: string, maximum: number): void {
    if (!this.take(key, maximum)) throw new AccessError(429, "Too many attempts. Wait 15 minutes and try again.");
  }
}

/**
 * Uses the pinned Better Auth schema, password verifier and password hasher.
 * The final SQLite transaction makes credential changes, token consumption and
 * session cleanup indivisible. No async hook can leave a changed password with
 * old browser sessions, and OAuth logout hooks cannot revoke approved AI apps.
 * Records use the existing verification table, which recovery restores clear.
 */
export function createAccountAccess(options: {
  auth: KairosAuth; database: Database.Database; accounts: Accounts; baseURL: string; delivery?: AccountDelivery;
  /** Track already-started neutral reset delivery so recovery/close drains it. */
  backgroundTaskHandler?: (task: Promise<unknown>) => void;
}) {
  const { auth, database, accounts, delivery } = options;
  const baseURL = new URL(options.baseURL).origin, limits = new AccountLimits();
  const state = (id: string): State | undefined => database.prepare(
    'SELECT u.id, u.email, u.emailVerified, a.id AS credentialId, a.password FROM "user" u JOIN "account" a ON a.userId = u.id AND a.providerId = ? WHERE u.id = ?',
  ).get("credential", id) as State | undefined;
  const fingerprint = (user: State) => digest(JSON.stringify([user.credentialId, user.password, user.email, user.emailVerified]));
  const eligible = (user: State | undefined): user is State => !!user?.password && user.emailVerified === 1 && realAccountEmail(user.email) !== undefined;
  const sameState = (user: State | undefined, ticket: Ticket): user is State =>
    !!user?.password && user.id === ticket.userId && user.email === ticket.email && fingerprint(user) === ticket.credential;
  const activeSession = (session: Session): boolean => {
    const row = database.prepare('SELECT expiresAt FROM "session" WHERE id = ? AND userId = ?')
      .get(session.session.id, session.user.id) as { expiresAt: string } | undefined;
    return !!row && Date.parse(row.expiresAt) > Date.now();
  };
  const owner = async (headers: Headers): Promise<Session> => {
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session || !activeSession(session)) throw new AccessError(401, "Please sign in to Kairos");
    return session;
  };
  const requireDelivery = (): AccountDelivery => {
    if (!delivery) throw new AccessError(503, "Email delivery is not configured for this Kairos service.");
    return delivery;
  };
  function readTicket(token: unknown, kind: AccountMail["kind"]): { row: TicketRow; ticket: Ticket } {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidLink();
    const row = database.prepare('SELECT id, value, expiresAt FROM "verification" WHERE identifier = ?')
      .get(PREFIX + digest(token)) as TicketRow | undefined;
    if (!row || !(Date.parse(row.expiresAt) > Date.now())) throw invalidLink();
    let ticket: Ticket;
    try { ticket = JSON.parse(row.value); } catch { throw invalidLink(); }
    if (!ticket || ticket.type !== "kairos-account-access-v1" || ticket.kind !== kind ||
      typeof ticket.userId !== "string" || typeof ticket.email !== "string" || typeof ticket.credential !== "string" ||
      (kind === "email-change" && (typeof ticket.newEmail !== "string" || realAccountEmail(ticket.newEmail) !== ticket.newEmail))) throw invalidLink();
    return { row, ticket };
  }
  function invalidatePending(userId: string): void {
    // Include unfinished OAuth exchanges, preserving already-approved consents
    // and issued tokens. Legacy library reset tokens are invalidated as well.
    const rows = database.prepare('SELECT id, identifier, value FROM "verification"').all() as Array<{ id: string; identifier: string; value: string }>;
    const remove = database.prepare('DELETE FROM "verification" WHERE id = ?');
    for (const row of rows) {
      if (row.identifier.startsWith("reset-password:") && row.value === userId) { remove.run(row.id); continue; }
      let value: { userId?: unknown; type?: unknown };
      try { value = JSON.parse(row.value); } catch { continue; }
      if (value && value.userId === userId &&
        (row.identifier.startsWith(PREFIX) || ["authorization_code", "consent"].includes(String(value.type)))) remove.run(row.id);
    }
  }
  async function issue(user: State, kind: AccountMail["kind"], newEmail?: string): Promise<void> {
    const mail = requireDelivery(), token = randomBytes(32).toString("base64url"), id = randomUUID(), now = new Date();
    const ticket: Ticket = { type: "kairos-account-access-v1", kind, userId: user.id, email: user.email, credential: fingerprint(user), ...(newEmail ? { newEmail } : {}) };
    database.transaction(() => {
      database.prepare('DELETE FROM "verification" WHERE identifier LIKE ? AND expiresAt <= ?').run(PREFIX + "%", now.toISOString());
      database.prepare('INSERT INTO "verification" (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, PREFIX + digest(token), JSON.stringify(ticket), new Date(now.getTime() + LIFETIME).toISOString(), now.toISOString(), now.toISOString());
    })();
    try {
      // Await delivery directly; the auth library's background callback policy
      // must not report successful issuance before this work has completed.
      await mail.send({ to: newEmail ?? user.email, kind, url: `${baseURL}/${kind === "email-change" ? "confirm-email" : "reset-password"}#token=${token}` });
    } catch {
      database.prepare('DELETE FROM "verification" WHERE id = ?').run(id);
      throw new AccessError(503, "The email could not be sent. Please try again later.");
    }
  }
  async function handle(request: AccountAccessRequest): Promise<Response> {
    const { path, method, headers, rateKey } = request;
    if (path === "/api/account" && method === "GET") {
      const session = await owner(headers), user = state(session.user.id);
      if (!user) throw new AccessError(401, "Please sign in to Kairos");
      return json({ id: user.id, email: user.email, emailVerified: user.emailVerified === 1,
        recoveryAvailable: !!delivery && eligible(user), emailChangeAvailable: !!delivery });
    }
    if (!["/api/account/email-change", "/api/account/confirm-email", "/api/account/forgot-password", "/api/account/reset-password"].includes(path)) {
      throw new AccessError(404, "Account route not found");
    }
    if (method !== "POST") throw new AccessError(405, "Use POST");
    if (headers.get("origin") !== baseURL) throw new AccessError(403, "Open Kairos to change your account");
    limits.require(`ip:${rateKey}`, 30);
    limits.require("all", 120);
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw new AccessError(400, "Provide a JSON object");
    const input = request.body as Record<string, unknown>;

    if (path === "/api/account/email-change") {
      const session = await owner(headers);
      limits.require(`password:${session.user.id}`, 5);
      requireDelivery();
      const newEmail = realAccountEmail(input.newEmail);
      if (!newEmail) throw new AccessError(400, "Enter a real email address you can receive mail at. Test addresses cannot be used for recovery.");
      if (typeof input.currentPassword !== "string" || !input.currentPassword || input.currentPassword.length > 128) {
        throw new AccessError(400, "Enter your current password");
      }
      return accounts.locked(session.user.id, async () => {
        const user = state(session.user.id);
        if (!user?.password || !activeSession(session)) throw new AccessError(401, "Please sign in to Kairos");
        const before = fingerprint(user);
        try { await auth.api.verifyPassword({ headers, body: { password: input.currentPassword as string } }); }
        catch { throw new AccessError(403, "Your current password could not be verified"); }
        const current = state(user.id);
        if (!activeSession(session) || !current || fingerprint(current) !== before) throw new AccessError(401, "Please sign in again");
        if (newEmail === user.email) throw new AccessError(400, "Choose a different email address");
        const used = database.prepare('SELECT id FROM "user" WHERE email = ? COLLATE NOCASE').get(newEmail);
        if (!used) await issue(user, "email-change", newEmail);
        return json(EMAIL_REQUEST);
      });
    }
    if (path === "/api/account/confirm-email") {
      const session = await owner(headers);
      limits.require(`complete:${session.user.id}`, 10);
      const { ticket } = readTicket(input.token, "email-change");
      if (ticket.userId !== session.user.id) throw invalidLink();
      return accounts.locked(session.user.id, async () => {
        const result = database.transaction(() => {
          const current = readTicket(input.token, "email-change").ticket, user = state(session.user.id);
          if (!activeSession(session)) throw new AccessError(401, "Please sign in to Kairos");
          if (!sameState(user, current)) throw invalidLink();
          if (database.prepare('SELECT id FROM "user" WHERE email = ? COLLATE NOCASE').get(current.newEmail)) throw invalidLink();
          database.prepare('UPDATE "user" SET email = ?, emailVerified = 1, updatedAt = ? WHERE id = ?')
            .run(current.newEmail, new Date().toISOString(), user.id);
          invalidatePending(user.id);
          return { status: true, email: current.newEmail, emailVerified: true };
        })();
        return json(result);
      });
    }
    if (path === "/api/account/forgot-password") {
      const email = realAccountEmail(input.email);
      if (!email || !delivery || !limits.take(`forgot:${email}`, 3)) return json(GENERIC_REQUEST);
      const found = database.prepare('SELECT id FROM "user" WHERE email = ? COLLATE NOCASE').get(email) as { id: string } | undefined;
      if (found) {
        // Email-provider latency must not identify whether a mailbox has an
        // account. Register admitted work before returning the neutral response.
        // The owner lock stays held until delivery/failed-challenge cleanup ends.
        const work = accounts.locked(found.id, async () => {
          const user = state(found.id);
          if (eligible(user) && user.email === email) await issue(user, "password-reset");
        }).catch(() => undefined);
        if (options.backgroundTaskHandler) options.backgroundTaskHandler(work);
        else await work; // Standalone callers must not leave untracked DB work.
      }
      return json(GENERIC_REQUEST);
    }
    const { ticket } = readTicket(input.token, "password-reset");
    limits.require(`complete:${ticket.userId}`, 10);
    const context = await auth.$context;
    if (typeof input.newPassword !== "string" || input.newPassword.length < context.password.config.minPasswordLength ||
      input.newPassword.length > context.password.config.maxPasswordLength) {
      throw new AccessError(400, `Use a password between ${context.password.config.minPasswordLength} and ${context.password.config.maxPasswordLength} characters`);
    }
    return accounts.locked(ticket.userId, async () => {
      const current = readTicket(input.token, "password-reset").ticket, before = state(ticket.userId);
      if (!eligible(before) || !sameState(before, current)) throw invalidLink();
      // Use the same pinned Better Auth hashing implementation as sign-up/login.
      const password = await context.password.hash(input.newPassword as string);
      database.transaction(() => {
        const current = readTicket(input.token, "password-reset").ticket, user = state(ticket.userId);
        if (!eligible(user) || !sameState(user, current)) throw invalidLink();
        database.prepare('UPDATE "account" SET password = ?, updatedAt = ? WHERE id = ? AND userId = ? AND providerId = ?')
          .run(password, new Date().toISOString(), user.credentialId, user.id, "credential");
        // Consents, refresh tokens, JWT generations and journal identity survive.
        // Clear session foreign keys before deleting browser sessions; avoid the
        // OAuth provider's logout hooks, which revoke session-bound AI tokens.
        database.prepare('UPDATE "oauthAccessToken" SET sessionId = NULL WHERE userId = ?').run(user.id);
        database.prepare('UPDATE "oauthRefreshToken" SET sessionId = NULL WHERE userId = ?').run(user.id);
        database.prepare('DELETE FROM "session" WHERE userId = ?').run(user.id);
        invalidatePending(user.id);
      })();
      return json({ status: true, message: "Password changed. Sign in with your new password. Your journal and AI connections are preserved." });
    });
  }
  return { handle };
}
