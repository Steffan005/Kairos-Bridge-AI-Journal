# Start with Kairos

**Your work should outlive the chat window.** Kairos gives the AI apps you approve a shared journal for the notes, preferences and decisions you want to carry forward.

**Keep your information local.** Run the open-source Journal on your own computer, choose its storage file, and connect compatible AI tools to it. A managed invited service is another deployment option. An AI connection describes access to a journal; the deployment determines where its records are stored.

## Choose your path

| You want to… | Start here |
|---|---|
| Use or inspect the native iPhone companion | [Kairos for iPhone](https://github.com/Steffan005/Kairos-Bridge-iOS). Its journal view is **Anamnesis — Your journal**. The app is in an invited TestFlight beta. The owner accepted TestFlight 0.1.0 build 7 on October 15, 2026 using the configured account service. Public App Store release remains ahead. |
| Connect local desktop AI tools to a file you control | [Run the local Journal](README.md#run-the-local-journal), then configure a supported MCP client. |
| Run an optional account and connection service | [Self-hostable adapter source and setup](hosted/README.md). Run it on an operator-controlled computer or server; the managed invited pilot is one deployment and has no public customer signup. |
| Use project resumption and handoffs locally or through the service | [Local Journal setup](README.md#run-the-local-journal) and [continuation contract](hosted/CONTINUE.md). |

The Journal engine can serve a local MCP client directly. The optional account adapter adds sign-in and approved connections when serving clients over HTTP. Where its files live depends on the deployment you choose. The native iPhone pilot has its own invited setup and configured service address; installing the local Journal does not install that app.

## What a return can look like

With Kairos already connected and approved in a supported AI app:

1. Ask it to save a synthetic project note, such as “For project-kitchen, the chosen curtain fabric is linen.”
2. Open another supported AI app connected to the same journal and ask it to retrieve that note, including its recorded author, date and note ID.
3. Ask to continue the project through local MCP or the account service. The briefing can select recorded goals and decisions, explicitly recorded open work and handoffs addressed to that actor. Corrections and resolutions use explicit note IDs while the original history stays available.

The connected app must actually invoke the journal tools. A setup screen or a model's claim that it remembers is not a retrieval result. Kairos stores notes delivered to it; it does not automatically read every conversation in every provider's history.

## Inspect the evidence

| Mechanism or demonstration | Source |
|---|---|
| Local storage, hashing, search and measured synthetic storage benchmark | [Local README](README.md#what-it-does-in-plain-words), [benchmark results](bench-results/storage-bench-300000.json) |
| Hosted account isolation, consent and owner controls | [Service overview](hosted/README.md) |
| Actual ChatGPT and Grok owner-phone shared-journal paths | [ChatGPT acceptance](hosted/CHATGPT_ACCEPTANCE.md), [Grok acceptance](hosted/GROK_ACCEPTANCE.md) |
| Gemini's initial round trip and later phone availability hold | [Gemini evidence](hosted/GEMINI_ACCEPTANCE.md). Current documented use is scoped to the computer browser. |
| Local and service-mode project briefings, explicit corrections and addressed handoffs; authenticated delivery origin on the account-service path | [Continuation contract](hosted/CONTINUE.md) |
| Controlled hosted recovery preserving 131,820 baseline owner entries | [October 15 recovery rehearsal](hosted/RECOVERY_ACCEPTANCE_2026-10-15.md). This is a manual operator-run exercise, not an automatic recovery service. |
| Latest native beta and its acceptance boundaries | [iPhone acceptance history](https://github.com/Steffan005/Kairos-Bridge-iOS/blob/chatgpt/native-first-slice/ACCEPTANCE.md) |

These records describe dated, bounded demonstrations. Independent onboarding, broader client compatibility, physical failure cases and customer readiness remain separate work.

## Your record and your connections

Local mode uses a file on your computer. The optional account adapter stores a separate journal per account under the operator-configured data directory, wherever that service runs. An approved AI receives the notes it retrieves and handles them under its provider's policies. Export gives you a copy of the record. The account service's **Disconnect all AI access** control revokes approved connections; signing out of the native app or browser is a different action.

On the authenticated account-service path, declared Author and the server-observed connection that delivered the record are distinct. Local MCP operation does not invent authenticated delivery origin; its explicit recipient selector can route addressed handoffs. Hash verification checks the record chain; it does not establish the factual truth of a note, the underlying model or the identity of a particular human. A 25 ms timestamp coordinate is not evidence of a continuously running 40 Hz process.

## Credit, licensing and related patent work

**Kairos Journal, created by Steffan Douglas Haskins.** Source is available under **AGPL-3.0-or-later**, with separate commercial licensing available. Commercial terms, including any royalty arrangements, are undisclosed. See [License](README.md#license) and [Commercial use](README.md#commercial-use).

Related orchestration work is patent pending: *Harmonic Orchestration System for AI Agents*, U.S. application **19/860,331**, inventor **Steffan Douglas Haskins**; related provisional **63/912,083**. Submission and payment were acknowledged November 2, 2026. This identifies the related application without asserting a granted patent or coverage of every continuity feature.
