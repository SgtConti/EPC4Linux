/**
 *  Ambient Color Receiver
 *
 *  The child device of the "Ambient Color Sync" app (../apps/ambient-color-sync.groovy). It receives screen colours and
 *  hands them to the app, which drives the lights. Three sources, usable together:
 *
 *  1. EPC4Linux push (Follow Video, "Send colours to Hubitat"): HTTP POSTs to the hub's LAN port 39501. Hubitat delivers
 *     such a request to the device whose Device Network Id is the sender's IP address in hex (e.g. C0A8012A for
 *     192.168.1.42) or its MAC address; the app sets that DNI from its "EPC4Linux PC address" setting. Body:
 *       {"source":"EPC4Linux","version":1,"seq":17,"active":true,"color":[r,g,b],
 *        "zones":{"left":[r,g,b],"right":[r,g,b],"top":[r,g,b],"bottom":[r,g,b]}}
 *       {"source":"EPC4Linux","version":1,"seq":18,"active":false}
 *  2. Hyperion JSON pushed to the same port by any client: {"command":"color","color":[r,g,b],...} sets the colour,
 *     {"command":"clear"} / {"command":"clearall"} ends the stream. Other commands are ignored.
 *  3. Hyperion.ng pull: with "Pull colours from a Hyperion server" on, the driver connects to the server's JSON port
 *     (19444) and asks for one LED snapshot per poll interval (ledstream-start, first update, ledstream-stop: the stream
 *     itself runs at up to 100 Hz, far too much for a hub). The server's LED layout (serverinfo) gives the zones.
 *
 *  The switch pauses the lights: off = colours are still received (the "color" attribute follows) but not passed on, and
 *  the app ends the session (restores, turns off or leaves the lights as configured).
 *
 *  Licence: MIT (see the repository's LICENSE).
 */

import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import groovy.transform.Field
import java.util.concurrent.ConcurrentHashMap

/** Per-device data that changes with every message: kept in memory, not in state (no database write per frame). */
@Field static final Map<Long, Map> VOLATILE = new ConcurrentHashMap<>()

@Field static final List<String> ZONES = ["left", "right", "top", "bottom"]
/** The "color" attribute changes at most this often (an event per frame would flood the event history). */
@Field static final long COLOR_EVENT_MS = 2000L
/** A Hyperion snapshot that did not arrive within this time is given up (the next poll asks again). */
@Field static final long HYPERION_REPLY_MS = 5000L
/** A partial Hyperion line longer than this is dropped. */
@Field static final int HYPERION_BUFFER_MAX = 65536

metadata {
    definition(name: "Ambient Color Receiver", namespace: "epc4linux", author: "EPC4Linux") {
        capability "Actuator"
        capability "Switch"
        capability "Initialize"

        attribute "color", "string"        // "#RRGGBB" of the whole screen, at most every 2 s
        attribute "streaming", "enum", ["active", "inactive"]
        attribute "source", "string"       // who sent the current stream (EPC4Linux, Hyperion, ...)
        attribute "hyperion", "string"     // the Hyperion pull connection: off, connecting, connected, error ...

        command "connectHyperion"
        command "disconnectHyperion"
    }
    preferences {
        input name: "hyperionEnabled", type: "bool", title: "Pull colours from a Hyperion.ng server", defaultValue: false
        input name: "hyperionHost", type: "text", title: "Hyperion server IP address"
        input name: "hyperionPort", type: "number", title: "Hyperion JSON port", defaultValue: 19444
        input name: "hyperionToken", type: "password", title: "Hyperion API token (only if the server requires authorization)"
        input name: "hyperionPollMs", type: "number", title: "Hyperion poll interval in ms (250-10000)", defaultValue: 1000, range: "250..10000"
        input name: "logEnable", type: "bool", title: "Debug logging (turns itself off after 30 minutes)", defaultValue: false
    }
}

// ───────────────────────────── lifecycle ─────────────────────────────

void installed() {
    sendEvent(name: "switch", value: "on")
    sendEvent(name: "streaming", value: "inactive")
    sendEvent(name: "hyperion", value: "off")
}

void updated() {
    if (logEnable) runIn(1800, "logsOff")
    if (hyperionEnabled) connectHyperion()
    else disconnectHyperion()
}

/** Hub start-up: the Hyperion connection does not survive a reboot. */
void initialize() {
    vol().clear()
    if (hyperionEnabled) connectHyperion()
}

