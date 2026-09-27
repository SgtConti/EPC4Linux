// Electron main process of Evnia Precision Center for Linux (01 whole; ARCHITECTURE "src/main").
// Bundled by scripts/build.mjs to build/app/main.cjs (backend included, in-process).
//
// Lifecycle (01 §3): single-instance lock (a second launch shows the window) → ready → kill-switch,
// local: protocol, windows (main 880x520 splash + notice toast), tray, IPC → the renderer invokes
// startupBackendService → interfaceInitializeCompleted resizes to the working size (01 §4).
// Stripped vendor behaviour (01 port plan 8): update check/installer, resource patches, MonitorInfo
// download, OAuth protocol handler, feedback window, Matter, DtsServer kill, global shortcuts.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, protocol, screen, session, type Display } from 'electron';
import { eneFrameBurstFromEnv } from '../backend/ambiglow/ene.ts';
import { generateHubToken } from '../backend/index.ts';
import { createLogger, type LogLevel } from '../backend/core/log.ts';
import { defaultAppTempDir } from '../backend/theme/paths.ts';
import type { Logger } from '../backend/types.ts';
import { LibusbBackend } from '../backend/usb/libusb-backend.ts';
import { applyAutostart, autostartDir } from './autostart.ts';
import { BackendHost, mockMonitorFromEnv } from './backend-host.ts';
import { ElectronCaptureHost } from './capture-host.ts';
import { createCommandRunner } from './child-process.ts';
import { DeviceChangeGate, type DeviceEventName } from './device-events.ts';
import { DisplayModeProvider } from './display-sources.ts';
import { installEgressGuard } from './egress-guard.ts';
import { type LineWatcher, startDisplayWatchers } from './display-watch.ts';
import { createDrmSource } from './drm-modes.ts';
import { appExitSteps, runExitSteps } from './exit.ts';
import { isWaylandSession, X11ForegroundTracker } from './foreground-app.ts';
import { PathGuard } from './fs-guard.ts';
import { createHostServices } from './host-services.ts';
import { IdleTimeSource, useMutterIdle } from './idle-time.ts';
import { type IpcHost, type RunConfig, registerIpcHandlers } from './ipc.ts';
import { createLocalProtocolHandler, LOCAL_SCHEME } from './local-protocol.ts';
import { BACKEND_LOG_NAMING, createFileSink, MAIN_LOG_NAMING } from './logfile.ts';
import { installMockProbe } from './mock-probe.ts';
import { buildMonitorJsonConfig, loadMonitorInfo, type MonitorJsonConfig } from './monitor-info.ts';
import { installNetworkGuard, redactUrl } from './network-guard.ts';
import { type AppPaths, clearDebugFlag, debugFlagSet, resolveAppPaths, selfDesktopFile, USER_DATA_NAME, userRuntimeDir } from './paths.ts';
import { ExperimentalSettings } from './experimental.ts';
import type { ExperimentalState } from './shared/channels.ts';
import { VENDOR_APP_VERSION } from './shared/store-schema.ts';
import { ConfigStore } from './store.ts';
import { TrayController } from './tray.ts';
import { trayHostAvailable } from './tray-host.ts';
import { normalizeLanguage } from './tray-i18n.ts';
import { MainWindowController, NoticeWindowController } from './windows.ts';

/** Hard stop after Exit, like the vendor's 1 s fallback, with room for the hub's close grace period. */
const EXIT_DEADLINE_MS = 3000;

class EvniaApp implements IpcHost {
  readonly log: Logger;
  readonly paths: AppPaths;
  readonly store: ConfigStore;
  readonly guard: PathGuard;
  readonly gate: DeviceChangeGate;
  readonly hubToken = generateHubToken();
  main!: MainWindowController;
  notice!: NoticeWindowController;
  readonly #openAsHidden = process.argv.includes('--openAsHidden');
  readonly #isFirstRun: boolean;
  readonly #tray: TrayController;
  readonly #backend: BackendHost;
  readonly #capture: ElectronCaptureHost;
  readonly #foreground: X11ForegroundTracker;
  readonly #usb: LibusbBackend;
  /** 20-monitor-io §3.5 mode snapshots; null with EVNIA_MOCK_MONITOR (the simulated monitor has its own mode). */
  readonly #displayModes: DisplayModeProvider | null;
  /** PATH_APP_TEMP: Comm_GenAppIcon writes there (backend), local: serves it (main). */
  readonly #appTempDir = defaultAppTempDir(process.env);
  /** The port's experiments (config.json linuxExperimental): the "Fast LED upload (experimental)" checkbox. */
  readonly #experimental: ExperimentalSettings;
  #language: string;
  #monitorConfig: MonitorJsonConfig | null = null;
  #appReady = false;
  #trayExitDisabled = false;
  #trayFunctionDisabled = true;
  #exiting: Promise<void> | null = null;
  #stopUsbWatch: (() => void) | null = null;
  #displayWatchers: LineWatcher[] = [];

