// Replay machinery shared by the contract tests (not a test file itself): send requests to a backend, collect
// the notifications each one raised, and compare replies with the Windows backend's (compare.ts).

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Backend } from '../../src/backend/types.ts';
import { ENVIRONMENT_DEPENDENT, at, compareJson, formatDiffs, jsonKeyOrders, stringifyOrdered, subtreeOrders, type KeyOrders } from './compare.ts';
import { composeMockBackend, type ComposeOptions, type ComposedBackend } from './compose.ts';
import { loadGolden, type Golden, type GoldenStep, type ResolvedGoldenStep } from './golden.ts';

export const GOLDEN: Golden = loadGolden();
export const N0 = GOLDEN.notifications.N0;
export const CONSTRAINTS_NOTIFICATION = 'NotifyUIDisplayFuncConstraintsChange';
export const EFFECT_NOTIFICATION = 'NotifyUIDisplayEffectChange';
export const PROFILE_FIXTURE = 'profile-getdevicedata-tag.json';

export interface ReplayResult {
  reply: string;
  /** Notifications that arrived while the request ran. */
  during: string[];
}

export interface RpcResult {
  reply: Record<string, any>;
  /** The raw reply (its key orders: jsonKeyOrders(text)). */
  text: string;
  during: Record<string, any>[];
}

export class Replayer {
  readonly #backend: Backend;
  readonly #notifications: string[];
  #seen = 0;
  /** Notifications that arrived between requests, with the label of the preceding step. */
  readonly between: { after: string; json: string }[] = [];
  #last = 'backend start';

  constructor(backend: Backend, notifications: string[]) {
    this.#backend = backend;
    this.#notifications = notifications;
  }

  async call(label: string, requestJson: string): Promise<ReplayResult> {
    this.#collect();
    const before = this.#notifications.length;
    const reply = await this.#backend.handleRequest(requestJson);
    const during = this.#notifications.slice(before);
    this.#seen = this.#notifications.length;
    this.#last = label;
    return { reply, during };
  }

  /** One request built like the renderer's (02 §4.4). */
  async rpc(label: string, functionName: string, parms: unknown[] | null = null): Promise<RpcResult> {
    const r = await this.call(label, JSON.stringify({ functionName, requestId: `contract-${label}`, parms }));
    return { reply: JSON.parse(r.reply) as Record<string, any>, text: r.reply, during: r.during.map((n) => JSON.parse(n) as Record<string, any>) };
  }

  /** Notifications that arrived since the last request (moved to `between`), parsed. */
  drain(): Record<string, any>[] {
    const from = this.between.length;
    this.#collect();
    return this.between.slice(from).map((b) => JSON.parse(b.json) as Record<string, any>);
  }

  #collect(): void {
    for (const json of this.#notifications.slice(this.#seen)) this.between.push({ after: this.#last, json });
    this.#seen = this.#notifications.length;
  }
}

/** The reply must equal the Windows one (compare.ts); with nothing tolerated, byte for byte. */
export function assertMatches(actualJson: string, expected: unknown, expectedOrder: KeyOrders, what: string): void {
  const actual = JSON.parse(actualJson) as unknown;
  const { diffs, tolerated } = compareJson(actual, expected, ENVIRONMENT_DEPENDENT, '', { actual: jsonKeyOrders(actualJson), expected: expectedOrder });
  assert.equal(diffs.length, 0, `${what} differs from the Windows backend:\n${formatDiffs(diffs)}`);
  // With nothing tolerated the bytes must be identical (Newtonsoft compact form, integer-like keys in the
  // fixture's raw order).
  if (tolerated.length === 0) assert.equal(actualJson, stringifyOrdered(expected, expectedOrder), `${what}: bytes`);
}

/** Compare a sub-tree of a reply text with an expected value whose raw order is `expectedOrder`. */
export function subtreeDiffs(text: string, path: string, expected: unknown, expectedOrder?: KeyOrders): string {
  const actual = at(JSON.parse(text), path);
  return formatDiffs(compareJson(actual, expected, [], '', { actual: subtreeOrders(jsonKeyOrders(text), path), expected: expectedOrder }).diffs);
}

