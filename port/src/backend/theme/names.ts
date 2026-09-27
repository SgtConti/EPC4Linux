// Name and path helpers of the vendor (COM/FileUtil.cs, COM/Extension_IO.cs, GO:120-132, COM/SHA1Util.cs).
//
// Theme, profile and macro names become file and directory names verbatim (20-theme §2), so the
// validator decides what can reach the file system.

import { createHash } from 'node:crypto';

/**
 * .NET Path.GetInvalidFileNameChars() on Windows: `"` `<` `>` `|` NUL, U+0001-U+001F, `:` `*` `?`
 * `\` `/` (20-theme §5.0). The vendor ran on Windows, so this set is what makes Linux profiles
 * portable back to Windows (20-theme §10.1 "Writer requirements").
 */
const WINDOWS_INVALID_FILE_NAME = /["<>|\u0000-\u001f:*?\\/]/;

/** FileUtil.IsFileNameValid / string.CheckFileNameValid() exactly as the vendor (COM/FileUtil.cs:12-19). */
export function checkFileNameValidVendor(name: string | null | undefined): boolean {
  if (name === null || name === undefined || name === '') return false;
  return !WINDOWS_INVALID_FILE_NAME.test(name);
}

/**
 * Path safety for names that already exist (loaded indexes, lookups): the vendor rule plus `.` and `..`.
 *
 * Deviation (vendor bug B-1, 20-theme §11): the vendor accepts `.` and `..`, so `Theme_Add("..", …)`
 * deleted `Theme/..`, i.e. the whole EvniaServe directory, before creating the theme. Every name that
 * becomes a path component goes through this check; the error codes and texts stay the vendor's
 * "Not Valid" ones. Names created by the port go through the stricter isValidNewName.
 */
export function isValidName(name: string | null | undefined): name is string {
  return checkFileNameValidVendor(name) && name !== '.' && name !== '..';
}

/**
 * The validator for every NEW theme, profile or macro name (Add, Rename, Copy, AddProfile, Import,
 * ApplyProfile): isValidName plus no leading or trailing space or dot (20-theme §10.1 "also reject
 * `.`, `..`, leading/trailing space or dot"). Win32 strips a trailing dot or space from a file or
 * directory name, so such a theme could not be copied back to Windows, and a leading dot makes the
 * file hidden on Linux. Failures keep the vendor's "Not Valid" texts and code 2.
 *
 * Existing names from a copied Windows index are not re-validated with this rule (Windows accepts a
 * leading space or dot), so no user data is dropped at load time.
 */
export function isValidNewName(name: string | null | undefined): name is string {
  return isValidName(name) && !/^[ .]|[ .]$/.test(name);
}

/** The first entry of `names` equal to `name` under OrdinalIgnoreCase, or undefined. */
export function findIgnoreCase(names: readonly (string | null)[], name: string | null | undefined): string | undefined {
  for (const n of names) if (n !== null && equalsIgnoreCase(n, name)) return n;
  return undefined;
}

/**
 * GlobalOper.GenValidName (GO:120-132): an invalid name becomes `defName`; a taken name becomes
 * `name(1)`, `name(2)`, … (no space).
 *
 * Deviation (20-theme §10.1, B-10): "taken" is decided case-insensitively (the vendor used
 * List.IndexOf, ordinal), because a Windows file system cannot hold both `Default` and `default`; the
 * validity test is isValidNewName.
 */
export function genValidName(names: readonly string[] | null, name: string, defName: string): string {
  const list = names ?? [];
  const base = isValidNewName(name) ? name : defName;
  let text = base;
  for (let n = 1; findIgnoreCase(list, text) !== undefined; n++) text = `${base}(${n})`;
  return text;
}

/** Last path component (POSIX; .NET on Linux only splits on '/'). */
export function fileNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Path.GetFileNameWithoutExtension: file name up to (not including) its last '.'. */
export function getFileNameWithoutExtension(path: string | null | undefined): string {
  if (!path) return '';
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(0, dot) : name;
}

/** Path.GetExtension (".png", "" when none). */
export function getExtension(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 && dot < name.length - 1 ? name.slice(dot) : '';
}

/** Path.ChangeExtension(path, ext) with ext starting with '.' (Macro_Export, SO:2513). */
export function changeExtension(path: string, ext: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const stem = dot > slash ? path.slice(0, dot) : path;
  return stem + ext;
}

/** SHA1Util.Sha1(text).Substring(0, 10): lowercase hex of SHA-1 over the UTF-8 bytes (TO:194). */
export function sha1Prefix10(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 10);
}

/** One UTF-16 unit upper-cased with the simple (1:1) mapping, as .NET's ordinal-ignore-case does. */
function upperUnit(c: string): string {
  const u = c.toUpperCase();
  return u.length === 1 ? u : c;
}

/** string.Equals(a, b, StringComparison.OrdinalIgnoreCase): per-unit simple upper-case comparison. */
export function equalsIgnoreCase(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && upperUnit(x) !== upperUnit(y)) return false;
  }
  return true;
}
