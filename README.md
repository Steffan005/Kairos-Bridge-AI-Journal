# Kairos-Bridge AI Journal (MCP server)

**A memory journal that you own, which every AI you use can read and write.**

Your AI reads your journal before it talks to you and writes a short note afterward. Switch from Claude to ChatGPT to Cursor and each one still knows you, because the memory sits in a file on **your** computer and not inside any company's app.

> Patent pending, U.S. Provisional 63/912,083.
> Status: private preview (v0.1.0). Not published yet. Planned home: https://github.com/Steffan005/Kairos-Bridge-AI-Journal
> Contact: Steffan Douglas Haskins, steffan.haskins@gmail.com
> Kairos Journal, created by Steffan Douglas Haskins. Copyright (C) 2026 Steffan Douglas Haskins. Free, open-source software under the GNU AGPL-3.0-or-later (see [License](#license)).

---

## What it does, in plain words

- **One file, on your machine.** Everything is stored in a single file: `~/.kairos-journal/journal.db`. No account, no cloud, and nobody pays for storage, because it's your own disk.
- **Any AI app can plug in.** It speaks MCP (Model Context Protocol), the standard plug for connecting tools to AI apps such as Claude Desktop, Cursor and others.
- **Tamper-evident.** Every entry carries a fingerprint (a SHA-256 hash) of itself plus the entry before it, like links in a chain. If anyone edits or deletes an old entry, `verify` catches it and points to where.
- **Append-only.** Entries are never edited or deleted. A correction is simply a new entry.
- **Stamped in order.** Each entry records the time (UTC) plus a "tick": the number of 25-millisecond steps since 1970, which gives every entry a precise place in the timeline.

### What the AI gets (the tools)

| Tool | When the AI uses it |
|---|---|
| `journal_wake` | At the start of a conversation. Returns a short briefing: your pinned entries (who you are, what you prefer) plus the most recent notes, capped at about 6,000 characters. |
| `journal_write` | When it learns something you'd want remembered (a preference, a fact, a decision, a short session summary). It's told never to write secrets, and the server also refuses obvious ones (passwords, API keys, card numbers and similar). |
| `journal_search` | When you mention something from the past. Searches by word across every entry. |
| `journal_verify` | When you ask "is my journal intact?" It re-checks every fingerprint and link. |
| `journal_export` | When you ask for a backup. Saves JSON or Markdown in a folder you own and never overwrites an existing file. |
| `journal_pin` / `journal_unpin` | Mark an entry to appear in every briefing, or stop showing it. Nothing gets deleted. |
| `journal_about` | When you ask who made it, what the license is, or where the source code is. (The same information is available as the MCP resource `kairos-journal://about` and, in HTTP mode, at `GET /about`.) |

Each entry contains: `id`, `created_at` (ISO time, UTC), `tick` (= floor(milliseconds ÷ 25)), `actor` (who wrote it, e.g. `claude`, `chatgpt`, `steffan`), `kind` (`note`, `fact`, `preference`, `decision` or `summary`), `text`, `tags`, `parent_hash` (the previous entry's hash, or 64 zeros for the first entry) and `hash`.

---

## 2-minute install

You need **Node.js 20 or newer** ([nodejs.org](https://nodejs.org), LTS version recommended).

```bash
# 1. Get the code
git clone https://github.com/Steffan005/Kairos-Bridge-AI-Journal.git
cd Kairos-Bridge-AI-Journal

# 2. Install and build
npm install
npm run build

# 3. Create your journal and check it
node dist/src/cli.js init
node dist/src/cli.js stats
```

Then connect your AI app (below) and restart the app. In a new chat, ask: *"Check my journal, then remember that I prefer short answers."*

> **If `npm install` fails while building `better-sqlite3`:** that library ships ready-made binaries for common setups, and when none fits your machine it compiles from source, which needs build tools (macOS: `xcode-select --install`; Debian/Ubuntu: `sudo apt install build-essential`). Using the current Node LTS usually avoids this.

---

## Connect it to your AI app

In the examples below, replace `/Users/YOUR_NAME/Kairos-Bridge-AI-Journal` with the real folder path (run `pwd` inside the folder to see it).

### Claude Desktop (macOS / Windows)

In Claude Desktop, open **Settings → Developer → Edit Config**. That opens `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Paste the following (or add the `kairos-journal` block next to the servers you already have):

```json
{
  "mcpServers": {
    "kairos-journal": {
      "command": "node",
      "args": ["/Users/YOUR_NAME/Kairos-Bridge-AI-Journal/dist/src/server.js"],
      "env": {
        "KAIROS_JOURNAL_ACTOR": "claude"
      }
    }
  }
}
```

Fully quit Claude Desktop and reopen it. If the server doesn't show up, replace `"node"` with Node's full path (run `which node` on macOS or `where node` on Windows). Claude's logs live in `~/Library/Logs/Claude` on macOS and `%APPDATA%\Claude\logs` on Windows.

### Cursor

Put this in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), then restart Cursor:

```json
{
  "mcpServers": {
    "kairos-journal": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/YOUR_NAME/Kairos-Bridge-AI-Journal/dist/src/server.js"],
      "env": {
        "KAIROS_JOURNAL_ACTOR": "cursor"
      }
    }
  }
}
```

### Other apps that run local MCP servers

Use the same command: `node /path/to/Kairos-Bridge-AI-Journal/dist/src/server.js`. Every app on the same computer can point at the same journal file at the same time, because SQLite handles the locking.

### Apps that only accept a URL (HTTP mode)

Some apps (ChatGPT, and Claude's web "custom connectors") don't start programs on your computer. They connect from their own cloud to a **public HTTPS address**. For those, run the server in HTTP mode:

```bash
export KAIROS_JOURNAL_TOKEN="$(openssl rand -hex 32)"   # a long random secret
node dist/src/server.js --http --port 8787
# -> listening on http://127.0.0.1:8787/mcp (bearer token required)
```

- By default it listens **only on your own computer** (127.0.0.1). Binding to any other address is refused unless `KAIROS_JOURNAL_TOKEN` is set.
- With the token set, every request must send `Authorization: Bearer <token>`.
- With no token set, it accepts requests only when they're addressed to `localhost`/`127.0.0.1`. That blocks web pages from reaching it through DNS tricks. To accept a tunnel's hostname without a token, list it in `KAIROS_JOURNAL_ALLOWED_HOSTS`, though using a token is strongly recommended.
- Endpoint: `POST /mcp` (MCP Streamable HTTP, stateless). `GET /healthz` returns `{"ok":true}`.

What each app needs, as of October 2026 (check the linked docs, since these change often):

| App | How it connects | Works with this server today? |
|---|---|---|
| Claude Desktop | Local (stdio) | Yes, config above. |
| Cursor | Local (stdio), or a URL with custom headers | Yes. For HTTP use `"url": "http://127.0.0.1:8787/mcp"` and `"headers": {"Authorization": "Bearer ${env:KAIROS_JOURNAL_TOKEN}"}` (see `examples/cursor-mcp-http.json`). |
| Claude (web/desktop) custom connectors | From Anthropic's cloud, public HTTPS URL; sign-in via OAuth, none, or fixed request headers | Possible through a tunnel you run (e.g. Cloudflare Tunnel, ngrok, Tailscale Funnel) with the token in a request header. Anthropic's developer docs mark fixed-header auth as beta, so it may not appear for every account. Free plans allow one custom connector. [Docs](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) |
| ChatGPT | From OpenAI's cloud, public HTTPS URL (or OpenAI's Secure MCP Tunnel); auth is OAuth or none | **Not yet with a token.** ChatGPT offers OAuth or no auth, and this server doesn't implement OAuth. Full read and write MCP is limited to Business, Enterprise and Edu workspaces on the web; Pro gets read/fetch only in developer mode. [Docs](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) |

Never expose the HTTP mode to the internet without a token. Anyone who reaches it can read your journal.

---

## Where your data lives

| What | Where |
|---|---|
| The journal | `~/.kairos-journal/journal.db` (plus temporary `-wal`/`-shm` files next to it while in use) |
| Exports | `~/.kairos-journal/exports/` by default |
| Use a different file | set `KAIROS_JOURNAL_DB=/path/to/file.db`, or pass `--db /path/to/file.db` |

The folder is created private to you (permissions `700`, file `600` on macOS/Linux). To back up, copy the file or run `kairos-journal export`. To move to a new computer, copy the file over.

## Privacy

- **In stdio mode (the default), nothing leaves your machine.** The server makes no network connections at all. It reads and writes one local file.
- What the server returns does go to the AI app you connected, and from there to that app's company, the same as anything else you type into that app. Only connect apps you trust with the contents of your journal.
- The AI is told never to save secrets, and the server rejects text that clearly looks like a password, API key, private key, payment card or Social Security number. That check is a safety net, not a guarantee.
- The AI is also told that journal entries are notes, not instructions, so it doesn't obey text that someone slipped into an entry.

---

## Command line

```bash
node dist/src/cli.js init            # create the journal if missing
node dist/src/cli.js stats           # how many entries, size on disk, who wrote what
node dist/src/cli.js verify          # check every fingerprint and link (exit code 2 if broken)
node dist/src/cli.js export --format md --out ~/Desktop/journal.md
node dist/src/cli.js path            # print where the journal file is
node dist/src/cli.js about           # license, copyright and where to get the source
```

(After `npm link` or a future `npm install -g`, the same commands are available as `kairos-journal …`.)

---

## How much space does it take? (measured)

We filled a test journal with **300,000 realistic entries** (mixed lengths from 121 to 3,609 characters, **averaging 848 characters**, median 710; 243 MB of raw text in total) through the real write path, chain hashing included. Measured on an 8-core Intel Xeon Linux machine with Node 20, October 7, 2026:

| Measure | Result |
|---|---|
| File size on disk, 300,000 entries | **458 MB** (479,887,360 bytes) |
| Average size per entry, everything included | **1,600 bytes** (about 1.6 KB) |
| Raw text alone, per entry | 848 bytes |
| Share taken by the search index | 129 MB (28%) |
| Opening the journal | 3 ms |
| `journal_wake` briefing (≈6,000 characters) | **0.4 ms** typical, 0.6 ms 95th percentile |
| `journal_search` (top 10, 160 mixed queries) | **35 ms** typical, 96 ms 95th percentile, 164 ms worst |
| Writing one entry (saved safely to disk) | 1.5 ms typical |
| `verify` of all 300,000 links | 3.4 s |
| Full JSON export | 7.4 s, 339 MB |

**What that means in everyday terms:**
- 1,000 entries take about **1.6 MB**, roughly the size of one phone photo.
- A heavy user writing 20 notes a day adds about **12 MB a year**.
- Even 300,000 long entries come in under half a gigabyte, and shorter notes take less.
- This replaces the earlier "about 1 KB per entry" estimate. The measured figure is about 1.6 KB per ~850-character entry once the search index and fingerprints are included.

Reproduce it: `npm run bench` (or `node dist/bench/storage-bench.js --entries 300000`). The results are saved in `bench-results/`. The entries are synthetic text built to look like real notes, so real journals with shorter notes will be smaller.

---

## For developers

- **Stack:** TypeScript, Node 20+, [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) 1.32, [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) 12 with the FTS5 full-text index (Porter stemming), and `zod` for input schemas.
- **Hash rule:** `hash = sha256( JSON.stringify(["kairos-journal/v1", id, created_at, tick, actor, kind, text, tags, parent_hash]) )`, as lowercase hex. The first entry's `parent_hash` is `"0" × 64`. A JSON export carries everything needed to re-verify the chain in any language without SQLite.
- **Append-only at three levels:** there are no delete or edit tools; database triggers abort any UPDATE or DELETE; and the hash chain reveals anyone who bypasses the triggers with raw file access. `verify` also catches rows removed from the middle (gaps in sequence numbers) or from the end (SQLite's sequence counter runs ahead of the last row).
- **Pins** live in a small separate table outside the chain, because pinning is a display preference and doesn't change what was written.
- **Concurrency:** WAL mode with a 5-second busy timeout. Each write is one immediate transaction, so several apps can share one journal.
- **Tests:** `npm test` runs 29 tests: chain integrity, tamper detection (edit, re-hash, delete-middle, delete-tail), search, the wake size cap, the secret filter, export, an end-to-end MCP client over stdio (list tools → write → wake → search → verify), HTTP mode (bearer token, Host checks, refusal to bind publicly without a token), and licensing (the LICENSE file is the unmodified official text, every source file has its SPDX header, and `journal_about`, `/about` and the server info report the license and source location).

```
src/
  server.ts       MCP server entry (stdio by default, --http for Streamable HTTP)
  tools.ts        the 8 MCP tools, the about resource and the instructions the AI sees
  about.ts        copyright, license, attribution and source location (AGPL notices)
  journal.ts      storage: SQLite schema, hash chain, wake, search, verify, export
  canonical.ts    canonical serialization, SHA-256, 25 ms tick
  secrets.ts      best-effort "this looks like a secret" filter
  http.ts         Streamable HTTP transport with bearer token and Host checks
  exportPath.ts   safe export locations (never overwrite)
  cli.ts          kairos-journal init | stats | verify | export | path | about
  config.ts       paths and environment variables
test/             node:test suites (unit + end-to-end)
bench/            storage and latency benchmark
examples/         ready-to-edit configs for Claude Desktop and Cursor
```

### Environment variables

| Variable | Meaning |
|---|---|
| `KAIROS_JOURNAL_DB` | Path of the journal file (default `~/.kairos-journal/journal.db`) |
| `KAIROS_JOURNAL_ACTOR` | Default "who wrote this" name (otherwise the AI supplies one, or the app's own name is used) |
| `KAIROS_JOURNAL_TOKEN` | HTTP mode: require `Authorization: Bearer <value>` |
| `KAIROS_JOURNAL_ALLOWED_HOSTS` | HTTP mode without a token: extra hostnames to accept (comma-separated) |
| `KAIROS_JOURNAL_SOURCE_URL` | Where network users can download the source code (overrides `kairosJournal.sourceUrl` in `package.json`) |

## Known limitations (v0.1)

- No OAuth yet, so ChatGPT can't connect with a token, and full ChatGPT write access also depends on the ChatGPT plan.
- The secret filter only catches obvious patterns. It can't recognize private facts written in plain words.
- The file isn't encrypted beyond your computer's own disk encryption (FileVault, BitLocker).
- Tamper evidence proves the history wasn't changed **after** it was written. It can't stop someone with access to your computer from rewriting the entire chain from scratch. To guard against that, save the chain head hash (`verify` prints it) somewhere else from time to time.
- No sync between computers yet. Copy the file, or put the folder in a synced drive (with only one computer writing at a time).

## License

**Kairos Journal, created by Steffan Douglas Haskins.**
Copyright (C) 2026 Steffan Douglas Haskins.

Kairos Journal is free, open-source software under the **GNU Affero General Public License, version 3 or (at your option) any later version** (SPDX: `AGPL-3.0-or-later`). The full license is in [`LICENSE`](LICENSE), and the copyright notice and extra terms are in [`NOTICE`](NOTICE).

**In plain words:**
- **You may** use it, study it, change it and share it, for free, for any purpose, including commercial use.
- **If you share it** (the original or your changed version), you have to share the source code too, under the same license.
- **If you change it and let other people use it over a network**, for example by running it as a hosted service, you have to offer those people the source code of your changed version. This is what makes the AGPL different from the ordinary GPL (section 13). The server helps with this: `journal_about`, the `kairos-journal://about` resource and `GET /about` all report where the source can be downloaded. Set `KAIROS_JOURNAL_SOURCE_URL` (or `kairosJournal.sourceUrl` in `package.json`) to your public source location.
- **Credit must stay.** Under an additional term allowed by section 7(b) of the license, every copy and every changed version must keep the notices "Copyright (C) 2026 Steffan Douglas Haskins" and "Kairos Journal, created by Steffan Douglas Haskins", including on any screen that shows legal notices. See `NOTICE`.
- **No warranty.** It comes as is (sections 15 and 16).

**Patents, an honest note.** Patent pending, U.S. Provisional 63/912,083. Section 11 of the AGPLv3 says that each contributor gives everyone who receives the code a **free (royalty-free), worldwide patent license** for any patent claims the contributor owns or controls that the code itself practices, covering making, using, selling and modifying it. In practice, if the patent issues and this code uses what it claims, people using or changing this code under the AGPL cannot be charged patent royalties for that use. The patent can still matter for products that don't use this code. **Steffan should review this with a patent attorney before any public release.** Publishing the code could also count as a public disclosure of the invention, so the timing relative to the nonprovisional filing matters too.

**Commercial licenses.** As the copyright holder, Steffan can also offer the same code under separate commercial terms (dual licensing). See [Commercial use](#commercial-use) below.

Patent pending, U.S. Provisional 63/912,083.

## Commercial use

The journal is **free for everyone under the AGPL**. Companies that want to build it into a **closed-source product or service**, for example an AI assistant's memory feature, without sharing their source code under the AGPL can get a **separate paid commercial license** from Steffan Douglas Haskins. That license is meant to cover use without the AGPL's share-alike obligations, negotiated attribution and terms, and the patent-pending technology (U.S. Provisional 63/912,083).

See [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md) for a plain-language summary. It is not a contract: final terms are set only in a signed agreement, and there is no published price. Contact: **steffan.haskins@gmail.com**.

## Contributing

Contributions are welcome once the Contributor License Agreement is final. Because of dual licensing, every outside contributor must sign the CLA before their changes can be merged. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CLA.md`](CLA.md) (currently a draft awaiting attorney review).
