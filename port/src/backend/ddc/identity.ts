// Monitor identification over DDC/CI (08 §3.4, 06 §4.3): VCP C8 scaler id, the TPV "FE" page queries
// (model, BOM, firmware version, dual-image bank, scaler name, panel name) and the factory serial.
// Mirrors Interface8.GetScalerIC / imethod_12 (GetMonitorInfo) and Interface2.GetSN on top of any
// DdcChannel, so it works over the VIA bridge, i2c-dev and the simulated monitor alike.

import type { DdcChannel } from '../types.ts';
import {
  type BomBrand,
  type ScalerType,
  TPV_QUERY,
  VCP_CONTROLLER_TYPE,
  parseBomString,
  parseDualImageBank,
  parseScalerIc,
  parseSerialReply,
  scalerTypeOf,
  tpvAscii,
} from './codec.ts';
import { DdcError, errorText, isBusy } from './errors.ts';
import type { DdcTimings } from './channel.ts';

/** A channel that exposes its timings (DdcChannelImpl does); plain DdcChannels get the vendor defaults. */
type ChannelLike = DdcChannel & { readonly timings?: Readonly<DdcTimings> };

const QUERY_SLEEP_DEFAULT = 150;
const RETRY_SLEEP_DEFAULT = 150;

function querySleep(ch: ChannelLike): number {
  return ch.timings?.querySleepMs ?? QUERY_SLEEP_DEFAULT;
}

/** GetScalerIC: GET VCP C8, ScalerIC = SL (08 §3.4). Uses GetStandardData's default sleepTime (150). */
export async function readScalerIc(ch: ChannelLike): Promise<{ scalerIc: number; scalerType: ScalerType }> {
  const raw = await ch.rawQuery([VCP_CONTROLLER_TYPE], 32, querySleep(ch));
  const scalerIc = parseScalerIc(raw);
  return { scalerIc, scalerType: scalerTypeOf(scalerIc) };
}

/** One ASCII TPV query (model, firmware version, scaler name, panel name). */
export async function readTpvString(ch: ChannelLike, query: 'modelName' | 'fwVersion' | 'scalerName' | 'panelName'): Promise<string> {
  const raw = await ch.rawQuery([...TPV_QUERY[query]], 32, querySleep(ch));
  const text = tpvAscii(raw);
  if (text === '') throw new DdcError('unsupported', `${query}: empty reply`);
  return text;
}

export async function readBomString(ch: ChannelLike, brands: readonly BomBrand[] = ['PHILIPS']): Promise<string> {
  return parseBomString(await ch.rawQuery([...TPV_QUERY.bomString], 32, querySleep(ch)), brands);
}

export async function readDualImageBank(ch: ChannelLike, scaler: ScalerType): Promise<number> {
  return parseDualImageBank(await ch.rawQuery([...TPV_QUERY.dualImageBank], 32, querySleep(ch)), scaler);
}

/** Interface2.GetSN: `01 FE EF 13 00 20`, 32-byte read, sleepTime 100. Empty string when shorter than 13. */
export async function readFactorySerial(ch: ChannelLike): Promise<string> {
  const raw = await ch.rawQuery([...TPV_QUERY.serialNumber], 32, ch.timings?.getSleepMs ?? 100);
  return parseSerialReply(raw);
}

export interface MonitorIdentity {
  scalerIc?: number;
  scalerType?: ScalerType;
  modelName?: string;
  bomString?: string;
  version?: string;
  dualImageBank?: number;
  scalerName?: string;
  serialNumber?: string;
  /** Per-field failure reasons; a failed field is simply absent (GetMonitorInfo only logs them). */
  errors: Partial<Record<Exclude<keyof MonitorIdentity, 'errors'>, string>>;
}

export interface IdentityOptions {
  /** BOM acceptance rule; the port always runs in the vendor's PHILIPS mode (06 §2.1). */
  brands?: readonly BomBrand[];
  /** Also read the factory serial number (ReadMonitorDetail does this separately in the vendor). */
  serial?: boolean;
  /** Tries per query (GetMonitorInfo: 3) and the sleep between them (150 ms). */
  tries?: number;
  retrySleepMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * GetScalerIC followed by GetMonitorInfo's sequence: model name, BOM, version, dual-image bank and
 * scaler name, each tried up to 3 times with 150 ms between tries (Interface8.imethod_12). Unlike the
 * vendor we continue when the scaler id is unknown (the family only matters for firmware updates).
 */
export async function readMonitorIdentity(ch: ChannelLike, options: IdentityOptions = {}): Promise<MonitorIdentity> {
  const tries = options.tries ?? 3;
  const retrySleep = options.retrySleepMs ?? ch.timings?.identityRetryMs ?? RETRY_SLEEP_DEFAULT;
  const pause = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const id: MonitorIdentity = { errors: {} };

  async function attempt<K extends keyof MonitorIdentity['errors']>(field: K, fn: () => Promise<MonitorIdentity[K]>, count = tries): Promise<void> {
    for (let i = 0; i < count; i++) {
      if (i > 0 && retrySleep > 0) await pause(retrySleep);
      try {
        id[field] = await fn();
        delete id.errors[field];
        return;
      } catch (e) {
        if (isBusy(e)) throw e; // another process holds the monitor: abort instead of retrying every field
        id.errors[field] = errorText(e);
      }
    }
  }

  await attempt('scalerIc', async () => (await readScalerIc(ch)).scalerIc, 1);
  if (id.scalerIc !== undefined) id.scalerType = scalerTypeOf(id.scalerIc);
  await attempt('modelName', () => readTpvString(ch, 'modelName'));
  await attempt('bomString', () => readBomString(ch, options.brands));
  await attempt('version', () => readTpvString(ch, 'fwVersion'));
  await attempt('dualImageBank', () => readDualImageBank(ch, id.scalerType ?? 'Unknown'));
  await attempt('scalerName', () => readTpvString(ch, 'scalerName'));
  if (options.serial ?? true) await attempt('serialNumber', () => readFactorySerial(ch), 1);
  return id;
}
