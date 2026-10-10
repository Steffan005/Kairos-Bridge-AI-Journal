# Private-journal development acceptance — October 10, 2026

**Actor:** ChatGPT / `gpt_codex`

**Scope:** local HTTP services, synthetic accounts and notes, including a simulated HTTPS proxy. No external AI was called by this suite. Real approved Kairos project notes are exercised separately in the local Journal; they are not test fixtures or hosted customer data.

## Results

| Check | Observed result |
| --- | --- |
| Hosted acceptance | OAuth/account tests and staging configuration/proxy tests: Node reports 20 passing tests including parents, zero failures |
| Original desktop Journal regression | 34 passing tests, zero failures |
| Hosted production dependency audit | `npm audit --omit=dev`: zero reported vulnerabilities at this check |
| Browser screens | Account creation, note save, source/date display, in-page deletion confirmation and cancellation, and downloaded JSON passed |
| Independent browser-note readback | One note in SQLite; export equals that entry; one-entry hash verification passes |

The hosted suite uses Better Auth's actual HTTP endpoints and an actual MCP SDK client. It exercises two accounts, signed consent requests, local dynamic registration, S256 PKCE, fresh-client project retrieval, tenant isolation across tools, read-only denial, token validation, scope/code rejection, restart, immediate owner disconnection, pending-code invalidation, and journal deletion/recreation. It also checks that browser sign-out/expiry preserve approved AI access, offline refresh works after sign-out, access lifetime is 15 minutes, and a matching refresh retry returns the same rotated credentials. A pinned recent entry appears only once in the owner view.

Staging tests simulate edge forwarding over local HTTP. They check strict Host/Origin/protocol handling, canonical HTTPS discovery, the invitation and `.test` signup gate, secure cookies, disabled public dynamic registration, rejection of other metadata origins, source revision, restart/export and active deletion. They do **not** establish that Render's real proxy behaves identically or that Anthropic's actual metadata document is accepted.

Deletion/recreation was exercised through the API in the automated suite. The browser check exercised **Keep my journal**, not the final destructive button. Browser width was temporarily set to 390 pixels; this is a responsive-layout check, not a physical iPhone result.

## Repeat

From the repository root:

```sh
npm ci
npm test
cd hosted
npm ci
npm test
```

The workflow in `.github/workflows/acceptance.yml` runs both suites on pushes and pull requests. A local pass does not itself establish a remote CI pass.

## Limits and next gate

These results do not prove Claude's published-client/CIMD interoperability, physical iPhone OAuth setup, onboarding by an independent tester, public hosting, recovery, backups, performance at scale, or native iOS/TestFlight delivery. The earlier fixed-Bearer Claude iPhone run is separate evidence and does not certify this new sign-in path.

Next: deploy the prepared [invited staging](STAGING.md) after account/resource approval, verify the real proxy and storage, then run Claude sign-in, retrieval, write, sign-out and disconnect with development accounts on an iPhone. Keep customer notes out until the remaining privacy/recovery gates pass. See [README](README.md) for exact implementation boundaries.
