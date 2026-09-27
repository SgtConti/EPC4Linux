// The identity of the Philips Evnia 34M2C8600 on which the Windows data in test/fixtures/windows was
// captured, ANONYMIZED: its serial, the EDID's 32-bit serial number and manufacture week, and the ENE
// controller's USB serial are replaced by synthetic values (tools/sanitize-public.py; the EDID checksum is
// recomputed), everything else is the captured unit's. For tests that replay or compare with that data
// (golden transcripts, Windows profiles, logs). Not shipped: the product's simulated monitor
// (src/backend/ddc/transports/mock-34m2c8600.ts) carries its own synthetic serial, and these tests inject
// this identity instead (createMock34M2C8600({spec}), MonitorManagerOptions.mockSpec).
// Sources: EDID "RAW DUMP" in logs/EvniaServe-2026-09-25.txt (07 §7.3), SN from GetSN (08 §2.3).

import { MOCK_34M2C8600, type MockMonitorSpec } from '../../src/backend/ddc/transports/mock-34m2c8600.ts';

/** EDID 0xFF descriptor and TPV GetSN of the captured unit (anonymized). */
export const USER_MONITOR_SERIAL = 'AU00000000001';

/** USB serial of the captured unit's ENE Ambiglow controller (anonymized; logs/EvniaServe-2026-09-25.txt:31). */
export const USER_ENE_SERIAL = '0000000002';

/** The captured unit's EDID (base block + CTA extension), byte-identical to the logged RAW DUMP. */
export const USER_EDID_HEX =
  '00FFFFFFFFFFFF00410C9FC20100000001230104B55022783BAC05B04D3DB7250F5054BFEF00D1C0B3009500818081C0316845686168E77C70A0D0A0295030203A0020513100001A000000FF0041553030303030303030303031000000FC0050484C2033344D324338363030000000FD0030AFFFFF5F010A20202020202002BD' +
  '02033DF14D03051404131F02904B4C3F595A2309070783010000E200D5E305C301E6060501664B02741A0000030330AF00A066024B02AF00000000000088D170A0D0A0325030403A0020513100001C539D70A0D0A0345030403A0020513100001A733E70A0D0A0295030203A0020513100001A000000000000000000000000C9';

/** The simulated monitor with the captured unit's identity (everything else is the product's MOCK_34M2C8600). */
export const USER_34M2C8600: MockMonitorSpec = {
  ...MOCK_34M2C8600,
  edidHex: USER_EDID_HEX,
  identity: { ...MOCK_34M2C8600.identity, serialNumber: USER_MONITOR_SERIAL },
};