void uninstalled() {
    disconnectHyperion()
    VOLATILE.remove(device.idAsLong)
}

void logsOff() {
    device.updateSetting("logEnable", [value: "false", type: "bool"])
    log.info "${device.displayName}: debug logging off"
}

// ───────────────────────────── switch (pause) ─────────────────────────────

void on() {
    sendEvent(name: "switch", value: "on", descriptionText: "${device.displayName}: lights follow the screen")
}

void off() {
    sendEvent(name: "switch", value: "off", descriptionText: "${device.displayName}: lights paused")
    parent?.receiverPaused()
}

// ───────────────────────────── incoming messages ─────────────────────────────

/**
 * LAN messages to port 39501 (a parseLanMessage description) and lines of the Hyperion socket (raw JSON text).
 */
void parse(String description) {
    if (description == null) return
    String text = description.trim()
    // LAN messages come as "index:.., mac:.., ip:.., headers:.., body:.."; everything else is the Hyperion socket.
    if (!text.startsWith("index:") && !text.startsWith("mac:")) {
        hyperionLine(text)
        return
    }
    Map msg
    try {
        msg = parseLanMessage(description)
    } catch (e) {
        logDebug "unreadable LAN message: ${e.message}"
        return
    }
    String body = msg?.body
    if (!body) {
        logDebug "LAN message without a body ignored"
        return
    }
    Object json
    try {
        json = new JsonSlurper().parseText(body)
    } catch (e) {
        log.warn "${device.displayName}: a LAN message that is not JSON was ignored (${body.take(80)})"
        return
    }
    if (json instanceof Map) handlePush((Map) json)
    else logDebug "LAN JSON that is not an object ignored"
}

/** An EPC4Linux document, or a Hyperion JSON command pushed to the hub. */
private void handlePush(Map json) {
    if (json.command != null) {
        handleHyperionCommand(json)
        return
    }
    String source = json.source ? json.source.toString().take(40) : "LAN"
    if (json.active == false) {
        streamEnded(source)
        return
    }
    List all = rgb(json.color)
    if (all == null) {
        logDebug "LAN document without a colour ignored: ${JsonOutput.toJson(json).take(120)}"
        return
    }
    Map zones = [all: all]
    if (json.zones instanceof Map) {
        ZONES.each { String z ->
            List c = rgb(json.zones[z])
            if (c != null) zones[z] = c
        }
    }
    deliver(zones, source)
}

/** Hyperion's JSON API commands that make sense for lights: a static colour and its removal. */
private void handleHyperionCommand(Map json) {
    switch (json.command) {
        case "color":
            List c = rgb(json.color)
            if (c != null) deliver([all: c], json.origin ? json.origin.toString().take(40) : "Hyperion JSON")
            break
        case "clear":
        case "clearall":
            streamEnded("Hyperion JSON")
            break
        default:
            logDebug "Hyperion command '${json.command}' ignored"
    }
}

/** Colours of one frame to the app (unless paused); the attributes follow, sparingly. */
private void deliver(Map zones, String source) {
    Map v = vol()
    long t = now()
    if (!v.streaming) {
        v.streaming = true
        sendEvent(name: "streaming", value: "active")
        sendEvent(name: "source", value: source)
        log.info "${device.displayName}: colours from ${source}"
    }
    if (t - ((v.colorAt ?: 0L) as long) >= COLOR_EVENT_MS) {
        v.colorAt = t
        sendEvent(name: "color", value: hex((List) zones.all))
    }
    if (device.currentValue("switch") == "off") return
    parent?.receiveColors(zones)
}

/** The sender said the stream ended. */
private void streamEnded(String source) {
    Map v = vol()
    boolean was = v.streaming == true
    v.streaming = false
    if (was) {
        sendEvent(name: "streaming", value: "inactive")
        log.info "${device.displayName}: ${source} stopped sending colours"
    }
    parent?.sourceEnded(source)
}

/** The app timed the stream out (no colours for a while): only the attribute changes. */
void markInactive() {
    Map v = vol()
    if (v.streaming) {
        v.streaming = false
        sendEvent(name: "streaming", value: "inactive")
    }
}

// ───────────────────────────── Hyperion.ng pull ─────────────────────────────

