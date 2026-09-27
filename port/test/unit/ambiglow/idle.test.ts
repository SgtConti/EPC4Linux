// "Turn off lights when idle": GlobalOper.CheckIdle and EffectEnableTemp on both light paths (09 §11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdleMonitor, isIdle } from '../../../src/backend/ambiglow/idle.ts';
import { DDC_WAKE_RETRY_MS } from '../../../src/backend/ambiglow/service.ts';
import { createLogger } from '../../../src/backend/core/log.ts';
import { enumItem } from '../../../src/backend/monitor/model/enum-items.ts';
import { getFrame, setFrame, specWith } from '../monitor/helpers.ts';
import { ManualTimers, flush, rgbaFrame, rig, writesOnly, type Rig } from './helpers.ts';

test('CheckIdle: idle only when enabled and input idle ≥ duration minutes', () => {
  assert.equal(isIdle({ TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 1 }, 9999), false);
  assert.equal(isIdle({ TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 5 }, 299), false);
  assert.equal(isIdle({ TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 5 }, 300), true);
});

test('IdleMonitor polls every second and reports each change once, logging "Idle state:True/False"', () => {
  const lines: string[] = [];
  const log = createLogger('t', (_l, _s, args) => lines.push(args.map(String).join(' ')), 'debug');
  const timers = new ManualTimers();
  const soft = { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 1 };
  let seconds = 0;
  const changes: boolean[] = [];
  const m = new IdleMonitor({ log, softConfig: () => soft, idleSeconds: () => seconds, onChange: (i) => changes.push(i), timers });
  m.start();
  timers.advance(5000);
  seconds = 60;
  timers.advance(1000);
  timers.advance(3000);
  seconds = 0;
  timers.advance(1000);
  seconds = 120;
  timers.advance(1000);
  soft.TurnOffLightsWhenIdle = false; // disabling the setting wakes at once
  timers.advance(1000);
  assert.deepEqual(changes, [true, false, true, false]);
  assert.deepEqual(lines.filter((l) => l.startsWith('Idle state:')), ['Idle state:True', 'Idle state:False', 'Idle state:True', 'Idle state:False']);
  m.stop();
  assert.equal(timers.pending, 0);
  const noSource = new IdleMonitor({ log, softConfig: () => ({ TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 1 }), onChange: () => assert.fail(), timers });
  assert.equal(noSource.check(), false, 'no idle source → never idle');
});

const IDLE_ON = { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 1 } as const;

async function goIdle(r: Rig, idle: boolean): Promise<void> {
  r.idle.seconds = idle ? 60 : 0;
  r.timers.advance(1000);
  await r.service.settled();
  await flush();
}

test('ENE: idle switches the effect off (LEDOFF, 0x0023 ← 0) and pauses the uploads; activity restores the lights; the capture session is kept', async () => {
  const r = await rig({ soft: IDLE_ON });
  try {
    assert.equal(r.service.followVideo.state, 'running', 'stored effect is FollowVideo');
    assert.equal(r.mock!.state().hostControl, 4);
    const m = r.eneMark();
    await goIdle(r, true);
    assert.equal(r.service.idle, true);
    const off = writesOnly(r.eneSince(m));
    assert.equal(off[0], '40 80 0000 0023 0001 | 00', 'host control released first');
    assert.equal(off.length, 29, 'the full AllZone sequence with mode LEDOFF');
    assert.deepEqual(r.mock!.state().groups[1]?.mode, 0);
    // Deviation (impl-ambiglow §5): the vendor stops the capture thread (StopAllTimer); on Wayland a restart
    // would show the ScreenCast portal dialog on every return to the PC. Only the uploads pause.
    assert.equal(r.capture.videoStops, 0);
    assert.equal(r.service.followVideo.state, 'running');
    assert.equal(r.service.followVideo.paused, true);
    const uploads = r.service.followVideo.uploads;
    r.capture.frame(rgbaFrame(() => [7, 7, 7]));
    r.timers.advance(500);
    await flush();
    assert.equal(r.service.followVideo.uploads, uploads, 'no uploads while idle');
    assert.deepEqual(writesOnly(r.eneSince(m)).length, 29, 'nothing after the LEDOFF sequence');

    const m2 = r.eneMark();
    await goIdle(r, false);
    const on = writesOnly(r.eneSince(m2));
    assert.equal(on[0], '40 80 0000 0023 0001 | 04');
    assert.equal(r.mock!.state().groups[1]?.mode, 14, 'FollowVideo (UserDefine) again');
    assert.equal(r.service.followVideo.state, 'running');
    assert.equal(r.service.followVideo.paused, false);
    assert.deepEqual(r.capture.videoStarts, [300], 'idle → wake starts no second capture (no second portal dialog)');
    // The newest frame (captured while idle) goes out on the next tick.
    r.timers.advance(100);
    await flush();
    assert.equal(r.service.followVideo.uploads, uploads + 1);
    assert.deepEqual([...r.mock!.state().frame.subarray(0, 3)], [7, 7, 7]);
  } finally {
    await r.cleanup();
  }
});

