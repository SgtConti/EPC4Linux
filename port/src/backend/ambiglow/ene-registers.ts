// ENE Ambiglow MCU (USB 0cf2:a201, chip 0x7730, vendor name "USB ENE 6K7732"): wire constants and
// the register map as used by Zeasn.USB.ENE.Lib (09 §3-§5).
// All registers are addressed with wValue = reg >> 16 (always 0 here) and wIndex = reg & 0xFFFF.

export const ENE_VENDOR_ID = 0x0cf2;
export const ENE_PRODUCT_ID = 0xa201;

/** ENEIC_E.ENE_0x7730: the only chip id CUSBENE6K7732.Plug() accepts (CUSBENE6K7732.cs:91-92). */
export const ENE_CHIP_ID = 0x7730;

// Vendor requests on EP0, device recipient (09 §3.3; EneEc.dll FUN_100039c0 / FUN_10003a90).
export const ENE_BM_WRITE = 0x40; // vendor | device | host-to-device
export const ENE_REQ_WRITE = 0x80;
export const ENE_BM_READ = 0xc0; // vendor | device | device-to-host
export const ENE_REQ_READ = 0x81;
/** EneEc.dll splits transfers at 0x1000 bytes; the app never sends more than 54 (09 §3.3). */
export const ENE_MAX_TRANSFER = 0x1000;

/** Class0.int_0: Thread.Sleep(10) after every register write except the 0x0023 switch (09 §3.5). */
export const ENE_WRITE_DELAY_MS = 10;

export const EneReg = {
  // Identification (09 §4.1)
  CHIP_ID_HI: 0x4000,
  CHIP_ID_LO: 0x4001,
  /** Revision register of the 0x773x family (EneEc.dll FUN_10005ed0). */
  CHIP_REV: 0x0244,
  /** Embedded-flash controller command/status; EneEc.dll treats non-zero as "trim loaded" (FUN_100052c0). */
  TRIM_STATUS: 0x0415,
  LED_GROUPS: 0xe0a1,
  LED_COUNT_BORDER: 0xe0a3,
  LED_COUNT_CENTRAL: 0xe0a5,
  LED_COUNT_BOTTOM: 0xe0a7,
  MODEL_NAME_LEN: 0xe9f0,
  MODEL_NAME: 0xe9f1,
  FW_VERSION: 0xb500,
  // Control (09 §4.2)
  /** "USBCableLivingSwitch": 0x04 = host (PC) control, 0x00 = released. */
  HOST_CONTROL: 0x0023,
  /** Per-LED frame buffer (R,G,B per LED) displayed in mode 14 (UserDefine). */
  FRAME_BUFFER: 0xe300,
  /** Audio level for FollowAudio (mode 9), three registers E960..E962. */
  AUDIO_LEVEL: 0xe960,
  /** Audio level for FollowAudioRainbow (mode 10), three registers E970..E972. */
  AUDIO_LEVEL_RAINBOW: 0xe970,
} as const;

export const ENE_MODEL_NAME_MAX = 15; // C# buffer size (CUSBENE6K7732.cs:238); the vendor does not cap (09 §16.7)
export const ENE_FW_VERSION_LENGTH = 5;
export const HOST_CONTROL_ON = 0x04;
export const HOST_CONTROL_OFF = 0x00;

/** Device_sel_E: LED groups and the AllZone selector (09 §5.2). */
export const EneRegion = { Border4Sided: 1, Central: 2, Bottom: 3, Clock4: 4, AllZone: 5 } as const;
export type EneGroup = 1 | 2 | 3 | 4;
export const ENE_GROUPS: readonly EneGroup[] = [1, 2, 3, 4];
/** ENEDeviceLedGroup.GetLed_group() clamps the reported group count to 3 (ENEDeviceLedGroup.cs:30-37). */
export const ENE_MAX_LED_GROUPS = 3;

/** MNTLightEffect_E (09 §5.1). */
export const EneMode = {
  LEDOFF: 0,
  StaticMode: 1,
  StaticModeRainbow: 2,
  ColorShift: 3,
  ColorShiftRainbow: 4,
  ColorWave: 5,
  ColorWaveRainbow: 6,
  ColorBreathing: 7,
  ColorBreathingRainbow: 8,
  FollowAudio: 9,
  FollowAudioRainbow: 10,
  FollowVideo: 11,
  StarryNight: 12,
  StarryNightRainbow: 13,
  UserDefine: 14,
} as const;

