// The LAN colour sync setting and its address rules (lan-sync.ts), as a pure module: no Node or Electron imports, so the
// sandboxed preload (window.__EVNIA__.lanSync), main (src/main/lan-sync.ts, the egress guard) and the backend sender
// validate exactly alike.
//
// Two kinds of receiver take the same JSON document (hubitat/, home-assistant/):
//   Hubitat          "192.168.1.20" → POST http://192.168.1.20:39501/ (the hub's LAN port; it routes the request by the
//                    sender's IP or MAC address);
//   Home Assistant   "http://192.168.1.20:8123/api/webhook/<id>" → POST to that webhook of the Ambient Color Sync
//                    integration (port 8123 when the URL has a webhook path but no port).
// The destination is a private IPv4 literal only — RFC 1918 or link-local — never a host name (no DNS lookup ever
// happens, so "homeassistant.local" is refused) and never a public, loopback or IPv6 address; plain http only, as both
// receivers serve on the user's own network (ARCHITECTURE rule 4 "Nothing online" keeps holding for everything else).

/** Hubitat's LAN message port (TCP; the hub routes the request to the device whose DNI is the sender's IP/MAC). */
export const LAN_SYNC_DEFAULT_PORT = 39501;
/** Home Assistant's default port: used for a webhook URL without a port. */
export const LAN_SYNC_HA_PORT = 8123;
/** Home Assistant's webhook path prefix (the integration's URL is <prefix><webhook id>). */
export const HA_WEBHOOK_PREFIX = '/api/webhook/';

/** The persisted setting (config.json linuxLanSync): off unless enabled with a valid private address. */
export interface LanSyncSettings {
  enabled: boolean;
  /** A private IPv4 literal, or '' while none is set. */
  host: string;
  port: number;
  /** The request path: '/' for Hubitat, '/api/webhook/<id>' for Home Assistant. */
  path: string;
}

export const LAN_SYNC_OFF: Readonly<LanSyncSettings> = Object.freeze({ enabled: false, host: '', port: LAN_SYNC_DEFAULT_PORT, path: '/' });

/** A request path the sender may use: '/' plus URL path characters (no query, fragment or blanks), at most 200 long. */
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,199}$/;

export function isValidLanPath(path: string): boolean {
  return typeof path === 'string' && PATH.test(path) && !path.includes('//') && !/(^|\/)\.\.?(\/|$)/.test(path);
}

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
 * What the address field takes → host, port and path, or an error text for the user:
 *   "192.168.1.20", "192.168.1.20:39501"                    Hubitat (path '/', port 39501 unless given);
 *   "http://192.168.1.20:8123/api/webhook/abc", without the  Home Assistant (port 8123 unless given for a webhook
 *   "http://" or the port                                   path, else 39501).
 * Surrounding blanks and trailing slashes are tolerated.
 */
export function parseLanSyncAddress(text: string): { host: string; port: number; path: string } | { error: string } {
  if (typeof text !== 'string') return { error: 'the address must be text' };
  let s = text.trim();
  if (/^https:\/\//i.test(s)) return { error: 'https is not supported; use the http:// address on your network' };
  s = s.replace(/^http:\/\//i, '');
  if (s === '') return { error: 'no address given' };
  const m = /^([^:/?#]+)(?::(\d{1,5}))?(\/[^?#]*)?$/.exec(s);
  if (!m) return { error: `"${s}" is not an IPv4 address with an optional :port and path` };
  const host = m[1];
  const path = (m[3] ?? '/').replace(/\/+$/, '') || '/';
  const port = m[2] !== undefined ? Number(m[2]) : path.startsWith(HA_WEBHOOK_PREFIX) ? LAN_SYNC_HA_PORT : LAN_SYNC_DEFAULT_PORT;
  if (!isIpv4(host)) return { error: `"${host}" is not an IPv4 address (host names are not looked up)` };
  if (!isPrivateIpv4(host)) return { error: `${host} is not a private network address (10.x, 172.16-31.x, 192.168.x or 169.254.x)` };
  if (port < 1 || port > 65535) return { error: `port ${m[2]} is out of range` };
  if (!isValidLanPath(path)) return { error: `"${path}" is not a usable path` };
  return { host, port, path };
}

/** The setting as stored (any JSON) → a valid one: enabled only with a private host; a bad port or path is the default. */
export function normalizeLanSyncSettings(value: unknown): LanSyncSettings {
  if (value === null || typeof value !== 'object') return { ...LAN_SYNC_OFF };
  const v = value as { enabled?: unknown; host?: unknown; port?: unknown; path?: unknown };
  const host = typeof v.host === 'string' && isPrivateIpv4(v.host.trim()) ? v.host.trim() : '';
  const port = typeof v.port === 'number' && Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535 ? v.port : LAN_SYNC_DEFAULT_PORT;
  const path = typeof v.path === 'string' && isValidLanPath(v.path) ? v.path : '/';
  return { enabled: v.enabled === true && host !== '', host, port, path };
}

/** The path with a webhook id shortened ("/api/webhook/3f9a…"): the id is a secret, so it stays out of logs. */
export function redactLanPath(path: string): string {
  if (!path.startsWith(HA_WEBHOOK_PREFIX)) return path;
  const id = path.slice(HA_WEBHOOK_PREFIX.length);
  return `${HA_WEBHOOK_PREFIX}${id.length > 6 ? `${id.slice(0, 4)}…` : id}`;
}

/** "192.168.1.20:39501" or "192.168.1.20:8123/api/webhook/3f9a…" (logs); "(no address)" while none is set. */
export function describeLanTarget(s: Pick<LanSyncSettings, 'host' | 'port'> & { path?: string }): string {
  if (s.host === '') return '(no address)';
  const path = s.path === undefined || s.path === '/' ? '' : redactLanPath(s.path);
  return `${s.host}:${s.port}${path}`;
}

/** The address field's text: "192.168.1.20[:port]" for Hubitat, the full "http://host:port/path" URL otherwise. */
export function lanSyncAddressText(s: Pick<LanSyncSettings, 'host' | 'port'> & { path?: string }): string {
  if (s.host === '') return '';
  if (s.path !== undefined && s.path !== '/') return `http://${s.host}:${s.port}${s.path}`;
  return s.port === LAN_SYNC_DEFAULT_PORT ? s.host : `${s.host}:${s.port}`;
}
