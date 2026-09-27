# Implementation notes: `hub` (SignalR server), `rpc` (dispatcher, notifier) and the backend composition root

Module owner: hub-rpc. Sources: `port/src/backend/hub/*`, `port/src/backend/rpc/*`, `port/src/backend/index.ts`, `port/src/backend/api/system-minimal.ts` (removed by the integration wave; the composition root is described in `impl-integration.md`). Tests: `port/test/unit/hub/`, `port/test/unit/rpc/` (80 tests, about 14 s; `node --test "test/unit/hub/*.test.ts" "test/unit/rpc/*.test.ts"`; the LAN-interface test skips when the container has no network).

Specs: `docs/re/02-renderer-shell.md` §4, §6, §L.4; `05-backend-host.md` §2.3–§3.3 (truncated after §3.3); `20-backend-host-tail.md` §1 (dispatcher errors, port rule, frames on the wire); `20-online-sweep-tail.md` summary (hub hardening). Ground truth: `work/dotnet-clean/EvniaServe/Class0.cs` (dispatcher), `Evnia/InputParams.cs`, `Evnia/EvniaHub.cs`, `Evnia/HandleEvent.cs`, `Evnia/Startup.cs`, `Zeasn.Com.Lib/JsonResult.cs` and `Extension_Json.cs`, `Bridge.Lib/Bridge.cs`, `Zeasn.PCenter.Entity.Lib/SoftConfigInfo.cs`. The vendor client is `work/app-pretty/renderer/assets/styles-DAnQi2A8.js:7888-8032` (class `Jc`). The integration tests use the same `@microsoft/signalr` 7.0.14 package the renderer bundles. The real request lines in `port/test/fixtures/windows/logs/EvniaServe-2026-09-2*.txt` are replayed as a contract test.

No new dependencies. No additions to `types.ts`.

---

## 1. Files

| File | Content |
|---|---|
| `hub/protocol.ts` | SignalR JSON hub protocol v1, pure functions: `RecordReader` (0x1E framing on bytes, 1 MiB limit, strict UTF-8), `checkHandshake()`, `parseHubMessage()`, and record writers (`invocationRecord`, `completionRecord`, `closeRecord`, `PING_RECORD`, `HANDSHAKE_OK`, `handshakeErrorRecord`). `HubProtocolError` has the name `InvalidDataException`. |
| `hub/security.ts` | `generateHubToken()` (32 random bytes as base64url, 43 characters), `tokenMatches()` (constant-time, SHA-256 of both sides), `originAllowed()`, `hostAllowed()`, `ALLOWED_ORIGINS`, `MIN_TOKEN_LENGTH` |
| `hub/rejection-log.ts` | `RejectionLog`, the rate limit for "rejected …" warnings (§4), and `REJECTION_LOG_DEFAULTS` (5 lines per kind per 60 s) |
| `hub/signalr-server.ts` | `startSignalRServer(options) → HubServer {port, connectionCount, broadcast(target, arg), close()}`, plus the constants `HUB_HOST`, `HUB_PATH`, `DEFAULT_HUB_PORT`, `HUB_METHOD`, `NOTIFICATION_TARGET`, `HUB_DEFAULTS`, `MAX_BUFFERED_BYTES` and `SHUTDOWN_GRACE_MS` |
| `rpc/input-params.ts` | `parseInputParams()` gives Newtonsoft semantics for `Evnia.InputParams`. It uses a small JSON parser that keeps number lexemes (`parseJToken`) and exposes `toInt32()`. `salvageRequestIds()` reads the ids of a request that failed to bind (§3.2 step 1) |
| `rpc/dispatcher.ts` | `RpcDispatcher implements RpcRegistry`, which reproduces `Class0`, plus the handler watchdog (§3.2) and the read-only `registrations()` view (§7). Also `DispatchErrors` (the vendor texts), `DispatcherOptions`, `DEFAULT_HANDLER_TIMEOUT_MS`, `handlerTimeoutMessage()`, `RegisteredOverload`, `VENDOR_QUIET_FUNCTIONS`, `VENDOR_SERIALIZE_MODES` and `netSignature()` |
| `rpc/notifier.ts` | `HubNotifier implements Notifier`, adding `subscribe()`. It is the `HandleEvent` path |
| `index.ts` | `createBackend()`, `startHubServer()`, `ApiModule`, `ApiServices`/`CoreServices`/`ServiceSlots`/`BackendService`, `BackendComposition`, `BackendEvents`, `API_MODULES`, and re-exports `generateHubToken`, `DEFAULT_HUB_PORT` and `HUB_PATH`. `ServiceSlots` is typed with the `services.ts` contracts |
| ~~`api/system-minimal.ts`~~ | Removed by the integration wave: `API_MODULES` (now in `compose.ts`, re-exported here) lists the real modules, and `createBackend(options)` without a composition builds the production services (`impl-integration.md` §2) |

