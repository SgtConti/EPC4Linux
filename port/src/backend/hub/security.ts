// Access control for the hub endpoint (ARCHITECTURE.md "Keep the SignalR wire protocol", rule 5).
//
// The vendor backend listened on http://*:10010 with no authentication at all (05 §2.3), so any
// LAN host or any web page open in a browser could drive the monitor. The port closes that:
//   1. the HTTP server binds 127.0.0.1 only (signalr-server.ts);
//   2. every WebSocket upgrade must carry the per-launch random token as `?k=<token>`. This 256-bit
//      secret is the ONLY barrier against browser content and against local processes: see 3;
//   3. an upgrade whose Origin header is present must be on the allow-list (default `file://` and
//      `null`, as the port task specifies). Browsers attach an Origin that scripts cannot forge, so
//      this filters ordinary web origins (https://…, http://localhost:…, a DNS-rebound name).
//      It does NOT keep browser content out in general: any web page can connect from an opaque
//      origin, which sends `Origin: null` (a sandboxed iframe, a srcdoc or data: frame, a page served
//      with `CSP: sandbox`), and a local .html file opened in a browser sends `file://` (Chromium) or
//      `null`. Non-browser clients send no Origin at all. The Electron renderer loaded with loadFile
//      sends `Origin: file://`; only its sandboxed/data: frames send `null` (probed with Electron 44,
//      impl-hub-rpc.md §4), so main can pass `allowedOrigins: ['file://']` to close the `null` path;
//   4. the Host header must name the loopback endpoint (127.0.0.1:<port> or localhost:<port>). With
//      the Origin check this defeats DNS rebinding (20-online-sweep-tail.md summary, §10.7); it does
//      not stop a page that addresses 127.0.0.1 directly, which is again left to the token.
// Only functions registered by api/ modules are callable (rpc/dispatcher.ts), which is the explicit
// function allowlist that replaces the vendor's reflection over all public Bridge methods.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Minimum accepted token length; generateHubToken() produces 43 characters. */
export const MIN_TOKEN_LENGTH = 16;

/** Origins allowed to open the hub by default (see header, item 3: `null` is reachable by any web page). */
export const ALLOWED_ORIGINS: readonly string[] = ['file://', 'null'];

/** 256-bit random token, URL-safe (base64url), suitable for the `k` query parameter. */
export function generateHubToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time token comparison. Both sides are hashed first so neither the content nor the
 * length of the expected token leaks through timing.
 */
export function tokenMatches(expected: string, supplied: string | null): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(supplied ?? '', 'utf8').digest();
  return timingSafeEqual(a, b) && supplied !== null;
}

/**
 * True when the handshake may proceed as far as the Origin policy is concerned. `allowed` replaces
 * the default list if the renderer is ever served from a custom scheme (e.g. "app://evnia").
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[] = ALLOWED_ORIGINS): boolean {
  return origin === undefined || allowed.includes(origin);
}

/** True when the Host header names the loopback endpoint the hub is bound to. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}
