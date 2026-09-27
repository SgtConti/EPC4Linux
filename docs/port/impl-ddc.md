# DDC/CI layer and monitor discovery (`src/backend/ddc/`, `src/backend/cli.ts`)

This module is the transport half of the monitor port. It covers DDC/CI framing and checksums,
VCP get and set (standard and TPV `E2 A0 xx`), the TPV identity page, the capability string (read,
parse and signed cache), EDID parsing, the VIA USB-DDC and i2c-dev transports, a simulated
34M2C8600, discovery on Linux, and a bring-up CLI.

It is built from 07, 08 §1-5, 06 §4-6 and 03 §6.2-6.3. Where those disagree, it follows the
decisions in **20-monitor-io-linux-consolidation.md** (D1-D10, R1-R10). The decompiled sources were
used where the reports were silent (`Interface2/8/13`, `Util`, `ComUtil`, `SerializedFileUtil`,
`CacheVcpMgr`, `MonitorUtil`, `Display`, `GClass3`).

No `types.ts` additions were needed.

## Files and public API

| File | Exports | Spec |
|---|---|---|
| `errors.ts` | `DdcError` (`code`: `io`, `invalid-reply`, `no-transport`, `unsupported`, `closed`, `argument`, `busy`; `transportId`), `isDdcError`, `isBusy`, `errorText` | – |
| `locks.ts` | `withPathLocks(keys, fn)` (in-process FIFO per path/monitor key). `ProcessLock`, `FlockProcessLock` (flock files), `lockPlace(env, uid)`, `lockFileName(key)`, `defaultProcessLock()`, `resolveProcessLock(option)`, `withExclusiveAccess(keys, lock, fn)` | 20 §2.3/§2.4 (D2) |
| `libc.ts` | `loadLibc()` (koffi `ioctl` and `flock`, loaded lazily), `LOCK_EX`/`LOCK_NB`/`LOCK_UN`, `errnoName`, `errnoError` | 20 §2.4/§2.7 |
| `codec.ts` | Constants (`DDC_CI_SLAVE`, `EDID_SLAVE`, `DDC_DEST`, `DDC_READ_ADDR`, opcodes, `EXT_BASE`, `PROBE_VCP`, `VCP_CONTROLLER_TYPE`, `VCP_INPUT_SOURCE`, `VCP_FIRMWARE_LEVEL`). `xorChecksum`, `buildDdcMessage` (frame **without** `0x6E`, per `DdcTransport.write`), `toWireFrame`. Payload builders: `get/setVcpPayload`, `get/setExtPayload`, `capsRequestPayload`, `rawGetPayload`. `checkReply`, `replyPayload`, `isNullMessage`, `parseVcpReply` (length-relative), `standardReplyEcho`, `parseCapsFragment`. `TPV_QUERY` table. `extractTpvPayload` (`imethod_8`), `tpvAscii`, `parseSerialReply`, `parseScalerIc`, `scalerTypeOf`, `parseDualImageBank`, `parseBootFlagAddress`, `parseBomString`, `fwVersionFromC9`. `isExtCode`/`extCode`/`extSub`, `hex2`/`hexBytes` | 08 §3.1-3.4, 07 §4.7/§6, 20 §2.5 |
| `capabilities.ts` | `readCapabilityString(fetch, opts)`: the F3 fragment reader. `parseCapabilities(raw)`: a structural MCCS parser (prot, type, model, cmds, vcp with nested value trees, mccs_ver, every segment). `analyseVcpString(raw)`: an **exact port of `ComUtil.AnalyseVcpString`** that returns an ordered `Map<code, bytes[]>` or `null` | 08 §3.5, 06 §4.8, 20 §2.6 |
| `cap-cache.ts` | `CapabilityCache` (a `CacheVcpMgr` port: `load`, `get`, `save`, `delete`, `reset`, `entries`). `encodeCapCacheFile`/`decodeCapCacheFile`, `serializeCapCacheData`, `capCacheSign`/`capCacheVerify` (HMAC-SHA256, key `WhaleTV_Serizlize_2026`), `capCacheKey(version, vcp60)` | 05 summary, 06 §4.8, 20-theme §3.8 |
| `edid.ts` | `parseEdid` returns `EdidDetails` (extends `EdidInfo` with the PnP id, version, size, gamma, chromaticity, preferred timing, extension count and checksum flag). `edidDisplayStrings(edid, sep)` gives the 14 `DisplayEDIDInfo` strings exactly as EDID256Block produces them. Also `localeDecimalSeparator(env)`, `edidPairingName`, `simpleModelName`, `sameEdidBase`, `fixEdidHeader` | 07 §4.8.6, 20 §3.3-3.4 |
| `channel.ts` | `DdcChannelImpl` (implements `DdcChannel`, plus `probe()`, `activeTransport`, `timings`; options `monitorKey`, `processLock`). `VENDOR_TIMINGS`, `NO_DELAY_TIMINGS`, `DdcClock`/`realClock`, `ONE_SHOT_CODES`, `USB_TOPOLOGY_CODES`, `TransportProbe` | 08 §3.2/§3.6/§4.1, 07 §3.4.2/§4.8, 20 §2.2-2.8 |
| `identity.ts` | `readScalerIc`, `readTpvString(ch, 'modelName'\|'fwVersion'\|'scalerName'\|'panelName')`, `readBomString`, `readDualImageBank`, `readFactorySerial`, `readMonitorIdentity` (the `GetMonitorInfo` sequence plus SN) | 08 §3.4, 06 §4.3 |
| `discovery.ts` | `discoverMonitors(opts)` returns `DiscoveredMonitor[]` (options include `viaProductIds`). Also `scanDrmConnectors`, `modelMatchesEdid`, `isIgnoredI2cAdapter`, `ENE_VENDOR_ID`/`ENE_PRODUCT_ID`, `DrmConnector`, `DiscoveryOptions`, `DiscoveryChannelOptions` | 20 §2.3, 08 §3.7/§4.1, 07 §8.2 |
| `transports/via.ts` | `ViaUsbTransport` (over `UsbDeviceHandle`), `VIA_REQUEST`, `VIA_VENDOR_ID`, `VIA_DDC_BRIDGE_PID`, `VIA_TIMEOUT_MS` | 08 §4.2-4.3, 20 §2.6 |
| `transports/i2cdev.ts` | `I2cDevTransport(path, sys, { slave, log })`, the `I2cSyscalls` interface (`setSlave(fd, addr, force?)`), `createLinuxI2cSyscalls`/`linuxI2cSyscalls` (`node:fs` plus a koffi `ioctl`), `readEdidOverI2c`, `i2cTransportId`, `I2C_SLAVE`, `I2C_SLAVE_FORCE` | 07 §8.3, 20 §2.7 |
| `transports/mock.ts` | `SimulatedMonitor`, `MockDdcTransport` (kind `mock`), `createMockViaHandler`/`mockViaDeviceSpec` (for `usb/FakeUsbBackend`), `createMockI2cSyscalls`, `writeMockSysfs`, `createMock34M2C8600`, `hexToBytes` | – |
| `transports/mock-34m2c8600.ts` | `MOCK_34M2C8600` seed spec | 03 §6.2-6.3, 06 §5.7, 08 §2.3 |
| `../cli.ts` | `main(argv, io)`, `parseCode`, `parseValue`, `parseProductId` | 07 §8.5 |