## 2. Public API (what Electron main uses)

```ts
import { createBackend, startHubServer, generateHubToken } from './backend/index.ts';

const token = generateHubToken();                       // per launch; give it to the preload
const backend = createBackend({ host, usb, mockMonitor });  // production services + API_MODULES (compose.ts, impl-integration.md)
await backend.start();                                  // starts the service slots: themes → monitors → ambiglow
const hub = await startHubServer(backend, { token, log, allowedOrigins: ['file://'] });  // 127.0.0.1, port 10010 upward; §4
// ipc 'startupBackendService' → hub.port ; preload → window.__EVNIA__.hubToken = token
backend.hotplug('usb' | 'display');                     // after the host's debounce (01 §9)
await hub.close(); await backend.stop();                // on quit: close() waits ≤1 s for running requests
```

- `createBackend(options, {services?, modules?, dispatcher?})`: `dispatcher` takes `DispatcherOptions` (`handlerTimeoutMs`, default 120 000; `quietFunctions`).
- `startHubServer(backend, {port?, token, log?, allowedOrigins?, keepAliveIntervalMs?, clientTimeoutMs?, handshakeTimeoutMs?})` returns `Promise<{port, connectionCount, close()}>`. It resolves once the server is listening. `port` is the port actually bound.
- `hub.close()` sends every client a Close, stops listening, drops invocations that are still queued, and resolves once the `GetTaskAsync` calls that are already running have finished, or after `SHUTDOWN_GRACE_MS` (1 s) with a warning. That makes `await hub.close(); await backend.stop();` safe: no service is stopped under a running handler (a DDC write, the `Start` scan) unless that handler overruns the grace period. The 1 s fits inside Electron main's 3 s quit deadline.
- The renderer connects to `ws://127.0.0.1:<port>/EvniaHub?k=<token>`. The vendor-UI patch `HUB-URL` in `scripts/ui-patches.mjs` already rewrites the client URL to exactly that, reading `window.__EVNIA__.hubToken`, and the CSP allows `ws://127.0.0.1:*`. The preload/main module must expose that token.
- **Keep one hub for the whole app lifetime.** On reconnect the renderer ignores any new port (02 §4.7), so a hub restarted on another port would never be reached.

## 3. How it maps to the vendor

### 3.1 Hub (`EvniaHub`, ASP.NET Core 3.1 SignalR; 02 §4.2, 05 §2.3–2.4)

