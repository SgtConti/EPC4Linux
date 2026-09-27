#!/usr/bin/env node
// npm run build — bundle the Electron app into build/app (ARCHITECTURE "Build and test pipeline" 2).
//
//   node scripts/build.mjs [--out <dir>] [--vendor-ui <dir>] [--vendor-data <dir>] [--vendor-assets <dir>]
//
// build/app/
//   main.cjs                 Electron main + the in-process backend (src/main, src/backend)
//   preload.cjs              main/notice window preload (src/preload), sandbox-compatible
//   capture-preload.cjs      hidden capture window preload (src/capture/preload.ts)
//   capture/capture.{html,js} hidden capture page (src/capture)
//   vendor-ui/               copy of build/vendor-ui (npm run import-ui)
//   resources/               build/vendor-data + build/vendor-assets (MonitorInfo.json, ENE/, icons)
//   package.json             {name, productName, version, main, desktopName}
// usb, koffi and ws stay external: in a checkout Electron resolves them from port/node_modules, and
// scripts/package-deb.mjs installs them (with their native binaries unpacked) into the package.

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const portDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runtime packages loaded by the main process from node_modules (native addons or optional natives). */
const RUNTIME_EXTERNALS = ['usb', 'koffi', 'ws'];

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    'vendor-ui': { type: 'string' },
    'vendor-data': { type: 'string' },
    'vendor-assets': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});
if (args.help) {
  console.log('usage: node scripts/build.mjs [--out <dir>] [--vendor-ui <dir>] [--vendor-data <dir>] [--vendor-assets <dir>]');
  process.exit(0);
}

const out = resolve(portDir, args.out ?? 'build/app');
const vendorUi = resolve(portDir, args['vendor-ui'] ?? 'build/vendor-ui');
const vendorData = resolve(portDir, args['vendor-data'] ?? 'build/vendor-data');
const vendorAssets = resolve(portDir, args['vendor-assets'] ?? 'build/vendor-assets');
const src = (p) => join(portDir, 'src', p);
const show = (p) => relative(portDir, p) || '.';

const common = {
  bundle: true,
  sourcemap: 'linked',
  sourcesContent: false,
  legalComments: 'eof',
  logLevel: 'warning',
  absWorkingDir: portDir,
};

const nodeBundle = { ...common, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', ...RUNTIME_EXTERNALS] };
// Sandboxed preloads may only require('electron'); a Node builtin import fails the build here.
const preloadBundle = { ...common, platform: 'browser', format: 'cjs', target: 'chrome130', external: ['electron'] };

async function main() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await Promise.all([
    build({ ...nodeBundle, entryPoints: [src('main/index.ts')], outfile: join(out, 'main.cjs') }),
    build({ ...preloadBundle, entryPoints: [src('preload/index.ts')], outfile: join(out, 'preload.cjs') }),
    build({ ...preloadBundle, entryPoints: [src('capture/preload.ts')], outfile: join(out, 'capture-preload.cjs') }),
    build({ ...common, platform: 'browser', format: 'iife', target: 'chrome130', entryPoints: [src('capture/page.ts')], outfile: join(out, 'capture', 'capture.js') }),
  ]);
  await cp(src('capture/capture.html'), join(out, 'capture', 'capture.html'));

  const warnings = [];
  if (existsSync(join(vendorUi, 'index.html'))) {
    await cp(vendorUi, join(out, 'vendor-ui'), { recursive: true });
  } else {
    warnings.push(`${show(vendorUi)}/index.html not found: the app will show an error page. Run "npm run import-ui" first.`);
  }
  for (const dir of [vendorData, vendorAssets]) {
    if (existsSync(dir)) await cp(dir, join(out, 'resources'), { recursive: true });
    else warnings.push(`${show(dir)} not found: resources/ will lack its files (MonitorInfo.json, icons). Run "npm run import-ui" first.`);
  }

  const pkg = JSON.parse(await readFile(join(portDir, 'package.json'), 'utf8'));
  const appPkg = {
    name: 'evnia-precision-center',
    productName: 'Evnia Precision Center',
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    private: true,
    main: 'main.cjs',
    // Wayland app_id / .desktop association (packaging/deb/evnia-precision-center.desktop).
    desktopName: 'evnia-precision-center.desktop',
  };
  await writeFile(join(out, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`);

  console.log(`build: wrote ${show(out)} (main.cjs, preload.cjs, capture-preload.cjs, capture/, package.json)`);
  for (const w of warnings) console.warn(`build: warning: ${w}`);
}

main().catch((e) => {
  console.error(`build: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
