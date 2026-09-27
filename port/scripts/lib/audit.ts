// Static audit of the patched vendor UI (14 §1 method, applied to our own output).
//
// After patching, every JS/HTML/CSS file is scanned for
//   1. absolute http(s)/ws(s) URLs (any letter case): each must be one of the two loopback hub forms
//      the port introduces (see `hubVerdict`) or an allowlisted inert string (XML namespace, library
//      error text, licence link) — anything else fails, including other loopback URLs;
//   2. scheme-only literals (`"https://"`): the building block of a URL assembled by concatenation
//      (`"https://"+host`), which rule 1 cannot see. Each must be covered by a reviewed entry;
//   3. network-API call sites (fetch, XHR, WebSocket, EventSource, importScripts, Worker, …),
//      also through aliased constructors such as `new this._options.EventSource(`: each must be
//      covered by a reviewed entry that explains why it cannot reach the network — unreviewed sites
//      fail;
// and a table of all findings is produced for the build log. Reviewed entries carry an exact count,
// so a new site next to a reviewed one still fails. The scan is lexical (a URL split into pieces
// other than a scheme literal, e.g. "https:"+"//"+host, is not recognized); the CSP and the
// main-process network kill-switch remain the enforcement layers behind it (02 §L.4).

import { matchGlob, globToRegExp } from './patch-engine.ts';
import type { ReviewedScheme, ReviewedSite, UrlAllowEntry } from './types.ts';

export type Verdict = 'loopback' | 'allowlisted' | 'reviewed' | 'FAIL';

export interface AuditFinding {
  kind: 'url' | 'api';
  file: string;
  offset: number;
  /** The URL, or the API kind for call sites. */
  match: string;
  verdict: Verdict;
  reason: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  /** Human-readable failure lines (unallowlisted URLs, unreviewed sites or scheme literals, stale table entries). */
  failures: string[];
  /** IPC channel → number of references, for the preload allowlist review (01 §10, 02 §3). */
  ipcChannels: Record<string, number>;
  filesScanned: number;
}

