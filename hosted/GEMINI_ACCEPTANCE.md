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

## Required acceptance before a support claim

Source `6ffb4e8dce888f1d4aa54139a043b3c756c9df2a` is deployed to the existing invited pilot. All **72 hosted** and **42 engine** checks passed; CI run [38396503688](https://github.com/Steffan005/Kairos-Bridge-AI-Journal/actions/runs/38396503688) succeeded. After restart, an independent owner API comparison matched all 67 pre-update records exactly, verified the then-current 68-record chain and matched all three existing approvals unchanged.

A fresh actual Gemini linking attempt reached Kairos's real permission page on the same phone-pilot journal. Google's metadata now declares `journal:read journal:write offline_access`; the visible Kairos page requests read, save/pin and access between conversations. Owner approval is pending at this checkpoint. No actual Gemini read/write or renewal has passed yet.

- Generated-key protocol fixtures: valid signed exchange; refused wrong callback, wrong key, unsigned exchange and wrong PKCE; exact consent scopes; key refresh after expiry; metadata overflow; owner sign-out and Disconnect.
- Deployment reports the exact tested revision; existing owner records and approvals survive unchanged.
- Actual Google/Kairos consent shows the intended owner journal and requested scopes.
- Actual Gemini retrieves a known note, writes once and independently reads the saved note; another fresh conversation retrieves it.
- Gemini iPhone app performs an actual call; its saved reply appears in native Kairos.
- Automatic renewal and physical Gemini sign-out/Disconnect behavior are recorded separately from initial read/write.

A fixture, consent page or Connected badge is not proof of an actual Gemini conversation. Until the live gates pass, Gemini remains unverified. Existing Claude, ChatGPT and Grok iPhone evidence is recorded in their own receipts.

## Primary provider instructions

[Google custom apps help](https://support.google.com/gemini/answer/17209137?hl=en&co=GENIE.Platform%3DiOS), checked October 13, describes setup through Gemini web followed by mobile use, subject to account eligibility and settings. The actual signed-in UI and OAuth request above are the evidence for this owner's available route. No Google activity/privacy setting was changed for this attempt.
