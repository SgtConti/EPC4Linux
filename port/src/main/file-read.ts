// Bounded reads of files the renderer names (fileSelect picks, window.nodeApi), for ipc.ts.
//
// Main runs the hub and the DDC traffic, so it must never block its event loop or exhaust memory on a
// file the user picked (task rule "never block the event loop"; ARCHITECTURE: hub and DDC run in main):
//   - only regular files are read. A FIFO would block the opening thread until a writer appears (a
//     synchronous IPC then hangs main for good, an async one ties up a libuv pool thread forever), and a
//     character device such as /dev/zero reports size 0 but never ends. Files are opened with O_NONBLOCK,
//     which regular files ignore and which makes opening a FIFO return at once, and checked with fstat on
//     the open descriptor, so a path swapped after an earlier stat() cannot slip through;
//   - at most MAX_RENDERER_FILE_BYTES are read: the renderer's own limit for everything it imports or
//     uploads (ProfileSizeExceed ST:43080, MacroSizeExceed KeyBind:1160, the feedback image check, all
//     20971520 bytes). Larger files are refused with EFBIG before any byte is read;
//   - data handed to IPC is always a fresh Uint8Array of exactly the file's bytes: IPC serializes a view's
//     whole ArrayBuffer, and a pooled Node Buffer would carry unrelated memory along.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, type Stats, writeFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';

/** The renderer's limit for imported/uploaded files (20 MiB); nodeApi and fileSelect never read more. */
export const MAX_RENDERER_FILE_BYTES = 20 * 1024 * 1024;

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

/** An fs-style error (`code`, `path`) with Node's message format. */
export function fsError(code: string, description: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${description}, open '${path}'`), { code, path });
}

function checkRegular(st: Stats, path: string, max: number): void {
  if (st.isDirectory()) throw fsError('EISDIR', 'illegal operation on a directory', path);
  if (!st.isFile()) throw fsError('EINVAL', 'not a regular file', path);
  if (st.size > max) throw fsError('EFBIG', `file too large (${st.size} bytes, limit ${max})`, path);
}

/** Up to `size` bytes from offset 0 of an open file, as a fresh array (shorter if the file shrank). */
async function readAll(fh: FileHandle, size: number): Promise<Uint8Array> {
  const data = new Uint8Array(size);
  let n = 0;
  while (n < size) {
    const { bytesRead } = await fh.read(data, n, size - n, n);
    if (bytesRead === 0) break;
    n += bytesRead;
  }
  return n === size ? data : data.slice(0, n);
}

/** Regular file `path` (at most `max` bytes) as a fresh Uint8Array; throws EISDIR/EINVAL/EFBIG or the open error. */
export async function readRegularFile(path: string, max = MAX_RENDERER_FILE_BYTES): Promise<Uint8Array> {
  const fh = await open(path, OPEN_FLAGS);
  try {
    const st = await fh.stat();
    checkRegular(st, path, max);
    return await readAll(fh, st.size);
  } finally {
    await fh.close();
  }
}

/** Synchronous readRegularFile, for window.nodeApi's sync channels (bounded, so the block is short). */
export function readRegularFileSync(path: string, max = MAX_RENDERER_FILE_BYTES): Uint8Array {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    const st = fstatSync(fd);
    checkRegular(st, path, max);
    const data = new Uint8Array(st.size);
    let n = 0;
    while (n < data.length) {
      const bytesRead = readSync(fd, data, n, data.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return n === data.length ? data : data.slice(0, n);
  } finally {
    closeSync(fd);
  }
}

/** copyFileSync for a regular source of at most `max` bytes (the destination was checked by the caller). */
export function copyRegularFileSync(from: string, to: string, max = MAX_RENDERER_FILE_BYTES): void {
  writeFileSync(to, readRegularFileSync(from, max));
}

/** MD5 of a regular file, streamed (any size, never blocks); '' when `path` is missing or not a regular file. */
export async function md5RegularFile(path: string): Promise<string> {
  let fh: FileHandle;
  try {
    fh = await open(path, OPEN_FLAGS);
  } catch {
    return '';
  }
  try {
    if (!(await fh.stat()).isFile()) return '';
    const hash = createHash('md5');
    for await (const chunk of fh.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

/**
 * A file picked in fileSelect: its size and content (data null above `max`), or null when it is not a
 * regular file (a directory, FIFO, socket or device), which is then treated as no pick at all.
 */
export async function readPickedFile(path: string, max = MAX_RENDERER_FILE_BYTES): Promise<{ size: number; data: Uint8Array | null } | null> {
  const fh = await open(path, OPEN_FLAGS);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    return { size: st.size, data: st.size > max ? null : await readAll(fh, st.size) };
  } finally {
    await fh.close();
  }
}