  constructor(paths: AppPaths, log: Logger, backendLog: Logger) {
    this.paths = paths;
    this.log = log;
    nativeTheme.themeSource = 'dark';
    this.store = new ConfigStore(join(paths.userData, 'config.json'), log.child('store'));
    this.#isFirstRun = this.#markFirstRun();
    const lang = normalizeLanguage(this.store.get('language'));
    if (lang.changed) {
      log.warn(`Configuration language '${String(this.store.get('language'))}' is not adapted, reset to ${lang.language}`);
      this.store.set('language', lang.language);
    }
    this.#language = lang.language;
    this.guard = new PathGuard({ readRoots: [paths.userData, paths.serveDataDir, paths.resourcesDir], scratchDir: paths.userData });
    this.gate = new DeviceChangeGate((name) => this.#deviceEvent(name), log.child('device'));
    this.#tray = new TrayController(paths.resourcesDir, log.child('tray'), {
      isOptionEnabled: (exitOnly) => this.#isTrayOptionEnabled(exitOnly),
      show: () => this.#showMainWindow(),
      rescan: () => {
        this.#showMainWindow();
        if (this.#appReady) this.main.send('rescan');
      },
      settings: () => {
        this.#showMainWindow();
        this.main.send('toPageView', 'setting');
      },
      exit: () => void this.exitApp(),
      titleOpensDevTools: () => app.isPackaged && debugFlagSet(paths.debugFlag),
      openDevTools: () => this.main.toggleDevTools(),
    });
    const env = process.env;
    const run = createCommandRunner(env);
    const mockMonitor = mockMonitorFromEnv(env);
    this.#capture = new ElectronCaptureHost({ paths, log: log.child('capture'), wayland: isWaylandSession(env) });
    this.#foreground = new X11ForegroundTracker({ log: log.child('foreground'), selfExe: process.execPath, run });
    this.#usb = new LibusbBackend({ log: backendLog.child('usb') });
    this.#displayModes = mockMonitor
      ? null
      : new DisplayModeProvider({
          log: log.child('displayMode'),
          run,
          env,
          drm: createDrmSource(log.child('displayMode')),
          electronDisplays: () => screen.getAllDisplays(),
        });
    const idleSource = new IdleTimeSource({
      log: log.child('idle'),
      electronIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      mutter: useMutterIdle(env),
      run,
    });
    // Test probe of the simulated hardware (e2e walkthrough): mock mode only, never with real hardware.
    // Like the display mode, the input idle time is then part of the simulated environment.
    const probe = mockMonitor
      ? installMockProbe(globalThis, () => this.#backend.backend, {
          deviceEvent: (name) => this.gate.trigger(name),
          // what the backend asked of the capture host (Follow video speed tiers)
          capture: () => this.#capture.videoStats,
        })
      : null;
    const idle = probe ? { seconds: () => probe.idleSeconds(() => idleSource.seconds()) } : idleSource;
    this.#backend = new BackendHost({
      host: createHostServices({
        log: backendLog,
        paths,
        capture: this.#capture,
        foreground: this.#foreground,
        idle,
        displayModes: this.#displayModes,
        guard: this.guard,
      }),
      log: log.child('backendService'),
      token: this.hubToken,
      // One libusb context per process: the VIA bridges, the ENE and main's USBChange events share it.
      usb: this.#usb,
      mockMonitor,
      appTempDir: this.#appTempDir,
      // The Ambiglow page's "Fast LED upload (experimental)" checkbox, as stored: the backend starts with it.
      eneFrameBurst: () => this.#experimental.eneFrameBurst,
    });
    // ...and follows every change of the stored setting (experimental.ts): config.json is the one source of truth.
    this.#experimental = new ExperimentalSettings({
      store: this.store,
      backend: this.#backend,
      forcedByEnv: eneFrameBurstFromEnv(process.env),
      log: log.child('experimental'),
    });
    if (mockMonitor) log.info(`EVNIA_MOCK_MONITOR=${mockMonitor}: simulated monitor, no hardware access`);
  }

  run(): void {
    app.on('second-instance', () => {
      this.log.info('On second-instance');
      this.#showMainWindow();
    });
    app.on('render-process-gone', (_e, wc, details) => this.log.error('Render progress gone', wc.id, details));
    app.on('child-process-gone', (_e, details) => this.log.error('Child progress gone', details));
    app.on('before-quit', (e) => {
      if (this.#exiting) return;
      e.preventDefault();
      void this.exitApp();
    });
    app.whenReady().then(
      () => this.#onReady(),
      (e: unknown) => this.log.error('App failed to start', e),
    );
  }

  async #onReady(): Promise<void> {
    const log = this.log;
    const debug = debugFlagSet(this.paths.debugFlag);
    log.info(`App ready, version ${VENDOR_APP_VERSION} (Linux port ${app.getVersion()}, Electron ${process.versions.electron})`);
    // file: only below the app tree (vendor-ui/, capture/): the renderer never reads user files through file:.
    installNetworkGuard(session.defaultSession, { log: log.child('net'), hubPort: () => this.#backend.port, fileRoots: [this.paths.appRoot] });
    app.on('web-contents-created', (_e, wc) => {
      wc.setWindowOpenHandler(({ url }) => {
        log.warn(`Blocked window.open to ${redactUrl(url)}`);
        return { action: 'deny' };
      });
    });
    protocol.handle(
      LOCAL_SCHEME,
      createLocalProtocolHandler(
        {
          roots: [this.paths.imageCacheDir, join(this.paths.serveDataDir, 'Theme'), this.paths.resourcesDir, this.paths.vendorUiDir],
          // Comm_GenAppIcon staging: the backend's PATH_APP_TEMP, the same directory (backend-host.ts appTempDir).
          privateRoots: [this.#appTempDir],
        },
        log.child('local'),
      ),
    );
    this.#displayModes?.refresh();
    this.#watchDevices();

    const trayAvailable = trayHostAvailable();
    void trayAvailable.then((ok) => {
      if (!ok) log.warn('No system tray host found (GNOME needs the AppIndicator extension); closing the window will quit');
    });
    // A hidden window without a tray icon could only be reached by launching the app again, so the
    // login autostart's --openAsHidden (01 §3.4) shows the window when no tray host exists.
    let openAsHidden = this.#openAsHidden;
    if (openAsHidden && !(await trayAvailable)) {
      log.warn('--openAsHidden ignored: no system tray to reach the hidden window from');
      openAsHidden = false;
    }

    this.main = new MainWindowController({
      paths: this.paths,
      store: this.store,
      log,
      openAsHidden,
      isFirstRun: this.#isFirstRun,
      devTools: !app.isPackaged || debug,
      allowReload: !app.isPackaged,
      onReadyToShow: () => {
        if (!this.#appReady) this.#start();
      },
      onCloseRequested: () => this.requestClose(),
    });
    this.notice = new NoticeWindowController({ paths: this.paths, store: this.store, log: log.child('notice') });
    this.notice.create();
    this.#tray.create(this.#language);
    registerIpcHandlers(this, {
      ipcMain,
      dialog,
      focusedWindow: () => BrowserWindow.getFocusedWindow(),
      windowOf: (wc) => BrowserWindow.fromWebContents(wc),
    });
    if (debug) this.main.window.webContents.openDevTools({ mode: 'undocked' });
    try {
      await this.main.load();
    } catch (e) {
      log.error('Main window failed to load', e);
    }
  }

  /** Vendor start() (01 §3.4) without the update prompt and the resource-patch check. */
  #start(): void {
    this.#appReady = true;
    this.main.start();
    this.#applyAutostart();
  }

  // ───────────── IpcHost ─────────────

  runConfig(): RunConfig {
    return {
      appVersion: VENDOR_APP_VERSION,
      isDebugMode: debugFlagSet(this.paths.debugFlag),
      isFirstRun: this.#isFirstRun,
      // The renderer uses isPackaged to pick the production asset layout (02 §11.3) and the patchPath
      // translation override; the port always ships the production renderer, never a dev server.
      isPackaged: true,
      mac: '',
      patchPath: this.paths.patchPath,
      // Only compared with the app picker's result ("CannotBindSelf"), which picks .desktop files on Linux.
      processPath: selfDesktopFile(process.env),
      userDataPath: this.paths.userData,
    };
  }

  startBackend(): Promise<number> {
    return this.#backend.ensureStarted();
  }

  monitorJsonConfig(): MonitorJsonConfig {
    this.#monitorConfig ??= buildMonitorJsonConfig(
      loadMonitorInfo(this.paths.bundledMonitorInfo, this.paths.userMonitorInfo, this.log.child('monitorInfo')),
    );
    return this.#monitorConfig;
  }

  onInterfaceInitializeCompleted(): void {
    this.#trayFunctionDisabled = false;
    this.#tray.refresh();
    this.main.onInterfaceInitializeCompleted();
  }

  /**
   * Window close (title bar, window manager or the renderer's close button). The vendor always hid
   * to the tray (01 §3.5); without a tray host the hidden window would be unreachable, so the app quits.
   */
  requestClose(): void {
    if (this.#exiting) return;
    void (async () => {
      if (this.main.uiAvailable && (await trayHostAvailable())) this.main.hide();
      else {
        this.log.info('No tray available: closing the main window quits the app');
        await this.exitApp();
      }
    })();
  }

  setLanguage(language: string): void {
    this.#language = normalizeLanguage(language).language;
    this.#tray.setLanguage(this.#language);
    this.notice.relayLanguage(language);
  }

  setAutoStartUp(enabled: boolean | undefined, minimized: boolean | undefined): void {
    if (enabled !== undefined) this.store.set('autoStartup', enabled);
    if (minimized !== undefined) this.store.set('autoStartupMinimize', minimized);
    this.#applyAutostart();
  }

  setTrayFlags(flags: { exitDisabled?: boolean; functionDisabled?: boolean }): void {
    if (flags.exitDisabled !== undefined) this.#trayExitDisabled = flags.exitDisabled;
    if (flags.functionDisabled !== undefined) this.#trayFunctionDisabled = flags.functionDisabled;
    this.#tray.refresh();
  }

  experimental(): ExperimentalState {
    return this.#experimental.state();
  }

  setEneFrameBurst(enabled: boolean): ExperimentalState {
    return this.#experimental.setEneFrameBurst(enabled);
  }

  // ───────────── exit ─────────────

  /** Vendor exitApp() (01 §3.5) minus the DtsServer kill; every step runs even if an earlier one fails. */
  exitApp(): Promise<void> {
    this.#exiting ??= (async () => {
      const deadline = setTimeout(() => app.exit(0), EXIT_DEADLINE_MS);
      const steps = appExitSteps({
        saveAndHideWindow: () => {
          if (!this.main || this.main.window.isDestroyed()) return;
          this.main.saveBounds();
          this.main.hide();
        },
        clearDebugFlag: () => clearDebugFlag(this.paths.debugFlag),
        tray: this.#tray,
        deviceEvents: [this.gate, ...this.#displayWatchers, ...(this.#displayModes ? [this.#displayModes] : [])],
        foreground: this.#foreground,
        capture: this.#capture,
        notice: this.notice ?? null,
        stopUsbWatch: this.#stopUsbWatch,
        backend: this.#backend,
      });
      await runExitSteps(steps, this.log);
      clearTimeout(deadline);
      this.log.info('Exit');
      app.exit(0);
    })();
    return this.#exiting;
  }

  // ───────────── internals ─────────────

  #isTrayOptionEnabled(exitOnly = false): boolean {
    return exitOnly ? !this.#trayExitDisabled : this.#appReady && !this.#trayExitDisabled && !this.#trayFunctionDisabled;
  }

  #showMainWindow(focus = true): void {
    this.log.info('Show main window', this.#appReady);
    this.main?.show(focus, this.#isTrayOptionEnabled());
  }

  #markFirstRun(): boolean {
    if (existsSync(this.paths.firstRunMarker)) return false;
    try {
      mkdirSync(this.paths.userData, { recursive: true });
      writeFileSync(this.paths.firstRunMarker, '');
    } catch (e) {
      this.log.error('Cannot create first-run marker', e);
    }
    return true;
  }

  /** Vendor setAutoStartUp(): re-applied on every start, packaged builds only (01 §3.4, §10.1 #18). */
  #applyAutostart(): void {
    if (!app.isPackaged) {
      this.log.debug('Autostart not applied (unpackaged build)');
      return;
    }
    applyAutostart({
      enabled: this.store.get('autoStartup') === true,
      minimized: this.store.get('autoStartupMinimize') === true,
      command: [process.execPath],
      dir: autostartDir(),
      log: this.log.child('autostart'),
    });
  }

  /**
   * Event sources of 01 §9 on Linux (20-monitor-io-linux-consolidation §5):
   * - `screen` replaces WM_DISPLAYCHANGE (resolution, scale and rotation changes; work-area-only
   *   changes such as a dock resizing are not display changes);
   * - udev drm/i2c-dev events and Mutter's MonitorsChanged (display-watch.ts) add hotplug, link
   *   retrains and refresh-rate-only changes;
   * - libusb hotplug replaces node-usb attach/detach.
   * Display add/remove and USB events also feed otherDeviceChange, like WM_DEVICECHANGE did for USB
   * and monitor device nodes.
   * Every raw display event also refreshes the display-mode snapshot at once (display-sources.ts), so
   * the backend's re-read after the debounce and its settle time sees the new mode.
   */
  #watchDevices(): void {
    const onTopology = (what: string, d: Display) => {
      this.log.debug(what, d.id, d.label);
      this.#displayModes?.refresh();
      if (this.main?.interfaceInitializeCompleted) this.main.applyMaximumSize();
      this.gate.trigger('displayChange');
      this.gate.trigger('otherDeviceChange');
    };
    screen.on('display-added', (_e, d) => onTopology('New display added:', d));
    screen.on('display-removed', (_e, d) => onTopology('Display removed:', d));
    screen.on('display-metrics-changed', (_e, _d, changed) => {
      if (!changed.some((c) => c === 'bounds' || c === 'scaleFactor' || c === 'rotation')) return;
      this.#displayModes?.refresh();
      this.gate.trigger('displayChange');
    });
    this.#displayWatchers = startDisplayWatchers({
      log: this.log.child('device'),
      onChange: (source) => {
        this.log.debug('Display event:', source);
        this.#displayModes?.refresh();
        this.gate.trigger('displayChange');
      },
    });
    this.#stopUsbWatch = this.#usb.onChange((kind, info) => {
      this.log.info(`USB ${kind}`, Date.now(), info.id);
      this.gate.trigger('USBChange');
      this.gate.trigger('otherDeviceChange');
    });
  }

  #deviceEvent(name: DeviceEventName): void {
    this.main?.send(name);
    if (name === 'USBChange') this.#backend.hotplug('usb');
    else if (name === 'displayChange') this.#backend.hotplug('display');
  }
}