## Behaviour

### Frames and replies (08 §3, 20 §2.5)

- **Requests.** The checksum is the XOR of every frame byte, the implicit `0x6E` included. All worked
  examples in 08 §3.3/§3.4, 07 §6 and 20 §2.5 are unit-tested byte for byte.
- **Validation.** A reply is valid when `r[0]==0x6E`, `1 <= L <= N-3`, and
  `0x50 ^ r[0..L+2] == 0`. A null message (`L=0`) is a failed attempt, so it is retried.
- **VCP parse.** The last four payload bytes are max and value, the same rule for standard and
  `E2A0` codes (hub rule, D3). `L` must be 4..30. The result code is returned in `VcpValue.resultCode`
  and is not treated as an error, like the hub.
  - The echoed VCP code of a standard 8-byte reply is compared with the request. A mismatch is only
    logged, because the vendor never checks it.
- **TPV identity page.**
  - `imethod_8`: data starts at `r[5]`, or at `r[6]` when `r[5]==0`. Text is ASCII up to the first NUL.
  - Serial (`GetSN`): raw ASCII with NULs dropped. `""` if `N<13`. The first 14 characters if `N>=14`.
    The vendor's `Substring` exception when the string is shorter is avoided.
  - BOM: the PHILIPS rule, `sub[4]=='P'` or the literal exception.
  - Scaler IC: `r[9]` (the SL byte), only when `L >= 8`. For shorter replies `r[9]` is the checksum
    or padding, which the vendor would read for `L` = 5..7; the port rejects them (`invalid-reply`).

### Channel (`DdcChannelImpl`)

- **Timing per transaction** (`GetStandardData`), up to 3 attempts:
  1. Write, then 100 ms. The delay is applied even after a failed write, and a failed write ends
     the attempt.
  2. Wait `max(15, sleepTime - elapsed)`. `sleepTime` is 100 for gets, GetSN and capabilities, and 150
     for C8 and FE queries.
  3. Read, then 50 ms. The VIA A7+A9 capabilities read has no 50 ms delay after it
     (`Interface13.method_0`).
  4. Validate.
