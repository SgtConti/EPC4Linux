// Tray icon and menu (01 §5; Linux plan item 5).
// Items: "Precision Center" (show), Rescan, Settings, Exit. "Check for Updates" and "Feedback" are
// online features and are not built. Labels come from the vendor table (tray-i18n.ts). Whether a
// tray host actually displays the icon is answered by tray-host.ts.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Menu, Tray, nativeImage } from 'electron';
import type { Logger } from '../backend/types.ts';
import { TRAY_TITLE, trayLabels } from './tray-i18n.ts';

export interface TrayActions {
  /** Vendor isTrayOptionEnable(exitOnly). */
  isOptionEnabled(exitOnly?: boolean): boolean;
  show(): void;
  rescan(): void;
  settings(): void;
  exit(): void;
  /** Packaged + debug flag: the title item opens DevTools instead (01 §5 item 1). */
  titleOpensDevTools(): boolean;
  openDevTools(): void;
}

export class TrayController {
  readonly #resourcesDir: string;
  readonly #log: Logger;
  readonly #actions: TrayActions;
  #tray: Tray | null = null;
  #language = 'en';

  constructor(resourcesDir: string, log: Logger, actions: TrayActions) {
    this.#resourcesDir = resourcesDir;
    this.#log = log;
    this.#actions = actions;
  }

  create(language: string): void {
    this.#language = language;
    const iconPath = join(this.#resourcesDir, 'favicon.png');
    const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    if (icon.isEmpty()) this.#log.warn(`Tray icon missing (${iconPath})`);
    this.#tray = new Tray(icon);
    this.#tray.setToolTip(TRAY_TITLE);
    this.#tray.on('click', () => this.#actions.show());
    this.#tray.setContextMenu(this.#menu());
  }

  /** Vendor refreshTray(): rebuild so enabled states follow the flags. */
  refresh(): void {
    if (!this.#tray) return;
    this.#tray.closeContextMenu();
    this.#tray.setContextMenu(this.#menu());
  }

  setLanguage(language: string): void {
    this.#language = language;
    this.#tray?.setContextMenu(this.#menu());
  }

  destroy(): void {
    this.#tray?.destroy();
    this.#tray = null;
  }

  #icon(name: string): Electron.NativeImage | undefined {
    const p = join(this.#resourcesDir, name);
    return existsSync(p) ? nativeImage.createFromPath(p) : undefined;
  }

  #menu(): Menu {
    const a = this.#actions;
    const labels = trayLabels(this.#language);
    return Menu.buildFromTemplate([
      {
        label: TRAY_TITLE,
        icon: this.#icon('favicon_16x16.png'),
        click: () => (a.titleOpensDevTools() ? a.openDevTools() : a.show()),
      },
      { label: labels.Rescan, icon: this.#icon('tray_rescan.png'), enabled: a.isOptionEnabled(), click: () => a.rescan() },
      { label: labels.Settings, icon: this.#icon('tray_setting.png'), enabled: a.isOptionEnabled(), click: () => a.settings() },
      { label: labels.Exit, icon: this.#icon('tray_close.png'), enabled: a.isOptionEnabled(true), click: () => a.exit() },
    ]);
  }
}
