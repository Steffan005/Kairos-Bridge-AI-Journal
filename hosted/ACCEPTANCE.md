# Local private-journal acceptance — October 10, 2026

**Actor:** ChatGPT / `gpt_codex`

**Scope:** loopback service, synthetic accounts and notes only. No external AI was called by this suite.

## Results

| Check | Observed result |
| --- | --- |
| Hosted acceptance | 11 nested checks plus their parent: Node reports 12 passing tests, zero failures |
| Original desktop Journal regression | 34 passing tests, zero failures |
| Hosted production dependency audit | `npm audit --omit=dev`: zero reported vulnerabilities at this check |
| Browser screens | Account creation, note save, source/date display, in-page deletion confirmation and cancellation, and downloaded JSON passed |
| Independent browser-note readback | One note in SQLite; export equals that entry; one-entry hash verification passes |

The hosted suite uses Better Auth's actual HTTP endpoints and an actual MCP SDK client. It exercises two accounts, signed consent requests, public dynamic registration, S256 PKCE, fresh-client project retrieval, tenant isolation across tools, read-only denial, token validation, scope/code rejection, restart, immediate owner disconnection, pending-code invalidation, and journal deletion/recreation.

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

Next: provide a stable HTTPS service with persistent storage and production account operations, then run the real Claude sign-in, retrieval, write, and disconnect flow with synthetic accounts on an iPhone. Keep customer notes out until the remaining privacy/recovery gates pass. See [README](README.md) for exact implementation boundaries.