- **Per kind.** The rules are chosen by `transport.kind`:

  | Kind | Transfer retries | Set write attempts | Get read | Capabilities read | Support probe |
  |---|---|---|---|---|---|
  | `via-usb` | 3, sleeping (n+1)×177 ms after **every** failure, the last included (`Util.smethod_0`) | 1 | 32 bytes | 64 (A7+A9) | 0 < value < 255 && max < 255 |
  | `i2c-dev` | none | 3 | 32 bytes (D3) | 38 bytes; the whole read is retried once after 2000 ms | RC == 0; one retry after 200 ms |
  | `mock` | none | 3 | 32 bytes | 64 | as i2c |

- **Transport policy** (20 D1, §2.2). This replaces the vendor's per-call "hub, then GPU".
  - A transport is used only after its **support probe** (GetVCP 0x14) passed. The probe runs lazily
    the first time a transport is needed, or explicitly through `probe()`.
  - Probe results live in a module-level `WeakMap` keyed by the transport **object**. A second
    channel over the same objects reuses them, and new objects from a new discovery run are probed
    again. The queue, by contrast, is keyed by the **path** (see Locking).
  - The transport that last succeeded is **sticky**. An operation first uses up its whole budget on
    the active transport, then runs once on the next usable one, and that one becomes active on
    success.
  - **`probe()`** re-probes every transport and resets the choice, so the next operation starts at
    USB again. The driver must call it on connect, on `Device_DetectionDisplay` and on
    `Device_DetectionUSB`.
  - **One-shot actions** (`ONE_SHOT_CODES`) are never replayed on another transport: 04, A4, F6,
    E2A036, E2A037, E2A038, E2A042 and E2A06B.
  - **USB topology writes** (E2A012, E2A014, E2A015 over USB) drop the USB probe result and make a
    probed alternative active, until the next `probe()`.
- **Locking** (20 §2.4, D2; `locks.ts`). There are two levels:
  - **In-process queue per path.** The lock keys are the transport ids (`via:usb:3-2.4`,
    `i2c:/dev/i2c-5`) plus `monitorKey` when it is given. They are not the transport objects:
    every discovery run opens a new USB handle and new i2c transports for the same bridge and bus,
    and those must share the queue of the driver's existing channel.
    - A whole operation, including its retries and failover, holds the queue of every key of its
      channel. A capability read holds it for about 6.8 s at vendor timings.
    - An operation joins the queues of all its keys in one synchronous step. All queues therefore
      order operations the same way: first come, first served, and no deadlock.
    - A multi-step `PHL_*` sequence needs its own single-flight queue in the driver, on top of this
      one.
  - **Cross-process flock per transaction.** Each transaction takes `flock(LOCK_EX)` on
    `$XDG_RUNTIME_DIR/evnia/ddc-<key>.lock`, for the transaction's path and the monitor key. A
    transaction is one write, the delays and one read, or one set write.
    - The lock is polled with `LOCK_NB` every 10 ms, so the event loop never blocks.
    - After 15 s it gives up with `DdcError('busy')`; a stuck peer, such as a CLI suspended with
      Ctrl-Z, therefore costs a bounded wait. The longest VIA exchange is about 8.5 s.
    - `busy` is never retried, never failed over to another path (the same monitor would
      interleave there too), and never recorded as a failed probe.
    - Under sudo (root with `SUDO_UID`), `/run/user/<SUDO_UID>/evnia` is used and root-created files
      are given to that user. Without a runtime directory, or if the lock file cannot be opened,
      DDC works without the lock and logs one warning.
    - The option `processLock`: `undefined` uses the default lock, `null` disables it (simulators,
      tests), or pass your own `ProcessLock`.
  - **Discovery** holds a process-wide "display scan" `Mutex` (20 §2.3). Its bridge queries run on
    channels over the bridge's path, and the USB-DDC probe also holds the paired monitor's key. Its
    EDID reads at `0x50` hold the bus's path lock. A rescan can therefore run while the driver is
    polling; the regression test checks for a strictly alternating `W R W R …` USB journal.
- **Injection.** `timings` (`VENDOR_TIMINGS` by default, `NO_DELAY_TIMINGS` for tests) and `clock`
  can be injected. The tests use a virtual clock to assert the exact delay sequences, for example
  `[100, 15, 50]` for a get and `[177, 354, 531, 100, …]` for VIA backoff.
- **Rejections.** Bad arguments reject before any I/O: codes above 0xFF, values outside 0..65535, and
  payloads that are too long. `close()` closes the transports, because the channel owns them.

