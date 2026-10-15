// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Script, runInNewContext } from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { page } from "../src/pages.js";
import { createPreview } from "../src/service.js";
import type { AccountMail } from "../src/accountAccess.js";

const origin = "https://journal.example.test", token = "synthetic-link-token-only-for-this-fixture";
const password = "synthetic-current-password", newPassword = "synthetic-replacement-password";
const testAccount = { id: "synthetic-owner", email: "pilot@example.test", emailVerified: false,
  emailChangeAvailable: true, recoveryAvailable: false };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
type Call = { path: string; method: string; body?: Record<string, unknown> };
type Reply = { status?: number; body?: unknown };
type Respond = (call: Call) => Reply | Promise<Reply>;
type View = Parameters<typeof page>[0];

// Generated-script fixture, not a browser/device acceptance check. No real
// mailbox, account, credential, or external network is used.
function screen(view: View, options: { enabled?: boolean; hash?: string; search?: string; respond?: Respond } = {}) {
  const rendered = page(view, undefined, { staging: true, accountRecovery: options.enabled ?? true });
  const source = rendered.html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)![1]; new Script(source);
  const calls: Call[] = [], redirects: string[] = [], cleaned: string[] = [], nodes = new Map<string, any>();
  for (const match of rendered.html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const classes = new Set((match[0].match(/\bclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean));
    nodes.set("#" + match[1], { value: "", textContent: "", disabled: /\sdisabled(?:\s|>)/.test(match[0]), style: {}, focused: false,
      classList: { add(name: string) { classes.add(name); }, remove(name: string) { classes.delete(name); },
        contains(name: string) { return classes.has(name); },
        toggle(name: string, force: boolean) { if (force) classes.add(name); else classes.delete(name); } },
      focus() { this.focused = true; } });
  }
  const node = (selector: string) => { const found = nodes.get(selector); assert.ok(found, `fixture contains ${selector}`); return found; };
  const location = { origin, pathname: "/" + view, search: options.search ?? "", hash: options.hash ?? "", assign(value: string) { redirects.push(value); } };
  const forbiddenStorage = new Proxy({}, { get() { throw new Error("Recovery tokens must not enter storage"); } });
  runInNewContext(source, { document: { querySelector: node }, location, URL, URLSearchParams,
    localStorage: forbiddenStorage, sessionStorage: forbiddenStorage,
    console: { log() { throw new Error("Recovery tokens must not be logged"); } },
    history: { replaceState(_state: unknown, _title: string, path: string) {
      assert.equal(path, location.pathname); cleaned.push(path); location.hash = ""; location.search = ""; } },
    fetch: async (path: string, init: { method?: string; body?: string } = {}) => {
      const call = { path, method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(init.body) } : {}) }; calls.push(call);
      const result = await (options.respond?.(call) ?? { body: testAccount }), status = result.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => result.body ?? {} };
    } });
  const submit = async (selector: string) => { const handler = node(selector).onsubmit;
    assert.equal(typeof handler, "function", `${selector} has a handler`); await handler({ preventDefault() {} }); };
  return { rendered, source, node, calls, redirects, cleaned, location, submit };
}
function deferredReply() { let resolve!: (reply: Reply) => void; const promise = new Promise<Reply>(done => { resolve = done; }); return { promise, resolve }; }

