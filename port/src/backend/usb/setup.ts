// Setup-packet checks and formatting shared by the libusb and fake backends.

import type { ControlSetup, UsbDeviceInfo } from '../types.ts';
import { UsbError, describeDevice } from './errors.ts';

/** bmRequestType bit 7: data stage direction (USB 2.0 §9.3.1). */
export const USB_DIR_IN = 0x80;

/** "C0 81 0000 E9F0 0001": a setup packet in the notation used by the specs (09 §3.3). */
export function formatSetup(setup: ControlSetup, wLength: number): string {
  const h = (n: number, w: number) => n.toString(16).padStart(w, '0');
  return `${h(setup.bmRequestType, 2)} ${h(setup.bRequest, 2)} ${h(setup.wValue, 4)} ${h(setup.wIndex, 4)} ${h(wLength, 4)}`.toUpperCase();
}

const isUint = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;

/**
 * Reject malformed setup packets before they reach libusb: field widths, a direction bit that
 * matches the call (controlOut/controlIn), and wLength ≤ 0xFFFF.
 */
export function checkSetup(setup: ControlSetup, direction: 'in' | 'out', wLength: number, device: UsbDeviceInfo): void {
  const ok =
    isUint(setup.bmRequestType, 0xff) &&
    isUint(setup.bRequest, 0xff) &&
    isUint(setup.wValue, 0xffff) &&
    isUint(setup.wIndex, 0xffff) &&
    isUint(wLength, 0xffff);
  const dirOk = ((setup.bmRequestType & USB_DIR_IN) !== 0) === (direction === 'in');
  if (!ok || !dirOk) {
    const why = !ok ? 'field out of range' : `bmRequestType direction does not match control${direction === 'in' ? 'In' : 'Out'}`;
    throw new UsbError('invalid', `Invalid setup packet for ${describeDevice(device)}: ${why} (${JSON.stringify({ ...setup, wLength })})`);
  }
}
