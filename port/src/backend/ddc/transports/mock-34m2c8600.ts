// Seed data of the simulated Philips Evnia 34M2C8600 (EVNIA_MOCK_MONITOR=34M2C8600).
// Sources, all from the user's machine:
//   - capability string: EvniaServe/Config/data.json (06 §4.8, 03 §6.2), byte-exact incl. the double space
//   - EDID: "RAW DUMP" in EvniaServe-2026-09-25.txt (07 §7.3)
//   - identity: LOG26 banner (08 §2.3): model, BOM, version, dual-image bank, scaler; SN from GetSN
//   - VCP values/maxima: reload after the E2A043 write (03 §6.3) and the connect read (06 §5.7)
// Entries marked "synthetic" were never read on the real monitor; they are plausible MCCS values so
// the simulator answers every code the capability string advertises.
//
// Privacy: this file ships inside the app (mock mode is part of the product, ARCHITECTURE rule 7), so it
// carries no identifier of the user's unit. The serial is the synthetic MOCK_SERIAL, in the TPV GetSN
// answer and in the EDID (0xFF descriptor text, the 32-bit serial number 1, the checksum recomputed); the
// rest of the EDID is the model's. Tests that replay the user's captured session inject the real serial and
// EDID from test/fixtures/user-monitor.ts (MonitorManagerOptions.mockSpec, createMock34M2C8600({spec})).

export interface MockMonitorSpec {
  name: string;
  capabilities: string;
  edidHex: string;
  identity: {
    modelName: string;
    bomString: string;
    fwVersion: string;
    dualImageBank: number;
    scalerName: string;
    serialNumber: string;
  };
  /** [code, value, max]; codes >= 0xE2A000 are TPV extended codes. */
  vcp: ReadonlyArray<readonly [number, number, number]>;
  /** Continuous controls: writes are clamped to 0..max. Other codes store any 16-bit value. */
  continuous: readonly number[];
  /** Picture controls the monitor keeps per SmartImage mode (VCP DC). */
  perMode: readonly number[];
  /** Codes reset by E2A038 (Ambiglow reset, 06 §6.2). */
  ambiglow: readonly number[];
  eq: { bands: number; defaultGain: number; maxGain: number };
}

/** Serial of the simulated monitor (13 characters, like the model's real serials): no real unit's. */
export const MOCK_SERIAL = 'MOCK000000001';

