// The DDC/CI Ambiglow path, used when no ENE controller drives the LEDs (09 §14, 06 §6.2): the TPV extended
// codes E2A0 19 (mode), 1A (colour), 1B (position), 1C (brightness), 1D (speed), 1E (direction) and 38
// (reset), on the display's own channel (DisplayDevice.ddc, one transaction at a time per monitor) and always
// inside DisplayDevice.exclusive() by the caller, so an Ambiglow sequence never interleaves with a PHL_*
// sequence (20-monitor-io-linux-consolidation §2.4). In this mode the monitor renders every effect itself,
// FollowVideo/FollowAudio included; the host streams nothing (CDevice_PHLDisplay.cs:1233,1255).
//
// The mode/colour/position/… setters of the Ambiglow page go through PHL_SetOSD (the monitor module); the
// ambiglow service owns Effect_Enable, Effect_Reset and the idle lights-off (EffectEnableTemp) here.
//
// Attribute I/O mirrors Extension_AttributeInfo (and monitor/display.ts, whose helpers are private):
//   SetValue  one write of Value.ToInt32(); the result is not reported (Display.SetStandardValue's return
//             code is ignored by every caller); failures are logged.
//   GetValue  one read; success sets Value/MaxValue and err_code 0, failure err_code 9 with the reason.
//   GetValue<T>(module)  every attribute of the module: when the display advertises the code (DataOSD.
//             GetAttributeInfo = SupportOSDList entry) copy its ValueList if the module's is empty and read,
//             else copy the unavailability reason.

import type { DisplayDevice } from '../services.ts';
import type { Logger, VcpValue } from '../types.ts';
import { analyseVcpString } from '../ddc/capabilities.ts';
import { errorText } from '../ddc/errors.ts';
import { AttributeInfo } from '../monitor/model/attribute-info.ts';
import { cloneEnumItem, enumValue, isExternName, isStandardName } from '../monitor/model/enum-items.ts';
import { asInt32 } from '../monitor/model/json-populate.ts';
import { attributesOf, type AttributeHolder } from '../monitor/model/modules.ts';
import { buildSupportOsdList, supportedAttribute } from '../monitor/model/value-lists.ts';

/** E2A0_19_AmbiglowLightMode_E.AmbiglowOff / StaticMode (catalog names, 20-enum §2). */
export const AMBIGLOW_OFF = enumValue('E2A0_19_AmbiglowLightMode_E', 'AmbiglowOff');
export const AMBIGLOW_STATIC = enumValue('E2A0_19_AmbiglowLightMode_E', 'StaticMode');

/** E2A0_ExternVCPOpCode_E.EXT_OP_E2A0_38_AmbiglowSet: write 1 = the monitor's own Ambiglow reset. */
export const AMBIGLOW_RESET_OP = 'EXT_OP_E2A0_38_AmbiglowSet';

/** CDevice_PHLDisplay.EffectReset: Thread.Sleep(200) between the E2A038 write and the re-read. */
export const AMBIGLOW_RESET_SETTLE_MS = 200;

/** What the concrete display driver (monitor/display.ts PhlDisplay) exposes beyond DisplayDevice. */
interface OsdSource {
  /** Display.VcpCode: the capability string in use. */
  readonly capabilities?: string;
  /** Display.IsSupport: a transport passed the DDC/CI support probe. */
  readonly isSupport?: boolean;
}

/**
 * DataOSD.SupportOSDList of a display, rebuilt from its capability string (the same pure functions the
 * display driver uses: ddc/capabilities.ts analyseVcpString + monitor/model/value-lists.ts), cached per
 * string. A display that does not expose one (a test double) advertises nothing.
 */
export class DisplayOsd {
  #caps: string | null = null;
  #list: AttributeInfo[] = [];

  /** DataOSD.GetAttributeInfo(name), as a copy (callers may set Value on it). */
  global(display: DisplayDevice, opName: string): AttributeInfo {
    const source = display as DisplayDevice & OsdSource;
    const caps = typeof source.capabilities === 'string' ? source.capabilities : '';
    if (caps !== this.#caps) {
      const parsed = analyseVcpString(caps);
      this.#list = parsed ? buildSupportOsdList(parsed) : [];
      this.#caps = caps;
    }
    const found = supportedAttribute(this.#list, opName, source.isSupport ?? true);
    return found.IsAvailable ? found.clone() : found;
  }
}

/** AttributeInfo.SetValue(): one write; failures logged, never thrown (vendor). */
export async function writeAttribute(display: DisplayDevice, a: AttributeInfo, log: Logger): Promise<void> {
  await writeAttributeChecked(display, a, log);
}

/** writeAttribute that says whether the write went out (true) or failed (logged, false). */
export async function writeAttributeChecked(display: DisplayDevice, a: AttributeInfo, log: Logger): Promise<boolean> {
  const code = a.VCPOpCode;
  const value = asInt32(a.Value);
  try {
    if (isStandardName(a.VCPOpCodeName)) await display.ddc.setVcp(code, value);
    else if (isExternName(a.VCPOpCodeName)) await display.ddc.setExt(code & 0xff, value);
    else {
      log.error(`${code} is not VcpCode`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`${a.VCPOpCodeName ?? code} = ${value}: write failed: ${errorText(e)}`);
    return false;
  }
}

/**
 * Port addition (no vendor counterpart): write `a` and read it back; true when the monitor now reports the
 * written value. Used where a lost write would leave the monitor in a state the profile does not describe
 * (the idle lights-off restore, impl-ambiglow §5 item 7). `a` itself is not changed.
 */
export async function writeVerified(display: DisplayDevice, a: AttributeInfo, log: Logger): Promise<boolean> {
  if (!(await writeAttributeChecked(display, a, log))) return false;
  const check = a.clone();
  await readAttribute(display, check);
  if (!check.IsAvailable) {
    log.warn(`${a.VCPOpCodeName ?? a.VCPOpCode}: read-back failed: ${check.err_msg}`);
    return false;
  }
  return asInt32(check.Value) === asInt32(a.Value);
}

/** AttributeInfo.GetValue(): one read into Value/MaxValue, err_code 9 on failure. */
export async function readAttribute(display: DisplayDevice, a: AttributeInfo): Promise<void> {
  const code = a.VCPOpCode;
  try {
    let v: VcpValue;
    if (isStandardName(a.VCPOpCodeName)) {
      v = await display.ddc.getVcp(code);
    } else if (isExternName(a.VCPOpCodeName)) {
      if ((code & 0xffff00) !== 0xe2a000) {
        a.setErrMsg(`extCode formate error code = ${code.toString(16)}`);
        return;
      }
      v = await display.ddc.getExt(code & 0xff);
    } else {
      return;
    }
    a.Value = v.value;
    a.MaxValue = v.max;
    a.resetErrMsg();
  } catch (e) {
    a.setErrMsg(`${isStandardName(a.VCPOpCodeName) ? 'GetStandardValue' : 'GetTPVExternValue'} error result=${errorText(e)}`);
  }
}

/** Extension_AttributeInfo.GetValue<T>(module) over the display's advertised codes. */
export async function readModule(display: DisplayDevice, osd: DisplayOsd, holder: AttributeHolder): Promise<void> {
  for (const a of attributesOf(holder)) {
    const g = osd.global(display, a.VCPOpCodeName ?? '');
    if (g.IsAvailable) {
      if (!a.ValueList?.length && g.ValueList?.length) a.ValueList = g.ValueList.map(cloneEnumItem);
      await readAttribute(display, a);
    } else {
      a.setErrMsg(g.err_msg);
    }
  }
}
