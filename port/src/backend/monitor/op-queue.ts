// Per-display single-flight queue for multi-step PHL_* sequences (20-monitor-io-linux-consolidation §2.4,
// decision D2): one bridge operation (PHL_SetInputSource, PHL_SetSmartImage, the EQ loop of a load, a
// reset, an Effect_* sequence of the ambiglow service, …) runs at a time per monitor, on top of the DDC
// channel's per-transaction queue. The vendor does not serialize these (06 §5.6); the port does, so two
// sequences can never interleave their writes and sleeps.
//
// Re-entrant: a task that (directly or through a callee) enqueues another task on the same queue runs it
// inline instead of deadlocking, which lets service hooks (e.g. DisplayDevice.setEneModel called from an
// operation that is already queued) compose safely. Tracked with AsyncLocalStorage, so only calls made
// from inside a running task's async context count as nested.

import { AsyncLocalStorage } from 'node:async_hooks';

export class OpQueue {
  readonly #context = new AsyncLocalStorage<OpQueue>();
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  /** Run `fn` after every previously queued task; nested calls from inside a task run inline. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#context.getStore() === this) return fn();
    this.#pending++;
    const task = () => this.#context.run(this, fn);
    const next = this.#tail.then(task, task);
    this.#tail = next.then(
      () => this.#pending--,
      () => this.#pending--,
    );
    return next;
  }

  /** Whether a task is queued or running. */
  get busy(): boolean {
    return this.#pending > 0;
  }

  /** Whether the caller runs inside a task of this queue. */
  get inside(): boolean {
    return this.#context.getStore() === this;
  }

  /**
   * Run `fn` outside the task context, for work a task starts but does not await (a notification
   * hook): anything that callback enqueues waits for its turn instead of running inline.
   */
  outside<T>(fn: () => T): T {
    return this.#context.exit(fn);
  }
}
