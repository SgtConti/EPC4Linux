# Ambient Color Sync for Home Assistant

A custom integration for [Home Assistant](https://www.home-assistant.io/). With it, lights follow your screen. The colours can come from:

- **EPC4Linux**: the Ambiglow **Follow video** mode of this repository's Linux app. It pushes the screen colours to the integration's webhook over your local network.
- **Hyperion.ng**: the integration polls a Hyperion server's LED colours. It asks for one snapshot per poll interval.
- **Any Hyperion JSON client**: POST the Hyperion JSON commands `color` and `clear` to the webhook.

For each light you choose the part of the screen it follows. The integration also handles brightness and pacing, and what happens when the colours stop: it can put every light back exactly as it was.

## Install

1. Copy `custom_components/ambient_color_sync` into your Home Assistant configuration directory, so that you have `config/custom_components/ambient_color_sync/manifest.json`. Then restart Home Assistant.
2. Go to **Settings → Devices & services → Add integration → Ambient Color Sync**.
   - Give it a name and pick the lights. Any `light` entity works; colour lights follow the colours, and others only follow the brightness.
   - For each light, choose what it follows: the whole screen, or the left, right, top or bottom edge.
3. The last dialog shows the **webhook URL**, for example `http://192.168.1.20:8123/api/webhook/3f9a…`. You need it for EPC4Linux. You can see it again at any time under **Configure** on the integration.

Add the integration more than once for several PCs or rooms. Each entry gets its own webhook and its own device.

> HACS cannot install from a sub-folder of this repository, so copy the folder by hand.

## EPC4Linux

On the Ambiglow page, select **Follow video**. Then:

1. Paste the webhook URL into the address field below *Fast LED upload*.
2. Tick **Send colours to Hubitat / Home Assistant (LAN)**.

The setting is saved in `~/.config/evnia/config.json` as `"linuxLanSync"` (enabled, host, port, path).

Things to know:

- **The URL needs an IP address.** EPC4Linux never looks up host names, so `homeassistant.local` does not work. Give Home Assistant a fixed (reserved) IP address in your router.
  - The integration builds the URL from Home Assistant's own LAN address and port.
- **Plain `http://` only.** If your Home Assistant serves `https` directly, with a certificate configured in `http:`, EPC4Linux cannot reach it.
- **What is sent.** EPC4Linux sends the average colour of the whole screen and of its four edges.
  - It sends up to 20 times per second, and only when the colours change noticeably. In practice the Follow video **Speed** slider sets the rate: about 10 per second on Normal, up to 20 on High.
  - It keeps one connection open, so there is no handshake per update.
  - On a static screen it sends a heartbeat every 5 s.
  - When Follow video stops (another effect, idle lights-off, quitting), it tells the integration that the stream ended.
- **Local network only.** The webhook accepts POSTs from your local network only. Home Assistant refuses it from the internet, and from Nabu Casa cloud.
- **Treat the URL like a password.** Anyone on your network who knows it can set your lights. EPC4Linux keeps the webhook id out of its logs.

## Entities

Each entry gets one device with these entities:

| Entity | Meaning |
|---|---|
| `switch.<name>_follow_screen` | Off pauses the lights. A running session ends, and the end action applies. On lets the next colours drive the lights again. The state is kept across restarts. |
| `binary_sensor.<name>_streaming` | On while colours arrive and the lights follow. Attribute `source`: EPC4Linux, Hyperion, or the client's `origin`. |
| `sensor.<name>_screen_colour` | **Disabled by default** (see [History and the activity log](#history-and-the-activity-log)). The whole-screen colour as `#RRGGBB`, updated at most every 2 s by default (*Screen colour sensor update interval*; this does not limit the lights). Attribute `rgb_color`, which is not recorded. |
| `sensor.<name>_hyperion_connection` | Shown only with the Hyperion pull on: off, connecting, connected, or the last error. |

You can use these in automations. For example, turn `follow_screen` off when a movie scene starts, or react to `streaming`.

## Options

Open **Configure** on the integration. It has three pages:

**Lights and screen areas**: which lights follow, and which part of the screen each one follows.

**Brightness, pacing and end of stream**

| Option | Default | Meaning |
|---|---|---|
| Switching lights on and off | The sync switches them | *The sync switches lights on and off*: a colour turns a light on, and a black screen (with *Turn the lights off*) or the end of the stream can turn it off. *Respect on/off set elsewhere*: only lights that are on follow the screen. A light switched off by an automation, a rule or by hand stays off, and follows again as soon as it is switched on. The sync then never switches a light on, a black screen dims instead of switching off, and *Restore* only touches lights that were on before and are still on. The *Turn the lights off* end action still turns them off. |
| Brightness | Follows the screen | The screen's brightness is scaled between *dark-screen* (10 %) and *bright-screen* (100 %) brightness. You can also choose a fixed brightness. |
| Saturation boost | 25 % | Screen averages tend towards grey. The boost makes the lights more colourful. |
| Black screen below / On a black screen | 4 % / Dim | Below this brightness, the lights dim to the dark-screen brightness (white), turn off, or keep the last colour. |
| Minimum time between updates | 500 ms | Down to 50 ms. Zigbee and Z-Wave bulbs need 1000 ms or more; Wi-Fi and LAN bulbs can take 100–500 ms; WLED and other fast lights can take 50 ms. Each light has at most one command in flight. A light that is still busy gets only the newest colour when it is ready, so a slow light cannot hold back a fast one, and commands never pile up. |
| Minimum change | 3 | A light gets a new command only when hue, saturation or brightness has moved by this many points. Hue is ignored for near-white colours. |
| Transition | 0.4 s | Fade time sent with each update. Lights without transition support ignore it. |
| When the colours stop | Restore | *Restore* puts every light back as it was before the stream: on/off, colour or colour temperature, and brightness (Home Assistant's reproduce-state). *Off* turns the lights off. *Leave* leaves them as they are. |
| Source counts as gone after | 15 s | For example when the PC sleeps or loses the network. |
| Screen colour sensor update interval | 2 s | Only the sensor. The recorder stores every state change, so short intervals grow the database. |

**Hyperion server**

- Turn on *Pull colours from Hyperion* and enter the server's address and JSON port (default 19444). If the server requires authorization from the LAN, also enter an API token (Hyperion: *Network Services → Token Management*).
- The integration reads the LED layout once (`serverinfo`). The zones are the LEDs in the outer 20 % of each side.
- After that it asks for one LED snapshot per poll interval with `ledstream-start` and stops the stream after the first update. The stream itself would run at up to 100 updates per second.
- It reconnects by itself, with a growing delay up to 5 minutes.
- This is separate from Home Assistant's built-in Hyperion integration, which *controls* Hyperion rather than reading from it.

## History and the activity log

**The activity log (logbook) stays quiet.** It records on/off changes only, never a new colour or brightness.

Two things can add entries:
- *Streaming* turning on and off at the start and end of each session.
- A light switched off and on again and again. That happens with *The sync switches lights on and off* combined with *On a black screen: Turn the lights off*, during films that cut to black. Use *Dim* (the default) or *Respect on/off set elsewhere* to avoid it.

**The history database (recorder) is the real load.** Home Assistant stores a row for every attribute change of a light, so every colour update of a following light.
- At an average of 5 updates per second, that is about 18,000 rows per light per hour of streaming.
- The integration cannot opt the lights out of recording: they are other integrations' entities. Only you can, in `configuration.yaml`:

```yaml
recorder:
  exclude:
    entities:
      - light.tv_backlight
      - light.left_lamp
```

- Excluded lights get no history graph and no logbook entries at all, also outside of streaming. Do this for lights that mainly follow the screen (strips, WLED, a TV backlight). Leave out the room's main lights, whose history you want.
- Raising *Minimum change* and *Minimum time between updates* also cuts the rows. A light that does not visibly change gets no update and no row.

**The integration's own entities.**
- The *Screen colour* sensor is **disabled by default**, because it changes every few seconds while streaming. Enable it under *Settings → Entities* if you want it, ideally with a longer *Screen colour sensor update interval*. Its `rgb_color` attribute is never recorded.
- If you installed an earlier version, the sensor stays enabled until you disable it.
- *Streaming* and *Follow screen* change only at the start and end of a session.

## Hyperion JSON over the webhook

```sh
curl -X POST http://192.168.1.20:8123/api/webhook/<id> -H 'Content-Type: application/json' \
     -d '{"command":"color","color":[255,80,0],"priority":50,"origin":"script"}'
curl -X POST http://192.168.1.20:8123/api/webhook/<id> -H 'Content-Type: application/json' -d '{"command":"clear","priority":50}'
```

## The EPC4Linux message format

```json
{"source":"EPC4Linux","version":1,"seq":17,"active":true,"color":[96,72,40],
 "zones":{"left":[180,40,20],"right":[20,40,200],"top":[90,90,90],"bottom":[30,30,30]}}
{"source":"EPC4Linux","version":1,"seq":18,"active":false}
```

- `color` is the average of the whole screen, and `zones` holds the averages of the border bands, all 0–255 sRGB.
- `active: false` ends the stream.
- Missing zones fall back to `color`, so other senders can send `color` alone.

## Tests

The tests run against a real Home Assistant core, with [pytest-homeassistant-custom-component](https://github.com/MatthewFlamm/pytest-homeassistant-custom-component):

```sh
cd home-assistant
python3 -m venv .venv && .venv/bin/pip install pytest-homeassistant-custom-component
.venv/bin/pytest
```

Last run: 13 tests on Home Assistant 2026.2.3. They cover:
- the colour logic;
- the config and options flow, including the webhook URL;
- webhook → `light.turn_on` with zones, pacing and only changed lights;
- the end of the stream with restore or off;
- "respect" mode (only lights that are on follow, and a light switched on elsewhere follows at once);
- one command in flight per light, so a slow light gets only the newest colour;
- Hyperion JSON, the black screen, the switch, the watchdog and a bad body;
- the Hyperion pull against a fake server.

## Troubleshooting

- **Nothing happens.** Check `binary_sensor.<name>_streaming`.
  - If it stays off, look for `LAN colour sync` in the EPC4Linux backend log. `not reachable` means a wrong IP or port, or a firewall in between.
  - Make sure the URL is the one shown under **Configure**.
- **"is not a private network address"** in EPC4Linux: the URL must use Home Assistant's LAN IP, not a public address or host name.
- **Lights lag or flicker.** Raise *Minimum time between updates* or *Minimum change*. Lights that get too many commands fall further behind.
- **Logs.** Add `custom_components.ambient_color_sync: debug` under `logger:` in `configuration.yaml`.
