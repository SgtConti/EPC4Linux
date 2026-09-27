// Shared plumbing of the monitor-facing API modules (api/phl.ts, api/device.ts, api/profile.ts,
// api/displayfw.ts).
//
// Vendor dispatch model (SystemOper.cs:987-1114, 2936-2992): every PHL_* / Profile_* call resolves the
// driver with `GetDeviceByType<IDisplay>(PHL_CDeviceDisplay)?.X(...)`. The driver is in the device table
// only while the display is connected (smethod_5 adds it after a successful ConnectionCkecked and removes
// it on failure), so with no connected display the `?.` yields null and Class0 replies
// "functionName: <fn>  return null obj" (two spaces; 20-backend-host-tail §1.3).

import type { ApiServices } from '../index.ts';
import type { MonitorManager } from '../services.ts';
import type { JsonResult, RpcArg, RpcCallContext, RpcHandler } from '../types.ts';
import { error } from '../core/envelope.ts';
import { DispatchErrors } from '../rpc/dispatcher.ts';
import { PhlDisplay } from './display.ts';
import { DISPLAY_SETTLE_MS, MonitorManagerImpl } from './manager.ts';
import { DEVICE_TYPE_DISPLAY } from './model/profile.ts';
import { sleep } from '../core/events.ts';

export { DEVICE_TYPE_DISPLAY };

/** "functionName: <fn>  return null obj" — the reply for a missing driver or a null JsonResult. */
export function nullObj(ctx: RpcCallContext): JsonResult {
  return error(DispatchErrors.nullResult(ctx.functionName));
}

/** The monitor manager slot, or null when the composition has none. */
export function monitorsOf(services: ApiServices): MonitorManager | null {
  const m = services.monitors as Partial<MonitorManager> | undefined;
  return m && typeof m.connectList === 'function' && typeof m.current === 'function' ? (m as MonitorManager) : null;
}

/** GetDeviceByType<IDisplay>(PHL_CDeviceDisplay): the current display while it is connected. */
export function connectedDisplay(services: ApiServices): PhlDisplay | null {
  const current = monitorsOf(services)?.current() ?? null;
  return current instanceof PhlDisplay && current.connected ? current : null;
}

/** The driver-dispatch wrapper: run `fn` on the connected display, else the vendor's null-object error. */
export function withDisplay(services: ApiServices, fn: (display: PhlDisplay, args: RpcArg[]) => Promise<JsonResult>): RpcHandler {
  return async (args, ctx) => {
    const display = connectedDisplay(services);
    return display ? fn(display, args) : nullObj(ctx);
  };
}

/** Device_DetectionDisplay's settle wait + display scan (manager clock when available). */
export async function detectDisplays(m: MonitorManager): Promise<void> {
  if (m instanceof MonitorManagerImpl) return m.detectDisplays();
  await sleep(DISPLAY_SETTLE_MS);
  await m.scan('display');
}

/** Device_Rescan: capability-cache reset (CacheVcpMgr.Reset) + full scan. */
export async function rescan(m: MonitorManager): Promise<void> {
  if (m instanceof MonitorManagerImpl) return m.rescan();
  await m.scan('all');
}
