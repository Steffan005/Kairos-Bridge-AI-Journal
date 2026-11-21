# First independent friends pilot

This is preparation for an invited, synthetic-data beta. The personal-invitation
path is disabled unless the operator explicitly configures it. Source tests are
not a live deployment, Apple approval, or independent iPhone acceptance.

## Private enrollment

The legacy development signup still requires its staging secret and a `.test`
address. Never distribute that secret or the owner's credentials. The optional
`/join` form accepts a separate random code bound to one normal email address.
It creates an independent account through Better Auth. It grants no AI access.

After building the hosted package, an operator can run
`node hosted/scripts/prepare-pilot-invitation.mjs --email RECIPIENT --out /PRIVATE/NEW/DIRECTORY`
from the repository root. This creates files locally; it sends nothing. The new
directory is private and must not already exist. `manifest.json` contains only
opaque email/code binding and code digests plus seven-day expiry; `invitation.txt` holds the
secret personal code. Keep both outside Git, public screenshots and chat logs.

Combine approved manifest entries into the private `KAIROS_PILOT_INVITATIONS`
environment value. There are at most 50 configured invitations. Account email
delivery must already be configured. An empty, malformed or conflicting
configuration fails closed. Removing an entry disables it after restart.
Personal codes never go into links, OAuth parameters or account metadata.

The code is durably claimed before registration is dispatched. Concurrent
replays, use with another email, expired codes and reuse after restart fail.
An interrupted or rejected registration may burn the code. Have the tester try
signing in first; if no account exists, issue a fresh code. Never edit an old
code's binding or expiry. Existing accounts cannot be replaced through invites.

The consumption ledger is an optional, checked table in `auth.db`, included in
coordinated recovery captures. Controlled restore retires all captured unused
codes. After any restore, remove old invitation configuration and issue fresh
codes. Directly replacing databases outside the controlled restore remains an
unsupported rollback and may revive older state.

## First-time account flow

1. The tester opens the canonical `/join` page on their own device, enters the
   invited email and personal code, and chooses a password of 12–128 characters.
2. The form opens Your account. For an unverified address, the same email is
   prefilled. The tester enters their current password and sends a confirmation.
3. The tester opens the email link, checks the signed-in account and confirms.
   The existing account-bound, one-use email flow verifies that same address;
   it does not automatically mark invitation accounts verified. Password
   recovery then becomes available through the existing verified-email flow.
4. The tester installs Kairos using their separate Apple TestFlight invitation
   and signs in. Build 7 has native sign-in and browser account controls; account
   creation is completed in the browser. No rebuild is implied by these server
   changes, but that exact build/server combination must pass physical checks.
5. In Anamnesis they save a made-up practice note, then use Connect to set up a
   supported AI app. They check their own email and requested permissions on the
   consent screen, enable Kairos in a new AI conversation and retrieve the note.

Signing out of Kairos preserves separately approved AI access. Disconnect all
AI access stops future journal access and keeps notes. Providers may retain
previously retrieved text. Delete journal leaves the sign-in account. Your account also offers permanent
account deletion, confirmed with the exact sign-in email and current password;
it removes the active journal, credentials, sessions, consent and token records.
It preserves other users and shared client registrations. An interrupted erasure
resumes before startup accepts requests, and captures refuse pending erasures.
Older recovery bundles cannot restore against a changed account inventory.
Hosting snapshots and protected recovery copies may retain earlier records;
there is no guaranteed backup-erasure deadline or scale guarantee.

## Distribution gates

- Preserve the existing owner group, deployments, keys, journals and consents.
- Review this change and the dependency lockfile prerequisite. Before any live
  change, capture and verify coordinated recovery material and an owner
  preservation baseline. Never restore an older auth database as routine
  rollback: that can undo account and access state.
- Deploy to the existing service only with the exact source recorded. Do not
  create paid resources, enable automatic deploys, or rotate existing secrets.
- Test live enrollment with disposable operator-controlled email addresses,
  including delivery, recovery, export, account deletion and two-account isolation. Confirm the
  owner's prior records and approved AI access still work afterward.
- In App Store Connect, create an external group (for example, KAIROS Friends
  Pilot), select an eligible build, and complete Beta App Information and What
  to Test. Provide an accurate reachable privacy URL and a dedicated Apple
  reviewer account containing only synthetic notes. Never use the owner account
  or expose the staging secret in review notes. Keep automatic tester
  notification and public links off until enrollment is ready.
- Submit the first external build for TestFlight Beta App Review. An internal
  Testing state and Ready to Submit are not external approval. Follow Apple's
  actual current status and any additional requirements in the submission UI.
- After approval and live preflight, add only the intended external recipients
  and send their separate TestFlight and account-setup invitations. Do not add
  friends as App Store Connect users.

## Record the first independent acceptance

Use a fresh per-person account and synthetic notes. Record timestamps, exact
build and source, results and note IDs, without passwords, codes or tokens.

Check invite/install, own-email signup and confirmation, empty initial journal,
native sign-in, save/read after reopening, supported-AI first connection,
retrieval in a fresh chat, AI write-back visible in Anamnesis, and absence of
another account's practice note. Check export against the saved records.
On disposable accounts, verify sign-out survival, Disconnect refusal with
notes retained, and password recovery preserving notes and intended approvals.
Do not exercise destructive owner controls on the real owner account.

Local fixtures cover admission, concurrent replay, wrong-email and expiry
refusal, same-email confirmation, preserved owner notes and signed AI grant,
restart, disabled defaults and controlled recovery. They do not prove actual
email delivery, provider setup, Apple approval or independent physical usage.
