/**
 *  Ambient Color Sync
 *
 *  Colour lights follow the screen: EPC4Linux's Follow Video colours (pushed over the LAN), Hyperion JSON "color"
 *  commands, or a Hyperion.ng server's LEDs. The app creates one child device, the "Ambient Color Receiver"
 *  (../drivers/ambient-color-receiver.groovy), which receives the colours; this app turns them into setColor commands
 *  for the selected lights:
 *    - each light follows the whole screen or one edge of it (left, right, top, bottom);
 *    - brightness follows the screen between a minimum and maximum level, or stays fixed;
 *    - commands are paced (a minimum interval and a minimum change), because Zigbee, Z-Wave and cloud bulbs take a few
 *      commands per second at best; the newest colours always win, nothing is queued;
 *    - when the colours stop (the sender says so, the receiver is switched off, or nothing arrives for a while) the
 *      lights are restored as they were, turned off, or left as they are.
 *
 *  Several instances can run side by side (e.g. one per PC or per room), each with its own receiver.
 *
 *  Licence: MIT (see the repository's LICENSE).
 */

import groovy.transform.Field
import java.util.concurrent.ConcurrentHashMap

definition(
    name: "Ambient Color Sync",
    namespace: "epc4linux",
    author: "EPC4Linux",
    description: "Lights follow the screen colours sent by EPC4Linux (Ambiglow Follow Video) or Hyperion.",
    category: "Convenience",
    iconUrl: "",
    iconX2Url: "",
    iconX3Url: "",
    singleInstance: false
)

preferences {
    page(name: "mainPage")
}

/** Per-app data that changes with every frame: kept in memory, not in state (no database write per frame). */
@Field static final Map<Long, Map> VOLATILE = new ConcurrentHashMap<>()

@Field static final Map ZONE_OPTIONS = [
    "all"   : "Whole screen",
    "left"  : "Left edge",
    "right" : "Right edge",
    "top"   : "Top edge",
    "bottom": "Bottom edge",
]

@Field static final String RECEIVER_NAMESPACE = "epc4linux"
@Field static final String RECEIVER_DRIVER = "Ambient Color Receiver"

// ───────────────────────────── settings page ─────────────────────────────

Map mainPage() {
    dynamicPage(name: "mainPage", title: "Ambient Color Sync", install: true, uninstall: true) {
        section("Source") {
            label title: "Name of this sync", required: false
            input "senderAddress", "text", title: "IP or MAC address of the EPC4Linux PC",
                description: "e.g. 192.168.1.42 — leave empty if you only use the Hyperion pull of the receiver device",
                required: false, submitOnChange: true
            paragraph sourceHelp()
        }
        section("Lights") {
            input "lights", "capability.colorControl", title: "Colour lights that follow the screen", multiple: true, required: true, submitOnChange: true
            lights?.each { d ->
                input "zone_${d.id}", "enum", title: "${d.displayName}: follows", options: ZONE_OPTIONS, defaultValue: "all", required: true
            }
        }
        section("Brightness and colour") {
            input "brightnessMode", "enum", title: "Brightness", options: ["follow": "Follows the screen", "fixed": "Fixed level"],
                defaultValue: "follow", required: true, submitOnChange: true
            if (brightnessMode == "fixed") {
                input "fixedLevel", "number", title: "Level (%)", range: "1..100", defaultValue: 80, required: true
            } else {
                input "minLevel", "number", title: "Level for a dark screen (%)", range: "1..100", defaultValue: 10, required: true
                input "maxLevel", "number", title: "Level for a bright screen (%)", range: "1..100", defaultValue: 100, required: true
            }
            input "saturationBoost", "number", title: "Saturation boost (%; 0 = the colours as on screen)", range: "0..200", defaultValue: 25
            input "darkThreshold", "number", title: "The screen counts as black below this brightness (%)", range: "0..100", defaultValue: 4
            input "darkAction", "enum", title: "On a black screen",
                options: ["dim": "Dim to the dark-screen level (white-ish)", "off": "Turn the lights off", "hold": "Keep the last colour"],
                defaultValue: "dim", required: true
        }
        section("Pacing") {
            input "minIntervalMs", "number", title: "Minimum time between updates of the lights (ms)", range: "100..10000", defaultValue: 1000,
                description: "Zigbee/Z-Wave bulbs: 1000 or more; fast LAN bulbs: 200-500"
            input "changeThreshold", "number", title: "Minimum change before a light is updated (hue, saturation or level points)", range: "0..50", defaultValue: 3
        }
        section("When the colours stop") {
            input "endAction", "enum", title: "Then", options: ["restore": "Restore the lights as they were", "off": "Turn the lights off", "leave": "Leave them as they are"],
                defaultValue: "restore", required: true
            input "inactiveTimeout", "number", title: "The source counts as gone after this many seconds without colours", range: "5..600", defaultValue: 15
        }
        section("Logging") {
            input "logEnable", "bool", title: "Debug logging (turns itself off after 30 minutes)", defaultValue: false
        }
    }
}

