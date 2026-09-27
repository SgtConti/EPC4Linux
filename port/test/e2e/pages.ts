// Per-page checks for the real vendor UI with the simulated 34M2C8600 (ARCHITECTURE "Build and test
// pipeline" 4: visit every monitor page, screenshot, no console errors). app.test.ts runs each entry
// when build/vendor-ui is present. The monitor driver and API layer (wave 2) add their pages here,
// e.g. { name: 'smart-image', run: async (w) => { await w.click('…'); await w.screenshot({ path: … }); } }.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { MOCK_SERIAL } from '../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { VendorRpc, vendorClient } from '../unit/hub/helpers.ts';
import { ARTIFACTS, type PageCheck, snapshot } from './harness.ts';

/** The simulated monitor of EVNIA_MOCK_MONITOR=34M2C8600 (EDID 0xFC name and 0xFF serial). */
const MOCK_NAME = 'PHL 34M2C8600';
/** The simulated monitor's serial (synthetic: the shipped mock carries no identifier of the user's unit). */
const MOCK_SN = MOCK_SERIAL;

interface EvniaWindow {
  ipc: { invoke(channel: string): Promise<unknown> };
  __EVNIA__: { hubToken: string };
}

/** A second client on the app's hub, with the port and token the preload gave the renderer. */
async function hubRpc(w: Page): Promise<VendorRpc> {
  const { port, token } = await w.evaluate(async () => {
    const win = window as unknown as EvniaWindow;
    return { port: (await win.ipc.invoke('startupBackendService')) as number, token: win.__EVNIA__.hubToken };
  });
  const hub = vendorClient(port, token);
  await hub.start();
  return new VendorRpc(hub);
}

export const MONITOR_PAGE_CHECKS: PageCheck[] = [
  {
    // The production composition behind startupBackendService (backend-host.ts): Start → Device_GetConnectList
    // lists the simulated monitor, so Home shows its card instead of "Connect Your Evnia Device".
    name: 'Home shows the simulated 34M2C8600 card with its bundled image',
    async run(w) {
      await w.getByText(MOCK_NAME, { exact: true }).first().waitFor({ state: 'visible', timeout: 45_000 });
      // DeviceImage: <model>_overview.png misses, the error handler switches to <model>.png
      await w.waitForFunction(
        () => [...document.images].some((i) => /\/vendor-ui\/monitor\/34M2C8600\.png$/.test(i.src) && i.complete && i.naturalWidth > 0),
        undefined,
        { timeout: 15_000 },
      );
      assert.equal(await w.getByText('Connect Your Evnia Device').count(), 0);
      await snapshot(w, join(ARTIFACTS, 'vendor', 'home-monitor-card.png'));
    },
  },
  {
    // HostServices.getDisplayMode in the running app (host-services.ts): the simulated monitor reports the
    // user's mode, which the driver copies into DispalyData (20-monitor-io §3.1/§3.5).
    name: 'the monitor data carries the display mode from main (MonitorResolution/Frequency/Orientation)',
    async run(w) {
      const rpc = await hubRpc(w);
      try {
        const list = (await rpc.invoke('Device_GetConnectList')) as { ExtDeviceInfo: { CurSN: string } }[];
        assert.equal(list[0]?.ExtDeviceInfo.CurSN, MOCK_SN);
        const data = (await rpc.invoke('Profile_GetDeviceData', 100000)) as { ModelName: string; DispalyData: Record<string, unknown> };
        assert.equal(data.ModelName, MOCK_NAME);
        assert.deepEqual(
          [data.DispalyData.MonitorResolution, data.DispalyData.MonitorFrequency, data.DispalyData.MonitorOrientation],
          ['3440x1440', '175Hz', '0°'],
        );
      } finally {
        await rpc.hub.stop();
      }
    },
  },
];
