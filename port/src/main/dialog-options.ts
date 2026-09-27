// Sanitizers for the renderer-supplied dialog options of fileSelect / exportFile (01 §10.1 #9, #11).
// The vendor passed them through verbatim; the port keeps only what the renderer legitimately sets and
// always opens a single file (no directories, no multi-selection).
//
// Two Linux adaptations (20-theme-profile-engine §10.2, zero bundle patches):
//   - App picker: the renderer's FileSelector asks for `[{name:"Application", extensions:["exe"]}]` when an
//     application is bound to a theme (ST:39812-39832). That request opens a chooser of application entries
//     instead: /usr/share/applications, `.desktop` files first, any file (an executable) as the second
//     filter. The backend accepts both (theme/app-binding.ts: desktop-id or executable binding).
//   - Save dialog: GTK does not append the filter's extension (Windows does), and the backend writes exactly
//     the chosen path. With a single one-extension filter (profile/macro export: "pcenter", "macro") the
//     proposed name gets the extension, and a chosen name without it gets it appended (§10.2 item 7) —
//     unless a file of that name exists, which the dialog's overwrite confirmation never covered.

import type { FileFilter, OpenDialogOptions, SaveDialogOptions } from 'electron';

function asRecord(o: unknown): Record<string, unknown> {
  return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {};
}

function sanitizeFilters(filters: unknown): FileFilter[] | undefined {
  if (!Array.isArray(filters)) return undefined;
  return filters.flatMap((f) => {
    const r = asRecord(f);
    if (typeof r.name !== 'string' || !Array.isArray(r.extensions)) return [];
    return [{ name: r.name, extensions: r.extensions.filter((e): e is string => typeof e === 'string') }];
  });
}

function common(src: Record<string, unknown>): { title?: string; defaultPath?: string; buttonLabel?: string; filters?: FileFilter[] } {
  const out: { title?: string; defaultPath?: string; buttonLabel?: string; filters?: FileFilter[] } = {};
  if (typeof src.title === 'string') out.title = src.title;
  if (typeof src.defaultPath === 'string') out.defaultPath = src.defaultPath;
  if (typeof src.buttonLabel === 'string') out.buttonLabel = src.buttonLabel;
  const filters = sanitizeFilters(src.filters);
  if (filters) out.filters = filters;
  return out;
}

/** The renderer's application picker: its first filter is exactly the extensions ["exe"]. */
export function isAppPickerRequest(o: unknown): boolean {
  const filters = sanitizeFilters(asRecord(o).filters);
  const ext = filters?.[0]?.extensions;
  return ext?.length === 1 && ext[0].toLowerCase() === 'exe';
}

/** Where application entries live (XDG data dirs, Flatpak and Snap exports); named in the chooser title. */
export const APPLICATION_DIRS_HINT = '~/.local/share/applications, /var/lib/flatpak/exports/share/applications, /var/lib/snapd/desktop/applications';

/** The Linux replacement of the ["exe"] picker (20-theme §10.2 item 1). */
export function appPickerDialogOptions(): OpenDialogOptions {
  return {
    title: `Select an application (.desktop) — also in ${APPLICATION_DIRS_HINT} — or a program`,
    defaultPath: '/usr/share/applications',
    filters: [
      { name: 'Applications', extensions: ['desktop'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  };
}

export function sanitizeOpenDialogOptions(o: unknown): OpenDialogOptions {
  if (isAppPickerRequest(o)) return appPickerDialogOptions();
  return { ...common(asRecord(o)), properties: ['openFile'] };
}

/** The one extension of a single-filter save dialog ("pcenter"), or null. */
export function soleSaveExtension(o: SaveDialogOptions): string | null {
  const f = o.filters;
  if (!f || f.length !== 1 || f[0].extensions.length !== 1) return null;
  const ext = f[0].extensions[0];
  return /^[A-Za-z0-9]+$/.test(ext) ? ext : null;
}

function hasExtension(path: string, ext: string): boolean {
  return path.toLowerCase().endsWith(`.${ext.toLowerCase()}`);
}

export function sanitizeSaveDialogOptions(o: unknown): SaveDialogOptions {
  const out: SaveDialogOptions = common(asRecord(o));
  const ext = soleSaveExtension(out);
  if (ext && out.defaultPath && !hasExtension(out.defaultPath, ext)) out.defaultPath = `${out.defaultPath}.${ext}`;
  return out;
}

/**
 * The chosen save path with the filter's extension appended when it lacks it, unless that other file
 * exists (`exists` is only asked then).
 */
export async function withSaveExtension(path: string, options: SaveDialogOptions, exists: (p: string) => Promise<boolean>): Promise<string> {
  const ext = soleSaveExtension(options);
  if (!ext || !path || hasExtension(path, ext)) return path;
  const candidate = `${path}.${ext}`;
  return (await exists(candidate)) ? path : candidate;
}
