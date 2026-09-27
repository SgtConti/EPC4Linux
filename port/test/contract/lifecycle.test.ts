// Contract tests of the PRODUCTION composition (compose.ts here → src/backend createDefaultBackend) in mock
// mode, on the golden session's hardware (EVNIA_MOCK_MONITOR=34M2C8600/no-ene), for what happens around the
// transcript: the monitor unplugged and plugged back (Device_DetectionUSB / Device_DetectionDisplay replies and
// notifications), Theme_ResetCurProfile and FactoryReset (VCP 0x04 = 1: the vendor behaviour, kept by the
// project's decision and documented for users in docs/port/impl-integration.md §5), and the backend lifecycle
// (a restart re-enumerates the displays for the latched Start; ThemeStore.start() runs once per load although
// both the lifecycle and every Start call it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mockViaDeviceSpec } from '../../src/backend/ddc/transports/mock.ts';
import { at } from './compare.ts';
import { USER_DISPLAY_KEY, storedDisplayContent, vcpWritesSince } from './compose.ts';
import { WINDOWS_FIXTURES } from './golden.ts';
import { Replayer, assertMatches, goldenStep, isAllowedNotification, replayStep, waitFor, withComposedBackend } from './replay.ts';

const HDR_LUMINANCE = 'ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance.Value';

/**
 * The monitor's DDC traffic of a reset: VCP 0x04 = 1, then the full re-read, whose only writes are the five
 * EQ band selects E2A001 = 0..4 of the audio EQ loop (impl-monitor §2.1-2.2; 20-theme §6).
 */
const RESET_WRITES = [{ code: 0x04, value: 1 }, ...[0, 1, 2, 3, 4].map((band) => ({ code: 0xe2a001, value: band }))];

test('monitor hotplug: unplugged, Device_DetectionUSB/Device_DetectionDisplay drop it; plugged back, it returns exactly as before', { timeout: 120_000 }, async (t) => {
  await withComposedBackend(t, {}, async (c) => {
    const { monitors, ambiglow } = c.backend.services;
    const replay = new Replayer(c.backend, c.notifications);
    await replayStep(replay, goldenStep('2')); // Start
    await replayStep(replay, goldenStep('12')); // Profile_GetDeviceData: waits for the full read
    const first = monitors.current();
    assert.ok(first);
    await waitFor(() => ambiglow.display === first, 5000, 'AmbiglowService.attach(<display>)');
    const hw = c.hardware();
    const status = join(hw.sysfsRoot, 'class/drm/card1-DP-1/status');

    await t.test('unplug: the device list becomes empty, no notification, the drivers answer "return null obj"', async () => {
      await writeFile(status, 'disconnected\n'); // the DRM connector (udev drm change → displayChange)
      hw.usb.detach(hw.via); // the monitor's USB hub with the VIA bridge (USBChange)
      c.backend.hotplug('usb'); // what the host sends after its debounce (01 §9)…
      c.backend.hotplug('display');
      const usb = await replay.rpc('unplug-usb', 'Device_DetectionUSB'); // …and what the renderer then calls
      assert.equal(usb.reply.err_code, 0, String(usb.reply.err_msg));
      const list = await replay.rpc('unplug-list', 'Device_GetConnectList');
      assert.deepEqual(usb.reply.Tag, list.reply.Tag, 'Device_DetectionUSB answers the device list (20-backend-host-tail §7.1)');
      const display = await replay.rpc('unplug-display', 'Device_DetectionDisplay'); // after the vendor's 5 s settle
      assert.deepEqual([display.reply.err_code, display.reply.err_msg, display.reply.Tag], [0, '', []]);
      for (const r of [usb, list, display]) assert.deepEqual(r.during, [], `${r.reply.FunctionName}: no notification for a vanished display`);
      assert.deepEqual(replay.drain(), [], 'nor in the background');
      assert.equal(monitors.current(), null);
      assert.equal(ambiglow.display, null, 'attach(null): no connected display left');
      assert.deepEqual((await replay.rpc('unplug-empty', 'Device_GetConnectList')).reply.Tag, []);
      const osd = await replay.rpc('unplug-osd', 'PHL_SetOSD', ['OP_10_Luminance', 1]);
      assert.equal(osd.reply.err_msg, 'functionName: PHL_SetOSD  return null obj', "the vendor's GetDeviceByType<IDisplay>()?.X()");
    });

    await t.test('replug: Device_DetectionUSB lists it again, then Profile_GetDeviceData, Device_DetectionDisplay and PHL_GetConstraints are the golden replies', async () => {
      await writeFile(status, 'connected\n');
      hw.usb.attach(mockViaDeviceSpec(hw.monitor, { deviceAddress: 21 }));
      c.backend.hotplug('usb');
      c.backend.hotplug('display');
      const step3 = goldenStep('3');
      const usb = await replay.rpc('replug-usb', 'Device_DetectionUSB');
      assertMatches(usb.text, { ...step3.reply, RequestId: 'contract-replug-usb', FunctionName: 'Device_DetectionUSB' }, step3.replyOrder, 'Device_DetectionUSB after the replug');
      for (const n of usb.during) assert.ok(isAllowedNotification(JSON.stringify(n), ['N0']), `unexpected notification ${JSON.stringify(n).slice(0, 200)}`);
      // The new driver loads in the background (N0 when the constraints leave the constructor state); the
      // Monitor shell's reload gets the golden Tag again: same monitor, same stored profile.
      await replayStep(replay, goldenStep('12'));
      await replayStep(replay, goldenStep('17')); // the renderer's displayChange: 5 s settle, then the scan
      await replayStep(replay, goldenStep('13')); // N1 before the reply
      for (const n of replay.drain()) assert.ok(isAllowedNotification(JSON.stringify(n), ['N0']));
      const again = monitors.current();
      assert.ok(again);
      assert.notEqual(again, first, 'a new driver for the replugged monitor');
      assert.equal(again.key, USER_DISPLAY_KEY);
      assert.deepEqual(again.discovered.transports.map((x) => x.kind), ['via-usb', 'i2c-dev'], 'USB-DDC first again (06 §5.1)');
      await waitFor(() => ambiglow.display === again, 5000, 'AmbiglowService.attach(<replugged display>)');
      assert.equal((await replay.rpc('replug-osd', 'PHL_SetOSD', ['OP_10_Luminance', 90])).reply.err_code, 0);
      assert.equal(hw.monitor.control(0x10)?.value, 90);
    });
  });
});

