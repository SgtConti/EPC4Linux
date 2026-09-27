// Shared contracts between backend modules. Implementations live in the sibling directories;
// see docs/port/ARCHITECTURE.md for the module map. Keep this file free of runtime code
// except tiny constants, so every module can import it without cycles.

// ───────────────────────────── Logging ─────────────────────────────

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

// ───────────────────────────── RPC envelope ─────────────────────────────

/** Parameter types the renderer can send (05 §3.3: Integer→int, String→string, Boolean→bool). */
export type RpcArg = number | string | boolean;
export type RpcArgType = 'int' | 'string' | 'bool';

/**
 * Zeasn.Com.Lib.JsonResult as serialized by the Windows backend (05 §3.4).
 * Field order on the wire is produced by core/envelope.ts; do not build these by hand.
 */
export interface JsonResult {
  err_code: number;
  IsSucc: boolean;
  err_msg: string | null;
  RequestId: string | null;
  Tag: unknown;
  FunctionName: string | null;
  CurrItem: unknown;
}

/** How a Tag payload must be serialized (12 §7: `ui` default, `uiProfileGet` for Profile_GetDeviceData, `profile` for files). */
export type SerializeMode = 'ui' | 'uiProfileGet' | 'profile';

export interface RpcCallContext {
  functionName: string;
  requestId: string | null;
  log: Logger;
}

export type RpcHandler = (args: RpcArg[], ctx: RpcCallContext) => JsonResult | Promise<JsonResult>;

/** One overload of a Bridge function. The dispatcher picks the overload whose signature matches the argument types exactly. */
export interface RpcOverload {
  signature: RpcArgType[];
  handler: RpcHandler;
  /** Serialization mode for this function's response (default 'ui'). */
  serialize?: SerializeMode;
}

export interface RpcRegistry {
  register(name: string, signature: RpcArgType[], handler: RpcHandler, serialize?: SerializeMode): void;
  has(name: string): boolean;
}

/** Push channel to the renderer: becomes a SignalR "Notification" event with RequestId=null (05 §4). */
export interface Notifier {
  notify(functionName: string, tag: unknown): void;
}

// ───────────────────────────── USB ─────────────────────────────

export interface UsbDeviceInfo {
  vendorId: number;
  productId: number;
  busNumber: number;
  deviceAddress: number;
  /** Stable id, e.g. "usb:3-2.1" (bus-portpath) — used to correlate attach/detach. */
  id: string;
  serialNumber?: string;
  product?: string;
  manufacturer?: string;
}

/** USB setup packet fields for a control transfer (bmRequestType carries direction/type/recipient). */
export interface ControlSetup {
  bmRequestType: number;
  bRequest: number;
  wValue: number;
  wIndex: number;
}

