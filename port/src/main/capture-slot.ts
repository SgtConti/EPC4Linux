// Start/stop sequencing for one capture kind (CaptureHost, src/backend/types.ts; 09 §7).
//
// Every start and every stop gets a new session number. A start may only deliver frames to its
// callback, and may only resolve true, while its session is still the current one. A stop, or a newer
// start, issued while an earlier start is still awaiting (window creation, desktopCapturer, the portal
// dialog, getUserMedia) therefore cancels it instead of being overwritten by it. Pure module.

export class CaptureSlot<T> {
  #seq = 0;
  #current: { session: number; sink: T } | null = null;

  /** A new start: supersedes any start in flight and any running capture. */
  begin(sink: T): number {
    const session = ++this.#seq;
    this.#current = { session, sink };
    return session;
  }

  /** Invalidates the start in flight and the running capture. */
  stop(): void {
    this.#seq++;
    this.#current = null;
  }

  isCurrent(session: number): boolean {
    return this.#current?.session === session;
  }

  /** The callback of `session` while it is current, else null (stale frames are dropped). */
  sink(session: number): T | null {
    return this.#current !== null && this.#current.session === session ? this.#current.sink : null;
  }

  /** `session` failed to start or its stream ended: forget it unless something newer happened. */
  release(session: number): void {
    if (this.isCurrent(session)) this.#current = null;
  }

  /** A start is in flight or a capture is running. */
  get busy(): boolean {
    return this.#current !== null;
  }
}

/** `promise`, or the value of `onTimeout()` when `promise` has not settled after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
