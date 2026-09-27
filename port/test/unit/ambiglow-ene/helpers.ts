// Shared fixtures for the ENE driver tests: a fake USB bus with the simulated 34M2C8600 ENE MCU,
// a recording sleep, and the spec notation for control transfers ("40 80 0000 E021 0001 | 0E").

import { readFileSync } from 'node:fs';
import { createLogger, silentSink, type LogSink } from '../../../src/backend/core/log.ts';
import { FakeUsbBackend, type FakeTransfer } from '../../../src/backend/usb/fake-backend.ts';
import { formatSetup } from '../../../src/backend/usb/setup.ts';
import { MockEneDevice, type MockEneOptions } from '../../../src/backend/ambiglow/mock-ene.ts';
import { parseAmbiglowInfo } from '../../../src/backend/ambiglow/ene-layout.ts';
import { EneDevice, type EneDeviceOptions } from '../../../src/backend/ambiglow/ene.ts';
import type { Logger } from '../../../src/backend/types.ts';

export const FIXTURES = new URL('./fixtures/', import.meta.url);

/** Subset of the vendor's PCenter_AmbiglowInfo.json (same formatting: CRLF, 2-space indent). */
export const LAYOUTS = parseAmbiglowInfo(readFileSync(new URL('PCenter_AmbiglowInfo.json', FIXTURES), 'utf8'));

export const hex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** One transfer in spec notation: OUT "setup | data", IN "setup -> reply". */
export function fmt(t: FakeTransfer): string {
  return `${formatSetup(t.setup, t.length)} ${t.direction === 'out' ? '|' : '->'} ${hex(t.data)}`;
}

/** "40 80 0000 <reg> <len> | <data>" for a register write. */
export function w(reg: number, ...data: number[]): string {
  return `40 80 0000 ${reg.toString(16).toUpperCase().padStart(4, '0')} ${data.length.toString(16).toUpperCase().padStart(4, '0')} | ${hex(data)}`;
}

/** "C0 81 0000 <reg> <len> -> <reply>" for a register read. */
export function r(reg: number, ...reply: number[]): string {
  return `C0 81 0000 ${reg.toString(16).toUpperCase().padStart(4, '0')} ${reply.length.toString(16).toUpperCase().padStart(4, '0')} -> ${hex(reply)}`;
}

export function recordingLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink: LogSink = (level, _scope, args) => lines.push(`${level}: ${args.map(String).join(' ')}`);
  return { log: createLogger('test', sink, 'debug'), lines };
}

export const quietLog = createLogger('test', silentSink);

export interface Rig {
  usb: FakeUsbBackend;
  mock: MockEneDevice;
  sleeps: number[];
  device: EneDevice;
  /** Devices reported through onLost, in order. */
  lost: EneDevice[];
  /** The driver options `device` was opened with (recording sleep, onLost), for opening another one. */
  options: EneDeviceOptions;
  /** Position in the transfer journal, for since(). */
  mark(): number;
  /** Transfers journaled after `mark`, in spec notation. */
  since(mark: number): string[];
}

/** Fake bus (unbounded journal) + mock ENE at usb:3-2.1 + opened driver with a recording (instant) sleep. */
export async function openRig(mockOptions: MockEneOptions = {}, deviceOptions: Partial<EneDeviceOptions> = {}): Promise<Rig> {
  const usb = new FakeUsbBackend({ journalLimit: Infinity });
  const mock = new MockEneDevice(mockOptions);
  const info = usb.attach(mock.spec({ busNumber: 3, portNumbers: [2, 1] }));
  const sleeps: number[] = [];
  const lost: EneDevice[] = [];
  const options: EneDeviceOptions = {
    log: quietLog,
    layouts: LAYOUTS,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onLost: (d) => lost.push(d),
    ...deviceOptions,
  };
  const device = await EneDevice.open(usb, info, options);
  return {
    usb,
    mock,
    sleeps,
    device,
    lost,
    options,
    mark: () => usb.transfers.length,
    since: (mark) => usb.transfers.slice(mark).map(fmt),
  };
}
