// Concurrency of the theme store (store.ts header "Concurrency"): no deadlock with a participant that
// runs on the display's single-flight OpQueue, bounded participant calls, lock-free reads, listeners
// outside the operation lock, debounced saves written into the profile being left, renames and the
// FactoryReset failure path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProfileParticipant } from '../../../src/backend/services.ts';
import { OpQueue } from '../../../src/backend/monitor/op-queue.ts';
import { DISPLAY_DESC, FIXTURE_DEFAULT_PCENTER, FakeParticipant, USER_DATA_THEME, gate, harness, readConfig, until, within } from './helpers.ts';

const USER_THEME = { Name: 'User', IsDefault: true, SelProfileName: 'Default', ProfileNames: ['Default'], CycleProfileNames: ['Default'], BindAppInfos: [] };
const SYNC = { EffectDetailInfo: null, SyncDevices: [{ ModelName: 'PHL 34M2C8600', DeviceType: 100000, SyncStatus: true }] };

/**
 * A display-like participant: apply and reset run on its single-flight OpQueue, like
 * monitor/display.ts (#op), where ambiglow's Effect_* sequences also run (DisplayDevice.exclusive).
 */
class QueuedParticipant implements ProfileParticipant {
  readonly desc = DISPLAY_DESC;
  readonly queue = new OpQueue();
  content = '{"Live":0}';
  applyCalls = 0;
  resetCalls = 0;
  readonly log: string[] = [];

  purify(): string {
    return this.content;
  }

  applyProfileContent(content: string | null): Promise<void> {
    const n = ++this.applyCalls;
    return this.queue.run(async () => {
      this.log.push(`apply-start#${n}`);
      await new Promise((r) => setTimeout(r, 5));
      this.content = content ?? '{"Fresh":1}';
      this.log.push(`apply-end#${n}`);
    });
  }

  resetToFactory(): Promise<void> {
    this.resetCalls++;
    return this.queue.run(async () => {
      this.content = '{"Reset":1}';
    });
  }
}

