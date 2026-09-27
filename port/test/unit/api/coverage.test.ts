// The union of all api/ modules must register every Bridge overload exactly once (catalog.ts), and so must
// the production composition (compose.ts API_MODULES, re-exported by index.ts: what Electron main's
// createBackend(options) registers).
//
// Module files are imported dynamically (helpers.ts API_MODULE_FILES). While an owner's files do not exist
// and its overloads are not all registered, the coverage test of that owner and the whole-surface test are
// marked `todo`: they still run and report what is missing, without failing the suite. Everything else is
// strict: no duplicates, nothing outside the catalog, every registration made by the module family that owns
// it, no api/ file outside the known layout (such a file would never be imported by these tests), and the
// production composition registering all 162 overloads exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_MODULES, createBackend, createDefaultBackend, defaultComposition } from '../../../src/backend/index.ts';
import { API_OWNERS, auditBackend, auditRegistrations, findOverload, formatAudit, overloadKey, overloadsOwnedBy } from '../../../src/backend/api/catalog.ts';
import { AmbiglowServiceImpl } from '../../../src/backend/ambiglow/service.ts';
import { MonitorManagerImpl } from '../../../src/backend/monitor/manager.ts';
import { ThemeStoreImpl } from '../../../src/backend/theme/store.ts';
import type { ApiOwner } from '../../../src/backend/api/catalog.ts';
import type { RpcArgType } from '../../../src/backend/types.ts';
import { captureLogger } from '../rpc/helpers.ts';
import { API_MODULE_FILES, NON_MODULE_FILES, loadApiModules, recordRegistrations, testHost, unlistedApiFiles, type LoadedApiFile } from './helpers.ts';

const loaded: LoadedApiFile[] = await loadApiModules();

interface Recorded {
  file: string;
  owner: ApiOwner | null;
  name: string;
  signature: readonly RpcArgType[];
}

const registrationErrors: string[] = [];
const recorded: Recorded[] = [];
for (const f of loaded) {
  for (const { exportName, module } of f.modules) {
    // Registration only: services are inert stand-ins, so a module that subscribes at registration time
    // still registers.
    const { registry, errors } = recordRegistrations([module]);
    for (const e of errors) registrationErrors.push(`${f.file} ${exportName}: ${e instanceof Error ? e.message : String(e)}`);
    for (const r of registry.registrations) recorded.push({ file: f.file, owner: f.owner, name: r.name, signature: r.signature });
  }
}

const missingFilesOf = (owner: ApiOwner) => loaded.filter((f) => f.owner === owner && f.status === 'missing').map((f) => `api/${f.file}`);
const allMissing = loaded.filter((f) => f.status === 'missing').map((f) => `api/${f.file}`);

test('every existing api/ module file loads and exports at least one ApiModule', () => {
  const problems = loaded.flatMap((f) => {
    if (f.status === 'error') return [`api/${f.file} failed to import: ${f.error instanceof Error ? f.error.message : String(f.error)}`];
    if (f.status === 'ok' && f.modules.length === 0) return [`api/${f.file} exports no ApiModule (expected an exported function named <family>Api)`];
    return [];
  });
  assert.deepEqual([...problems, ...registrationErrors], []);
  assert.ok(loaded.find((f) => f.file === 'system.ts')?.status === 'ok');
  assert.ok(loaded.find((f) => f.file === 'stubs.ts')?.status === 'ok');
});

test('every file in src/backend/api/ is a known module file (helpers.ts API_MODULE_FILES) or catalog.ts', () => {
  assert.deepEqual(
    unlistedApiFiles(),
    [],
    `add these files with their catalog owner to API_MODULE_FILES in test/unit/api/helpers.ts; the coverage tests do not import them otherwise (known: ${[
      ...API_MODULE_FILES.map((f) => f.file),
      ...NON_MODULE_FILES,
    ].join(', ')})`,
  );
});

test('no module registers anything outside the Bridge catalog, and nothing is registered twice', () => {
  const audit = auditRegistrations(recorded);
  assert.deepEqual(audit.extra, [], formatAudit(audit));
  assert.deepEqual(
    audit.duplicates.map((d) => {
      const key = overloadKey(d.overload.name, d.overload.signature);
      return `${key} ×${d.count} (${recorded.filter((r) => overloadKey(r.name, r.signature) === key).map((r) => r.file).join(', ')})`;
    }),
    [],
  );
});