private String sourceHelp() {
    String hubIp = location?.hub?.localIP ?: "this hub's IP address"
    String dni = receiverDni()
    String routed = dni.startsWith("ambient-color-sync-") ?
        "No PC address set: only the receiver's Hyperion pull and senders whose address matches its network id reach it." :
        "LAN messages from that address reach the receiver (network id ${dni})."
    return "In EPC4Linux: Ambiglow → Follow Video → tick <b>Send colours to Hubitat / Home Assistant (LAN)</b> and enter <b>${hubIp}</b>. " +
        "The colours arrive on the hub's port 39501. ${routed} Give the PC a fixed (reserved) IP address in your router, " +
        "or enter its MAC address instead. Hyperion: open the receiver device and set the Hyperion server there, or let a " +
        "Hyperion client POST JSON \"color\" commands to http://${hubIp}:39501/."
}

// ───────────────────────────── lifecycle ─────────────────────────────

void installed() {
    initialize()
}

void updated() {
    unschedule()
    if (state.active) endSession("settings changed")
    initialize()
}

void uninstalled() {
    if (state.active && endAction == "restore") restoreLights()
    getChildDevices()?.collect { it.deviceNetworkId }?.each { deleteChildDevice(it) }
    VOLATILE.remove(app.id as Long)
}

void initialize() {
    vol().clear()
    state.active = false
    state.remove("snapshot")
    ensureReceiver()
    if (logEnable) runIn(1800, "logsOff")
    if (!app.label) app.updateLabel("Ambient Color Sync")
}

void logsOff() {
    app.updateSetting("logEnable", [value: "false", type: "bool"])
    log.info "${app.label}: debug logging off"
}

/** The receiver's Device Network Id: the sender's IP in hex (C0A8012A) or MAC (AABBCCDDEEFF), else an own id. */
private String receiverDni() {
    String a = senderAddress?.trim() ?: ""
    if (a ==~ /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/ && a.tokenize(".").every { (it as int) <= 255 }) {
        return a.tokenize(".").collect { String.format("%02X", it as int) }.join()
    }
    String mac = a.replaceAll(/[^0-9A-Fa-f]/, "")
    if (mac.length() == 12 && a ==~ /^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$/) return mac.toUpperCase()
    if (a) log.warn "${app.label}: '${a}' is neither an IPv4 nor a MAC address; LAN messages from the PC will not reach the receiver"
    return "ambient-color-sync-${app.id}"
}

/** Create the receiver, or move it to the network id of the current sender address. */
private void ensureReceiver() {
    String dni = receiverDni()
    def child = getChildDevices()?.find { true }
    try {
        if (child == null) {
            child = addChildDevice(RECEIVER_NAMESPACE, RECEIVER_DRIVER, dni,
                [name: RECEIVER_DRIVER, label: "${app.label ?: 'Ambient Color Sync'} Receiver", isComponent: false])
            log.info "${app.label}: created ${child.displayName} (network id ${dni})"
        } else if (child.deviceNetworkId != dni) {
            child.setDeviceNetworkId(dni)
            log.info "${app.label}: ${child.displayName} now receives from network id ${dni}"
        }
    } catch (e) {
        if (e.class.simpleName == "UnknownDeviceTypeException") log.error "${app.label}: install the '${RECEIVER_DRIVER}' driver (Drivers Code) first"
        else log.error "${app.label}: could not set up the receiver with network id ${dni} (${e.message}); another device may use that id already"
    }
}

