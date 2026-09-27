// Electron fuses of the packaged binary (scripts/package-deb.mjs; 20-online-sweep-tail summary §12:
// the offline acceptance tests include the fuse checks).
//
// Fuses are build-time switches compiled into the Electron executable as a "fuse wire": the sentinel
// below, one version byte (1), one length byte, then one byte per fuse: '1' (0x31) enabled, '0' (0x30)
// disabled, 'r' removed. @electron/fuses writes them the same way; it is not a dependency of the port,
// so this is the minimal writer for the v1 wire (the layout of electron/electron shell/common/fuses.json5).
//
// The packaged app turns off the fuses that let anyone who can start it use it as a general Node runtime
// under its identity:
//   RunAsNode (0)                          ELECTRON_RUN_AS_NODE=1 evnia-precision-center -e …
//   EnableNodeOptionsEnvironmentVariable (2) NODE_OPTIONS=--require … injected into main
//   EnableNodeCliInspectArguments (3)      --inspect / --inspect-brk debugger on main
// It keeps GrantFileProtocolExtraPrivileges (7) on: the vendor UI is loaded from file:// with
// `<script type=module crossorigin>`, which needs it; src/main/network-guard.ts confines file: requests to
// the app tree instead. EnableEmbeddedAsarIntegrityValidation (4) and OnlyLoadAppFromAsar (5) stay off:
// asar integrity needs the header hash stored with the executable (macOS reads ElectronAsarIntegrity from
// Info.plist, Windows a PE resource; the Linux executable of Electron 44 has no such store), and without it
// OnlyLoadAppFromAsar protects nothing here: /opt is root-owned, so whoever can put a resources/app/
// directory there can replace app.asar or the executable as well.

/** The fuse wire sentinel (electron/electron build/fuses/build.py). */
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
export const FUSE_WIRE_VERSION = 1;

/** Fuse indexes of wire version 1 (Electron 44 has 9). */
export const FUSE = {
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7,
  WasmTrapHandlers: 8,
} as const;

export type FuseName = keyof typeof FUSE;

/** What scripts/package-deb.mjs writes into the packaged executable. */
export const PACKAGED_FUSES: Readonly<Partial<Record<FuseName, boolean>>> = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  GrantFileProtocolExtraPrivileges: true,
};

export interface FuseWire {
  /** Byte offset of the sentinel. */
  offset: number;
  version: number;
  /** One character per fuse: '0', '1' or 'r'. */
  fuses: string[];
}

const SENTINEL = Buffer.from(FUSE_SENTINEL, 'latin1');

/** The fuse wire of an Electron executable; throws unless exactly one v1 wire is present. */
export function readFuseWire(binary: Uint8Array): FuseWire {
  const buf = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  const offset = buf.indexOf(SENTINEL);
  if (offset < 0) throw new Error('fuse sentinel not found: not an Electron executable');
  if (buf.indexOf(SENTINEL, offset + 1) >= 0) throw new Error('fuse sentinel found more than once');
  const version = buf[offset + SENTINEL.length];
  if (version !== FUSE_WIRE_VERSION) throw new Error(`unsupported fuse wire version ${version}`);
  const length = buf[offset + SENTINEL.length + 1];
  const start = offset + SENTINEL.length + 2;
  if (start + length > buf.length) throw new Error('truncated fuse wire');
  const fuses = [...buf.subarray(start, start + length)].map((b) => String.fromCharCode(b));
  for (const f of fuses) if (f !== '0' && f !== '1' && f !== 'r') throw new Error(`invalid fuse state ${JSON.stringify(f)}`);
  return { offset, version, fuses };
}

/** Write `changes` into `binary` (in place) and return the new wire. Removed ('r') or unknown fuses throw. */
export function setFuses(binary: Uint8Array, changes: Readonly<Partial<Record<FuseName, boolean>>>): FuseWire {
  const wire = readFuseWire(binary);
  const start = wire.offset + SENTINEL.length + 2;
  for (const [name, on] of Object.entries(changes) as [FuseName, boolean][]) {
    const index = FUSE[name];
    if (index === undefined || index >= wire.fuses.length) throw new Error(`fuse ${name} is not in this Electron's wire`);
    if (wire.fuses[index] === 'r') throw new Error(`fuse ${name} was removed from this Electron`);
    binary[start + index] = on ? 0x31 : 0x30;
  }
  return readFuseWire(binary);
}

/** The state of one fuse in a wire: true/false, or null when removed or absent. */
export function fuseState(wire: FuseWire, name: FuseName): boolean | null {
  const f = wire.fuses[FUSE[name]];
  return f === '1' ? true : f === '0' ? false : null;
}

/** "RunAsNode=0 EnableCookieEncryption=0 …" for logs. */
export function describeFuses(wire: FuseWire): string {
  return (Object.keys(FUSE) as FuseName[])
    .filter((n) => FUSE[n] < wire.fuses.length)
    .map((n) => `${n}=${wire.fuses[FUSE[n]]}`)
    .join(' ');
}
