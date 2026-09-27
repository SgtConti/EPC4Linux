import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditFiles, formatAuditTable, HUB_CSP_SOURCE, type AuditRules } from '../../../scripts/lib/audit.ts';
import type { ReviewedScheme, ReviewedSite, UrlAllowEntry } from '../../../scripts/lib/types.ts';

const allow: UrlAllowEntry[] = [{ url: 'http://www.w3.org/2000/svg', reason: 'namespace' }];
const reviewed: ReviewedSite[] = [
  { file: 'assets/app-*.js', api: 'fetch', context: 'const core=', count: 1, reason: 'unreachable after patch' },
];
const schemes: ReviewedScheme[] = [{ file: 'assets/app-*.js', context: 'placeholder:"http://"', count: 1, reason: 'input placeholder' }];
const none: AuditRules = { urlAllowlist: [], reviewedSites: [], reviewedSchemes: [] };
const HUB = '`http://127.0.0.1:${e}/EvniaHub?k=${encodeURIComponent(window.__EVNIA__?.hubToken??"")}`';

test('a clean tree passes: loopback hub, allowlisted namespace, reviewed call site, reviewed scheme literal', () => {
  const files = new Map([
    ['assets/app-1.js', `const ns="http://www.w3.org/2000/svg";const u=${HUB};const core=async e=>fetch(e);const p={placeholder:"http://"};`],
    ['index.html', `<meta http-equiv="Content-Security-Policy" content="connect-src 'self' ${HUB_CSP_SOURCE}; img-src 'self'"/>`],
    ['assets/app.css', '.a{background:url(./x.png)}'],
    ['monitor/x.png', 'fetch("https://binary.example/")'],
  ]);
  const report = auditFiles(files, { urlAllowlist: allow, reviewedSites: reviewed, reviewedSchemes: schemes });
  assert.deepEqual(report.failures, []);
  assert.equal(report.filesScanned, 3, 'only JS/HTML/CSS are scanned');
  assert.deepEqual(
    report.findings.map((f) => [f.file, f.kind, f.match, f.verdict]),
    [
      ['assets/app-1.js', 'url', 'http://www.w3.org/2000/svg', 'allowlisted'],
      // The scanner stops at the first quote.
      ['assets/app-1.js', 'url', 'http://127.0.0.1:${e}/EvniaHub?k=${encodeURIComponent(window.__EVNIA__?.hubToken??', 'loopback'],
      ['assets/app-1.js', 'url', 'http://', 'reviewed'],
      ['assets/app-1.js', 'api', 'fetch', 'reviewed'],
      ['index.html', 'url', HUB_CSP_SOURCE, 'loopback'],
    ],
  );
});

test('remote URLs, localhost and unreviewed network APIs fail the audit', () => {
  const files = new Map([
    ['assets/app-1.js', 'const ns="http://www.w3.org/2000/svg";const core=1;const h="https://saas.zeasn.tv";new WebSocket(`ws://localhost:${p}`);self.importScripts(u);'],
  ]);
  const report = auditFiles(files, { urlAllowlist: allow, reviewedSites: reviewed, reviewedSchemes: [] });
  const text = report.failures.join('\n');
  assert.match(text, /remote URL not allowlisted: https:\/\/saas\.zeasn\.tv/);
  assert.match(text, /loopback URL other than the token-protected hub: ws:\/\/localhost:\$\{p\}/);
  assert.match(text, /unreviewed WebSocket call site/);
  assert.match(text, /unreviewed importScripts call site/);
  assert.match(text, /reviewed fetch site "const core=" in assets\/app-\*\.js: expected 1 occurrence\(s\), found 0/);
  assert.match(formatAuditTable(report), /^VERDICT +KIND +FILE +N +MATCH +REASON\nFAIL /);
});

test('a URL built by concatenation from a scheme literal fails unless reviewed, with an exact count', () => {
  const concat = 'const api="https://"+host+"/api";const w=`wss://`+h;';
  const unreviewed = auditFiles(new Map([['assets/app-1.js', concat]]), none);
  assert.deepEqual(
    unreviewed.findings.map((f) => [f.kind, f.match, f.verdict]),
    [['url', 'https://', 'FAIL'], ['url', 'wss://', 'FAIL']],
  );
  assert.equal(unreviewed.failures.length, 2);
  assert.match(
    unreviewed.failures[0] ?? '',
    /^assets\/app-1\.js@\d+: scheme-only literal not reviewed \(a URL may be built by concatenation\): …const api="https:\/\/"\+host/,
  );

  // A new concatenation site next to a reviewed placeholder is caught by the count.
  const next = 'const p={placeholder:"http://"};const api="https://"+host;';
  const report = auditFiles(new Map([['assets/app-1.js', next]]), { ...none, reviewedSchemes: schemes });
  assert.deepEqual(report.failures, ['reviewed scheme literal "placeholder:"http://"" in assets/app-*.js: expected 1 occurrence(s), found 2']);

  // An entry whose literal is gone, or whose file is gone, is stale.
  const stale = auditFiles(new Map([['assets/other.js', 'x=1']]), { ...none, reviewedSchemes: schemes });
  assert.deepEqual(stale.failures, [
    'reviewed scheme literal "placeholder:"http://"" in assets/app-*.js: expected 1 occurrence(s), found 0',
    'reviewed scheme literal file assets/app-*.js is not part of the imported UI',
  ]);
});

