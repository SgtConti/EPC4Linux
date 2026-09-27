// DeviceType / EquipmentType tables needed by the profile engine (EN/DeviceType.cs, EN/EquipmentType.cs).
//
// The theme engine never talks to a peripheral, but a profile file may hold sections of any device
// (a Windows export from a machine with an Evnia mouse, 20-theme §3.3). Three vendor rules depend on
// the device type of a section:
//   - sub-device types (members carrying [MainDeviceType(x)]) are folded into their main type on save
//     and lookup (T_Theme_Profile.GetRealDeviceType, EN/T_Theme_Profile.cs:96-115);
//   - Theme_GetProfileDesc and Theme_GetDevicesBasicInfo skip sub-device types (TO:551, SO:3395);
//   - Theme_GetDevicesBasicInfo also skips JiangMeng_Mouse_Dongle_8K (SO:3395).
// Newtonsoft also accepts enum *names* for enum-typed members (20-theme §3.1 reader rule 4), so the
// name tables are kept complete.

/** DeviceType (EN/DeviceType.cs), declaration order. */
export const DEVICE_TYPES: Readonly<Record<string, number>> = {
  Unknown: 0,
  PHL_CDeviceDisplay: 100000,
  RongYuan_KeyboardSPK8708: 200000,
  RongYuan_KeyboardSPK8508: 200001,
  RongYuan_KeyboardSPK8308: 200002,
  RongYuan_KeyboardSPK8708_BLE: 200003,
  RongYuan_KeyboardSPK8708_24G: 200004,
  BeiYing_KeyboardSPK8618: 201000,
  BeiYing_KeyboardSPK8618_24G: 201001,
  RongYuan_MouseSPK9708: 300000,
  RongYuan_MouseSPK9508: 300001,
  RongYuan_MouseSPK9308: 300002,
  RongYuan_MouseSPK9708_BLE: 300003,
  RongYuan_MouseSPK9708_24G: 300004,
  JiangMeng_MouseSPK9718: 301000,
  JiangMeng_Mouse_Dongle_8K: 301001,
  JiangMeng_MouseSPK9728: 301002,
  YongJiaXing_MouseSPK9618: 302000,
  YongJiaXing_MouseSPK9618_24G: 302001,
  YongJiaXing_MouseSPK9418: 302002,
  YongJiaXing_MouseSPK9418_24G: 302003,
  HaiHui_MouseSPK9618_3395: 303000,
  HaiHui_MouseSPK9618_3395_24G: 303001,
  HaiHui_MouseSPK9618_3395_BLE: 303002,
  HaiHui_MouseSPK9618_8960: 303003,
  HaiHui_MouseSPK9618_8960_24G: 303004,
  RongYuan_MousePadSPL7508: 400001,
  PHL_CDeviceTAG4106: 500000,
  PHL_CDeviceTAG5106: 500001,
};

/** EquipmentType (EN/EquipmentType.cs). */
export const EQUIPMENT_TYPES: Readonly<Record<string, number>> = {
  Unknown: 0,
  Display: 1,
  Keyboard: 2,
  Mouse: 3,
  MousePad: 4,
  Headset: 5,
};

export const DEVICE_TYPE_DISPLAY = 100000;
export const EQUIPMENT_TYPE_DISPLAY = 1;
export const DEVICE_TYPE_JIANGMENG_DONGLE_8K = 301001;

/** [MainDeviceType(main)] attributes of EN/DeviceType.cs: sub type → main type. */
const MAIN_DEVICE_TYPE: ReadonlyMap<number, number> = new Map([
  [200003, 200000],
  [200004, 200000],
  [300003, 300000],
  [300004, 300000],
  [302001, 302000],
  [302003, 302002],
  [303001, 303000],
  [303002, 303000],
  [303004, 303003],
]);

/** UtilAttribute.GetAttribute<MainDeviceTypeAttribute>(deviceType)?.MainDeviceType. */
export function mainDeviceTypeOf(deviceType: number): number | undefined {
  return MAIN_DEVICE_TYPE.get(deviceType);
}

export function isSubDeviceType(deviceType: number): boolean {
  return MAIN_DEVICE_TYPE.has(deviceType);
}

/** T_Theme_Profile.GetRealDeviceType (EN/T_Theme_Profile.cs:96-115). */
export function getRealDeviceType(deviceType: number, modelName: string | null): number {
  const main = MAIN_DEVICE_TYPE.get(deviceType);
  if (main !== undefined) return main;
  if (deviceType === DEVICE_TYPE_JIANGMENG_DONGLE_8K) {
    if (modelName === 'SPK9718') return DEVICE_TYPES.JiangMeng_MouseSPK9718;
    if (modelName === 'SPK9728') return DEVICE_TYPES.JiangMeng_MouseSPK9728;
  }
  return deviceType;
}
