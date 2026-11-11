# Hosted recovery acceptance — October 15, 2026

**Status: manual recovery rehearsal passed within the scope below.** Deployment, local/CI tests, all 10 hosted synthetic drill checks, actual captures A/B, encrypted off-host custody, controlled restore, fresh-process sign-in/readback, live-owner preservation, and owned staging cleanup passed. The restored copy retained 6 accounts, 5 journals, and 131,831 entries. All 131,820 baseline owner entries retained their exact exported fields; the live owner had 2 later entries and all 4 approval IDs/scopes unchanged. Captures paused data requests for 71.123 / 72.577 seconds and reached the 512 MiB memory limit. This is an operator-run recovery rehearsal with the remaining manual limits listed below.

Prepared by `gpt_codex` for the existing invited development pilot. This report records sanitized results only. Keep database bundles, account identifiers, journal contents, credentials, private age identities, and private storage paths out of this document. Operator receipts remain private; add only the relevant revision, timestamps, counts, hashes, timings, and outcomes below.

## Source and deployment chronology

All human-readable times in this table use America/New_York (EDT, UTC−04:00).

| Event | Exact source or deployment | Observed result |
| --- | --- | --- |
| Recovery implementation | `03e0c9de7cc4e0696508b3177fee558e861e777d` | Coordinated capture, request/background-work drain, read-only verification workers, private Unix socket control, encrypted vault tools, and isolated synthetic drill implemented. |
| Implementation CI | [Run 38678344649](https://github.com/Steffan005/Kairos-Bridge-AI-Journal/actions/runs/38678344649) | Passed for `03e0c9d`. CI is implementation evidence, not hosted recovery acceptance. |
| First hosted attempt | `dep-db84tk2vcj2c7387nuvg`; October 14, 11:56 PM EDT; duration 2m 58s | Failed during startup because newly created recovery directories inherited the parent's SGID bit. The strict private-directory check rejected the resulting mode. The platform automatically returned to executable source `f51ff7a9c7acd2af8f770d479c3a9f60ec3a2c43`. This describes the application deployment outcome; it does not establish a database rollback or a completed recovery capture. |
| Permission correction | `62f5daeec1f476924edaf4c3f229d4e47f1b46bc` | Newly created private directories have their mode normalized to `0700`. Existing operator directories still undergo strict validation and are not silently repaired. Matching pack/unpack directory creation was corrected too. |
| Correction CI | [Run 38679522036](https://github.com/Steffan005/Kairos-Bridge-AI-Journal/actions/runs/38679522036) | Passed for exact source `62f5dae`: root 78/78, hosted 114/114, and vault 11/11 on Linux, with no failures. The operator verified these counts in the raw run log. The Linux regression fixture requires actual inherited SGID, exercising the deployment condition. |
| Corrected hosted attempt | `dep-db854h8n74is73dr8jrg`; started October 15, 12:10:45 AM EDT; Live at 12:13:41 AM EDT (`2026-10-15T04:13:41Z`); duration 2m 56s | Passed. Public `/about` served exact source `62f5daeec1f476924edaf4c3f229d4e47f1b46bc`. SSH inspection confirmed socket parent and output directories mode `0700`, socket mode `0600`, and owner UID `1000`. |

The SGID correction addresses inherited special permission bits on newly created directories. It does not relax the requirement for private ownership and permissions, follow replacement symbolic links, or change existing operator directories.

## Verified local evidence

These results were obtained with disposable local fixtures. They do not demonstrate that the Render disk has been captured or recovered.

| Check | Result | Scope |
| --- | --- | --- |
| Root suite | 78 passed | Local run completed before the directory-only correction; exact corrected source subsequently passed 78/78 in Linux CI. |
| Hosted suite, corrected source | 114 passed | Includes capture admission/draining, auth background writes, SQLite lease exclusion, worker deadlines, HTTP health availability, private socket integration, cleanup, SGID behavior, and existing hosted behavior. |
| Vault suite, corrected source | 10 passed; 1 skipped locally; 11/11 passed in Linux CI | The Mac filesystem did not reproduce directory SGID inheritance for the skipped vault subtest. Linux CI exercised and passed that platform-specific regression. |
| Recovery behavior | Passed in synthetic fixtures | Two-owner isolation; later deletion handling; deletion/recreation refusal; fresh authorization after restore; historical access/refresh credentials rejected; missing, changed, unsupported, and broken-chain captures refused. |
| Private operator control | Passed in synthetic fixtures | Unix socket permissions and framing; fixed output roots; bounded requests; one capture at a time; sanitized receipts; shutdown waits; handled failures remove only the owned operation directory. |
| Encryption/opening | Passed in synthetic fixtures | Streaming age encryption; independent ciphertext pins; explicit latest-witness selection; wrong keys, altered ciphertext, unsafe archive members, and changed inputs rejected; failed opening removes partial plaintext. |

An intermittent Better Auth diagnostic reported missing tables while a fresh synthetic database was still being migrated. The awaited initialization and subsequent acceptance checks passed. This diagnostic was observed separately from the hosted SGID startup failure and is not evidence of either a successful or failed hosted restore.

### Local scale measurement

A synthetic local Mac fixture exercised the final capture/verification architecture with 131,806 entries and 94,883,840 bytes of copied database files. No live journal contents were used.

| Measurement | Observed value |
| --- | ---: |
| Drain time | 6 ms |
| Capture time | 4,373 ms |
| Total data-request pause | 4,380 ms |
| Health probes during capture | 342 successful responses |
| Maximum health response time | 23 ms |
| Data requests receiving maintenance `503` | 342 |
| Maximum event-loop delay | 78 ms |
| Process RSS before capture | 135 MiB |
| Peak process RSS | 261 MiB |

Verification iterates SQLite rows; it does not load all journal entries into an array. File hashing uses a 64 KiB buffer, and only one inspector worker runs at a time. The worker's 128 MiB old-space setting is not a total process or cgroup memory limit. These Mac measurements are not a Render latency or memory guarantee.

## Hosted preflight context

The operator's preflight observation recorded a 512 MiB / 0.5 CPU instance, cgroup `memory.current` of 77,950,976 bytes (approximately 74 MiB), a 233 MiB live data directory, and 131,820 journal entries. That memory value covers the cgroup and is not service RSS. `/tmp` was observed on disk-backed `/dev/root`, with 52,364 MiB available; it was not a tmpfs mount. The persistent `/var/data` filesystem had 725 MiB available.

These are preflight observations. Captures A and B subsequently used `/tmp` staging outside the live data directory. Their measured memory and health behavior, followed by the authenticated live-owner comparison, are recorded below.

### Private live baseline

The authenticated owner baseline completed at `2026-10-15T03:51:26.893Z` under source `f51ff7a9c7acd2af8f770d479c3a9f60ec3a2c43`. It recorded 131,820 entries, independently verified all 131,820 chain links, and recorded 4 approvals. The head hash was `0a7d5b7f1144f4d2d9c24611d66dc7d9d4214af43ff30ab4c4343889ef9b92d1`; the approval-inventory hash was `efee853c3ad9a05fcfd976a318d3d4c6d69cd825ff3878321d67d68861d987ce`. Exact exported fields were retained in the private comparison snapshot.

This baseline covers the observed owner's export and approvals. It does not establish other-account contents, provider conversations, or global deletion freshness. One baseline journal read returned `502`; its retry returned `200`. These observations preceded the corrected deployment and actual capture.

## Verified hosted synthetic drill

The private operator receipt `kairos-synthetic-hosted-recovery-drill-v1` records `ok: true` at exact source `62f5daeec1f476924edaf4c3f229d4e47f1b46bc`. The run started at `2026-10-15T04:14:48.999Z` and finished at `2026-10-15T04:14:54.896Z`, taking 5,897 ms. It used isolated synthetic data and a distinct restored process with the same origin and authentication secret. The receipt contains no persisted credentials. No actual journal capture or restore is established by this fixture.

| Operation | Accounts / journals / files | Drain | Capture | Total request pause |
| --- | --- | ---: | ---: | ---: |
| First private-socket capture, `2026-10-15T04:14:51.088Z` | 2 / 2 / 4 | 0 ms | 496 ms | 496 ms |
| Later capture after disconnect and deletion, `2026-10-15T04:14:51.702Z` | 2 / 1 / 3 | 0 ms | 538 ms | 538 ms |

The isolated restore took 106 ms. It retained 2 accounts, 1 journal, and 1 entry; discarded 1 deleted journal using the later witness; and required fresh authorization.

| Hosted synthetic check | Result |
| --- | --- |
| Two isolated owners before capture | Passed |
| First capture through private socket | Passed |
| Later witness includes disconnect and deletion | Passed |
| Restore in distinct process with same origin and authentication secret | Passed |
| Old sessions, access credentials, and refresh credentials rejected | Passed |
| Note and all metadata match exactly | Passed |
| Deleted owner remains empty and isolated | Passed |
| Fresh PKCE consent and MCP read succeed | Passed |
| Signing key and access generation changed | Passed |
| Historical credentials still rejected after fresh consent | Passed |

## Actual capture A and off-host custody

Capture A completed at `2026-10-15T04:23:56.994Z` using exact source `62f5daeec1f476924edaf4c3f229d4e47f1b46bc`. The independent observation records a completed, known result. No automatic retry was required.

| Capture receipt field | Recorded value |
| --- | --- |
| Backup ID | `d0a02f72-a1dc-4fb5-8ae2-2e34c935a8e0` |
| Accounts / journals / database files | 6 / 5 / 7 |
| Drain / capture / total request pause | 0 / 71,123 / 71,123 ms |
| Private control request duration | 71,209 ms |
| Manifest SHA-256 | `99566af42e50a0b9446e28dad5ca64efc349db21ab3b3e589d92d7ce91ba3c64` |
| Capture-time witness ID | `97999512-91e6-4d30-b96e-10af39af20d9` |
| Capture-time witness SHA-256 | `af9c7d14fa809ff442ba12e228b723d03caf0f8a34443031f578d83eaad7e039` |

This capture exercised a manual maintenance pause of approximately 71 seconds. Ordinary database requests are rejected with maintenance `503` during the pause. It is not routine, user-transparent backup behavior. The capture receipt does not supply per-journal entry totals; the retained owner's count and exact metadata were subsequently checked in the isolated restore.

### Measured host behavior

| Observation during capture A | Recorded value |
| --- | ---: |
| Health responses | 655; all HTTP `200` |
| Maximum health response time | 3,743 ms |
| Cgroup memory before / after | 118,902,784 / 508,493,824 bytes |
| Sampled peak / configured cgroup limit | 536,870,912 / 536,870,912 bytes (512 MiB) |
| Memory samples / errors | 711 / 0 |
| Sampling interval / largest gap | 100 / 170 ms |

Memory reached the configured cgroup limit. The sampled peak is a lower-bound observation, and successful completion does not establish spare memory capacity. A follow-up inspection reported `memory.events` counters `oom=0`, `oom_kill=0`, and `max=2336`. At that later inspection, memory included 66,105,344 bytes anonymous, 388,505,600 bytes file-backed, and 19,898,368 bytes kernel memory. File cache predominated after capture; this does not establish anonymous-memory usage at the peak. The same service process remained present with 102,280 KiB RSS and 10m 56s elapsed runtime, supporting no observed restart during capture A. The later authenticated live-owner comparison passed as recorded below.

### Encrypted transfer receipts

The archive was sealed at `2026-10-15T04:24:53.297Z` using age over tar+gzip. It contains 239,620,982 content bytes across 9 archive files, including the 7 database files, manifest, and capture-time witness. The separate authentication-secret envelope was captured at `2026-10-15T04:25:31.208Z` and binds its receipt to the source revision, origin, backup ID, and archive hash without recording the secret value.

Off-host custody was verified at `2026-10-15T04:26:56.380642Z`:

| Encrypted artifact | Bytes | SHA-256 | Destination mode |
| --- | ---: | --- | --- |
| Capture A archive | 39,686,596 | `4af6c69914e0d302ff417238fff32a57cb62ca8edc342e99487ef1c648a88c14` | `0600` |
| Separate authentication-secret envelope | 243 | `f9356afc925d40f87b7278ed2e4a9f17d5b8f620ee968a94ebee432d896610da` | `0600` |

Both transferred ciphertexts matched their independently retained size and SHA-256 receipts. The custody receipt confirms that the private age identity stayed off-host and the destination is outside iCloud and Git. The operator subsequently reported successful off-host decryption/unpacking of all 9 archive files and successful separate authentication-secret decryption and parsing into a private file without exposing its value. Capture A's witness remains capture-time evidence; the controlled restore used the later witness from capture B.

## Capture B and controlled off-host restore

Capture B completed at `2026-10-15T04:27:42.376Z` and was observed at `2026-10-15T04:27:42.390Z`, using the same exact `62f5dae` source. Its backup ID is `38922252-6c9c-4b87-8bdc-2bf39a3fe1d8`. It captured 6 accounts, 5 journals, and 7 database files with 0 ms drain and 72,577 ms capture/request pause. The private control request took 72,609 ms.

The later witness was obtained through the authenticated private socket on the still-live trusted service and retained separately for restore. Its ID is `5e8e2e4b-3786-483e-a8bb-3ed56f6f24d8`, and SHA-256 is `4329e3996e6796a29810c48344bbd079f22d734917acea7115d3337bacd5a103`. This establishes the operator's contemporaneous source of deletion state for this drill; it does not establish authority over later deletions or an unobserved source rollback.

| Observation during capture B | Recorded value |
| --- | ---: |
| Health responses | 674; all HTTP `200` |
| Maximum health response time | 1,815 ms |
| Cgroup memory before / after | 499,527,680 / 508,993,536 bytes |
| Sampled peak / configured cgroup limit | 536,870,912 / 536,870,912 bytes (512 MiB) |
| `memory.events` `oom` / `oom_kill`, before and after | 0 / 0 |
| `memory.events` `max`, before → after | 2,525 → 7,476 |
| Memory samples / errors | 726 / 0 |
| Sampling interval / largest gap | 100 / 158 ms |

Capture B again reached the memory limit without an OOM event recorded in the before/after counters. The increasing `max` counter records memory-limit pressure. Endpoint memory-stat snapshots do not establish memory composition at the peak.

The controlled restore receipt records success at `2026-10-15T04:28:53.884Z` for capture A using this later witness. It retained 6 accounts, 5 journals, and 131,831 total entries, discarded 0 journals, and requires reauthorization. The live journal inventory had not been deleted between these captures, so the actual restore did not discard a journal; deletion exclusion was exercised separately in the hosted synthetic drill. The restored-data total covers all retained journals and is distinct from the owner-scoped counts below.

### Actual restored-copy sign-in and readback

The private `kairos-private-real-restore-check-v1` receipt records `ok: true` for an isolated new process bound only to loopback. The check ran from `2026-10-15T04:29:27.029Z` through `2026-10-15T04:29:48.960Z`, with a recorded duration of 21,929 ms. It used capture A, the exact original authentication secret, and capture B's separately trusted witness.

| Actual restored-copy check | Result |
| --- | --- |
| All restored journals | 6 accounts, 5 journals, 131,831 entries; all journal chains verified |
| Authorization state before startup | Zero rows in `session`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `verification`, `oauthClientAssertion`, and `jwks` |
| Existing owner session | Old session token absent; saved cookie and its locally normalized equivalent both rejected with HTTP `401` |
| Fresh owner sign-in | Original password login succeeded with the exact original authentication secret |
| Fresh AI approval state | 0 approved AI connections; no inherited grants |
| Owner journal | 131,822 entries with head `6385224aa00db1199f82ce7f775f79286a4e9dd99361c22e2692e96e4f40ba9b` |
| Baseline preservation | All 131,820 baseline entries form an exact field-by-field append prefix; dates, origin, provenance, and continuity preserved |
| Historical and recent readback | Earliest historical note and newest note lookups matched exactly |
| Read-only preservation | All journal counts and heads unchanged after the reads and process shutdown |

Historical AI authorization rows were cleared in the actual restored database. Unavailable historical bearer-token bytes were not individually replayed. Historical access/refresh replay rejection and fresh PKCE consent/MCP access were exercised with known synthetic credentials in the separate hosted drill. The actual restored-copy check exercised fresh password sign-in, owner readback, and rejection of the saved owner session; it made no provider conversation calls or new note writes.

## Live-owner preservation after capture

The authenticated after-observation ran from `2026-10-15T04:28:29.542Z` through `2026-10-15T04:28:59.169Z` at exact source `62f5daeec1f476924edaf4c3f229d4e47f1b46bc`. All recorded HTTP reads returned `200`. The export was bracketed by matching owner counts of 131,822, with stable approvals and shared-state entries.

- All 131,820 baseline entries retained every exported field exactly, including write-origin fields; the baseline append prefix was unchanged.
- The full 131,822-entry chain passed independent verification, with 2 appended entries. Its head hash was `6385224aa00db1199f82ce7f775f79286a4e9dd99361c22e2692e96e4f40ba9b`.
- All 4 live approval IDs and scopes were unchanged; the approval-inventory SHA-256 remained `efee853c3ad9a05fcfd976a318d3d4c6d69cd825ff3878321d67d68861d987ce`.
- The existing authenticated owner session remained usable for the observed reads. These receipts do not exercise provider conversations or establish other-account contents.

## Cleanup and retained evidence

Host cleanup completed at `2026-10-15T04:31:18.471446Z`, removing 12 owned items: the A/B capture staging directories, synthetic drill and observation staging, temporary vault output, and installation/observation/sealing helpers. The cleanup receipt confirms that the live data directory was untouched and the private control roots were retained.

Mac cleanup completed at `2026-10-15T04:31:32.115168Z`. It removed the opened capture, isolated restored directory, and raw authentication-secret file. The encrypted archive, private age identity, independent receipts, and private before/after audit snapshots were retained. The audit snapshots include plaintext export data; cleanup does not claim their deletion. Their retention and eventual removal remain explicit operator responsibilities.

The operator subsequently recorded completion checkpoint `1e7579a1080e5cb3` at `2026-10-15T04:31:55.958Z`. This was written after both captures and is outside the encrypted capture A cutoff. No later live entry count is inferred from that checkpoint.

## Hosted acceptance receipts

All rehearsal gates below are supported by the supplied local, CI, or operator receipts. Each result retains its stated scope; future recoveries require fresh operator evidence.

| Gate | Required sanitized receipt | Status |
| --- | --- | --- |
| Corrected deployment | Live deployment `dep-db854h8n74is73dr8jrg` at `2026-10-15T04:13:41Z`; public `/about` serves exact `62f5dae`; SSH confirms private directories `0700`, socket `0600`, UID `1000` | Passed |
| Disposable hosted drill | Exact executable revision; isolated synthetic-only run; start/end timestamps; distinct restored process; owner isolation, deletion handling, fresh authorization, and old-credential refusal, as recorded above | Passed: 10/10 checks |
| Live baseline | Owner baseline completed at `2026-10-15T03:51:26.893Z`: 131,820 entries and verified chain links, head hash, and 4 approvals retained for comparison | Passed within stated owner scope |
| Coordinated live capture | Captures A/B each completed with 6 accounts, 5 journals, 7 database files, exact revision, and pinned witnesses; pauses 71,123 / 72,577 ms | Passed |
| Host resource behavior | A/B health probes all `200`; both captures reached 512 MiB; OOM counters remained zero; live authenticated reads resumed | Passed observed runs at limit; manual maintenance constraint |
| Encrypted off-host custody | Archive byte count and SHA-256 matched; independent receipt retained; private identity remained off-host; mode `0600`; all 9 archive files unpacked | Passed |
| Authentication-secret custody | Separate 243-byte ciphertext matched its SHA-256 off-host with mode `0600`; private decryption and parsing passed without value exposure | Passed |
| Latest deletion witness | Separately retained capture B witness from authenticated socket on the trusted still-live source; exact witness hash used by controlled restore | Passed for this restore's observed boundary |
| Isolated restore of captured data | Controlled restore retained 6 accounts, 5 journals, 131,831 entries; discarded 0; distinct-process password sign-in, exact owner readback, empty grants, old-session refusal, and unchanged journal heads passed | Passed within stated credential and readback scope |
| Live journal preservation | All 131,820 baseline entries/fields unchanged; 131,822-entry chain verified; 4 approval IDs/scopes unchanged; existing session read successfully | Passed within stated owner scope |
| Owned staging cleanup | 12 owned host items removed; opened capture, restored copy, and raw secret removed on Mac; live directory/control roots untouched; encrypted artifacts and private audit snapshots retained | Passed within explicit retained-evidence scope |

## Remaining manual pilot limits

- Captures are operator initiated. There is no automatic backup interval, continuous replication, declared recovery-point objective, or recovery-time guarantee.
- Data written after capture lies outside that capture's recovery boundary. Deployment success alone does not protect the journal.
- A capture-time witness cannot establish later deletion history. A timestamp and matching hash do not prove freshness. If authoritative current deletion state is unavailable after source loss or rollback, do not treat an old witness as current.
- A new account or a deletion/recreation after the chosen capture can make the capture unsuitable; the controlled restore intentionally refuses unsupported histories.
- This workflow does not provide customer password reset, independent identity recovery, production account erasure, or erasure of retained backups.
- Capture pauses new database requests with `503` and `Retry-After`; it drains admitted requests and tracked authentication work. Actual captures A/B paused admission for 71.123 / 72.577 seconds, requiring manual maintenance windows. The configured drain limit is 15 seconds. Capture has a 120-second deadline with worker cancellation and cooperative checks around copy/publication; filesystem stalls are not a hard real-time guarantee.
- Health bypasses request admission. Captures A/B returned `200` for all 655 / 674 probes, with maxima of 3.743 / 1.815 seconds; both reached the 512 MiB cgroup limit. These runs support bounded manual capture on the observed host, not headroom or a latency guarantee for later workloads.
- The ciphertext receipt supplies an independently retained integrity pin, not a signature or an automatic source of deletion authority. The public age recipient can encrypt other archives.
- Keep the private age identity off-host, retain a separately protected key copy, and record a retention schedule. The service authentication secret requires separate encrypted custody; the journal vault does not include it.
- Handled failures clean up owned partial outputs. A crash, power loss, `SIGKILL`, or filesystem cleanup error can leave private remnants requiring operator inspection. Client timeout or disconnection alone does not cancel a capture.
- `/tmp` is staging storage. A same-host copy is not an off-host recovery copy. Plaintext artifacts must be removed after the accepted encrypted copy and evidence are retained.
- Restored processes use a new private data directory. This acceptance workflow does not replace the live service directory or revoke existing live approvals. Restored sessions and AI approvals must be recreated explicitly.

Operational details: [controlled recovery](RECOVERY.md) and [encrypted vault workflow](RECOVERY_VAULT.md).
