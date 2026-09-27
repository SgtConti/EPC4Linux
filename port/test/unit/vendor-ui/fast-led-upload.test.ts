// The FAST-LED-UPLOAD patch (scripts/ui-patches.mjs): the "Fast LED upload (experimental)" checkbox that the port adds to
// the vendor's Ambiglow page after the Speed slider. The inserted render expression is evaluated here with stand-ins
// for the page's Vue helpers and reactive state (the names of Ambiglow-Dvqon39u.js's render scope), so its logic is
// tested without the vendor archive: when it shows, what it binds, and that it only talks to the preload's narrow
// window.__EVNIA__.experimental API. The real-archive suite (import-vendor-ui.test.ts) checks the patched chunk itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPatchTable } from '../../../scripts/lib/import-pipeline.ts';
import type { PatchSpec } from '../../../scripts/lib/types.ts';

const HINT = 'Sends each frame in one USB transfer. Turn off if the lights flicker or freeze.';

async function patch(): Promise<PatchSpec & { find: string }> {
  const p = (await loadPatchTable()).patches.find((x) => x.id === 'FAST-LED-UPLOAD');
  assert.ok(p && typeof p.find === 'string', 'the patch exists with a literal anchor');
  return p as PatchSpec & { find: string };
}

interface VNode {
  tag?: string;
  comp?: string;
  props?: Record<string, any>;
  children?: VNode[];
  text?: string;
  flag?: number;
  dyn?: string[];
}

interface Scope {
  ene?: boolean;
  effect?: number;
  enabled?: boolean;
  api?: { get(): { eneFrameBurst: boolean; forcedByEnv: boolean }; setEneFrameBurst(on: boolean): Promise<void> } | null;
  /** window.__electronLog.warn of the page (the preload's bridge into main's log); absent when not given. */
  electronLogWarn?: (...data: unknown[]) => void;
  /** The page's console.warn (default: a no-op, so the tests stay quiet). */
  consoleWarn?: (...data: unknown[]) => void;
}

/** Evaluate the inserted expression in a stand-in of the page's render scope. */
async function render(scope: Scope): Promise<VNode | null> {
  const p = await patch();
  const prefix = p.find.slice(0, p.find.indexOf('Ye.startCount.support?'));
  assert.ok(p.replace.startsWith(prefix) && p.replace.endsWith(',Ye.startCount.support?'), 'the patch keeps both vendor blocks around it');
  const expr = p.replace.slice(prefix.length, -',Ye.startCount.support?'.length);
  const ref = <T>(value: T) => ({ value });
  const helpers = {
    c: (x: { value: unknown }) => x.value, // unref
    n: () => undefined, // openBlock
    u: (tag: string, props: Record<string, unknown>, children: VNode[]): VNode => ({ tag, props, children }), // createElementBlock
    r: (comp: string, props: Record<string, unknown>, _children: null, flag: number, dyn: string[]): VNode => ({ comp, props, flag, dyn }), // createVNode
    s: (name: string) => `resolved:${name}`, // resolveComponent
    S: (tag: string, props: Record<string, unknown>, text: string, flag: number): VNode => ({ tag, props, text, flag }), // createElementVNode
    m: () => null, // createCommentVNode
  };
  const window = {
    ...(scope.api === null ? {} : { __EVNIA__: { experimental: scope.api } }),
    ...(scope.electronLogWarn ? { __electronLog: { warn: scope.electronLogWarn } } : {}),
  };
  const console = { warn: scope.consoleWarn ?? (() => undefined) };
  const fn = new Function('c', 'n', 'u', 'r', 's', 'S', 'm', 'Z', 'Ae', 'Ce', 'window', 'console', `return ${expr};`);
  return fn(helpers.c, helpers.n, helpers.u, helpers.r, helpers.s, helpers.S, helpers.m, ref(scope.ene ?? true), ref(scope.effect ?? 1), ref(scope.enabled ?? true), window, console);
}

function api(state: { eneFrameBurst: boolean; forcedByEnv: boolean }, calls: boolean[] = [], fail = false) {
  return {
    get: () => ({ ...state }),
    setEneFrameBurst: (on: boolean) => {
      calls.push(on);
      return fail ? Promise.reject(new Error('refused')) : Promise.resolve();
    },
  };
}

test('FAST-LED-UPLOAD: only with the ENE, the Follow Video effect (EffectType 1) and the preload API', async () => {
  const off = { eneFrameBurst: false, forcedByEnv: false };
  assert.notEqual(await render({ api: api(off) }), null, 'ENE + Follow Video');
  assert.equal(await render({ ene: false, api: api(off) }), null, 'the DDC page (no ENE)');
  for (const effect of [2, 3, 4, 5, 6, 7]) assert.equal(await render({ effect, api: api(off) }), null, `effect ${effect}`);
  assert.equal(await render({ api: null }), null, 'no window.__EVNIA__.experimental (another preload): nothing');
});