| Vendor behaviour | Port |
|---|---|
| `/EvniaHub`, JSON protocol, client uses `skipNegotiation` + WebSockets | Upgrade on `/EvniaHub` only; the path match is case-insensitive, as in ASP.NET routing. No `/negotiate`: every non-upgrade HTTP request gets 404, because the client never negotiates. |
| Handshake `{"protocol":"json","version":1}␞` → `{}␞`; errors → `{"error":…}␞` + close | Same. Protocol names match case-insensitively. Only version 1 is accepted (3.1: `version == 1`). ASP.NET error texts: `The protocol 'x' is not supported.`, `The server does not support version N of the 'json' protocol.`, `An unexpected error occurred during connection handshake. InvalidDataException: …` |
| One hub method `Task GetTaskAsync(string)`; the result is sent with `Clients.All.SendAsync("GetTaskAsync", json)` and then a void Completion, `CompletionMessage.WithResult(id, null)` (20 §1.4) | Same order, but the result goes to the **caller only** (security review; 20-online-sweep-tail summary "replies to the caller only", §10.7, vendor finding S4): first `{"type":1,"target":"GetTaskAsync","arguments":[json]}` to the calling connection, then `{"type":3,"invocationId":…,"result":null}` to the caller only if an `invocationId` was sent (the client's `invoke()` resolves with `null`). A non-blocking `send` gets no Completion. Notifications raised while the handler runs go out before the reply: the wire order is Notification…, GetTaskAsync, Completion (20 §1.4). |
| Binding (ASP.NET) | Target names are case-insensitive. The call needs exactly one string-or-null argument and no streams. Errors go back as Completion errors: `Failed to invoke 'X' due to an error on the server. HubException: Method does not exist.` / `Failed to invoke 'GetTaskAsync' due to an error on the server.` / the streaming-invocation text. A null argument reaches the dispatcher as `""`, which fails exactly as `null` does in `Class0`. |
| Invocations from one connection are serialized (3.1 receive loop) | A per-connection promise chain. Other connections are not blocked. Pings and Close are still handled while an invocation runs, so a call longer than both timeouts (the ~21 s `Start`, 20 §7.2) does not drop the renderer; an integration test runs a 3 s call against 1 s timeouts with the vendor-configured client. Invocations queued on a connection that has since closed are dropped. The chain relies on every call settling, which the dispatcher's handler watchdog guarantees (§3.2). |
| `KeepAliveInterval` 15 s, `ClientTimeoutInterval` 30 s, `HandshakeTimeout` 15 s, `MaximumReceiveMessageSize` 1 MiB | Same defaults (`HUB_DEFAULTS`). A ping is sent when nothing else was sent for 15 s; the ticker runs every ≤1 s. The client stops scheduling its own pings unless it receives data, so server pings are required, not optional. All three timers run on `performance.now()` (CLOCK_MONOTONIC), like Node's timers and Chromium's: after a suspend/resume or a wall-clock step the renderer is neither dropped nor left without pings, so there is no spurious reconnect and loading overlay (02 §4.7). |
| Notifications: `HandleEvent` → `Clients.All.SendAsync("Notification", json)` | `backend.onNotification` → `broadcast('Notification', json)`. They are dropped when no client is connected, as in the vendor. |
| Malformed message → InvalidDataException → connection closed | `{"type":7,"error":"Connection closed with an error.","allowReconnect":true}`, then WS close 1011. Only the offending connection is affected. A WS message larger than 2 × 1 MiB is refused by `ws` (1009). |
| Port: Electron `getFreePort(10010)` increments on any listen error until 65535 | The hub binds directly (no probe-then-spawn race) and moves upward only on `EADDRINUSE`/`EACCES`. Port 0 means "any" (tests). |
| Host shutdown | `close()`: Close record (`allowReconnect:true`) + WS close 1001 to every client, new upgrades get 503, queued invocations are dropped, running ones are awaited up to `SHUTDOWN_GRACE_MS` (§2). |

### 3.2 Dispatcher (`Class0.method_0/1/2`)

The check order decides which error a malformed request gets. It is reproduced exactly (see the header of `rpc/dispatcher.ts`):

1. `parseInputParams` returns null → `解析json字符串: <raw>失败`. `JsonDeserialize` swallows every exception, so all parse and conversion failures land here: non-object root, `"parms":"x"`, `"device":1.5`, trailing text, and so on. The vendor sent this with RequestId and FunctionName null, which the renderer takes for a notification, so the caller's promise never settled. The port applies the port rule of 20 §1.3 instead: when the text is still a JSON object, `salvageRequestIds()` reads `functionName` and `requestId` with the same Newtonsoft name matching and string conversion, and the reply echoes them. An id that cannot be read (not JSON, not an object, an object/array value) stays null. The err_msg is unchanged.
2. `functionName` missing or null → `Object reference not set to an instance of an object.`. This is the vendor's `string_0.Trim()` NullReferenceException. It is **not** `functionName is null`, which only covers empty or white-space names (.NET `char.IsWhiteSpace` set; U+FEFF is not white space).
3. Any parameter that is not Integer, String or Boolean → `Unsupported parameter type: <Float|Null|Object|Array>`. This check runs **before** the name lookup and reports the first bad token.
4. Unknown name (case-sensitive) → `functionName: X undefined`.
5. No overload with the exact type list → `params error: ` followed by the .NET `MethodInfo.ToString()` of every overload, joined by ` | `, e.g. `Zeasn.Com.Lib.JsonResult PHL_SetOSD(System.String) | Zeasn.Com.Lib.JsonResult PHL_SetOSD(System.String, Int32)`.
6. An integer outside int32 → `Value was either too large or too small for an Int32.`.
7. `device` other than −1 with a non-null `parms` → `Parameter count mismatch.`. The vendor prepends `device` after choosing the overload by `parms` only. With `parms:null` the vendor passes no arguments and ignores `device`. The renderer never sends `device` (02 §4.4).
8. Handler returns null or undefined → `functionName: X  return null obj` (two spaces).

Every result echoes RequestId and FunctionName (from step 2 onward as in the vendor; step 1 best-effort). Handler results are copied, never mutated.

**Handler watchdog** (port deviation, §5 item 9). Every handler runs under a timer, `DispatcherOptions.handlerTimeoutMs`, default `DEFAULT_HANDLER_TIMEOUT_MS` = 120 000 ms. When it fires:

- the request is answered with `err_code 9`, `err_msg` `functionName: <name> timed out after <ms> ms`, and RequestId and FunctionName echoed;
- `rpc/<name>` logs an error;
- the next queued request of that connection runs.

The handler is not cancelled. When it settles later, the result is dropped with a warn line, or with an error line if it failed. `0` or less disables the watchdog, which is the vendor behaviour. Values above 2³¹−1 ms throw a RangeError. The 120 s limit is well above the longest legitimate call, the ~21 s `Start` scan, which `api/system.ts` already answers after 60 s.

- Integer vs Float follows Newtonsoft's spelling rule: `1` is Integer; `1.0`, `1e3` and `-0.5` are Float. That is why `JSON.parse` is not used.
- `InputParams` binding mirrors Newtonsoft (details in the header of `rpc/input-params.ts`):
  - property names match exactly or case-insensitively;
  - unknown properties are ignored and JSON nulls are skipped;
  - a repeated property overwrites, except a repeated `parms`, which is appended;
  - string properties read numbers by their spelling and booleans as `"true"`/`"false"`;
  - `device` accepts an int32 or an integer string (`" +42 "`), and `""` counts as absent;
  - MaxDepth is 64.
- Serialization uses `core/envelope.ts` `serializeResult` in the overload's mode. `Profile_GetDeviceData` defaults to `uiProfileGet` (`Class0.list_1`, `VENDOR_SERIALIZE_MODES`) unless the registration passes a mode.
- Logging:
  - `GetTaskAsync param = <raw>` is logged at debug for every request except `Effect_GetLEDs` and `Effect_CheckDynamicLightingEnabled` (`Class0.list_0`).
  - `Unsupported parameter type` and handler exceptions are logged at error.
  - Handlers get `ctx.log` = `rpc/<functionName>`.

### 3.3 Notifier (`HandleEvent.method_0`)

`notify(name, tag)` serializes `{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":…,"FunctionName":name,"CurrItem":null}`. That is `new JsonResult { FunctionName, Tag }`: `err_msg` is **null**, not `""`. It logs `OnNotification … param=<json>`, or `'The parameter exceeds the print limit'` above 1024 characters, and hands the string to every subscriber. A failing subscriber does not stop the others. A payload that cannot be serialized is dropped with an error log.

### 3.4 `api/system-minimal.ts` (removed)

The wave-1 placeholder was removed by the integration wave; `api/system.ts`, `api/device.ts` and `api/setting.ts` answer these functions now, and `test/unit/hub/backend.test.ts` keeps the same three replies as a test-local fixture. What it answered:

| Function | Tag | Vendor source |
|---|---|---|
| `Start()` | `true` | `SystemOper.Start` → `Succ(true)` |
| `Device_GetConnectList()` | `[]` | `GetConnectionDevice` with no devices |
| `Setting_GlobalData()` | `{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5}` | `Succ(GlobalOper.ConfigData)`; `SoftConfigInfo` field initializers. This is byte-identical to the user's `Config/SoftConfig.data` |

## 4. Security (replaces the vendor's unauthenticated `http://*:10010`)

- Bound to `127.0.0.1` only. A test checks that the LAN address refuses connections.
- Upgrade checks, in order:
  1. path → 404;
  2. `Host` must be `127.0.0.1:<port>` or `localhost:<port>` → 403. This guards against DNS rebinding and is recommended by 20-online-sweep-tail;
  3. `Origin`, if present, must be on the allow-list → 403. The default is `file://` and `null`, as the port task specifies; `allowedOrigins` replaces it;
  4. `k` must equal the token, compared in constant time → 403.
- **What each layer really stops.** The **token is the only barrier against browser content and local processes**. The other layers are narrower:
  - The Origin check only filters ordinary web origins: `https://…`, `http://localhost:…`, and a DNS-rebound name. Browsers set `Origin` themselves and scripts cannot forge it.
  - The Origin check does not keep web pages out. Any web page can open the socket from an opaque origin, which sends `Origin: null`. Opaque origins include a `<iframe sandbox="allow-scripts" srcdoc=…>`, a `data:` frame, and a page served with `CSP: sandbox`. Such a page addresses `127.0.0.1:<port>`, so the Host check passes as well.
  - A local `.html` file opened in a browser sends `file://` (Chromium) or `null`.
  - Non-browser clients send no Origin at all.
- **What Electron sends** (probed in the Docker image with Electron 44: a `BrowserWindow.loadFile` page, a sandboxed srcdoc iframe inside it, and a `loadURL('data:…')` page, each opening a WebSocket to a logging server):
  - the `loadFile` page sends `Origin: file://`;
  - the sandboxed frame and the `data:` page send `Origin: null`.

  The vendor renderer's SignalR client runs in the top-level `loadFile` page. **Electron main should therefore pass `allowedOrigins: ['file://']`**, which closes the opaque-origin path. It does not close the local-file path. The token stays per-launch, 256-bit, never logged and never written to disk by this module.
- Rejections are logged at warn with remote address, path, Origin and reason. The query string (the token) is never logged, and client-controlled text is clipped to 120 characters.
- Rejection logging is **rate-limited** (`hub/rejection-log.ts`). Any web page in the user's browser can trigger rejections without the token as fast as it likes (`new WebSocket('ws://127.0.0.1:10010/EvniaHub')` → 403 foreign Origin, `<img src=http://127.0.0.1:10010/x>` → 404). Per kind of rejection (plain HTTP, path, Host, Origin, token, shutting down, malformed target) the first 5 of each 60 s window are logged individually. The fifth line ends with `(further rejections of this kind are summarized)`, and when the window ends (checked by the hub's ticker, and at `close()`) one line `N more rejected hub request(s) not logged individually (<kind>)` reports the rest. A sustained flood therefore costs at most 6 lines per kind per minute.
- There is no REST API, no Swagger and no developer exception page. The only callable functions are those registered by `api/` modules, which is the explicit allowlist that replaces reflection over all 163 Bridge methods.
- Replies go to the **caller only** (security review; 20-online-sweep-tail summary §10.7, vendor finding S4). The vendor sent every result to all connections (`Clients.All`). With the token gate only token holders connect, but any second client (a debugging tool, the e2e `hubRpc` helper) would otherwise receive the renderer's replies, device serials and file paths included. With the one renderer client the wire bytes are identical. Backend Notifications are still sent to every client (`broadcast()`), as the renderer expects. Unit test: `signalr-server.test.ts` "replies go to the caller only …; notifications are broadcast to every client".
- A slow consumer is dropped (terminated, warn line) once more than 16 MiB (`MAX_BUFFERED_BYTES`) is queued for it; the other clients keep receiving. Silent sockets are dropped after 15 s without a handshake and 30 s without any message.

## 5. Deviations from the vendor (deliberate)

1. **Parse failures echo the ids** (§3.2 step 1, port rule of 20 §1.3). The vendor sent `RequestId:null`/`FunctionName:null`, which leaves the renderer's promise pending forever. The stock renderer's `JSON.stringify` requests always parse, so this only matters for malformed requests. The outer `Class0` guard (unreachable) also echoes the ids.
2. **Handler exceptions → `JsonResult.Exception(ex)`** with the ids echoed. The vendor would report the reflection wrapper's `Exception has been thrown by the target of an invocation.` But every `SystemOper` method catches internally and returns `JsonResult.Exception`, so API handlers can simply throw and get the vendor's function-level behaviour.
3. **Unserializable result → error envelope** (`JsonSerialize failed: …`) with the ids. The vendor broadcast `null`, which leaves the renderer's promise pending forever because there is no client timeout (02 §4.6).
4. **Strings are never Date tokens.** Newtonsoft's default `DateParseHandling.DateTime` turns ISO-8601 date-time strings (19–40 characters, `T` at index 10) and `/Date(…)/` into Date tokens, which `Class0` rejects as `Unsupported parameter type: Date`. A user naming a profile `2026-01-01T10:00:00` would hit that bug.
5. **Strict JSON grammar** for requests. Newtonsoft's lenient extensions (comments, single quotes, unquoted names, NaN/Infinity, hex/octal, trailing commas) fail with the parse error instead. The renderer only sends `JSON.stringify` output, so this never matters in practice. Newtonsoft's acceptance of raw control characters inside strings is kept.
6. **Hub hardening** (§4) and **127.0.0.1** instead of `*`, including rate-limited rejection logs (the vendor host rejected nothing, so it logged nothing).
7. **Close messages carry `allowReconnect:true`** (ASP.NET 3.1 predates the field), so the 7.x client goes straight into automatic reconnect. The vendor renderer would reconnect anyway through its `onclose` → `connect()` loop.
8. **Shutdown drains running requests** (§2): `close()` waits up to 1 s for `GetTaskAsync` calls already running before it resolves, so the services are not stopped under a handler.
9. **Handler watchdog** (§3.2): a handler still running after 120 s is answered with an `err_code 9` envelope and the ids echoed. In the vendor, one handler that never returned (a stuck USB/DDC transfer, a service bug) blocked that connection's queue forever. The server pings kept the socket alive, so the client neither timed out nor reconnected, and the renderer, which has no reply timeout (02 §4.6), stayed on its loading overlay until the app was restarted.
10. **Replies to the caller only** (§3.1, §4): the vendor broadcast every `GetTaskAsync` result to all connections. Identical wire bytes for the single renderer connection.

## 6. Known limitations

- Only `skipNegotiation` WebSocket clients are supported: no negotiate, no long polling, no SSE, no MessagePack. That covers the vendor renderer.
- Only JSON hub protocol version 1 is accepted. A future 8.x client asking for version 2 would get the handshake error.
- `connectionCount`, the 15/30/15 s timers and the 1 MiB limit are per server. They are not tuned per client.
- A handler still running after the 1 s shutdown grace (for example the ~21 s `Start` scan, 20 §7.2) races `backend.stop()`. The hub logs `N GetTaskAsync call(s) still running after 1000 ms, stopping anyway`; services must tolerate `stop()` while one of their calls is in flight (e.g. reject it with an error result).
- The watchdog cannot cancel a handler. After it fires:
  - the stuck call keeps running in the background;
  - the next request, possibly into the same service, runs concurrently with it, so services must serialize their own device access (e.g. with `core/events.ts` `Mutex`);
  - the hub no longer counts the call as running, so `hub.close()` does not wait for it.
- `core/envelope.ts` `exception()` prints the message twice, once as `name: message` and again as the first line of the JS stack. This is cosmetic and belongs to the core owner.

## 7. What the next wave must know

**Writing an API module** (`api/<family>.ts`):

```ts
import type { ApiModule } from '../index.ts';
import { succ, error } from '../core/envelope.ts';

export const phlApi: ApiModule = (registry, services) => {
  const log = services.log.child('phl');
  // Register every Bridge overload with the exact C# parameter types and order (Bridge.cs):
  registry.register('PHL_SetOSD', ['string'], ([name]) => …);
  registry.register('PHL_SetOSD', ['string', 'int'], async ([name, value]) => succ(await monitors.setOsd(String(name), Number(value))));
  registry.register('Profile_GetDeviceData', ['int'], ([dt]) => succ(profileOf(dt)));  // uiProfileGet applied automatically
};
```

- **Signatures must match `Bridge.cs` exactly.** The renderer's argument types decide the overload. Every renderer call site that passes a wrong type gets the vendor's `params error`, and so does the port.
- **Always return a `JsonResult`**, built with `core/envelope.ts` (`succ`, `error(msg, code)`, `result(code, msg, tag)`). The renderer treats `err_code !== 0 || err_msg` as failure, so success must carry `err_msg ""` (what `succ` does) or null.
- There is no client-side timeout, and replies are latest-wins per function name (02 §4.5). A handler must always settle. To report a failure, return `error(...)` or throw; the dispatcher turns a throw into `JsonResult.Exception`. The 120 s watchdog (§3.2) is only a last resort: it keeps a hung handler from freezing the UI, but the user still waits two minutes and gets a generic error. Bound device I/O inside the service, with its own shorter timeouts.
- **Requests from the renderer are processed one at a time** (vendor semantics). A long handler, for example a 20 s scan inside `Start`, delays every other request, including `Effect_GetLEDs` polling, just as on Windows. Keep long work off the request path if that hurts.
- **Auditing registrations:** `RpcDispatcher.registrations()` returns every overload as `{name, signature, serialize}` (copies, in registration order) without dispatching anything. `api/catalog.ts` `dispatcherRegistrations()` should read it instead of probing each name with 16 Boolean parms and parsing the `params error` text.
- **Tags must serialize in C# declaration order.** Use plain objects built in that order, or implement `[toCSharpJson](mode)` (`core/json.ts`) for entities with `[JsonIgnoreEx]` members.
- **Registering the same name and signature twice throws.** (Done by the integration wave: `API_MODULES` lists `api/system.ts` and the device modules instead of the placeholder; `impl-integration.md`.)
- **Notifications:** `services.notifier.notify('<Notification_Func name>', tag)` with the names and payloads in 02 §6. Use named keys for `NotifyUIDisplayEffectChange` (`{ENEEnable, EffectInfo, ModuleAmbiglow}`), not `Item1..3`. `PHL_GetConstraints` is followed by `NotifyUIDisplayFuncConstraintsChange` (seen in the real logs).

**Services** (`index.ts`):

- `ServiceSlots` is typed with the `services.ts` contracts: `themes?: ThemeStore`, `monitors?: MonitorManager`, `ambiglow?: AmbiglowService`. All three extend `BackendService` (`start?`/`stop?`). `index.ts` and `services.ts` import each other type-only, and both imports are erased. api/ modules therefore use `services.monitors?.scan('all')` directly, with no `Partial<…>` casts, and tsc catches contract drift. Test doubles that implement only part of a contract need an explicit `as unknown as MonitorManager` (see `lifecycleSlots()` in `test/unit/hub/backend.test.ts`). The integration wave builds the real services in `createBackend(opts, { services: (core) => ({…}) })`.
- The factory receives `CoreServices`: `log`, `notifier`, `host`, `events`, `options`. API modules receive the same plus the slots (`ApiServices`).
- `backend.start()` runs `themes → monitors → ambiglow` (vendor: `InitEnviroment` before the scan, 05 §2.5), and `stop()` runs them in reverse. A failing service is logged and the others still start, so the UI can connect and report errors per call.
- Transitions are serialized: a start phase never overlaps a stop phase. Calls that overlap are safe. A second `start()` or `stop()` while the same transition is pending returns the same promise, which resolves only when every service has finished that phase. A `start()` issued during `stop()` begins after the last service has stopped, and vice versa. `stop()` on a stopped backend and `start()` on a started one resolve immediately. The backend can be restarted.
- Hotplug: `backend.hotplug(kind)` emits `events` `'hotplug' {kind}`. Services subscribe to it in their factory, and API modules can too. Add more in-process events to `BackendEvents` as needed (the `EventSystem` replacement).

**Electron main:**

- Generate the token with `generateHubToken()` and expose it to the renderer as `window.__EVNIA__.hubToken` (patch `HUB-URL`).
- Return `hub.port` from `startupBackendService`.
- Load the renderer with `loadFile`, which gives Origin `file://` (probed, §4), and pass `allowedOrigins: ['file://']` to `startHubServer`. The default list also admits `null`, which any web page can produce (§4). (Integration wave: `startHubServer` now defaults to `APP_RENDERER_ORIGINS = ['file://']`, so `src/main/backend-host.ts` gets it without passing it; the raw `startSignalRServer` default is unchanged.) If a custom protocol is used instead, pass that origin.
- The network kill-switch must allow `ws://127.0.0.1:<port>/EvniaHub`.