### Capabilities

- **Reader.** Standard MCCS: append all `L-3` data bytes, advance by the same amount, and stop on an
  empty fragment **or** when the outer `( … )` group closes at the last non-blank character (20 §2.6).
  - Failure budget: 3 retries per fragment, reset after each success.
  - Fallback: when the fragment after a short one (< 26 bytes, the vendor stop rule) cannot be read,
    the string read so far is accepted.
  - The offset echo is only logged if it mismatches. The string is capped at 8 KiB.
  - The vendor's 27-byte fragment cap and DDCHelper's "drop the last short fragment" quirk are not
    reproduced.
- **`analyseVcpString`** reproduces the vendor regexes:
  - upper-cases, then takes the first **balanced** `VCP(`;
  - inserts spaces when the group has none, which loses multi-byte codes;
  - accepts only flat sub-lists, so a nested list yields `[]`;
  - takes only 2-hex values, dedupes, keeps the first of duplicate codes, and returns null for codes
    longer than 8 hex digits.

  On the user's string it reproduces the parse dump EvniaServe logged (LOG26 "5. 匹配完毕的 VCP"),
  all 85 entries in order. **Use `analyseVcpString` to build `SupportOSDList`.** `parseCapabilities`
  is a structural view (model, MCCS version, cmds, nested trees) for diagnostics.

### Capability cache (`Config/data.json`)

- **Format.** A byte-for-byte round trip with the user's file is tested: UTF-8 BOM, then
  `{"data":…,"sign":…}` with Newtonsoft escaping (plus `\u0085`, `\u2028`, `\u2029`), key order
  `Name, Datas` / `Key, Vcp`, and a base64 HMAC-SHA256 signature.
- **Loading.** A bad signature makes the load ignore the file, which the next save overwrites. An
  unsigned plain list ("old version") is accepted. A malformed file gives an empty cache.
- **Lookup semantics** are the vendor's:
  - `get`: case-insensitive name, key matched as a case-insensitive **substring**.
  - `save`/`delete`: ordinal (exact) matches.
- **Writes** are atomic (write a temp file, then rename). The vendor writes in place.
  - Writes of one instance are queued, and each writes the list as it is when its turn comes.
    Overlapping `save`/`delete`/`reset` calls therefore all resolve, and the file ends in the final
    state.
  - Temp names are unique per write (`data.json.<pid>.<n>.tmp`), so two instances on one path
    cannot rename each other's temp file away either.

### EDID

- **`parseEdid`** follows EDID256Block:
  - The PnP id is the manufacturer plus `%04X` of the product code.
  - `monitorName` concatenates **all** 0xFC descriptors, `serialString` all 0xFF descriptors, each up
    to 13 characters and stopping at LF. `serialString` also has its non-ASCII characters removed.
- **`edidDisplayStrings`** reproduces the user's persisted `MonitorEDIDInfo_T` exactly, with `","` as
  the separator (tested against `Default.pcenter`). Details:
  - the manufacturer table and its bug-compatible numeric fallback;
  - `Week%02d-%d`;
  - `~x.x"`;
  - `0.##` gamma via float emulation;
  - `0.###` chromaticity from exact n/1024 values;
  - the widest DisplayID type-I timing for PHL/AOC/ENV/AMZ PnP ids.
- **`localeDecimalSeparator()`** implements D5: `LC_ALL`, then `LC_NUMERIC`, then `LANG`, mapped to a
  BCP-47 tag and passed to ICU. C/POSIX gives `.`.

### Discovery (20 §2.3)

1. **DRM, with no bus traffic.** Take connected connectors that have a parseable EDID. Filter on the
   brand (`PHL` in the PnP id, `brands: null` turns this off) and on the optional
   `supportsModel(edidName)` whitelist.
2. **Bus per connector** (R6). DP and eDP connectors use the connector's child adapter (AUX) first,
   then the `ddc` link. Other connectors use the `ddc` link first. Without either, the GPU's other
   adapters are tried:
   - only below a PCI display-class device (`0x03xxxx`);
   - never on the adapters ddcutil ignores (`isIgnoredI2cAdapter`): any name containing `SMBus`,
     and the prefixes `AMDGPU SMU` (RAS/FRU EEPROM at `0x50`, firmware controller),
     `Synopsys DesignWare`, `soc:i2cdsi`, `smu`, `mac-io` and `u4`;
   - by reading EDID at `0x50` (write `00`/read 128, write `80`/read 128, header fix) under the bus's
     lock, and comparing the base block.

   The NVIDIA proprietary driver names every adapter `NVIDIA i2c adapter N`, so these cannot be told
   apart by name. They are all read at `0x50`, like ddcutil and the vendor's `FindMonitorByEDID` do.
