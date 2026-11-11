// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
import test from "node:test";
import assert from "node:assert/strict";
import { accountDeliveryFromEnvironment, createResendAccountDelivery } from "../src/accountMail.js";

const baseURL = "https://kairos.recovery-fixture.org";
const apiKey = "re_isolated_fixture_not_a_real_key";
const from = "accounts@recovery-fixture.org";
const message = { to: "owner@recovery-fixture.org", kind: "email-change" as const,
  url: `${baseURL}/confirm-email#token=${"x".repeat(43)}` };

test("mail is disabled by default and partial configuration fails closed", () => {
  assert.equal(accountDeliveryFromEnvironment(baseURL, {}), undefined);
  for (const env of [{ KAIROS_EMAIL_PROVIDER: "resend" }, { KAIROS_EMAIL_API_KEY: apiKey },
    { KAIROS_EMAIL_PROVIDER: "other", KAIROS_EMAIL_API_KEY: apiKey, KAIROS_EMAIL_FROM: from }]) {
    assert.throws(() => accountDeliveryFromEnvironment(baseURL, env), /Configure/);
  }
  assert.throws(() => createResendAccountDelivery({ baseURL: "http://127.0.0.1:1234", apiKey, from }), /HTTPS/);
  assert.throws(() => createResendAccountDelivery({ baseURL, apiKey, from: "sender@example.test" }), /sender email/);
});

test("mail uses a fixed HTTPS destination, private bearer header and stable idempotency key", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const delivery = createResendAccountDelivery({ baseURL, apiKey, from, fetcher: (async (url, init) => {
    calls.push({ url: String(url), init: init! }); return new Response('{"id":"synthetic"}', { status: 200 });
  }) as typeof fetch });
  await delivery.send(message); await delivery.send(message);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
  assert.match(headers.get("idempotency-key")!, /^kairos-account-[a-f0-9]{64}$/);
  assert.equal(headers.get("idempotency-key"), new Headers(calls[1].init.headers).get("idempotency-key"));
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.to, [message.to]);
  assert.equal(body.from, `Kairos-Bridge <${from}>`);
  assert.match(body.subject, /Confirm/);
  assert.ok(body.text.includes(message.url));
  assert.ok(!body.text.includes(apiKey));
  assert.equal(body.html, undefined);
});

test("wrong-origin, query-token, wrong-purpose and invalid recipient messages never leave the service", async () => {
  let calls = 0;
  const delivery = createResendAccountDelivery({ baseURL, apiKey, from, fetcher: (async () => { calls++; return new Response(); }) as typeof fetch });
  for (const change of [{ url: message.url.replace(baseURL, "https://attacker.recovery-fixture.org") },
    { url: message.url.replace("#", "?") }, { url: message.url.replace("confirm-email", "reset-password") },
    { url: message.url + "&other=1" }, { to: "owner@example.test" }, { to: "bad\r\nBcc: bad@recovery-fixture.org" }]) {
    await assert.rejects(delivery.send({ ...message, ...change }));
  }
  assert.equal(calls, 0);
});

test("provider errors are sanitized and password-reset copy describes session behavior", async () => {
  for (const fetcher of [async () => new Response(apiKey + message.url, { status: 403 }), async () => { throw new Error(apiKey); }]) {
    const delivery = createResendAccountDelivery({ baseURL, apiKey, from, fetcher: fetcher as typeof fetch });
    await assert.rejects(delivery.send(message), error => error instanceof Error && error.message === "Account email delivery is temporarily unavailable");
  }
  let body = "";
  const delivery = createResendAccountDelivery({ baseURL, apiKey, from, fetcher: (async (_url, init) => {
    body = String(init!.body); return new Response(null, { status: 202 });
  }) as typeof fetch });
  await delivery.send({ ...message, kind: "password-reset", url: message.url.replace("confirm-email", "reset-password") });
  assert.match(JSON.parse(body).text, /signs out your Kairos app and browser sessions/);
  assert.match(JSON.parse(body).text, /approved AI connections stay/);
});
