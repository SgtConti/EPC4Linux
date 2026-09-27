import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPatch,
  applyPatchTable,
  countOccurrences,
  decodeUtf8Strict,
  globToRegExp,
  ImportError,
  sha256,
  validatePatchTable,
  verifyPinnedFiles,
} from '../../../scripts/lib/patch-engine.ts';
import { loadPatchTable } from '../../../scripts/lib/import-pipeline.ts';
import type { PatchSpec, PinnedFile, UiPatchTable } from '../../../scripts/lib/types.ts';

const patch = (over: Partial<PatchSpec>): PatchSpec => ({
  id: 'T1', file: 'a-*.js', find: 'x', replace: 'y', rationale: 'r', spec: 's', ...over,
});

function assertImportError(fn: () => unknown, code: string, re?: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ImportError, `expected ImportError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (re) assert.match(err.message, re);
    return true;
  });
}

test('applyPatch replaces an anchor that occurs exactly once', () => {
  const out = applyPatch('async function Sv(e,t){return 1}', patch({ find: 'async function Sv(e,t){', replace: 'async function Sv(e,t){throw 0;' }));
  assert.equal(out.text, 'async function Sv(e,t){throw 0;return 1}');
  assert.equal(out.count, 1);
});

test('applyPatch fails loudly when the anchor is missing or duplicated', () => {
  assertImportError(() => applyPatch('nothing here', patch({ id: 'P9', find: 'anchor' })), 'PATCH_COUNT', /P9 .*matched 0 time\(s\), expected exactly 1/);
  assertImportError(() => applyPatch('anchor anchor', patch({ find: 'anchor' })), 'PATCH_COUNT', /matched 2 time\(s\), expected exactly 1/);
  assertImportError(() => applyPatch('anchor', patch({ find: 'anchor', expectCount: 2 })), 'PATCH_COUNT', /matched 1 time\(s\), expected exactly 2/);
  assert.equal(applyPatch('anchor anchor', patch({ find: 'anchor', replace: 'B', expectCount: 2 })).text, 'B B');
});

test('replacements are literal: $-sequences are never expanded, also for RegExp anchors', () => {
  assert.equal(applyPatch('a${e}b', patch({ find: '${e}', replace: '$&$1$$' })).text, 'a$&$1$$b');
  const secret = 'const k={Key:"s3cr3t"}';
  const out = applyPatch(secret, patch({ find: /const k=\{Key:"[^"]*"\}/, replace: 'const k={Key:"$&"}' }));
  assert.equal(out.text, 'const k={Key:"$&"}');
});

test('countOccurrences counts non-overlapping matches and rejects empty anchors', () => {
  assert.equal(countOccurrences('aaaa', 'aa'), 2);
  assert.equal(countOccurrences('a1b2c3', /\d/), 3);
  assertImportError(() => countOccurrences('abc', ''), 'PATCH_EMPTY_FIND');
  assertImportError(() => countOccurrences('abc', /x*/), 'PATCH_EMPTY_MATCH');
});

test('globToRegExp: * never crosses a path separator', () => {
  const re = globToRegExp('assets/styles-*.js');
  assert.ok(re.test('assets/styles-DAnQi2A8.js'));
  assert.ok(!re.test('assets/styles-BB_VBJb3.css'));
  assert.ok(!re.test('assets/sub/styles-x.js'));
  assert.ok(globToRegExp('index.html').test('index.html'));
  assert.ok(!globToRegExp('index.html').test('indexxhtml'));
});

test('verifyPinnedFiles names the vendor build that was found instead of the pinned one', () => {
  const pin: PinnedFile = { glob: 'assets/styles-*.js', path: 'assets/styles-DAnQi2A8.js', sha256: sha256('pinned') };
  const other = new Map([['assets/styles-NEWHASH1.js', Buffer.from('x')]]);
  assertImportError(() => verifyPinnedFiles(other, [pin], '1.13.0'), 'PIN_MISSING', /expected assets\/styles-DAnQi2A8\.js .*found assets\/styles-NEWHASH1\.js/);
  assertImportError(() => verifyPinnedFiles(new Map(), [pin], '1.13.0'), 'PIN_MISSING', /no file matches assets\/styles-\*\.js/);
  const tampered = new Map([['assets/styles-DAnQi2A8.js', Buffer.from('tampered')]]);
  assertImportError(() => verifyPinnedFiles(tampered, [pin], '1.13.0'), 'PIN_HASH', /different or modified build/);
  verifyPinnedFiles(new Map([['assets/styles-DAnQi2A8.js', Buffer.from('pinned')]]), [pin], '1.13.0');
});

test('applyPatchTable chains patches per file and rejects unpinned targets', () => {
  const pinned: PinnedFile[] = [{ glob: 'a-*.js', path: 'a-1.js', sha256: sha256('one two') }];
  const files = new Map<string, Uint8Array>([['a-1.js', Buffer.from('one two')]]);
  const applied = applyPatchTable(files, {
    pinnedFiles: pinned,
    patches: [patch({ id: 'A', find: 'one', replace: 'ONE' }), patch({ id: 'B', find: 'ONE two', replace: '1 2' })],
  });
  assert.deepEqual(applied.map((a) => [a.id, a.file, a.count]), [['A', 'a-1.js', 1], ['B', 'a-1.js', 1]]);
  assert.equal(Buffer.from(files.get('a-1.js') ?? []).toString(), '1 2');
  assertImportError(() => applyPatchTable(files, { pinnedFiles: pinned, patches: [patch({ file: 'b-*.js' })] }), 'PATCH_UNPINNED');
});

test('decodeUtf8Strict refuses bytes that would not survive a text round trip', () => {
  assert.equal(decodeUtf8Strict('ok.js', Buffer.from('héllo')), 'héllo');
  assertImportError(() => decodeUtf8Strict('bad.js', Uint8Array.from([0x61, 0xff, 0x62])), 'NOT_UTF8');
});

test('the shipped patch table is structurally valid and covers every online touchpoint N01..N40', async () => {
  const table = await loadPatchTable();
  validatePatchTable(table);
  assert.equal(table.vendor.version, '1.13.0');
  const ids = table.touchpoints.map((t) => t.id);
  assert.deepEqual(ids, Array.from({ length: 40 }, (_, i) => `N${String(i + 1).padStart(2, '0')}`));
  // Vendor cloud secrets must only be matched by pattern, never committed as literal anchors.
  for (const p of table.patches.filter((x) => x.id.startsWith('SECRET-'))) assert.ok(p.find instanceof RegExp, p.id);
});

test('validatePatchTable rejects duplicate ids, unpinned targets, bad hashes, missing lists and vague reviewed entries', async () => {
  const good = await loadPatchTable();
  const clone = (): UiPatchTable => ({ ...good, patches: [...good.patches], pinnedFiles: [...good.pinnedFiles] });
  const dup = clone();
  dup.patches.push({ ...dup.patches[0]! });
  assertImportError(() => validatePatchTable(dup), 'TABLE_INVALID', /duplicate patch id/);
  const unpinned = clone();
  unpinned.patches.push(patch({ id: 'NEW', file: 'assets/nope-*.js' }));
  assertImportError(() => validatePatchTable(unpinned), 'TABLE_INVALID', /unpinned file/);
  const badHash = clone();
  badHash.pinnedFiles[0] = { ...badHash.pinnedFiles[0]!, sha256: 'abc' };
  assertImportError(() => validatePatchTable(badHash), 'TABLE_INVALID', /invalid sha256/);
  const noSchemes = { ...clone(), reviewedSchemes: undefined } as unknown as UiPatchTable;
  assertImportError(() => validatePatchTable(noSchemes), 'TABLE_INVALID', /reviewedSchemes must be an array/);
  const zeroCount = { ...clone(), reviewedSchemes: good.reviewedSchemes.map((s, i) => (i === 0 ? { ...s, count: 0 } : s)) };
  assertImportError(() => validatePatchTable(zeroCount), 'TABLE_INVALID', /count >= 1/);
  const noContext = { ...clone(), reviewedSites: good.reviewedSites.map((s, i) => (i === 0 ? { ...s, context: '' } : s)) };
  assertImportError(() => validatePatchTable(noContext), 'TABLE_INVALID', /needs a file glob, a context/);
});
