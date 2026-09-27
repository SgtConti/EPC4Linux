// Golden transcript fixtures (not a test file itself): loading, and re-deriving them from the specs.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { jsonKeyOrders, prefixedOrders, stringifyOrdered, subtreeOrders, type KeyOrders } from './compare.ts';

export const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const REPO_DIR = fileURLToPath(new URL('../../../', import.meta.url));
export const WINDOWS_FIXTURES = fileURLToPath(new URL('../fixtures/windows/', import.meta.url));

/** sha256 of the compact Profile_GetDeviceData Tag given in 20-enum-valuelist-catalog §5 (29403 bytes). */
export const PROFILE_TAG_SHA256 = '91e8a59c09e6a94d2e67d0422ed35519be6c8111499da17187c368c460d45a45';

/**
 * Static Tags of 20-enum-valuelist-catalog §6 (compact UI form, as Newtonsoft writes them): byte length and
 * sha256 from the section headings (checked against the document by the provenance test).
 */
export const SPEC_STATIC_TAGS = {
  /** §6.1 Effect_GetMenu(100000) with ENE model "34M2C8600". */
  effectMenuEne: { section: '6.1', bytes: 3962, sha256: '516cd5fad0f6938f314663ae956a79b845a816d272b7446b6bf605f77b290af2' },
  /** §6.2 Effect_GetMenu(100000) without ENE (string_0 = ""). */
  effectMenuNoEne: { section: '6.2', bytes: 3277, sha256: 'cd09882c69487c4bc4c2c08251d34db1119beb152a6be887c1aa63609306a236' },
  /** §6.3 DisplayEffectInfo.Default("34M2C8600") — the Effect_Reset Tag with ENE. */
  effectInfoDefault: { section: '6.3', bytes: 1994, sha256: '341006d3282ac2e6986a94ba8878498107baa0c0f0516f9fe11da3baa36f41e8' },
} as const;

export type NotificationPolicy =
  /** Zero or more notifications, each byte-equal (modulo tolerances) to one of `allowed`. */
  | { mode: 'optional'; allowed: string[] }
  /** Exactly these notifications, in order, before the reply. */
  | { mode: 'exact'; expected: string[] }
  | { mode: 'none' };

export interface GoldenStep {
  step: string;
  log: string;
  functionName: string;
  /** Verbatim GetTaskAsync argument (the renderer's JSON request string). */
  request: string;
  /** Expected reply envelope; a Tag of {"$fixture": file} is replaced by that fixture file's content. */
  reply: Record<string, unknown>;
  notifications: NotificationPolicy;
  vendorReply?: Record<string, unknown>;
  note?: string;
}

export interface ResolvedGoldenStep extends GoldenStep {
  /** Raw key order of `reply` as written in the fixture files (compare.ts header: integer-like keys). */
  replyOrder: KeyOrders;
}

export interface Golden {
  steps: ResolvedGoldenStep[];
  notifications: Record<string, Record<string, unknown>>;
  /** Raw key order of each notification, by name. */
  notificationOrders: Record<string, KeyOrders>;
}

export function readFixtureText(name: string): string {
  return readFileSync(FIXTURE_DIR + name, 'utf8');
}

export function readFixture<T = unknown>(name: string): T {
  return JSON.parse(readFixtureText(name)) as T;
}

/** Raw key orders of a fixture file (compare.ts jsonKeyOrders). */
export function fixtureOrders(name: string): Map<string, string[]> {
  return jsonKeyOrders(readFixtureText(name));
}

interface RawGolden {
  steps: GoldenStep[];
  notifications: Record<string, Record<string, unknown>>;
}

/** The golden transcript with every `$fixture` reference resolved, and the fixtures' raw key orders. */
export function loadGolden(): Golden {
  const file = 'golden-2026-09-26.json';
  const raw = readFixture<RawGolden>(file);
  const orders = fixtureOrders(file);
  const fixtureRef = (v: unknown): string | null =>
    v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { $fixture?: unknown }).$fixture === 'string' ? (v as { $fixture: string }).$fixture : null;
  return {
    steps: raw.steps.map((s, i) => {
      const replyOrder = subtreeOrders(orders, `steps[${i}].reply`);
      const ref = fixtureRef(s.reply.Tag);
      if (ref === null) return { ...s, replyOrder };
      for (const p of [...replyOrder.keys()]) if (p === 'Tag' || p.startsWith('Tag.') || p.startsWith('Tag[')) replyOrder.delete(p);
      for (const [p, keys] of prefixedOrders(fixtureOrders(ref), 'Tag')) replyOrder.set(p, keys);
      return { ...s, reply: { ...s.reply, Tag: readFixture(ref) }, replyOrder };
    }),
    notifications: raw.notifications,
    notificationOrders: Object.fromEntries(Object.keys(raw.notifications).map((name) => [name, subtreeOrders(orders, `notifications.${name}`)])),
  };
}

