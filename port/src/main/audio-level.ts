// Follow-audio level, reproducing the vendor pipeline (09 §8):
//   AudioSyncController.GetDftData(minHz=0, maxHz=2500, sqrt=1)
//     mono = mean of channels; N = 2^floor(log2(frames)); NAudio FFT(forward:false) = unscaled DFT;
//     |X[k]| for k in [0, N/2); bins [minHz/binHz, maxHz/binHz) with binHz = floor(sampleRate / N)
//     (integer division); sqrt() applied `sqrt` times per value.
//   AudioSyncUtil.ConvertToSingleData (constants from GlobalData.cs):
//     avg = mean(d); mx = min(max(d), avg*5); mx = min(mx, 50); mx = max(mx, 5);
//     v = (avg + (avg > mx*0.1 ? 0.1*mx : 0)) * 1.5; v = min(v, mx); level = (byte)(v/mx*255)
// Linux input (09 plan C): src/main/audio-monitor.ts records the default sink's monitor at 48 kHz and
// feeds the latest AUDIO_FFT_SIZE mono samples (mean of the channels) here every 40 ms
// (EffectTimerMgr.method_3). At 48 kHz that gives N=2048, binHz=23 and 108 bins, the values the vendor
// got from NAudio's ~2400-frame WASAPI chunks (09 §8.1). Pure module.

export const AUDIO_FFT_SIZE = 2048;
export const AUDIO_INTERVAL_MS = 40;

/** GlobalData.cs defaults. */
export const AUDIO_CONSTANTS = {
  sampleMinHz: 0,
  sampleMaxHz: 2500,
  sampleSqrtCount: 1,
  maxMultipleAverage: 5.0,
  maxPercent: 50.0,
  minPercent: 5.0,
  exceptBarDataMoveUpMin: 0.1,
  exceptBarDataMoveUpMultiple: 0.1,
  exceptBarWaveStrengthMultiple: 1.5,
} as const;

/** In-place iterative radix-2 FFT; `re`/`im` length must be a power of two. No scaling. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** GetDftData on a mono buffer. Returns an empty array for an empty buffer. */
export function dftData(
  mono: ArrayLike<number>,
  sampleRate: number,
  minHz: number = AUDIO_CONSTANTS.sampleMinHz,
  maxHz: number = AUDIO_CONSTANTS.sampleMaxHz,
  sqrtCount: number = AUDIO_CONSTANTS.sampleSqrtCount,
): Float64Array {
  if (mono.length === 0) return new Float64Array(0);
  const n = 2 ** Math.floor(Math.log2(mono.length));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = mono[i];
  fft(re, im);
  const half = n / 2;
  const binHz = Math.floor(sampleRate / n);
  if (binHz <= 0) return new Float64Array(0);
  let start = Math.floor(minHz / binHz);
  let end = Math.floor(maxHz / binHz);
  if (start >= half) start = 0;
  if (end >= half) end = half - 1;
  if (end <= start) return new Float64Array(0);
  const out = new Float64Array(end - start);
  for (let k = start; k < end; k++) {
    let v = Math.hypot(re[k], im[k]);
    for (let s = 0; s < sqrtCount; s++) v = Math.sqrt(v);
    out[k - start] = v;
  }
  return out;
}

/** ConvertToSingleData: spectrum → level 0..255. */
export function levelFromSpectrum(d: ArrayLike<number>): number {
  if (d.length === 0) return 0;
  const c = AUDIO_CONSTANTS;
  let sum = 0;
  let max = -Infinity;
  for (let i = 0; i < d.length; i++) {
    sum += d[i];
    if (d[i] > max) max = d[i];
  }
  const avg = sum / d.length;
  let mx = max;
  if (mx > avg * c.maxMultipleAverage) mx = avg * c.maxMultipleAverage;
  if (mx > c.maxPercent) mx = c.maxPercent;
  if (mx < c.minPercent) mx = c.minPercent;
  let v = (avg + (avg > mx * c.exceptBarDataMoveUpMin ? c.exceptBarDataMoveUpMultiple * mx : 0)) * c.exceptBarWaveStrengthMultiple;
  if (v > mx) v = mx;
  const level = Math.trunc((v / mx) * 255);
  return Number.isFinite(level) ? Math.min(255, Math.max(0, level)) : 0;
}