3. **Merge by EDID serial** (D6). When a display has no 0xFF serial, the 32-bit serial, then the
   connector name, is used. Two connectors that show the same monitor become one entry with two
   i2c transports.
4. **VIA bridges.** Take `2109:8884` devices that are not hubs. Other VIA product ids are probed
   only when listed in `viaProductIds` (CLI `--via-pid`); see Deviations.
   - A device is a hub if its descriptor `bDeviceClass` is `09` (`usb/ids.ts` `usbDeviceClass`).
   - For backends without the class, sysfs `bDeviceClass` decides, and after that the known hub
     PIDs 0211/0817/2817/2211.

   For each bridge, on a probe-less channel over the bridge's path:
   1. VCP C8; the scaler family must be known (RTK, MTK, NTK or HVW).
   2. ModelName, tried 3 times, 150 ms apart.
   3. Pairing: exact, then loose `^(PHL |…)?<EDID name>[0-9A-Z]*`, with the EDID name regex-escaped.
      A tie is broken by the factory SN; if it stays ambiguous the bridge is left unpaired.
   4. The USB-DDC probe, on a channel that also holds the paired monitor's key.
   5. The factory SN is compared with the EDID serial. A mismatch is only a warning.

   Unpaired or unsupported bridges are closed.
5. **ENE `0cf2:a201`.** It is attached to the monitor whose VIA bridge shares the longest USB
   port-path prefix, or to the only monitor.
6. **Result.** `transports` is `[VIA?, i2c…]`. `I2cDevTransport`s open their device lazily, so
   discovery itself never opens `/dev/i2c-N` except in the EDID-matching step.

### Transports

- **VIA.**
  - Write: `40 B2 0000 0000 N`, with data `6E` plus the message; at most 32 bytes.
  - Read ≤ 32: `C0 A3 0000 006F N`.
  - Read > 32: `C0 A7 0000 006F 20` then `C0 A9 0000 0000 N-32`.
  - A short IN transfer leaves a zero tail. Transfer timeout is 1000 ms.
  - The traffic is asserted byte-exact against `usb/FakeUsbBackend`'s journal.
- **i2c-dev.**
  - Opens with `open(O_RDWR)` through `node:fs`, then `ioctl(I2C_SLAVE=0x0703, 0x37)` through koffi,
    which is loaded lazily.
  - Uses a separate `read(2)` and `write(2)` (async on the libuv pool), never `I2C_RDWR`.
  - A short transfer is an error. A failed open is retried on the next operation. Errors carry
    hints for `ENOENT` (load `i2c-dev`), `EACCES` (udev rule) and `EBUSY`.
  - `EBUSY` from `I2C_SLAVE` means a kernel driver has claimed the address. For `0x37` that is the
    out-of-tree `ddcci` driver (ddcci-backlight). Like ddcutil, the transport then retries with
    `I2C_SLAVE_FORCE` (`0x0706`) and logs a warning: that driver's own traffic, for example
    brightness changes through its backlight device, is not serialized with ours.
    - Other addresses, such as the EDID EEPROM at `0x50`, are never forced.
    - If even the forced call fails, the error names ddcci and how to unload it.
  - Tests use a fake `I2cSyscalls`. The real binding is checked only on a regular temp file
    (`ioctl` reports `ENOTTY`); nothing touches `/dev`.
- **Simulator.** `SimulatedMonitor` works on raw frames:
  - VCP state seeded from 03 §6.3 / 06 §5.7;
  - picture values stored per SmartImage mode (DC);
  - EQ band selector plus gain (E2A001/E2A039), E2A038 Ambiglow reset, E2A042 picture reset, 04
    factory reset;
  - continuous controls clamped;
  - RC=1 for codes outside the capability string;
  - capabilities in 32-byte fragments, and the FE page (model, BOM, version, dual bank, scaler, SN
    in both request forms);
  - EDID at `0x50`;
  - fault injection: NACK on write or read, bad checksum, null reply.

  Values never read on real hardware are marked "synthetic" in `mock-34m2c8600.ts`. The panel name
  and boot-flag address answer with a null message (unknown).

  **Synthetic identity (security review).** The simulator ships in the package (`EVNIA_MOCK_MONITOR`,
  `cli.ts --mock`, the install test). So it carries no identifier of the user's unit:
  - the serial is `MOCK_SERIAL` = `MOCK000000001`, in the TPV GetSN answer and in the EDID's 0xFF
    descriptor;
  - the EDID's 32-bit serial number is 1, with the base-block checksum recomputed;
  - everything else of the EDID (PnP id, product code, week/year, name, timings, extension block) is the
    model's.

  Tests that compare with data captured on the user's monitor (golden transcripts, the logged EDID dump,
  the LOG26 banner, the Windows profiles) use `test/fixtures/user-monitor.ts` `USER_34M2C8600`, which
  has the real EDID and serial. They pass it as `createMock34M2C8600({spec})`,
  `MonitorManagerOptions.mockSpec` or `new SimulatedMonitor(spec)`. `edid.test.ts` checks that the
  shipped EDID differs from the real dump only in the serial bytes (12-15, 77-89) and the checksum. A
  packaging test scans the bundle sources and `build/app` for the real serials.

