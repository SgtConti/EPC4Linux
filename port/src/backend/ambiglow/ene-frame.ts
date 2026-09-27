// Follow-video frame → ENE per-LED frame buffer (Class0.method_7..10, 09 §7.3).
//
// Input is the 50×40 colour grid of the screen (09 §7.2; produced upstream from the capture host's
// CaptureFrame). Each LED samples one grid cell chosen by the vendor's fixed formulas; the result
// is written as R,G,B triplets starting at 0xE300 in six control transfers (four border segments,
// central, bottom). No apply/commit write follows: mode 14 (UserDefine) displays the buffer.
//
//   segment  n (source)        cell (row, col) of LED k                write address
//   right    Right (JSON)      (round((n-k)·40/(n+1)), 49)  bottom→top   A1 = 0xE300
//   rightUp  RightUp (JSON)    (0, round(49 - k·25/n))      right→centre continues
//   leftUp   LeftUp (JSON)     (0, round((n-1-k)·25/n))     centre→left  continues
//   left     Left (JSON)       (round((k+1)·40/(n+1)), 0)   top→bottom   continues
//   central  device 0xE0A5     (round(k·40/n), 25)          top→bottom   A2 = A1 + 3·border(dev)
//   bottom   device 0xE0A7     (39, round(k·50/n)), last LED → col 49   A3 = A2 + 3·central(dev)
//
// round() is .NET Convert.ToInt32(double): round half to even (Extension_Number.cs:35-45).
//
// Deviation (09 plan F.3): every write stays inside the device's frame buffer, A1 .. A1 + 3·(border +
// central + bottom). The border segments are sized by the JSON, not by the device; when their sum
// exceeds the device's LED count the vendor writes past the buffer into undocumented registers.
// Here the border is cut at the buffer end. A JSON border larger than the device's border group but
// within the buffer spills into the central LEDs as in the vendor (the central write then follows).

import type { EneModelLayout } from './ene-layout.ts';
import { EneReg } from './ene-registers.ts';

export const GRID_WIDTH = 50;
export const GRID_HEIGHT = 40;
const LAST_COL = GRID_WIDTH - 1;
const LAST_ROW = GRID_HEIGHT - 1;
const HALF_WIDTH = Math.trunc(GRID_WIDTH / 2); // GetHalfValue(): int / 2

/** LED counts per group as reported by the device (0xE0A3 / 0xE0A5 / 0xE0A7); 0 = group absent. */
export interface EneLedCounts {
  border: number;
  central: number;
  bottom: number;
}

export type FrameSegmentName = 'right' | 'rightUp' | 'leftUp' | 'left' | 'central' | 'bottom';

export interface FrameSegment {
  name: FrameSegmentName;
  /** Frame-buffer address of the segment's first LED. */
  reg: number;
  /** Grid cell sampled by each LED, in write order. */
  cells: ReadonlyArray<readonly [row: number, col: number]>;
}

export interface FramePlan {
  segments: readonly FrameSegment[];
}

