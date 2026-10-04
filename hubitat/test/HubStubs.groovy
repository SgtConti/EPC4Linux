// Minimal stand-ins for the Hubitat sandbox API that ../apps and ../drivers use (see run.sh).
class Log {
    List lines = []
    def debug(m) { lines << "DEBUG $m" }
    def info(m) { lines << "INFO $m"; println "  info: $m" }
    def warn(m) { lines << "WARN $m"; println "  warn: $m" }
    def error(m) { lines << "ERROR $m"; println "  error: $m" }
}

class FakeRawSocket {
    List sent = []
    List connects = []
    boolean closed = false
    void connect(Map opts, String host, int port) { connects << [opts, host, port] }
    void sendMessage(String m) { sent << m }
    void close() { closed = true }
}

class FakeDevice {
    String displayName = "Receiver"
    Long idAsLong = 42L
    String deviceNetworkId
    Map<String, Object> current = [:]
    List events = []
    def currentValue(String n) { current[n] }
}

abstract class HubBase extends Script {
    Log log = new Log()
    Map settings = [:]
    Map state = [:]
    List schedules = []
    long clock = 1_000_000L
    long now() { clock }
    void advance(long ms) { clock += ms }
    void runIn(Number s, String h, Map o = [:]) { schedules << ["runIn", s, h] }
    void runInMillis(Number ms, String h, Map o = [:]) { schedules << ["runInMillis", ms, h] }
    void unschedule(String h = null) { schedules << ["unschedule", h] }
    def propertyMissing(String name) { settings[name] }
    // definition DSL: ignored
    def definition(Map m, Closure c = null) { c?.delegate = this; c?.call() }
    def metadata(Closure c) { c.delegate = this; c.call() }
    def preferences(Closure c) { c.delegate = this; c.call() }
    def capability(String s) {}
    def attribute(String a, String t, List v = null) {}
    def command(String c, List a = null) {}
    def input(Map m) {}
    def input(String n, String t, Map m = [:]) {}
    def input(Map m, String n, String t) {}
    def page(Map m) {}
    def section(String t, Closure c) { c.delegate = this; c.call() }
    def label(Map m) {}
    def paragraph(String s) { paragraphs << s }
    List paragraphs = []
    def dynamicPage(Map m, Closure c) { c.delegate = this; c.call(); m }
}

abstract class DriverBase extends HubBase {
    FakeDevice device = new FakeDevice()
    def parent
    FakeRawSocket raw = new FakeRawSocket()
    Map interfaces = [rawSocket: raw]
    void sendEvent(Map e) { device.events << e; device.current[e.name] = e.value }
    Map parseLanMessage(String d) {
        Map m = [:]
        d.split(", ").each { String kv -> int i = kv.indexOf(":"); m[kv.substring(0, i)] = kv.substring(i + 1) }
        if (m.body) m.body = new String(m.body.decodeBase64(), "UTF-8")
        m
    }
}

class FakeLight {
    def id
    String displayName
    Map current = [:]
    List calls = []
    def currentValue(String n) { current[n] }
    void setColor(Map c) { calls << ["setColor", c]; current.switch = "on"; current.hue = c.hue; current.saturation = c.saturation; current.level = c.level; current.colorMode = "RGB" }
    void off() { calls << ["off"]; current.switch = "off" }
    void setLevel(int l) { calls << ["setLevel", l] }
    void setColorTemperature(int ct, int level) { calls << ["setColorTemperature", ct, level] }
}

class FakeChild {
    String deviceNetworkId
    String displayName
    List calls = []
    void setDeviceNetworkId(String d) { deviceNetworkId = d }
    void markInactive() { calls << "markInactive" }
}

abstract class AppBase extends HubBase {
    Map app = [id: 7L, label: "Ambient Color Sync", updateLabel: { String l -> }]
    Map location = [hub: [localIP: "192.168.1.20"]]
    List children = []
    List getChildDevices() { children }
    def addChildDevice(String ns, String type, String dni, Map props) {
        def c = new FakeChild(deviceNetworkId: dni, displayName: props.label); children << c; c
    }
    void deleteChildDevice(String dni) { children.removeAll { it.deviceNetworkId == dni } }
}
