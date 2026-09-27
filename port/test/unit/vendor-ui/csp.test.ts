import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCspPolicies, rewriteCsp } from '../../../scripts/lib/csp.ts';
import { ImportError } from '../../../scripts/lib/patch-engine.ts';

const POLICY = "default-src 'self'; connect-src 'self' ws://127.0.0.1:*";

test('an existing vendor CSP meta is replaced in place', () => {
  const html =
    '<!doctype html><html><head><meta charset="UTF-8"/><title>t</title>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' https://*.zeasn.tv; script-src \'self\' https://*.jsdelivr.net"/>' +
    '<script type="module" src="./a.js"></script></head><body></body></html>';
  const out = rewriteCsp('index.html', html, POLICY);
  assert.equal(out.action, 'replaced');
  assert.deepEqual(readCspPolicies(out.html), [POLICY]);
  assert.ok(!out.html.includes('zeasn'));
  assert.ok(out.html.indexOf('Content-Security-Policy') < out.html.indexOf('<script'));
});

test('a page without a CSP (vendor notice.html) gets one right after <meta charset>', () => {
  const html = '<!doctype html><html><head><meta charset="UTF-8"/><title>t</title><style>a{}</style><script src="x.js"></script></head></html>';
  const out = rewriteCsp('notice/notice.html', html, POLICY);
  assert.equal(out.action, 'inserted');
  assert.ok(out.html.startsWith(`<!doctype html><html><head><meta charset="UTF-8"/><meta http-equiv="Content-Security-Policy" content="${POLICY}"/><title>`));
  assert.deepEqual(readCspPolicies(out.html), [POLICY]);
});

test('falls back to <head> when there is no charset declaration', () => {
  const out = rewriteCsp('x.html', '<html><head lang="en"><title>t</title></head></html>', POLICY);
  assert.ok(out.html.startsWith(`<html><head lang="en"><meta http-equiv="Content-Security-Policy"`));
});

test('ambiguous or unusable pages abort the import', () => {
  const two =
    '<head><meta http-equiv="Content-Security-Policy" content="a"><meta http-equiv="content-security-policy" content="b"></head>';
  assert.throws(() => rewriteCsp('two.html', two, POLICY), (e: unknown) => e instanceof ImportError && e.code === 'CSP_AMBIGUOUS');
  assert.throws(() => rewriteCsp('none.html', '<body></body>', POLICY), (e: unknown) => e instanceof ImportError && e.code === 'CSP_NO_HEAD');
  assert.throws(() => rewriteCsp('q.html', '<head></head>', 'default-src "x"'), (e: unknown) => e instanceof ImportError && e.code === 'CSP_INVALID');
});
