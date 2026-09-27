// Shutdown sequence of exitApp (01 §3.5 exitApp; 01 port plan 2 "kill the backend in exitApp").
//
// Each step runs on its own: a step that throws or rejects is logged and the next one still runs, so a
// failure early on (e.g. the tray or a window) can never skip stopping the backend, which releases the
// Ambiglow controller and drains the DDC queue. The order is the vendor's (save bounds, hide, delete the
// debug flag, destroy the tray) followed by the port's own resources, backend last.

import type { Logger } from '../backend/types.ts';

export interface ExitStep {
  name: string;
  run(): unknown;
}

export async function runExitSteps(steps: readonly ExitStep[], log: Logger): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (e) {
      log.error(`App exit: "${step.name}" failed`, e);
    }
  }
}

/** What exitApp shuts down, in the shapes the steps need. */
export interface ExitParts {
  /** Save mainWindowBounds and hide the window (no-op before the window exists). */
  saveAndHideWindow(): void;
  clearDebugFlag(): void;
  tray: { destroy(): void };
  deviceEvents: ReadonlyArray<{ dispose(): void }>;
  foreground: { dispose(): void };
  capture: { dispose(): void };
  notice: { destroy(): void } | null;
  stopUsbWatch: (() => void) | null;
  backend: { stop(): Promise<void> };
}

export function appExitSteps(p: ExitParts): ExitStep[] {
  return [
    { name: 'save window bounds', run: () => p.saveAndHideWindow() },
    { name: 'debug flag', run: () => p.clearDebugFlag() },
    { name: 'tray', run: () => p.tray.destroy() },
    ...p.deviceEvents.map((d, i) => ({ name: `device events ${i}`, run: () => d.dispose() })),
    { name: 'foreground tracker', run: () => p.foreground.dispose() },
    { name: 'capture', run: () => p.capture.dispose() },
    { name: 'notice window', run: () => p.notice?.destroy() },
    { name: 'USB hotplug', run: () => p.stopUsbWatch?.() },
    { name: 'backend', run: () => p.backend.stop() },
  ];
}
