# Evnia Precision Center for Linux: user guide

This is an unofficial, offline Linux port of Philips **Evnia Precision Center 1.13.0**. It controls a Philips Evnia monitor: picture modes (SmartImage and SmartImage HDR), game settings, input, audio, system and setup settings, profiles and themes, the dashboard overlay, and Ambiglow lighting.

It covers the monitor only. It makes no network connection, and it has no firmware updates, accounts or Philips peripherals. See [What was removed](#what-was-removed).

It was built for, and tested against a simulation of, the **Philips Evnia 34M2C8600** (EDID name `PHL 34M2C8600`, Realtek scaler). The vendor's model table lists other Evnia monitors too, but none of them has been tested.

> **Status.** Everything was verified against a simulated 34M2C8600 seeded from real Windows logs and settings, and the `.deb` was installed and started in clean Debian 13 and Ubuntu 24.04 containers. The port has **not yet run against the physical monitor**. On your first start, follow [First start on the real monitor](#first-start-on-the-real-monitor).

Contents:

1. [Requirements](#requirements)
2. [Connecting the monitor](#connecting-the-monitor)
3. [Installing](#installing)
4. [What the package sets up, and how to check it](#what-the-package-sets-up-and-how-to-check-it)
5. [First start](#first-start)
6. [Desktop notes (GNOME, Wayland, X11)](#desktop-notes-gnome-wayland-x11)
7. [Reset and Factory reset also reset the monitor](#reset-and-factory-reset-also-reset-the-monitor)
8. [Taking over your Windows profiles and settings](#taking-over-your-windows-profiles-and-settings)
9. [What was removed](#what-was-removed)
10. [Other differences from the Windows app](#other-differences-from-the-windows-app)
11. [Files and logs](#files-and-logs)
12. [Troubleshooting](#troubleshooting)
13. [Removing the package](#removing-the-package)
14. [Building from source](#building-from-source)

---

## Requirements

| | |
|---|---|
| Architecture | x86-64 (amd64) only |
| Distribution | Debian 13 "trixie" and Ubuntu 24.04 LTS are tested. The package also declares the pre-2024 library names (Debian 12, Ubuntu 22.04), but those systems are not tested. |
| Desktop | GNOME on Wayland or X11 is the target. Other desktops work, with the limits described under [Desktop notes](#desktop-notes-gnome-wayland-x11). |
| Monitor | A Philips Evnia monitor connected by DisplayPort or HDMI, plus the monitor's **USB upstream cable** to this computer (see [Connecting the monitor](#connecting-the-monitor)) |
| Recommended packages | Installed automatically by `apt` unless you turn Recommends off: `libglib2.0-bin` (gdbus), `x11-utils` (xprop), `x11-xserver-utils` (xrandr), `pulseaudio-utils` (parec, pactl), `libpipewire-0.3-0t64`, `xdg-desktop-portal`. Each one enables a feature; without it that feature is off (see the table in [Troubleshooting](#features-that-need-a-recommended-package)). |
| Optional | `gnome-shell-extension-appindicator` for a tray icon on vanilla GNOME. `ddcutil` for your own checks. |

No root access is needed to run the app, and you do not need to join any group.

## Connecting the monitor

The app reaches the monitor in two ways. It prefers the first one.

1. **USB-DDC over the USB upstream cable (preferred).** The monitor has a built-in USB hub. Inside it are a VIA Labs USB-DDC bridge (`2109:8884`) and the ENE Ambiglow LED controller (`0cf2:a201`). Both work only when the monitor's USB upstream port is connected to **this** computer. If the monitor has more than one upstream port and a KVM/USB-upstream setting, that setting must route the hub to this computer.
   - This path works whatever input the monitor is showing, and while the video link sleeps.
   - The Windows app used it for everything on this monitor.
2. **DDC/CI over the graphics card (fallback).** Without the USB cable the app talks to the monitor through the graphics card's i2c buses (`/dev/i2c-N`). Most settings work this way.
   - This path needs the video link to be active on the connector that shows this computer.
   - On the Windows side only a few commands were ever seen over this path, so it is less proven than USB-DDC.

**Ambiglow needs the USB cable for its full effect set.** With the ENE controller reachable, the app drives the LEDs itself: Follow video, Follow audio, Breathing with speed and brightness, per-region colours and the live preview. Without it, the Ambiglow page switches to the monitor's own built-in Ambiglow modes over DDC/CI, which have fewer options.

## Installing

Download or build the package (see [Building from source](#building-from-source)), then install it with `apt`, which also installs the libraries it needs:

```sh
sudo apt install ./evnia-precision-center_1.13.0-linux.3_amd64.deb
```

- Keep the `./`. Without it, apt looks for a package of that name in the archive.
- If apt prints `Download is performed unsandboxed as root … couldn't be accessed by user '_apt'`, it is only a notice: the file sits in your home directory. The installation still works.
- An upgrade is installed the same way. Your settings and profiles are kept.

The package installs:

| Path | What |
|---|---|
| `/opt/evnia-precision-center/` | The application (Electron 44, the patched vendor UI, the Linux backend) |
| `/usr/bin/evnia-precision-center` | Command to start it |
| `/usr/share/applications/evnia-precision-center.desktop` | Application menu entry "Evnia Precision Center" |
| `/usr/lib/udev/rules.d/70-evnia-precision-center.rules` | Device access for the logged-in user (below) |
| `/usr/lib/modules-load.d/evnia-precision-center-i2c.conf` | Loads the `i2c-dev` kernel module at boot |
| `/usr/share/doc/evnia-precision-center/README.Debian.gz`, `man evnia-precision-center` | Short documentation |

## What the package sets up, and how to check it

### What it sets up

- **udev rules** give the user at the local seat (`TAG+="uaccess"`) access to exactly:
  - the VIA USB-DDC bridge `2109:8884`. The rule also keeps this bridge out of USB autosuspend. Power tools such as TLP or `powertop --auto-tune` would otherwise stall the first request after an idle period;
  - the ENE Ambiglow controller `0cf2:a201`;
  - the i2c buses of display adapters (PCI class VGA or display controller), for the DDC/CI fallback.
  - The rules deliberately leave out the graphics card's SMBus and `AMDGPU SMU` buses (firmware controllers and EEPROMs), and every other VIA Labs device (ordinary USB hubs in docks and monitors). They stay root-only, as before.
- **i2c-dev**: the installer loads the module once (`modprobe i2c-dev`), and `modules-load.d` loads it at every boot.
- The installer then re-applies the rules to devices that are already plugged in (`udevadm trigger`), so no reboot is needed.
- `chrome-sandbox` is made root-owned and setuid. Chromium needs it where unprivileged user namespaces are restricted, such as Ubuntu 24.04's AppArmor policy.

### How to check it

Run these as your normal user. None of them changes anything.

```sh
# 1. The monitor's USB functions (needs the USB upstream cable)
lsusb -d 2109:8884     # VIA Labs USB-DDC bridge: must be listed
lsusb -d 0cf2:a201     # ENE Ambiglow controller: listed if the Ambiglow controller enumerated
lsusb -t               # topology: both sit below the monitor's VIA hubs

# 2. You have access to the bridge (look for "user:<you>:rw-"; getfacl is in the package acl)
getfacl /dev/bus/usb/$(lsusb -d 2109:8884 | awk '{print $2 "/" substr($4, 1, 3)}')

# 3. The i2c buses exist, and the display buses carry an ACL ("+" after the mode, e.g. crw-rw----+)
ls -l /dev/i2c-*
for a in /sys/bus/i2c/devices/i2c-*; do echo "$(basename "$a"): $(cat "$a/name")"; done
```

On an AMD graphics card the monitor's DisplayPort connector has an adapter named `AMDGPU DM aux hw bus N`, and usually also `AMDGPU DM i2c hw bus N`. Those should show the `+`. The `AMDGPU SMU` buses should not.

**Optional: ddcutil.** If you have `ddcutil` installed, you can check the DDC/CI fallback path independently. **Quit the app first**: the app and ddcutil do not coordinate their bus access.

```sh
ddcutil detect         # expect: Mfg id PHL, Model "PHL 34M2C8600"
ddcutil --bus N getvcp 10    # brightness, N from the detect output
```

ddcutil only uses the graphics-card path; it does not use the monitor's USB-DDC bridge.

If access is missing, see [Permissions](#permissions).

## First start

Start **Evnia Precision Center** from the application menu, or run `evnia-precision-center`.

- A small splash window appears, then the main window. Home shows a card **PHL 34M2C8600** with the monitor's picture.
- On the very first start, the app reads the monitor's capability string. That takes about 7 seconds over USB. The result is cached in `~/.config/EvniaServe/Config/data.json`, and later starts are faster.
- The first run shows the vendor's short tutorials on Home, the monitor pages and Dashboard. **Settings → Tutorials Reset** shows them again.
- **Start with the system** (Settings → General) is **off** by default, unlike on Windows. When you turn it on, the app writes `~/.config/autostart/evnia-precision-center.desktop` and starts minimised to the tray at login.
- Only one instance runs per user. Starting the app again brings the running window to the front.
- If Home says **Connect Your Evnia Device**, the monitor was not found. See [The monitor is not found](#the-monitor-is-not-found).

### First start on the real monitor

The port has not yet been run against the physical monitor. For the first session, go step by step:

1. Run the checks in [How to check it](#how-to-check-it).
2. Start the app and confirm the card on Home. **Settings → About Device** should show the model, `3440x1440` and your refresh rate.
3. Change something harmless and reversible: the Brightness slider on the SmartImage page, then set it back. Check that the monitor follows.
4. Try the Ambiglow page: switch the effect off and on, pick a colour.
5. Keep **Profile → Reset**, **Settings → Factory reset** and **Setup → Restore to factory settings** for later. They reset the monitor (see [below](#reset-and-factory-reset-also-reset-the-monitor)).
6. If anything misbehaves, collect the logs (see [Reporting a problem](#reporting-a-problem)).

## Desktop notes (GNOME, Wayland, X11)

### Tray icon on GNOME

The tray icon needs a StatusNotifier host. Vanilla GNOME has none, so it needs an extension:

- **Ubuntu** ships and enables its "Ubuntu AppIndicators" extension by default. Nothing to do.
- **Debian** and other GNOME installs: install `gnome-shell-extension-appindicator`, enable "AppIndicator and KStatusNotifierItem Support" in the Extensions app (or run `gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com`), log out and in, then restart the app.

Without a tray:

- closing the window **quits** the app (with a tray it hides to the tray, as on Windows);
- a start "minimised to tray" (the login autostart) shows the window instead of starting invisibly.

The tray menu has: Precision Center (show the window), Rescan, Settings, Exit.

### Ambiglow "Follow video" (screen capture)

Follow video samples the screen and sends its colours to the Ambiglow LEDs.

- **Wayland:** the first time you select Follow video in each app run, GNOME shows its **screen-sharing dialog** (the xdg-desktop-portal ScreenCast dialog). Choose the Evnia monitor and confirm.
  - Later uses in the same run reuse that permission. After an app restart the dialog appears once again: Electron cannot store the permission across runs.
  - While it runs, GNOME shows its screen-sharing indicator in the top bar. That is expected.
  - If you stop sharing from that indicator, the LEDs keep the last colours until you select Follow video again.
  - If you close or ignore the dialog, the start gives up after 60 seconds. Select Follow video again to get a new dialog.
  - This path needs PipeWire, `xdg-desktop-portal` and a portal backend (`xdg-desktop-portal-gnome` on GNOME). All of them are part of a normal GNOME installation.
- **X11:** there is no dialog. The app captures the **primary display**, as the Windows app did. If the Evnia is not your primary display, make it primary, or Follow video shows another screen's colours.

The capture is reduced to 50×40 pixels before it leaves the capture window. Nothing is recorded or stored.

#### Speed: how quickly the LEDs follow the screen

With the Ambiglow controller connected over USB, the Ambiglow page shows a **Speed** slider for Follow video (the Windows app has none). It controls how often the screen is sampled and how soon the colours reach the LEDs:

| Speed | What it does | LED updates per second | LEDs behind the picture |
|---|---|---|---|
| **Low** | The Windows app's timing: a new sample every 0.3 s, sent on a fixed 0.1 s tick | about 3 | about 0.25 s on average, up to about 0.5 s: the same as the Windows app |
| **Normal** (default) | A sample every 0.1 s, sent to the LEDs as soon as it is taken | 10 | about 0.1 s on average, up to about 0.17 s |
| **High** | 25 samples per second; the newest is sent whenever the controller is free | about 15 | about the same as Normal, but smoother |

The delay is the wait for the next sample, plus Low's tick, plus the time the controller needs to take the update (about 65 ms). Each sample is taken the moment the screen is grabbed, as in the Windows app. So High mainly makes the colours change more smoothly; it does not shorten the delay much. The delay of the monitor's own picture is not included.

- **High uses noticeably more CPU**, because the screen is captured and scaled 25 times per second. It keeps sending even while the screen does not change. If your computer is busy, or runs on battery, prefer Normal.
- While the LEDs are off because you are away from the computer ("turn off lights when idle"), or while the Ambiglow controller is gone for a moment (monitor standby), the screen capture **slows to one sample per second** in every speed. It keeps running, so no new screen-sharing dialog appears when the lights come back.
- The change applies immediately, while Follow video keeps running. **On Wayland, changing the speed does not show the screen-sharing dialog again**: the running screen capture is kept.
- The speed is saved in the current profile, like the speed of the other effects. Profiles copied from Windows start at Normal, because the Windows app saves Normal (and ignores the value).
- Without the USB Ambiglow controller, the monitor itself runs Follow video (see [The Ambiglow controller is missing](#the-ambiglow-controller-is-missing)). The Speed slider on that page is the monitor's own, and it is disabled for Follow video, as in the Windows app.

#### Brightness: dimming the Follow video colours

With the Ambiglow controller connected over USB, the Ambiglow page also shows a **Brightness** slider for Follow video (the Windows app has none). The app dims the screen colours before it sends them to the LEDs:

| Brightness | The LEDs show |
|---|---|
| **Bright** | the screen colours at one third |
| **Brighter** | the screen colours at two thirds |
| **Brightest** (default) | the screen colours as they are, as in the Windows app |

- The change applies at once, even while the picture does not change, and Follow video keeps running: no new screen-sharing dialog on Wayland.
- The preview on the page shows the dimmed colours. Like for every effect, the preview also fades its light layer with the slider (to 40 % at Bright, 70 % at Brighter), so at Bright and Brighter it looks clearly fainter than the LEDs. The LEDs show exactly the dimmed colours of the table.
- The level is saved in the current profile, like the brightness of the other effects. Profiles copied from Windows start at Brightest, because the Windows app saves Brightest.
- Without the USB Ambiglow controller there is no such slider for Follow video; the monitor itself decides.

#### Fast LED upload (experimental)

Below the Speed slider, Follow video has a checkbox **Fast LED upload (experimental)**, off by default (the Windows app has none). The Ambiglow controller normally takes each LED update as six small USB writes of about 65 ms in total, as in the Windows app, which limits Speed High to about 15 updates per second. With the checkbox ticked, each update is **one USB transfer** of about 11 ms, which lets High reach its 25 updates per second.

- It is **untested on a real monitor**: it relies on how the controller stores the colours, which is not confirmed. If the LEDs show wrong colours, flicker or freeze, **untick it**. The change applies from the next update, while Follow video keeps running.
- If the controller refuses the single transfer, the app goes back to the six writes by itself after three failures in a row, and says so in the backend log (see [Follow video lags behind the picture](#follow-video-lags-behind-the-picture)). The checkbox stays ticked; untick and tick it again to try once more.
- The choice is kept for the next start, in `~/.config/evnia/config.json` as `"linuxExperimental": {"eneFrameBurst": true}`. It applies to every profile. The Windows app ignores that entry.
- The checkbox appears only with the USB Ambiglow controller and with Follow video selected, and it is greyed out while the effect is switched off.
- If the app was started with `EVNIA_ENE_FRAME_BURST=1` in its environment (the older way to switch it on), the checkbox shows ticked and greyed out, with a note: the environment variable wins for that run. Start the app without it to decide with the checkbox again.

### Ambiglow "Follow audio"

Follow audio makes the LEDs react to what your computer plays. It records the **monitor of the default output device** (the playback signal), never a microphone.

- It uses `parec` from `pulseaudio-utils` and works with PulseAudio and with PipeWire (through pipewire-pulse, the default on Debian 13 and Ubuntu 24.04).
- It follows a change of the default output, and shows no level while the output is muted.
- GNOME may show its microphone indicator while Follow audio runs, because GNOME counts every recording stream.

### Themes bound to applications (X11 only)

**Profile → Applications** lets you create a theme that switches automatically when a given application comes to the foreground.

- The app picker opens `/usr/share/applications`: pick the application's `.desktop` file (Flatpak and Snap apps have theirs under `/var/lib/flatpak/exports/share/applications`, `~/.local/share/flatpak/exports/share/applications` and `/var/lib/snapd/desktop/applications`). You can also pick an executable.
- The app recognises the application by its window class, desktop-file name, executable, Flatpak ID or Snap name.
- When a different application comes to the front, the theme switches back to **User**, as on Windows.
- **On Wayland this does not work**: a Wayland session does not tell applications which window is active, so the themes never switch automatically. You can still switch themes by hand.
- The app only watches the active window while at least one application-bound theme exists (or a theme other than User is current). Otherwise it does not follow focus changes at all.

### Idle lights-off

Settings → General → **Idle for …** switches the Ambiglow off after the chosen number of minutes without keyboard or mouse input, and back on at the next input.

- On GNOME Wayland the idle time comes from GNOME Shell's idle monitor.
- Everywhere else it comes from the display server.

### Other desktop notes

- The resolution and refresh rate shown in the app (About Device, the dashboard overlay) come from GNOME's display configuration, `xrandr` on X11, or the kernel's display state.
- The small notification toast (used by the vendor for peripheral notices) cannot be positioned on Wayland. It does not matter for the monitor.
- DevTools and reload shortcuts are disabled, except in debug mode (see [Debug logging](#debug-logging)).

## Reset and Factory reset also reset the monitor

**Important.** Like the Windows application, three functions send the monitor the DDC/CI command **"Restore factory defaults" (VCP 0x04 = 1)**:

| Where | What it does |
|---|---|
| **Profile → Reset** (the reset icon of the active profile) | Resets the monitor to its factory settings, then saves the monitor's new values into the current profile. |
| **Settings → Factory reset** | Resets the monitor **and** deletes the app's themes, profiles, macros and settings in `~/.config/EvniaServe`, keeping only the `logs` folder, then recreates the defaults (theme User, profile Default). |
| **Monitor → Setup → Restore to factory settings** | The monitor's own factory reset, as its label says. |

What that means:

- Every OSD picture setting of the monitor returns to its factory value. That covers the SmartImage mode values, brightness, contrast, colour, and the monitor's own Ambiglow settings, among others.
- The app waits 5 seconds and then reads the monitor again. The whole operation takes about 6 to 10 seconds, and the monitor may blank briefly.
- Factory reset also deletes the cached capability string, so the next start reads it again (about 7 s).
- Export any profile you want to keep (**Profile → Export**) before using any of these resets.

The small reset icon on the **SmartImage** page is different: it resets only the current picture mode's values, not the whole monitor. **Settings → Tutorials Reset** only shows the tutorials again.

## Taking over your Windows profiles and settings

The Linux app uses the same file formats as the Windows app, so files can be copied in both directions.

| Windows | Linux | Content |
|---|---|---|
| `%APPDATA%\EvniaServe\Theme\` | `~/.config/EvniaServe/Theme/` | Themes, profiles (`*.pcenter`), macros, the theme index `DataTheme.cfg` |
| `%APPDATA%\EvniaServe\Config\SoftConfig.data` | `~/.config/EvniaServe/Config/SoftConfig.data` | Idle lights-off settings |
| `%APPDATA%\evnia\config.json` | `~/.config/evnia/config.json` | UI settings: language, Home view, dashboard overlay, tutorials, window size |

`%APPDATA%` is `C:\Users\<name>\AppData\Roaming`. If `XDG_CONFIG_HOME` is set, it replaces `~/.config`.

### Copying the profiles (recommended)

1. **Quit the Linux app** (tray → Exit, or close the window when there is no tray).
2. Back up the Linux folder if the app has run before: `mv ~/.config/EvniaServe/Theme ~/.config/EvniaServe/Theme.bak`
3. Copy the Windows `Theme` folder, for example from a mounted Windows partition:

   ```sh
   mkdir -p ~/.config/EvniaServe
   cp -r "/mnt/windows/Users/<name>/AppData/Roaming/EvniaServe/Theme" ~/.config/EvniaServe/
   ```

4. Optionally copy `SoftConfig.data` and `config.json` the same way.
   - `config.json` also carries the Windows **Start with the system** setting. If it was on in Windows, the Linux app will add a login autostart entry.
   - `Config/data.json` (the capability cache) and the `logs` folders are not needed.
5. Start the app. Your profiles appear under **Profile**, and your themes in the theme selector.

What carries over and what does not:

- Monitor settings in profiles apply to the same model name only (`PHL 34M2C8600`), as on Windows.
- Themes bound to a **Windows** application (`C:\…\app.exe`) keep the theme, but the binding is dropped. Bind the theme again to a Linux application (X11 only).
- Macros belong to Philips mice and keyboards, which the port does not support. They are kept but have no use.
- A damaged `DataTheme.cfg` is not overwritten silently: it is renamed to `DataTheme.cfg.corrupt-<time>`, and the defaults are created.

### Importing single profiles

Instead of copying folders, use **Profile → Export** in the Windows app to save a `.pcenter` file, then **Profile → Import** in the Linux app. Files up to 20 MiB are accepted, which is the vendor's own limit. Exports from the Linux app can be imported on Windows as well.

## What was removed

| Feature | Status in the port |
|---|---|
| Online account, login, cloud profile/macro sharing | Removed. The account entry, the login dialog and the cloud rows of Import/Export are gone. |
| App updates and update checks | Removed (About page, tray, notifications). Install a newer `.deb` instead. |
| **Monitor firmware update (OTA)** | Removed. The FwUpdate tab is hidden, and the backend refuses any firmware flash. No flashing code ships. |
| Feedback form | Removed |
| Philips peripherals (mice, keyboards, headsets, mouse pads), pairing tool | Not supported. Peripheral pages are unreachable because no peripheral is ever listed. |
| SmartDesktop (window layouts) | Removed |
| DTS headphone audio | Removed |
| AmbiScape smart bulbs (Wi-Fi/Matter) | Removed. The Settings entry and the bulb pages are gone. |
| External links (vendor website, licence links) | They do nothing. The licence names are still shown. |
| Product image downloads | Removed. The images of the supported models are bundled. |

A network kill-switch blocks every request that is not local and logs it. The app's internal connection between its UI and its backend is bound to 127.0.0.1 and protected by a per-launch token. The Windows app accepted unauthenticated connections from the network on port 10010.

## Other differences from the Windows app

- Start with the system is off by default. Without a tray icon, closing the window quits the app.
- Ambiglow Follow video has a **Speed** slider (with the USB Ambiglow controller). Low is the Windows app's timing and delay. The default, Normal, updates the LEDs three times as often, with less than half the delay. See [Speed](#speed-how-quickly-the-leds-follow-the-screen).
- Ambiglow Follow video has a **Brightness** slider (with the USB Ambiglow controller) that dims the colours to one or two thirds; the default, Brightest, is the Windows app's. See [Brightness](#brightness-dimming-the-follow-video-colours).
- Ambiglow Follow video has an opt-in **Fast LED upload (experimental)** checkbox (with the USB Ambiglow controller), off by default. See [Fast LED upload](#fast-led-upload-experimental).
- The application picker for app-bound themes offers `.desktop` files instead of `.exe` files.
- Export always adds `.pcenter` / `.macro` to the file name you type, as the Windows dialog did.
- The app can read only the files you pick in its dialogs and its own data folders. It can write only the file you choose in the export dialog.
- The logs are appended to, not overwritten at each start. The debug flag lives in your private runtime directory (see [Debug logging](#debug-logging)).
- Whether the app shows the SmartImage HDR page follows the monitor's current picture mode, not the desktop's HDR setting.
- Settings you change with the monitor's own OSD buttons are not seen by the app until it reads the monitor again: press **Sync** in the monitor sidebar. The Windows app behaves the same.

## Files and logs

| Path | Content |
|---|---|
| `~/.config/evnia/config.json` | UI settings (electron-store format, like `%APPDATA%\evnia\config.json`) |
| `~/.config/evnia/logs/YY-MM-DD.log` | **Application log** (window, tray, capture, device events, blocked requests). Rotated at 20 MiB; files older than 5 days are deleted. |
| `~/.config/EvniaServe/Theme/` | Themes, profiles, macros, `DataTheme.cfg` |
| `~/.config/EvniaServe/Config/` | `SoftConfig.data` (idle settings), `data.json` (capability cache), `color.data` |
| `~/.config/EvniaServe/logs/YYYY-MM-DD.txt` | **Backend log** (monitor discovery, DDC/CI, Ambiglow, profiles) |
| `~/.config/autostart/evnia-precision-center.desktop` | Only when Start with the system is on |
| `$XDG_RUNTIME_DIR/evnia/` | Lock files that keep the app and its command-line tool from talking to the monitor at the same time |
| `$XDG_RUNTIME_DIR/EvniaServe/` | Temporary application icons for app-bound themes (icons older than 24 h are removed at the next start) |

## Troubleshooting

### The monitor is not found

Home shows **Connect Your Evnia Device**.

1. Check the cables. You need the video cable, and for the preferred path the USB upstream cable to this computer (see [Connecting the monitor](#connecting-the-monitor)).
2. Run the checks in [How to check it](#how-to-check-it).
   - If `lsusb -d 2109:8884` lists nothing, the USB path is not available. Check the cable and the monitor's KVM/USB-upstream setting.
   - If `/dev/i2c-*` does not exist, load the module: `sudo modprobe i2c-dev`.
3. Click **Rescan** in the tray menu or on Home.
4. Look at the backend log `~/.config/EvniaServe/logs/<today>.txt`. Each problem found during discovery is logged with a hint, for example `no permission on /dev/i2c-N: udev uaccess rule / i2c group`.
5. The app recognises Philips monitors (`PHL` in the EDID) that appear in the vendor's model table. Other brands are ignored.

### Permissions

Symptoms:

- `getfacl` does not list your user;
- the log mentions `LIBUSB_ERROR_ACCESS`, `EACCES` or "udev rules";
- the Ambiglow falls back to DDC/CI with a warning that names the udev rule.

The rules apply to the user **logged in at the local seat** (the active graphical session). A second user who is not active, and SSH sessions, get no access. That is intended.

Fixes, in order:

1. Re-plug the monitor's USB upstream cable, or log out and in again.
2. Re-apply the rules by hand:

   ```sh
   sudo udevadm control --reload-rules
   sudo udevadm trigger --action=change --subsystem-match=usb --attr-match=idVendor=2109 --attr-match=idProduct=8884
   sudo udevadm trigger --action=change --subsystem-match=usb --attr-match=idVendor=0cf2 --attr-match=idProduct=a201
   sudo udevadm trigger --action=change --subsystem-match=i2c-dev
   ```

3. Check that the rule file exists: `ls /usr/lib/udev/rules.d/70-evnia-precision-center.rules`. A local rule in `/etc/udev/rules.d/` with the same name would override it.

Do not run the app with `sudo`. It would create root-owned files in your home directory.

### "ddcci" kernel driver (EBUSY)

If the out-of-tree `ddcci` driver (package `ddcci-dkms`, used for brightness sliders on external monitors) is loaded, it claims the monitor's DDC/CI address on the i2c bus. The backend log then says:

```
/dev/i2c-N: slave 0x37 is claimed by a kernel driver (usually ddcci); using I2C_SLAVE_FORCE like ddcutil.
```

- The app keeps working over i2c, but that driver's own traffic, such as brightness changes through the desktop's brightness slider, can collide with the app's.
- This only concerns the i2c fallback. The USB-DDC path is not affected.

If you see failed or wrong values:

- use the USB cable, so the app uses USB-DDC; or
- unload the driver while you use the app: `sudo modprobe -r ddcci_backlight ddcci`; or
- blacklist it permanently.

The same applies to other DDC/CI tools and GNOME brightness extensions based on ddcutil (and `ddcutil-service`). They do not coordinate with this app.

### The Ambiglow controller is missing

`lsusb -d 2109:8884` lists the bridge, but `lsusb -d 0cf2:a201` lists nothing.

- The Ambiglow controller sits behind a second small hub inside the monitor (`2109:2211`, the USB 2.0 half; its USB 3 half is `2109:0211`). On the Windows side there was a day when only the USB 3 half enumerated, so the controller was missing.
- `lsusb -t` shows this case as `2109:0211` without `2109:2211`.
- Power-cycle the monitor (switch it off at the power button or unplug its power for a few seconds), or re-plug the USB upstream cable.
- Meanwhile the Ambiglow works with the monitor's own modes over DDC/CI. A few effects and the preview are then missing, and some functions answer "Not Support ENE".

### Follow video does not start

- On Wayland, the screen-sharing dialog may have been cancelled or ignored for 60 seconds. Select Follow video again.
- Check that `xdg-desktop-portal` and `xdg-desktop-portal-gnome` are installed, and that PipeWire runs (`systemctl --user status pipewire`).
- On X11, make the Evnia the primary display (see [Follow video](#ambiglow-follow-video-screen-capture)).
- The application log shows what happened, for example `capture video-started`, `Screen capture was not granted (no source selected)` or `Screen capture did not start within 60000 ms; giving up`.

### Follow video lags behind the picture

- Set **Speed** to Normal or High on the Ambiglow page while Follow video is selected (see [Speed](#speed-how-quickly-the-leds-follow-the-screen)). Low is the Windows app's timing, which lags by up to about half a second.
- The backend log (`~/.config/EvniaServe/logs/`) shows the speed in use, for example `FollowVideo speed High: screen capture every 40 ms, LED upload of every new frame`. The application log shows `Screen capture interval 40 ms (same session)` when the running capture was changed.
- The application log should show `capture video-started: …; sampling each new source frame`. If it shows `sampling a <video> element every … ms` instead, this Electron build lacks the interface the app uses to take each screen frame as it arrives. The colours then lag by up to one more sample interval (up to about 0.3 s more at Low). Please report it.

**Experimental: one USB transfer per LED update.** At High the controller is the limit: each LED update is six small USB writes of about 65 ms in total, as in the Windows app. Tick **Fast LED upload (experimental)** below the Speed slider to send each update as one transfer instead, which could allow the full 25 updates per second (see [Fast LED upload](#fast-led-upload-experimental)). It is **untested on a real monitor**. What the logs show:

- the backend log: `"Fast LED upload (experimental)" on: Follow video frames go to the ENE as one control transfer at 0xE300 from the next frame` when you tick it, and `Experimental ENE frame burst on ("Fast LED upload (experimental)")` near its start when it was ticked at the last run;
- if the controller refuses the single transfer, the warning `the experimental frame burst ("Fast LED upload (experimental)" / EVNIA_ENE_FRAME_BURST=1) failed`, and after three failures in a row `frame burst failed 3 times in a row; switched off`: the app then uses the six writes again by itself, until you untick and tick the checkbox.

If the LEDs show wrong colours, flicker or freeze, untick the checkbox. **If you cannot reach it** (the app does not show its window, say), quit the app and turn it off in the file:

```sh
# ~/.config/evnia/config.json: set "eneFrameBurst" to false, or delete the "linuxExperimental" entry
sed -i 's/"eneFrameBurst": true/"eneFrameBurst": false/' ~/.config/evnia/config.json
```

Then start the app normally, without `EVNIA_ENE_FRAME_BURST` in its environment: that variable (`EVNIA_ENE_FRAME_BURST=1 evnia-precision-center`, the older way to try it for one run) turns the single transfer on whatever the checkbox says, and the backend log then shows `Experimental ENE frame burst on (EVNIA_ENE_FRAME_BURST=1, …)` near its start. Please report the result either way (see [Reporting a problem](#reporting-a-problem)).

### Follow audio shows nothing

- `parec` must be installed: `sudo apt install pulseaudio-utils`.
- A sound server must run: `pactl info` must answer.
- If the default output is muted, the level is 0.
- The application log says `Follow-audio capturing the default sink monitor` when it works.

### Features that need a recommended package

| Missing tool | Package | Effect |
|---|---|---|
| `parec`, `pactl` | `pulseaudio-utils` | No Follow audio |
| `gdbus` | `libglib2.0-bin` | On GNOME: no resolution/refresh from GNOME, no refresh-rate change events, idle time on Wayland less reliable, no tray detection through D-Bus |
| `xrandr` | `x11-xserver-utils` | On X11: resolution/refresh come from the fallback sources |
| `xprop` | `x11-utils` | On X11: no app-bound theme switching |
| `libpipewire-0.3` | `libpipewire-0.3-0t64` | On Wayland: no Follow video |
| portal | `xdg-desktop-portal` (+ `-gnome`) | On Wayland: no Follow video |

### Values in the app do not match the monitor

- After you use the monitor's OSD buttons, press **Sync** in the monitor sidebar to read the monitor again.
- After a monitor power cycle, give the app a few seconds: it notices the USB and display changes, reconnects and reads the monitor again.

### The app crashes when it exits

Every exit currently ends with a crash signal (SIGTRAP) **after** the app has saved everything and stopped its backend.

- Where `systemd-coredump` is active, `coredumpctl list` shows one entry per exit.
- No data is lost.
- The cause is the USB library inside Electron's main process. See [MAINTAINING](MAINTAINING.md#known-defects).

### The app does not start: sandbox errors

If the terminal shows an error about the Chromium sandbox or `chrome-sandbox`, check that the helper is intact:

```sh
ls -l /opt/evnia-precision-center/chrome-sandbox   # expect -rwsr-xr-x root root
dpkg --verify evnia-precision-center               # no output = all files as installed
```

If not, reinstall the package. Do not start the app with `--no-sandbox`.

### Debug logging

1. Create the debug flag: `touch "$XDG_RUNTIME_DIR/evnia-debug-open.tmp"`
2. Start the app. Both logs now contain debug lines. The developer tools open in their own window at start, and **Alt+Shift+M** opens them again after you close them.
3. The flag is removed when the app exits, so the next start is normal again.

The flag counts only as a regular file owned by you.

### Command-line probe (read-only)

The DDC/CI layer has a command-line tool for checking the monitor. It is **not part of the `.deb`**. It runs from a source checkout (`port/`, after `npm ci`) with Node.js 22.18 or later:

```sh
cd port
npm run cli -- list            # connectors, i2c buses, USB-DDC bridges, ENE, and per path "DDC/CI ok" or "unusable"
npm run cli -- get 10          # read one VCP code (10 = brightness; e2a019 = Ambiglow mode)
npm run cli -- identity        # scaler, model, BOM, firmware version, serial
npm run cli -- caps            # the capability string (about 7 s over USB)
npm run cli -- get 10 --transport i2c   # force one path for get/caps/identity: via or i2c
```

- `list`, `get`, `identity` and `caps` only read.
- `set <code> <value>` writes, and is refused without `--yes`. You should not need it.
- Run it as your desktop user; the udev rules grant the access.
- It takes the same locks as the app, so it can run while the app is open.
- `--mock` runs it against the simulated monitor.

### Reporting a problem

Collect:

- `~/.config/evnia/logs/` and `~/.config/EvniaServe/logs/`, from a debug run if possible;
- the output of `lsusb -t` and of `ls -l /dev/i2c-*`;
- your desktop and session type (`echo $XDG_SESSION_TYPE`).

The logs contain your monitor's serial number and your local paths. Review them before you share them.

## Removing the package

```sh
sudo apt remove evnia-precision-center     # or: sudo apt purge evnia-precision-center
```

This removes every file of the package and the udev rules. The access granted to devices that are plugged in ends at the next re-plug or logout.

Your own files are left in place. Delete them yourself if you want:

- `~/.config/evnia`
- `~/.config/EvniaServe`
- `~/.config/autostart/evnia-precision-center.desktop`

## Building from source

The port's source contains no copy of the vendor application. The build takes the vendor's user interface and three data files from **your own copy** of the Windows application, patches them, and packages them with the Linux backend. The resulting `.deb` therefore contains vendor material: it is for your personal use only. Do not share it.

You need:

1. **The Evnia Precision Center 1.13.0 installation folder** from Windows (the folder containing `Evnia Precision Center.exe`). The build reads:
   - `resources/app.asar`;
   - `resources/bin/res/data/PCenter_DeviceInfo.json`;
   - `resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json`.

   Put the folder next to `port/` as `Evnia Precision Center/`, or point the build at it (see below). Only version 1.13.0 is accepted. Any other build fails with a clear message before anything is patched.
2. **Docker**. On Windows, Docker Desktop with Git Bash works.
3. **Network access once**, for the Docker base image and `npm ci`. The `npm ci` step downloads Electron. The build and the tests themselves need no network.

Steps, from the repository root:

```sh
# 1. The development image (Debian 13 with Node 22, Xvfb, dpkg tools, lintian)
docker build -t evnia-port-dev -f port/docker/Dockerfile.dev port/docker

# 2. Dependencies, installed inside the container so they are Linux builds
docker run --rm -v "$PWD:/repo" -w /repo/port evnia-port-dev bash -c 'npm ci'

# 3. Import the vendor UI, build, package
docker run --rm -v "$PWD:/repo" -w /repo/port evnia-port-dev \
  bash -c 'npm run import-ui && npm run build && npm run dist:deb'
# → port/dist/evnia-precision-center_1.13.0-linux.3_amd64.deb
```

- **Git Bash on Windows:** prefix each `docker run` with `MSYS_NO_PATHCONV=1`, and give the volume as a Windows path, e.g. `-v "C:\path\to\repo:/repo"`.
- **Linux host:** the container runs as root, so the files it creates in `port/` are owned by root. Afterwards run `sudo chown -R "$USER" port/build port/dist port/node_modules`.
- **Installation folder elsewhere:** use `npm run import-ui -- --asar /path/to/resources/app.asar`. That uses the data files next to it, unless `--resources <dir>` names another `resources` folder. The environment variable `EVNIA_VENDOR_ASAR` works as well; the path must be visible inside the container.
- **Package maintainer field:** set `DEBEMAIL="Your Name <you@example.org>"` for the build. Without it the neutral placeholder `Evnia Linux Port <noreply@localhost>` is used.

Other `npm` scripts, the tests and the project layout are described in [`port/README.md`](../../port/README.md). How the pieces fit together is in [ARCHITECTURE.md](ARCHITECTURE.md), and how to maintain and update the port is in [MAINTAINING.md](MAINTAINING.md).
