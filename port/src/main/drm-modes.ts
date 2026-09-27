// 20-monitor-io-linux-consolidation §3.5 source c: the current mode of each connected DRM connector, read
// through libdrm (read-only: drmModeGetConnectorCurrent never forces a re-probe, and a non-master client
// cannot force one either). Orientation is unknown at this level, so the snapshots carry rotation 0 ("0°").
//
// libdrm.so.2 is always present where Electron runs (Chromium links it). koffi is loaded on first use, like
// src/backend/ddc/libc.ts. The libdrm calls are plain KMS getters (a few ioctls on an awake GPU: only cards
// with a connected connector are opened); the device node is opened and closed asynchronously.
//
// Structures: xf86drmMode.h (libdrm, stable since 2.4.x). drmModeGetConnectorCurrent needs libdrm ≥ 2.4.71.

import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../backend/types.ts';
import { exactRefreshHz, type ModeSnapshot } from './display-mode.ts';

/** Kernel drm_connector_enum_list (drivers/gpu/drm/drm_connector.c), indexed by DRM_MODE_CONNECTOR_*. */
export const DRM_CONNECTOR_TYPE_NAMES: readonly string[] = Object.freeze([
  'Unknown', 'VGA', 'DVI-I', 'DVI-D', 'DVI-A', 'Composite', 'SVIDEO', 'LVDS', 'Component', 'DIN', 'DP',
  'HDMI-A', 'HDMI-B', 'TV', 'eDP', 'Virtual', 'DSI', 'DPI', 'Writeback', 'SPI', 'USB',
]);

/** drm_mode.h */
export const DRM_MODE_CONNECTED = 1;
export const DRM_MODE_FLAG_INTERLACE = 1 << 4;
export const DRM_MODE_FLAG_DBLSCAN = 1 << 5;

/** The kernel's connector name, e.g. "DP-2" (drm_connector_init: "<type name>-<type id>"). */
export function drmConnectorName(type: number, typeId: number): string {
  return `${DRM_CONNECTOR_TYPE_NAMES[type] ?? 'Unknown'}-${typeId}`;
}

/** The fields of drmModeModeInfo the refresh computation needs. */
export interface DrmModeInfo {
  clock: number;
  hdisplay: number;
  htotal: number;
  vdisplay: number;
  vtotal: number;
  vscan: number;
  flags: number;
}

export interface DrmConnectorState {
  /** "DP-2" */
  name: string;
  connected: boolean;
  /** The CRTC's mode when the connector drives one. */
  mode: DrmModeInfo | null;
}

/** What readDrmSnapshots needs from libdrm (fake in tests). */
export interface DrmApi {
  /** The connectors of the DRM device open on `fd`; [] when it has no KMS resources. */
  readConnectors(fd: number): DrmConnectorState[];
}

/** Snapshot of one connector (§3.5 step 2 for the rate; step 5: no orientation at this level). */
export function drmSnapshot(card: string, c: DrmConnectorState): ModeSnapshot {
  const m = c.mode;
  return {
    source: 'drm',
    connector: `${card}-${c.name}`,
    mode: m
      ? {
          width: m.hdisplay,
          height: m.vdisplay,
          exactHz: exactRefreshHz({
            clockKHz: m.clock,
            htotal: m.htotal,
            vtotal: m.vtotal,
            vscan: m.vscan,
            interlace: (m.flags & DRM_MODE_FLAG_INTERLACE) !== 0,
            doubleScan: (m.flags & DRM_MODE_FLAG_DBLSCAN) !== 0,
          }),
        }
      : null,
    rotation: 0,
  };
}

