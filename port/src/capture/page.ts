// Script of the hidden capture page (build/app/capture/capture.html), main world.
//
// Video (09 §7, ARCHITECTURE "Screen capture"): X11 → getUserMedia with chromeMediaSource 'desktop' and
// the primary screen's desktopCapturer id; Wayland → getDisplayMedia, answered in main through the
// PipeWire ScreenCast portal. Frames are scaled on an OffscreenCanvas to the 50×40 grid of the vendor's
// CalcRGBs (area-filtered "smooth" mode, 09 plan B) and posted as RGBA.
// Any failure (portal denied, no PipeWire, no source) resolves false.
//
// Sampling: the source runs at the asked rate (protocol.ts frameRateFor: 1000 / intervalMs fps, so 300 ms is a
// frame every 300 ms), and each frame it delivers is sampled as it arrives (MediaStreamTrackProcessor, which
// Chromium exposes to the page), at most about one per interval (minSampleSpacingMs: the ceiling for a source
// that runs faster than asked). A frame reaches main a few ms after the screen was grabbed, so a screen change
// waits at most one source interval. It needs no rendering either, so the hidden window is not a concern.
// Without MediaStreamTrackProcessor the page falls back to a <video> element sampled by a timer every intervalMs.
// That timer runs out of phase with the source, which adds up to one interval of lag and sometimes posts a
// source frame twice. The 'video-started' status names the sampling in use.
//
// Sequencing: at most one stream exists. Every start and stop bumps `generation`; a start that finds
// the generation changed after one of its awaits (getUserMedia/getDisplayMedia, the sampler's start) stops the
// stream it just opened and resolves false, so a stop or a newer start issued while the portal dialog or
// getUserMedia was pending can never leave an orphaned stream, reader or timer behind.
//
// Retune (setVideoInterval, the Follow video speed tiers and their pause): the sampling interval changes at once
// and the source's frame rate follows through track.applyConstraints, within the same stream. The portal stream
// (Wayland) is opened at MAX_FRAME_RATE and then constrained to the asked rate, so a later, faster speed stays
// inside it: re-opening it would show the ScreenCast dialog again. An X11 desktop stream is opened at the
// asked rate; when applyConstraints cannot raise it, it is re-opened with the same source id (no dialog on
// X11) and its sampler swapped in, still in the same session.

import {
  frameRateFor,
  MAX_FRAME_RATE,
  minSampleSpacingMs,
  type CaptureBridge,
  type CapturePageApi,
  type SetVideoIntervalCommand,
  type StartVideoCommand,
} from './protocol.ts';

declare global {
  interface Window {
    evniaCaptureBridge: CaptureBridge;
    evniaCapture: CapturePageApi;
  }
}

/** Chromium's MediaStreamTrackProcessor (not in the DOM typings): the frames of a video track as a stream. */
type TrackProcessorConstructor = new (init: { track: MediaStreamTrack }) => { readonly readable: ReadableStream<VideoFrame> };

const bridge = window.evniaCaptureBridge;
const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const formatFps = (fps: number) => `${Math.round(fps * 10) / 10} fps`;

/** How the page takes frames of one stream. */
interface Sampler {
  /** 'frames': each new source frame as it arrives; 'timer': a <video> element every interval (the fallback). */
  readonly mode: 'frames' | 'timer';
  /** The state's intervalMs changed. */
  retime(): void;
  stop(): void;
}

interface VideoState {
  readonly session: number;
  /** X11 desktopCapturer source id; null for the portal stream. */
  readonly sourceId: string | null;
  readonly width: number;
  readonly height: number;
  readonly ctx: OffscreenCanvasRenderingContext2D;
  stream: MediaStream;
  /** Null only while the start sets it up. */
  sampler: Sampler | null;
  intervalMs: number;
}

let video: VideoState | null = null;
let generation = 0;
/** The interval the current session wants (its start may still be opening); setVideoInterval updates it. */
let wanted: { session: number; intervalMs: number } | null = null;

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

/** Scale `image` to the grid and post it to main, while `state` is the current capture (true: posted). */
function post(state: VideoState, image: CanvasImageSource): boolean {
  if (video !== state) return false;
  state.ctx.drawImage(image, 0, 0, state.width, state.height);
  bridge.frame(state.session, state.ctx.getImageData(0, 0, state.width, state.height).data, state.width, state.height, Date.now());
  return true;
}

