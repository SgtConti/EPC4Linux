# Evnia Precision Center 1.13.0: online sweep, part 2 (security findings, network-deny guard, strip checklist, offline tests)

## Summary

This report completes `14-online-sweep.md`, which stops inside "## 9. Security findings relevant to the port" at row S1. Report 14 was not edited. Its N01..N40 inventory is complete, so this report reuses those IDs. Section numbers continue from report 14 (§9 to §14), so report 14's dangling references now resolve here: N13's "network-deny guard in §9" is §10.1 to §10.4, and N31's "Replacement: §9" is §10.5.

Main results:

- **24 security findings (S1 to S24)**, each re-read in code (§9.1). The worst ones in the user's current Windows install are:
  - The EvniaServe HTTP/SignalR endpoint on `*:10010`. It has no authentication, no Origin or Host check, and a reflective dispatcher that exposes all 163 public `Bridge` functions. Results go to every connected client (S1 to S4).
  - `GetWifiList`, which returns stored Wi-Fi passphrases. It also builds a `cmd.exe` command line from every SSID in radio range (S5, S6).
  - The silent self-updater. Its only integrity check is a server-supplied MD5 (S14).
  - Renderer-to-main primitives that turn any script injection into command execution: `runCommand`, `softwareInstall(path)`, `openDefaultBrowser`, raw `fs`, and no IPC allowlist (S9, S12). The CSP makes that injection easier (S10).
- **None of these reach the port.** All online code is dropped. The one socket that must stay (the SignalR hub) is rebuilt on loopback with a per-launch token, Origin and Host checks, replies to the caller only, and an explicit function allowlist (§10.7).
- **§10: network-deny guard.** Several layers: an Electron `webRequest` allowlist, Chromium resolver and proxy dead-ends, spellcheck off, window/navigation/permission denial, a confined `local:` handler, a Node-side egress ban, and packaging rules. §10.5 gives the exact replacement CSP for `index.html` and `notice.html`.
- **§11: strip checklist.** Every N01..N40 is mapped to the vendor artefact to delete or patch and to the port mechanism. Patches P1 to P11 are re-rated for "OTA removed, monitor only, peripheral pages hidden". New patches P12 to P16 are defined. P12 removes the embedded cloud credentials from the reused renderer bundle.
- **§12: offline acceptance tests (T1 to T8).** These are for the user to run later on Linux: `ss -tulpn` shows loopback only, an Electron `--log-net-log` capture has no external host, the app starts and works with networking disabled, a syscall trace shows no egress, and package-content, fuse and renderer-surface checks pass.
- **Corrections** to reports 01, 02, 05, 13 and 14 are at the end.

Legend (as in report 14): **AP** = `work/app-pretty/`, **OUT** = `work/app/out/` (original minified bundles), **DC** = `work/dotnet-clean/`, **INST** = `Evnia Precision Center/`, **UD** = `%APPDATA%\evnia`, **SD** = `%APPDATA%\EvniaServe`. Short forms:
- **EM** = `AP/main/index.js`
- **PL** = `AP/preload/index.js`
- **ST** = `AP/renderer/assets/styles-DAnQi2A8.js`
- **MN** = `AP/renderer/assets/main-CDosWiM3.js`
- **FB** = `AP/renderer/assets/feedback-NPrjkfNw.js`
- **MCJ** = `AP/matter-control.mjs`
- **SO** = `DC/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs`
- **ES** = `DC/EvniaServe/`

"CONFIRMED" means read in code or seen in the user's real logs and state. "INFERRED" means reasoned from code or documented platform behaviour, but not observed. No corpus binary was run, and no network or hardware was touched. The vendor agent files `work/app/VENDOR_*.md.txt` were treated as untrusted and ignored. Secret values are **not** reproduced anywhere in this report, not even as prefixes.

---

## 9. Security findings relevant to the port

### 9.1 Re-verification log

Each item the task named was re-read. Line numbers are those of the files as they are now.

| Item | Result | Actual location |
|---|---|---|
| Kestrel bind | CONFIRMED `webBuilder.UseUrls("http://*:10010/")` | ES/Evnia/Program.cs:37. Electron also passes `--urls http://*:<port>` (EM:13562; user log `26-09-26.log:10` "on 10010") |
| Startup pipeline | CONFIRMED | ES/Evnia/Startup.cs: `AddControllers` 37, `AddSignalR` 38 and 55-58 (1 MiB), default CORS policy `https://*:10010/` 39-45, `AddSwaggerGen` 46-53, `AddHostedService` 54, **`UseDeveloperExceptionPage` 63 (unconditional)**, `UseSwagger`/`UseSwaggerUI` 64-68, `UseC