export interface DrmReadOptions {
  log: Logger;
  /** /sys/class/drm */
  sysfsRoot?: string;
  /** /dev/dri */
  devRoot?: string;
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

/**
 * Snapshots of the connected connectors of every card that sysfs shows with a connected connector (other
 * cards, e.g. a sleeping hybrid-graphics GPU, are never opened). null when no card could be read.
 */
export async function readDrmSnapshots(api: DrmApi, o: DrmReadOptions): Promise<ModeSnapshot[] | null> {
  const sysfs = o.sysfsRoot ?? '/sys/class/drm';
  const dev = o.devRoot ?? '/dev/dri';
  let entries: string[];
  try {
    entries = await readdir(sysfs);
  } catch {
    return null;
  }
  const cards = new Set<string>();
  for (const e of entries) {
    const m = /^(card\d+)-.+$/.exec(e);
    if (m && (await readTrimmed(join(sysfs, e, 'status'))) === 'connected') cards.add(m[1]);
  }
  if (cards.size === 0) return [];
  const out: ModeSnapshot[] = [];
  let readable = 0;
  for (const card of [...cards].sort()) {
    let handle;
    try {
      handle = await open(join(dev, card), 'r');
    } catch (e) {
      o.log.debug(`libdrm: cannot open ${join(dev, card)}: ${(e as Error).message}`);
      continue;
    }
    try {
      for (const c of api.readConnectors(handle.fd)) if (c.connected) out.push(drmSnapshot(card, c));
      readable++;
    } catch (e) {
      o.log.warn(`libdrm: reading ${card} failed: ${(e as Error).message}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return readable > 0 ? out : null;
}

// ───────────────────────────── koffi binding ─────────────────────────────

type Koffi = Awaited<typeof import('koffi')>['default'];

const u32 = 'uint32_t';
const u16 = 'uint16_t';

/** The xf86drmMode.h structures as koffi types (exported for the layout test). */
export function drmTypes(koffi: Koffi) {
  // typedef struct _drmModeModeInfo (68 bytes)
  const ModeInfo = koffi.struct({
    clock: u32,
    hdisplay: u16,
    hsync_start: u16,
    hsync_end: u16,
    htotal: u16,
    hskew: u16,
    vdisplay: u16,
    vsync_start: u16,
    vsync_end: u16,
    vtotal: u16,
    vscan: u16,
    vrefresh: u32,
    flags: u32,
    type: u32,
    name: koffi.array('uint8_t', 32),
  });
  // typedef struct _drmModeRes
  const Res = koffi.struct({
    count_fbs: 'int',
    fbs: 'void *',
    count_crtcs: 'int',
    crtcs: 'void *',
    count_connectors: 'int',
    connectors: 'void *',
    count_encoders: 'int',
    encoders: 'void *',
    min_width: u32,
    max_width: u32,
    min_height: u32,
    max_height: u32,
  });
  // typedef struct _drmModeConnector (the enums drmModeConnection / drmModeSubPixel are int-sized)
  const Connector = koffi.struct({
    connector_id: u32,
    encoder_id: u32,
    connector_type: u32,
    connector_type_id: u32,
    connection: 'int',
    mmWidth: u32,
    mmHeight: u32,
    subpixel: 'int',
    count_modes: 'int',
    modes: 'void *',
    count_props: 'int',
    props: 'void *',
    prop_values: 'void *',
    count_encoders: 'int',
    encoders: 'void *',
  });
  // typedef struct _drmModeEncoder
  const Encoder = koffi.struct({ encoder_id: u32, encoder_type: u32, crtc_id: u32, possible_crtcs: u32, possible_clones: u32 });
  // typedef struct _drmModeCrtc
  const Crtc = koffi.struct({ crtc_id: u32, buffer_id: u32, x: u32, y: u32, width: u32, height: u32, mode_valid: 'int', mode: ModeInfo, gamma_size: 'int' });
  return { ModeInfo, Res, Connector, Encoder, Crtc };
}

/** Bind libdrm (default libdrm.so.2). Rejects when koffi or the library is unavailable. */
export async function loadDrmApi(library = 'libdrm.so.2'): Promise<DrmApi> {
  const koffi = (await import('koffi')).default;
  const lib = koffi.load(library);
  const { Res, Connector, Encoder, Crtc } = drmTypes(koffi);

  const getResources = lib.func('void *drmModeGetResources(int fd)');
  const freeResources = lib.func('void drmModeFreeResources(void *ptr)');
  const getConnectorCurrent = lib.func('void *drmModeGetConnectorCurrent(int fd, uint32_t connector_id)');
  const freeConnector = lib.func('void drmModeFreeConnector(void *ptr)');
  const getEncoder = lib.func('void *drmModeGetEncoder(int fd, uint32_t encoder_id)');
  const freeEncoder = lib.func('void drmModeFreeEncoder(void *ptr)');
  const getCrtc = lib.func('void *drmModeGetCrtc(int fd, uint32_t crtc_id)');
  const freeCrtc = lib.func('void drmModeFreeCrtc(void *ptr)');

  interface RawRes { count_connectors: number; connectors: unknown }
  interface RawConnector { encoder_id: number; connector_type: number; connector_type_id: number; connection: number }
  interface RawCrtc { mode_valid: number; mode: DrmModeInfo }

  function crtcMode(fd: number, encoderId: number): DrmModeInfo | null {
    if (!encoderId) return null;
    const enc = getEncoder(fd, encoderId);
    if (!enc) return null;
    let crtcId: number;
    try {
      crtcId = (koffi.decode(enc, Encoder) as { crtc_id: number }).crtc_id;
    } finally {
      freeEncoder(enc);
    }
    if (!crtcId) return null;
    const crtc = getCrtc(fd, crtcId);
    if (!crtc) return null;
    try {
      const c = koffi.decode(crtc, Crtc) as RawCrtc;
      if (!c.mode_valid) return null;
      const m = c.mode;
      return { clock: m.clock, hdisplay: m.hdisplay, htotal: m.htotal, vdisplay: m.vdisplay, vtotal: m.vtotal, vscan: m.vscan, flags: m.flags };
    } finally {
      freeCrtc(crtc);
    }
  }

  return {
    readConnectors(fd) {
      const res = getResources(fd);
      if (!res) return [];
      try {
        const r = koffi.decode(res, Res) as RawRes;
        const count = Math.max(0, Math.min(r.count_connectors, 256));
        const ids = count > 0 && r.connectors ? (Array.from(koffi.decode(r.connectors, u32, count) as ArrayLike<number>)) : [];
        const out: DrmConnectorState[] = [];
        for (const id of ids) {
          const ptr = getConnectorCurrent(fd, id);
          if (!ptr) continue;
          let c: RawConnector;
          try {
            c = koffi.decode(ptr, Connector) as RawConnector;
          } finally {
            freeConnector(ptr);
          }
          const connected = c.connection === DRM_MODE_CONNECTED;
          out.push({ name: drmConnectorName(c.connector_type, c.connector_type_id), connected, mode: connected ? crtcMode(fd, c.encoder_id) : null });
        }
        return out;
      } finally {
        freeResources(res);
      }
    },
  };
}

/** Source c of the DisplayModeProvider: libdrm is bound on first use; a failed bind disables the source. */
export function createDrmSource(log: Logger, o: Omit<DrmReadOptions, 'log'> & { library?: string } = {}): () => Promise<ModeSnapshot[] | null> {
  let api: Promise<DrmApi | null> | null = null;
  return async () => {
    api ??= loadDrmApi(o.library).catch((e: unknown) => {
      log.info(`libdrm unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    const bound = await api;
    return bound ? readDrmSnapshots(bound, { ...o, log }) : null;
  };
}