/**
 * Each new frame of the stream as it arrives, at most about one per interval (minSampleSpacingMs); every frame is
 * closed at once (the source's buffer pool is small). Null when the page has no MediaStreamTrackProcessor.
 */
function frameSampler(state: VideoState, stream: MediaStream): Sampler | null {
  const Processor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorConstructor }).MediaStreamTrackProcessor;
  const track = stream.getVideoTracks()[0];
  if (typeof Processor !== 'function' || !track) return null;
  let reader: ReadableStreamDefaultReader<VideoFrame>;
  try {
    reader = new Processor({ track }).readable.getReader();
  } catch {
    return null;
  }
  let stopped = false;
  let reported = false;
  let last = -Infinity;
  const report = (detail: string) => {
    if (!reported && !stopped && video === state) bridge.status(state.session, 'video-error', detail);
    reported = true;
  };
  void (async () => {
    for (;;) {
      let next: ReadableStreamReadResult<VideoFrame>;
      try {
        next = await reader.read();
      } catch (e) {
        report(`frame reader: ${describe(e)}`);
        return;
      }
      if (next.done) return; // the track ended: stopped here, or 'ended' (watchEnded)
      const frame = next.value;
      try {
        const now = performance.now();
        if (!stopped && now - last >= minSampleSpacingMs(state.intervalMs) && post(state, frame)) last = now;
      } catch (e) {
        report(`frame sampling: ${describe(e)}`);
      } finally {
        frame.close();
      }
    }
  })();
  return {
    mode: 'frames',
    retime() {}, // the spacing reads state.intervalMs
    stop() {
      stopped = true;
      reader.cancel().catch(() => undefined);
    },
  };
}

/** The fallback: a <video> element playing the stream, sampled by a timer every interval. */
async function timerSampler(state: VideoState, stream: MediaStream): Promise<Sampler> {
  const el = document.createElement('video');
  el.muted = true;
  el.srcObject = stream;
  try {
    await el.play();
  } catch (e) {
    el.srcObject = null;
    throw e;
  }
  const sample = () => {
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) post(state, el);
  };
  let timer = setInterval(sample, state.intervalMs);
  return {
    mode: 'timer',
    retime() {
      clearInterval(timer);
      timer = setInterval(sample, state.intervalMs);
    },
    stop() {
      clearInterval(timer);
      el.srcObject = null;
    },
  };
}

function openSampler(state: VideoState, stream: MediaStream): Promise<Sampler> {
  const frames = frameSampler(state, stream);
  return frames ? Promise.resolve(frames) : timerSampler(state, stream);
}

function describeSampling(sampler: Sampler, intervalMs: number): string {
  return sampler.mode === 'frames'
    ? 'sampling each new source frame'
    : `sampling a <video> element every ${intervalMs} ms (no MediaStreamTrackProcessor)`;
}

function openDesktop(sourceId: string, frameRate: number): Promise<MediaStream> {
  // Chromium's legacy desktop-capture constraints (not in the DOM typings).
  const constraints = {
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: frameRate } },
  } as unknown as MediaStreamConstraints;
  return navigator.mediaDevices.getUserMedia(constraints);
}

function openScreen(cmd: StartVideoCommand, frameRate: number): Promise<MediaStream> {
  if (cmd.sourceId) return openDesktop(cmd.sourceId, frameRate);
  // The portal stream cannot be re-opened without a dialog: open it at the ceiling, constrain it afterwards.
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: MAX_FRAME_RATE } }, audio: false });
}

function releaseVideo(): void {
  if (!video) return;
  video.sampler?.stop();
  stopStream(video.stream);
  video = null;
}

function stopVideo(): void {
  generation++;
  wanted = null;
  releaseVideo();
}

/** 'ended' of the state's current track: the user or the system ended the capture. */
function watchEnded(state: VideoState): void {
  const stream = state.stream;
  for (const track of stream.getVideoTracks()) {
    track.addEventListener('ended', () => {
      if (video !== state || state.stream !== stream) return;
      releaseVideo();
      bridge.status(state.session, 'video-ended', 'capture ended by the system or the user');
    });
  }
}