test('ENE: an attach while idle (profile apply, reload, re-open) records the effect without lighting the LEDs; the wake shows it', async () => {
  const r = await rig({ soft: IDLE_ON });
  try {
    await goIdle(r, true);
    assert.equal(r.mock!.state().hostControl, 0);
    // A profile apply with another effect while the user is away: the display's post-apply hook re-attaches.
    const data = r.display.profile()!;
    data.EffectInfo!.CurrEffect = enumItem('Static', '恒亮模式', 7);
    let m = r.eneMark();
    await r.service.attach(r.display);
    await flush();
    assert.ok(!r.eneSince(m).includes('40 80 0000 0023 0001 | 04'), 'no 0x0023 ← 04 while idle (no flash)');
    assert.deepEqual(writesOnly(r.eneSince(m)), [], 'already dark: nothing written');
    assert.equal(r.service.ene?.suspended, true);

    // The ENE re-enumerates while idle (monitor standby): the fresh device runs the firmware's own effect,
    // so the LEDOFF variant goes out once — still without 0x0023 ← 04.
    const usb = r.t.bundle.usb;
    usb.detach(r.eneInfo!);
    const info = usb.attach(r.mock!.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 21 }));
    r.display.setEneDevice(info);
    m = r.eneMark();
    await r.service.attach(r.display);
    await flush();
    const writes = writesOnly(r.eneSince(m));
    assert.equal(writes[0], '40 80 0000 0023 0001 | 00');
    assert.ok(!writes.includes('40 80 0000 0023 0001 | 04'));
    assert.equal(r.mock!.state().groups[1]?.mode, 0);

    m = r.eneMark();
    await goIdle(r, false);
    assert.equal(writesOnly(r.eneSince(m))[0], '40 80 0000 0023 0001 | 04');
    assert.equal(r.mock!.state().groups[1]?.mode, 2, 'the Static (rainbow) effect applied while idle is shown on wake');
    assert.equal(r.service.followVideo.state, 'stopped', 'FollowVideo was left');
  } finally {
    await r.cleanup();
  }
});

test('ENE: the monitor goes to standby during idle (the ENE leaves on a USB change, no failed write): the capture session waits for it', async () => {
  const r = await rig({ soft: IDLE_ON });
  try {
    await goIdle(r, true);
    const usb = r.t.bundle.usb;
    usb.detach(r.eneInfo!);
    r.display.setEneDevice(undefined); // discovery after the USBChange no longer pairs an ENE
    await r.service.attach(r.display);
    await flush();
    assert.equal(r.display.eneModel, '', 'DDC fallback (method_15)');
    assert.equal(r.capture.videoStops, 0);
    assert.equal(r.service.followVideo.state, 'running');
    assert.equal(r.service.followVideo.paused, true);
    // The monitor wakes up with the user: the ENE re-enumerates, the next USB change pairs it again.
    const info = usb.attach(r.mock!.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 40 }));
    r.display.setEneDevice(info);
    const m = r.eneMark();
    await r.service.attach(r.display);
    await flush();
    assert.equal(r.display.eneModel, '34M2C8600');
    assert.ok(!writesOnly(r.eneSince(m)).includes('40 80 0000 0023 0001 | 04'), 'still idle: dark');
    await goIdle(r, false);
    assert.equal(r.mock!.state().groups[1]?.mode, 14);
    assert.equal(r.service.followVideo.paused, false);
    assert.deepEqual(r.capture.videoStarts, [300], 'no second portal dialog');
  } finally {
    await r.cleanup();
  }
});

test('ENE: a capture start that failed is tried once more on the next wake', async () => {
  const r = await rig({ soft: IDLE_ON, load: false });
  try {
    r.capture.videoResult = false;
    await r.display.connect();
    await r.display.ready();
    await r.service.settled();
    await flush();
    assert.equal(r.service.followVideo.state, 'failed');
    await goIdle(r, true);
    r.capture.videoResult = true;
    await goIdle(r, false);
    assert.deepEqual(r.capture.videoStarts, [300, 300]);
    assert.equal(r.service.followVideo.state, 'running');
  } finally {
    await r.cleanup();
  }
});

test('ENE: a disabled Ambiglow stays off across idle (no writes)', async () => {
  const r = await rig({ soft: { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 1 } });
  try {
    assert.equal((await r.call('Effect_Enable', [100000, false])).err_code, 0);
    const m = r.eneMark();
    r.idle.seconds = 600;
    r.service.checkIdle();
    await r.service.settled();
    r.idle.seconds = 0;
    r.service.checkIdle();
    await r.service.settled();
    assert.deepEqual(writesOnly(r.eneSince(m)), []);
  } finally {
    await r.cleanup();
  }
});