export const MOCK_34M2C8600: MockMonitorSpec = {
  name: '34M2C8600',
  capabilities:
    '(prot(monitor)type(LCD)model(34M2C8600MV)cmds(01 02 03 07 0C E3 F3)vcp(02 04 05 08 0B 0C 10 12 14(02 04 05 06 07 08 0A 0B 0D ) 16 18 1A 52 54(00 01) 60(11 12 0F 15 21 22 2F 35 ) 62 6C 6E 70 72(50 64 78 8C A0) 86(01 0A 12 13 14 15 16 17 18 19 1A 1B 23)87 8D(01 02) A4 A5 AC AE B2 B6 C0 C6 C8 CA(01 02) CC(01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 12 14 16 17 1A 1E 24) D6(01 04 05) DA(00 02) DC(00 01 03 04 05 06 07 08 0B 0E 11 20 21 22 23 24 30 33 51 E2) DF E9(00 02) E0(01 02 03 05) E2A000(46 47 48 49 4A 4B) E2A001(00 01 02 03 04) E2A004(00 01 02) E2A006(00 01 02 03) E2A007(00 01) E2A008(00 01) E2A009(01 02 03 04 05 06 07) E2A00A E2A00B E2A00C E2A00D E2A00E E2A00F E2A010(00 01 02 03 04) E2A011(00 01 02 03 04) E2A012(00 01) E2A013(00 01) E2A015(00 01 02) E2A016(00 01) E2A017(00 01) E2A019(00 01 02 03 04 05 06 07) E2A01A(00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D) E2A01B(00 01 02 03) E2A01C(00 01 02) E2A01D(00 01 02) E2A020(02 03 04  0F) E2A024(00 01 02 03 04) E2A034(00 02 03 04) E2A035(00 02 03) E2A036(00 01) E2A038(01) E2A039 E2A040(00 01) E2A041(00 01 02) E2A042(30 31 32 33 34 35 36 37 38 39 3A 3B 3C 3D 3E 3F) E2A043(00 01) E2A044(00 01 02 03) EC(01 02 03) ED(00 01) F0(00 01) F2(00 01 02 03 04) F6(01) F7(42)FD FF)mswhql(1)asset_eep(40)mccs_ver(2.2))',
  edidHex:
    '00FFFFFFFFFFFF00410C9FC20100000001230104B55022783BAC05B04D3DB7250F5054BFEF00D1C0B3009500818081C0316845686168E77C70A0D0A0295030203A0020513100001A000000FF004D4F434B303030303030303031000000FC0050484C2033344D324338363030000000FD0030AFFFFF5F010A2020202020200289' +
    '02033DF14D03051404131F02904B4C3F595A2309070783010000E200D5E305C301E6060501664B02741A0000030330AF00A066024B02AF00000000000088D170A0D0A0325030403A0020513100001C539D70A0D0A0345030403A0020513100001A733E70A0D0A0295030203A0020513100001A000000000000000000000000C9',
  identity: {
    modelName: '34M2C8600',
    bomString: '100GPRS2003NA1SXXY',
    fwVersion: 'V1.01',
    dualImageBank: 0x40,
    scalerName: 'RTD2738VL',
    serialNumber: MOCK_SERIAL,
  },
  vcp: [
    [0x02, 0x01, 0x02], // synthetic: new control value "no new values"
    [0x04, 0x00, 0x01], // restore factory defaults (trigger)
    [0x05, 0x00, 0x01], // synthetic
    [0x08, 0x00, 0x01], // synthetic
    [0x0b, 0x32, 0x32], // synthetic: colour temperature increment
    [0x0c, 0x46, 0xff], // synthetic: colour temperature request
    [0x10, 0x64, 0x64],
    [0x12, 0x32, 0x64],
    [0x14, 0x05, 0x0d], // probe value (LOG26 CheckSupportUSBDDC)
    [0x16, 0x64, 0x64], // synthetic: user RGB gains
    [0x18, 0x64, 0x64],
    [0x1a, 0x64, 0x64],
    [0x52, 0x00, 0xff], // synthetic
    [0x54, 0x02, 0x04],
    [0x60, 0x0f, 0x3616], // DP1; the odd maximum is what the monitor reported (06 §5.7)
    [0x62, 0x00, 0x64],
    [0x6c, 0x32, 0x64], // synthetic: black levels
    [0x6e, 0x32, 0x64],
    [0x70, 0x32, 0x64],
    [0x72, 0x78, 0xa0], // synthetic: gamma 2.2
    [0x86, 0x02, 0x23],
    [0x87, 0x32, 0x64], // synthetic: sharpness
    [0x8d, 0x02, 0x02],
    [0xa4, 0x00, 0xffff], // window mask control (commit trigger)
    [0xa5, 0x00, 0x200],
    [0xac, 0xf467, 0x0003], // synthetic: ~259.2 kHz horizontal frequency
    [0xae, 0x445c, 0xffff], // synthetic: 175.00 Hz
    [0xb2, 0x01, 0x08], // synthetic
    [0xb6, 0x03, 0x08], // synthetic: LCD per type(LCD)
    [0xc0, 0x01f4, 0x0000], // synthetic: usage hours
    [0xc6, 0x0000, 0xffff], // synthetic
    [0xc8, 0x0009, 0x00ff], // Realtek controller (ScalerIC 0x09, 08 §2.3 "VIA-RTK")
    [0xca, 0x02, 0x02], // synthetic: OSD enabled
    [0xcc, 0x02, 0x24],
    [0xd6, 0x01, 0x05], // synthetic: power on
    [0xda, 0x02, 0x08],
    [0xdc, 0x21, 0x35], // SmartImage "HDR Game"
    [0xdf, 0x0202, 0xffff], // synthetic: MCCS 2.2
    [0xe0, 0x03, 0x08],
    [0xe9, 0x00, 0x02],
    [0xec, 0x00, 0x00],
    [0xed, 0x01, 0x01],
    [0xf0, 0x00, 0x01], // synthetic
    [0xf2, 0x01, 0x04],
    [0xf6, 0x00, 0x00],
    [0xf7, 0x42, 0x42], // synthetic: PIP + 2-window PBP (caps F7(42))
    [0xfd, 0x00, 0x00], // synthetic
    [0xff, 0x00, 0x00], // synthetic
    [0xe2a000, 0x46, 0x4b],
    [0xe2a001, 0x04, 0x04], // EQ band selector, left on the last band by the load loop
    [0xe2a004, 0x00, 0x02],
    [0xe2a006, 0x00, 0x03],
    [0xe2a007, 0x00, 0x01],
    [0xe2a008, 0x00, 0x01],
    [0xe2a009, 0x01, 0x07],
    [0xe2a00a, 0x64, 0x64],
    [0xe2a00b, 0x32, 0x64],
    [0xe2a00c, 0x00, 0x05],
    [0xe2a00d, 0x00, 0x00],
    [0xe2a00e, 0x32, 0x64],
    [0xe2a00f, 0x32, 0x64],
    [0xe2a010, 0x00, 0x04],
    [0xe2a011, 0x02, 0x04],
    [0xe2a012, 0x01, 0x01],
    [0xe2a013, 0x01, 0x01],
    [0xe2a015, 0x00, 0x02],
    [0xe2a016, 0x00, 0x01],
    [0xe2a017, 0x00, 0x01],
    [0xe2a019, 0x00, 0x07],
    [0xe2a01a, 0x06, 0x0d],
    [0xe2a01b, 0x00, 0x03],
    [0xe2a01c, 0x02, 0x02],
    [0xe2a01d, 0x00, 0x02],
    [0xe2a020, 0x0f, 0x11], // synthetic: colour space Native
    [0xe2a024, 0x00, 0x04], // synthetic: LowBlue off
    [0xe2a034, 0x03, 0x04],
    [0xe2a035, 0x02, 0x03],
    [0xe2a036, 0x00, 0x01],
    [0xe2a038, 0x00, 0x01], // Ambiglow reset (trigger)
    [0xe2a039, 0x08, 0x10], // EQ gain of the selected band (flat)
    [0xe2a040, 0x01, 0x01],
    [0xe2a041, 0x01, 0x02],
    [0xe2a042, 0x30, 0x3f], // SmartImage reset (trigger)
    [0xe2a043, 0x01, 0x01], // AutoWarning, after the user's write (LOG26:1087)
    [0xe2a044, 0x00, 0x03],
  ],
  continuous: [0x10, 0x12, 0x16, 0x18, 0x1a, 0x62, 0x6c, 0x6e, 0x70, 0x87, 0xe2a00a, 0xe2a00b, 0xe2a00c, 0xe2a00d, 0xe2a00e, 0xe2a00f],
  perMode: [0x10, 0x12, 0xf0, 0x72, 0x87, 0x14, 0x16, 0x18, 0x1a, 0xe2a020, 0xe2a024],
  ambiglow: [0xe2a019, 0xe2a01a, 0xe2a01b, 0xe2a01c, 0xe2a01d],
  eq: { bands: 5, defaultGain: 0x08, maxGain: 0x10 },
};
