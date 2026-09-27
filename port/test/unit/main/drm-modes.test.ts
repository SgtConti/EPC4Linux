// §3.5 source c (src/main/drm-modes.ts): connector names, the sysfs pre-filter, the koffi binding of the
// xf86drmMode.h structures. The binding is exercised against the system libdrm.so.2 (symbols, a NULL
// result) and, when a C compiler is available, end to end against a stand-in libdrm compiled from the
// header's structure definitions, so the koffi layout is checked against what a C compiler lays out.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import { formatMode } from '../../../src/main/display-mode.ts';
import {
  createDrmSource,
  type DrmApi,
  drmConnectorName,
  drmSnapshot,
  drmTypes,
  loadDrmApi,
  readDrmSnapshots,
} from '../../../src/main/drm-modes.ts';

const log = createLogger('test', silentSink);
const koffi = createRequire(import.meta.url)('koffi') as Parameters<typeof drmTypes>[0];
const dir = mkdtempSync(join(tmpdir(), 'evnia-drm-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('connector names are the kernel\'s (<type name>-<type id>)', () => {
  assert.equal(drmConnectorName(10, 2), 'DP-2');
  assert.equal(drmConnectorName(11, 1), 'HDMI-A-1');
  assert.equal(drmConnectorName(14, 1), 'eDP-1');
  assert.equal(drmConnectorName(3, 1), 'DVI-D-1');
  assert.equal(drmConnectorName(20, 1), 'USB-1');
  assert.equal(drmConnectorName(99, 1), 'Unknown-1');
  const mode = { clock: 74_250, hdisplay: 1920, htotal: 2200, vdisplay: 1080, vtotal: 1125, vscan: 0, flags: 0x10 };
  const s = drmSnapshot('card0', { name: 'HDMI-A-1', connected: true, mode });
  assert.deepEqual([s.connector, s.mode, s.rotation], ['card0-HDMI-A-1', { width: 1920, height: 1080, exactHz: 60 }, 0]);
  assert.equal(drmSnapshot('card0', { name: 'x', connected: true, mode: { ...mode, flags: 0x20 } }).mode?.exactHz, 15, 'double scan');
  assert.equal(drmSnapshot('card0', { name: 'x', connected: true, mode: null }).mode, null);
});

test('xf86drmMode.h layouts (x86-64): koffi sizes and offsets', () => {
  const t = drmTypes(koffi);
  assert.equal(koffi.sizeof(t.ModeInfo), 68);
  assert.equal(koffi.offsetof(t.ModeInfo, 'vrefresh'), 24);
  assert.equal(koffi.offsetof(t.ModeInfo, 'name'), 36);
  assert.equal(koffi.sizeof(t.Res), 80);
  assert.equal(koffi.offsetof(t.Res, 'connectors'), 40);
  assert.equal(koffi.sizeof(t.Connector), 88);
  assert.equal(koffi.offsetof(t.Connector, 'connection'), 16);
  assert.equal(koffi.offsetof(t.Connector, 'modes'), 40);
  assert.equal(koffi.offsetof(t.Connector, 'encoders'), 80);
  assert.equal(koffi.sizeof(t.Encoder), 20);
  assert.equal(koffi.sizeof(t.Crtc), 100);
  assert.equal(koffi.offsetof(t.Crtc, 'mode'), 28);
  assert.equal(koffi.offsetof(t.Crtc, 'gamma_size'), 96);
});

/** A fake sysfs (/sys/class/drm) and device directory: card1 drives DP-2 (connected) and HDMI-A-1 (not). */
function fakeTree(): { sysfsRoot: string; devRoot: string } {
  const root = mkdtempSync(join(dir, 'tree-'));
  const sysfsRoot = join(root, 'sys');
  const devRoot = join(root, 'dev');
  const conn = (name: string, status: string) => {
    mkdirSync(join(sysfsRoot, name), { recursive: true });
    writeFileSync(join(sysfsRoot, name, 'status'), `${status}\n`);
  };
  conn('card1-DP-2', 'connected');
  conn('card1-HDMI-A-1', 'disconnected');
  conn('card2-DP-1', 'disconnected');
  mkdirSync(join(sysfsRoot, 'card1'), { recursive: true });
  mkdirSync(join(sysfsRoot, 'renderD128'), { recursive: true });
  mkdirSync(devRoot, { recursive: true });
  writeFileSync(join(devRoot, 'card1'), '');
  writeFileSync(join(devRoot, 'card2'), '');
  return { sysfsRoot, devRoot };
}

test('readDrmSnapshots opens only cards with a connected connector and keeps connected connectors', async () => {
  const tree = fakeTree();
  const fds: number[] = [];
  const api: DrmApi = {
    readConnectors(fd) {
      fds.push(fd);
      return [
        { name: 'DP-2', connected: true, mode: { clock: 319_750, hdisplay: 3440, htotal: 3600, vdisplay: 1440, vtotal: 1481, vscan: 0, flags: 5 } },
        { name: 'HDMI-A-1', connected: false, mode: null },
        { name: 'DP-3', connected: true, mode: null },
      ];
    },
  };
  const snaps = await readDrmSnapshots(api, { log, ...tree });
  assert.equal(fds.length, 1, 'card2 has nothing connected and is never opened');
  assert.deepEqual(
    snaps?.map((s) => [s.connector, s.mode && formatMode(s.mode, s.rotation)]),
    [
      ['card1-DP-2', { resolution: '3440x1440', frequency: '59Hz', orientation: '0°' }],
      ['card1-DP-3', null],
    ],
  );
  assert.equal(await readDrmSnapshots(api, { log, sysfsRoot: join(dir, 'missing'), devRoot: tree.devRoot }), null, 'no sysfs');
  rmSync(join(tree.devRoot, 'card1'));
  assert.equal(await readDrmSnapshots(api, { log, ...tree }), null, 'no readable card');
  const throwing: DrmApi = { readConnectors: () => { throw new Error('boom'); } };
  writeFileSync(join(tree.devRoot, 'card1'), '');
  assert.equal(await readDrmSnapshots(throwing, { log, ...tree }), null);
});

const SYSTEM_LIBDRM = ['/usr/lib/x86_64-linux-gnu/libdrm.so.2', '/usr/lib64/libdrm.so.2', '/usr/lib/libdrm.so.2'].find((p) => existsSync(p));

test('the system libdrm binds every function; an invalid descriptor reads as no connectors', { skip: SYSTEM_LIBDRM ? false : 'no libdrm.so.2' }, async () => {
  const api = await loadDrmApi();
  assert.deepEqual(api.readConnectors(-1), []);
  const source = createDrmSource(log, { library: '/nonexistent/libdrm.so.2' });
  assert.equal(await source(), null, 'an unloadable library disables the source');
});

// A stand-in libdrm: the xf86drmMode.h structures and the eight functions, one card with DP-2 driving a
// 3440x1440 CRTC (the EDID's 59.97 Hz DTD1), a disconnected HDMI-A-1 and a connected DP-3 without encoder.
const FAKE_LIBDRM_C = String.raw`
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
typedef struct _drmModeModeInfo { uint32_t clock; uint16_t hdisplay, hsync_start, hsync_end, htotal, hskew;
  uint16_t vdisplay, vsync_start, vsync_end, vtotal, vscan; uint32_t vrefresh; uint32_t flags; uint32_t type; char name[32]; } drmModeModeInfo;
typedef struct _drmModeRes { int count_fbs; uint32_t *fbs; int count_crtcs; uint32_t *crtcs; int count_connectors; uint32_t *connectors;
  int count_encoders; uint32_t *encoders; uint32_t min_width, max_width; uint32_t min_height, max_height; } drmModeRes;
typedef enum { DRM_MODE_CONNECTED = 1, DRM_MODE_DISCONNECTED = 2, DRM_MODE_UNKNOWNCONNECTION = 3 } drmModeConnection;
typedef enum { DRM_MODE_SUBPIXEL_UNKNOWN = 1 } drmModeSubPixel;
typedef struct _drmModeConnector { uint32_t connector_id; uint32_t encoder_id; uint32_t connector_type; uint32_t connector_type_id;
  drmModeConnection connection; uint32_t mmWidth, mmHeight; drmModeSubPixel subpixel; int count_modes; drmModeModeInfo *modes;
  int count_props; uint32_t *props; uint64_t *prop_values; int count_encoders; uint32_t *encoders; } drmModeConnector;
typedef struct _drmModeEncoder { uint32_t encoder_id; uint32_t encoder_type; uint32_t crtc_id; uint32_t possible_crtcs; uint32_t possible_clones; } drmModeEncoder;
typedef struct _drmModeCrtc { uint32_t crtc_id; uint32_t buffer_id; uint32_t x, y; uint32_t width, height; int mode_valid; drmModeModeInfo mode; int gamma_size; } drmModeCrtc;
static int live = 0;
int fake_live(void) { return live; }
drmModeRes *drmModeGetResources(int fd) {
  if (fd < 0) return NULL;
  drmModeRes *r = calloc(1, sizeof *r); live++;
  r->count_fbs = 0; r->count_crtcs = 1; r->crtcs = calloc(1, 4); r->crtcs[0] = 70;
  r->count_connectors = 3; r->connectors = calloc(3, 4); r->connectors[0] = 40; r->connectors[1] = 41; r->connectors[2] = 42;
  r->count_encoders = 1; r->encoders = calloc(1, 4); r->encoders[0] = 50;
  r->min_width = 1; r->max_width = 16384; r->min_height = 1; r->max_height = 16384;
  return r;
}
void drmModeFreeResources(drmModeRes *r) { if (!r) return; free(r->crtcs); free(r->connectors); free(r->encoders); free(r); live--; }
drmModeConnector *drmModeGetConnectorCurrent(int fd, uint32_t id) {
  drmModeConnector *c = calloc(1, sizeof *c); live++;
  c->connector_id = id; c->subpixel = DRM_MODE_SUBPIXEL_UNKNOWN;
  c->count_props = 2; c->props = calloc(2, 4); c->prop_values = calloc(2, 8);
  if (id == 40) { c->encoder_id = 50; c->connector_type = 10; c->connector_type_id = 2; c->connection = DRM_MODE_CONNECTED;
    c->mmWidth = 800; c->mmHeight = 335; c->count_encoders = 1; c->encoders = calloc(1, 4); c->encoders[0] = 50; }
  else if (id == 41) { c->connector_type = 11; c->connector_type_id = 1; c->connection = DRM_MODE_DISCONNECTED; }
  else { c->connector_type = 10; c->connector_type_id = 3; c->connection = DRM_MODE_CONNECTED; }
  return c;
}
void drmModeFreeConnector(drmModeConnector *c) { if (!c) return; free(c->props); free(c->prop_values); free(c->encoders); free(c); live--; }
drmModeEncoder *drmModeGetEncoder(int fd, uint32_t id) {
  if (id != 50) return NULL;
  drmModeEncoder *e = calloc(1, sizeof *e); live++;
  e->encoder_id = 50; e->encoder_type = 2; e->crtc_id = 70; e->possible_crtcs = 0xf; e->possible_clones = 0;
  return e;
}
void drmModeFreeEncoder(drmModeEncoder *e) { if (!e) return; free(e); live--; }
drmModeCrtc *drmModeGetCrtc(int fd, uint32_t id) {
  if (id != 70) return NULL;
  drmModeCrtc *c = calloc(1, sizeof *c); live++;
  c->crtc_id = 70; c->buffer_id = 99; c->width = 3440; c->height = 1440; c->mode_valid = 1; c->gamma_size = 4096;
  c->mode.clock = 319750; c->mode.hdisplay = 3440; c->mode.hsync_start = 3488; c->mode.hsync_end = 3520; c->mode.htotal = 3600;
  c->mode.vdisplay = 1440; c->mode.vsync_start = 1443; c->mode.vsync_end = 1453; c->mode.vtotal = 1481; c->mode.vscan = 0;
  c->mode.vrefresh = 60; c->mode.flags = 0x5; c->mode.type = 0x48; strcpy(c->mode.name, "3440x1440");
  return c;
}
void drmModeFreeCrtc(drmModeCrtc *c) { if (!c) return; free(c); live--; }
`;

const cc = spawnSync('cc', ['--version'], { encoding: 'utf8' });

test('koffi binding end to end against a C-compiled stand-in libdrm', { skip: cc.status === 0 ? false : 'no C compiler' }, async () => {
  const src = join(dir, 'fake-libdrm.c');
  const lib = join(dir, 'libfakedrm.so');
  writeFileSync(src, FAKE_LIBDRM_C);
  const build = spawnSync('cc', ['-shared', '-fPIC', '-O1', '-Wall', '-Werror', '-o', lib, src], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const api = await loadDrmApi(lib);
  const tree = fakeTree();
  const snaps = await readDrmSnapshots(api, { log, ...tree });
  assert.deepEqual(
    snaps?.map((s) => [s.connector, s.mode && { ...s.mode, exactHz: Number(s.mode.exactHz.toFixed(4)) }, s.mode && formatMode(s.mode, s.rotation)]),
    [
      ['card1-DP-2', { width: 3440, height: 1440, exactHz: 59.9726 }, { resolution: '3440x1440', frequency: '59Hz', orientation: '0°' }],
      ['card1-DP-3', null, null],
    ],
  );
  const live = koffi.load(lib).func('int fake_live(void)') as () => number;
  assert.equal(live(), 0, 'every libdrm object is freed');
  assert.deepEqual(api.readConnectors(-1), []);
  const source = createDrmSource(log, { library: lib, ...tree });
  assert.equal((await source())?.length, 2);
});