test('only the hub template (scripts) and the exact CSP source (HTML) are accepted on loopback', () => {
  const bad = [
    // userinfo: the real host is evil.example
    'http://127.0.0.1:80@evil.example/EvniaHub',
    'http://127.0.0.1:${e}@evil.example/EvniaHub',
    // other local services and paths
    'http://127.0.0.1:631/printers',
    'ws://127.0.0.1:${e}/other',
    'http://127.0.0.1/',
    // a placeholder inside the host, and a scheme the hub does not speak
    'http://127.0.0.${x}/EvniaHub',
    'http://127.0.0.1${x}/EvniaHub',
    'https://127.0.0.1:${e}/EvniaHub',
    // the CSP source belongs in HTML only
    HUB_CSP_SOURCE,
  ];
  const js = bad.map((u) => `u=\`${u}\``).join(';');
  const html = '<meta content="connect-src ws://127.0.0.1:1234 ws://127.0.0.1:*/x"/><a href="http://127.0.0.1:8080/EvniaHub">';
  const report = auditFiles(new Map([['assets/a.js', js], ['index.html', html], ['assets/a.css', `@import "${HUB_CSP_SOURCE}"`]]), none);
  assert.equal(report.findings.filter((f) => f.verdict === 'loopback').length, 0);
  assert.equal(report.failures.length, bad.length + 3 + 1);
  assert.ok(report.failures.some((f) => f.includes('remote URL not allowlisted: http://127.0.0.1:80@evil.example/EvniaHub')));
  assert.ok(report.failures.some((f) => f.includes('loopback URL other than the token-protected hub: http://127.0.0.1:631/printers')));
  const ok = auditFiles(new Map([['assets/a.js', `u=${HUB};v=\`ws://127.0.0.1:\${p}/EvniaHub\``]]), none);
  assert.deepEqual(ok.failures, []);
  assert.equal(ok.findings.filter((f) => f.verdict === 'loopback').length, 2);
});

test('upper-case schemes and aliased or prefixed constructors are found', () => {
  const src =
    'a="HTTPS://Evil.Example/x";b="Wss://evil.example/";c="HTTP://";' +
    'r=new this._options.EventSource(e,{withCredentials:!0});s=new EventSource(u);' +
    'w=new SharedWorker(u);x=new self.Worker(u);y=new window.XMLHttpRequest;z=new webkitRTCPeerConnection(c);' +
    'q=new this._webSocketConstructor(e);';
  const report = auditFiles(new Map([['assets/a.js', src]]), none);
  const count = (api: string) => report.findings.filter((f) => f.kind === 'api' && f.match === api && f.verdict === 'FAIL').length;
  assert.equal(count('EventSource'), 2);
  assert.equal(count('Worker'), 2);
  assert.equal(count('XMLHttpRequest'), 1);
  assert.equal(count('RTCPeerConnection'), 1);
  assert.equal(count('WebSocket'), 1);
  assert.deepEqual(
    report.findings.filter((f) => f.kind === 'url').map((f) => [f.match, f.verdict]),
    [['HTTPS://Evil.Example/x', 'FAIL'], ['Wss://evil.example/', 'FAIL'], ['HTTP://', 'FAIL']],
  );
});

test('stale allowlist entries and wrong reviewed counts are reported, so the table stays exact', () => {
  const files = new Map([['assets/app-1.js', 'const core=async e=>fetch(e);const core2=async e=>fetch(e)']]);
  const report = auditFiles(files, {
    urlAllowlist: [...allow, { url: 'https://gone.example/', reason: 'x' }],
    reviewedSites: [{ ...reviewed[0]!, context: 'const core' }],
    reviewedSchemes: [],
  });
  assert.ok(report.failures.includes('stale URL allowlist entry (no longer present): http://www.w3.org/2000/svg'));
  assert.ok(report.failures.includes('stale URL allowlist entry (no longer present): https://gone.example/'));
  assert.ok(report.failures.some((f) => /expected 1 occurrence\(s\), found 2/.test(f)));
});

test('fetch captured by reference (fetch.bind) counts as a call site; IPC channels are tallied', () => {
  const files = new Map([['a.js', 'this._f=fetch.bind(self);window.ipc.invoke("getMac");window.ipc.send("notice",1);window.ipc.send("notice",0)']]);
  const report = auditFiles(files, none);
  assert.equal(report.findings.filter((f) => f.match === 'fetch' && f.verdict === 'FAIL').length, 1);
  assert.deepEqual(report.ipcChannels, { getMac: 1, notice: 2 });
});