test('every registration is made by the module family that owns it', () => {
  const misplaced = recorded.flatMap((r) => {
    const b = findOverload(r.name, r.signature);
    return b && r.owner !== null && b.owner !== r.owner ? [`api/${r.file} registers ${overloadKey(r.name, r.signature)}, owned by ${b.owner}`] : [];
  });
  assert.deepEqual(misplaced, []);
});

for (const owner of API_OWNERS) {
  const missingFiles = missingFilesOf(owner);
  const audit = auditRegistrations(recorded.filter((r) => r.owner === owner), { owners: [owner] });
  test(
    `every ${owner} overload is registered exactly once (${overloadsOwnedBy(owner).length})`,
    // todo only while files are missing AND the overloads are incomplete: a complete owner is checked strictly.
    { todo: missingFiles.length > 0 && !audit.ok ? `waiting for ${missingFiles.join(', ')}` : false },
    () => {
      assert.equal(audit.ok, true, formatAudit(audit));
    },
  );
}

const unionAudit = auditRegistrations(recorded);

test(
  'the union of all api/ modules registers all 162 Bridge overloads exactly once',
  { todo: allMissing.length > 0 && !unionAudit.ok ? `waiting for ${allMissing.join(', ')}` : false },
  () => {
    assert.equal(unionAudit.ok, true, formatAudit(unionAudit));
    assert.equal(recorded.length, 162);
  },
);

test('the production composition (index.ts API_MODULES) registers all 162 Bridge overloads exactly once', async () => {
  // 1. The module list itself: missing, extra, duplicated registrations (a duplicate makes the real
  //    RpcDispatcher throw "already registered" inside createBackend).
  const { registry, errors } = recordRegistrations(API_MODULES);
  assert.deepEqual(errors.map((e) => (e instanceof Error ? e.message : String(e))), [], 'API_MODULES registration errors');
  const listed = registry.audit();
  assert.equal(listed.ok, true, `index.ts API_MODULES:\n${formatAudit(listed)}`);
  assert.equal(registry.registrations.length, 162);
  // 2. The live backend Electron main creates (createBackend(options) without a composition: the real
  //    services and the default modules), probed through its request path without running any handler.
  //    No service is started, so nothing touches the (nonexistent) data directories.
  for (const [what, backend] of [
    ['createBackend(options)', createBackend({ host: testHost(captureLogger('backend').log), noHardware: true })],
    ['createBackend(options, defaultComposition())', createBackend({ host: testHost(captureLogger('backend').log), noHardware: true }, defaultComposition())],
    ['createDefaultBackend(options)', createDefaultBackend({ host: testHost(captureLogger('backend').log), noHardware: true })],
  ] as const) {
    const live = await auditBackend(backend);
    assert.equal(live.ok, true, `${what}:\n${formatAudit(live)}`);
  }
});

test('API_MODULES is exactly the exported module of every api/ module file, in family order', () => {
  const fromFiles = loaded.flatMap((f) => f.modules.map((m) => m.module));
  assert.equal(API_MODULES.length, fromFiles.length);
  assert.deepEqual(new Set(API_MODULES), new Set(fromFiles), 'every api/ module and nothing else');
  // Family order of the catalog owners (system, stubs, monitor, theme, ambiglow): only matters for the log.
  const ownerOf = (m: unknown) => loaded.find((f) => f.modules.some((x) => x.module === m))?.owner;
  assert.deepEqual([...new Set(API_MODULES.map(ownerOf))], ['system', 'stubs', 'monitor', 'theme', 'ambiglow']);
  assert.ok(Object.isFrozen(API_MODULES));
});

test('the production composition builds the concrete services (the wiring runs in test/contract)', () => {
  const { log, lines } = captureLogger('backend');
  const backend = createDefaultBackend({ host: testHost(log), mockMonitor: '34M2C8600/no-ene', noHardware: true });
  const { themes, monitors, ambiglow } = backend.services;
  assert.ok(themes instanceof ThemeStoreImpl);
  assert.ok(monitors instanceof MonitorManagerImpl);
  assert.ok(ambiglow instanceof AmbiglowServiceImpl);
  assert.ok(lines.some((l) => l.text === 'backend composition: simulated monitor "34M2C8600/no-ene" (EVNIA_MOCK_MONITOR)'));
  assert.equal(ambiglow.display, null, 'nothing is attached before the first scan');
});