/** The Profile_GetDeviceData Tag of the user's HDR state (20-enum-valuelist-catalog §5). */
export function profileTag(): Record<string, unknown> {
  return readFixture('profile-getdevicedata-tag.json');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ───────────── Re-deriving the fixtures from the documents (provenance check) ─────────────

export const HOST_TAIL_MD = `${REPO_DIR}docs/re/20-backend-host-tail.md`;
export const ENUM_CATALOG_MD = `${REPO_DIR}docs/re/20-enum-valuelist-catalog.md`;
export const SESSION_LOG = `${WINDOWS_FIXTURES}logs/EvniaServe-2026-09-26.txt`;

export function specsPresent(): boolean {
  return existsSync(HOST_TAIL_MD) && existsSync(ENUM_CATALOG_MD) && existsSync(SESSION_LOG);
}

/**
 * Every complete JSON reply/notification line of 20-backend-host-tail §5, keyed by RequestId ('N0' for the
 * notification), parsed and as the raw line text (for the key order of integer-like keys).
 */
export function specReplyEntries(): Map<string, { value: Record<string, unknown>; text: string }> {
  const lines = readFileSync(HOST_TAIL_MD, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('## 5. (d) Golden transcript'));
  const to = lines.findIndex((l) => l.startsWith('## 6. (e)'));
  const out = new Map<string, { value: Record<string, unknown>; text: string }>();
  for (const l of lines.slice(from, to)) {
    const m = /^(R|R\(port\)|N0)\s*=\s*(\{.*\})$/.exec(l) ?? (/^\{"err_code".*\}$/.test(l) ? ['', '', l] : null);
    if (!m) continue;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(m[2]) as Record<string, unknown>;
    } catch {
      continue; // skeletons with "…" or "<same object as step 12>"
    }
    if (stringifyOrdered(v, jsonKeyOrders(m[2])) !== m[2]) throw new Error(`spec line is not in compact Newtonsoft form: ${m[2].slice(0, 80)}`);
    out.set(m[1] === 'N0' ? 'N0' : String(v.RequestId), { value: v, text: m[2] });
  }
  return out;
}

/** specReplyEntries(), parsed values only. */
export function specReplies(): Map<string, Record<string, unknown>> {
  return new Map([...specReplyEntries()].map(([id, e]) => [id, e.value]));
}

/** The pretty-printed §5 block of 20-enum-valuelist-catalog, as text. */
export function specProfileTagText(): string {
  const lines = readFileSync(ENUM_CATALOG_MD, 'utf8').split('\n');
  const section = lines.findIndex((l) => l.startsWith('## 5. (d) Full UI-form'));
  const start = lines.findIndex((l, i) => i > section && l === '```json');
  const end = lines.findIndex((l, i) => i > start && l === '```');
  return lines.slice(start + 1, end).join('\n');
}

/** The pretty-printed §5 block of 20-enum-valuelist-catalog, parsed. */
export function specProfileTag(): unknown {
  return JSON.parse(specProfileTagText());
}

/** `### 6.N … — <bytes> bytes, sha256 \`<hex>\`` headings of 20-enum-valuelist-catalog §6, by section number. */
export function specStaticTagHeadings(): Map<string, { bytes: number; sha256: string }> {
  const out = new Map<string, { bytes: number; sha256: string }>();
  for (const line of readFileSync(ENUM_CATALOG_MD, 'utf8').split('\n')) {
    const m = /^### (6\.\d+) .* — (\d+) bytes, sha256 `([0-9a-f]{64})`/.exec(line);
    if (m) out.set(m[1], { bytes: Number(m[2]), sha256: m[3] });
  }
  return out;
}

/** The verbatim request of `requestId` in the user's 2026-09-26 EvniaServe log. */
export function loggedRequest(requestId: string): string | null {
  const log = readFileSync(SESSION_LOG, 'utf8');
  for (const m of log.matchAll(/GetTaskAsync param = (\{.*?\})  \S/g)) {
    if (m[1].includes(`"requestId":"${requestId}"`)) return m[1];
  }
  return null;
}