void connectHyperion() {
    unschedule("hyperionPoll")
    unschedule("connectHyperion")
    String host = hyperionHost?.trim()
    if (!host) {
        log.warn "${device.displayName}: no Hyperion server address set"
        sendEvent(name: "hyperion", value: "error: no address")
        return
    }
    try {
        interfaces.rawSocket.close()
    } catch (ignored) {
    }
    Map v = vol()
    v.hyBuf = ""
    v.hyAwait = false
    v.hyMisses = 0
    v.remove("hyLayout")
    sendEvent(name: "hyperion", value: "connecting")
    int port = (hyperionPort ?: 19444) as int
    try {
        interfaces.rawSocket.connect([eol: "\n", byteInterface: false], host, port)
    } catch (e) {
        hyperionFailed("connect to ${host}:${port} failed: ${e.message}")
        return
    }
    if (hyperionToken) hyperionSend([command: "authorize", subcommand: "login", token: hyperionToken, tan: 1])
    hyperionSend([command: "serverinfo", tan: 2])
    state.hyperionRetries = 0
    sendEvent(name: "hyperion", value: "connected")
    log.info "${device.displayName}: connected to Hyperion at ${host}:${port}"
    runInMillis(pollMs(), "hyperionPoll")
}

void disconnectHyperion() {
    unschedule("hyperionPoll")
    unschedule("connectHyperion")
    try {
        interfaces.rawSocket.close()
    } catch (ignored) {
    }
    Map v = vol()
    v.hyAwait = false
    v.hyBuf = ""
    if (device.currentValue("hyperion") != "off") sendEvent(name: "hyperion", value: "off")
}

/** One LED snapshot per interval: ask for the stream; the first update stops it again (hyperionLine). */
void hyperionPoll() {
    if (!hyperionEnabled) return
    Map v = vol()
    if (v.hyAwait && now() - ((v.hyAwaitAt ?: 0L) as long) < HYPERION_REPLY_MS) {
        runInMillis(pollMs(), "hyperionPoll")
        return
    }
    if (v.hyAwait) {
        v.hyMisses = ((v.hyMisses ?: 0) as int) + 1
        if (v.hyMisses >= 3) {
            hyperionFailed("no LED data for ${3 * HYPERION_REPLY_MS / 1000} s")
            return
        }
    }
    v.hyAwait = true
    v.hyAwaitAt = now()
    hyperionSend([command: "ledcolors", subcommand: "ledstream-start", tan: 3])
    runInMillis(pollMs(), "hyperionPoll")
}

/** rawSocket status changes (errors, the server closing the connection). */
void socketStatus(String status) {
    logDebug "Hyperion socket: ${status}"
    if (!hyperionEnabled) return
    if (status?.toLowerCase()?.contains("error") || status?.toLowerCase()?.contains("closed")) hyperionFailed(status)
}

private void hyperionFailed(String why) {
    unschedule("hyperionPoll")
    try {
        interfaces.rawSocket.close()
    } catch (ignored) {
    }
    int retries = ((state.hyperionRetries ?: 0) as int) + 1
    state.hyperionRetries = retries
    int delay = Math.min(300, 5 * (1 << Math.min(retries - 1, 6)))
    log.warn "${device.displayName}: Hyperion ${why}; reconnecting in ${delay} s"
    sendEvent(name: "hyperion", value: "error: ${why}".take(120))
    vol().hyAwait = false
    if (hyperionEnabled) runIn(delay, "connectHyperion")
}

private void hyperionSend(Map m) {
    try {
        interfaces.rawSocket.sendMessage(JsonOutput.toJson(m) + "\n")
    } catch (e) {
        hyperionFailed("send failed: ${e.message}")
    }
}

/** One line from the Hyperion server (lines may arrive split: the parts are joined until they parse). */
private void hyperionLine(String text) {
    Map v = vol()
    String line = (v.hyBuf ?: "") + text
    Object json
    try {
        json = new JsonSlurper().parseText(line)
        v.hyBuf = ""
    } catch (e) {
        v.hyBuf = line.length() > HYPERION_BUFFER_MAX ? "" : line
        return
    }
    if (!(json instanceof Map)) return
    Map m = (Map) json
    String cmd = m.command?.toString()
    if (cmd == "ledcolors-ledstream-update") {
        if (!v.hyAwait) return
        v.hyAwait = false
        v.hyMisses = 0
        hyperionSend([command: "ledcolors", subcommand: "ledstream-stop", tan: 4])
        Object leds = (m.data instanceof Map ? m.data.leds : null) ?: (m.result instanceof Map ? m.result.leds : null)
        Map zones = hyperionZones(leds, (Map) v.hyLayout)
        if (zones != null) deliver(zones, "Hyperion")
    } else if (cmd == "serverinfo" && m.success && m.info instanceof Map) {
        Map layout = hyperionLayout(m.info.leds)
        if (layout != null) v.hyLayout = layout
        else v.remove("hyLayout")
        logDebug "Hyperion layout: ${v.hyLayout?.collectEntries { k, idx -> [(k): idx.size()] }}"
    } else if (m.success == false) {
        String err = m.error?.toString() ?: "request failed"
        log.warn "${device.displayName}: Hyperion ${cmd ?: ''}: ${err}"
        if (cmd?.startsWith("authorize")) sendEvent(name: "hyperion", value: "error: authorization failed")
    }
}

