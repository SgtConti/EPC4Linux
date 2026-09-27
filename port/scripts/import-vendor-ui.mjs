#!/usr/bin/env node
// npm run import-ui — imports the vendor renderer from the user's own Evnia Precision Center
// installation into port/build/ (no vendor code is committed to this repository).
//
//   node scripts/import-vendor-ui.mjs [--asar <app.asar>] [--resources <dir>] [--out <dir>] [--quiet]
//
//   --asar       vendor archive (default: $EVNIA_VENDOR_ASAR, else ../Evnia Precision Center/resources/app.asar
//                relative to port/); relative paths resolve against the current directory
//   --resources  the install's resources/ directory holding bin/res/data (default: the asar's directory)
//   --out        parent directory for vendor-ui/, vendor-data/, vendor-assets/ (default: port/build)
//   --quiet      only print errors and warnings
//
// Exit status: 0 on success, 1 on any failure (one line "import-vendor-ui: <CODE>: <message>" on
// stderr), 2 on usage errors. Warnings (stderr, "warning: …") do not change the status.
// See docs/port/impl-vendor-ui.md and docs/re/02-renderer-shell.md §L.3.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatAuditTable } from './lib/audit.ts';
import { AuditFailedError, defaultPaths, loadPatchTable, runImport } from './lib/import-pipeline.ts';
import { ImportError } from './lib/patch-engine.ts';

const portDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let args;
try {
  args = parseArgs({
    options: {
      asar: { type: 'string' },
      resources: { type: 'string' },
      out: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }).values;
} catch (err) {
  console.error(`import-vendor-ui: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
if (args.help) {
  console.log('usage: node scripts/import-vendor-ui.mjs [--asar <app.asar>] [--resources <dir>] [--out <dir>] [--quiet]');
  process.exit(0);
}

const defaults = defaultPaths(portDir);
/** @type {(line: string) => void} */
const log = args.quiet ? () => {} : (line) => console.log(line);

try {
  const table = await loadPatchTable();
  const result = await runImport({
    asarPath: args.asar ? resolve(args.asar) : defaults.asarPath,
    resourcesDir: args.resources ? resolve(args.resources) : undefined,
    outDir: args.out ? resolve(args.out) : defaults.outDir,
    table,
    log,
    warn: (line) => console.error(line),
  });
  log('');
  log('Static audit (remote URLs, scheme literals and network API call sites left in the patched UI):');
  log(formatAuditTable(result.audit));
  log('');
  log('IPC channels referenced by the patched UI (several only from unreachable code; the preload allowlist ' +
    `decides which reach main): ${Object.keys(result.audit.ipcChannels).sort().join(', ')}`);
  log(`OK: ${result.manifest.patches.length} patches, ${result.manifest.removed.length} files removed, ` +
    `${result.manifest.copied.length} vendor data/asset files copied; manifest ${result.outputs.ui}/PATCHES.json`);
} catch (err) {
  if (err instanceof AuditFailedError) {
    console.error(formatAuditTable(err.report));
    console.error('');
  }
  if (err instanceof ImportError) {
    console.error(`import-vendor-ui: ${err.code}: ${err.message}`);
  } else {
    // Not an anticipated failure (those are ImportErrors): keep the stack for the bug report.
    console.error(`import-vendor-ui: INTERNAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
  process.exit(1);
}
