// Script of the hidden capture page (build/app/capture/capture.html), main world.
//
// Video (09 §7, ARCHITECTURE "Screen capture"): X11 → getUserMedia with chromeMediaSource 'desktop' and
// the primary screen's desktopCapturer id; Wayland → getDisplayMedia, answered in main through the
// PipeWire ScreenCast portal. Frames are scaled on an OffscreenCanvas to the 50×40 grid of the vendor's
// CalcRGBs (area-filtered "smooth" mode, 09 plan B) and posted as RGBA every `intervalMs`.
// Any failure (portal denied, no PipeWire, no source) resolves false.
//
// Sequencing: at most one stream exists. Every start and stop bumps `generation`; a start that finds
// the generation changed after one of its awaits (getUserMedia/getDisplayMedia, play) stops the stream
// it just opened and resolves false, so a stop or a newer start issued while the portal dialog or
// getUserMedia was pending can never leave an orphaned stream or timer behind.

import type { CaptureBridge, CapturePageApi, StartVideoCommand } from './protocol.ts';

declare global {
  interface Window {
    evniaCaptureBridge: CaptureBridge;
    evniaCapture: CapturePageApi;
  }
}

const bridge = window.evniaCaptureBridge;
const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

interface VideoState {
  stream: MediaStream;
  video: HTMLVideoElement;
  timer: ReturnType<typeof setInterval>;
}

let video: VideoState | null = null;
let generation = 0;

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

async function openScreen(cmd: StartVideoCommand): Promise<MediaStream> {
  const frameRate = Math.max(1, Math.min(30, Math.round(1000 / cmd.intervalMs)));
  if (cmd.sourceId) {
    // Chromium's legacy desktop-capture constraints (not in the DOM typings).
    const constraints = {
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: cmd.sourceId, maxFrameRate: frameRate } },
    } as unknown as MediaStreamConstraints;
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: frameRate } }, audio: false });
}

function releaseVideo(): void {
  if (!video) return;
  clearInterval(video.timer);
  stopStream(video.stream);
  video.video.srcObject = null;
  video = null;
}

function stopVideo(): void {
  generation++;
  releaseVideo();
}

async function startVideo(cmd: StartVideoCommand): Promise<boolean> {
  const gen = ++generation;
  releaseVideo();
  const superseded = () => gen !== generation;
  let stream: MediaStream;
  try {
    stream = await openScreen(cmd);
  } catch (e) {
    if (!superseded()) bridge.status(cmd.session, 'video-error', describe(e));
    return false;
  }
  if (superseded()) {
    stopStream(stream);
    return false;
  }
  const el = document.createElement('video');
  el.muted = true;
  el.srcObject = stream;
  try {
    await el.play();
  } catch (e) {
    stopStream(stream);
    if (!superseded()) bridge.status(cmd.session, 'video-error', describe(e));
    return false;
  }
  if (superseded()) {
    stopStream(stream);
    el.srcObject = null;
    return false;
  }
  const canvas = new OffscreenCanvas(cmd.width, cmd.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    stopStream(stream);
    bridge.status(cmd.session, 'video-error', 'no 2d context');
    return false;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const timer = setInterval(() => {
    if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    ctx.drawImage(el, 0, 0, cmd.width, cmd.height);
    bridge.frame(cmd.session, ctx.getImageData(0, 0, cmd.width, cmd.height).data, cmd.width, cmd.height, Date.now());
  }, cmd.intervalMs);
  const state: VideoState = { stream, video: el, timer };
  video = state;
  for (const track of stream.getVideoTracks()) {
    track.addEventListener('ended', () => {
      if (video !== state) return;
      releaseVideo();
      bridge.status(cmd.session, 'video-ended', 'capture ended by the system or the user');
    });
  }
  bridge.status(cmd.session, 'video-started', stream.getVideoTracks()[0]?.label ?? '');
  return true;
}

window.evniaCapture = { startVideo, stopVideo };
