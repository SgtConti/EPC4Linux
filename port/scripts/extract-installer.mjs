#!/usr/bin/env node
// Extracts what the build needs from the vendor's Windows installer with 7-Zip, so the port can be built
// without Windows. The installer is only read (never executed); the result is verified against the pins of
// scripts/ui-patches.mjs before it replaces the output directory. See scripts/extract-installer.ts.
//
//   node scripts/extract-installer.mjs --installer <"evnia Setup 1.13.0.exe"> [--out <dir>] [--full] [--force]
//                                      [--7z <path>] [--quiet]
//
//   --installer  the vendor installer (default: $EVNIA_VENDOR_INSTALLER)
//   --out        target directory (default: ../Evnia Precision Center relative to port/, where npm run import-ui
//                looks); relative paths resolve against the current directory
//   --full       extract the complete installation (Electron runtime, .NET service, DLLs; about 0.4 GB), e.g. for
//                the tools in tools/. Default: only resources/app.asar and resources/bin/res/data/
//   --force      replace an existing --out directory (only one that is empty or holds an Evnia installation)
//   --7z         7-Zip executable (default: $EVNIA_7Z, else the first of 7zz, 7z, 7za on PATH that reads NSIS)
//   --quiet      only print errors and warnings
//
// Running it again with the same installer is a verified no-op. Exit status: 0 on success, 1 on any failure
// (one line "extract-installer: <CODE>: <message>" on stderr), 2 on usage errors, 130 when interrupted.
// Warnings (stderr, "warning: …") do not change the status.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const portDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOut = resolve(portDir, '..', 'Evnia Precision Center');
const usage =
  'usage: node scripts/extract-installer.mjs --installer <"evnia Setup 1.13.0.exe"> [--out <dir>] [--full] [--force] [--7z <path>] [--quiet]';

let args;
try {
  args = parseArgs({
    options: {
      installer: { type: 'string' },
      out: { type: 'string' },
      full: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      '7z': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }).values;
} catch (err) {
  console.error(`extract-installer: ${err instanceof Error ? err.message : String(err)}`);
  console.error(usage);
  process.exit(2);
}
if (args.help) {
  console.log(usage);
  process.exit(0);
}
const installer = args.installer || process.env.EVNIA_VENDOR_INSTALLER;
if (!installer) {
  console.error('extract-installer: --installer <path to the vendor installer> is required (or set EVNIA_VENDOR_INSTALLER)');
  console.error(usage);
  process.exit(2);
}

// Loaded here so that a missing `npm ci` (@electron/asar) is one clear line, not a stack trace.
let lib;
let pipeline;
let ImportError;
try {
  lib = await import('./extract-installer.ts');
  pipeline = await import('./lib/import-pipeline.ts');
  ({ ImportError } = await import('./lib/patch-engine.ts'));
} catch (err) {
  console.error(`extract-installer: SETUP: cannot load the build scripts (${err instanceof Error ? err.message : String(err)}). ` +
    'Run `npm ci` in port/ first, with Node >= 22.18.');
  process.exit(1);
}

const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => controller.abort(sig));

/** @type {(line: string) => void} */
const log = args.quiet ? () => {} : (line) => console.log(line);
const outDir = args.out ? resolve(args.out) : defaultOut;

try {
  const table = await pipeline.loadPatchTable();
  const result = await lib.runExtract({
    installer,
    outDir,
    table,
    sevenZip: args['7z'],
    full: args.full,
    force: args.force,
    signal: controller.signal,
    log,
    warn: (line) => console.error(line),
  });
  const importCmd = outDir === defaultOut
    ? 'npm run import-ui'
    : `npm run import-ui -- --asar "${join(outDir, 'resources', 'app.asar')}"`;
  log(`OK: ${table.vendor.product} ${table.vendor.version} ${result.status === 'up-to-date' ? 'already in' : 'extracted to'} ` +
    `${outDir}${result.fileCount ? ` (${result.fileCount} files)` : ''}. Next: ${importCmd}`);
} catch (err) {
  if (controller.signal.aborted) {
    console.error(`extract-installer: interrupted (${controller.signal.reason}); ${outDir} was not changed`);
    process.exit(130);
  }
  if (err instanceof ImportError) {
    console.error(`extract-installer: ${err.code}: ${err.message}`);
  } else {
    // Not an anticipated failure (those are ImportErrors): keep the stack for the bug report.
    console.error(`extract-installer: INTERNAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
  process.exit(1);
}
