// Exact-count, hash-guarded string patching of the vendor renderer (02 §L.3).
//
// Every patch must match exactly `expectCount` times (default 1) in a file whose SHA-256 equals the
// pinned value, otherwise the whole import aborts. This makes a different vendor build fail loudly
// at build time instead of silently producing a half-patched, possibly online, UI.

import { createHash } from 'node:crypto';
import type { AppliedPatch, PatchSpec, PinnedFile, UiPatchTable } from './types.ts';

/** Error raised for any condition that must abort the import. `code` is stable for tests/CI. */
export class ImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `*` matches any run of characters except `/`; everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${body}$`);
}

export function matchGlob(paths: Iterable<string>, glob: string): string[] {
  const re = globToRegExp(glob);
  return [...paths].filter((p) => re.test(p)).sort();
}

/**
 * Checks that every pinned file exists under its exact 1.13.0 name and has the pinned hash.
 * The error message names the glob candidates so a user with another vendor version sees at once
 * which build they have.
 */
export function verifyPinnedFiles(files: ReadonlyMap<string, Uint8Array>, pinned: readonly PinnedFile[], version: string): void {
  for (const pin of pinned) {
    const data = files.get(pin.path);
    if (!data) {
      const candidates = matchGlob(files.keys(), pin.glob);
      throw new ImportError(
        'PIN_MISSING',
        `Vendor UI mismatch: expected ${pin.path} (Evnia Precision Center ${version}) but ` +
          (candidates.length ? `found ${candidates.join(', ')}` : `no file matches ${pin.glob}`) +
          '. This importer only supports the pinned vendor version; update scripts/ui-patches.mjs for a new version.',
      );
    }
    const actual = sha256(data);
    if (actual !== pin.sha256) {
      throw new ImportError(
        'PIN_HASH',
        `Vendor UI mismatch: ${pin.path} has SHA-256 ${actual}, expected ${pin.sha256} (Evnia Precision Center ${version}). ` +
          'The installer copy is a different or modified build; refusing to patch it.',
      );
    }
  }
}

function globalRegExp(re: RegExp): RegExp {
  return re.flags.includes('g') ? new RegExp(re.source, re.flags) : new RegExp(re.source, `${re.flags}g`);
}

/** Number of non-overlapping occurrences of `find` in `text`. */
export function countOccurrences(text: string, find: string | RegExp): number {
  if (typeof find === 'string') {
    if (find.length === 0) throw new ImportError('PATCH_EMPTY_FIND', 'Patch find string must not be empty');
    let count = 0;
    for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) count++;
    return count;
  }
  let count = 0;
  for (const m of text.matchAll(globalRegExp(find))) {
    if (m[0].length === 0) throw new ImportError('PATCH_EMPTY_MATCH', `Patch regex ${find} matched an empty string`);
    count++;
  }
  return count;
}

/** Applies one patch to `text`; throws unless it matches exactly `expectCount` times. */
export function applyPatch(text: string, patch: PatchSpec): { text: string; count: number } {
  const expect = patch.expectCount ?? 1;
  const count = countOccurrences(text, patch.find);
  if (count !== expect) {
    throw new ImportError(
      'PATCH_COUNT',
      `Patch ${patch.id} (${patch.file}): anchor matched ${count} time(s), expected exactly ${expect}. ` +
        'The vendor file differs from the reviewed build or another patch changed the anchor.',
    );
  }
  const out =
    typeof patch.find === 'string'
      ? text.split(patch.find).join(patch.replace)
      : text.replace(globalRegExp(patch.find), () => patch.replace);
  return { text: out, count };
}

/** Decodes UTF-8 and proves the round trip is lossless, so patching never corrupts other bytes. */
export function decodeUtf8Strict(path: string, data: Uint8Array): string {
  const text = Buffer.from(data).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(data))) {
    throw new ImportError('NOT_UTF8', `${path} is not valid UTF-8; refusing to patch it as text`);
  }
  return text;
}

/**
 * Applies the patch table in order. `files` maps renderer-relative paths to contents and is updated
 * in place. Patches for the same file see the output of earlier patches, so anchors must not overlap.
 */
export function applyPatchTable(files: Map<string, Uint8Array>, table: Pick<UiPatchTable, 'pinnedFiles' | 'patches'>): AppliedPatch[] {
  const byGlob = new Map(table.pinnedFiles.map((p) => [p.glob, p]));
  const texts = new Map<string, string>();
  const applied: AppliedPatch[] = [];
  for (const patch of table.patches) {
    const pin = byGlob.get(patch.file);
    if (!pin) throw new ImportError('PATCH_UNPINNED', `Patch ${patch.id} targets ${patch.file}, which is not in the pinned-file table`);
    const data = files.get(pin.path);
    if (!data) throw new ImportError('PIN_MISSING', `Patch ${patch.id}: ${pin.path} is missing`);
    const before = texts.get(pin.path) ?? decodeUtf8Strict(pin.path, data);
    const { text, count } = applyPatch(before, patch);
    texts.set(pin.path, text);
    applied.push({ id: patch.id, file: pin.path, count, rationale: patch.rationale, spec: patch.spec });
  }
  for (const [path, text] of texts) files.set(path, Buffer.from(text, 'utf8'));
  return applied;
}

/** Structural validation of the table, so a typo in ui-patches.mjs fails before anything is written. */
export function validatePatchTable(table: UiPatchTable): void {
  const fail = (msg: string): never => {
    throw new ImportError('TABLE_INVALID', `scripts/ui-patches.mjs: ${msg}`);
  };
  const isHex = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
  if (!table.vendor?.version) fail('vendor.version is required');
  if (!table.csp || /[\r\n"]/.test(table.csp)) fail('csp must be a single-line policy without double quotes');
  const lists = ['pinnedFiles', 'patches', 'cspFiles', 'removals', 'copies', 'urlAllowlist', 'reviewedSites', 'reviewedSchemes', 'touchpoints'] as const;
  for (const key of lists) if (!Array.isArray(table[key])) fail(`${key} must be an array`);
  const globs = new Set<string>();
  for (const pin of table.pinnedFiles) {
    if (!isHex(pin.sha256)) fail(`pinned file ${pin.path} has an invalid sha256`);
    if (!globToRegExp(pin.glob).test(pin.path)) fail(`pinned path ${pin.path} does not match its glob ${pin.glob}`);
    if (globs.has(pin.glob)) fail(`duplicate pinned glob ${pin.glob}`);
    globs.add(pin.glob);
  }
  const ids = new Set<string>();
  for (const p of table.patches) {
    if (!p.id || ids.has(p.id)) fail(`missing or duplicate patch id ${p.id}`);
    ids.add(p.id);
    if (!globs.has(p.file)) fail(`patch ${p.id} targets unpinned file ${p.file}`);
    if (typeof p.find !== 'string' && !(p.find instanceof RegExp)) fail(`patch ${p.id} has no find anchor`);
    if (typeof p.replace !== 'string') fail(`patch ${p.id} has no replacement`);
    const n = p.expectCount ?? 1;
    if (!Number.isInteger(n) || n < 1) fail(`patch ${p.id} expectCount must be a positive integer`);
    if (!p.rationale || !p.spec) fail(`patch ${p.id} needs a rationale and a spec reference`);
  }
  for (const f of table.cspFiles) if (!globs.has(f)) fail(`CSP target ${f} must be pinned`);
  for (const r of table.removals) {
    if (!r.path || r.path.startsWith('/') || r.path.includes('..')) fail(`invalid removal path ${r.path}`);
    if (!Number.isInteger(r.mapDepsEntries) || r.mapDepsEntries < 0) fail(`removal ${r.path} needs mapDepsEntries >= 0`);
  }
  for (const c of table.copies) {
    if (c.source.includes('..') || c.destDir.includes('..')) fail(`invalid copy spec ${c.source}`);
    if (!/^vendor-(?:data|assets)(?:\/|$)/.test(c.destDir)) fail(`copy ${c.source} must go to vendor-data/ or vendor-assets/`);
    if (c.source.includes('*') && (c.from !== 'asar' || c.source.lastIndexOf('/') > c.source.indexOf('*'))) {
      fail(`copy ${c.source}: globs are only supported in the last path segment of an asar source`);
    }
    if (!c.source.includes('*') && !isHex(c.sha256)) fail(`copy ${c.source} must pin a sha256`);
  }
  // A reviewed entry covers an exact, positive number of sites identified by a non-empty context.
  for (const s of [...table.reviewedSites, ...table.reviewedSchemes]) {
    if (!s.file || !s.context || !s.reason || !Number.isInteger(s.count) || s.count < 1) {
      fail(`reviewed entry "${s.context}" in ${s.file} needs a file glob, a context, a reason and a count >= 1`);
    }
  }
  for (const t of table.touchpoints) {
    for (const id of t.patches) if (!ids.has(id)) fail(`touchpoint ${t.id} references unknown patch ${id}`);
  }
}
