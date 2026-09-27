// Window sizing rules of the vendor main process (01 §4), as pure functions.

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/** Persisted `mainWindowBounds` (01 §6). */
export interface SavedBounds extends Rect {
  maximized: boolean;
}

export const SPLASH_SIZE: Size = { width: 880, height: 520 };
export const MIN_WORKING_SIZE: Size = { width: 1280, height: 720 };

/**
 * Notice toast bounds (01 §4, index.js:9223-9229):
 *   factor = workAreaSize.width * scaleFactor / 1920; w = round(240*factor); h = round(120*factor);
 *   bottom-right corner, 3 px margin.
 * Fix: the vendor ignored workArea.x/y, which misplaces the toast when a panel/dock sits on the left
 * or top edge; the port offsets by the work area origin.
 */
export function noticeBounds(workArea: Rect, scaleFactor: number): Rect {
  const factor = (workArea.width * scaleFactor) / 1920;
  const width = Math.round(240 * factor);
  const height = Math.round(120 * factor);
  return { width, height, x: workArea.x + workArea.width - width - 3, y: workArea.y + workArea.height - height - 3 };
}

/** Largest work area over all displays, by width (vendor setMaximumSize, index.js:17688-17696). */
export function largestWorkArea(workAreas: readonly Size[]): Size | null {
  let best: Size | null = null;
  for (const wa of workAreas) if (!best || wa.width > best.width) best = { width: wa.width, height: wa.height };
  return best && best.width > 0 && best.height > 0 ? best : null;
}

/**
 * Working size after interfaceInitializeCompleted (01 §4 step 3): the saved size if any, otherwise
 * 1920x1080 when the nearest display's work area is at least 1920 wide, else 1280x720.
 */
export function workingSize(saved: Partial<SavedBounds> | undefined, nearestWorkArea: Size): Size {
  if (saved?.width && saved?.height) return { width: saved.width, height: saved.height };
  return nearestWorkArea.width >= 1920 ? { width: 1920, height: 1080 } : { ...MIN_WORKING_SIZE };
}

export function isSavedBounds(v: unknown): v is SavedBounds {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k])) && typeof b.maximized === 'boolean';
}
