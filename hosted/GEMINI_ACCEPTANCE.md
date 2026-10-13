# Consumer Gemini compatibility — evidence and open gates

## Observed October 13, 2026

The owner's actual Gemini web **Personal Intelligence → Connected Apps** page offers custom MCP apps. Entering the existing invited-staging `/mcp` URL reached Google's security/privacy acknowledgement, which the owner authorized. The next browser request used a Google-hosted, account-and-service-host-bound Client ID Metadata Document, an exact Google callback, `journal:read journal:write`, and PKCE S256. The deployed three-provider allow-list rejected this new identity. No Kairos journal grant succeeded at that point.

The observed Google metadata uses `private_key_jwt` with RS256 and public keys at:

`https://www.gstatic.com/account-linking/.well-known/client-assertion-signature-verification-key.json`

The real account identifier, OAuth state, challenge, codes, tokens and private credentials are excluded from this document and the repository.

## Compatibility implemented for verification

- Admit only the exact Google-owned `clientidmetadata/user_bound_provider/user_bound_custom-mcp-<21-digit-account>-<this-service-host>` shape in invited staging. Other paths, hosts, query strings, fragments and service bindings remain refused; public dynamic registration stays disabled.
- Before persistence, require the original exact client identity, six observed Google callback forms bound to that same slug, signed RSA authentication, authorization-code/refresh grants, and the observed journal scopes.
- Better Auth 1.7.7 requires remote keys to share a metadata or browser-trusted origin. The adapter fetches only Google's exact key resource through the existing public-DNS-pinned/no-redirect transport, then supplies the complete public key set inline. Browser trusted origins remain the service origin alone.
- The original metadata and key responses are bounded. The transformed document must still fit the existing 5 KiB MCP metadata cap. Overflow rejects the connection; no keys are discarded.
- Google metadata and public keys are re-fetched together after a 60-second cache interval. Conditional metadata validators are removed so an unchanged metadata document cannot conceal changed keys. This is a bounded freshness policy, not immediate key refresh on signature failure.
- The resource now advertises its existing `offline_access` capability for explicit client requests and owner consent. Already-approved read/write tokens do not require this additional scope. The initial observed Gemini request did **not** include it; successful automatic renewal remains a separate live gate.

## Dated acceptance and open gates

Source `6ffb4e8dce888f1d4aa54139a043b3c756c9df2a` was deployed to the existing invited pilot. All **72 hosted** and **42 engine** checks passed; CI run [38396503688](https://github.com/Steffan005/Kairos-Bridge-AI-Journal/actions/runs/38396503688) succeeded. After restart, an independent owner API comparison matched all 67 pre-update records exactly, verified the then-current 68-record chain and matched all three existing approvals unchanged.

A fresh actual Gemini linking attempt reached Kairos's real permission page on the same phone-pilot journal. Google's metadata now declares `journal:read journal:write offline_access`; the visible Kairos page requests read, save/pin and access between conversations. The owner approved these permissions. The first request expired during UI troubleshooting, so its submit returned `invalid_signature`; the actual signed URL's expiry was already 351 seconds in the past. A fresh request then succeeded with the original verification and expiry intact.

The owner API then listed a fourth approval with the three requested scopes. Gemini saved the custom app as **Kairos-Bridge**, enabled, and displayed eight journal tools. This was setup evidence; actual conversation acceptance followed separately below.

- Generated-key protocol fixtures: valid signed exchange; refused wrong callback, wrong key, unsigned exchange and wrong PKCE; exact consent scopes; key refresh after expiry; metadata overflow; owner sign-out and Disconnect.
- Deployment reports the exact tested revision; existing owner records and approvals survive unchanged.
- Actual Google/Kairos consent shows the intended owner journal and requested scopes.
- Actual Gemini retrieves a known note, writes once and independently reads the saved note; another fresh conversation retrieves it.
- Gemini iPhone app performs an actual call; its saved reply appears in native Kairos.
- Automatic renewal and physical Gemini sign-out/Disconnect behavior are recorded separately from initial read/write.

A fixture, consent page or Connected badge is not proof of an actual Gemini conversation. Existing Claude, ChatGPT and Grok iPhone evidence is recorded in their own receipts.

## Owner iPhone round trip, followed by missing mobile app

On October 13, the owner reported an actual Gemini iPhone read of Grok's linen-curtains note, followed by one write and a separate read-back. Independent owner API and approved Kairos reads matched the saved record exactly:

- Text: `Synthetic Gemini iPhone acceptance: the kitchen bowls are ceramic.`
- ID: `d30eb12921889ca5`; actor: `gemini`; tag: `project-kitchen`.
- Created at: `2026-10-13T13:01:52.769Z`; exact matching text count: one.

Another new Gemini iPhone conversation returned that same record. The owner explicitly confirmed its visibility after refreshing native Kairos. These are bounded owner-phone results, with the write independently confirmed; no raw physical-device tool trace was captured. Initial connector setup was performed on the Mac, not entirely on an iPhone.

Source `e790d8965afe04ace663d8d6ff251fc63c46782e` subsequently deployed the neutral restart message for invalid consent links, with 75 hosted checks passing and successful CI. Independent checks matched every one of the 74 pre-check journal records unchanged and found all four approvals, including Google's read/write and explicitly approved renewal. This message change leaves authorization expiry and verification intact.

During the final post-expiry read check, the owner updated Gemini on iPhone and reported that Kairos was no longer present in the app's `@` picker or his phone browser, while the Mac connection reportedly still worked. The actual phone Connected Apps screen and account comparison are requested. The cause is unresolved; no permissions or clients were changed to work around it. The service was healthy and the saved record remained present once. **Continued Gemini mobile availability and access beyond the initial 15-minute token remain open gates.** No successful live refresh exchange is claimed.

This hosted connector uses Google's account-level custom app and a public HTTPS endpoint. It does not depend on a desktop Chrome extension, local Mac daemons, Tailscale or the older Trinity Bridge. Historical local-bridge explanations do not diagnose this configuration. Physical Gemini Sign out/Disconnect checks and independent onboarding also remain untested.

## Primary provider instructions

[Google custom apps help](https://support.google.com/gemini/answer/17209137?hl=en&co=GENIE.Platform%3DiOS), checked October 13, describes setup through Gemini web followed by mobile use, subject to account eligibility and settings. The actual signed-in UI and OAuth request above are the evidence for this owner's available route. No Google activity/privacy setting was changed for this attempt.
