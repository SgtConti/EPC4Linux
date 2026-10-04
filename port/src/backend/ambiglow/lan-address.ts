// The LAN colour sync setting and its address rules (lan-sync.ts), as a pure module: no Node or Electron imports, so the
// sandboxed preload (window.__EVNIA__.lanSync), main (src/main/lan-sync.ts, the egress guard) and the backend sender
// validate exactly alike.
//
// The destination is a private IPv4 literal only — RFC 1918 or link-local — never a host name (no DNS lookup ever
// happens) and never a public, loopback or IPv6 address: the Hubitat hub is on the user's own network (ARCHITECTURE
// rule 4 "Nothing online" keeps holding for everything else).

/** Hubitat's LAN message port (TCP; the hub routes the request to the device whose DNI is the sender's IP/MAC). */
export const LAN_SYNC_DEFAULT_PORT = 39501;

/** The persisted setting (config.json linuxLanSync): off unless enabled with a valid private address. */
export interface LanSyncSettings {
  enabled: boolean;
  /** A private IPv4 literal, or '' while none is set. */
  host: string;
  port: number;
}

export const LAN_SYNC_OFF: Readonly<LanSyncSettings> = Object.freeze({ enabled: false, host: '', port: LAN_SYNC_DEFAULT_PORT });

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A dotted-quad IPv4 literal without leading zeros ("192.168.1.20", not "192.168.001.20" or "1.2.3"). */
export function isIpv4(host: string): boolean {
  return typeof host === 'string' && IPV4.test(host);
}

/**
 * A private IPv4 literal: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC 1918) or 169.254.0.0/16 (link-local).
 * Host names, loopback, public and IPv6 addresses are not.
 */
export function isPrivateIpv4(host: string): boolean {
  if (!isIpv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * "192.168.1.20" or "192.168.1.20:39501" (what the Ambiglow page's address field takes) → host and port, or an error
 * text for the user. Surrounding blanks and an "http://" prefix or trailing "/" are tolerated.
 */
export function parseLanSyncAddress(text: string): { host: string; port: number } | { error: string } {
  if (typeof text !== 'string') return { error: 'the address must be text' };
  const s = text.trim().replace(/^http:\/\//i, '').replace(/\/+$/, '');
  if (s === '') return { error: 'no address given' };
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return { error: `"${s}" is not an IPv4 address with an optional :port` };
  const host = m[1];
  const port = m[2] === undefined ? LAN_SYNC_DEFAULT_PORT : Number(m[2]);
  if (!isIpv4(host)) return { error: `"${host}" is not an IPv4 address (host names are not looked up)` };
  if (!isPrivateIpv4(host)) return { error: `${host} is not a private network address (10.x, 172.16-31.x, 192.168.x or 169.254.x)` };
  if (port < 1 || port > 65535) return { error: `port ${m[2]} is out of range` };
  return { host, port };
}

/** The setting as stored (any JSON) → a valid one: enabled only with a private host; a bad port is the default. */
export function normalizeLanSyncSettings(value: unknown): LanSyncSettings {
  if (value === null || typeof value !== 'object') return { ...LAN_SYNC_OFF };
  const v = value as { enabled?: unknown; host?: unknown; port?: unknown };
  const host = typeof v.host === 'string' && isPrivateIpv4(v.host.trim()) ? v.host.trim() : '';
  const port = typeof v.port === 'number' && Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535 ? v.port : LAN_SYNC_DEFAULT_PORT;
  return { enabled: v.enabled === true && host !== '', host, port };
}

/** "192.168.1.20:39501" (logs); "(no address)" while none is set. */
export function describeLanTarget(s: Pick<LanSyncSettings, 'host' | 'port'>): string {
  return s.host === '' ? '(no address)' : `${s.host}:${s.port}`;
}

/** The address field's text: "192.168.1.20", with ":port" only when it is not the default. */
export function lanSyncAddressText(s: Pick<LanSyncSettings, 'host' | 'port'>): string {
  return s.host === '' ? '' : s.port === LAN_SYNC_DEFAULT_PORT ? s.host : `${s.host}:${s.port}`;
}