test('FAST-LED-UPLOAD: the vendor Checkbox in a "slider-item" row with a hint line; bound to the stored state, disabled like the sliders', async () => {
  const row = (await render({ api: api({ eneFrameBurst: false, forcedByEnv: false }) }))!;
  assert.equal(row.tag, 'div');
  assert.equal(row.props!.key, 4, 'a key of its own next to the position (0), brightness (1), speed (2) and star count (3) blocks');
  assert.equal(row.props!.class, 'slider-item evnia-fast-led-upload');
  assert.equal(row.props!.title, HINT);
  const [box, hint] = row.children!;
  assert.equal(box.comp, 'resolved:Checkbox', "the vendor's global Checkbox component");
  assert.deepEqual(
    { modelValue: box.props!.modelValue, label: box.props!.label, i18n: box.props!.i18n, disabled: box.props!.disabled },
    { modelValue: false, label: 'Fast LED upload (experimental)', i18n: false, disabled: false },
  );
  assert.deepEqual([box.flag, box.dyn], [8, ['modelValue', 'disabled']], 'the dynamic props are declared for the patch flag');
  assert.equal(hint.text, HINT);
  assert.equal(hint.props!.class, 'evnia-fast-led-upload-hint');

  const stored = (await render({ api: api({ eneFrameBurst: true, forcedByEnv: false }) }))!.children![0];
  assert.deepEqual([stored.props!.modelValue, stored.props!.disabled], [true, false], 'ticked: the stored setting');
  const effectOff = (await render({ enabled: false, api: api({ eneFrameBurst: true, forcedByEnv: false }) }))!.children![0];
  assert.equal(effectOff.props!.disabled, true, 'disabled while the effect is off');
  const forced = (await render({ api: api({ eneFrameBurst: false, forcedByEnv: true }) }))!;
  assert.deepEqual([forced.children![0].props!.modelValue, forced.children![0].props!.disabled], [true, true], 'EVNIA_ENE_FRAME_BURST=1: ticked and disabled');
  assert.match(forced.children![1].text!, /EVNIA_ENE_FRAME_BURST=1 is set; unset it to turn this off/);
});

test('FAST-LED-UPLOAD: a click calls window.__EVNIA__.experimental.setEneFrameBurst with the new value; a refusal is logged (console and main log), not thrown', async () => {
  const calls: boolean[] = [];
  const quiet: unknown[][] = [];
  const box = (await render({ api: api({ eneFrameBurst: false, forcedByEnv: false }, calls), consoleWarn: (...d) => quiet.push(d), electronLogWarn: (...d) => quiet.push(d) }))!.children![0];
  box.props!.onChange(true);
  box.props!.onChange(false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [true, false]);
  assert.deepEqual(quiet, [], 'an accepted change logs nothing');

  const consoleLines: unknown[][] = [];
  const mainLog: unknown[][] = [];
  const failing = (await render({
    api: api({ eneFrameBurst: false, forcedByEnv: false }, calls, true),
    consoleWarn: (...d) => consoleLines.push(d),
    electronLogWarn: (...d) => mainLog.push(d),
  }))!.children![0];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(failing.props!.onChange(true), undefined);
    await new Promise((r) => setImmediate(r));
    // Without the electron-log bridge (another preload): the console line only, still no rejection.
    const bare = (await render({ api: api({ eneFrameBurst: false, forcedByEnv: false }, calls, true), consoleWarn: (...d) => consoleLines.push(d) }))!.children![0];
    bare.props!.onChange(false);
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], 'no unhandled rejection in the page');
  const expected = /^Fast LED upload not changed; the checkbox shows the wrong state until the row is shown again \(another effect and back, or the page reopened\): refused$/;
  assert.equal(mainLog.length, 1, 'one line into the main log (window.__electronLog, src/main/renderer-log.ts)');
  assert.equal(mainLog[0].length, 1);
  assert.match(String(mainLog[0][0]), expected);
  assert.equal(consoleLines.length, 2, 'and one console line per refusal');
  for (const line of consoleLines) assert.match(String(line[0]), expected);
});

test('FAST-LED-UPLOAD: no URL, no window.ipc channel, no vendor identifier the audit would have to review', async () => {
  const p = await patch();
  assert.doesNotMatch(p.replace, /https?:|wss?:|window\.ipc|fetch\(|XMLHttpRequest|WebSocket/);
  assert.equal(p.expectCount ?? 1, 1);
  assert.ok(p.rationale.length > 0 && p.spec.includes('impl-vendor-ui'));
});