test('DDC: idle writes E2A019 = 0 and activity the stored mode back', async () => {
  // Ambiglow on in ColorShift (E2A019 = 3) over DDC, no ENE.
  const r = await rig({ ene: false, spec: specWith([[0xe2a019, 3, 7]]), soft: { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 1 } });
  try {
    const data = r.display.profile()!;
    assert.equal(data.ENEEffectEnable, false);
    assert.equal(data.ModuleAmbiglow.EffectEnable, true);
    const m = r.ddcMark();
    r.idle.seconds = 60;
    r.service.checkIdle();
    await r.service.settled();
    assert.deepEqual(r.ddcSince(m), [setFrame(0xe2a019, 0)]);
    assert.deepEqual(r.service.ddcSuspension, { key: 'AU00000000001', mode: 3, pending: false, retries: 0 });
    const m2 = r.ddcMark();
    r.idle.seconds = 0;
    r.service.checkIdle();
    await r.service.settled();
    assert.deepEqual(r.ddcSince(m2), [setFrame(0xe2a019, 3), getFrame(0xe2a019)], 'the stored mode, verified by a read-back');
    assert.equal(r.service.ddcSuspension, null);
    assert.ok(r.ddcSince(0).includes(getFrame(0xe2a019)), 'the load read E2A019');
  } finally {
    await r.cleanup();
  }
});

/** Make the monitor refuse the next `n` E2A019 writes (DDC NAK, e.g. still coming out of DPMS standby). */
function refuseModeWrites(r: Rig, n: number): { left(): number } {
  const ddc = r.display.ddc as unknown as { setExt(code: number, value: number): Promise<void> };
  const real = ddc.setExt.bind(ddc);
  let left = n;
  ddc.setExt = async (code, value) => {
    if (code === 0x19 && left > 0) {
      left--;
      throw new Error('DDC/CI NAK (simulated)');
    }
    return real(code, value);
  };
  return { left: () => left };
}

const DDC_ON = { ene: false, spec: specWith([[0xe2a019, 3, 7]]), soft: IDLE_ON } as const;

test('DDC: a wake write the monitor does not take is retried (2 s, 5 s, …) until the read-back confirms it', async () => {
  const r = await rig(DDC_ON);
  try {
    r.idle.seconds = 60;
    r.service.checkIdle();
    await r.service.settled();
    const refused = refuseModeWrites(r, 2);
    const m = r.ddcMark();
    r.idle.seconds = 0;
    r.service.checkIdle();
    await r.service.settled();
    assert.deepEqual(r.ddcSince(m), [], 'the write never reached the monitor');
    assert.deepEqual(r.service.ddcSuspension, { key: 'AU00000000001', mode: 3, pending: true, retries: 1 });
    r.timers.advance(DDC_WAKE_RETRY_MS[0]);
    await r.service.settled();
    await flush();
    assert.equal(refused.left(), 0);
    assert.equal(r.service.ddcSuspension?.pending, true);
    r.timers.advance(DDC_WAKE_RETRY_MS[1]);
    await r.service.settled();
    await flush();
    assert.deepEqual(r.ddcSince(m), [setFrame(0xe2a019, 3), getFrame(0xe2a019)]);
    assert.equal(r.service.ddcSuspension, null, 'confirmed: nothing outstanding');
    r.timers.advance(60_000);
    await r.service.settled();
    assert.deepEqual(r.ddcSince(m), [setFrame(0xe2a019, 3), getFrame(0xe2a019)], 'no further retries');
  } finally {
    await r.cleanup();
  }
});

test('DDC: an outstanding restore is dropped when the user switches the Ambiglow (Effect_Enable)', async () => {
  const r = await rig(DDC_ON);
  try {
    r.idle.seconds = 60;
    r.service.checkIdle();
    await r.service.settled();
    refuseModeWrites(r, 1);
    r.idle.seconds = 0;
    r.service.checkIdle();
    await r.service.settled();
    assert.equal(r.service.ddcSuspension?.pending, true);
    const off = await r.call('Effect_Enable', [100000, false]);
    assert.deepEqual([off.err_code, off.Tag], [0, false]);
    assert.equal(r.service.ddcSuspension, null);
    const m = r.ddcMark();
    r.timers.advance(30_000);
    await r.service.settled();
    assert.deepEqual(r.ddcSince(m), [], 'no retry switches the Ambiglow on behind the user\'s back');
  } finally {
    await r.cleanup();
  }
});