## Deviations from the vendor (deliberate)

| Vendor | Port | Why |
|---|---|---|
| Per-call "hub, then GPU" fallback | Sticky active transport; one-shot actions never replayed; re-evaluated by `probe()` | 20 D1/§2.2: a dead bridge would cost about 3.5 s per call; replaying a swap or refresh repeats the action |
| `elapsed > sleepTime ? 15 : sleepTime - elapsed` | `max(15, sleepTime - elapsed)` | Never shorter than 15 ms. The two are identical on real timings, where `elapsed` is at least 100 |
| Hub path sends out-of-range values as 0 (`ToUInt16`) | `RangeError`-style `DdcError('argument')` | Writing 0 by accident (for example input or brightness) is harmful |
| Hub does not check the source byte until after the retries | `r[0]==0x6E` is part of validation, so the attempt is retried | More robust; no behavioural difference on valid replies |
| Capabilities: 27-byte cap, stop below 26, abort after 3 failures total | Standard MCCS advance, balance or end-marker stop, 3 retries per fragment, short-fragment fallback | 08 §3.5 / 07 §8.4-H / 20 §2.6 recommendations |
| A9 failure ignored, A9 retried alone | A failed A9 fails the whole read, which is then retried from A7 | The I2C transaction state after a failed continuation is unknown |
| GPU-path timing `Sleep(5·a)` before the read | Hub timing on both transports | 20 §2.7: one shared table |
| i2c GET reads payload+3 (11) bytes | 32 bytes | 20 D3 |
| EDID name inserted unescaped into the pairing regex; last display wins | Escaped; first exact match, then first loose match; ties by SN | Correctness |
| Bridges with an unknown scaler still enumerate on Windows but get no model | Skipped (no pairing is possible) | Same outcome |
| Cache written in place, unserialized | Temp file plus `rename`; writes queued per instance; unique temp names | Crash safety; overlapping saves no longer fail with `ENOENT` |
| The DDCHelper-path capability string is post-processed to `vcp(...)` only | The full raw string on every transport | Superset; `analyseVcpString` gives the same map |
| Every `2109` non-hub device gets `B2`/`A3` DDC requests; on Windows only functions bound to WinUSB can be opened (`Interface13` `WinUsb_Initialize`) | Only `2109:8884` by default; more PIDs through `viaProductIds` / `--via-pid`; hubs excluded by descriptor class | usbfs lets a privileged process (for example the CLI under sudo) send vendor requests to any VIA function, such as billboard, PD or dock controllers, whose meaning for `B2`/`A3`/`A7` is unknown. Each silent device would also cost about 3.5 s of backoff |
| GetScalerIC reads `r[9]` whenever `L >= 5` | Requires `L >= 8` | For `L` = 5..7, `r[9]` is the checksum or bus padding; a `0x09` there would read as RTK |
| No process-level lock (single-instance app) | Per-path in-process queue, plus a per-transaction flock under `$XDG_RUNTIME_DIR/evnia` | 20 §2.4: rescans, a second instance and the CLI must never split a request from its reply |
| DDCHelper (ADL/NVAPI) owns the GPU bus | `EBUSY` on `0x37` is retried with `I2C_SLAVE_FORCE` and a warning, like ddcutil | With the `ddcci` kernel driver loaded, the i2c fallback would otherwise be dead |
| EDID probing on every GPU adapter | ddcutil's ignore list (SMBus, AMDGPU SMU, …) | Those buses host EEPROMs and firmware controllers |

## Known limitations and open items

- **Cross-tool locking** against ddcutil (20 §2.4: `flock` on `/dev/i2c-N`) is not implemented,
  because the report marks ddcutil's behaviour "L/verify". The process-level lock files are
  implemented, but only this app and its CLI take them.
- **Lock scope.** The lock files live in the user's runtime directory. Processes of other users do
  not see them, except root under sudo, which uses the invoking user's directory. Processes that
  lock only transport ids (no `monitorKey`) are serialized per path, not per monitor.
