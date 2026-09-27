import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_ORIGINS, MIN_TOKEN_LENGTH, generateHubToken, hostAllowed, originAllowed, tokenMatches } from '../../../src/backend/hub/security.ts';

test('generated tokens are 256-bit, URL-safe and unique', () => {
  const tokens = new Set(Array.from({ length: 64 }, generateHubToken));
  assert.equal(tokens.size, 64);
  for (const t of tokens) {
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(t.length >= MIN_TOKEN_LENGTH);
  }
});

test('tokenMatches accepts only the exact token', () => {
  const t = generateHubToken();
  assert.equal(tokenMatches(t, t), true);
  assert.equal(tokenMatches(t, null), false);
  assert.equal(tokenMatches(t, ''), false);
  assert.equal(tokenMatches(t, t.slice(0, -1)), false);
  assert.equal(tokenMatches(t, `${t}x`), false);
  assert.equal(tokenMatches(t, t.toUpperCase() === t ? t.toLowerCase() : t.toUpperCase()), false);
});

test('Origin policy: absent, file:// and null are allowed; any web origin is not', () => {
  assert.deepEqual(ALLOWED_ORIGINS, ['file://', 'null']);
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed('file://'), true);
  assert.equal(originAllowed('null'), true);
  for (const o of ['http://localhost:10010', 'http://127.0.0.1:10010', 'https://evil.example', 'app://.', 'FILE://', 'file:///etc', '', 'file://, file://']) {
    assert.equal(originAllowed(o), false, o);
  }
});

test('Host policy: only the loopback endpoint of the hub', () => {
  assert.equal(hostAllowed('127.0.0.1:10010', 10010), true);
  assert.equal(hostAllowed('LOCALHOST:10010', 10010), true);
  for (const h of [undefined, '', '127.0.0.1', '127.0.0.1:10011', 'evil.example:10010', '[::1]:10010', '0.0.0.0:10010']) {
    assert.equal(hostAllowed(h, 10010), false, String(h));
  }
});

test('Origin policy can be replaced for a custom renderer scheme', () => {
  assert.equal(originAllowed('app://evnia', ['app://evnia']), true);
  assert.equal(originAllowed('file://', ['app://evnia']), false);
  assert.equal(originAllowed(undefined, []), true);
});