// ───────────────────────────── from the receiver ─────────────────────────────

/** Colours of one frame: [all: [r,g,b], left: …, right: …, top: …, bottom: …] (zones may be missing). */
void receiveColors(Map zones) {
    if (!lights) return
    Map v = vol()
    v.zones = zones
    v.lastSeen = now()
    if (!state.active) startSession()
    long wait = ((v.lastFlush ?: 0L) as long) + minInterval() - now()
    if (wait <= 0) {
        flush()
    } else if (!v.flushPending) {
        v.flushPending = true
        runInMillis(wait, "flush")
    }
}

/** The sender ended its stream (EPC4Linux "active": false, Hyperion clear). */
void sourceEnded(String source) {
    endSession("${source} stopped")
}

/** The receiver's switch was turned off. */
void receiverPaused() {
    endSession("receiver switched off")
}

// ───────────────────────────── session ─────────────────────────────

private void startSession() {
    state.active = true
    Map v = vol()
    v.sent = new ConcurrentHashMap()
    if (endAction == "restore" || endAction == null) {
        state.snapshot = lights.collectEntries { d ->
            [(d.id.toString()): [
                switch    : d.currentValue("switch"),
                colorMode : d.currentValue("colorMode"),
                hue       : d.currentValue("hue"),
                saturation: d.currentValue("saturation"),
                level     : d.currentValue("level"),
                ct        : d.currentValue("colorTemperature"),
            ]]
        }
    }
    log.info "${app.label}: colours arriving, ${lights.size()} light(s) follow"
    runIn(5, "watchdog")
}

/** Ends the session after inactiveTimeout seconds without colours (a PC that slept or lost the network). */
void watchdog() {
    if (!state.active) return
    long silent = now() - ((vol().lastSeen ?: 0L) as long)
    if (silent > timeoutMs()) {
        getChildDevices()?.each { it.markInactive() }
        endSession("no colours for ${silent.intdiv(1000)} s")
    } else {
        runIn(5, "watchdog")
    }
}

private void endSession(String reason) {
    if (!state.active) return
    state.active = false
    unschedule("flush")
    unschedule("watchdog")
    Map v = vol()
    v.remove("zones")
    v.flushPending = false
    log.info "${app.label}: ${reason}; lights ${endAction == 'off' ? 'off' : endAction == 'leave' ? 'left as they are' : 'restored'}"
    switch (endAction ?: "restore") {
        case "off":
            lights?.each { it.off() }
            break
        case "restore":
            restoreLights()
            break
    }
    state.remove("snapshot")
}

private void restoreLights() {
    Map snap = state.snapshot ?: [:]
    lights?.each { d ->
        Map s = snap[d.id.toString()]
        if (s == null) return
        try {
            if (s.switch == "off") {
                d.off()
            } else if (s.colorMode == "CT" && s.ct) {
                restoreColorTemperature(d, s.ct as int, s.level != null ? s.level as int : null)
            } else if (s.hue != null && s.saturation != null) {
                d.setColor([hue: s.hue as int, saturation: s.saturation as int, level: (s.level ?: 100) as int])
            } else if (s.level != null) {
                d.setLevel(s.level as int)
            }
        } catch (e) {
            log.warn "${app.label}: could not restore ${d.displayName}: ${e.message}"
        }
    }
}

private void restoreColorTemperature(d, int ct, Integer level) {
    if (level == null) {
        d.setColorTemperature(ct)
        return
    }
    try {
        d.setColorTemperature(ct, level)
    } catch (MissingMethodException ignored) {
        d.setColorTemperature(ct)
        d.setLevel(level)
    }
}

// ───────────────────────────── driving the lights ─────────────────────────────

