// Tiny typed event bus replacing Zeasn.Com.Lib.EventSystem for in-process events
// (hotplug, effect ticks, idle changes). Notifications to the renderer go through Notifier instead.

type Handler<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  #handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(name: K, handler: Handler<Events[K]>): () => void {
    let set = this.#handlers.get(name);
    if (!set) this.#handlers.set(name, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    for (const h of this.#handlers.get(name) ?? []) {
      try {
        (h as Handler<Events[K]>)(payload);
      } catch {
        // handlers must not break the emitter; they log their own errors
      }
    }
  }
}

/** Serialize async work (one DDC conversation at a time per monitor, 06 §5.6). */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
