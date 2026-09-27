// The two libc calls the DDC layer needs and Node's fs lacks, through koffi (ARCHITECTURE: i2c-dev
// via koffi): ioctl(2) for the i2c-dev slave address (20 §2.7) and flock(2) for the cross-process DDC
// lock (20 §2.4). Both are non-blocking system calls (flock only ever with LOCK_NB), so calling them
// synchronously never stalls the event loop. koffi is loaded on first use, so importing this module
// (tests, the simulator) never needs the FFI.

import { constants as osConstants } from 'node:os';

export interface SyscallResult {
  /** The call's return value (-1 on failure). */
  result: number;
  /** errno after a failed call, 0 otherwise. */
  errno: number;
}

export interface Libc {
  /** ioctl(fd, request, (unsigned long) arg). */
  ioctl(fd: number, request: number, arg: number): SyscallResult;
  /** flock(fd, operation). */
  flock(fd: number, operation: number): SyscallResult;
}

/** <sys/file.h> */
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

let loader: Promise<Libc> | null = null;

export function loadLibc(): Promise<Libc> {
  loader ??= import('koffi').then((mod) => {
    const koffi = mod.default;
    const libc = koffi.load('libc.so.6');
    const ioctl = libc.func('int ioctl(int fd, unsigned long request, ...)');
    const flock = libc.func('int flock(int fd, int operation)');
    const wrap = (result: number): SyscallResult => ({ result, errno: result < 0 ? koffi.errno() : 0 });
    return {
      ioctl: (fd, request, arg) => wrap(ioctl(fd, request, 'unsigned long', arg) as number),
      flock: (fd, operation) => wrap(flock(fd, operation) as number),
    };
  });
  return loader;
}

/** Symbolic errno name ("EBUSY"), as Node reports it in `err.code`. */
export function errnoName(errno: number): string {
  const entry = Object.entries(osConstants.errno).find(([, v]) => v === errno);
  return entry ? entry[0] : `errno ${errno}`;
}

/** An Error carrying the errno name in `code`, like Node's own fs errors. */
export function errnoError(message: string, errno: number): NodeJS.ErrnoException {
  const code = errnoName(errno);
  return Object.assign(new Error(`${message}: ${code}`), { code, errno });
}
