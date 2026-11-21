// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
import type Database from "better-sqlite3";
import type { Accounts } from "./accounts.js";

/** Durable intent bridges auth/control SQLite files and the journal filesystem.
 * Only the password-confirmed owner route writes an intent. Interrupted erasures
 * resume before the listener opens; backups refuse an unfinished erasure.
 */
export function createAccountDeletion(database: Database.Database, accounts: Accounts) {
  database.exec("CREATE TABLE IF NOT EXISTS kairos_account_deletions (userId TEXT PRIMARY KEY, requestedAt TEXT NOT NULL)");
  function finish(userId: string): void {
    accounts.delete(userId);
    database.transaction(() => {
      // Shared registered clients and other users' grants must survive.
      database.prepare('UPDATE "oauthClient" SET userId=NULL WHERE userId=?').run(userId);
      for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent", "session", "account"]) {
        database.prepare(`DELETE FROM "${table}" WHERE userId=?`).run(userId);
      }
      const user = database.prepare('SELECT email FROM "user" WHERE id=?').get(userId) as { email: string } | undefined;
      const remove = database.prepare('DELETE FROM "verification" WHERE id=?');
      for (const row of database.prepare('SELECT id,identifier,value FROM "verification"').all() as Array<{ id: string; identifier: string; value: string }>) {
        let value: { userId?: unknown } | undefined;
        try { value = JSON.parse(row.value); } catch { /* Plain legacy reset user id. */ }
        if (value?.userId === userId || row.value === userId || (user && row.identifier === user.email)) remove.run(row.id);
      }
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='kairos_pilot_invitations' AND type='table'").get()) {
        // Opaque consumed digests prevent replay without retaining identity.
        database.prepare('UPDATE kairos_pilot_invitations SET userId=NULL WHERE userId=?').run(userId);
      }
      database.prepare('DELETE FROM "user" WHERE id=?').run(userId);
    })();
    accounts.forget(userId);
    database.prepare('DELETE FROM kairos_account_deletions WHERE userId=?').run(userId);
  }
  for (const row of database.prepare('SELECT userId FROM kairos_account_deletions ORDER BY userId').all() as Array<{ userId: string }>) finish(row.userId);
  return (userId: string): void => {
    database.prepare('INSERT OR IGNORE INTO kairos_account_deletions(userId,requestedAt) VALUES (?,?)').run(userId, new Date().toISOString());
    finish(userId);
  };
}