test('Theme_ResetCurProfile and FactoryReset reset the monitor with VCP 0x04 = 1 (vendor behaviour, kept by decision)', { timeout: 120_000 }, async (t) => {
  await withComposedBackend(t, {}, async (c) => {
    const replay = new Replayer(c.backend, c.notifications);
    await replayStep(replay, goldenStep('2'));
    await replayStep(replay, goldenStep('12'));
    const hw = c.hardware();
    const defaultProfile = join(c.serveDataDir, 'Theme', 'User', 'Default.pcenter');
    const noOtherNotifications = (during: Record<string, any>[]) => {
      for (const n of [...during, ...replay.drain()]) assert.ok(isAllowedNotification(JSON.stringify(n), ['N0']), `unexpected notification ${JSON.stringify(n).slice(0, 200)}`);
    };

    await t.test('Theme_ResetCurProfile: Tag null, VCP 0x04 = 1, the monitor re-read into the cleared profile (20-theme §6, B-3)', async () => {
      assert.equal((await replay.rpc('reset-lum', 'PHL_SetOSD', ['OP_10_Luminance', 55])).reply.err_code, 0);
      assert.equal(hw.monitor.control(0x10)?.value, 55);
      const mark = hw.monitor.frames.length;
      const r = await replay.rpc('reset-cur', 'Theme_ResetCurProfile');
      assert.deepEqual([r.reply.err_code, r.reply.err_msg, r.reply.Tag], [0, '', null]);
      assert.deepEqual(vcpWritesSince(hw, mark), RESET_WRITES, 'VCP 0x04 "restore factory defaults", then only the re-read');
      assert.equal(hw.monitor.control(0x10)?.value, 100, "the monitor restored its factory values (the simulator's seeds)");
      noOtherNotifications(r.during);
      const data = await replay.rpc('reset-data', 'Profile_GetDeviceData', [100000]);
      assert.equal(at(data.reply.Tag, HDR_LUMINANCE), 100, 'DeviceData is the fresh read');
      assert.equal(at(storedDisplayContent(defaultProfile), HDR_LUMINANCE), 100, 'the profile holds the post-reset state');
    });

    await t.test('FactoryReset: Tag true, VCP 0x04 = 1, EvniaServe re-initialised (20-theme §7), the monitor keeps working', async () => {
      assert.equal((await replay.rpc('fr-profile', 'Theme_AddProfile', ['User', 'Extra'])).reply.err_code, 0);
      assert.equal((await replay.rpc('fr-idle', 'Setting_TurnOffLightsWhenIdle', [true])).reply.err_code, 0);
      assert.equal((await replay.rpc('fr-lum', 'PHL_SetOSD', ['OP_10_Luminance', 42])).reply.err_code, 0);
      assert.equal(hw.monitor.control(0x10)?.value, 42);
      const mark = hw.monitor.frames.length;
      const r = await replay.rpc('factory-reset', 'FactoryReset');
      assert.deepEqual([r.reply.err_code, r.reply.err_msg, r.reply.Tag], [0, '', true]);
      assert.deepEqual(vcpWritesSince(hw, mark), RESET_WRITES);
      assert.equal(hw.monitor.control(0x10)?.value, 100);
      noOtherNotifications(r.during);
      // The first-run index is the user's DataTheme.cfg byte for byte (golden steps 5 and 8), the idle
      // settings are the SoftConfigInfo defaults (golden step 14), the extra profile is gone.
      await replayStep(replay, goldenStep('5'));
      await replayStep(replay, goldenStep('8'));
      await replayStep(replay, goldenStep('14'));
      assert.deepEqual(readdirSync(join(c.serveDataDir, 'Theme', 'User')), ['Default.pcenter']);
      assert.equal(
        readFileSync(join(c.serveDataDir, 'Theme', 'DataTheme.cfg'), 'utf8'),
        readFileSync(join(WINDOWS_FIXTURES, 'EvniaServe', 'Theme', 'DataTheme.cfg'), 'utf8'),
        'the fresh DataTheme.cfg',
      );
      assert.equal(at(storedDisplayContent(defaultProfile), HDR_LUMINANCE), 100, "the display's post-reset state in the new Default.pcenter");
      const data = await replay.rpc('fr-data', 'Profile_GetDeviceData', [100000]);
      assert.equal(data.reply.err_code, 0, String(data.reply.err_msg));
      assert.equal(at(data.reply.Tag, HDR_LUMINANCE), 100);
      assert.equal((await replay.rpc('fr-osd', 'PHL_SetOSD', ['OP_10_Luminance', 70])).reply.err_code, 0);
      assert.equal(hw.monitor.control(0x10)?.value, 70);
    });
  });
});