export function assertNotifications(step: GoldenStep, during: string[]): void {
  const policy = step.notifications;
  const label = `step ${step.step} ${step.functionName}`;
  if (policy.mode === 'none') {
    assert.deepEqual(during.map((n) => JSON.parse(n).FunctionName), [], `${label}: no notification expected`);
    return;
  }
  if (policy.mode === 'exact') {
    assert.equal(during.length, policy.expected.length, `${label}: notifications ${during.map((n) => JSON.parse(n).FunctionName).join(', ')}`);
    policy.expected.forEach((name, i) => assertMatches(during[i], GOLDEN.notifications[name], GOLDEN.notificationOrders[name], `${label} notification ${name}`));
    return;
  }
  for (const n of during) assert.ok(isAllowedNotification(n, policy.allowed), `${label}: unexpected notification ${n.slice(0, 200)}`);
}

/** Whether `json` equals (modulo the tolerated paths) one of the named golden notifications. */
export function isAllowedNotification(json: string, allowed: readonly string[]): boolean {
  return allowed.some(
    (name) => compareJson(JSON.parse(json), GOLDEN.notifications[name], ENVIRONMENT_DEPENDENT, '', { actual: jsonKeyOrders(json), expected: GOLDEN.notificationOrders[name] }).diffs.length === 0,
  );
}

/** Send one golden request and check its reply and the notifications it raised. Throws on mismatch. */
export async function replayStep(replay: Replayer, step: ResolvedGoldenStep): Promise<void> {
  const { reply, during } = await replay.call(step.step, step.request);
  assertMatches(reply, step.reply, step.replyOrder, `step ${step.step} ${step.functionName} reply`);
  assertNotifications(step, during);
}

export function goldenStep(step: string): ResolvedGoldenStep {
  const s = GOLDEN.steps.find((x) => x.step === step);
  if (!s) throw new Error(`no golden step ${step}`);
  return s;
}

/**
 * Notifications between requests come from background work (the full VCP read after Start). Before the first
 * PHL_GetConstraints only N0 may appear (20-backend-host-tail §7.2); afterwards nothing may.
 */
export function assertBackgroundNotifications(replay: Replayer): void {
  const firstConstraints = GOLDEN.steps.findIndex((s) => s.functionName === 'PHL_GetConstraints');
  for (const { after, json } of replay.between) {
    const index = GOLDEN.steps.findIndex((s) => s.step === after);
    const early = after === 'backend start' || (index >= 0 && index < firstConstraints);
    assert.ok(early, `unexpected background notification after step ${after}: ${json.slice(0, 200)}`);
    assert.deepEqual(compareJson(JSON.parse(json), N0).diffs, [], `background notification after ${after}`);
  }
}

/** Poll `condition` every 10 ms until it holds; fail with `what` after `ms`. */
export async function waitFor(condition: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await condition())) {
    if (performance.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Compose the production backend in mock mode, run `body`, always stop it; skip without vendor data. */
export async function withComposedBackend(t: TestContext, options: ComposeOptions, body: (c: ComposedBackend) => Promise<void>): Promise<void> {
  const c = await composeMockBackend(options);
  if ('skip' in c) {
    t.skip(c.skip);
    return;
  }
  t.diagnostic(`production composition, EVNIA_MOCK_MONITOR=${c.mockMonitor}`);
  try {
    await body(c);
  } catch (e) {
    const tail = c.logLines.filter((l) => l.level === 'warn' || l.level === 'error').slice(-20);
    if (tail.length) t.diagnostic(`backend warnings/errors:\n${tail.map((l) => `${l.level} [${l.scope}] ${l.text}`).join('\n')}`);
    throw e;
  } finally {
    await c.cleanup();
  }
}

/**
 * Every NotifyUIDisplayEffectChange Tag carries the named keys the renderer reads (Monitor-D4qz4RBn.js:85-91)
 * first, then the vendor's ValueTuple keys Item1..3 with the same values (12 §7 port plan item 7).
 */
export function assertEffectChange(n: Record<string, any>, eneEnable: boolean, what: string): void {
  assert.equal(n.FunctionName, EFFECT_NOTIFICATION, what);
  assert.equal(n.RequestId, null, `${what}: a notification`);
  assert.deepEqual(
    Object.keys(n.Tag),
    ['ENEEnable', 'EffectInfo', 'ModuleAmbiglow', 'Item1', 'Item2', 'Item3'],
    `${what}: named keys, then the vendor's tuple keys (20-backend-host-tail §2.5)`,
  );
  assert.deepEqual([n.Tag.Item1, n.Tag.Item2, n.Tag.Item3], [n.Tag.ENEEnable, n.Tag.EffectInfo, n.Tag.ModuleAmbiglow], `${what}: Item1..3`);
  assert.equal(n.Tag.ENEEnable, eneEnable, `${what}: ENEEnable`);
}
