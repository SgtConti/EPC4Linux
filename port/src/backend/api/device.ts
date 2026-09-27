// Bridge Device_* functions (Bridge.cs:94-142 → SystemOper.cs:228-252, 737-772) for the monitor-only
// port: the connect list is the display driver's DeviceInfo (20-backend-host-tail §5 step 3, §6), the
// device-change calls rescan like the vendor's ScanDeviceType values (05 §2.5, 20-monitor-io §5).
//
// Device_GetConnectList must never fail: the renderer's startup S() awaits it without a catch
// (20-backend-host-tail §6 item 1).

import type { ApiModule } from '../index.ts';
import { error, succ } from '../core/envelope.ts';
import { DEVICE_TYPE_DISPLAY, detectDisplays, monitorsOf, rescan } from '../monitor/api-support.ts';
import { MonitorManagerImpl } from '../monitor/manager.ts';

/** SystemOper's text for a device type without a connected driver. */
export const NO_DRIVER = 'No driver found!';

export const deviceApi: ApiModule = (registry, services) => {
  const log = services.log.child('api/device');
  const list = () => monitorsOf(services)?.connectList() ?? [];

  // #16 Device_GetConnectList → SystemOper.GetConnectionDevice.
  registry.register('Device_GetConnectList', [], async () => succ(list()));

  // #17 Device_GetDeviceInfo(device): the driver's DeviceInfo, else "No driver found!".
  registry.register('Device_GetDeviceInfo', ['int'], async ([device]) => {
    const m = monitorsOf(services);
    if (device !== DEVICE_TYPE_DISPLAY || !m) return error(NO_DRIVER);
    const info = m instanceof MonitorManagerImpl ? m.deviceInfo() : (m.connectList()[0] ?? null);
    return info ? succ(info) : error(NO_DRIVER);
  });

  // #18 Device_UpgradeFw: no peripheral drivers and no firmware flashing in the port (E).
  registry.register('Device_UpgradeFw', ['int', 'string'], async () => error(NO_DRIVER));

  // #22 Device_Rescan (tray "rescan"): CacheVcpMgr.Reset() + a full scan, then the list.
  registry.register('Device_Rescan', [], async () => {
    const m = monitorsOf(services);
    if (m) await rescan(m).catch((e) => log.error('Device_Rescan failed', e));
    return succ(list());
  });

  // #23 Device_DetectionUSB (renderer USBChange): the USB reconcile only (UsbDeviceChange path).
  registry.register('Device_DetectionUSB', [], async () => {
    const m = monitorsOf(services);
    if (m) await m.scan('usb').catch((e) => log.error('Device_DetectionUSB failed', e));
    return succ(list());
  });

  // #24 Device_DetectionDisplay (renderer displayChange): 5000 ms settle, then the display scan.
  registry.register('Device_DetectionDisplay', [], async () => {
    const m = monitorsOf(services);
    if (m) await detectDisplays(m).catch((e) => log.error('Device_DetectionDisplay failed', e));
    return succ(list());
  });

  // #25 Device_OtherDeviceChange (hidraw changes): BLE peripherals only — no display I/O, same list.
  registry.register('Device_OtherDeviceChange', [], async () => succ(list()));
};