async function startVideo(cmd: StartVideoCommand): Promise<boolean> {
  const gen = ++generation;
  releaseVideo();
  wanted = { session: cmd.session, intervalMs: cmd.intervalMs };
  const superseded = () => gen !== generation;
  let stream: MediaStream;
  try {
    stream = await openScreen(cmd, frameRateFor(wanted.intervalMs));
  } catch (e) {
    if (!superseded()) bridge.status(cmd.session, 'video-error', describe(e));
    return false;
  }
  if (superseded()) {
    stopStream(stream);
    return false;
  }
  const ctx = new OffscreenCanvas(cmd.width, cmd.height).getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    stopStream(stream);
    bridge.status(cmd.session, 'video-error', 'no 2d context');
    return false;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // A setVideoInterval that arrived while the stream was opening wins over the start's interval.
  const intervalMs = wanted?.session === cmd.session ? wanted.intervalMs : cmd.intervalMs;
  const state: VideoState = { session: cmd.session, sourceId: cmd.sourceId, width: cmd.width, height: cmd.height, ctx, stream, sampler: null, intervalMs };
  let sampler: Sampler;
  try {
    sampler = await openSampler(state, stream);
  } catch (e) {
    stopStream(stream);
    if (!superseded()) bridge.status(cmd.session, 'video-error', describe(e));
    return false;
  }
  if (superseded()) {
    sampler.stop();
    stopStream(stream);
    return false;
  }
  state.sampler = sampler;
  video = state;
  watchEnded(state);
  bridge.status(cmd.session, 'video-started', `${stream.getVideoTracks()[0]?.label ?? ''}; ${describeSampling(sampler, intervalMs)}`);
  // The portal stream was opened at the ceiling, and an interval may have changed during the open.
  if (!cmd.sourceId || intervalMs !== cmd.intervalMs) void retune(state, intervalMs, false);
  return true;
}

async function setVideoInterval(cmd: SetVideoIntervalCommand): Promise<boolean> {
  if (!wanted || wanted.session !== cmd.session) return false;
  wanted.intervalMs = cmd.intervalMs;
  const state = video;
  if (!state || state.session !== cmd.session) return true; // still opening: startVideo takes it
  return retune(state, cmd.intervalMs, true);
}

/** The sampling interval at once, then the source's frame rate; `report` sends a 'video-retuned' status. */
async function retune(state: VideoState, intervalMs: number, report: boolean): Promise<boolean> {
  if (state.intervalMs !== intervalMs) {
    state.intervalMs = intervalMs;
    state.sampler?.retime();
  }
  const fps = frameRateFor(intervalMs);
  const notes: string[] = [];
  const track = state.stream.getVideoTracks()[0];
  if (track) {
    try {
      await track.applyConstraints({ frameRate: { max: fps } });
    } catch (e) {
      notes.push(`applyConstraints: ${describe(e)}`);
    }
    // Stopped meanwhile, or a newer retune took over (it finishes the job).
    if (video !== state || state.intervalMs !== intervalMs) return video === state;
    const actual = state.stream.getVideoTracks()[0]?.getSettings().frameRate;
    if (state.sourceId && typeof actual === 'number' && actual + 0.5 < fps) {
      notes.push(await reopenDesktop(state, fps));
    }
  }
  if (video !== state || state.intervalMs !== intervalMs) return video === state;
  const source = state.stream.getVideoTracks()[0]?.getSettings().frameRate;
  if (report) {
    const rate = typeof source === 'number' ? formatFps(source) : 'unknown';
    bridge.status(state.session, 'video-retuned', `every ${intervalMs} ms, source frame rate ${rate}${notes.length ? ` (${notes.join('; ')})` : ''}`);
  }
  return true;
}

/** X11: the same desktop source again at `fps` (no dialog), its sampler swapped into the running state. */
async function reopenDesktop(state: VideoState, fps: number): Promise<string> {
  let next: MediaStream;
  try {
    next = await openDesktop(state.sourceId!, fps);
  } catch (e) {
    return `re-open at ${formatFps(fps)} failed, kept the stream: ${describe(e)}`;
  }
  if (video !== state) {
    stopStream(next);
    return 'superseded';
  }
  let sampler: Sampler;
  try {
    sampler = await openSampler(state, next);
  } catch (e) {
    stopStream(next);
    return `re-opened stream did not play, kept the old one: ${describe(e)}`;
  }
  if (video !== state) {
    sampler.stop();
    stopStream(next);
    return 'superseded';
  }
  const old = { stream: state.stream, sampler: state.sampler };
  state.stream = next;
  state.sampler = sampler;
  old.sampler?.stop();
  stopStream(old.stream);
  watchEnded(state);
  return `re-opened the desktop source at ${formatFps(fps)}`;
}

window.evniaCapture = { startVideo, stopVideo, setVideoInterval };
