// HostServices.getDisplayMode (20-monitor-io-linux-consolidation §3.5): the pure string rules, the Mutter
// (GetCurrentState) and XRandR (--current --verbose) readers, output matching by EDID / Mutter spec /
// connector, and the provider's source order, fallbacks and refresh behaviour. The monitor is the captured
// 34M2C8600 with its logged EDID (the RAW DUMP of EvniaServe-2026-09-25.txt, serials anonymized).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, silentSink, type LogLevel } from '../../../src/backend/core/log.ts';
import { parseEdid } from '../../../src/backend/ddc/edid.ts';
import { USER_EDID_HEX } from '../../fixtures/user-monitor.ts';
import type { DiscoveredMonitor } from '../../../src/backend/types.ts';
import type { CommandResult, CommandRunner } from '../../../src/main/child-process.ts';
import {
  type DisplayLike,
  edidMatches,
  edidPreferredMode,
  exactRefreshHz,
  formatElectronDisplay,
  formatFrequency,
  formatMode,
  identityMatches,
  matchSnapshot,
  MOCK_DISPLAY_MODE,
  type ModeSnapshot,
  pickDisplayForMonitor,
  rotationSteps,
} from '../../../src/main/display-mode.ts';
import { cliSourcesFor, DisplayModeProvider, parseMutterState, parseXrandrVerbose } from '../../../src/main/display-sources.ts';
import { parseGVariant } from '../../../src/main/gvariant.ts';

const USER_EDID = Uint8Array.from(Buffer.from(USER_EDID_HEX, 'hex'));
const philips: DiscoveredMonitor = { key: 'AU00000000001', edid: parseEdid(USER_EDID), connector: 'card1-DP-2', transports: [] };

/** The same monitor model with another serial (a second 34M2C8600): the 0xFF descriptor and the 32-bit serial. */
function otherUnit(serial: string): Uint8Array {
  const e = Buffer.from(USER_EDID);
  const at = e.indexOf('AU00000000001');
  assert.ok(at > 0);
  e.write(serial.padEnd(13, ' ').slice(0, 13), at, 'latin1');
  e[12] ^= 0x5a;
  return Uint8Array.from(e);
}

const WAYLAND_GNOME = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' };
const X11_GNOME = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' };
const X11_XFCE = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'XFCE' };
const WAYLAND_KDE = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' };

// ───────────────────────────── §3.5 string rules ─────────────────────────────

test('§3.5 steps 2-3: exact rate from the timing, floor(exact + 0.005) + "Hz" (the spec table of this monitor)', () => {
  // 20-monitor-io §3.5 table, computed from the user's EDID dump
  const rows: [number, number, number, number, string][] = [
    [319_750, 3600, 1481, 59.9726, '59Hz'], // DTD1 of block 0
    [536_400, 3600, 1490, 100.0, '100Hz'], // CTA DTD @0xBD
    [402_750, 3600, 1492, 74.9832, '74Hz'], // CTA DTD @0xCF: hz < 75, MBR disabled
    [159_870, 3600, 1481, 29.9854, '29Hz'], // CTA DTD @0xE1
  ];
  for (const [clockKHz, htotal, vtotal, exact, text] of rows) {
    const hz = exactRefreshHz({ clockKHz, htotal, vtotal });
    assert.ok(Math.abs(hz - exact) < 0.0001, `${clockKHz}: ${hz}`);
    assert.equal(formatFrequency(hz), text);
  }
  // Windows-style truncation, with 0.005 Hz of slack for quantisation and float noise
  assert.equal(formatFrequency(59.94), '59Hz');
  assert.equal(formatFrequency(143.98), '143Hz');
  assert.equal(formatFrequency(59.99999), '60Hz');
  assert.equal(formatFrequency(174.996), '175Hz');
  assert.equal(formatFrequency(174.994), '174Hz');
  assert.equal(formatFrequency(0), '', 'an unknown rate stays empty (hz = 0, MBR disabled)');
  assert.equal(formatFrequency(Number.NaN), '');
  // drm_mode_vrefresh factors
  assert.equal(exactRefreshHz({ clockKHz: 74_250, htotal: 2200, vtotal: 1125, interlace: true }), 60);
  assert.equal(exactRefreshHz({ clockKHz: 74_250, htotal: 2200, vtotal: 1125, doubleScan: true }), 15);
  assert.equal(exactRefreshHz({ clockKHz: 74_250, htotal: 2200, vtotal: 1125, vscan: 2 }), 15);
  assert.equal(exactRefreshHz({ clockKHz: 74_250, htotal: 2200, vtotal: 1125, vscan: 1 }), 30);
  assert.equal(exactRefreshHz({ clockKHz: 0, htotal: 2200, vtotal: 1125 }), 0);
});