test("test account can request a real email before password recovery is enabled", async () => {
  const s = screen("account"); await flush();
  assert.equal(s.node("#new-email").disabled, false); assert.equal(s.node("#change-submit").disabled, false);
  assert.equal(s.node("#account-reset").classList.contains("hidden"), true);
  s.node("#new-email").value = "  owner@fixture-mail.net  "; s.node("#current-password").value = password;
  await s.submit("#email-change");
  assert.deepEqual(s.calls[1], { path: "/api/account/email-change", method: "POST", body: { newEmail: "owner@fixture-mail.net", currentPassword: password } });
  assert.equal(s.node("#current-password").value, ""); assert.match(s.node("#status").textContent, /If this address can be used/);
});
test("verified recovery is shown separately from email-change configuration", async () => {
  const s = screen("account", { respond: () => ({ body: { ...testAccount, emailVerified: true, recoveryAvailable: true } }) });
  await flush(); assert.equal(s.node("#account-reset").classList.contains("hidden"), false); assert.match(s.node("#recovery-help").textContent, /verified email/);
  const disabled = screen("account", { respond: () => ({ body: { ...testAccount, emailChangeAvailable: false } }) });
  await flush(); assert.equal(disabled.node("#change-submit").disabled, true); await disabled.submit("#email-change");
  assert.equal(disabled.calls.length, 1); assert.match(disabled.node("#recovery-help").textContent, /not available/);
});
test("account expiry uses the fixed sign-in return; failures clear passwords and stay generic", async () => {
  const expired = screen("account", { respond: () => ({ status: 401, body: { message: "synthetic-private-error" } }) });
  await flush(); assert.deepEqual(expired.redirects, ["/sign-in?returnTo=account"]);
  const s = screen("account", { respond: call => call.method === "GET" ? { body: testAccount } : { status: 403, body: { error: "synthetic-private-error" } } });
  await flush(); s.node("#current-password").value = password; await s.submit("#email-change");
  assert.equal(s.node("#current-password").value, ""); assert.match(s.node("#status").textContent, /Check your current password/);
  assert.doesNotMatch(s.node("#status").textContent, /synthetic-private/);
});
test("link pages remove fragments immediately and never automatically POST", async () => {
  for (const view of ["confirm-email", "reset-password"] as const) {
    const s = screen(view, { hash: "#token=" + token }); await flush();
    assert.deepEqual(s.cleaned, ["/" + view]); assert.equal(s.location.hash, "");
    assert.equal(s.calls.some(call => call.method !== "GET"), false); assert.equal(s.redirects.length, 0);
    assert.doesNotMatch(s.rendered.html, new RegExp(token)); assert.match(s.rendered.csp, /connect-src 'self'; form-action 'self'/);
    assert.match(s.rendered.csp, /script-src 'nonce-[^']+'/);
  }
});
test("missing tokens keep reset and confirmation disabled", async () => {
  const reset = screen("reset-password"); await reset.submit("#reset-password");
  assert.equal(reset.node("#reset-submit").disabled, true); assert.equal(reset.calls.length, 0);
  const confirm = screen("confirm-email"); await confirm.submit("#confirm-email");
  assert.equal(confirm.node("#confirm-submit").disabled, true); assert.equal(confirm.calls.length, 0);
});
test("confirmation keeps its token in memory while signing into the existing account", async () => {
  let signedIn = false;
  const s = screen("confirm-email", { hash: "#token=" + token, respond: call => {
    if (call.path === "/api/account") return signedIn ? { body: testAccount } : { status: 401 };
    if (call.path === "/api/auth/sign-in/email") { signedIn = true; return { body: { url: "https://hostile.example/ignored" } }; }
    return { body: { status: true } };
  } });
  await flush(); assert.equal(s.node("#confirm-submit").disabled, true);
  s.node("#confirmation-email").value = testAccount.email; s.node("#confirmation-password").value = password;
  await s.submit("#confirmation-login");
  assert.deepEqual(s.calls[1], { path: "/api/auth/sign-in/email", method: "POST", body: { email: testAccount.email, password } });
  assert.equal(s.node("#confirmation-password").value, ""); assert.equal(s.node("#confirm-submit").disabled, false);
  assert.equal(s.calls.filter(call => call.path === "/api/account/confirm-email").length, 0);
  await s.submit("#confirm-email"); assert.deepEqual(s.calls.at(-1), { path: "/api/account/confirm-email", method: "POST", body: { token } });
  assert.equal(s.node("#confirm-email").classList.contains("hidden"), true); assert.equal(s.node("#confirmation-login").classList.contains("hidden"), true);
  assert.equal(s.redirects.length, 0); const count = s.calls.length; await s.submit("#confirm-email"); assert.equal(s.calls.length, count);
});
test("confirmation lookup blocks conflicting sign-in; failed login clears password", async () => {
  const pending = deferredReply();
  const s = screen("confirm-email", { hash: "#token=" + token, respond: call => call.path === "/api/account" ? pending.promise : { status: 401, body: { message: "synthetic-private-login" } } });
  assert.equal(s.node("#confirmation-login-submit").disabled, true); await s.submit("#confirmation-login"); assert.equal(s.calls.length, 1);
  pending.resolve({ status: 401 }); await flush(); s.node("#confirmation-password").value = password; await s.submit("#confirmation-login");
  assert.equal(s.node("#confirmation-password").value, ""); assert.doesNotMatch(s.node("#status").textContent, /synthetic-private/);
  assert.equal(s.node("#confirm-submit").disabled, true);
});
test("rejected confirmation stays generic and can require fresh inline sign-in", async () => {
  const s = screen("confirm-email", { hash: "#token=" + token, respond: call => call.method === "GET" ? { body: testAccount } : { status: 401, body: { error: token, message: "another-owner-id" } } });
  await flush(); await s.submit("#confirm-email"); assert.equal(s.node("#confirm-submit").disabled, true);
  assert.equal(s.node("#confirmation-login-submit").disabled, false); assert.doesNotMatch(s.node("#status").textContent, /another-owner|synthetic-link/);
});
test("reset validates matching passwords, clears them, and preserves AI wording", async () => {
  const s = screen("reset-password", { hash: "#token=" + token });
  s.node("#new-password").value = newPassword; s.node("#confirm-password").value = password;
  await s.submit("#reset-password"); assert.equal(s.calls.length, 0); assert.equal(s.node("#confirm-password").focused, true);
  s.node("#confirm-password").value = newPassword; await s.submit("#reset-password");
  assert.deepEqual(s.calls[0], { path: "/api/account/reset-password", method: "POST", body: { token, newPassword } });
  assert.equal(s.node("#new-password").value, ""); assert.equal(s.node("#confirm-password").value, "");
  assert.equal(s.node("#reset-password").classList.contains("hidden"), true);
  assert.match(s.node("#status").textContent, /Sign in again in your browser and Kairos app/);
  assert.match(s.node("#status").textContent, /approved AI connections remain available/);
  await s.submit("#reset-password"); assert.equal(s.calls.length, 1);
});
test("failed reset clears passwords and never displays tokens or backend detail", async () => {
  const s = screen("reset-password", { hash: "#token=" + token, respond: () => ({ status: 400, body: { error: token, message: "synthetic-private-error" } }) });
  s.node("#new-password").value = s.node("#confirm-password").value = newPassword; await s.submit("#reset-password");
  assert.equal(s.node("#new-password").value, ""); assert.equal(s.node("#confirm-password").value, "");
  assert.doesNotMatch(s.node("#status").textContent, /synthetic-private|synthetic-link/);
});
test("forgot-password responses stay generic for success and failure", async () => {
  for (const reply of [{ body: { status: true } }, { body: { message: "synthetic-private-identity" } }, { status: 503, body: { error: "synthetic-private-mail" } }]) {
    const s = screen("forgot-password", { respond: () => reply }); s.node("#recovery-email").value = "  owner@fixture-mail.net  ";
    await s.submit("#forgot-password"); assert.deepEqual(s.calls[0].body, { email: "owner@fixture-mail.net" });
    assert.doesNotMatch(s.node("#status").textContent, /synthetic-private/);
  }
});
test("pending account forms ignore duplicate submit attempts", async () => {
  for (const [view, form] of [["account", "#email-change"], ["forgot-password", "#forgot-password"], ["reset-password", "#reset-password"], ["confirm-email", "#confirm-email"]] as const) {
    const pending = deferredReply();
    const s = screen(view, { hash: "#token=" + token, respond: call => call.method === "GET" ? { body: testAccount } : pending.promise }); await flush();
    if (view === "reset-password") s.node("#new-password").value = s.node("#confirm-password").value = newPassword;
    const first = s.submit(form); await s.submit(form); assert.equal(s.calls.filter(call => call.method === "POST").length, 1, view);
    pending.resolve({ body: { status: true } }); await first;
  }
});
test("disabled configuration keeps controls unavailable and still removes fragments", async () => {
  for (const [view, action] of [["account", "#change-submit"], ["forgot-password", "#recovery-submit"], ["reset-password", "#reset-submit"], ["confirm-email", "#confirm-submit"]] as const) {
    const s = screen(view, { enabled: false, hash: "#token=" + token }); await flush(); assert.equal(s.node(action).disabled, true, view);
    assert.equal(s.calls.some(call => call.method === "POST"), false); assert.match(s.rendered.html, /not available on this service yet/);
    if (view === "reset-password" || view === "confirm-email") assert.deepEqual(s.cleaned, ["/" + view]);
  }
});
test("fixed account return removes only its parameter and preserves OAuth query bytes", async () => {
  const rawOAuth = "state=encoded%20value&sig=abc%2Fdef&other=%2b";
  for (const [search, expectedQuery, destination] of [["?returnTo=account", undefined, "/account"], ["?returnTo=https%3A%2F%2Fhostile.example", undefined, "/journal"], ["?" + rawOAuth + "&returnTo=account", rawOAuth, "/consent?fixture=1"]] as const) {
    const s = screen("sign-in", { search, respond: () => ({ body: expectedQuery ? { url: destination } : {} }) });
    s.node("#email").value = "owner@fixture-mail.net"; s.node("#password").value = password; await s.submit("#login");
    assert.deepEqual(s.calls[0].body, { email: "owner@fixture-mail.net", password, ...(expectedQuery ? { oauth_query: expectedQuery } : {}) });
    assert.deepEqual(s.redirects, [destination]); assert.equal(s.node("#password").value, "");
  }
});
test("navigation, labels, password bounds and signup-only test wording remain explicit", () => {
  const signIn = page("sign-in", undefined, { staging: true, accountRecovery: true });
  assert.match(signIn.html, /New test accounts must use addresses ending in \.test/); assert.match(signIn.html, /Sign in with your current Kairos email/);
  assert.match(signIn.html, /href="\/forgot-password"/); assert.match(page("journal").html, /href="\/account"/);
  for (const view of ["account", "forgot-password", "reset-password", "confirm-email"] as const) {
    const html = page(view, undefined, { accountRecovery: true }).html;
    for (const input of html.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      assert.ok(html.includes(`for="${input[1]}"`), `${view} labels ${input[1]}`);
      assert.match(input[0], /autocomplete="(?:email|username|current-password|new-password)"/);
      if (input[0].includes('type="password"')) assert.match(input[0], /minlength="12" maxlength="128"/);
    }
    assert.match(html, /role="status" aria-live="polite"/);
  }
});

