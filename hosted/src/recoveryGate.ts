// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.

/** All service database activity must enter before its first asynchronous step. */
export class RecoveryGate {
  private active = 0;
  private paused = false;
  private closing = false;
  private tasks = new Set<Promise<unknown>>();
  private idleListeners = new Set<() => void>();
  private maintenance?: Promise<unknown>;
  private shutdown?: Promise<void>;

  enter(): (() => void) | undefined {
    if (this.paused || this.closing) return undefined;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true; this.active--; this.notifyIdle();
    };
  }

  /** Better Auth supplies already-started promises; track rather than defer them. */
  track = (task: Promise<unknown>): void => {
    this.tasks.add(task);
    const settled = () => { this.tasks.delete(task); this.notifyIdle(); };
    task.then(settled, settled);
  };

  private notifyIdle(): void {
    if (this.active || this.tasks.size) return;
    for (const listener of [...this.idleListeners]) listener();
  }

  private idle(timeoutMs?: number): Promise<void> {
    if (!this.active && !this.tasks.size) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => { if (timer) clearTimeout(timer); this.idleListeners.delete(done); resolve(); };
      this.idleListeners.add(done);
      if (timeoutMs !== undefined) timer = setTimeout(() => {
        this.idleListeners.delete(done);
        reject(new Error("Recovery could not drain active work before its deadline; no capture was started"));
      }, timeoutMs);
    });
  }

  exclusive<T>(operation: () => Promise<T>, drainTimeoutMs = 15_000): Promise<T> {
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1) return Promise.reject(new Error("Invalid recovery drain deadline"));
    if (this.closing) return Promise.reject(new Error("Service is closing"));
    if (this.maintenance) return Promise.reject(new Error("Recovery is already running"));
    this.paused = true;
    const task = (async () => {
      try { await this.idle(drainTimeoutMs); return await operation(); }
      finally { this.paused = false; this.maintenance = undefined; }
    })();
    this.maintenance = task;
    return task;
  }

  /** Shutdown waits for maintenance and admitted work; it never forces a request closed. */
  close(operation: () => Promise<void>): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = (async () => {
      await this.maintenance?.catch(() => {});
      await this.idle();
      await operation();
    })();
    return this.shutdown;
  }
}
