# Ambient Color Sync for Hubitat

With this app, colour lights on a [Hubitat Elevation](https://hubitat.com/) hub follow your screen. The colours can come from:

- **EPC4Linux**: the Ambiglow **Follow video** mode of this repository's Linux app. Tick *Send colours to Hubitat (LAN)* and the app pushes the screen colours to the hub over your local network.
- **Hyperion.ng**: the hub reads the LED colours of a Hyperion server. The receiver device asks for one snapshot per poll interval.
- **Any Hyperion JSON client**: POST the Hyperion JSON commands `color` and `clear` to the hub.

It has two parts:

| File | Install as | Role |
|---|---|---|
| [`apps/ambient-color-sync.groovy`](apps/ambient-color-sync.groovy) | *Apps Code* | You pick the lights here, give each one a part of the screen, and set brightness, pacing and what happens when the colours stop. |
| [`drivers/ambient-color-receiver.groovy`](drivers/ambient-color-receiver.groovy) | *Drivers Code* | The app creates one receiver device per app instance. The receiver takes the colours in and passes them to the app. Its switch pauses the lights. |

## Install

1. On the hub, open **Drivers Code → New Driver**, paste `drivers/ambient-color-receiver.groovy`, and click **Save**.
2. Open **Apps Code → New App**, paste `apps/ambient-color-sync.groovy`, and click **Save**.
3. Open **Apps → Add User App → Ambient Color Sync**, then:
   - **IP or MAC address of the EPC4Linux PC**: the computer that runs EPC4Linux. Reserve a fixed IP address for it in your router, or enter its MAC address.
   - **Lights**: colour bulbs or strips (capability *Color Control*). For each light, choose what it follows: the whole screen, or the left, right, top or bottom edge. For example, a lamp left of the monitor can follow the left edge.
   - Adjust the rest if you want (see [Settings](#settings)), then click **Done**.

   The app creates a device named *… Receiver*.

You can add more instances, for example one per PC or per room. Each instance gets its own receiver.

## EPC4Linux

On the Ambiglow page, select **Follow video**. Below the Speed slider and the *Fast LED upload* box:

1. Enter the **hub's IP address** in the address field, for example `192.168.1.20`. The app page also shows this address. Add `:port` only if you use something other than 39501.
2. Tick **Send colours to Hubitat (LAN)**.

The setting is saved in `~/.config/evnia/config.json` as `"linuxLanSync": {"enabled": true, "host": "192.168.1.20", "port": 39501}`.

Things to know:

- The row appears only when the USB Ambiglow controller is present and Follow video is selected. The colours are sent while Follow video runs, at the same moments the monitor's LEDs are updated.
- When Follow video stops, the PC tells the hub that the stream has ended. This happens when you choose another effect, switch Ambiglow off, idle lights-off kicks in, or the app quits. The hub then restores, turns off or leaves the lights, as set.
- The address must be a **private IPv4 address**: `10.x.x.x`, `172.16–31.x.x`, `192.168.x.x` or `169.254.x.x`. Host names are refused.
  - The app is otherwise "nothing online". It lets the Node side open TCP connections to exactly that one address, and only while the setting is on.
  - The renderer never connects anywhere itself.
- **Pacing.** The PC sends at most 5 updates per second, and only when a colour has changed noticeably. On a static screen it sends a heartbeat every 5 s. The app on the hub slows this down further for each light.
- If the hub does not answer, the PC retries every 2 s and writes one warning to the backend log.

## Hyperion

**Pull from a Hyperion.ng server.** Open the receiver device and set **Pull colours from a Hyperion.ng server**, the server's IP address and the JSON port (default 19444). Then click **Save Preferences**.

- The driver connects over TCP and reads the LED layout once (`serverinfo`). The layout gives the zones: LEDs in the outer 20 % of each side.
- After that it asks for one LED snapshot per poll interval (default 1000 ms) with `ledstream-start` and stops the stream after the first update. The stream itself would run at up to 100 updates per second, which is too much for a hub.
- If your server requires authorization from the LAN, enter an API token (Hyperion: *Network Services → Token Management*).
- The `hyperion` attribute shows the connection state. The driver reconnects by itself with a growing delay, up to 5 minutes.

**Push Hyperion JSON to the hub.** Any client can POST Hyperion's JSON-RPC to `http://<hub>:39501/`:

```sh
curl -X POST http://192.168.1.20:39501/ -d '{"command":"color","color":[255,80,0],"priority":50,"origin":"script"}'
curl -X POST http://192.168.1.20:39501/ -d '{"command":"clear","priority":50}'
```

The hub delivers such a request only to a device whose network id matches the sender. So enter the client's IP or MAC address as the app's *PC address*, or create a second app instance for it.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Follows (per light) | Whole screen | The whole screen or one edge. EPC4Linux averages a band of 20 % of the width or height. |
| Brightness | Follows the screen | The screen's brightness is scaled between *Level for a dark screen* (10 %) and *Level for a bright screen* (100 %). You can also set a fixed level instead. |
| Saturation boost | 25 % | Screen averages tend towards grey. The boost makes the lights more colourful. |
| Black screen below / On a black screen | 4 % / Dim | Below this brightness, the app dims the lights to the dark-screen level (white), turns them off, or keeps the last colour. |
| Minimum time between updates | 1000 ms | Zigbee and Z-Wave bulbs need 1000 ms or more. Fast LAN bulbs can take 200–500 ms. The newest colours always win; nothing is queued. |
| Minimum change | 3 points | A light gets a new command only when hue, saturation or level has moved by this much. Hue is ignored for near-white colours. |
| When the colours stop | Restore | *Restore* puts back each light's on/off state, colour or colour temperature, and level from before the stream. *Off* turns the lights off. *Leave* leaves them as they are. |
| Source counts as gone after | 15 s | For example when the PC sleeps or loses the network. |

The receiver's **switch** pauses the lights. You can use it from dashboards and rules. While it is off, the receiver still takes colours in (its `color` attribute follows, at most every 2 s), but the lights are released.

## The EPC4Linux message format

EPC4Linux sends HTTP `POST /` with `Content-Type: application/json` to the hub's port 39501:

```json
{"source":"EPC4Linux","version":1,"seq":17,"active":true,"color":[96,72,40],
 "zones":{"left":[180,40,20],"right":[20,40,200],"top":[90,90,90],"bottom":[30,30,30]}}
{"source":"EPC4Linux","version":1,"seq":18,"active":false}
```

- `color` is the average of the whole screen. `zones` holds the averages of the border bands. All values are 0–255 sRGB.
- `active: false` ends the stream.
- Other senders can use the same format. The receiver needs only `color`, and any missing zone falls back to `color`.

## Tests

[`test/run.sh`](test/run.sh) runs the app and the driver against stand-ins of the Hubitat API ([`test/HubStubs.groovy`](test/HubStubs.groovy)) through [`test/scenarios.groovy`](test/scenarios.groovy). The scenarios cover:
- the EPC4Linux and Hyperion messages, and the Hyperion pull with a split line;
- the network ids;
- zones, brightness, pacing, black screen, the watchdog, and restore, off and leave.

It needs a JDK and Groovy 2.4, the hub's Groovy version: `JAVA_HOME=… GROOVY_HOME=… hubitat/test/run.sh`. It checks the logic and that the code compiles. It is not a real hub: the hub's sandbox and real bulbs are not tested.

## Troubleshooting

- **Nothing happens.**
  - Open the receiver device. If `streaming` stays `inactive`, the hub has not received anything from the PC.
  - Check that the receiver's *Device Network Id* is the PC's IP address in hex: 192.168.1.42 → `C0A8012A`. The app sets it from the PC address. If the PC's IP address has changed, update it in the app.
  - Check the EPC4Linux backend log for `LAN colour sync`: `not reachable` means a wrong hub address, or a firewall in between.
- **"Another device may use that id already"** in the app log: some other device already has the PC's IP or MAC address as its network id. Hubitat delivers each LAN message to only one device.
- **The lights lag or skip.** This is expected for mesh bulbs. Raise *Minimum time between updates* rather than lowering it: a bulb that is sent too many commands falls further behind.
- **Lights flicker between similar colours.** Raise *Minimum change*.
- **Debug logging.** Both the app and the driver have a debug switch, which turns itself off after 30 minutes.
