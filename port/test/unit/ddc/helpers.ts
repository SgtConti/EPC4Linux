// Shared helpers for the DDC unit tests (not a test file itself).

import { readFileSync } from 'node:fs';
import type { DdcTransport } from '../../../src/backend/types.ts';
import type { DdcClock } from '../../../src/backend/ddc/channel.ts';
import { hexBytes } from '../../../src/backend/ddc/codec.ts';
import type { SimulatedMonitor } from '../../../src/backend/ddc/transports/mock.ts';

export const fixture = (rel: string) => new URL(`../../fixtures/windows/${rel}`, import.meta.url);

/** 256-byte EDID from the DDCHelper "RAW DUMP" line of the user's log (07 §7.3). */
export function realEdid(): Uint8Array {
  const log = readFileSync(fixture('logs/EvniaServe-2026-09-25.txt'), 'utf8');
  const m = /RAW DUMP: ([0-9A-F]+)/.exec(log);
  if (!m) throw new Error('RAW DUMP not found');
  return Uint8Array.from(Buffer.from(m[1], 'hex'));
}

/** The real capability string, from the signed cache fixture. */
export function realCapabilities(): string {
  const file = JSON.parse(readFileSync(fixture('EvniaServe/Config/data.json'), 'utf8').replace(/^﻿/, ''));
  return JSON.parse(file.data)[0].Datas[0].Vcp;
}

export const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/\s+/g, ''), 'hex'));
export const hex = (b: ArrayLike<number>) => hexBytes(b);

/** Virtual time: sleeps advance the clock instantly and are recorded (non-zero ones). */
export class VirtualClock implements DdcClock {
  t = 0;
  readonly sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    this.sleeps.push(ms);
    this.t += ms;
  }
}

/**
 * Transport of any kind in front of a simulator, with scripted transfer failures and an operation log
 * ("w:<hex>" / "r:<length>") for ordering assertions.
 */
export class ScriptedTransport implements DdcTransport {
  readonly kind: DdcTransport['kind'];
  readonly id: string;
  readonly monitor: SimulatedMonitor;
  readonly ops: string[] = [];
  failWrites = 0;
  failReads = 0;
  closed = false;

  constructor(kind: DdcTransport['kind'], id: string, monitor: SimulatedMonitor) {
    this.kind = kind;
    this.id = id;
    this.monitor = monitor;
  }

  async write(message: Uint8Array): Promise<void> {
    this.ops.push(`w:${hex(message)}`);
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error('scripted write failure');
    }
    this.monitor.receive(message);
  }

  async read(length: number): Promise<Uint8Array> {
    this.ops.push(`r:${length}`);
    if (this.failReads > 0) {
      this.failReads--;
      throw new Error('scripted read failure');
    }
    return this.monitor.reply(length);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