/** Network-capable browser APIs. The regexes are deliberately broad; the reviewed-site table narrows them. */
export const NETWORK_APIS: ReadonlyArray<{ api: string; re: RegExp }> = [
  // Calls, and `fetch.bind/call/apply` (how SignalR's HTTP client captures fetch for later use).
  { api: 'fetch', re: /(?<![\w$])fetch(?:\s*\(|\.(?:bind|call|apply)\s*\()/g },
  // Constructors are matched through any member-expression alias and in any letter case: SignalR
  // keeps its transports' constructors in fields (`new this._webSocketConstructor(`,
  // `new this._options.EventSource(`), and `SharedWorker`/`webkitRTCPeerConnection` are prefixes.
  { api: 'XMLHttpRequest', re: /\bnew\s+[\w$.]*xmlhttprequest/gi },
  { api: 'WebSocket', re: /\bnew\s+[\w$.]*websocket[\w$]*\s*\(/gi },
  { api: 'EventSource', re: /\bnew\s+[\w$.]*eventsource[\w$]*\s*\(/gi },
  { api: 'importScripts', re: /\bimportScripts\s*\(/g },
  { api: 'Worker', re: /\bnew\s+[\w$.]*worker\s*\(/gi },
  { api: 'sendBeacon', re: /\bsendBeacon\s*\(/g },
  { api: 'window.open', re: /\bwindow\.open\s*\(/g },
  { api: 'RTCPeerConnection', re: /\bnew\s+[\w$.]*rtcpeerconnection/gi },
  { api: 'serviceWorker.register', re: /\bserviceWorker\.register\s*\(/g },
];

/**
 * The hub endpoint (ARCHITECTURE "Keep the SignalR wire protocol"; 02 §4.1) and the CSP source that
 * admits it (the `connect-src` of the policy in ui-patches.mjs). These are the only loopback URLs the
 * audit accepts without an allowlist entry.
 */
export const HUB_PATH = '/EvniaHub';
export const HUB_CSP_SOURCE = 'ws://127.0.0.1:*';

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>\\)]*/gi;
/** A template-literal placeholder; the last one may be cut off by the URL scanner (it stops at quotes). */
const PLACEHOLDER_RE = /\$\{[^}]*\}?/g;
const IPC_RE = /window\.ipc\.(?:send|invoke|on|once)\(\s*"([\w:-]+)"/g;
const CONTEXT_BEFORE = 160;
const CONTEXT_AFTER = 80;

export function isAuditedFile(path: string): boolean {
  return /\.(?:m?js|html?|css)$/i.test(path);
}

/** True for a scheme-only literal such as the "http://" input placeholder of the vendor ButtonFunc page. */
function isBareScheme(url: string): boolean {
  return /^[a-z]+:\/\/$/i.test(url);
}

/** The source text a reviewed entry's `context` must occur in. */
function contextAt(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - CONTEXT_BEFORE), index + length + CONTEXT_AFTER);
}

/** A short excerpt around a failure, for the build log. */
function excerpt(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 60), index + length + 20);
}

/** Parses a URL as scanned from source text, with every `${…}` placeholder replaced by a dummy value. */
function parseTemplateUrl(url: string): URL | null {
  try {
    return new URL(url.replace(PLACEHOLDER_RE, '1'));
  } catch {
    return null;
  }
}

/**
 * Reason text if `url` (found in `path`) is one of the two loopback hub forms the port introduces,
 * otherwise null:
 *   - in a script, the hub URL template of the HUB-URL patch: scheme http or ws, host literally
 *     127.0.0.1 (placeholders only after it, i.e. in the port, path or query), no userinfo, path
 *     exactly /EvniaHub;
 *   - in an HTML page, exactly the CSP source `ws://127.0.0.1:*`.
 * Anything else on loopback — another local service's port or path, `localhost` (a leftover means an
 * unpatched site), or a userinfo form such as `http://127.0.0.1:80@evil.example/` — is not accepted.
 */
function hubVerdict(path: string, url: string): string | null {
  if (/\.html?$/i.test(path)) return url === HUB_CSP_SOURCE ? 'CSP connect-src for the loopback hub (127.0.0.1 only)' : null;
  if (!/\.m?js$/i.test(path) || !/^(?:http|ws):\/\/127\.0\.0\.1(?=[:/?#]|$)/i.test(url)) return null;
  const u = parseTemplateUrl(url);
  if (!u || u.hostname !== '127.0.0.1' || u.username !== '' || u.password !== '' || u.pathname !== HUB_PATH) return null;
  return 'loopback hub URL (HUB-URL; 127.0.0.1 only, per-launch token)';
}

/** Failure reason for a URL that is neither the hub nor allowlisted. */
function failReason(url: string): string {
  const host = parseTemplateUrl(url)?.hostname ?? '';
  return /^(?:127\.|localhost$|\[::1\]$|0\.0\.0\.0$)/i.test(host)
    ? 'loopback URL other than the token-protected hub'
    : 'remote URL not allowlisted';
}

export interface AuditRules {
  urlAllowlist: readonly UrlAllowEntry[];
  reviewedSites: readonly ReviewedSite[];
  reviewedSchemes: readonly ReviewedScheme[];
}

export function auditFiles(files: ReadonlyMap<string, string>, rules: AuditRules): AuditReport {
  const findings: AuditFinding[] = [];
  const failures: string[] = [];
  const ipcChannels: Record<string, number> = {};
  const allowHits = new Map<string, number>(rules.urlAllowlist.map((a) => [a.url, 0]));
  const siteHits = rules.reviewedSites.map(() => 0);
  const schemeHits = rules.reviewedSchemes.map(() => 0);
  const paths = [...files.keys()].filter(isAuditedFile).sort();

  for (const path of paths) {
    const text = files.get(path) ?? '';

    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(/[;,.]+$/, '');
      if (isBareScheme(url)) {
        const ctx = contextAt(text, m.index, url.length);
        const idx = rules.reviewedSchemes.findIndex((s) => globToRegExp(s.file).test(path) && ctx.includes(s.context));
        if (idx >= 0) {
          schemeHits[idx] = (schemeHits[idx] ?? 0) + 1;
          findings.push({ kind: 'url', file: path, offset: m.index, match: url, verdict: 'reviewed', reason: rules.reviewedSchemes[idx]?.reason ?? '' });
        } else {
          const reason = 'scheme-only literal not reviewed (a URL may be built by concatenation)';
          failures.push(`${path}@${m.index}: ${reason}: …${excerpt(text, m.index, url.length)}…`);
          findings.push({ kind: 'url', file: path, offset: m.index, match: url, verdict: 'FAIL', reason });
        }
        continue;
      }
      const hub = hubVerdict(path, url);
      const allow = rules.urlAllowlist.find((a) => a.url === url);
      let verdict: Verdict;
      let reason: string;
      if (hub) {
        verdict = 'loopback';
        reason = hub;
      } else if (allow) {
        verdict = 'allowlisted';
        reason = allow.reason;
        allowHits.set(allow.url, (allowHits.get(allow.url) ?? 0) + 1);
      } else {
        verdict = 'FAIL';
        reason = failReason(url);
        failures.push(`${path}@${m.index}: ${reason}: ${url}`);
      }
      findings.push({ kind: 'url', file: path, offset: m.index, match: url, verdict, reason });
    }

    for (const { api, re } of NETWORK_APIS) {
      for (const m of text.matchAll(re)) {
        const ctx = contextAt(text, m.index, m[0].length);
        const idx = rules.reviewedSites.findIndex(
          (s) => s.api === api && globToRegExp(s.file).test(path) && ctx.includes(s.context),
        );
        if (idx >= 0) {
          siteHits[idx] = (siteHits[idx] ?? 0) + 1;
          findings.push({ kind: 'api', file: path, offset: m.index, match: api, verdict: 'reviewed', reason: rules.reviewedSites[idx]?.reason ?? '' });
        } else {
          failures.push(`${path}@${m.index}: unreviewed ${api} call site: …${excerpt(text, m.index, m[0].length)}…`);
          findings.push({ kind: 'api', file: path, offset: m.index, match: api, verdict: 'FAIL', reason: 'network API call site not reviewed' });
        }
      }
    }

    for (const m of text.matchAll(IPC_RE)) {
      const ch = m[1] ?? '';
      ipcChannels[ch] = (ipcChannels[ch] ?? 0) + 1;
    }
  }

  for (const [url, hits] of allowHits) {
    if (hits === 0) failures.push(`stale URL allowlist entry (no longer present): ${url}`);
  }
  const checkExact = (label: string, entries: ReadonlyArray<{ file: string; context: string; count: number }>, hits: number[]): void => {
    entries.forEach((s, i) => {
      const found = hits[i] ?? 0;
      if (found !== s.count) failures.push(`reviewed ${label} "${s.context}" in ${s.file}: expected ${s.count} occurrence(s), found ${found}`);
      if (matchGlob(paths, s.file).length === 0) failures.push(`reviewed ${label} file ${s.file} is not part of the imported UI`);
    });
  };
  checkExact('scheme literal', rules.reviewedSchemes, schemeHits);
  rules.reviewedSites.forEach((s, i) => checkExact(`${s.api} site`, [s], [siteHits[i] ?? 0]));

  return { findings, failures, ipcChannels, filesScanned: paths.length };
}

/** Plain-text table for the build log; identical findings in one file are folded into one row. */
export function formatAuditTable(report: AuditReport): string {
  const rows = new Map<string, { f: AuditFinding; n: number }>();
  for (const f of report.findings) {
    const key = `${f.verdict}\u0000${f.kind}\u0000${f.file}\u0000${f.match}\u0000${f.reason}`;
    const row = rows.get(key);
    if (row) row.n++;
    else rows.set(key, { f, n: 1 });
  }
  const table = [...rows.values()].sort(
    (a, b) => Number(b.f.verdict === 'FAIL') - Number(a.f.verdict === 'FAIL') || a.f.file.localeCompare(b.f.file) || a.f.match.localeCompare(b.f.match),
  );
  const cols: Array<[string, (r: { f: AuditFinding; n: number }) => string]> = [
    ['VERDICT', (r) => r.f.verdict],
    ['KIND', (r) => r.f.kind],
    ['FILE', (r) => r.f.file],
    ['N', (r) => String(r.n)],
    ['MATCH', (r) => (r.f.match.length > 70 ? `${r.f.match.slice(0, 67)}...` : r.f.match)],
    ['REASON', (r) => r.f.reason],
  ];
  const widths = cols.map(([h, get]) => Math.max(h.length, ...table.map((r) => get(r).length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ');
  return [line(cols.map(([h]) => h)), ...table.map((r) => line(cols.map(([, get]) => get(r))))].join('\n');
}