async function freePort(): Promise<number> {
  const socket = net.createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(resolve => socket.close(() => resolve())); return port;
}
// Real HTTP dispatch on loopback with synthetic mailbox capture. No mail leaves
// the process, and all account/journal files are temporary and removed afterward.
test("HTTP account routes preserve the owner and journal through email and password changes", { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-account-page-http-")), baseURL = `http://127.0.0.1:${await freePort()}`;
  const mail: AccountMail[] = [];
  const preview = await createPreview({ baseURL, directory, secret: randomBytes(32).toString("hex"), accountDelivery: { async send(message) { mail.push(message); } } });
  const request = (path: string, options: RequestInit = {}) => fetch(baseURL + path, { redirect: "manual", ...options, headers: { connection: "close", ...options.headers } });
  const post = (path: string, data: unknown, cookie = "") => request(path, { method: "POST", headers: { origin: baseURL, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(data) });
  const cookieFrom = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const signUp = async (email: string) => { const response = await post("/api/auth/sign-up/email", { email, password, name: "Synthetic page tester" }); assert.equal(response.status, 200); return { cookie: cookieFrom(response), user: (await response.json()).user }; };
  try {
    await preview.listen();
    for (const path of ["/forgot-password", "/reset-password", "/confirm-email"]) {
      const response = await request(path); assert.equal(response.status, 200, path); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer"); assert.match(response.headers.get("content-security-policy")!, /form-action 'self'/); assert.match(await response.text(), /role="status"/);
    }
    assert.equal(mail.length, 0); const protectedPage = await request("/account"); assert.equal(protectedPage.status, 302);
    assert.equal(protectedPage.headers.get("location"), "/sign-in?returnTo=account"); assert.equal((await request("/api/account")).status, 401);
    const owner = await signUp("pages-owner@example.test"), other = await signUp("pages-other@example.test");
    assert.equal((await post("/api/auth/sign-up/email", { email: "new@fixture-mail.net", password, name: "Synthetic" })).status, 400);
    assert.equal((await request("/account", { headers: { cookie: owner.cookie } })).status, 200);
    const initial = await (await request("/api/account", { headers: { cookie: owner.cookie } })).json();
    assert.equal(initial.id, owner.user.id); assert.equal(initial.emailChangeAvailable, true); assert.equal(initial.recoveryAvailable, false);
    assert.equal((await post("/api/journal/notes", { text: "Synthetic account continuity note", tags: [] }, owner.cookie)).status, 201);
    const blocked = await request("/api/account/email-change", { method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ newEmail: "owner@fixture-mail.net", currentPassword: password }) });
    assert.equal(blocked.status, 403); assert.equal(mail.length, 0);
    const changed = await post("/api/account/email-change", { newEmail: "owner@fixture-mail.net", currentPassword: password }, owner.cookie);
    assert.equal(changed.status, 200); assert.equal(mail.length, 1);
    const changeToken = new URLSearchParams(new URL(mail[0].url).hash.slice(1)).get("token")!; assert.ok(changeToken); assert.equal(new URL(mail[0].url).search, "");
    assert.equal((await request("/confirm-email")).status, 200);
    assert.equal((await (await request("/api/account", { headers: { cookie: owner.cookie } })).json()).email, owner.user.email, "opening the page never changes the account");
    assert.equal((await post("/api/account/confirm-email", { token: changeToken })).status, 401);
    assert.equal((await post("/api/account/confirm-email", { token: changeToken }, other.cookie)).status, 400);
    assert.equal((await post("/api/account/confirm-email", { token: changeToken }, owner.cookie)).status, 200);
    const confirmed = await (await request("/api/account", { headers: { cookie: owner.cookie } })).json();
    assert.equal(confirmed.id, initial.id); assert.equal(confirmed.email, "owner@fixture-mail.net"); assert.equal(confirmed.recoveryAvailable, true);
    const missing = await post("/api/account/forgot-password", { email: "missing@fixture-mail.net" }), existing = await post("/api/account/forgot-password", { email: confirmed.email });
    assert.equal(missing.status, 200); assert.equal(existing.status, 200); assert.deepEqual(await existing.json(), await missing.json()); assert.equal(mail.length, 2);
    const resetToken = new URLSearchParams(new URL(mail[1].url).hash.slice(1)).get("token")!;
    assert.equal((await request("/reset-password")).status, 200); assert.equal((await request("/api/account", { headers: { cookie: owner.cookie } })).status, 200, "opening reset page never invalidates a session");
    assert.equal((await post("/api/account/reset-password", { token: resetToken, newPassword })).status, 200);
    assert.equal((await request("/api/account", { headers: { cookie: owner.cookie } })).status, 401);
    const login = await post("/api/auth/sign-in/email", { email: confirmed.email, password: newPassword }); assert.equal(login.status, 200); assert.equal((await login.json()).user.id, initial.id);
    const journal = await (await request("/api/journal", { headers: { cookie: cookieFrom(login) } })).json(); assert.equal(journal.count, 1); assert.equal(journal.entries[0].text, "Synthetic account continuity note");
  } finally { await preview.close(); rmSync(directory, { recursive: true, force: true }); }
});
test("HTTP default configuration renders unavailable help with generic reset responses", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "kairos-account-page-disabled-")), baseURL = `http://127.0.0.1:${await freePort()}`;
  const preview = await createPreview({ baseURL, directory, secret: randomBytes(32).toString("hex") });
  try {
    await preview.listen(); for (const path of ["/forgot-password", "/reset-password", "/confirm-email"]) { const response = await fetch(baseURL + path); assert.equal(response.status, 200); assert.match(await response.text(), /not available on this service yet/); }
    const response = await fetch(baseURL + "/api/account/forgot-password", { method: "POST", headers: { origin: baseURL, "content-type": "application/json" }, body: JSON.stringify({ email: "synthetic@fixture-mail.net" }) });
    assert.equal(response.status, 200); assert.match((await response.json()).message, /If this address/);
  } finally { await preview.close(); rmSync(directory, { recursive: true, force: true }); }
});
