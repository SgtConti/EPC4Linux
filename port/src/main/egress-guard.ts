// Node-side egress ban of the main process (ARCHITECTURE rule 4 "Nothing online"; 20-online-sweep-tail
// summary §10: "Chromium resolver and proxy dead-ends … a Node-side egress ban").
//
// session.webRequest (network-guard.ts) and the resolver/proxy switches only cover Chromium's network
// stack. Main also runs Node: the backend, the hub and every npm dependency. None of them opens an outbound
// connection today, and this guard makes sure a future dependency or change cannot do so unnoticed. It is
// installed before the backend is created and refuses, with a log line and an exception:
//   - net.Socket connect() (net.connect, http/https agents, tls.connect, fetch/undici) to anything but a
//     Unix socket or a loopback IP literal (127.0.0.0/8, ::1, ::ffff:127.0.0.0/104); host names are
//     refused too, except "localhost";
//   - dgram send()/connect() to a non-loopback address;
//   - dns.lookup of any name but "localhost" (getaddrinfo), and every dns.resolve*/reverse query (c-ares
//     sends those to the network itself), for the callback and promise APIs and dns.Resolver instances.
// Servers are not affected (the hub listens on 127.0.0.1; accepted sockets are not connect() calls), nor
// are child processes (gdbus, xprop, parec) and Chromium's own networking.

import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import type { Logger } from '../backend/types.ts';

/** The error a refused connection or lookup gets (code EACCES, like a firewall's refusal). */
export class EgressBlockedError extends Error {
  readonly code = 'EACCES';

  constructor(what: string) {
    super(`EACCES: outbound network access is disabled in this app (${what})`);
    this.name = 'EgressBlockedError';
  }
}

/** A loopback IP literal: 127.0.0.0/8, ::1 (any spelling) or an IPv4-mapped 127.x address. */
export function isLoopbackIp(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = net.isIP(h);
  if (family === 4) return h.split('.')[0] === '127';
  if (family !== 6) return false;
  const groups = expandIpv6(h.toLowerCase());
  if (!groups) return false;
  const zeros = (n: number) => groups.slice(0, n).every((g) => g === 0);
  if (zeros(7) && groups[7] === 1) return true; // ::1
  return zeros(5) && groups[5] === 0xffff && groups[6] >> 8 === 127; // ::ffff:127.0.0.0/104
}

/** The eight 16-bit groups of an IPv6 literal (zone id dropped, dotted IPv4 tail converted), or null. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.replace(/%.*$/, '');
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Host names that may be looked up and connected to by name (they resolve to loopback, /etc/hosts). */
function isLocalhostName(host: string): boolean {
  return /^localhost\.?$/i.test(host);
}

/** May a TCP/UDP peer `host` be contacted? Loopback IP literals and "localhost" only. */
export function isAllowedPeer(host: string): boolean {
  return isLoopbackIp(host) || isLocalhostName(host);
}

interface ConnectTarget {
  path?: string;
  host?: string;
  port?: unknown;
}

/** What net.Socket#connect(...) was asked to reach (all public overloads plus Node's normalized form). */
export function connectTarget(args: readonly unknown[]): ConnectTarget {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // net.connect → socket.connect(normalizedArgs)
  if (first !== null && typeof first === 'object') {
    const o = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof o.path === 'string' && o.path !== '') return { path: o.path };
    return { host: typeof o.host === 'string' && o.host !== '' ? o.host : 'localhost', port: o.port };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { host: typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost', port: first };
}

const DNS_QUERY_METHODS = [
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt',
  'reverse',
] as const;

type Restore = () => void;

function patch<T extends object>(target: T, key: string, make: (original: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown, restores: Restore[]): void {
  const holder = target as Record<string, unknown>;
  const original = holder[key];
  if (typeof original !== 'function') return;
  holder[key] = make(original as (...a: unknown[]) => unknown);
  restores.push(() => {
    holder[key] = original;
  });
}

let installed: Restore | null = null;

/**
 * Install the ban in this process (idempotent). Returns a function that removes it (tests). `log` gets one
 * warning per refused attempt.
 */
export function installEgressGuard(log: Logger): Restore {
  if (installed) return installed;
  const restores: Restore[] = [];
  const refuse = (what: string): EgressBlockedError => {
    const err = new EgressBlockedError(what);
    log.warn(`Blocked outbound ${what}`);
    return err;
  };

  patch(net.Socket.prototype, 'connect', (original) =>
    function (this: net.Socket, ...args: unknown[]) {
      const t = connectTarget(args);
      if (t.path === undefined && !isAllowedPeer(t.host ?? '')) throw refuse(`connection to ${t.host}:${String(t.port)}`);
      return original.apply(this, args);
    },
  restores);

  const udpAddress = (args: readonly unknown[], from: number): string | undefined => args.slice(from).find((a): a is string => typeof a === 'string');
  patch(dgram.Socket.prototype, 'send', (original) =>
    function (this: dgram.Socket, ...args: unknown[]) {
      // send(msg, [offset, length,] port[, address][, cb]); msg itself may be a string.
      const address = udpAddress(args, 1);
      if (address !== undefined && !isAllowedPeer(address)) throw refuse(`UDP datagram to ${address}`);
      return original.apply(this, args);
    },
  restores);
  patch(dgram.Socket.prototype, 'connect', (original) =>
    function (this: dgram.Socket, ...args: unknown[]) {
      const address = udpAddress(args, 1);
      if (address !== undefined && !isAllowedPeer(address)) throw refuse(`UDP connection to ${address}`);
      return original.apply(this, args);
    },
  restores);

  // getaddrinfo: only "localhost" (and IP literals, which resolve to themselves without a query).
  patch(dns, 'lookup', (original) =>
    function (this: unknown, ...args: unknown[]) {
      const host = String(args[0]);
      if (!isLocalhostName(host) && net.isIP(host) === 0) {
        const err = refuse(`DNS lookup of ${host}`);
        const cb = args.findLast((a) => typeof a === 'function') as ((e: Error) => void) | undefined;
        if (!cb) throw err;
        process.nextTick(cb, err);
        return {};
      }
      return original.apply(this, args);
    },
  restores);
  patch(dns.promises, 'lookup', (original) =>
    function (this: unknown, ...args: unknown[]) {
      const host = String(args[0]);
      if (!isLocalhostName(host) && net.isIP(host) === 0) return Promise.reject(refuse(`DNS lookup of ${host}`));
      return original.apply(this, args);
    },
  restores);
  // c-ares queries go to the configured name servers directly: none at all.
  const callbackQuery = () =>
    function (this: unknown, ...args: unknown[]) {
      const err = refuse(`DNS query for ${String(args[0])}`);
      const cb = args.findLast((a) => typeof a === 'function') as ((e: Error) => void) | undefined;
      if (!cb) throw err;
      process.nextTick(cb, err);
      return {};
    };
  const promiseQuery = () =>
    function (this: unknown, ...args: unknown[]) {
      return Promise.reject(refuse(`DNS query for ${String(args[0])}`));
    };
  for (const m of DNS_QUERY_METHODS) {
    patch(dns, m, callbackQuery, restores);
    patch(dns.Resolver.prototype, m, callbackQuery, restores);
    patch(dns.promises, m, promiseQuery, restores);
    patch(dns.promises.Resolver.prototype, m, promiseQuery, restores);
  }

  installed = () => {
    for (const r of restores.reverse()) r();
    installed = null;
  };
  log.info('Outbound network access from Node disabled (loopback and Unix sockets only)');
  return installed;
}
