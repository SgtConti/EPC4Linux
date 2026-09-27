// Timer seam for the effect engines (the vendor's EffectTimerMgr threads, 09 §1, and GlobalOper.CheckIdle's
// 1 s loop, 09 §11). Production uses unref'd Node timers, so an idle poll or a frame uploader never keeps a
// CLI process alive; tests inject a manual clock and step it.

export interface EffectTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

type NodeTimer = ReturnType<typeof setTimeout>;

export const realTimers: EffectTimers = {
  setInterval(callback, ms) {
    const h = setInterval(callback, ms);
    h.unref?.();
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as NodeTimer);
  },
  setTimeout(callback, ms) {
    const h = setTimeout(callback, ms);
    h.unref?.();
    return h;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeTimer);
  },
};
