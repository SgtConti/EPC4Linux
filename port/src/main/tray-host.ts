// Is there a system tray that will show our icon? (ARCHITECTURE "Linux integration": Tray.)
//
// Electron's Tray is a StatusNotifierItem on Linux. Vanilla GNOME Shell displays none unless the
// AppIndicator extension provides a StatusNotifierWatcher, and it dropped legacy XEmbed trays. The
// answer decides what closing the main window does: hide to the tray (vendor, 01 §3.5) or quit,
// because a hidden window without a tray icon could only be reached again by relaunching the app.

import { execFile } from 'node:child_process';

export const STATUS_NOTIFIER_WATCHER = 'org.kde.StatusNotifierWatcher';

/** `gdbus` "(true,)" / `dbus-send` "boolean true" reply of NameHasOwner → owned? */
export function parseNameHasOwner(stdout: string): boolean {
  return /\(true,?\)|boolean true/.test(stdout);
}

/** Desktops without an SNI watcher but with an XEmbed tray: X11 sessions that are not GNOME. */
export function legacyTrayLikely(env: NodeJS.ProcessEnv): boolean {
  const gnome = (env.XDG_CURRENT_DESKTOP ?? '').toUpperCase().split(':').includes('GNOME');
  return env.XDG_SESSION_TYPE === 'x11' && !gnome;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 1500 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function trayHostAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const reply =
    (await run('gdbus', [
      'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', STATUS_NOTIFIER_WATCHER,
    ])) ??
    (await run('dbus-send', [
      '--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner', `string:${STATUS_NOTIFIER_WATCHER}`,
    ]));
  if (reply !== null && parseNameHasOwner(reply)) return true;
  return legacyTrayLikely(env);
}
