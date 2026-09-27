// Stable USB device identifiers shared by the libusb and fake backends.
//
// The id follows the kernel's sysfs device name (bus-port.port…), so "usb:3-2.1" is the device on
// port 1 of the hub on port 2 of root hub 3 — the same string as /sys/bus/usb/devices/3-2.1. It is
// stable across re-plugs into the same physical port, which lets attach/detach events be correlated
// and lets the monitor driver pair the ENE MCU with the VIA bridge behind the same monitor hub.
// Because it is stable, the id alone cannot tell a live device from one that re-enumerated in the
// meantime; isSameEnumeration() adds the bus address for that.

import type { UsbDeviceInfo, UsbDeviceInfoWithClass } from '../types.ts';

/** bDeviceClass of a hub (USB 2.0 §9.6.1 / §11.23.1). */
export const USB_CLASS_HUB = 0x09;

/**
 * bDeviceClass of a device as reported by LibusbBackend or FakeUsbBackend (both return
 * UsbDeviceInfoWithClass), or undefined for an info from elsewhere (hand-built, another UsbBackend).
 * Monitor discovery uses it to tell the VIA hub halves (2109:0817/2817/0211/2211, class 0x09) from
 * the 2109:8884 bridge (20 §2.3 step 2) and to keep hubs in their own list for the USBChange
 * comparers (20 §5 step 1).
 */
export function usbDeviceClass(info: UsbDeviceInfo): number | undefined {
  const deviceClass = (info as Partial<UsbDeviceInfoWithClass>).deviceClass;
  return typeof deviceClass === 'number' ? deviceClass : undefined;
}

/** "usb:<bus>-<p1>.<p2>…"; root hubs are "usb:<bus>"; without port numbers, "usb:<bus>@<address>". */
export function usbDeviceId(busNumber: number, portNumbers: readonly number[] | undefined, deviceAddress: number): string {
  if (portNumbers === undefined) return `usb:${busNumber}@${deviceAddress}`;
  if (portNumbers.length === 0) return `usb:${busNumber}`;
  return `usb:${busNumber}-${portNumbers.join('.')}`;
}

/** Name of the device directory under /sys/bus/usb/devices, or null if the topology is unknown. */
export function usbSysfsName(busNumber: number, portNumbers: readonly number[] | undefined): string | null {
  if (portNumbers === undefined) return null;
  return portNumbers.length === 0 ? `usb${busNumber}` : `${busNumber}-${portNumbers.join('.')}`;
}

type Enumeration = Pick<UsbDeviceInfo, 'id' | 'busNumber' | 'deviceAddress' | 'vendorId' | 'productId'>;

/**
 * True when both infos describe the same enumeration of a device: same port id, bus address and
 * VID/PID. Every re-enumeration (unplug/replug, monitor standby or power cycle, a hub reset after
 * an E2A012/E2A014/E2A015 write, suspend/resume) assigns a new address while the id stays the same,
 * and handles opened on the previous enumeration are dead (LIBUSB_ERROR_NO_DEVICE).
 */
export function isSameEnumeration(a: Enumeration, b: Enumeration): boolean {
  return (
    a.id === b.id &&
    a.busNumber === b.busNumber &&
    a.deviceAddress === b.deviceAddress &&
    a.vendorId === b.vendorId &&
    a.productId === b.productId
  );
}

const hex4 = (n: number) => (n & 0xffff).toString(16).padStart(4, '0');

/** "0cf2:a201" (lsusb notation). */
export function formatVidPid(vendorId: number, productId: number): string {
  return `${hex4(vendorId)}:${hex4(productId)}`;
}
