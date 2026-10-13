// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext, Script } from "node:vm";
import { page } from "../src/pages.js";

const friendly = "This connection request is no longer valid. Start again from your AI app.";
const query = "state=synthetic-private-state&sig=synthetic-signature";

// Generated-script fixture only. No real browser, signed request, account,
// credential, journal, authorization endpoint or external network is used.
function consentScreen(ok: boolean, response: Record<string, unknown>) {
  const rendered = page("consent", { client: "Synthetic AI app", clientId: "synthetic-client",
    email: "page-fixture@example.test", redirectHost: "synthetic.example.test", scopes: ["journal:read", "journal:write"] });
  const script = rendered.html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)![1];
  new Script(script);
  const nodes = new Map<string, any>();
  const calls: Array<{ path: string; method: string; body: string }> = [];
  const redirects: string[] = [];
  function node(selector: string): any {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: "", disabled: false, style: {} });
    return nodes.get(selector);
  }
  runInNewContext(script, {
    document: { querySelector: node },
    location: { search: "?" + query, assign: (url: string) => redirects.push(url) },
    fetch: async (path: string, options: { method: string; body: string }) => {
      calls.push({ path, method: options.method, body: options.body });
      return { ok, json: async () => response };
    },
  });
  return { node, calls, redirects };
}

test("expired or modified consent signatures show a neutral restart instruction", async () => {
  for (const action of ["#allow", "#deny"]) {
    const screen = consentScreen(false, { error: "invalid_signature", message: "synthetic-private-state",
      error_description: "synthetic-signature" });
    await screen.node(action).onclick();
    assert.equal(screen.node("#status").textContent, friendly);
    assert.equal(screen.node("#allow").disabled, false); assert.equal(screen.node("#deny").disabled, false);
    assert.equal(screen.redirects.length, 0);
    assert.doesNotMatch(screen.node("#status").textContent, /expired|invalid_signature|synthetic|state=|sig=/);
    assert.deepEqual(JSON.parse(screen.calls[0].body), { accept: action === "#allow", oauth_query: query });
    assert.equal(screen.calls[0].path, "/api/auth/oauth2/consent"); assert.equal(screen.calls[0].method, "POST");
  }
});

test("other consent failures keep their existing human-readable message", async () => {
  const screen = consentScreen(false, { error: "other_error", message: "Please sign in to Kairos." });
  await screen.node("#allow").onclick();
  assert.equal(screen.node("#status").textContent, "Please sign in to Kairos.");
  assert.equal(screen.redirects.length, 0);
});

test("successful consent still redirects using the unchanged approval request", async () => {
  const destination = "https://synthetic.example.test/callback";
  const screen = consentScreen(true, { url: destination });
  await screen.node("#allow").onclick();
  assert.deepEqual(screen.redirects, [destination]);
  assert.deepEqual(JSON.parse(screen.calls[0].body), { accept: true, oauth_query: query });
  assert.equal(screen.node("#status").textContent, "");
});
