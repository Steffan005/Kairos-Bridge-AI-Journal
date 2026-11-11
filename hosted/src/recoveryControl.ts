// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { BackupManifest } from "./recovery.js";

const MAX_REQUEST = 4096;
const MAX_RESPONSE = 4096;
const NONCE = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUEST_TIMEOUT_MS = 5000;
const ERRORS = ["INVALID_REQUEST", "REQUEST_TOO_LARGE", "REQUEST_TIMEOUT", "BUSY", "CLOSING", "CAPTURE_FAILED"] as const;
type ErrorCode = typeof ERRORS[number];
export type RecoveryReceipt = {
  version: 1; ok: true; nonce: string; operation: string; backup: string; witness: string;
  backup_id: string; captured_at: string; source_revision: string; witness_sha256: string;
  accounts: number; journals: number; files: number;
  drain_ms?: number; capture_ms?: number; paused_ms?: number;
};
export type RecoveryControlOptions = {
  socketPath: string; outputDirectory: string; sourceRevision: string;
  capture: (paths: { backup: string; witness: string; sourceRevision: string }) => Promise<{ manifest: BackupManifest; witnessSha256: string; drainMs?: number; captureMs?: number; pausedMs?: number }>;
};

function absolutePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Recovery requires a normalized absolute filesystem path");
}
function privateDirectory(path: string, create: boolean): string {
  absolutePath(path);
  if (typeof process.getuid !== "function") throw new Error("Recovery control requires Unix filesystem permissions");
  if (create) {
    let created = false;
    try { mkdirSync(path, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (created) {
      // Linux may inherit SGID from the parent despite mkdir's requested mode.
      // Normalize only a directory this invocation created. Never repair an
      // existing operator directory or follow a replacement symbolic link.
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error("New recovery directory owner changed");
        fchmodSync(fd, 0o700);
      } finally { closeSync(fd); }
    }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("Recovery directories must be ordinary directories owned by this Unix user with mode 0700");
  }
  return realpathSync(path);
}
function socketLocation(path: string, createParent: boolean): string {
  absolutePath(path);
  const socketPath = join(privateDirectory(dirname(path), createParent), basename(path));
  // macOS has a 104-byte sockaddr_un path; leave room for its terminator.
  if (Buffer.byteLength(socketPath) > 100) throw new Error("Recovery socket path exceeds 100 bytes");
  return socketPath;
}
function assertAbsent(path: string): void {
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("Recovery refuses to replace an existing socket or output");
}
function checkSocket(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600) {
    throw new Error("Recovery socket must belong to this Unix user with mode 0600");
  }
}

/** The Unix user and private filesystem permissions are the operator boundary.
 * This endpoint never listens on TCP and never accepts output paths from clients.
 * The nonce correlates one response; it is not a password or an authorization token.
 */
