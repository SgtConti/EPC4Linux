// Error type for the USB layer and the mapping from libusb error/status codes.
//
// The `usb` package reports two kinds of numeric codes (node_modules/usb/src/transfer.cc, node_usb.cc):
//   - synchronous failures (libusb_open, transfer submit) throw LIBUSB_ERROR_* codes (negative);
//   - asynchronous control transfers complete with a libusb_transfer_status (positive).
// Both are folded into one small set of codes that callers can branch on. The values are libusb ABI
// constants (libusb.h), so they are spelled out here instead of being read from the loaded module.

import type { UsbDeviceInfo } from '../types.ts';
import { formatVidPid } from './ids.ts';

export type UsbErrorCode =
  /** libusb could not be loaded or initialised; USB features are off. */
  | 'unavailable'
  /** LIBUSB_ERROR_ACCESS: the device node is not accessible (missing udev rule). */
  | 'access'
  /** The device is gone (unplugged, or re-enumerated at a new address). */
  | 'no-device'
  | 'not-found'
  | 'busy'
  | 'timeout'
  /** Control request STALLed: the device does not support it (LIBUSB_ERROR_PIPE / TRANSFER_STALL). */
  | 'stall'
  | 'overflow'
  | 'io'
  /** The handle was closed by its owner. */
  | 'closed'
  /** Bad arguments (setup packet fields out of range, wrong direction, …). */
  | 'invalid'
  | 'other';

export class UsbError extends Error {
  readonly code: UsbErrorCode;
  /** Raw libusb error code or transfer status, when the error came from libusb. */
  readonly errno: number | undefined;

  constructor(code: UsbErrorCode, message: string, options?: { errno?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UsbError';
    this.code = code;
    this.errno = options?.errno;
  }
}

/** What to tell the user when libusb reports LIBUSB_ERROR_ACCESS (08 §8.5, 09 plan A.1). */
export const USB_PERMISSION_HINT =
  'install the Evnia Precision Center udev rules (TAG+="uaccess" for 2109:8884 and 0cf2:a201), ' +
  'run "sudo udevadm control --reload && sudo udevadm trigger", then re-plug the monitor\'s USB upstream cable';

// libusb_error (negative) → code, name
const LIBUSB_ERRORS = new Map<number, [UsbErrorCode, string]>([
  [-1, ['io', 'LIBUSB_ERROR_IO']],
  [-2, ['invalid', 'LIBUSB_ERROR_INVALID_PARAM']],
  [-3, ['access', 'LIBUSB_ERROR_ACCESS']],
  [-4, ['no-device', 'LIBUSB_ERROR_NO_DEVICE']],
  [-5, ['not-found', 'LIBUSB_ERROR_NOT_FOUND']],
  [-6, ['busy', 'LIBUSB_ERROR_BUSY']],
  [-7, ['timeout', 'LIBUSB_ERROR_TIMEOUT']],
  [-8, ['overflow', 'LIBUSB_ERROR_OVERFLOW']],
  [-9, ['stall', 'LIBUSB_ERROR_PIPE']],
  [-10, ['io', 'LIBUSB_ERROR_INTERRUPTED']],
  [-11, ['other', 'LIBUSB_ERROR_NO_MEM']],
  [-12, ['other', 'LIBUSB_ERROR_NOT_SUPPORTED']],
  [-99, ['other', 'LIBUSB_ERROR_OTHER']],
]);

// libusb_transfer_status (positive) → code, name
const TRANSFER_STATUS = new Map<number, [UsbErrorCode, string]>([
  [1, ['io', 'LIBUSB_TRANSFER_ERROR']],
  [2, ['timeout', 'LIBUSB_TRANSFER_TIMED_OUT']],
  [3, ['io', 'LIBUSB_TRANSFER_CANCELLED']],
  [4, ['stall', 'LIBUSB_TRANSFER_STALL']],
  [5, ['no-device', 'LIBUSB_TRANSFER_NO_DEVICE']],
  [6, ['overflow', 'LIBUSB_TRANSFER_OVERFLOW']],
]);

/** Codes that stand for a libusb_error: everything but the backend's own 'unavailable' and 'closed'. */
export type LibusbErrorCode = Exclude<UsbErrorCode, 'unavailable' | 'closed'>;

// Code → the libusb_error a synchronous libusb call reports for it (the first of LIBUSB_ERRORS per code,
// LIBUSB_ERROR_OTHER for 'other').
const LIBUSB_ERRNO: Record<LibusbErrorCode, number> = {
  io: -1,
  invalid: -2,
  access: -3,
  'no-device': -4,
  'not-found': -5,
  busy: -6,
  timeout: -7,
  overflow: -8,
  stall: -9,
  other: -99,
};

/** "LIBUSB_ERROR_OTHER (-99)" for a libusb_error value, e.g. node-usb's INIT_ERROR. */
export function libusbErrorName(errno: number): string {
  return `${LIBUSB_ERRORS.get(errno)?.[1] ?? 'unknown libusb error'} (${errno})`;
}

export function describeDevice(info: Pick<UsbDeviceInfo, 'vendorId' | 'productId' | 'id'>): string {
  return `${formatVidPid(info.vendorId, info.productId)} (${info.id})`;
}

/**
 * The UsbError LibusbBackend reports when a synchronous libusb call (libusb_open, transfer submit)
 * fails with the libusb_error behind `code`: the same code, errno and message (including the udev
 * hint for 'access'). Used by FakeUsbBackend so simulated failures read exactly like real ones.
 */
export function simulatedLibusbError(code: LibusbErrorCode, op: string, device: Pick<UsbDeviceInfo, 'vendorId' | 'productId' | 'id'>): UsbError {
  const errno = LIBUSB_ERRNO[code];
  // node-usb's libusbException (src/node_usb.cc:309-314): message = libusb_error_name(), plus `errno`.
  const thrown = Object.assign(new Error(LIBUSB_ERRORS.get(errno)?.[1] ?? 'LIBUSB_ERROR_OTHER'), { errno });
  return fromLibusbError(thrown, op, device);
}

/**
 * Convert whatever the `usb` package threw or passed to a callback into a UsbError.
 * `op` names the failed operation for the message, e.g. "open" or "control IN C0 81 0000 E9F0".
 */
export function fromLibusbError(err: unknown, op: string, device: Pick<UsbDeviceInfo, 'vendorId' | 'productId' | 'id'>): UsbError {
  if (err instanceof UsbError) return err;
  const errno = typeof (err as { errno?: unknown })?.errno === 'number' ? (err as { errno: number }).errno : undefined;
  const known = errno === undefined ? undefined : errno < 0 ? LIBUSB_ERRORS.get(errno) : TRANSFER_STATUS.get(errno);
  const code: UsbErrorCode = known?.[0] ?? 'other';
  const name = known?.[1] ?? (err instanceof Error ? err.message : String(err));
  const where = describeDevice(device);
  const message =
    code === 'access'
      ? `No permission to open USB device ${where}; ${USB_PERMISSION_HINT}`
      : `${op} on USB device ${where} failed: ${name}`;
  return new UsbError(code, message, { errno, cause: err });
}