test('§3.5 steps 4-5: mode pixels, swapped for 90°/270°; orientation in counter-clockwise steps, flips ignored', () => {
  const m = { width: 3440, height: 1440, exactHz: 175.047 };
  assert.deepEqual(formatMode(m, 0), { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' });
  assert.deepEqual(formatMode(m, 1), { resolution: '1440x3440', frequency: '175Hz', orientation: '90°' });
  assert.deepEqual(formatMode(m, 2), { resolution: '3440x1440', frequency: '175Hz', orientation: '180°' });
  assert.deepEqual(formatMode(m, 3), { resolution: '1440x3440', frequency: '175Hz', orientation: '270°' });
  assert.equal(rotationSteps(5), 1, 'META_MONITOR_TRANSFORM_FLIPPED_90 → 90°');
  assert.equal(rotationSteps(4), 0);
  assert.equal(rotationSteps(-1), 0);
  assert.deepEqual(MOCK_DISPLAY_MODE, { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' }, 'the user\'s mode (PROF), as backend/serve.ts --mock reports it');
});

// ───────────────────────────── GVariant text ─────────────────────────────

test('GVariant text parser: gdbus call output', () => {
  assert.deepEqual(parseGVariant('(uint64 123456,)'), [123456]);
  assert.deepEqual(parseGVariant('()'), []);
  assert.deepEqual(parseGVariant("(true, false, 'a\\'b', \"c'd\", -3, 1.5e3, 0x1f, byte 0x10, objectpath '/x', @as [], [1, 2])"), [
    true, false, "a'b", "c'd", -3, 1500, 31, 16, '/x', [], [1, 2],
  ]);
  const dict = parseGVariant("{'is-current': <true>, 'n': <uint32 5>, 'e': <@a{sv} {}>, 'u': <'\\u00e9\\t'>}");
  assert.ok(dict instanceof Map);
  assert.equal(dict.get('is-current'), true);
  assert.equal(dict.get('n'), 5);
  assert.ok(dict.get('e') instanceof Map);
  assert.equal(dict.get('u'), 'é\t');
  assert.deepEqual(parseGVariant("{'k', 1}"), ['k', 1], 'a lone dict entry');
  assert.deepEqual(parseGVariant("[just 3, nothing, @ms nothing]"), [3, null, null]);
  assert.deepEqual(parseGVariant("(inf, -inf, b'ab\\001')"), [Infinity, -Infinity, 'ab\x01']);
  for (const bad of ['(1,', "'open", '(1 2)', '<1', 'what', '(1) x']) assert.throws(() => parseGVariant(bad), /GVariant text/, bad);
});

// ───────────────────────────── a. Mutter ─────────────────────────────

const PHILIPS_SPEC = "('DP-2', 'PHL', 'PHL 34M2C8600', 'AU00000000001')";
const LAPTOP_SPEC = "('eDP-1', 'BOE', '0x0a1c', '0x00000000')";
/** GetCurrentState as gdbus prints it (GNOME 46 shape): Philips at 175 Hz, a laptop panel rotated 90°, an unused TV. */
const MUTTER_STATE =
  `(uint32 7, [(${PHILIPS_SPEC}, [('3440x1440@175.002', 3440, 1440, 175.00199890136719, 1.0, [1.0, 2.0], {'is-current': <true>, 'is-preferred': <true>}), ` +
  "('3440x1440@59.973', 3440, 1440, 59.972599029541016, 1.0, [1.0, 2.0], @a{sv} {}), ('3440x1440@99.982', 3440, 1440, 99.982, 1.0, [1.0], {'refresh-rate-mode': <'variable'>})], " +
  "{'is-builtin': <false>, 'display-name': <'Philips Consumer Electronics Company 34\"'>, 'min-refresh-rate': <48>}), " +
  `(${LAPTOP_SPEC}, [('1920x1200@60.000', 1920, 1200, 60.0, 1.25, [1.0, 1.25, 1.5], {'is-current': <true>, 'is-preferred': <true>})], {'is-builtin': <true>, 'display-name': <'Built-in display'>}), ` +
  "(('HDMI-1', 'GSM', 'LG TV', '0x01010101'), [('3840x2160@60.000', 3840, 2160, 60.0, 2.0, [1.0, 2.0], {'is-preferred': <true>})], {'display-name': <'LG Electronics 55\"'>})], " +
  `[(0, 0, 1.0, uint32 0, true, [${PHILIPS_SPEC}], @a{sv} {}), (3440, 0, 1.25, uint32 1, false, [${LAPTOP_SPEC}], @a{sv} {})], ` +
  "{'layout-mode': <uint32 1>, 'supports-changing-layout-mode': <true>, 'global-scale-required': <false>, 'legacy-ui-scaling-factor': <1>})\n";

test('Mutter GetCurrentState: the is-current mode and the logical monitor\'s transform; unused monitors have no mode', () => {
  const snaps = parseMutterState(MUTTER_STATE);
  assert.deepEqual(
    snaps.map((s) => [s.connector, s.identity?.product, s.mode, s.rotation]),
    [
      ['DP-2', 'PHL 34M2C8600', { width: 3440, height: 1440, exactHz: 175.00199890136719 }, 0],
      ['eDP-1', '0x0a1c', { width: 1920, height: 1200, exactHz: 60 }, 1],
      ['HDMI-1', 'LG TV', null, 0],
    ],
  );
  const hit = matchSnapshot(snaps, philips);
  assert.equal(hit?.connector, 'DP-2');
  assert.deepEqual(formatMode(hit!.mode!, hit!.rotation), { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' });
  const laptop = snaps[1];
  assert.deepEqual(formatMode(laptop.mode!, laptop.rotation), { resolution: '1200x1920', frequency: '60Hz', orientation: '90°' });
  assert.throws(() => parseMutterState('(uint32 1,)'), /unexpected/);
});

test('Mutter spec matching: EDID PnP id, 0xFC name and 0xFF serial (or Mutter\'s hex fallbacks)', () => {
  const edid = philips.edid!;
  assert.equal(identityMatches({ vendor: 'PHL', product: 'PHL 34M2C8600', serial: 'AU00000000001' }, edid), true);
  assert.equal(identityMatches({ vendor: 'phl', product: 'phl 34m2c8600 ', serial: 'au00000000001' }, edid), true);
  assert.equal(identityMatches({ vendor: 'PHL', product: '0xc29f', serial: `0x${(edid.serialNumber >>> 0).toString(16).padStart(8, '0')}` }, edid), true);
  assert.equal(identityMatches({ vendor: 'PHL', product: 'PHL 34M2C8600', serial: 'AU00000009999' }, edid), false, 'another unit');
  assert.equal(identityMatches({ vendor: 'AOC', product: 'PHL 34M2C8600', serial: 'AU00000000001' }, edid), false);
  assert.equal(identityMatches({ vendor: 'PHL', product: 'PHL 34M2C8600', serial: 'AU00000000001' }, null), false);
  // two identical units on DP-1 and DP-2: the connector breaks the tie
  const twin = (connector: string): ModeSnapshot => ({ source: 'mutter', connector, identity: { vendor: 'PHL', product: 'PHL 34M2C8600', serial: 'AU00000000001' }, mode: null, rotation: 0 });
  assert.equal(matchSnapshot([twin('DP-1'), twin('DP-2')], philips)?.connector, 'DP-2');
  assert.equal(matchSnapshot([twin('DP-1'), twin('DP-3')], philips)?.connector, 'DP-1', 'no name match: the first');
  assert.equal(matchSnapshot([{ ...twin('DP-2'), identity: { vendor: 'X', product: 'Y', serial: 'Z' } }], philips)?.connector, 'DP-2', 'the name when nothing matches by identity');
  assert.equal(matchSnapshot([{ ...twin('DP-9'), identity: { vendor: 'X', product: 'Y', serial: 'Z' } }], philips), undefined);
});

// ───────────────────────────── b. XRandR ─────────────────────────────

const edidLines = (bytes: Uint8Array) =>
  Buffer.from(bytes)
    .toString('hex')
    .match(/.{1,32}/g)!
    .map((l) => `\t\t${l}`)
    .join('\n');

/** `xrandr --current --verbose` of the amdgpu DDX (outputs named DisplayPort-N / HDMI-A-N). */
function xrandrVerbose(philipsEdid: Uint8Array = USER_EDID): string {
  return [
    'Screen 0: minimum 320 x 200, current 4520 x 1920, maximum 16384 x 16384',
    'DisplayPort-0 disconnected (normal left inverted right x axis y axis)',
    '\tIdentifier: 0x52',
    '\tTimestamp:  25839',
    '\tSubpixel:   unknown',
    '\tClones:    ',
    '\tCRTCs:      0 1 2 3',
    'DisplayPort-1 connected primary 3440x1440+0+0 (0x55) normal (normal left inverted right x axis y axis) 800mm x 335mm',
    '\tIdentifier: 0x53',
    '\tTimestamp:  25839',
    '\tSubpixel:   unknown',
    '\tGamma:      1.0:1.0:1.0',
    '\tBrightness: 1.0',
    '\tClones:    ',
    '\tCRTC:       0',
    '\tCRTCs:      0 1 2 3',
    '\tTransform:  1.000000 0.000000 0.000000',
    '\t            0.000000 1.000000 0.000000',
    '\t            0.000000 0.000000 1.000000',
    '\t           filter: ',
    '\tEDID: ',
    edidLines(philipsEdid),
    '\tGAMMA_LUT_SIZE: 4096 ',
    '\t\trange: (0, -1)',
    '\tHDR_OUTPUT_METADATA: ',
    '\t\t0000000000000000',
    '\tvrr_capable: 1 ',
    '\t\trange: (0, 1)',
    '\tunderscan: off ',
    '\t\tsupported: off, on, auto',
    '  3440x1440 (0x55) 853.250MHz +HSync -VSync *current +preferred',
    '        h: width  3440 start 3488 end 3520 total 3600 skew    0 clock 237.01KHz',
    '        v: height 1440 start 1443 end 1453 total 1354           clock 175.05Hz',
    '  3440x1440 (0x56) 319.750MHz +HSync -VSync',
    '        h: width  3440 start 3488 end 3520 total 3600 skew    0 clock  88.82KHz',
    '        v: height 1440 start 1443 end 1453 total 1481           clock  59.97Hz',
    'HDMI-A-0 connected 1080x1920+3440+0 (0x60) left (normal left inverted right x axis y axis) 530mm x 300mm',
    '\tIdentifier: 0x54',
    '\tEDID: ',
    edidLines(otherUnit('XX00000000001')),
    '  1920x1080i (0x60)  74.250MHz +HSync +VSync Interlace *current',
    '        h: width  1920 start 2008 end 2052 total 2200 skew    0 clock  33.75KHz',
    '        v: height 1080 start 1084 end 1094 total 1125           clock  60.00Hz',
    'DisplayPort-2 connected (normal left inverted right x axis y axis)',
    '\tIdentifier: 0x55',
    '  1920x1080 (0x61) 148.500MHz +HSync +VSync',
    '        h: width  1920 start 2008 end 2052 total 2200 skew    0 clock  67.50KHz',
    '        v: height 1080 start 1084 end 1089 total 1125           clock  60.00Hz',
    '',
  ].join('\n');
}

test('XRandR --verbose: current mode, rotation and EDID of every connected output', () => {
  const snaps = parseXrandrVerbose(xrandrVerbose());
  assert.deepEqual(
    snaps.map((s) => [s.connector, s.mode && { ...s.mode, exactHz: Number(s.mode.exactHz.toFixed(4)) }, s.rotation, s.edid?.length]),
    [
      ['DisplayPort-1', { width: 3440, height: 1440, exactHz: 175.0472 }, 0, USER_EDID.length],
      ['HDMI-A-0', { width: 1920, height: 1080, exactHz: 60 }, 1, USER_EDID.length],
      ['DisplayPort-2', null, 0, undefined],
    ],
  );
  assert.ok(edidMatches(snaps[0].edid, USER_EDID), 'the EDID property is read exactly (no other blob property)');
  // matched by EDID, not by name: the amdgpu DDX calls the kernel's DP-2 "DisplayPort-1"
  const hit = matchSnapshot(snaps, philips);
  assert.equal(hit?.connector, 'DisplayPort-1');
  assert.deepEqual(formatMode(hit!.mode!, hit!.rotation), { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' });
  const tv = snaps[1];
  assert.deepEqual(formatMode(tv.mode!, tv.rotation), { resolution: '1080x1920', frequency: '60Hz', orientation: '90°' }, 'interlaced field rate, rotated left');
  // modesetting DDX names match the kernel connector; a monitor without EDID in xrandr falls back to it
  const renamed = xrandrVerbose().replaceAll('DisplayPort-1', 'DP-2').replace(/\tEDID: \n(\t\t[0-9a-f]+\n)+/, '');
  assert.equal(matchSnapshot(parseXrandrVerbose(renamed), philips)?.connector, 'DP-2');
  assert.equal(matchSnapshot(parseXrandrVerbose(xrandrVerbose(otherUnit('AU00009999999'))), philips), undefined, 'another unit on DisplayPort-1 is not this monitor');
  assert.deepEqual(parseXrandrVerbose(''), []);
});

// ───────────────────────────── Electron fallback ─────────────────────────────

test('Electron screen fallback: rotated DIP x scale, clockwise rotation, only unambiguous displays', () => {
  const evnia: DisplayLike = { id: 1, label: 'PHL 34M2C8600', size: { width: 3440, height: 1440 }, scaleFactor: 1, rotation: 0, displayFrequency: 174.996 };
  const laptop: DisplayLike = { id: 2, label: 'eDP-1', size: { width: 800, height: 1280 }, scaleFactor: 1.5, rotation: 90, displayFrequency: 60 };
  assert.deepEqual(formatElectronDisplay(evnia), { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' });
  assert.deepEqual(formatElectronDisplay(laptop), { resolution: '1200x1920', frequency: '60Hz', orientation: '270°' }, 'clockwise 90 is counter-clockwise 270');
  assert.deepEqual(formatElectronDisplay({ ...evnia, displayFrequency: 0 }).frequency, '', 'Xvfb reports no rate');
  assert.deepEqual(edidPreferredMode(USER_EDID), { width: 3440, height: 1440 });
  assert.equal(pickDisplayForMonitor([laptop, evnia], philips)?.id, 1, 'by EDID name in the label');
  assert.equal(pickDisplayForMonitor([laptop, { ...evnia, label: 'DP-2' }], { ...philips, edid: null })?.id, 1, 'by connector label');
  assert.equal(pickDisplayForMonitor([laptop, { ...evnia, label: '' }], philips)?.id, 1, 'by the EDID preferred mode');
  assert.equal(pickDisplayForMonitor([{ ...laptop, label: '' }], philips)?.id, 2, 'the only display');
  assert.equal(pickDisplayForMonitor([{ ...laptop, label: '' }, { ...laptop, id: 3, label: '' }], philips), null, 'ambiguous: no primary-display guess');
  assert.equal(pickDisplayForMonitor([], philips), null);
});

// ───────────────────────────── provider ─────────────────────────────

function fakeRunner(answers: Record<string, CommandResult | (() => CommandResult)>): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (command: string, args: readonly string[]) => {
    calls.push([command, ...args].join(' '));
    const a = answers[command];
    return (typeof a === 'function' ? a() : a) ?? { ok: false, stdout: '', error: 'ENOENT' };
  }) as CommandRunner & { calls: string[] };
  run.calls = calls;
  return run;
}

function recordingLog(): { log: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const log = createLogger('test', (level: LogLevel, _scope, args) => lines.push(`${level} ${args.map(String).join(' ')}`), 'debug');
  return { log, lines };
}

const noElectron = () => [];

test('session source order (§3.5 step 1): Wayland → Mutter, X11 → XRandR then Mutter on GNOME, else libdrm', () => {
  assert.deepEqual(cliSourcesFor(WAYLAND_GNOME), ['mutter']);
  assert.deepEqual(cliSourcesFor(X11_GNOME), ['xrandr', 'mutter']);
  assert.deepEqual(cliSourcesFor(X11_XFCE), ['xrandr']);
  assert.deepEqual(cliSourcesFor(WAYLAND_KDE), []);
  assert.deepEqual(cliSourcesFor({}), []);
});

test('provider on GNOME Wayland: Mutter answers; disabled or unknown monitors give null, never another display', async () => {
  const run = fakeRunner({ gdbus: { ok: true, stdout: MUTTER_STATE } });
  const { log, lines } = recordingLog();
  let drmCalls = 0;
  const p = new DisplayModeProvider({ log, run, env: WAYLAND_GNOME, drm: async () => (drmCalls++, []), electronDisplays: () => [{ id: 1, label: '', size: { width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0, displayFrequency: 60 }] });
  await p.refreshNow();
  assert.deepEqual(run.calls, ['gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig --method org.gnome.Mutter.DisplayConfig.GetCurrentState']);
  assert.equal(drmCalls, 0, 'libdrm only when no CLI source answers');
  assert.deepEqual(p.get(philips), { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' });
  const tv: DiscoveredMonitor = { key: 'TV', edid: null, connector: 'card1-HDMI-A-1', transports: [] };
  assert.equal(p.get({ ...tv, connector: 'card0-HDMI-1' }), null, 'listed without a current mode');
  assert.equal(p.get(tv), null, 'not listed');
  assert.equal(p.get(tv), null);
  const warnings = lines.filter((l) => l.startsWith('warn'));
  assert.equal(warnings.length, 2, `one warning per monitor and reason: ${warnings.join(' | ')}`);
  assert.match(warnings[0], /HDMI-1 without a current mode/);
  p.dispose();
});

test('provider on X11 (amdgpu DDX names): XRandR by EDID; Mutter is only asked on GNOME', async () => {
  const run = fakeRunner({ xrandr: { ok: true, stdout: xrandrVerbose() }, gdbus: { ok: true, stdout: MUTTER_STATE } });
  const p = new DisplayModeProvider({ log: createLogger('t', silentSink), run, env: X11_GNOME, drm: null, electronDisplays: noElectron });
  await p.refreshNow();
  assert.deepEqual(run.calls.map((c) => c.split(' ')[0]).sort(), ['gdbus', 'xrandr']);
  assert.deepEqual(run.calls.find((c) => c.startsWith('xrandr')), 'xrandr --current --verbose', 'no re-probe of the outputs');
  assert.deepEqual(p.get(philips), { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' });
  // xrandr does not list it (another unit there): Mutter, the second source, does
  const other = fakeRunner({ xrandr: { ok: true, stdout: xrandrVerbose(otherUnit('AU00009999999')).replaceAll('DisplayPort-1', 'DisplayPort-7') }, gdbus: { ok: true, stdout: MUTTER_STATE } });
  const q = new DisplayModeProvider({ log: createLogger('t', silentSink), run: other, env: X11_GNOME, drm: null, electronDisplays: noElectron });
  await q.refreshNow();
  assert.equal(q.get(philips)?.frequency, '175Hz');
  const xfce = fakeRunner({ xrandr: { ok: true, stdout: xrandrVerbose() } });
  const r = new DisplayModeProvider({ log: createLogger('t', silentSink), run: xfce, env: X11_XFCE, drm: null, electronDisplays: noElectron });
  await r.refreshNow();
  assert.deepEqual(xfce.calls, ['xrandr --current --verbose']);
  assert.equal(r.get(philips)?.resolution, '3440x1440');
  for (const x of [p, q, r]) x.dispose();
});

test('provider fallbacks: libdrm when no CLI source answers, Electron only when nothing is available', async () => {
  const { log, lines } = recordingLog();
  const drmSnap: ModeSnapshot = { source: 'drm', connector: 'card1-DP-2', mode: { width: 3440, height: 1440, exactHz: 59.9726 }, rotation: 0 };
  const run = fakeRunner({ xrandr: { ok: false, stdout: '', error: 'ENOENT' } });
  const p = new DisplayModeProvider({ log, run, env: X11_XFCE, drm: async () => [drmSnap], electronDisplays: noElectron });
  await p.refreshNow();
  assert.deepEqual(p.get(philips), { resolution: '3440x1440', frequency: '59Hz', orientation: '0°' }, 'libdrm: matched by the full connector name, orientation unknown');
  assert.equal(p.get({ ...philips, connector: 'card0-DP-2' }), null, 'another card');
  assert.ok(lines.some((l) => /source xrandr unavailable \(xrandr: ENOENT\)/.test(l)));
  // nothing available: the Electron display, when unambiguous
  const evnia: DisplayLike = { id: 1, label: '', size: { width: 3440, height: 1440 }, scaleFactor: 1, rotation: 0, displayFrequency: 174.996 };
  const e = new DisplayModeProvider({ log, run: fakeRunner({}), env: WAYLAND_GNOME, drm: async () => null, electronDisplays: () => [evnia] });
  assert.deepEqual(e.get(philips), { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' }, 'before the first snapshot too');
  await e.refreshNow();
  assert.deepEqual(e.get(philips), { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' });
  const two = new DisplayModeProvider({ log, run: fakeRunner({}), env: WAYLAND_GNOME, drm: null, electronDisplays: () => [evnia, { ...evnia, id: 2 }] });
  await two.refreshNow();
  assert.equal(two.get(philips), null, 'two 3440x1440 displays: ambiguous');
  // a failing gdbus reply is a failed source too
  const garbled = new DisplayModeProvider({ log, run: fakeRunner({ gdbus: { ok: true, stdout: '(uint32' } }), env: WAYLAND_GNOME, drm: async () => [drmSnap], electronDisplays: noElectron });
  await garbled.refreshNow();
  assert.equal(garbled.get(philips)?.frequency, '59Hz');
  assert.ok(lines.some((l) => /unreadable gdbus output/.test(l)));
  for (const x of [p, e, two, garbled]) x.dispose();
});

test('provider refreshes: joined while running, again after the settle time, and when a lookup finds old data', async () => {
  let now = 1000;
  let state = MUTTER_STATE;
  const run = fakeRunner({ gdbus: () => ({ ok: true, stdout: state }) });
  const p = new DisplayModeProvider({ log: createLogger('t', silentSink), run, env: WAYLAND_GNOME, drm: null, electronDisplays: noElectron, now: () => now, settleMs: 20, maxAgeMs: 10_000 });
  await Promise.all([p.refreshNow(), p.refreshNow(), p.refreshNow()]);
  assert.equal(run.calls.length, 2, 'the first run plus one more for the joined requests');
  state = MUTTER_STATE.replace("uint32 0, true, [('DP-2'", "uint32 3, true, [('DP-2'");
  p.refresh();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(run.calls.length, 4, 'now and after the settle time');
  assert.equal(p.get(philips)?.orientation, '270°');
  now += 10_001;
  state = MUTTER_STATE;
  assert.equal(p.get(philips)?.orientation, '270°', 'answered from the snapshot at once');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(run.calls.length, 5, 'and refreshed in the background');
  assert.equal(p.get(philips)?.orientation, '0°');
  p.dispose();
  p.refresh();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(run.calls.length, 5, 'nothing after dispose');
});