- **Reply layout.** The extended reply layout (8 vs 10 bytes) is unconfirmed (20 Q1, checklist C9);
  length-relative parsing covers both. The 20 §2.7 fallback to 11-byte reads when a 32-byte read
  fails is not implemented; nothing suggests it is needed.
- **The 2109:8884 descriptors** are unknown (08 Q1). Some fwupd plugins may probe VIA devices (20 Q2).
- **EDID over i2c** reads only 256 bytes, like the vendor; there is no E-DDC segment pointer. The
  sysfs EDID (all blocks) is preferred and is what discovery uses.
- **Panel name and boot-flag address** of the real monitor were never captured, so the simulator
  answers them with a null message.
- **Probe failures.** A transport whose probe failed stays disabled until `probe()` is called again.
  The driver must call it on detection events.

## What the next wave must do

### Monitor driver (`src/backend/monitor/`)

1. **Discover.** Call `discoverMonitors({ log, usb, supportsModel })`.
   - `supportsModel` is the MonitorInfo.json whitelist: `^((PHL )|(PHL_)|(PHL))?<name>$`,
     case-insensitive.
   - For each monitor, create **one** `new DdcChannelImpl(monitor.transports, { log, monitorKey:
     monitor.key })` and share it with the Ambiglow DDC fallback. Never create per-feature channels;
     the queue is shared anyway.
   - **Always pass `monitorKey`.** It is what serializes a second instance or the CLI talking to the
     same monitor over the other path. `monitor/display.ts` currently builds its channel without it.
   - Mock mode: pass `processLock: null` (the simulator is private to the process).
   - Call `channel.probe()` on connect, `Device_DetectionDisplay` and `Device_DetectionUSB`. For
     `ddc.transport = usb|i2c`, pass only those transports.
2. **Capability cache.**
   - Construct `new CapabilityCache(join(serveDataDir, 'Config', 'data.json'))`. The vendor code
     says `config`, but the Windows directory is `Config`, and Linux is case-sensitive.
   - Build the key with `capCacheKey(version, await channel.getVcp(0x60))`. `version` is
     `readTpvString(channel, 'fwVersion')` (`FE E1 E6 06 00` works on both transports). On i2c only,
     the vendor first tries `fwVersionFromC9(await channel.getVcp(0xC9))`.
   - The cache name is `edid.monitorName` (`"PHL 34M2C8600"`).
   - On a miss, call `channel.capabilities()` and save the string only if `analyseVcpString(raw)` is
     non-null.
3. **Identity strings.**
   - `DispalyData.MonitorEDIDInfo_T = edidDisplayStrings(monitor.edid as EdidDetails, sep)`, where
     `sep` is `localeDecimalSeparator()` or the `display.edidDecimal` setting.
   - `Display.SN` and the UI key are `monitor.key` (the EDID serial).
   - `ModelName`/`MonitorName` is `edid.monitorName`, and it must match exactly for `.pcenter`
     import (20-theme §10).
4. **Reads.** `getVcp`/`getExt` return `resultCode`. The vendor hub ignores it; map any rejection to
   `err_code 9`.
5. **Writes.** Values must be 0..65535. The vendor's `ToUInt16` "sends 0" behaviour is refused with
   `DdcError('argument')`; decide per call site if parity matters. Sets are fire-and-forget like
   the vendor: no read-back.
6. **IsSmartImageHDR.** Derive it from the DC value (policy P1, 20 D8). That is monitor-side and not
   part of this module.
7. **Hotplug.** A VIA detach makes USB operations fail with `io` and fail over to i2c automatically.
   On `USBChange`:
   1. Call `probe()` on the existing channel.
   2. If the bridge re-enumerated, its old handle fails with `no-device` (see
      `usb/ids.ts isSameEnumeration`). Re-run `discoverMonitors`. It is safe while the old channel
      is still in use: discovery runs under the scan lock, and its bridge and EDID traffic holds the
      same path and monitor locks as the driver's channel.
   3. Build the new channel over the new transports (with `monitorKey`), then `close()` the old
      channel. Closing waits for the old channel's queue and closes its transports.
   4. Close the transports of discovered monitors you do not keep.
8. **Busy.** `DdcError('busy')` means another process (a second instance or the CLI) held the
   monitor's lock for 15 s. Treat it like any failed get or set (`err_code 9` / -1); the transport
   is not marked unusable.

### API / integration

