// Screen source selection for follow-video (09 §7.1; ARCHITECTURE "Linux integration").
//
// The vendor captured Screen.PrimaryScreen (09 §7.1). On X11 the primary display's desktopCapturer
// source is picked by display_id; on Wayland the ScreenCast portal returns the single source the user
// chose. The follow-audio source is chosen by parec itself (@DEFAULT_MONITOR@, audio-monitor.ts).
//
// Wayland grant reuse (impl-ambiglow §2.4 "Capture-host request"): every getDisplayMedia used to ask
// desktopCapturer again, i.e. show the portal's ScreenCast dialog on every FollowVideo start (a wake from
// idle, re-selecting FollowVideo, a re-plugged monitor). WebRTC's PipeWire capturer keeps the portal's
// restore token per source id for the life of the process (RestoreTokenManager, persist mode "transient")
// and passes it when a capturer is started for that id again; that is how Chromium avoids a second dialog
// between the picker and the capture. So the source the user granted is answered again on the next
// request, and the portal can restore the session without a dialog. When the portal cannot restore it, it
// shows the dialog as before. A grant is dropped when a start that used it fails and when the stream ends
// (the user stopped sharing from GNOME's indicator), so the next start asks afresh. Persisting across app
// runs (persist_mode 2) is not reachable: Electron exposes neither the persist mode nor the token.

export interface ScreenSourceLike {
  id: string;
  display_id: string;
}

export function pickScreenSource<T extends ScreenSourceLike>(sources: readonly T[], primaryDisplayId: number | string): T | null {
  return sources.find((s) => s.display_id === String(primaryDisplayId)) ?? sources[0] ?? null;
}

/** What a display-media request is answered with (Electron's `{video: {id, name}}`). */
export interface ScreenSourceRef {
  id: string;
  name: string;
}

/** The Wayland screen grant of this run (see the header). */
export class ScreenGrant {
  #granted: ScreenSourceRef | null = null;
  #offered: ScreenSourceRef | null = null;
  #offeredFromGrant = false;

  /** The granted source, if any: answer the request with it instead of asking the portal again. */
  reuse(): ScreenSourceRef | null {
    if (this.#granted) {
      this.#offered = this.#granted;
      this.#offeredFromGrant = true;
    }
    return this.#granted;
  }

  /** The portal picker returned `source` for the current request. */
  picked(source: ScreenSourceRef): void {
    this.#offered = { id: source.id, name: source.name };
    this.#offeredFromGrant = false;
  }

  /** Frames flow for the current request: its source is the grant. */
  started(): void {
    if (this.#offered) this.#granted = this.#offered;
    this.#offered = null;
  }

  /** The current start failed (denied, timed out, no stream): a reused grant is not trusted again. */
  failed(): void {
    if (this.#offeredFromGrant) this.#granted = null;
    this.#offered = null;
    this.#offeredFromGrant = false;
  }

  /** The stream was ended by the user or the system: ask again next time. */
  ended(): void {
    this.#granted = null;
  }

  get granted(): ScreenSourceRef | null {
    return this.#granted;
  }
}