/** The LED indices of each zone from serverinfo's LED layout ({hmin,hmax,vmin,vmax} per LED, 0..1). */
private Map hyperionLayout(Object leds) {
    if (!(leds instanceof List)) return null
    Map zones = [left: [], right: [], top: [], bottom: []]
    leds.eachWithIndex { Object led, int i ->
        if (!(led instanceof Map)) return
        double x = (num(led.hmin) + num(led.hmax)) / 2
        double y = (num(led.vmin) + num(led.vmax)) / 2
        if (x < 0.2) zones.left << i
        if (x > 0.8) zones.right << i
        if (y < 0.2) zones.top << i
        if (y > 0.8) zones.bottom << i
    }
    return zones
}

/** Zone averages of Hyperion's LED colours (a flat [r,g,b,r,g,b,...] list, or a list of [r,g,b]). */
private Map hyperionZones(Object leds, Map layout) {
    if (!(leds instanceof List) || leds.isEmpty()) return null
    List<List> colors = []
    if (leds[0] instanceof List) {
        leds.each { Object c -> List x = rgb(c); if (x != null) colors << x }
    } else {
        for (int i = 0; i + 2 < leds.size(); i += 3) colors << [clamp(leds[i]), clamp(leds[i + 1]), clamp(leds[i + 2])]
    }
    if (colors.isEmpty()) return null
    Map zones = [all: average(colors, null)]
    layout?.each { String z, List idx ->
        List c = average(colors, idx)
        if (c != null) zones[z] = c
    }
    return zones
}

// ───────────────────────────── helpers ─────────────────────────────

/** This device's in-memory map. A ConcurrentHashMap: never store null in it (remove the key instead). */
private Map vol() {
    Long id = device.idAsLong
    Map m = VOLATILE.get(id)
    if (m == null) {
        VOLATILE.putIfAbsent(id, new ConcurrentHashMap())
        m = VOLATILE.get(id)
    }
    return m
}

private int pollMs() {
    int ms = (hyperionPollMs ?: 1000) as int
    return Math.max(250, Math.min(10000, ms))
}

/** [r, g, b] (0..255 integers) of a colour list; a longer list (several LEDs) is averaged; anything else null. */
private List rgb(Object v) {
    if (!(v instanceof List) || v.size() < 3) return null
    if (!v.every { it instanceof Number }) return null
    if (v.size() == 3) return [clamp(v[0]), clamp(v[1]), clamp(v[2])]
    List<List> colors = []
    for (int i = 0; i + 2 < v.size(); i += 3) colors << [clamp(v[i]), clamp(v[i + 1]), clamp(v[i + 2])]
    return average(colors, null)
}

private List average(List<List> colors, List idx) {
    long r = 0, g = 0, b = 0
    int n = 0
    (idx != null ? idx : (0..<colors.size())).each { Object i ->
        List c = colors[(int) i]
        if (c == null) return
        r += (int) c[0]; g += (int) c[1]; b += (int) c[2]; n++
    }
    return n == 0 ? null : [Math.round((double) r / n) as int, Math.round((double) g / n) as int, Math.round((double) b / n) as int]
}

private int clamp(Object v) {
    return Math.max(0, Math.min(255, Math.round(num(v)) as int))
}

private double num(Object v) {
    return v instanceof Number ? ((Number) v).doubleValue() : 0d
}

private String hex(List c) {
    return String.format("#%02X%02X%02X", c[0] as int, c[1] as int, c[2] as int)
}

private void logDebug(String msg) {
    if (logEnable) log.debug "${device.displayName}: ${msg}"
}