/** Speed_E byte values. */
export const EneSpeed = { Low: 0x02, Normal: 0x00, High: 0xfe } as const;
/** Bright_E byte values. */
export const EneBrightness = { Bright: 0x04, Brighter: 0x02, Brightest: 0x00 } as const;

/** Offsets inside a group's control block B(g) = 0xE010 + 0x10*g (Class0.cs:45-91). */
export const EneField = { SW_MODE: 0x0, MODE: 0x1, SPEED: 0x2, DIRECTION: 0x3, BRIGHTNESS: 0x9, APPLY: 0xf } as const;

/** Control register `field` of group g: g1 → 0xE02x, g2 → 0xE03x, g3 → 0xE04x, g4 → 0xE05x. */
export function groupReg(group: EneGroup, field: number): number {
  return 0xe010 + 0x10 * group + field;
}

/** Static/base colour R,G,B of group g: 0xE980 / 0xE983 / 0xE986 / 0xE989. */
export function staticColorReg(group: EneGroup): number {
  return 0xe980 + 3 * (group - 1);
}

// ───────────── Access policy (09 plan F.3) ─────────────
// Everything outside these windows is refused by the transport: in particular the embedded-flash
// controller 0x04xx, E51RST 0x0202 and WDTCFG 0x0600 are never written, and nothing is read that
// the vendor app does not read. [start, end) byte ranges; a transfer must fit entirely in one.
// The frame buffer is sized per device: 3 bytes for each LED of groups 1..3 as the device reports
// them (0xE300..0xE389 for the 46 LEDs of the 34M2C8600, 09 §7.3); the registers behind it are
// undocumented and never written.

/** First register after the frame-buffer area; a device reporting more LEDs is capped here (544 LEDs). */
const FRAME_BUFFER_LIMIT = EneReg.AUDIO_LEVEL;

const CONTROL_WRITABLE: ReadonlyArray<readonly [number, number]> = [
  [EneReg.HOST_CONTROL, EneReg.HOST_CONTROL + 1],
  [0xe020, 0xe060], // group control blocks g1..g4
  [EneReg.AUDIO_LEVEL, EneReg.AUDIO_LEVEL + 3],
  [EneReg.AUDIO_LEVEL_RAINBOW, EneReg.AUDIO_LEVEL_RAINBOW + 3],
  [0xe980, 0xe98c], // static colours g1..g4
];

const READABLE: ReadonlyArray<readonly [number, number]> = [
  [EneReg.CHIP_ID_HI, EneReg.CHIP_ID_LO + 1],
  [EneReg.CHIP_REV, EneReg.CHIP_REV + 1],
  [EneReg.TRIM_STATUS, EneReg.TRIM_STATUS + 1],
  [EneReg.LED_GROUPS, 0xe0aa], // group count and per-group LED counts (E0A1..E0A9)
  [EneReg.MODEL_NAME_LEN, EneReg.MODEL_NAME + ENE_MODEL_NAME_MAX],
  [EneReg.FW_VERSION, EneReg.FW_VERSION + ENE_FW_VERSION_LENGTH],
  [EneReg.FRAME_BUFFER, FRAME_BUFFER_LIMIT],
  ...CONTROL_WRITABLE,
];

const within = (ranges: ReadonlyArray<readonly [number, number]>, reg: number, length: number) =>
  length > 0 && ranges.some(([start, end]) => reg >= start && reg + length <= end);

/** End (exclusive) of the frame buffer of a device with `leds` LEDs in groups 1..3. */
export function frameBufferEnd(leds: number): number {
  return Math.min(EneReg.FRAME_BUFFER + 3 * Math.max(0, Math.trunc(leds)), FRAME_BUFFER_LIMIT);
}

/** Whether `length` bytes at `reg` may be written to a device whose frame buffer holds `frameBufferLeds` LEDs. */
export function isWritableRange(reg: number, length: number, frameBufferLeds: number): boolean {
  return within(CONTROL_WRITABLE, reg, length) || within([[EneReg.FRAME_BUFFER, frameBufferEnd(frameBufferLeds)]], reg, length);
}

export function isReadableRange(reg: number, length: number): boolean {
  return within(READABLE, reg, length);
}