// ───────────── bootstrap (01 §3.1) ─────────────

process.setSourceMapsEnabled(true);
// userData must be ~/.config/evnia like %APPDATA%\evnia, whatever productName says (01 §2).
app.setPath('userData', join(app.getPath('appData'), USER_DATA_NAME));
// Defense in depth behind the webRequest kill-switch: no host name resolves, only the loopback hub
// (an IP literal) is reachable, so even requests Chromium makes outside webRequest cannot go online.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
// Proxy dead-end (20-online-sweep-tail §10): Chromium ignores the system and environment proxy
// settings (no PAC download, no proxy connection), so a configured proxy is never contacted either.
app.commandLine.appendSwitch('no-proxy-server');
Menu.setApplicationMenu(null);

const paths = resolveAppPaths(app.getAppPath(), app.getPath('appData'), userRuntimeDir());
const level: LogLevel = debugFlagSet(paths.debugFlag) ? 'debug' : 'info';
const log = createLogger('main', createFileSink({ dir: paths.logsDir, naming: MAIN_LOG_NAMING, console: !app.isPackaged }), level);
const backendLog = createLogger(
  'backend',
  createFileSink({ dir: paths.backendLogsDir, naming: BACKEND_LOG_NAMING, console: !app.isPackaged }),
  level,
);
const indexLog = log.child('index');
// Node-side egress ban (egress-guard.ts): installed before the backend, the hub or any dependency can
// open a socket; webRequest and the switches above cover only Chromium's network stack.
installEgressGuard(log.child('egress'));
process.on('uncaughtException', (e, origin) => {
  indexLog.error(`An uncaught ${origin} error occurred!`);
  indexLog.error(e);
});
process.on('unhandledRejection', (reason) => indexLog.error('Unhandled rejection', reason));

if (!app.requestSingleInstanceLock()) {
  indexLog.info('requestSingleInstanceLock return false');
  app.quit();
} else {
  new EvniaApp(paths, log.child('app'), backendLog).run();
}
