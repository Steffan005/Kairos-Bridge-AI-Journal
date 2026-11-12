// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RecoveryGate } from "../src/recoveryGate.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("recovery drains admitted requests and nested background work before excluding writers", async () => {
  const gate = new RecoveryGate(), background = deferred(), nested = deferred(), copied = deferred();
  const release = gate.enter()!;
  gate.track(background.promise.then(() => { gate.track(nested.promise); }));
  let began = false;
  const snapshot = gate.exclusive(async () => { began = true; await copied.promise; return "captured"; });
  assert.equal(gate.enter(), undefined);
  await assert.rejects(gate.exclusive(async () => {}), /already running/);
  release(); await turn(); assert.equal(began, false);
  background.resolve(); await turn(); assert.equal(began, false);
  nested.resolve(); await turn(); assert.equal(began, true);
  assert.equal(gate.enter(), undefined);
  copied.resolve(); assert.equal(await snapshot, "captured");
  const next = gate.enter(); assert.ok(next); next();
});

test("a drain deadline abandons capture and resumes admission without cancelling active work", async () => {
  const gate = new RecoveryGate(), release = gate.enter()!;
  let copied = false;
  await assert.rejects(gate.exclusive(async () => { copied = true; }, 15), /drain active work/);
  assert.equal(copied, false);
  const next = gate.enter(); assert.ok(next); next();
  let closed = false;
  const close = gate.close(async () => { closed = true; });
  await turn(); assert.equal(closed, false);
  release(); await close; assert.equal(closed, true);
  assert.equal(gate.enter(), undefined);
});

test("shutdown serializes with capture and failed maintenance always releases admission", async () => {
  const gate = new RecoveryGate();
  await assert.rejects(gate.exclusive(async () => { throw new Error("synthetic failure"); }), /synthetic failure/);
  const release = gate.enter(); assert.ok(release); release();
  const copying = deferred();
  const snapshot = gate.exclusive(async () => { await copying.promise; });
  let closes = 0;
  const close = gate.close(async () => { closes++; });
  assert.equal(gate.close(async () => { closes++; }), close);
  assert.equal(gate.enter(), undefined);
  await assert.rejects(gate.exclusive(async () => {}), /closing/);
  await turn(); assert.equal(closes, 0);
  copying.resolve(); await snapshot; await close; assert.equal(closes, 1);
});
