import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImportError } from '../../../scripts/lib/patch-engine.ts';
import { removeFiles } from '../../../scripts/lib/removals.ts';
import type { RemovalSpec } from '../../../scripts/lib/types.ts';

// A chunk shaped like vite's output (02 §1.1): the preload table, then routes that preload by index.
const table = (entries: string[]) =>
  `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=${JSON.stringify(entries)})))=>i.map(i=>d[i]);`;
const route = (chunk: string, deps: number[]) => `()=>Qa(()=>import("./${chunk}"),__vite__mapDeps([${deps.join(',')}]),import.meta.url)`;
const ENTRIES = ['./Kept-1.js', './Kept-1.css', './Gone-2.js', './Gone-2.css'];

function tree(chunk: string, extra: Record<string, string> = {}): Map<string, Uint8Array> {
  const files: Record<string, string> = {
    'index.html': '<script type="module" src="./assets/app-0.js"></script>',
    'assets/app-0.js': chunk,
    'assets/Kept-1.js': 'export{}',
    'assets/Kept-1.css': '.k{}',
    'assets/Gone-2.js': 'export{}',
    'assets/Gone-2.css': '.g{}',
    'assets/gone.png': 'png',
    ...extra,
  };
  return new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
}

const removals = (over: Partial<Record<string, number>> = {}): RemovalSpec[] => [
  { path: 'assets/Gone-2.js', reason: 'r', spec: 's', mapDepsEntries: over['assets/Gone-2.js'] ?? 1 },
  { path: 'assets/Gone-2.css', reason: 'r', spec: 's', mapDepsEntries: over['assets/Gone-2.css'] ?? 1 },
  { path: 'assets/gone.png', reason: 'r', spec: 's', mapDepsEntries: 0 },
];

function assertImportError(fn: () => unknown, code: string, re: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ImportError, `expected ImportError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.match(err.message, re);
    return true;
  });
}

test('a removed chunk may stay in the preload table while no preload call uses its index', () => {
  const files = tree(`${table(ENTRIES)}const routes=[${route('Kept-1.js', [0, 1])}];`);
  const removed = removeFiles(files, removals());
  assert.deepEqual(removed.map((r) => [r.path, r.mapDepsEntries]), [['assets/Gone-2.js', 1], ['assets/Gone-2.css', 1], ['assets/gone.png', 0]]);
  assert.deepEqual([...files.keys()].sort(), ['assets/Kept-1.css', 'assets/Kept-1.js', 'assets/app-0.js', 'index.html']);
});

test('a kept route that preloads a removed file by index fails, although its name occurs only in the table', () => {
  // The route loads Kept-1.js but preloads index 2 (Gone-2.js): the basename count alone would pass.
  const files = tree(`${table(ENTRIES)}const routes=[${route('Kept-1.js', [0, 2])}];`);
  assertImportError(() => removeFiles(files, removals()), 'REMOVAL_REFERENCED', /assets\/Gone-2\.js is still preloaded by a __vite__mapDeps\(\[…\]\) call using index 2 in assets\/app-0\.js/);
});

test('any reference by name outside the preload table fails: import(), CSS url(), HTML src', () => {
  const withImport = tree(`${table(ENTRIES)}const routes=[${route('Gone-2.js', [])}];`);
  assertImportError(() => removeFiles(withImport, removals()), 'REMOVAL_REFERENCED', /assets\/Gone-2\.js is still referenced by assets\/app-0\.js: .*import\("\.\/Gone-2\.js"\)/);
  const withCss = tree(table(ENTRIES), { 'assets/Kept-1.css': '.k{background:url(./gone.png)}' });
  assertImportError(() => removeFiles(withCss, removals()), 'REMOVAL_REFERENCED', /assets\/gone\.png is still referenced by assets\/Kept-1\.css/);
  const withHtml = tree(table(ENTRIES), { 'index.html': '<img src="./assets/gone.png">' });
  assertImportError(() => removeFiles(withHtml, removals()), 'REMOVAL_REFERENCED', /assets\/gone\.png is still referenced by index\.html/);
});

test('preload tables that cannot be checked abort the import', () => {
  const alias = tree(`${table(ENTRIES)}const f=__vite__mapDeps;f([2]);`);
  assertImportError(() => removeFiles(alias, removals()), 'REMOVAL_UNVERIFIABLE', /used 1 time\(s\) other than as a literal preload call/);
  const computed = tree(`${table(ENTRIES)}__vite__mapDeps(deps);`);
  assertImportError(() => removeFiles(computed, removals()), 'REMOVAL_UNVERIFIABLE', /other than as a literal preload call/);
  const reshaped = tree('const __vite__mapDeps=(i,d=["./Gone-2.js"])=>i.map(i=>d[i]);__vite__mapDeps([0]);');
  assertImportError(() => removeFiles(reshaped, removals()), 'REMOVAL_UNVERIFIABLE', /found 0 __vite__mapDeps table definitions/);
  const unresolved = tree(table(['./Kept-1.js', '../Gone-2.js']));
  assertImportError(() => removeFiles(unresolved, removals()), 'REMOVAL_UNVERIFIABLE', /entry Gone-2\.js is not a file of the vendor UI/);
  const outOfRange = tree(`${table(ENTRIES)}${route('Kept-1.js', [7])}`);
  assertImportError(() => removeFiles(outOfRange, removals()), 'REMOVAL_UNVERIFIABLE', /index 7 beyond the table/);
});

test('the number of inert table entries must match the reviewed mapDepsEntries exactly', () => {
  const files = tree(table(ENTRIES));
  assertImportError(
    () => removeFiles(files, removals({ 'assets/Gone-2.css': 0 })),
    'REMOVAL_MAPDEPS',
    /assets\/Gone-2\.css is named by 1 inert __vite__mapDeps table entry, expected 0/,
  );
});

test('a removal target that does not exist fails (different vendor build)', () => {
  assertImportError(
    () => removeFiles(tree(table(ENTRIES)), [...removals(), { path: 'assets/Other-9.js', reason: 'r', spec: 's', mapDepsEntries: 0 }]),
    'REMOVAL_MISSING',
    /assets\/Other-9\.js does not exist/,
  );
});
