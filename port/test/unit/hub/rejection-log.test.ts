import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REJECTION_LOG_DEFAULTS, RejectionLog } from '../../../src/backend/hub/rejection-log.ts';
import { captureLogger } from '../rpc/helpers.ts';

test('RejectionLog: the first rejections of a kind per window are logged, the rest summarized when the window ends', () => {
  const { log, lines } = captureLogger();
  const r = new RejectionLog(log, 3, 60_000);
  for (let i = 0; i < 10; i++) r.record('foreign Origin', `origin #${i}`, 1000 + i);
  r.record('missing or wrong token', 'token #0', 1500);
  assert.deepEqual(lines.map((l) => [l.level, l.text]), [
    ['warn', 'origin #0'],
    ['warn', 'origin #1'],
    ['warn', 'origin #2 (further rejections of this kind are summarized)'],
    ['warn', 'token #0'],
  ]);

  r.flush(60_999); // the origin window (opened at 1000) is still open
  assert.equal(lines.length, 4);
  r.flush(61_000);
  assert.deepEqual(lines.at(-1), { level: 'warn', scope: 'test', text: '7 more rejected hub request(s) not logged individually (foreign Origin)' });
  assert.equal(lines.length, 5, 'a window without suppressed rejections ends silently');

  // a new window starts with a fresh burst
  r.record('foreign Origin', 'origin #10', 70_000);
  assert.equal(lines.at(-1)!.text, 'origin #10');
  r.flush(Infinity);
  assert.equal(lines.length, 6);
});

test('RejectionLog: a sustained flood yields at most burst + 1 lines per kind and window', () => {
  const { log, lines } = captureLogger();
  const r = new RejectionLog(log);
  const { burst, windowMs } = REJECTION_LOG_DEFAULTS;
  // 1000 rejections per second for 10 minutes
  for (let ms = 0; ms < 10 * 60_000; ms++) r.record('plain HTTP request', `http ${ms}`, ms);
  r.flush(Infinity);
  const windows = (10 * 60_000) / windowMs;
  assert.equal(lines.length, windows * (burst + 1));
  assert.ok(lines.every((l) => l.level === 'warn'));
});