export async function createRecoveryControl(options: RecoveryControlOptions) {
  if (!SHA.test(options.sourceRevision)) throw new Error("Recovery requires the deployed 40-character source revision");
  const socketPath = socketLocation(options.socketPath, true);
  assertAbsent(socketPath); // Never unlink a possibly active or stale socket automatically.
  const outputDirectory = privateDirectory(options.outputDirectory, true);
  let closing = false;
  let active: Promise<void> | undefined;
  let activeSocket: net.Socket | undefined;
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let chunks: Buffer[] = [], bytes = 0, finished = false;
    const fail = (error: ErrorCode, nonce: string | null = null) => {
      if (finished) return;
      finished = true;
      socket.end(JSON.stringify({ version: 1, ok: false, nonce, error }) + "\n");
      // A malformed peer may keep its write side open indefinitely.
      socket.setTimeout(1000, () => socket.destroy());
    };
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => fail("REQUEST_TIMEOUT"));
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST) { chunks = []; fail("REQUEST_TOO_LARGE"); return; }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      if (finished) return;
      socket.setTimeout(0);
      let nonce: string;
      try {
        const raw = Buffer.concat(chunks).toString("utf8"); chunks = [];
        // Exactly one JSON line, followed by EOF. Waiting for EOF ensures that
        // appended commands cannot start a capture before they are rejected.
        if (!/^[^\r\n]+\n$/.test(raw)) throw new Error("Invalid frame");
        const request: unknown = JSON.parse(raw.slice(0, -1));
        if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid request");
        const r = request as Record<string, unknown>;
        if (Object.keys(r).sort().join(",") !== "command,nonce,version" || r.version !== 1 || r.command !== "capture" || typeof r.nonce !== "string" || !NONCE.test(r.nonce)) throw new Error("Invalid request");
        nonce = r.nonce;
      } catch { fail("INVALID_REQUEST"); return; }
      if (closing) { fail("CLOSING", nonce); return; }
      if (active) { fail("BUSY", nonce); return; }
      finished = true;
      activeSocket = socket;
      active = (async () => {
        let ownedOperation: { path: string; dev: number; ino: number } | undefined;
        try {
          // Recheck configuration after startup. Same-user/root processes are
          // trusted operators; no other Unix user can traverse these roots.
          if (privateDirectory(outputDirectory, false) !== outputDirectory) throw new Error("Output root changed");
          const operation = join(outputDirectory, randomUUID());
          mkdirSync(operation, { mode: 0o700 }); // Exclusive creation; no overwrite.
          const created = lstatSync(operation);
          ownedOperation = { path: operation, dev: created.dev, ino: created.ino };
          const backup = join(operation, "backup"), witness = join(operation, "witness.json");
          const result = await options.capture({ backup, witness, sourceRevision: options.sourceRevision });
          const m = result.manifest;
          if (!UUID.test(m.id) || !NONCE.test(result.witnessSha256) || !Number.isFinite(Date.parse(m.captured_at))) throw new Error("Invalid capture result");
          // Never serialize the full manifest: it contains account identifiers.
          const receipt: RecoveryReceipt = { version: 1, ok: true, nonce, operation, backup, witness,
            backup_id: m.id, captured_at: m.captured_at, source_revision: options.sourceRevision,
            witness_sha256: result.witnessSha256, accounts: m.users.length, journals: m.journals.length, files: m.files.length };
          for (const [from, to] of [["drainMs", "drain_ms"], ["captureMs", "capture_ms"], ["pausedMs", "paused_ms"]] as const) {
            const value = result[from];
            if (value !== undefined) {
              if (!Number.isFinite(value) || value < 0) throw new Error("Invalid capture timing");
              receipt[to] = value;
            }
          }
          const response = JSON.stringify(receipt) + "\n";
          if (Buffer.byteLength(response) > MAX_RESPONSE) throw new Error("Receipt too large");
          socket.end(response);
        } catch {
          // Awaiting capture above has settled: its copy/verification workers
          // can no longer write into this request's private operation directory.
          // Refuse cleanup if its path was replaced; never touch another capture.
          if (ownedOperation) {
            try {
              const current = lstatSync(ownedOperation.path);
              if (current.isDirectory() && !current.isSymbolicLink() && current.dev === ownedOperation.dev && current.ino === ownedOperation.ino) {
                rmSync(ownedOperation.path, { recursive: true });
              }
            } catch { /* A removed/replaced directory or filesystem failure needs operator inspection. */ }
          }
          // Callback errors can contain credentials, note text or database paths.
          socket.end(JSON.stringify({ version: 1, ok: false, nonce, error: "CAPTURE_FAILED" }) + "\n");
        }
      })().finally(() => { active = undefined; activeSocket = undefined; });
    });
  });
  try {
    await new Promise<void>((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolveReady(); });
    });
    chmodSync(socketPath, 0o600);
    checkSocket(socketPath);
  } catch (error) {
    if (server.listening) await new Promise<void>(r => server.close(() => r()));
    throw error;
  }
  let closed: Promise<void> | undefined;
  return {
    socketPath,
    close: () => closed ??= (async () => {
      closing = true;
      const stopped = new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
      for (const socket of sockets) if (socket !== activeSocket) socket.destroy();
      await active;
      await stopped;
    })(),
  };
}

/** Run on the host through an authenticated operator session, such as SSH. */
export async function requestRecoveryCapture(options: { socketPath: string; nonce?: string; timeoutMs?: number }): Promise<RecoveryReceipt> {
  const socketPath = socketLocation(options.socketPath, false);
  checkSocket(socketPath);
  const nonce = options.nonce ?? randomBytes(32).toString("hex");
  if (!NONCE.test(nonce)) throw new Error("Recovery nonce must be 64 lowercase hexadecimal characters");
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("Invalid recovery timeout");
  return new Promise<RecoveryReceipt>((resolveReceipt, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let chunks: Buffer[] = [], bytes = 0;
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new Error("Recovery request timed out; inspect the private output directory before retrying")), timeoutMs);
    socket.once("close", () => clearTimeout(timer));
    socket.once("error", () => fail(new Error("Could not connect to the private recovery socket")));
    socket.once("connect", () => socket.end(JSON.stringify({ version: 1, command: "capture", nonce }) + "\n"));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE) { fail(new Error("Recovery response exceeds its size limit")); return; }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8"); chunks = [];
        if (!/^[^\r\n]+\n$/.test(raw)) throw new Error("Invalid recovery response");
        const receipt = JSON.parse(raw.slice(0, -1)) as RecoveryReceipt & { error?: ErrorCode };
        if (receipt.version !== 1 || receipt.nonce !== nonce) throw new Error("Recovery response does not match this request");
        if (!receipt.ok) throw new Error(ERRORS.includes(receipt.error!) ? `Recovery request failed: ${receipt.error}` : "Invalid recovery response");
        if (!UUID.test(receipt.backup_id) || !SHA.test(receipt.source_revision) || !NONCE.test(receipt.witness_sha256)
          || !Number.isFinite(Date.parse(receipt.captured_at)) || ![receipt.accounts, receipt.journals, receipt.files].every(n => Number.isSafeInteger(n) && n >= 0)
          || ![receipt.drain_ms, receipt.capture_ms, receipt.paused_ms].every(n => n === undefined || (typeof n === "number" && Number.isFinite(n) && n >= 0))
          || ![receipt.operation, receipt.backup, receipt.witness].every(p => typeof p === "string" && isAbsolute(p))) throw new Error("Invalid recovery receipt");
        resolveReceipt(receipt);
      } catch (error) { fail(error instanceof Error ? error : new Error("Invalid recovery response")); }
    });
  });
}