export interface UsbDeviceHandle {
  readonly info: UsbDeviceInfo;
  controlOut(setup: ControlSetup, data: Uint8Array, timeoutMs?: number): Promise<void>;
  controlIn(setup: ControlSetup, length: number, timeoutMs?: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface UsbBackend {
  list(filter?: (d: UsbDeviceInfo) => boolean): Promise<UsbDeviceInfo[]>;
  open(info: UsbDeviceInfo): Promise<UsbDeviceHandle>;
  /** Subscribe to hotplug; returns an unsubscribe function. */
  onChange(cb: (kind: 'attach' | 'detach', info: UsbDeviceInfo) => void): () => void;
}

// ───────────────────────────── DDC/CI ─────────────────────────────

/**
 * A byte pipe to one monitor's DDC/CI slave (0x37 / 8-bit 0x6E).
 *
 * write(): `message` is the DDC/CI packet WITHOUT the destination address byte, i.e. starting with
 *          the source byte 0x51 and ending with the checksum (computed including 0x6E, see ddc/codec.ts).
 *          Transports add the address byte if their medium needs it (VIA: data stage starts with 0x6E;
 *          i2c-dev: address is set via ioctl).
 * read():  returns exactly `length` raw bytes as clocked off the bus, starting with the display's
 *          source byte 0x6E (08 §3.2).
 * Implementations must NOT add vendor delays; the codec layer owns timing (07, 08 §3.2).
 */
export interface DdcTransport {
  readonly kind: 'via-usb' | 'i2c-dev' | 'mock';
  /** Stable identifier, e.g. "via:usb:3-2" or "i2c:/dev/i2c-5". */
  readonly id: string;
  write(message: Uint8Array): Promise<void>;
  read(length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Result of a VCP read (08 §3.3 reply parsing). */
export interface VcpValue {
  value: number;
  max: number;
  /** MCCS result code byte (0 = no error); the vendor ignores it but we keep it for diagnostics. */
  resultCode: number;
}

/**
 * High-level DDC/CI channel for one monitor, implemented by ddc/channel.ts on top of one or more
 * DdcTransports (USB-DDC preferred, i2c fallback — 06 §5.1). All calls are serialized per monitor.
 */
export interface DdcChannel {
  readonly transports: readonly DdcTransport[];
  getVcp(code: number): Promise<VcpValue>;
  setVcp(code: number, value: number): Promise<void>;
  /** TPV extended code E2 A0 xx (06 §6.2): `sub` is the low byte xx. */
  getExt(sub: number): Promise<VcpValue>;
  setExt(sub: number, value: number): Promise<void>;
  /** Raw vendor query, e.g. [0xFE,0xE1,0xE6,0x06,0x00] (08 §3.4); returns the raw reply buffer. */
  rawQuery(opcodeAndArgs: number[], readLength?: number, sleepMs?: number): Promise<Uint8Array>;
  capabilities(): Promise<string>;
  close(): Promise<void>;
}

// ───────────────────────────── Monitor discovery ─────────────────────────────

export interface EdidInfo {
  raw: Uint8Array;
  manufacturer: string;      // e.g. "PHL"
  productCode: number;       // e.g. 0xC29F
  serialNumber: number;      // 32-bit binary serial
  monitorName: string;       // 0xFC descriptor, e.g. "PHL 34M2C8600"
  serialString: string;      // 0xFF descriptor, 13 characters, e.g. "MOCK000000001" (simulated monitor)
  week: number;
  year: number;
}

/** A physical monitor as found on Linux, before the driver loads its profile. */
export interface DiscoveredMonitor {
  /** Key used by the UI to switch displays (Windows used the EDID serial string). */
  key: string;
  edid: EdidInfo | null;
  /** DRM connector name if known, e.g. "card1-DP-2". */
  connector?: string;
  /** Candidate transports in priority order (USB-DDC first). */
  transports: DdcTransport[];
  /** ENE Ambiglow controller if present on USB. */
  ene?: UsbDeviceInfo;
}

// ───────────────────────────── Host services (provided by Electron main or tests) ─────────────────────────────

/** Downscaled RGBA frame of the primary screen (follow-video, 09 §7). */
export interface CaptureFrame {
  width: number;   // 50
  height: number;  // 40
  data: Uint8ClampedArray; // RGBA, row-major, width*height*4
  timestamp: number;
}

export interface CaptureHost {
  /** Start delivering frames at roughly `intervalMs`; resolves false if capture is unavailable/denied. */
  startVideo(intervalMs: number, onFrame: (f: CaptureFrame) => void): Promise<boolean>;
  stopVideo(): void;
  /** Start delivering an audio level 0..255 every ~40 ms (follow-audio, 09 §8). */
  startAudio(onLevel: (level: number, spectrum?: Float32Array) => void): Promise<boolean>;
  stopAudio(): void;
  /**
   * Change the frame interval of the current video capture (running, or a start still in flight) to roughly
   * `intervalMs`, keeping its session: on GNOME Wayland a new session is a ScreenCast portal dialog. No-op while
   * nothing is captured; never throws. Optional (appended for the Follow video speed tiers, impl-ambiglow §4.2):
   * without it the capture keeps the interval of its start.
   */
  setVideoInterval?(intervalMs: number): void;
}

export interface DisplayModeInfo {
  /** e.g. "3440x1440" */
  resolution: string;
  /** e.g. "175Hz" */
  frequency: string;
  /** e.g. "0°" */
  orientation: string;
}

export interface HostServices {
  log: Logger;
  /** Directory that mirrors %APPDATA%\EvniaServe (Config/, Theme/, logs/). */
  serveDataDir: string;
  /** Directory that mirrors %APPDATA%\evnia (Electron userData; holds MonitorInfo.json, config.json). */
  appDataDir: string;
  /** Read-only bundled data (MonitorInfo.json, PCenter_DeviceInfo.json, PCenter_AmbiglowInfo.json). */
  resourcesDir: string;
  capture?: CaptureHost;
  /** Seconds since last user input (powerMonitor.getSystemIdleTime). */
  getIdleSeconds?(): number;
  /** Current mode of the OS display that shows `monitor` (best effort). */
  getDisplayMode?(monitor: DiscoveredMonitor): DisplayModeInfo | null;
  /** Executable path of the foreground app, or null if unknown (Wayland). */
  getForegroundAppPath?(): string | null;
  /**
   * File-access policy for paths that arrive over RPC (Theme_ImportProfile/ExportProfile/GetProfileDesc/
   * ApplyProfile, Theme_GetDevicesBasicInfo(path, eq), Macro_Import/Export/GetDetail(file)/VerifyFile):
   * false refuses the access, and the function answers with the vendor's own error for that case, so the
   * reply shape does not change. Electron main allows reads of files the user picked in a dialog and of
   * the app's data directories, and writes only to the path the user just chose in the export dialog
   * (one-shot) or to a `<userData>/<name>.pcenter|.macro` temporary file (src/main/fs-guard.ts). Absent
   * (serve.ts, the CLI, tests): no restriction, like the vendor.
   */
  pathAllowed?(path: string, access: 'read' | 'write'): boolean;
}

// ───────────────────────────── Backend facade ─────────────────────────────

export interface BackendOptions {
  host: HostServices;
  usb?: UsbBackend;
  /** Enable the simulated monitor (EVNIA_MOCK_MONITOR); value is the model name, e.g. "34M2C8600". */
  mockMonitor?: string;
  /** Disable real hardware access entirely (tests). */
  noHardware?: boolean;
}

export interface Backend {
  /** Handle one GetTaskAsync request string; returns the serialized JsonResult string to broadcast. */
  handleRequest(requestJson: string): Promise<string>;
  /** Subscribe to serialized notification JSON strings (target "Notification"). */
  onNotification(cb: (json: string) => void): () => void;
  /** Called by the host on USB/display hotplug (debounced upstream). */
  hotplug(kind: 'usb' | 'display'): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ───────────────────────────── USB device class (appended by usb-ene) ─────────────────────────────

/**
 * UsbDeviceInfo plus the device descriptor's bDeviceClass (0x09 = hub). LibusbBackend and
 * FakeUsbBackend return this shape everywhere (list() and its filter, handle.info, onChange());
 * read it from a plain UsbDeviceInfo with usb/ids.ts usbDeviceClass(). Needed to separate the VIA
 * hub halves from the 2109:8884 bridge (20 §2.3 step 2) and hubs from devices for the USBChange
 * comparers (20 §5 step 1).
 */
export interface UsbDeviceInfoWithClass extends UsbDeviceInfo {
  deviceClass: number;
}