/** The newest colours to every light that changed enough since its last command. */
void flush() {
    Map v = vol()
    v.flushPending = false
    v.lastFlush = now()
    Map zones = (Map) v.zones
    if (!state.active || zones == null) return
    Map sent = (Map) (v.sent ?: (v.sent = new ConcurrentHashMap()))
    lights?.each { d ->
        String zone = settings["zone_${d.id}"] ?: "all"
        List c = (List) (zones[zone] ?: zones.all)
        if (c == null) return
        Map target = targetFor(c)
        if (target == null) return
        Map last = (Map) sent[d.id]
        if (target.off) {
            if (last?.off != true) {
                d.off()
                sent[d.id] = [off: true]
                logDebug "${d.displayName}: off (black screen)"
            }
            return
        }
        if (last != null && !last.off && !changed(last, target)) return
        d.setColor([hue: target.hue, saturation: target.saturation, level: target.level])
        sent[d.id] = target
        logDebug "${d.displayName}: ${zone} rgb${c} → hue ${target.hue} sat ${target.saturation} level ${target.level}"
    }
}

/** [hue, saturation, level] (Hubitat 0..100 scales) for a screen colour, [off: true], or null (keep the last colour). */
private Map targetFor(List c) {
    List hsv = rgbToHsv(c[0] as int, c[1] as int, c[2] as int)
    double h = hsv[0], s = hsv[1], val = hsv[2]
    boolean fixed = brightnessMode == "fixed"
    int lo = intSetting(minLevel, 10, 1, 100)
    int hi = Math.max(lo, intSetting(maxLevel, 100, 1, 100))
    if (val < intSetting(darkThreshold, 4, 0, 100)) {
        switch (darkAction ?: "dim") {
            case "off": return [off: true]
            case "hold": return null
            default: return [hue: Math.round(h) as int, saturation: 0, level: fixed ? intSetting(fixedLevel, 80, 1, 100) : lo]
        }
    }
    s = Math.min(100d, s * (1 + intSetting(saturationBoost, 25, 0, 200) / 100d))
    int level = fixed ? intSetting(fixedLevel, 80, 1, 100) : (int) Math.round(lo + (hi - lo) * val / 100d)
    return [hue: Math.round(h) as int, saturation: Math.round(s) as int, level: level]
}

private boolean changed(Map a, Map b) {
    int t = intSetting(changeThreshold, 3, 0, 50)
    if (t == 0) return a.hue != b.hue || a.saturation != b.saturation || a.level != b.level
    int dh = Math.abs((a.hue as int) - (b.hue as int))
    dh = Math.min(dh, 100 - dh) // hue wraps around
    // Hue hardly matters for nearly white colours.
    boolean hueCounts = Math.max(a.saturation as int, b.saturation as int) >= 10
    return (hueCounts && dh >= t) || Math.abs((a.saturation as int) - (b.saturation as int)) >= t || Math.abs((a.level as int) - (b.level as int)) >= t
}

/** RGB 0..255 → [hue, saturation, value] on Hubitat's 0..100 scales. */
private List rgbToHsv(int r, int g, int b) {
    double rf = r / 255d, gf = g / 255d, bf = b / 255d
    double max = Math.max(rf, Math.max(gf, bf))
    double min = Math.min(rf, Math.min(gf, bf))
    double d = max - min
    double h = 0
    if (d > 0) {
        if (max == rf) h = ((gf - bf) / d) % 6
        else if (max == gf) h = (bf - rf) / d + 2
        else h = (rf - gf) / d + 4
        h *= 60
        if (h < 0) h += 360
    }
    double s = max == 0 ? 0 : d / max
    return [h / 3.6d, s * 100d, max * 100d]
}

// ───────────────────────────── helpers ─────────────────────────────

/** This app's in-memory map. A ConcurrentHashMap: never store null in it (remove the key instead). */
private Map vol() {
    Long id = app.id as Long
    Map m = VOLATILE.get(id)
    if (m == null) {
        VOLATILE.putIfAbsent(id, new ConcurrentHashMap())
        m = VOLATILE.get(id)
    }
    return m
}

private long minInterval() {
    return intSetting(minIntervalMs, 1000, 100, 10000) as long
}

private long timeoutMs() {
    return intSetting(inactiveTimeout, 15, 5, 600) * 1000L
}

private int intSetting(Object value, int fallback, int lo, int hi) {
    if (value == null) return fallback
    int v
    try {
        v = value as int
    } catch (ignored) {
        return fallback
    }
    return Math.max(lo, Math.min(hi, v))
}

private void logDebug(String msg) {
    if (logEnable) log.debug "${app.label}: ${msg}"
}