test('DDC: a reload during idle reads the idle Off back; the wake restores the Ambiglow in DeviceData and the profile', async () => {
  const r = await rig(DDC_ON);
  try {
    r.idle.seconds = 60;
    r.service.checkIdle();
    await r.service.settled();
    const reload = await r.display.reload();
    assert.equal(reload.IsSucc, true);
    await r.service.settled();
    await flush();
    const data = r.display.profile()!;
    assert.equal(data.ModuleAmbiglow.EffectEnable, false, 'the load logic reads E2A019 = 0 as "Ambiglow off" (PHL/…:379-390)');
    assert.equal(r.service.ddcSuspension?.mode, 3, 'the record survives the reload');
    const m = r.ddcMark();
    r.idle.seconds = 0;
    r.service.checkIdle();
    await r.service.settled();
    await flush();
    assert.deepEqual(r.ddcSince(m), [setFrame(0xe2a019, 3), getFrame(0xe2a019)]);
    const after = r.display.profile()!;
    assert.equal(after.ModuleAmbiglow.EffectEnable, true);
    assert.equal(after.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value, 3);
    const stored = JSON.parse(r.themes.contents.get('100000|PHL 34M2C8600')!) as { ModuleAmbiglow: { EffectEnable: boolean } };
    assert.equal(stored.ModuleAmbiglow.EffectEnable, true, 'saved: the profile does not keep Ambiglow disabled');
  } finally {
    await r.cleanup();
  }
});

/** The display's current ProfileContent with the DDC Ambiglow switched as given (a profile to apply). */
function ambiglowProfile(r: Rig, enable: boolean, mode: number): string {
  const content = JSON.parse(r.display.purify()) as { ModuleAmbiglow: { EffectEnable: boolean; EXT_OP_E2A0_19_AmbiglowLightMode: { Value: number } } };
  content.ModuleAmbiglow.EffectEnable = enable;
  content.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value = mode;
  return JSON.stringify(content);
}

test('DDC: a profile switch during idle decides what the wake restores (ThemeStore.onSwitched)', async () => {
  const r = await rig(DDC_ON);
  try {
    r.idle.seconds = 60;
    r.service.checkIdle();
    await r.service.settled();
    // A profile with the Ambiglow on in another mode: the apply writes it (method_12), the attach that follows
    // switches it off again, and the wake restores the new mode.
    let m = r.ddcMark();
    await r.display.applyProfileContent(ambiglowProfile(r, true, 5));
    await r.service.settled();
    await flush();
    r.themes.emitSwitched('switch');
    assert.deepEqual(r.ddcSince(m).filter((f) => f === setFrame(0xe2a019, 5) || f === setFrame(0xe2a019, 0)), [setFrame(0xe2a019, 5), setFrame(0xe2a019, 0)]);
    assert.equal(r.service.ddcSuspension?.mode, 5);
    // A profile with the Ambiglow off: nothing to restore.
    await r.display.applyProfileContent(ambiglowProfile(r, false, 5));
    await r.service.settled();
    await flush();
    r.themes.emitSwitched('switch');
    assert.equal(r.service.ddcSuspension, null);
    m = r.ddcMark();
    r.idle.seconds = 0;
    r.service.checkIdle();
    await r.service.settled();
    assert.deepEqual(r.ddcSince(m), [], 'the wake leaves the Ambiglow off, as the profile says');
  } finally {
    await r.cleanup();
  }
});

test('DDC: stop() during idle switches the monitor\'s Ambiglow on again (verified)', async () => {
  const r = await rig(DDC_ON);
  try {
    r.idle.seconds = 60;
    r.service.checkIdle();
    await r.service.settled();
    const m = r.ddcMark();
    await r.service.stop();
    assert.deepEqual(r.ddcSince(m), [setFrame(0xe2a019, 3), getFrame(0xe2a019)]);
    assert.equal(r.service.ddcSuspension, null);
    assert.equal(r.service.idle, false, 'forgotten: a later start() reports the idle user again');
  } finally {
    await r.cleanup();
  }
});

test('DDC: a disabled Ambiglow is not switched on by the wake (vendor bug fixed)', async () => {
  const r = await rig({ ene: false, soft: { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 1 } });
  try {
    const data = r.display.profile()!;
    assert.equal(data.ModuleAmbiglow.EffectEnable, false, 'the user\'s monitor: E2A019 read 0 → Off');
    assert.equal(data.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value, 7, 'shown as StaticMode');
    const m = r.ddcMark();
    r.idle.seconds = 60;
    r.service.checkIdle();
    await r.service.settled();
    r.idle.seconds = 0;
    r.service.checkIdle();
    await r.service.settled();
    assert.deepEqual(r.ddcSince(m), [], 'the vendor wrote 0 and then 7 (Static on) here');
  } finally {
    await r.cleanup();
  }
});
