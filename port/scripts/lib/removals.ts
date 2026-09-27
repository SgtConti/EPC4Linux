// Dropping vendor sub-apps and assets from the imported UI (task item 1 "remove … if safe"; 02 §1.1).
//
// A removal is safe only if nothing that stays can still load the file. Vite references a lazily
// loaded chunk in two ways (02 §1.1):
//   - by name, in `import("./X.js")`, `new URL("./X.png", import.meta.url)`, CSS `url()`, HTML `src`;
//   - by index, through the per-chunk preload table
//       const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./A.js","./A.css",…])))=>i.map(i=>d[i]);
//     and calls such as `Qa(()=>import("./A.js"),__vite__mapDeps([30,31]),import.meta.url)`.
// So after the patches have removed the routes, (1) a removed file's basename may not occur in any
// kept JS/HTML/CSS file outside such a table, and (2) no remaining `__vite__mapDeps([…])` call may
// use the index of a removed file. A table whose shape is not recognized aborts the import, because
// the index check could not be done.

import { posix } from 'node:path';
import { isAuditedFile } from './audit.ts';
import { ImportError } from './patch-engine.ts';
import type { RemovalSpec } from './types.ts';

export interface RemovedFile {
  path: string;
  reason: string;
  spec: string;
  /** Inert `__vite__mapDeps` table entries left behind (equal to the spec's expectation). */
  mapDepsEntries: number;
}

const MAPDEPS = '__vite__mapDeps';
/** vite's preload-table helper, emitted verbatim (not minified) at the top of a chunk. */
const MAPDEPS_DEF_RE = /const __vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=(\[[^\]]*\])\)\)\)=>i\.map\(i=>d\[i\]\);/g;
/** A preload call with a literal index list, the only call form vite emits. */
const MAPDEPS_CALL_RE = /__vite__mapDeps\(\[(\d+(?:,\d+)*)?\]\)/g;

interface MapDepsTable {
  /** Renderer-relative path of each table entry, by index. */
  entries: string[];
  /** Every index used by a `__vite__mapDeps([…])` call of the chunk. */
  usedIndices: Set<number>;
  /** The chunk text with the table literal blanked, for the by-name reference check. */
  textWithoutTable: string;
}

function unverifiable(path: string, what: string): never {
  throw new ImportError(
    'REMOVAL_UNVERIFIABLE',
    `${path}: ${what}; cannot prove that removed files are no longer preloaded (different vite output?)`,
  );
}

/** Parses the `__vite__mapDeps` table and preload calls of one chunk, or returns null if it has none. */
export function parseMapDeps(path: string, text: string, knownFiles: ReadonlySet<string>): MapDepsTable | null {
  if (!text.includes(MAPDEPS)) return null;
  const defs = [...text.matchAll(MAPDEPS_DEF_RE)];
  if (defs.length !== 1) unverifiable(path, `found ${defs.length} ${MAPDEPS} table definitions, expected exactly 1`);
  const def = defs[0];
  const tableText = def[1];
  let raw: unknown;
  try {
    raw = JSON.parse(tableText);
  } catch {
    unverifiable(path, `the ${MAPDEPS} file table is not a plain string array`);
  }
  if (!Array.isArray(raw) || !raw.every((e): e is string => typeof e === 'string')) {
    unverifiable(path, `the ${MAPDEPS} file table is not a plain string array`);
  }
  // Entries are relative to the chunk (vite `base: './'`). Every one must name a file of the vendor
  // UI, which proves the resolution is right and so the index check cannot silently miss a file.
  const entries = raw.map((e) => posix.normalize(posix.join(posix.dirname(path), e)));
  const stray = entries.find((e) => !knownFiles.has(e));
  if (stray !== undefined) unverifiable(path, `${MAPDEPS} entry ${stray} is not a file of the vendor UI`);

  const calls = [...text.matchAll(MAPDEPS_CALL_RE)];
  // Identifier uses: the definition's own name and default parameter, plus one per literal call.
  // Anything else (an alias, a computed index list) cannot be checked.
  const uses = text.split(MAPDEPS).length - 1;
  if (uses !== 2 + calls.length) unverifiable(path, `${MAPDEPS} is used ${uses - 2 - calls.length} time(s) other than as a literal preload call`);
  const usedIndices = new Set<number>();
  for (const c of calls) for (const n of (c[1] ?? '').split(',').filter(Boolean)) usedIndices.add(Number(n));
  for (const i of usedIndices) if (i >= entries.length) unverifiable(path, `${MAPDEPS} call uses index ${i} beyond the table`);

  const start = def.index + def[0].indexOf(tableText);
  const textWithoutTable = `${text.slice(0, start)}[]${text.slice(start + tableText.length)}`;
  return { entries, usedIndices, textWithoutTable };
}

/**
 * Deletes the files listed in `removals` from `files` (renderer-relative path → content) and proves
 * that no kept JS/HTML/CSS file can still load one of them. Throws `REMOVAL_MISSING` for a target that
 * does not exist, `REMOVAL_REFERENCED` for a live reference, `REMOVAL_UNVERIFIABLE` for an unknown
 * preload-table shape and `REMOVAL_MAPDEPS` when the inert table entries differ from `mapDepsEntries`.
 */
export function removeFiles(files: Map<string, Uint8Array>, removals: readonly RemovalSpec[]): RemovedFile[] {
  const allFiles = new Set(files.keys());
  for (const r of removals) {
    if (!files.delete(r.path)) {
      throw new ImportError('REMOVAL_MISSING', `Removal target ${r.path} does not exist in the vendor UI (different vendor build?)`);
    }
  }
  const removedPaths = new Set(removals.map((r) => r.path));
  const tableEntries = new Map<string, number>(removals.map((r) => [r.path, 0]));

  for (const [path, data] of files) {
    if (!isAuditedFile(path)) continue;
    let text = Buffer.from(data).toString('utf8');
    const table = parseMapDeps(path, text, allFiles);
    if (table) {
      table.entries.forEach((entry, index) => {
        if (!removedPaths.has(entry)) return;
        tableEntries.set(entry, (tableEntries.get(entry) ?? 0) + 1);
        if (table.usedIndices.has(index)) {
          throw new ImportError(
            'REMOVAL_REFERENCED',
            `Removed ${entry} is still preloaded by a ${MAPDEPS}([…]) call using index ${index} in ${path}; removing it would break a reachable page`,
          );
        }
      });
      text = table.textWithoutTable;
    }
    for (const r of removals) {
      const name = posix.basename(r.path);
      const at = text.indexOf(name);
      if (at !== -1) {
        const near = text.slice(Math.max(0, at - 60), at + name.length + 20);
        throw new ImportError(
          'REMOVAL_REFERENCED',
          `Removed ${r.path} is still referenced by ${path}: …${near}…; removing it could break a reachable page`,
        );
      }
    }
  }

  return removals.map((r) => {
    const found = tableEntries.get(r.path) ?? 0;
    if (found !== r.mapDepsEntries) {
      throw new ImportError(
        'REMOVAL_MAPDEPS',
        `Removed ${r.path} is named by ${found} inert ${MAPDEPS} table entr${found === 1 ? 'y' : 'ies'}, expected ${r.mapDepsEntries}; update mapDepsEntries in scripts/ui-patches.mjs after reviewing the preload calls`,
      );
    }
    return { path: r.path, reason: r.reason, spec: r.spec, mapDepsEntries: found };
  });
}
