# Implementation notes: `usb` layer and ENE Ambiglow driver

Module owner: usb-ene. Sources: `port/src/backend/usb/*`, `port/src/backend/ambiglow/ene*.ts`, `port/src/backend/ambiglow/mock-ene.ts`. Tests: `port/test/unit/usb/`, `port/test/unit/ambiglow-ene/` (96 tests, `node --test "test/unit/usb/**/*.test.ts" "test/unit/ambiglow-ene/**/*.test.ts"`).

Specs: `docs/re/09-ambiglow-lighting.md` §3–§8, §11, §16.8, plan A/F; `08` §4.1, §8.2, §8.5; `01` §9; `20-monitor-io-linux-consolidation` §2.2 rule 5, §5. Ground truth: `work/dotnet-clean/Zeasn.USB.ENE.Lib` (`Class0.cs`, `CUSBENE6K7732.cs`), `work/dotnet-clean/Zeasn.Equipment.Option.Lib/.../ENEDataConvert.cs`, `CDevice_PHLDisplay.cs`, `work/native/EneEc.dll.c`, and the user's log `logs/EvniaServe-2026-09-25.txt`.

No new dependencies. One addition to `types.ts` (appended, nothing existing changed): `UsbDeviceInfoWithClass extends UsbDeviceInfo { deviceClass: number }` (§1.1).

---

## 1. USB layer (`src/backend/usb/`)

| File | Content |
|---|---|
| `libusb-backend.ts` | `LibusbBackend implements UsbBackend` on the `usb` 2.18 legacy API; `loadUsbModule()`; `DEFAULT_CONTROL_TIMEOUT_MS = 1000` |
| `fake-backend.ts` | `FakeUsbBackend implements UsbBackend`: in-memory devices with control-transfer handlers, `attach()`/`detach()`, bounded transfer journal, simulated open errors; `DEFAULT_JOURNAL_LIMIT` |
| `errors.ts` | `UsbError { code, errno }`, `UsbErrorCode`, `LibusbErrorCode`, `fromLibusbError()`, `simulatedLibusbError()`, `libusbErrorName()`, `USB_PERMISSION_HINT` |
| `ids.ts` | `usbDeviceId()`, `usbSysfsName()`, `isSameEnumeration()`, `formatVidPid()`, `usbDeviceClass()`, `USB_CLASS_HUB` |
| `setup.ts` | `checkSetup()` (field ranges, direction bit vs. call), `formatSetup()` (`"C0 81 0000 E9F0 0001"`) |

### 1.1 `LibusbBackend`

```ts
const usb = new LibusbBackend({ log });           // options: load?, sysfsRoot? ('/sys/bus/usb/devices' | null), defaultTimeoutMs?
await usb.isAvailable();                           // false without libusb; never throws
usb.unavailableReason;                             // string | null
await usb.list(filter?);                           // UsbDeviceInfoWithClass[] (the filter sees deviceClass too)
const h = await usb.open(info);                    // UsbDeviceHandle
await h.controlOut(setup, data, timeoutMs?);       // resolves when all bytes went out
await h.controlIn(setup, length, timeoutMs?);      // bytes actually returned (may be short)
await h.close();
const off = usb.onChange((kind, info) => …);       // 'attach' | 'detach'
```