- **Mock mode.** For `EVNIA_MOCK_MONITOR=34M2C8600`, either:
  - use `createMock34M2C8600()`, which returns a ready `DiscoveredMonitor` (VIA over `FakeUsbBackend`
    plus i2c over mock syscalls) and the `SimulatedMonitor` for assertions; or
  - run the real `discoverMonitors` against `writeMockSysfs(tmp, bundle.monitor, …)` with
    `bundle.usb` and `bundle.i2c`, which is what `cli.ts --mock` does.

  Pass `NO_DELAY_TIMINGS` for speed, or keep `VENDOR_TIMINGS` for realistic latencies (a full load
  takes about 11 s).
- **Event loop.** All I/O is async. The only synchronous FFI calls are the `ioctl(I2C_SLAVE)`, which
  does no bus traffic, and `flock(LOCK_EX|LOCK_NB)`, which never waits. Nothing blocks the event loop
  (20-backend-host-tail §840).
- **Packaging.** The udev rules and `modules-load.d/evnia-i2c-dev.conf` in 20 §2.9 are needed on
  real hardware (packaging module).

## CLI

```
node src/backend/cli.ts list [--all] [--json]               # connectors, buses, bridges, ENE, probe results, EDID strings
node src/backend/cli.ts caps [--transport via|i2c]         # raw + parsed summary
node src/backend/cli.ts get 10 | 0x60 | e2a039             # read-only
node src/backend/cli.ts set <code> <value> --yes           # refused (exit 2) without --yes
node src/backend/cli.ts identity                           # C8, model, BOM, version, bank, scaler, SN
  --mock  --monitor <serial|connector>  --via-pid <hex>...  --verbose  --sysfs <dir>  --dev <dir>
```

- **Real hardware** uses `usb/LibusbBackend` and the real i2c syscalls with vendor timings.
  - Each transaction takes the same locks as the app (path plus `monitorKey`, flock under
    `$XDG_RUNTIME_DIR/evnia`), so the CLI can run while the app is running.
  - Prefer running it as the desktop user; the udev `uaccess` rule grants access. Under `sudo`, the
    lock files of the invoking user (`SUDO_UID`) are used.
  - `--via-pid` lets bring-up try another VIA bridge PID; the default is `8884` only.
- **`--mock`** runs the full discovery path against a temporary fake sysfs, without the
  cross-process lock.
- **Exit codes:** 0 on success, 1 on failure, 2 on a usage error or a refused write.
- Run it on the device in the read-only order of 20 §7: `list`, `get 14`, `get 60`, `identity`,
  `caps`. Then try `set` on brightness (0x10) only, and restore the value.

## Tests

```
MSYS_NO_PATHCONV=1 docker run --rm -v "C:\path\to\repo:/repo" -w /repo/port evnia-port-dev \
  bash -c 'node --test "test/unit/ddc/*.test.ts"'
```

There are 95 tests in `test/unit/ddc/` (`helpers.ts` holds the virtual clock, a scripted transport and
the fixture loaders).

| Area | What the tests check |
|---|---|
| Codec | Every worked frame from 07, 08 and 20; reply validation and parsers; scaler IC `L >= 8` |
| Capabilities | The real string; the vendor parse dump; edge cases of the vendor regexes; reader stop and fallback rules |
| Cache | Byte-exact round trip of the real `data.json`; tamper and legacy handling; CacheVcpMgr semantics on disk; 100 overlapping saves plus save/delete races, and two instances on one path |
| EDID | The real dump; the persisted `MonitorEDIDInfo_T` reproduced exactly; locale mapping |
| Channel | Exact timing sequences on a virtual clock; retries; sticky failover; one-shot and topology rules; probe rules; queue ordering |
| Locks | Path-lock ordering (first come, first served, mixed key orders, release on rejection) |
| Locks (flock) | Real `flock` through koffi between two lock instances; the `busy` timeout; lock-file names; `lockPlace` including sudo; `chown` to the invoking user; degrading when the directory is missing |
| Locks (channel) | One process-lock hold per transaction; `busy` not retried, failed over or recorded as a failed probe |
| VIA | Byte-exact control transfers through `FakeUsbBackend` |
| i2c-dev | Syscall sequence and lazy open; `EBUSY` then `I2C_SLAVE_FORCE` on `0x37` only; the real koffi `ioctl` binding (both requests) on a regular file |
| Simulator | Semantics of `SimulatedMonitor` |
| Discovery | Fake sysfs trees: link kinds, R6, PCI class gate, the ignored adapters (SMBus, AMDGPU SMU), brand, serial merge, pairing, tie-break, D6, ENE |
| Discovery (USB) | Hub exclusion by descriptor class, sysfs or PID; the PID allowlist |
| Discovery (rescan) | A rescan while a driver channel polls gives a strictly alternating `W R` journal and correct values. This test fails when the queue is keyed per object |
| CLI | `main()` in-process with `--mock`; argument parsing |