/** A colour grid: width×height pixels, row-major, RGB (3 bytes) or RGBA (4 bytes, alpha ignored). */
export interface VideoGrid {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface FrameWrite {
  reg: number;
  data: Uint8Array;
}

/** .NET Convert.ToInt32(double) for the non-negative values used here: round half to even. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// Guard for LED counts far beyond any shipped model (> 80 central / > 100 bottom), where the vendor
// would index past the grid and drop the frame; clamping keeps the sampling on the edge instead.
const clampRow = (r: number) => Math.min(Math.max(r, 0), LAST_ROW);
const clampCol = (c: number) => Math.min(Math.max(c, 0), LAST_COL);

const range = <T>(n: number, f: (k: number) => T): T[] => Array.from({ length: n }, (_, k) => f(k));

/** Precompute the sampling plan for a device (layout from the JSON table, counts from its registers). */
export function planFrame(layout: EneModelLayout, counts: EneLedCounts): FramePlan {
  const segments: FrameSegment[] = [];
  const a1 = EneReg.FRAME_BUFFER;
  const a2 = a1 + 3 * counts.border;
  const a3 = a2 + 3 * counts.central;
  const end = a3 + 3 * counts.bottom;

  const { rightLedCount: r, rightUpLedCount: ru, leftUpLedCount: lu, leftLedCount: l } = layout;
  if (r + ru + lu + l > 0 && counts.border > 0) {
    // Class0.method_8: four writes back to back from A1, sized by the JSON sub-counts (cut at the
    // end of the device's frame buffer, see the header).
    let reg = a1;
    const add = (name: FrameSegmentName, all: Array<readonly [number, number]>) => {
      const cells = all.slice(0, (end - reg) / 3);
      if (cells.length === 0) return;
      segments.push({ name, reg, cells });
      reg += 3 * cells.length;
    };
    add('right', range(r, (k) => [clampRow(roundHalfEven((r - k) * (GRID_HEIGHT / (r + 1)))), LAST_COL] as const));
    add('rightUp', range(ru, (k) => [0, clampCol(roundHalfEven(LAST_COL - k * (HALF_WIDTH / ru)))] as const));
    add('leftUp', range(lu, (k) => [0, clampCol(roundHalfEven((lu - 1 - k) * (HALF_WIDTH / lu)))] as const));
    add('left', range(l, (k) => [clampRow(roundHalfEven((k + 1) * (GRID_HEIGHT / (l + 1)))), 0] as const));
  }
  if (layout.centerLedCount > 0 && counts.central > 0) {
    // Class0.method_9: vertical centre line, top → bottom.
    const n = counts.central;
    segments.push({ name: 'central', reg: a2, cells: range(n, (k) => [clampRow(roundHalfEven(k * (GRID_HEIGHT / n))), HALF_WIDTH] as const) });
  }
  if (layout.bottomLedCount > 0 && counts.bottom > 0) {
    // Class0.method_10: bottom row, left → right; the last LED always samples the right edge.
    const n = counts.bottom;
    const cells = range(n, (k) => [LAST_ROW, clampCol(roundHalfEven(k * (GRID_WIDTH / n)))] as const);
    cells[n - 1] = [LAST_ROW, LAST_COL];
    segments.push({ name: 'bottom', reg: a3, cells });
  }
  return { segments };
}

/**
 * The frame as ONE write (EneDeviceOptions.frameBurst, 09 plan A.7): the segments concatenated when each starts
 * where the previous one ended (the normal case: 9+12+12+9+54+42 = 138 bytes from 0xE300 on the 34M2C8600), else
 * null (a gap, or a JSON border that spills into the central LEDs; the caller keeps the segment writes).
 */
export function burstFrameWrite(writes: readonly FrameWrite[]): FrameWrite | null {
  if (writes.length === 0) return null;
  let end = writes[0].reg;
  for (const w of writes) {
    if (w.reg !== end) return null;
    end += w.data.length;
  }
  const data = new Uint8Array(end - writes[0].reg);
  for (const w of writes) data.set(w.data, w.reg - writes[0].reg);
  return { reg: writes[0].reg, data };
}

/**
 * Host-side dimming of a frame (the port's FollowVideo Brightness, impl-ambiglow §4.2 and deviation 17): every colour
 * byte × `gain`, rounded to the nearest integer. A gain of 1 or more (or not a number) returns the writes unchanged
 * (the same objects), 0 or less gives black. The follow-video engine passes 1/3, 2/3 or 1; with those c·gain is
 * never halfway between two integers, so the rounding is exact.
 */
export function dimFrameWrites(writes: readonly FrameWrite[], gain: number): FrameWrite[] {
  if (!(gain < 1)) return [...writes];
  const f = gain > 0 ? gain : 0;
  return writes.map((w) => ({ reg: w.reg, data: w.data.map((c) => Math.round(c * f)) }));
}

/**
 * Sample a grid into the plan's frame-buffer writes. The grid must be exactly 50×40 (the vendor's
 * fixed CalcRGBs(50, 40) size; it rejects smaller grids and ignores anything beyond 50×40).
 */
export function renderFrame(plan: FramePlan, grid: VideoGrid): FrameWrite[] {
  if (grid.width !== GRID_WIDTH || grid.height !== GRID_HEIGHT) {
    throw new RangeError(`follow-video grid must be ${GRID_WIDTH}x${GRID_HEIGHT}, got ${grid.width}x${grid.height}`);
  }
  const channels = grid.data.length / (GRID_WIDTH * GRID_HEIGHT);
  if (channels !== 3 && channels !== 4) {
    throw new RangeError(`follow-video grid data must be RGB or RGBA (${GRID_WIDTH * GRID_HEIGHT * 3} or ${GRID_WIDTH * GRID_HEIGHT * 4} bytes), got ${grid.data.length}`);
  }
  return plan.segments.map((segment) => {
    const data = new Uint8Array(3 * segment.cells.length);
    segment.cells.forEach(([row, col], i) => {
      const src = (row * GRID_WIDTH + col) * channels;
      data[3 * i] = grid.data[src];
      data[3 * i + 1] = grid.data[src + 1];
      data[3 * i + 2] = grid.data[src + 2];
    });
    return { reg: segment.reg, data };
  });
}