- **Ids**: `usb:<bus>-<p1>.<p2>…`, the kernel's sysfs device name (for example `usb:3-2.1`). Root hubs are `usb:<bus>`. When libusb reports no port numbers, the id is `usb:<bus>@<address>`. The id is stable across re-plugs into the same port. `open()` first matches the exact enumeration instance (bus, address, VID/PID), then falls back to the same port id, so an `info` from before a re-enumeration still opens the device.
- **Id ≠ enumeration**: because the id is stable, it cannot tell a live device from one that re-enumerated (monitor standby or power cycle, KVM/input switch, the hub reset after an `E2A012`/`E2A014`/`E2A015` write, suspend/resume). The bus address changes on every re-enumeration and handles opened on the old one are dead for good (`no-device`). `isSameEnumeration(a, b)` compares id, bus, address and VID/PID; use it to decide whether a held handle is still current.
- **No interface claim, no driver detach** (08 §8.2, 09 plan A.3). `open()` calls `device.open(false)`, which is only `libusb_open`. The ENE's HID interface `mi_01` stays bound to `usbhid`. Device-recipient vendor requests on EP0 need nothing more on usbfs.
- **Several handles on one device**: node-usb hands out one JS `Device` per `libusb_device`; its `open()` is a no-op on an open device and `close()` closes the libusb handle for every holder (and throws while a transfer is pending; `node_modules/usb/src/device.cc:39-55, 206-224`). The backend therefore keeps one reference-counted record per `Device` (module-wide `WeakMap`): the second `open()` of a device shares the libusb handle, `close()` of a handle only calls `device.close()` when the last handle on the device closes, and all handles on the device share one FIFO transfer lock. Closing one handle never breaks another, and a close always waits for a transfer in flight. This covers, for example, a DDC rescan that pairs the VIA bridge again while the previous `ViaUsbTransport` is alive, or an ENE re-probe before the stale `EneDevice` is closed.
- **Lazy strings**: enumeration never opens devices. `serialNumber`/`product`/`manufacturer` are read from sysfs (`/sys/bus/usb/devices/<name>/{serial,product,manufacturer}`, cached by the kernel). This happens only for devices that pass the `list()` filter, and for opened or hotplugged devices. The filter itself sees descriptor data only. The local copy is keyed by enumeration (id + address + VID/PID) and holds present devices only: a `detach` event still carries the strings (the sysfs node is gone by then), after which they are dropped, and every `list()` prunes entries of devices that are no longer enumerated. No permission is needed.
- **Error mapping**: `LIBUSB_ERROR_*` values (thrown by open/submit, negative) and `libusb_transfer_status` values (async callback, positive) are mapped to `UsbError.code` (`access`, `no-device`, `timeout`, `stall`, `io`, `overflow`, `busy`, `not-found`, `invalid`, `closed`, `unavailable`, `other`). `access` produces: `No permission to open USB device 0cf2:a201 (usb:3-2.1); install the Evnia Precision Center udev rules (TAG+="uaccess" for 2109:8884 and 0cf2:a201), run "sudo udevadm control --reload && sudo udevadm trigger", then re-plug …`.
- **Timeouts**: default 1000 ms (09 plan A.4, 08 §8.2; WinUSB's default is 5 s). A per-call value is set on `device.timeout` immediately before submission.
- **Serialization**: one transfer at a time per device, FIFO across all handles on it. Callers that coordinate themselves lose nothing.
- **Device class**: every info the backend hands out (`list()` results and what its filter sees, `handle.info`, hotplug events) is a `UsbDeviceInfoWithClass`: `deviceClass` is the device descriptor's `bDeviceClass`, read from node-usb's cached descriptor, so nothing is opened. With it, discovery separates the VIA hub halves (`2109:0817/2817/0211/2211`, class `0x09`) from the `2109:8884` bridge (20 §2.3 step 2) and keeps hubs in their own list for the `USBChange` comparers (20 §5 step 1). Code that holds a plain `UsbDeviceInfo` reads it with `usbDeviceClass(info)`, which returns `undefined` for infos that did not come from one of these backends. Compare with `USB_CLASS_HUB`.
- **No libusb**: `usb` is loaded by a dynamic `import('usb')` inside try/catch on first use. The backend logs one warning and treats USB as unavailable when there is no prebuild, `libusb_init` fails (`INIT_ERROR`), the module lacks `getDeviceList`, or `getDeviceList` throws. `list()` then returns `[]`, `onChange()` is a no-op subscription, and `open()` rejects with `UsbError('unavailable')`, whose message includes the reason. The process never crashes. After a failed `libusb_init`, node-usb's `Init()` returns before it exports any function (`src/node_usb.cc:49-56`). The backend therefore checks `INIT_ERROR` first, and the reason reads `libusb_init failed: LIBUSB_ERROR_OTHER (-99)` rather than "missing API".
- **Hotplug**: the first `onChange` subscriber registers `usb.on('attach'|'detach')`. It then calls `unrefHotplugEvents()`, so hotplug does not keep a CLI process alive. When the last subscriber leaves, the listeners are removed, which stops node-usb's hotplug/polling. A listener that throws is logged and does not affect the others. Events are raw, with no debounce: the main process applies the vendor's 1000/2000 ms `USBChange` throttle (01 §9).

### 1.2 `FakeUsbBackend`

```ts
const usb = new FakeUsbBackend({ journalLimit? });   // default DEFAULT_JOURNAL_LIMIT = 10 000; 0 = off, Infinity = keep all
const info = usb.attach({ vendorId, productId, handler, busNumber?, portNumbers?, deviceAddress?, deviceClass?, serialNumber?, product?, manufacturer? });
usb.detach(info | id);                 // emits 'detach'; open handles now fail with 'no-device'
usb.setOpenError(info, 'access');      // libusb_open fails with LIBUSB_ERROR_ACCESS (missing udev rule); 'busy', 'io', … likewise; null clears
usb.transfers;                         // FakeTransfer[] {deviceId, direction, setup, data, length, timeoutMs}, oldest first
```

The fake follows the same semantics as the real backend:
- the same setup validation, and an `overflow` error when a handler returns more than `wLength`;
- the `list()` filter sees descriptor data only (no strings, but `deviceClass`), while the returned infos carry the strings, so a filter on the serial fails in tests exactly as it would in production;
- infos carry `deviceClass` (`spec.deviceClass`, default 0; pass `USB_CLASS_HUB` for a hub);
- a simulated open failure (`setOpenError`) is built by the same mapping as a real one (`simulatedLibusbError`: node-usb's exception shape through `fromLibusbError`). Code, errno and message are identical to `LibusbBackend`'s, including the udev hint for `access`, so mock mode, contract and e2e runs show the production text;
- handles on one device are independent (closing one leaves the others usable) but share one FIFO lock, so async handlers never see two transfers of one device interleaved, and `close()` waits for a transfer in flight;
- handles of a detached device fail with `no-device`, also after a device re-attaches at the same port (a new enumeration: pass a different `deviceAddress` to model it);
- a closed handle fails with `closed`, and a handler exception that is not a `UsbError` becomes a `stall`.

**Journal bound.** The journal keeps at least the most recent `journalLimit` transfers. It is trimmed back to that many once it reaches twice the limit (amortised O(1)). This keeps mock mode (follow-video, follow-audio and DDC traffic for hours) at a few MB. Tests that index into the journal across more than 10 000 transfers pass `journalLimit: Infinity`, as the ENE test rig does.

---

## 2. ENE driver (`src/backend/ambiglow/ene*.ts`)

| File | Content |
|---|---|
| `ene-registers.ts` | VID/PID, chip id, request codes, register map `EneReg`, `groupReg(g, field)`, `staticColorReg(g)`, enums `EneMode`/`EneRegion`/`EneSpeed`/`EneBrightness`/`EneField`, access windows `isWritableRange(reg, len, frameBufferLeds)`/`isReadableRange`, `frameBufferEnd(leds)` |
| `ene-transport.ts` | `EneTransport` (`readRegs`, `readReg`, `writeRegs(reg, data, paced=true)`, `setFrameBufferLeds(n)`, `close`), `EneError`, `eneReadSetup`/`eneWriteSetup` |
| `ene-layout.ts` | `parseAmbiglowInfo`, `loadAmbiglowInfo(resourcesDir, log)`, `findModelLayout`, `matchEneModelName`, `AMBIGLOW_INFO_PATHS` |
| `ene-frame.ts` | `planFrame(layout, counts)`, `renderFrame(plan, grid)`, `roundHalfEven`, `GRID_WIDTH/HEIGHT` (50×40) |
| `ene-params.ts` | `EneParameterSet`, `normalizeParameterSet`, `parameterSetWrites`, `audioLevelByte`, `audioLevelWrites`, `releaseWrites`, `toEneParameterSet(effectInfo, {breathingSync})`, `EffectType`, `RegionType` |
| `ene.ts` | `EneDevice`, `EneDeviceOptions` (`layouts`, `onLost?`, transport options), `identifyEne`, `findEneDevices`, `isEneDevice` |
| `mock-ene.ts` | `MockEneDevice` (a `FakeUsbHandler`; `violations`, `frameLeds`, `state()`), `MOCK_ENE_DEFAULTS` |

### 2.1 Wire protocol (09 §3.3, EneEc.dll `FUN_100039c0`/`FUN_10003a90`)

- Read `n` bytes at `reg`: `C0 81 <reg>>16> <reg&FFFF> n`.
- Write: `40 80 <reg>>16> <reg&FFFF> n` plus the data. The device auto-increments the address.
- Every write except the `0x0023` switch is followed by `sleep(10)` (`Class0.method_4`, 09 §3.5). This is configurable through `writeDelayMs`; tests inject `sleep`.
- A short read is zero-padded. This matches the vendor, which reads into cleared buffers and never checks the length WinUSB returns.

### 2.2 `EneDevice`

```ts
const layouts = await loadAmbiglowInfo(host.resourcesDir, log);           // <resourcesDir>/ENE/… or <resourcesDir>/data/ENE/…
for (const info of await findEneDevices(usb)) {                           // 0cf2:a201 only
  const ene = await EneDevice.open(usb, info, { log, layouts, onLost }); // identify; throws EneError / UsbError
  ene.identity;   // {chipId, revision, trimStatus, ledGroups, counts:{border,central,bottom}, modelName, firmware, fwVersion}
  ene.layout;     // JSON row for the model; ene.ledCount = 46 on the 34M2C8600
}
await ene.setEffect(toEneParameterSet(displayEffectInfo));   // ParameterSet (09 §6); the owner's explicit state
await ene.setEffect(ps, { suspended: true });                // while idle: recorded for lightsOn(), the LEDs stay dark
await ene.writeVideoFrame(captureFrame);                     // 50×40 RGBA or RGB grid → 0xE300… (09 §7.3); false unless mode 14 applied
await ene.writeAudioLevel(level);                            // float 0..255, truncated to a byte → E960..62 or E970..72; false unless mode 9/10
await ene.lightsOff(); await ene.lightsOn();                 // idle suspend / resume (09 §11); resolve false when they did nothing
ene.ledColors();                                             // Effect_GetLEDs preview, R,G,B × ledCount in frame-buffer order
ene.busy; ene.applied; ene.hostControl; ene.suspended;
ene.lost; ene.isCurrent(await findEneDevices(usb));          // gone / re-enumerated? (§2.4)
await ene.close();                                           // 0x0023 ← 0 (UnPlug), then close; {release:false} skips it (always skipped when lost)
```

**Identification (read-only, vendor order).** The probe below matches `USER_PROBE` in `ene-identify.test.ts`:

```
C0 81 0000 4000 0001 -> 77      C0 81 0000 4001 0001 -> 30      (Ec_Init chip id)
C0 81 0000 0244 0001 -> rev     C0 81 0000 0415 0001 -> trim    (0x773x family only; trim=0 is only logged)
C0 81 0000 E0A1 0001 -> 03      then E0A3 / E0A5 / E0A7 per present group (clamped to 3)
C0 81 0000 E9F0 0001 -> L       C0 81 0000 E9F1 min(L,15) -> "34M2C8600" (NUL-terminated)
C0 81 0000 B500 0005 -> 03 32 07 0F 0B
```

Devices are rejected and closed without any write in these cases: `not-ene` (chip ≠ 0x7730), `invalid-firmware` (FW bytes 0..3 all zero), and `unsupported-model` (name not in the JSON; the vendor keeps such a device open but never uses it).

**ParameterSet.** `parameterSetWrites()` produces the full sequence as data. It starts with the unpaced `0x0023 ← 04/00`, followed by the region-specific block of `Class0.method_5`:
- AllZone: 28 writes, field by field across groups 1–4.
- Border4Sided: 17 writes.
- Central: 13 writes.
- Bottom: 13 writes.
- Clock4: 7 writes.

Every sequence is asserted byte for byte in `ene-params.test.ts`, including the user's logged FollowVideo/AllZones case (`0023←04`, then 28 writes with mode `0E`, 28 × 10 ms). `normalizeParameterSet` implements the rainbow variants and the forced speed/brightness/direction for modes 11/14. Unknown modes become LEDOFF.

**UI mapping.** `toEneParameterSet(info, {breathingSync})` implements `ENEDataConvert.MapTMain_ParameterSet` together with the Breathing override from `CDevice_PHLDisplay.method_17`. It takes the C#-shaped `DisplayEffectInfo` members directly (`EffectEnable`, `CurrEffect.Value`, `EffectDetail.{Effect.Value, Speed, Brightness, IsRainbowColor, CurRGB, CurRegion}`).

**Follow-video frame.** `planFrame()` precomputes one sampled grid cell per LED using the vendor formulas with round-half-even. Border sub-counts come from the JSON; the central and bottom counts and the base addresses come from the device registers. For the 34M2C8600 this gives 6 paced writes: 9 B @E300, 12 B @E309, 12 B @E315, 9 B @E321, 54 B @E32A, 42 B @E360. `ene-frame.test.ts` asserts these against the concrete table in 09 §7.3. No commit write follows. The grid must be exactly 50×40, RGB or RGBA. A `CaptureFrame` can be passed as is.

Every frame write stays inside the device's frame buffer (`E300 … E300 + 3·ledCount`). If the JSON border sub-counts add up to more LEDs than the device has in total, the border is cut at the buffer end (deviation 19). A JSON border that is larger than the device's border group but fits in the buffer spills into the central LEDs, as in the vendor, and the central write that follows overwrites them. Any mismatch between the JSON border and the device's `0xE0A3` count is logged once as a warning when the device opens.

**Audio.** The level byte is written to three registers, each write paced. `writeAudioLevel` picks the bank from the applied mode (10 → `E970..72`, 9 → `E960..62`). That is the same choice the vendor makes via `IsRainbowColor`. The level is the `CaptureHost.startAudio` value as is: a float 0..255. `audioLevelByte` truncates it like the vendor's `(byte)(v / mx * 255)` (09 §8.2), clamps out-of-range values to 0..255 and treats NaN as 0, so the engine can forward the raw level.

**Idle suspend (09 §11).** The vendor's `EffectEnableTemp(enable)` (`CDevice_PHLDisplay.cs:954-972`) only acts while the stored `EffectInfo.EffectEnable` is true, and then re-sends that EffectInfo with `EffectEnable` overridden. The driver models the same thing without access to the profile:
- `setEffect(ps)` records `ps` as the requested state and ends any suspension.
- `setEffect(ps, { suspended: true })` (added by the ambiglow module) records `ps` as the requested state but keeps (or puts) the device suspended: nothing is written when the applied state is already LEDOFF; otherwise the LEDOFF variant of `ps` goes out (the `lightsOff()` bytes), which also darkens a freshly opened device that still runs the firmware's own effect. `lightsOn()` later shows `ps`. A `ps` that is itself LEDOFF is applied as without the option and ends the suspension. The effect engine uses it for every push while idle, so a profile switch, reload or re-open during idle never lights the LEDs (impl-ambiglow §4.4).
- `lightsOff()` switches the requested effect off (same parameters, mode LEDOFF, `0x0023 ← 0`) and marks the device suspended. It writes nothing and resolves `false` if nothing was requested yet, the requested effect is itself LEDOFF (the user disabled Ambiglow), or the device is already suspended.
- `lightsOn()` re-applies the requested effect only while suspended; otherwise it writes nothing and resolves `false`. It can never switch on LEDs that the owner switched off with `setEffect`.

The off sequence uses the requested (un-normalised) speed and brightness, so it is byte-identical to the vendor's ParameterSet for the same EffectInfo with `EffectEnable = false`. In mode 14 that means the UI speed/brightness bytes, not the forced `00`.

**Serialization.** One operation runs at a time per device, in FIFO order. `busy` is true while an operation is queued or running, so a frame source can drop frames instead of queueing them (09 plan A.7).

**Access policy (09 plan F.3).** `EneTransport` refuses any transfer outside these windows:

| Direction | Allowed windows |
|---|---|
| Writes | `0x0023`, `E020–E05F`, `E960–E962`, `E970–E972`, `E980–E98B`, and the device's frame buffer `E300 … E300 + 3·ledCount − 1` (`E300–E389` for the 46 LEDs of the 34M2C8600) |
| Reads | The same fixed windows, the whole frame-buffer area `E300–E95F`, and the identification registers |

The frame-buffer window is per device. `EneTransport.setFrameBufferLeds(n)` opens it, and `EneDevice` calls it with `ledCount` (groups 1–3 as the device reports them) right after identification; until then no frame write is accepted. `frameBufferEnd(n)` caps the window below the audio registers (at most 544 LEDs), so a bogus LED count cannot open it over `E960` and beyond. The flash controller (`0x04xx`), `E51RST 0x0202`, `WDTCFG 0x0600`, the per-LED SW-mode block `0xE100` and the undocumented registers behind the frame buffer can never be written.

### 2.3 `MockEneDevice`

`new MockEneDevice(options?)` is a 64 KiB register file behind the two vendor requests. By default it reproduces the user's 34M2C8600:
- Chip `0x7730`, model `34M2C8600`, FW `03 32 07 0F 0B`. Source: log 2026-09-25 lines 650 and 651. The USB serial is the synthetic `0000000001` (security review: the mock ships in the package, so it carries no identifier of the user's unit; the real one is in log line 31).
- Group count 3 with counts 14/18/14, rev 1 and trim 1. These are **inferred**, not seen in any log (09 Open questions 3/5).

Group settings latch when 1 is written to the group's apply register, which is what `state().groups` shows. `state()` also exposes `hostControl`, `frame` and the audio registers.

**Own register map.** The mock accepts writes only to the registers listed in 09 §4.2, written out in `mock-ene.ts` (`writableRegisters`) rather than taken from the driver's policy, so its check tests the driver instead of mirroring it:
- `0x0023`;
- per group, only the six fields `+0/+1/+2/+3/+9/+F` of `E020`/`E030`/`E040`/`E050`;
- the frame buffer sized by the mock's **own** LED counts (`frameLeds`: the counts of the groups it reports; `E300–E389` by default);
- `E960–E962`, `E970–E972` and `E980–E98B`.

Every byte of a multi-byte write must land on an allowed register. Any other write STALLs and is recorded in `violations`, and any other request STALLs as well. `mock-ene.test.ts` runs every region, a frame, both audio banks, idle off/on and close through the real driver and asserts `violations` stays empty. A regression that writes past the frame buffer (a wrong base, inflated counts) or into an unlisted field is therefore caught. To use the mock in mock mode:

```ts
const usb = new FakeUsbBackend();
usb.attach(new MockEneDevice().spec({ busNumber: 3, portNumbers: [2, 1] }));
```

The driver code then runs unchanged. The DDC agent attaches its VIA mock to the same `FakeUsbBackend`.

### 2.4 Lost and re-enumerated devices

A libusb handle that reports `LIBUSB_ERROR_NO_DEVICE` never recovers. The first operation that fails with `UsbError('no-device')` marks the `EneDevice` **lost**:
- `lost` becomes true and `hostControl` false.
- `onLost(device)` (from `EneDeviceOptions`) is called once, after the failed operation left the device lock. A throwing handler is logged.
- Every further operation rejects with `EneError('lost')`.
- `close()` skips the release write.

A device can also have re-enumerated without any operation failing yet, for example when a detach and an attach fall into one `USBChange` window. `isCurrent(present)` catches that case. It is true only if the device is open, not lost, and `present` (a fresh `findEneDevices()`) contains the same enumeration (`isSameEnumeration`: id **and** address). `ene-device.test.ts` covers both: detach, re-attach at the same port with a new address, detect, close, re-open, re-apply.

---

## 3. Deviations from the vendor (all deliberate)

1. **Disabled Breathing is off.** `method_17` forces mode 7 for Breathing even when `EffectEnable` is false. Because of this, `Effect_Enable(false)` and "turn off lights when idle" leave a breathing effect running. `toEneParameterSet` returns LEDOFF whenever the effect is disabled.
2. **ParameterSet is sent once.** The vendor sends it twice for unsynced Breathing (harmless, but it doubles the ~0.45 s cost). `toEneParameterSet` returns a single set, and callers should send it once.
3. **A sequence aborts on the first failed write** and rejects, leaving `applied = null`. The vendor ignores intermediate failures and returns the last write's status.
4. **Model-name read capped at 15 bytes.** The vendor reads `L` bytes into a 15-byte buffer, which overflows (09 §16.7).
5. **Layout lookup ignores case.** The vendor's support check is case-insensitive but its layout lookup is case-sensitive, so a mismatch leads to a null dereference during follow-video.
6. **Probe scope.** Only `0cf2:a201` is probed; the DLL opens anything with its WinUSB GUIDs. Chips outside the 0x773x family are rejected right after the id read. The flash trim-load that `EneEc.dll` runs when `0x0415 == 0` is never performed; the value is only logged.
7. **Register access limited to the documented map** (§2.2), with the frame buffer bounded per device by the LED count it reports.
8. **Frames and audio levels are dropped unless the matching mode is applied.** A late frame after idle turn-off cannot reach the device. Audio levels are truncated and clamped to a byte rather than relying on the caller (the vendor's value is a byte by construction).
9. **`0x0023` is derived from the normalised mode.** This only differs for out-of-range input: the vendor would claim host control with the LEDs off.
10. **`close()` releases `0x0023`** by default, like `UnPlug`. The vendor never releases it at process exit (09 §16.6).
11. **Transfers over `0x1000` bytes are refused** rather than chunked with the DLL's repeated-`wIndex` bug. The driver never exceeds 54 bytes.
12. **Empty frame segments are skipped.** The vendor still sleeps 10 ms for a 0-length write.
13. **The `ledColors()` mirror is correct.** The vendor mirror (`Class1`) uses the RightUp count for the right segment, never fills central/bottom, and fills the wrong ranges per region.
14. **Operations are serialized per device.** The vendor's capture, audio and UI threads can interleave writes.
15. **Grid size and clamping.** The grid must be exactly 50×40. Row and column indices are clamped for LED counts beyond any shipped model, where the vendor would throw and drop the frame.
16. **Pacing is `setTimeout(10)`, about 10 ms.** Windows' timer granularity turns the same `Sleep(10)` into about 15.6 ms (458 ms for 28 writes in the log). The vendor constant is kept. Whether the firmware needs any pacing is an open hardware test (09 Open question 4).
17. **Idle suspend is state in the driver** (§2.2). The vendor reads `EffectInfo.EffectEnable` from the profile on every `EffectEnableTemp`. Here `lightsOff()`/`lightsOn()` act on the last `setEffect` request. The bytes on the wire are the same, and a disabled Ambiglow is never switched on by a wake.
18. **Re-enumeration is detected, not re-plugged on every USB change** (§2.4). The vendor re-plugs the ENE on every `USBChange` (09 §16.8): `UnPlug` (`0x0023←0`), then a full probe and effect re-apply, even when the ENE was not involved. The port re-probes only an ENE that is new, lost or re-enumerated.
19. **Follow-video border cut at the frame-buffer end** (§2.2). The vendor sizes the four border writes by the JSON sub-counts alone (`Class0.method_8`). A table row with more border LEDs than the device reports in total therefore makes it write past the frame buffer into undocumented registers. The port cuts the border at `E300 + 3·ledCount`. No shipped combination is known to trigger this: the 34M2C8600's JSON border (3+4+4+3 = 14) matches its border group.

---

## 4. Known limitations / unverified on hardware

- **Inferred firmware behaviour.** All device behaviour beyond the logged identity values is inferred: `0x0023` semantics, the 14/18/14 counts, auto-increment across segments, and "no commit after frames". The byte sequences are vendor-exact, so the driver does what Windows did.
- **Frame rate.** A frame is 6 paced writes, about 65 ms including transfers, so the rate tops out around 14–15 fps. A single 138-byte write at `0xE300` is possible (09 plan A.7) but not used until tested.
- **Strings on non-Linux systems.** String descriptors come from sysfs only. Where sysfs is absent, `serialNumber`/`product` stay undefined. Nothing in the port depends on them.
- **Handles shared with code outside this backend.** The per-device record covers every handle opened through `LibusbBackend` (module-wide). Code that uses the `usb` package directly on the same device would bypass it. Nothing in the port does.

---

## 5. What the next wave must know

**Monitor driver / discovery**
- Create one `LibusbBackend` per process. The main-process `USBChange` detection can share it through `onChange`. In mock mode, use a `FakeUsbBackend` with a `MockEneDevice` (§2.3).
- **Hubs vs. functions:** use `usbDeviceClass(info) === USB_CLASS_HUB` (§1.1). Bridges are `idVendor == 0x2109 && deviceClass != 0x09` (20 §2.3 step 2). For the `USBChange` comparers, put hubs in their own list (20 §5 step 1). For the 20 §6.4 diagnostic, `2109:0211` present with `2109:2211` and `0cf2:a201` absent means "hub enumerated only at SuperSpeed". `ddc/discovery.ts` currently reads `bDeviceClass` from sysfs and falls back to a PID list; it can use `usbDeviceClass()` instead. In `FakeUsbBackend` tests, hubs then need `deviceClass: USB_CLASS_HUB` in their spec.
- Open every ENE with an `onLost` callback that schedules the same reconcile as a USB change (below). The id is **not** enough to identify a held device: it survives re-enumeration (monitor standby or power cycle, KVM/input switch, the hub reset after `E2A012`/`E2A014`/`E2A015` writes, suspend/resume), and a detach plus attach can land in one `USBChange` throttle window (01 §9).
- On start, on each (debounced) USB change and on `onLost`, reconcile:
  1. `const present = await findEneDevices(usb)`.
  2. For every held `EneDevice` with `!ene.isCurrent(present)` (closed, lost, gone, or re-enumerated at a new address): `await ene.close({ release: false })` and forget it. Its handle is dead, so there is nothing to release.
  3. `EneDevice.open` every `present` info that is not held by a current device.
  4. Pair each new device with the DDC monitor via `matchEneModelName(monitor.monitorName, [ene.modelName])`. This is `CUSBENE6K7732.GetModelName`, which accepts "PHL 34M2C8600", "PHL_…" or "PHL…".
  5. Set `DiscoveredMonitor.ene = ene.info`, then apply the stored effect (see the last bullet). A re-opened device starts with the firmware's own state, so the effect must be re-applied, and after an idle `lightsOff()` also switched off again.
- Do **not** copy vendor quirk §16.8, where every USB change runs `UnPlug()` (which writes `0x0023←0`) and then a full re-plug. Re-probe only an ENE that is new, lost or re-enumerated (`isCurrent` false).
- `EneError` codes `not-ene`, `invalid-firmware` and `unsupported-model` mean "use the DDC `E2A0` path" (09 §14). `UsbError('access')` means the udev rule is missing. Surface its message, which already contains `USB_PERMISSION_HINT`, also in mock mode through `FakeUsbBackend.setOpenError`. The DDC fallback still works.
- On plug, the vendor applies the stored effect (`method_14`, then `method_17`) and sets `ENEEffectEnable = true`. Do the same with `setEffect(toEneParameterSet(profile.EffectInfo, { breathingSync: false }))`.

**Effect engine (follow-video / audio / idle)**
- **Follow-video:** pass the capture host's 50×40 RGBA `CaptureFrame` directly to `writeVideoFrame`. Skip frames while `ene.busy`. The vendor sends every 100 ms with fresh content every 300 ms; up to about 10 fps is safe.
- **Follow-audio:** forward the `CaptureHost` level (a float) to `writeAudioLevel(level)` every 40 ms; the driver truncates it to a byte. This is 3 paced writes (about 30 ms), so do not queue more than one.
- **Idle:** call `lightsOff()` when idle starts and `lightsOn()` when it ends (§2.2). Both are safe to call unconditionally: they do nothing when the Ambiglow is disabled, not yet applied, already suspended or not suspended. Every plain `setEffect` (a UI change, a profile switch) is the new requested state and ends a suspension; while idle, the engine passes `{ suspended: true }` instead (§2.2), which records the state without lighting the LEDs (following a plain `setEffect` with `lightsOff()` would flash them on for the ~0.3 s of the sequence).
- **Speed/brightness changes:** do not re-send ParameterSet for FollowVideo, FollowAudio or Breathing (vendor `:1088-1121`); the other `Effect_*` calls do re-send it (09 §6.4).
- **Shutdown and suspend:** call `ene.close()` so the monitor firmware takes the LEDs back. After resume, the ENE usually re-enumerates; the reconcile above re-opens it.

**API layer**
- **`Effect_GetLEDs`:** build `RGB[]` from `ene.ledColors()`, taking triplets in order. The renderer slices `[0,14)` border and `[14,32)` central. Return an error, as the vendor does, unless the current effect is FollowVideo or FollowAudio.
- **ENE availability:** `LibusbBackend.isAvailable()` and `unavailableReason` are useful for diagnostics and logs.

**Build / packaging**
- **esbuild:** `usb` (a native addon) must be marked external. `import('usb')` then compiles to `require('usb')` in `main.cjs`, and `loadUsbModule` accepts both the ESM namespace and the CJS shape.
- **Layout table:** `loadAmbiglowInfo` reads the vendor's `resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json` from the first of `AMBIGLOW_INFO_PATHS` that exists:
  1. `<resourcesDir>/ENE/PCenter_AmbiglowInfo.json`, which is where the current build puts it. `scripts/ui-patches.mjs` copies the file to `build/vendor-data/ENE/`, `scripts/build.mjs` copies `vendor-data/` into `<app>/resources/`, and `src/main/paths.ts` sets `resourcesDir = <app>/resources`. `ene-layout.test.ts` locks this chain: it checks the manifest and `resolveAppPaths`, and loads the real table from `build/vendor-data` and `build/app/resources` when they exist.
  2. `<resourcesDir>/data/ENE/PCenter_AmbiglowInfo.json`, the vendor's own `data/` level. Packaging that keeps that level therefore still works.

  The file that was used is logged at info level (`ENE model table <path>: N models`). If neither file exists, or the one found is malformed, the ENE path is disabled with a warning, as on Windows, and the DDC `E2A0` codes take over. A malformed first copy does not fall back to the second, so a packaging error stays visible.
- **Runtime library for USB:** the `usb` linux-x64 glibc prebuild (`node_modules/usb/prebuilds/linux-x64/node.napi.glibc.node`) links libusb statically but needs **`libudev.so.1`** (readelf `NEEDED`; it also needs libstdc++6, libgcc-s1 and libc6, which Electron needs anyway). Without it `import('usb')` fails and the whole USB layer (VIA USB-DDC and ENE) reports itself unavailable. The `.deb` must declare `Depends: libudev1`, or derive the dependencies by running `dpkg-shlibdeps` on the prebuild. `packaging/deb/control.in` currently lists `libusb-1.0-0`, which the prebuild does not use, and lacks `libudev1`. That file belongs to the packaging owner.
- **Unpacked prebuilds:** `.node` files cannot be loaded from inside an asar. `node_modules/usb` (with `prebuilds/linux-x64`) must ship unpacked (`app.asar.unpacked`). `scripts/package-deb.mjs` does this already (`asar.unpackDir` includes `node_modules/usb`). Keep it when the packaging changes.
- **udev:** add `SUBSYSTEM=="usb", ATTRS{idVendor}=="0cf2", ATTRS{idProduct}=="a201", TAG+="uaccess"`, plus the VIA rule from 08 §8.5. The permission error text refers to these rules.
