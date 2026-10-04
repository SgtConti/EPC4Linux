// The LAN-COLOR-SYNC patch (scripts/ui-patches.mjs): the "Send colours to Hubitat (LAN)" row the port adds to the vendor's
// Ambiglow page after the FAST-LED-UPLOAD row. As in fast-led-upload.test.ts, the inserted render expression is evaluated
// with stand-ins for the page's Vue helpers and reactive state, so its logic is tested without the vendor archive: when it
// shows, what it binds, and that it only talks to the preload's narrow window.__EVNIA__.lanSync API.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPatchTable } from '../../../scripts/lib/import-pipeline.ts';
import type { PatchSpec } from '../../../scripts/lib/types.ts';

const ANCHOR_HEAD = 'experimental.get()):m("",!0),';
const ANCHOR_TAIL = ',Ye.startCount.support?';

async function patches(): Promise<{ fast: PatchSpec & { find: string }; lan: PatchSpec & { find: string }; ids: string[] }> {
  const table = await loadPatchTable();
  const fast = table.patches.find((x) => x.id === 'FAST-LED-UPLOAD') as PatchSpec & { find: string };
  const lan = table.patches.find((x) => x.id === 'LAN-COLOR-SYNC') as PatchSpec & { find: string };
  assert.ok(lan && typeof lan.find === 'string', 'the patch exists with a literal anchor');
  return { fast, lan, ids: table.patches.map((p) => p.id) };
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

interface Settings {
  enabled: boolean;
  host: string;
  port: number;
}

interface Scope {
  ene?: boolean;
  effect?: number;
  api?: { get(): Settings; set(change: { enabled?: boolean; address?: string }): Promise<Settings> } | null;
  warn?: (...data: unknown[]) => void;
}

async function render(scope: Scope): Promise<VNode | null> {
  const { lan } = await patches();
  assert.ok(lan.replace.startsWith(ANCHOR_HEAD) && lan.replace.endsWith(ANCHOR_TAIL), 'the patch keeps both blocks around it');
  const expr = lan.replace.slice(ANCHOR_HEAD.length, -ANCHOR_TAIL.length);
  const ref = <T>(value: T) => ({ value });
  const window = {
    ...(scope.api === null ? {} : { __EVNIA__: { lanSync: scope.api } }),
    __electronLog: { warn: scope.warn ?? (() => undefined) },
  };
  const console = { warn: () => undefined };
  const fn = new Function('c', 'n', 'u', 'r', 's', 'S', 'm', 'Z', 'Ae', 'window', 'console', `return ${expr};`);
  return fn(
    (x: { value: unknown }) => x.value,
    () => undefined,
    (tag: string, props: Record<string, unknown>, children: VNode[]): VNode => ({ tag, props, children }),
    (comp: string, props: Record<string, unknown>, _c: null, flag: number, dyn: string[]): VNode => ({ comp, props, flag, dyn }),
    (name: string) => `resolved:${name}`,
    (tag: string, props: Record<string, unknown>, text: string | null, flag: number, dyn?: string[]): VNode => ({ tag, props, text: text ?? undefined, flag, dyn }),
    () => null,
    ref(scope.ene ?? true),
    ref(scope.effect ?? 1),
    window,
    console,
  );
}

function api(state: Settings, calls: unknown[] = [], answer: (c: { enabled?: boolean; address?: string }) => Promise<Settings> = async () => state) {
  return {
    get: () => ({ ...state }),
    set: (c: { enabled?: boolean; address?: string }) => {
      calls.push(c);
      return answer(c);
    },
  };
}

test('LAN-COLOR-SYNC: anchored on FAST-LED-UPLOAD\'s output, after it in the table, and only there', async () => {
  const { fast, lan, ids } = await patches();
  assert.ok(ids.indexOf('LAN-COLOR-SYNC') === ids.indexOf('FAST-LED-UPLOAD') + 1);
  assert.equal(fast.replace.split(lan.find).length - 1, 1, 'FAST-LED-UPLOAD\'s replacement contains the anchor once');
  assert.equal(fast.find.includes(lan.find), false, 'the unpatched vendor text does not');
});

test('LAN-COLOR-SYNC: only with the ENE, the Follow Video effect and the preload API', async () => {
  const off = { enabled: false, host: '', port: 39501 };
  assert.notEqual(await render({ api: api(off) }), null);
  assert.equal(await render({ ene: false, api: api(off) }), null);
  for (const effect of [2, 3, 4, 5, 6, 7]) assert.equal(await render({ effect, api: api(off) }), null, `effect ${effect}`);
  assert.equal(await render({ api: null }), null);
});

test('LAN-COLOR-SYNC: a checkbox, an address field and a hint, bound to the stored setting', async () => {
  const row = (await render({ api: api({ enabled: true, host: '192.168.1.20', port: 39501 }) }))!;
  assert.equal(row.props!.key, 'evnia-lan-sync');
  assert.equal(row.props!.class, 'slider-item evnia-lan-sync');
  const [box, input, hint] = row.children!;
  assert.equal(box.comp, 'resolved:Checkbox');
  assert.deepEqual([box.props!.modelValue, box.props!.label, box.props!.i18n], [true, 'Send colours to Hubitat (LAN)', false]);
  assert.deepEqual([box.flag, box.dyn], [8, ['modelValue']]);
  assert.equal(input.tag, 'input');
  assert.deepEqual([input.props!.type, input.props!.value, input.flag, input.dyn], ['text', '192.168.1.20', 8, ['value']]);
  assert.equal(hint.props!.class, 'evnia-lan-sync-hint');
  assert.match(hint.text!, /Hubitat/);
  const port = (await render({ api: api({ enabled: false, host: '10.0.0.2', port: 8080 }) }))!.children![1];
  assert.equal(port.props!.value, '10.0.0.2:8080', 'a non-default port is shown');
});

test('LAN-COLOR-SYNC: the checkbox and the field call lanSync.set; a refused address marks the field and is logged', async () => {
  const calls: unknown[] = [];
  const warned: unknown[][] = [];
  const answer = async (c: { enabled?: boolean; address?: string }): Promise<Settings> => {
    if (c.address === 'bad') throw new Error("Error invoking remote method 'evnia:lan-sync-set': Error: Hubitat address not saved: nope");
    return { enabled: false, host: '192.168.1.30', port: 39501 };
  };
  const row = (await render({ api: api({ enabled: false, host: '', port: 39501 }, calls, answer), warn: (...d) => warned.push(d) }))!;
  const [box, input] = row.children!;
  box.props!.onChange(true);
  const el = { value: ' 192.168.1.30 ', style: { borderColor: '' }, title: '' };
  input.props!.onChange({ target: el });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [{ enabled: true }, { address: ' 192.168.1.30 ' }]);
  assert.deepEqual(el, { value: '192.168.1.30', style: { borderColor: '' }, title: '' }, 'shown normalized');
  el.value = 'bad';
  input.props!.onChange({ target: el });
  await new Promise((r) => setImmediate(r));
  assert.equal(el.style.borderColor, '#e5484d');
  assert.equal(el.title, 'Hubitat address not saved: nope', 'the reason without Electron\'s prefix');
  assert.deepEqual(warned, [['Hubitat address not saved: nope']]);
});

test('LAN-COLOR-SYNC: no URL, no network API, no window.ipc channel in the renderer', async () => {
  const { lan } = await patches();
  assert.doesNotMatch(lan.replace, /https?:|wss?:|window\.ipc|fetch\(|XMLHttpRequest|WebSocket/);
  assert.equal(lan.expectCount ?? 1, 1);
});
