// Follow-audio DSP (src/main/audio-level.ts) against the vendor algorithm (09 §8).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dftData, fft, levelFromSpectrum } from '../../../src/main/audio-level.ts';

/** AudioSyncUtil.ConvertToSingleData, transcribed from the decompiled C# (AudioSyncUtil.cs:48-75). */
function vendorLevel(data: number[]): number {
  if (data.length === 0) return 0;
  const num = data.reduce((a, b) => a + b, 0) / data.length;
  let num2 = Math.max(...data);
  if (num2 > num * 5.0) num2 = num * 5.0;
  if (num2 > 50.0) num2 = 50.0;
  if (num2 < 5.0) num2 = 5.0;
  let num3 = (num + (num > num2 * 0.1 ? 0.1 * num2 : 0.0)) * 1.5;
  if (num3 > num2) num3 = num2;
  num3 = (num3 / num2) * 255.0;
  return Math.trunc(num3) & 0xff;
}

function naiveDft(x: number[]): number[] {
  const n = x.length;
  return x.map((_, k) => {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      re += x[t] * Math.cos((2 * Math.PI * k * t) / n);
      im -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
    }
    return Math.hypot(re, im);
  });
}

test('radix-2 FFT equals the unscaled DFT', () => {
  const x = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) / 10);
  const re = Float64Array.from(x);
  const im = new Float64Array(64);
  fft(re, im);
  const expected = naiveDft(x);
  for (let k = 0; k < 64; k++) assert.ok(Math.abs(Math.hypot(re[k], im[k]) - expected[k]) < 1e-9, `bin ${k}`);
});

test('GetDftData: 0-2500 Hz with integer bin width, sqrt applied once', () => {
  const sr = 48000;
  const n = 2048;
  const tone = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / sr));
  const d = dftData(tone, sr);
  assert.equal(d.length, Math.floor(2500 / Math.floor(sr / n)), 'binHz = 23 → 108 bins');
  const peak = d.indexOf(Math.max(...d));
  assert.equal(peak, Math.round((1000 * n) / sr));
  assert.ok(Math.abs(d[peak] - Math.sqrt(n / 2)) < 3, 'sqrt(|X|) of a unit sine ≈ sqrt(N/2)');
  assert.equal(dftData(new Float32Array(0), sr).length, 0);
  assert.equal(dftData(new Float32Array(3000), sr).length, Math.floor(2500 / Math.floor(sr / 2048)), 'truncates to 2^floor(log2 n)');
});

test('level heuristic matches the vendor C# on edge cases and random spectra', () => {
  assert.equal(levelFromSpectrum([]), 0);
  assert.equal(levelFromSpectrum([0, 0, 0]), 0);
  assert.equal(levelFromSpectrum([10, 10, 10, 10]), 255);
  assert.equal(levelFromSpectrum([1, 1, 1, 1]), 114);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 500; i++) {
    const scale = [0.1, 1, 5, 20, 80][i % 5];
    const d = Array.from({ length: 108 }, () => rnd() * scale);
    assert.equal(levelFromSpectrum(d), vendorLevel(d), `case ${i}`);
  }
});

test('silence gives level 0 and a loud broadband signal saturates', () => {
  const sr = 48000;
  assert.equal(levelFromSpectrum(dftData(new Float32Array(2048), sr)), 0);
  let seed = 1;
  const noise = Float32Array.from({ length: 2048 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1);
  assert.ok(levelFromSpectrum(dftData(noise, sr)) > 200);
});
