# Existing-account email change and password recovery

This slice upgrades the existing account in place. It does not create a second
journal, reimport notes, change author labels, or disconnect approved AI apps.
Release and real-mail acceptance must be recorded separately from isolated checks.

## Owner flow

1. Sign in with the existing Kairos login and open **Manage email and password**.
2. Enter a reachable new email and the current password.
3. Open the confirmation email. Sign in to the same existing account if needed,
   then press **Confirm email**. Opening the link alone does not change anything.
4. Use the new email on subsequent sign-ins. The account's immutable ID, journal,
   dates, imported provenance and AI approvals stay attached to the same identity.
5. **Forgot password?** sends a reset link only to a verified account address.
   Submitting a new password signs out browser and native app sessions. Approved
   AI connections continue until the owner explicitly disconnects them.

The original `.test` login remains usable until confirmation. It cannot receive
recovery email. New invited signups remain limited to `.test`; this change does
not open public registration. Email delivery is disabled when unconfigured.

## Delivery setup

The optional adapter uses Resend's HTTPS send-email API. A domain under the
owner's DNS control is needed; a shared `vercel.app` project address does not
provide that control. The owner's Gmail can be the recipient/sign-in address.

1. Register the owner-approved domain with the price and renewal terms reviewed.
2. In Resend, add a sending subdomain such as `accounts.<owned-domain>` and install
   exactly the DNS records Resend supplies. Wait for verified status.
3. Keep open and click tracking off for authentication emails. Use a domain-bound
   sending-only API key. Enter secrets privately in Render; never paste them in
   chat, Git, Kairos notes, shell arguments or screenshots.
4. Set these three environment variables together on the existing service:

   | Variable | Value |
   | --- | --- |
   | `KAIROS_EMAIL_PROVIDER` | `resend` |
   | `KAIROS_EMAIL_FROM` | One verified sender address, e.g. `accounts@accounts.<owned-domain>` |
   | `KAIROS_EMAIL_API_KEY` | Private domain-restricted sending key |

   No paid service upgrade, disk change, auth-secret rotation or OAuth origin
   change is required by this code. Review actual provider-plan limits before
   enabling mail. Partial mail configuration fails startup rather than silently
   claiming recovery is available.

5. Deploy the reviewed source and run the isolated acceptance gate below before
   changing the owner's actual email. The sender receives only the recipient,
   subject, action link and transactional text, never journal content.

References: [verified domains](https://resend.com/docs/dashboard/domains/introduction),
[send email](https://resend.com/docs/api-reference/emails/send-email),
[API key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key).

## Credential and data invariants

- Challenges use 32 random bytes; only a SHA-256 digest is stored as an identifier
  in the existing verification table. The row binds purpose, immutable user ID,
  current email, current credential fingerprint, destination email and expiry.
- Links expire after 30 minutes. An atomic transaction consumes all pending
  account changes/recovery links after a successful credential change. A reset
  link sent before an email change or password change cannot be used afterward.
- The page reads the token from a URL fragment, removes it from the URL, keeps it
  only in memory and submits it through a same-origin POST. GETs never consume it.
- Email change requires a valid owner session and current-password verification.
  Confirmation requires that same owner. Reset requires the verified-mailbox
  challenge and a 12–128 character password, hashed by the pinned auth library.
- Password mutation, OAuth session-reference detachment, browser-session deletion
  and pending-link invalidation occur in one SQLite transaction. Approved consent,
  token validity and Kairos's access epoch are preserved.
- Raw library credential-changing endpoints are blocked to prevent bypassing
  these rules. Public recovery replies do not disclose whether an account exists.
- Password sign-in, OAuth token exchange and journal mutations share the owner
  lock with recovery. Journal requests recheck their session after acquiring it.
  Reset-email delivery is tracked background work: provider latency does not
  reveal which addresses have accounts, and capture/shutdown waits for cleanup.
- Limits cover peer, owner, recipient and total request volume. They are bounded
  in-process limits for the existing single-instance service and reset on restart.
  A multi-instance release requires shared enforcement.
- Recovery uses the existing schema and clears pending verification records on
  restore. Restoring an old backup restores the credentials at that backup's
  cutoff; these flows do not turn old captures into current backups.

## Native compatibility

The companion native change persists the immutable user ID alongside the existing
Keychain session. A legacy session acquires its ID from an authenticated server
response. Cached email is a display value, never evidence that two accounts match.
Held drafts are bound to that ID through email change and reauthentication.

Build 6 keeps unsent drafts only in memory. **Save or copy an unsent draft before
updating the app.** An app replacement cannot recover a draft that was never saved.
Browser and native sessions remain separate; account links may require a browser
sign-in even while the native journal is open.

## Acceptance before marking the slice complete

- [x] Review source and run journal, hosted, recovery and native regressions.
- [ ] Check narrow and large-text account screens in an actual browser/device.
- [ ] Verify the sending domain/key configuration without exposing credentials.
- [ ] Deliver and complete confirmation/reset using a disposable real mailbox.
- [ ] Verify same user ID, unchanged journal records/epochs/consents and actual AI
      reads plus token renewal after reset; reject old browser sessions and links.
- [ ] Preserve a private pre-change receipt, then let the owner enter passwords and
      confirm the real email change. Refresh the phone and confirm existing notes.
- [ ] Record the deployed commit, native build, mail result and limits in Kairos
      and the North Star. Do not report a live account migration from fixture tests.

## October 15 isolated validation

- Journal suite: 78 passed; journal source was unchanged by this account slice.
- Final hosted suite: 146 passed, zero failed or skipped, including build.
- Recovery-vault suite on macOS: 10 passed, one platform-specific setgid check
  skipped. Linux CI is required for that case.
- Native fixtures: 140 assertions passed; unsigned Simulator compilation passed.
- Independent review reproduced and fixed overlapping reset/token exchange,
  revoked-session journal upload, and delayed native responses across accounts.
  Ambiguous token-request media types are rejected before provider dispatch.
- Empty-schema startup diagnostics come from pre-existing eager library checks.
  Explicit postmigration validation succeeds; an incomplete persisted schema
  still rejects startup. No validation was bypassed or disabled.

These results used disposable fixtures. Actual sender verification, delivered
mail, deployed-source checks, and owner account acceptance remain pending.
