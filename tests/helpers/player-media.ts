import assert from "node:assert/strict";
import { MediaDevice, type MediaDeviceElement } from "../../player/media-device.js";
import {
  advancePlayerRuntimeTime,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeMedia,
  reportPlayerRuntimeMediaLoad,
  type PlayerRuntimeSession,
} from "../../player/runtime-adapter.js";
import type { MediaLoadReport } from "../../src/index.js";

// A deterministic stand-in for HTMLAudioElement: tests move `position` to simulate what was actually played.
class FakeElement implements MediaDeviceElement {
  src = "";
  preload = "";
  volume = 1;
  position = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  refuse = false;
  /** When set, `play()` waits for `resolvePlays()`. */
  deferPlays = false;
  readonly pendingPlays: Array<() => void> = [];
  plays = 0;
  readonly listeners = new Map<string, Array<() => void>>();
  get currentTime() {
    return this.position;
  }
  set currentTime(value: number) {
    this.position = value;
    this.ended = false;
    this.emit("seeked");
  }
  play(): Promise<void> {
    this.plays++;
    if (this.refuse) {
      const error = new Error("refused");
      error.name = "NotAllowedError";
      return Promise.reject(error);
    }
    if (this.deferPlays)
      return new Promise((resolve) =>
        this.pendingPlays.push(() => {
          this.paused = false;
          resolve();
        }),
      );
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute() {
    this.src = "";
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  metadata(durationS: number) {
    this.duration = durationS;
    this.emit("loadedmetadata");
  }
  advance(seconds: number) {
    if (!this.paused) this.position += seconds;
  }
}

// The same loop the Player host runs: reconcile after each session change, observe with sampled progress.
export function harness(
  source: string,
  resolve: (path: string) => string | null = (path) => `asset:${path}`,
  { reuse = false }: { readonly reuse?: boolean } = {},
) {
  const elements: FakeElement[] = [];
  const released: FakeElement[] = [];
  const loads: Array<[number, MediaLoadReport]> = [];
  let blocked = false;
  let session: PlayerRuntimeSession = createPlayerRuntimeSession(source);
  let now = 0;
  const device = new MediaDevice({
    createElement: () => {
      const reused = reuse ? released.pop() : undefined;
      if (reused !== undefined) return reused;
      const element = new FakeElement();
      elements.push(element);
      return element;
    },
    releaseElement: (element) => {
      const fake = elements.find((candidate) => candidate === element);
      if (fake !== undefined) released.push(fake);
    },
    resolveSource: resolve,
    reportLoad: (mediaId, report) => {
      loads.push([mediaId, report]);
      const result = reportPlayerRuntimeMediaLoad(session, mediaId, report);
      if (result.outcome.kind === "accepted") publish(result.session);
    },
    requestObservation: () => {},
    blockedChanged: (value) => (blocked = value),
  });
  function publish(next: PlayerRuntimeSession) {
    session = next;
    device.reconcile(playerRuntimeMedia(session.snapshot).media);
  }
  return {
    elements,
    loads,
    device,
    get session() {
      return session;
    },
    get blocked() {
      return blocked;
    },
    start() {
      device.reconcile(playerRuntimeMedia(session.snapshot).media);
    },
    /** Publishes the session returned by a completed Player action. */
    update(next: PlayerRuntimeSession) {
      publish(next);
    },
    replace(next: PlayerRuntimeSession) {
      device.reset();
      // Like the Player's scene clock, continue from the restored observation.
      now = next.snapshot.observedSessionTimeMs;
      publish(next);
    },
    /** Lets `ms` of wall time pass, during which playing elements advance by `played` seconds. */
    tick(ms: number, played = ms / 1000) {
      now += ms;
      for (const element of elements) element.advance(played);
      const result = observePlayerRuntimeTime(session, now, device.sample());
      assert.equal(result.outcome.kind, "observed");
      publish(result.session);
    },
    /** A development time jump to `targetMs`, published as the Player host publishes one. */
    jump(targetMs: number) {
      session = advancePlayerRuntimeTime(session, targetMs);
      now = session.snapshot.observedSessionTimeMs;
      device.jumped(playerRuntimeMedia(session.snapshot).media);
    },
    texts() {
      return session.transcriptEntries.flatMap((entry) =>
        entry.kind === "message" ? [entry.text] : [],
      );
    },
  };
}