test('backend restart: stop() + start() re-enumerates the displays, so the latched Start and the device list still show the monitor', { timeout: 120_000 }, async (t) => {
  await withComposedBackend(t, {}, async (c) => {
    const { monitors, ambiglow } = c.backend.services;
    const replay = new Replayer(c.backend, c.notifications);
    await replayStep(replay, goldenStep('2'));
    await replayStep(replay, goldenStep('3'));
    await replayStep(replay, goldenStep('12'));

    await c.backend.stop();
    assert.deepEqual(monitors.displays(), [], 'MonitorManager.stop() disposed the displays');
    assert.equal(ambiglow.display, null);
    await c.backend.start(); // afterStart: the first run had scanned, so the displays are enumerated again
    assert.equal(monitors.displays().length, 1, 'enumerated before any request');
    assert.equal(monitors.current()?.key, USER_DISPLAY_KEY);

    // The renderer reconnects: Start replies at once (latched, vendor bool_0), and everything answers as in
    // the golden session. The simulated monitor is a fresh one after the restart (the mock environment is
    // rebuilt), the stored profile the one the first run saved.
    await replayStep(replay, goldenStep('2'));
    await replayStep(replay, goldenStep('3'));
    await replayStep(replay, goldenStep('11'));
    await replayStep(replay, goldenStep('12'));
    await replayStep(replay, goldenStep('13'));
    await waitFor(() => ambiglow.display === monitors.current(), 5000, 'AmbiglowService.attach(<display>) after the restart');
    for (const { json } of replay.between) assert.ok(isAllowedNotification(json, ['N0']), `unexpected notification ${json.slice(0, 200)}`);
  });
});

test('backend restart before the renderer ever called Start: nothing is scanned before Start (vendor order)', { timeout: 60_000 }, async (t) => {
  await withComposedBackend(t, {}, async (c) => {
    const { monitors } = c.backend.services;
    await c.backend.stop();
    await c.backend.start();
    assert.deepEqual(monitors.displays(), [], 'no scan without a Start (SystemOper.Start runs the first scan)');
    const replay = new Replayer(c.backend, c.notifications);
    await replayStep(replay, goldenStep('2'));
    await replayStep(replay, goldenStep('3'));
  });
});

test('ThemeStore.start() loads once: the lifecycle start and the Start request share the load (impl-api §2 contract)', { timeout: 60_000 }, async (t) => {
  await withComposedBackend(t, {}, async (c) => {
    // backend.start() has run ThemeStore.start() (InitEnviroment). Corrupt the index on disk: a second load
    // would set it aside as DataTheme.cfg.corrupt-<ms> and fall back to the default index.
    const index = join(c.serveDataDir, 'Theme', 'DataTheme.cfg');
    writeFileSync(index, 'not json');
    const replay = new Replayer(c.backend, c.notifications);
    await replayStep(replay, goldenStep('2')); // Start → themes.start() again, then the scan
    await replayStep(replay, goldenStep('5')); // Theme_GetThemeInfos: the index loaded at backend.start()
    await replayStep(replay, goldenStep('8'));
    assert.deepEqual(readdirSync(join(c.serveDataDir, 'Theme')).filter((f) => f.startsWith('DataTheme.cfg.corrupt')), [], 'not reloaded');
    // The next profile save rewrites the index from memory (ThemeSaveCurProfiles writes both files).
    await replayStep(replay, goldenStep('12'));
    assert.equal((await replay.rpc('idem-osd', 'PHL_SetOSD', ['OP_10_Luminance', 99])).reply.err_code, 0);
    await replay.rpc('idem-basic', 'Theme_GetDevicesBasicInfo', [-1]); // writes the pending save first
    await waitFor(() => existsSync(index) && readFileSync(index, 'utf8') === readFileSync(join(WINDOWS_FIXTURES, 'EvniaServe', 'Theme', 'DataTheme.cfg'), 'utf8'), 5000, 'DataTheme.cfg rewritten from memory');
  });
});