test('a display-queue task that awaits store mutators while Theme_Switch waits for that queue does not deadlock', async (t) => {
  const h = await harness(t, { seed: true, store: { saveDebounceMs: 20 } });
  const p = new QueuedParticipant();
  h.store.registerParticipant(p);
  assert.equal((await h.call('Theme_AddProfile', 'User', 'P2')).err_code, 0);

  // An Effect_* sequence holds the display queue…
  const g = gate();
  const steps: string[] = [];
  const task = p.queue.run(async () => {
    await g.promise;
    await h.store.setSyncProfile(SYNC);
    steps.push('setSyncProfile');
    await h.store.saveParticipant(p);
    steps.push('saveParticipant');
    await h.store.setSoftConfig({ TurnOffLightsWhenIdle: true });
    steps.push('setSoftConfig');
    await h.store.flush();
    steps.push('flush');
  });
  // …while Theme_Switch holds the store's operation lock and waits for that queue in applyProfileContent.
  const sw = h.call('Theme_Switch', 'User', 'P2');
  await until(() => p.applyCalls === 1, 2000, 'the switch to reach applyProfileContent');
  g.open();
  await within(task, 3000, 'the queue task');
  const r = await within(sw, 3000, 'Theme_Switch');
  assert.equal(r.err_code, 0);
  assert.deepEqual(steps, ['setSyncProfile', 'saveParticipant', 'setSoftConfig', 'flush']);
  // The Sync_Profile change went into the profile current at that moment (P2) and was saved with it.
  assert.deepEqual(h.store.getSyncProfile()?.SyncDevices, [{ SyncStatus: true, Connect: false, EquipmentType: 0, DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtModel: null }]);
  assert.match(await readConfig(join(h.serve, 'Theme', 'User', 'P2.pcenter')), /^\{"Sync_Profile":\{"EffectDetailInfo":null,"SyncDevices":\[\{"SyncStatus":true,/);
  assert.equal(await readConfig(join(h.serve, 'Config', 'SoftConfig.data')), '{"TurnOffLightsWhenIdle":true,"TurnOffLightsWhenIdleDuration":5}');
  // Later operations still run (nothing stayed locked).
  assert.equal((await within(h.call('Theme_AddProfile', 'User', 'P3'), 1000, 'next operation')).err_code, 0);
});

test('a save pending before the operation, awaited from the queue during Theme_Switch / Theme_ResetCurProfile, does not deadlock', async (t) => {
  const h = await harness(t, { seed: true, store: { saveDebounceMs: 10_000 } });
  const p = new QueuedParticipant();
  h.store.registerParticipant(p);
  await h.call('Theme_AddProfile', 'User', 'P2');

  for (const op of [() => h.call('Theme_Switch', 'User', 'P2'), () => h.call('Theme_ResetCurProfile')]) {
    p.content = '{"Edit":1}';
    const early = h.store.saveParticipant(p); // in the 10 s debounce window
    const g = gate();
    const task = p.queue.run(async () => {
      await g.promise;
      await early;
      await h.store.setSyncProfile(SYNC);
    });
    const applies = p.applyCalls + p.resetCalls;
    const running = op();
    await until(() => p.applyCalls + p.resetCalls === applies + 1, 2000, 'the operation to reach the participant');
    g.open();
    await within(task, 3000, 'the queue task');
    assert.equal((await within(running, 3000, 'the operation')).err_code, 0);
  }
  // The switch wrote the pending edit into the profile it left.
  assert.match(await readConfig(join(h.serve, 'Theme', 'User', 'Default.pcenter')), /"ProfileContent":"\{\\"Edit\\":1\}"/);
});

test('a participant that never answers is bounded: the operation completes and the store stays usable', async (t) => {
  const h = await harness(t, { seed: true, store: { participantTimeoutMs: 50 } });
  const stuck: ProfileParticipant = {
    desc: DISPLAY_DESC,
    purify: () => '{"Stuck":1}',
    applyProfileContent: () => new Promise<void>(() => undefined),
    resetToFactory: () => new Promise<void>(() => undefined),
  };
  h.store.registerParticipant(stuck);
  await h.call('Theme_AddProfile', 'User', 'P2');
  const sw = await within(h.call('Theme_Switch', 'User', 'P2'), 2000, 'Theme_Switch with a stuck participant');
  assert.equal(sw.err_code, 0);
  assert.equal(h.store.currentProfileName(), 'P2');
  assert.match(await readConfig(join(h.serve, 'Theme', 'User', 'P2.pcenter')), /\{\\"Stuck\\":1\}/);
  assert.equal((await within(h.call('Theme_ResetCurProfile'), 2000, 'Theme_ResetCurProfile')).err_code, 0);
  assert.equal((await within(h.call('FactoryReset'), 2000, 'FactoryReset')).err_code, 0);
  assert.equal((await within(h.call('Theme_AddProfile', 'User', 'P3'), 1000, 'next operation')).err_code, 0);
});

test('read-only queries are served from memory while an operation holds the lock (SO:2994-3007, Bridge.cs:23-26)', async (t) => {
  const h = await harness(t, { seed: true });
  const p = new FakeParticipant();
  const g = gate();
  p.onApply = () => g.promise;
  h.store.registerParticipant(p);
  await h.call('Theme_AddProfile', 'User', 'P2');
  const sw = h.call('Theme_Switch', 'User', 'P2');
  await until(() => p.applied.length === 1, 2000, 'the switch to reach applyProfileContent');
  const [cur, infos, global, profile] = await within(
    Promise.all([h.call('Theme_GetCurTheme'), h.call('Theme_GetThemeInfos'), h.call('Setting_GlobalData'), h.call('Theme_GetCurProfile')]),
    1000,
    'read-only queries during a switch',
  );
  // The switch has made P2 current (synchronously, before applying).
  assert.equal((cur.Tag as { SelProfileName: string }).SelProfileName, 'P2');
  assert.equal((infos.Tag as unknown[]).length, 1);
  assert.deepEqual(global.Tag, { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 });
  assert.deepEqual(profile.Tag, { Sync_Profile: null, Profiles: [] });
  g.open();
  assert.equal((await sw).err_code, 0);
});

test('onSwitched listeners run after the lock is released: an operation they start queues behind the next switch', async (t) => {
  const h = await harness(t, { seed: true });
  const p = new QueuedParticipant();
  h.store.registerParticipant(p);
  await h.call('Theme_AddProfile', 'User', 'P2');
  let first = true;
  h.store.onSwitched((e) => {
    p.log.push(`event:${e.profile}`);
    if (!first) return;
    first = false;
    void h.store.addProfile('User', 'FromListener').then(() => p.log.push('listener-op-done'));
    void h.store.setSyncProfile(SYNC).then(() => p.log.push('listener-sync-done'));
  });
  const s1 = h.call('Theme_Switch', 'User', 'P2');
  const s2 = h.call('Theme_Switch', 'User', 'Default');
  const [r1, r2] = await within(Promise.all([s1, s2]), 3000, 'two switches');
  assert.deepEqual([r1.err_code, r2.err_code], [0, 0]);
  await until(() => p.log.includes('listener-op-done') && p.log.includes('listener-sync-done'), 2000, 'the listener work');
  const at = (s: string) => p.log.indexOf(s);
  assert.ok(at('event:P2') > at('apply-end#1'), p.log.join(' '));
  assert.ok(at('event:P2') < at('apply-start#2'), p.log.join(' '));
  // The listener's operation neither ran inline nor overlapped switch #2: it was queued behind it.
  assert.ok(at('listener-op-done') > at('apply-end#2'), p.log.join(' '));
  assert.ok(at('listener-op-done') > at('event:Default'), p.log.join(' '));
  assert.deepEqual(((await h.call('Theme_GetCurTheme')).Tag as { ProfileNames: string[] }).ProfileNames, ['Default', 'P2', 'FromListener']);
  // The mutator applied to exactly one profile, and memory matches disk for the current one.
  await h.store.flush();
  const files = await Promise.all(['P2', 'Default'].map((n) => readConfig(join(h.serve, 'Theme', 'User', `${n}.pcenter`))));
  assert.equal(files.filter((f) => f.includes('"SyncStatus":true')).length, 1, files.join('\n'));
  const current = JSON.parse(files[1]) as { Sync_Profile: unknown };
  assert.deepEqual(h.store.getSyncProfile(), current.Sync_Profile);
});

test('a debounced edit is written into the profile being left before Switch, and read by Copy / Export / Import', async (t) => {
  const h = await harness(t, { seed: true, store: { saveDebounceMs: 10_000 } });
  const dir = join(h.serve, 'Theme', 'User');
  const p = new FakeParticipant('{"Edit":0}');
  p.onApply = async (c) => {
    p.content = c ?? '{"Fresh":1}';
  };
  h.store.registerParticipant(p);

  p.content = '{"Edit":1}';
  const s1 = h.store.saveParticipant(p);
  assert.equal((await h.call('Theme_CopyProfile', 'User', 'Default', 'C')).err_code, 0);
  await within(s1, 1000, 'the pending save');
  assert.match(await readConfig(join(dir, 'C.pcenter')), /\{\\"Edit\\":1\}/);

  p.content = '{"Edit":2}';
  const s2 = h.store.saveParticipant(p);
  const out = join(h.root, 'exported.pcenter');
  assert.equal((await h.call('Theme_ExportProfile', 'User', 'Default', out)).err_code, 0);
  await within(s2, 1000, 'the pending save');
  assert.match((await readFile(out)).toString('utf8'), /\{\\"Edit\\":2\}/);

  await h.call('Theme_AddProfile', 'User', 'P2');
  p.content = '{"Edit":3}';
  const s3 = h.store.saveParticipant(p);
  assert.equal((await h.call('Theme_Switch', 'User', 'P2')).err_code, 0);
  await within(s3, 1000, 'the pending save');
  // The edit belongs to Default (the profile left); P2 got the post-apply state, not the edit.
  assert.match(await readConfig(join(dir, 'Default.pcenter')), /\{\\"Edit\\":3\}/);
  const p2 = await readConfig(join(dir, 'P2.pcenter'));
  assert.match(p2, /\{\\"Fresh\\":1\}/);
  assert.doesNotMatch(p2, /Edit/);

  p.content = '{"Edit":4}';
  const s4 = h.store.saveParticipant(p);
  const src = join(h.root, 'evnia', 'Imported');
  await copyFile(FIXTURE_DEFAULT_PCENTER, src);
  assert.equal((await h.call('Theme_ImportProfile', 'User', src, false)).err_code, 0);
  await within(s4, 1000, 'the pending save');
  assert.match(await readConfig(join(dir, 'P2.pcenter')), /\{\\"Edit\\":4\}/);
});

test('Theme_Rename of the current theme: saves before, during and after land in the renamed directory only', async (t) => {
  const h = await harness(t, { seed: true });
  const exe = join(h.root, 'apps', 'game');
  await mkdir(join(h.root, 'apps'), { recursive: true });
  await writeFile(exe, '#!/bin/sh\nexit 0\n');
  await chmod(exe, 0o755);
  assert.equal((await h.call('Theme_Add', 'App', JSON.stringify([{ BindAppFilePath: exe, BindAppIconPath: '' }]))).err_code, 0);
  assert.equal((await h.call('Theme_Switch', 'App', '')).err_code, 0);
  const p = new FakeParticipant('{"Before":1}');
  h.store.registerParticipant(p);
  // A save racing the rename (queued on the next tick while the rename runs).
  const s = h.store.saveParticipant(p);
  const r = h.call('Theme_Rename', 'App', 'Games');
  await within(Promise.all([s, r]), 2000, 'save + rename');
  assert.equal((await r).err_code, 0);
  p.content = '{"After":1}';
  await h.store.saveParticipant(p);
  await h.store.flush();
  await assert.rejects(stat(join(h.serve, 'Theme', 'App')), 'no stray directory under the old name');
  assert.match(await readConfig(join(h.serve, 'Theme', 'Games', 'Default.pcenter')), /\{\\"After\\":1\}/);
  assert.equal(h.store.currentThemeName(), 'Games');
  assert.match(await readConfig(join(h.serve, 'Theme', 'DataTheme.cfg')), /"Name":"Games"/);
});

test('Theme_RenameProfile of the current profile with a pending save: the renamed file gets it, the old name stays gone', async (t) => {
  const h = await harness(t, { seed: true, store: { saveDebounceMs: 10_000 } });
  const dir = join(h.serve, 'Theme', 'User');
  const p = new FakeParticipant('{"Pending":1}');
  h.store.registerParticipant(p);
  const s = h.store.saveParticipant(p);
  assert.equal((await h.call('Theme_RenameProfile', 'User', 'Default', 'Main')).err_code, 0);
  await within(s, 1000, 'the pending save');
  p.content = '{"Later":1}';
  const later = h.store.saveParticipant(p);
  await h.store.flush();
  await later;
  assert.deepEqual((await readdir(dir)).sort(), ['Main.pcenter']);
  assert.match(await readConfig(join(dir, 'Main.pcenter')), /\{\\"Later\\":1\}/);
});

test('FactoryReset "InitEnviroment error": fresh state in memory, participants untouched, start() recovers (SO:254-303)', async (t) => {
  // Not named EvniaServe: only Theme/Config/Cache are wiped, so a *file* named Theme survives the wipe
  // and makes writing the fresh DataTheme.cfg fail.
  const h = await harness(t, { seed: true, serveName: 'custom-root' });
  const p = new FakeParticipant('{"X":1}');
  h.store.registerParticipant(p);
  await h.call('Setting_TurnOffLightsWhenIdle', true);
  await h.call('Theme_AddProfile', 'User', 'P2');
  await h.call('Theme_Switch', 'User', 'P2');
  const events: string[] = [];
  h.store.onSwitched((e) => events.push(`${e.reason}:${e.theme}|${e.profile}`));
  await rm(join(h.serve, 'Theme'), { recursive: true, force: true });
  await writeFile(join(h.serve, 'Theme'), 'blocker');

  const r = await h.call('FactoryReset');
  assert.deepEqual([r.err_code, r.IsSucc, r.err_msg, r.Tag], [9, false, 'InitEnviroment error', null]);
  // The vendor kept pointing at the wiped theme; the port holds the fresh state (consistent with the index).
  assert.deepEqual((await h.call('Theme_GetCurTheme')).Tag, USER_THEME);
  assert.deepEqual((await h.call('Theme_GetThemeInfos')).Tag, [USER_THEME]);
  assert.deepEqual((await h.call('Theme_GetCurProfile')).Tag, { Sync_Profile: null, Profiles: [] });
  assert.deepEqual(h.store.getSoftConfig(), { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 });
  assert.equal(p.resets, 0, 'devices are not reset when the environment cannot be initialised (vendor)');
  assert.deepEqual(events, ['factory-reset:User|Default']);

  await assert.rejects(h.store.start(), /^Error: InitEnviroment error$/);
  await rm(join(h.serve, 'Theme'));
  await h.store.start();
  assert.equal(await readConfig(join(h.serve, 'Theme', 'DataTheme.cfg')), USER_DATA_THEME);
  assert.match(await readConfig(join(h.serve, 'Theme', 'User', 'Default.pcenter')), /\{\\"X\\":1\}/);
});
