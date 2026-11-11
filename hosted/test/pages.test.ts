// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext, Script } from "node:vm";
import { page } from "../src/pages.js";

const origin = "https://journal.example.test";
const clientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";

// Lightweight DOM fixture for generated script behavior, not a browser/device test.
async function journalScreen(connections: { clientId: string; scopes: string[] }[]) {
  const rendered = page("journal", undefined, { staging: true });
  const script = rendered.html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)![1];
  new Script(script);
  const nodes = new Map<string, any>();
  function node(selector: string): any {
    if (!nodes.has(selector)) nodes.set(selector, {
      textContent: "", href: "", value: "", style: {},
      classList: { toggle() {}, add() {}, remove() {} },
      replaceChildren() {}, append() {}, focus() {},
    });
    return nodes.get(selector);
  }
  runInNewContext(script, {
    document: { querySelector: node, createElement: (tag: string) => node(tag) },
    location: { origin, search: "", assign() {} }, URL,
    fetch: async () => ({ ok: true, json: async () => ({ connections, entries: [], deleted: false }) }),
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  return { rendered, node };
}

test("invited journal prepares the documented Claude form without sending a credential", async () => {
  const { rendered, node } = await journalScreen([]);
  const href = new URL(node("#connect-claude").href);
  assert.equal(href.origin + href.pathname, "https://claude.ai/customize/connectors");
  assert.deepEqual(Object.fromEntries(href.searchParams), {
    modal: "add-custom-connector", connectorName: "Kairos", connectorUrl: origin + "/mcp",
  });
  assert.equal(node("#mcp-address").value, origin + "/mcp");
  assert.equal(node("#connect-claude").textContent, "Connect Claude");
  assert.match(rendered.html, /Already added Kairos in Claude/);
  assert.match(rendered.html, /check your account email/);
  assert.match(rendered.html, /cannot tell whether the connector is enabled/);
  assert.match(rendered.csp, /connect-src 'self'/);
});

test("approved Claude access opens existing connections and still explains the chat step", async () => {
  const { node } = await journalScreen([{ clientId, scopes: ["journal:read"] }]);
  assert.equal(node("#connect-claude").href, "https://claude.ai/customize/connectors");
  assert.equal(node("#connect-claude").textContent, "Open Claude connections");
  assert.match(node("#claude-status").textContent, /access is approved/);
  assert.match(node("#claude-status").textContent, /Enable your Kairos connector/);
});

test("another client's approval does not report Claude as approved", async () => {
  const { node } = await journalScreen([{ clientId: "other-fixture", scopes: ["journal:read"] }]);
  assert.equal(node("#connect-claude").textContent, "Connect Claude");
  assert.equal(new URL(node("#connect-claude").href).searchParams.get("modal"), "add-custom-connector");
});

test("local preview does not offer a cloud connector for its loopback address", () => {
  const local = page("journal");
  assert.doesNotMatch(local.html, /id="connect-claude"/);
  assert.doesNotMatch(local.html, /id="mcp-address"/);
  new Script(local.html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)![1]);
});
