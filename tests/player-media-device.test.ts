import assert from "node:assert/strict";
import test from "node:test";
import {
  MediaDevice,
  SOURCE_UNAVAILABLE_MESSAGE,
  VIDEO_UNSUPPORTED_MESSAGE,
  type MediaDeviceElement,
} from "../player/media-device.js";
import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeMedia,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import type { MediaLoadReport } from "../src/index.js";

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

// The same loop the Phase 2C host runs: reconcile after each session change, observe with sampled progress.
function harness(
  source: string,
  resolve: (path: string) => string | null = (path) => `asset:${path}`,
) {
  const elements: FakeElement[] = [];
  const loads: Array<[number, MediaLoadReport]> = [];
  let blocked = false;
  let session: PlayerRuntimeSession = createPlayerRuntimeSession(source);
  let now = 0;
  const device = new MediaDevice({
    createElement: () => {
      const element = new FakeElement();
      elements.push(element);
      return element;
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
    texts() {
      return session.transcriptEntries.flatMap((entry) =>
        entry.kind === "message" ? [entry.text] : [],
      );
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("device loads resolved audio once, plays it, and completes blocking playback from measured progress", async () => {
  const player = harness('playAudio "sounds/bell.mp3"\nsay "after", instant');
  player.start();
  const [element] = player.elements;
  assert.equal(element?.src, "asset:sounds/bell.mp3");
  assert.equal(element?.preload, "auto");
  element!.metadata(2);
  assert.deepEqual(player.loads, [[1, { kind: "loaded", durationMs: 2000 }]]);
  assert.equal(element!.paused, false);
  player.tick(1000);
  assert.deepEqual(player.texts(), []);
  // A stall: wall time passes without playback, so blocking playback does not finish early.
  player.tick(5000, 0);
  assert.deepEqual(player.texts(), []);
  player.tick(1000);
  assert.deepEqual(player.texts(), ["after"]);
  assert.equal(element!.src, "", "a settled instance releases its element");
  element!.metadata(2);
  assert.equal(player.loads.length, 1, "no second load report");
  await settle();
});

test("video and unavailable sources are reported as failed so the script continues", () => {
  const video = harness('playVideo "videos/intro.mp4"\nsay "after video", instant');
  video.start();
  assert.deepEqual(video.loads, [[1, { kind: "failed", message: VIDEO_UNSUPPORTED_MESSAGE }]]);
  assert.deepEqual(video.texts(), ["after video"]);
  assert.equal(video.elements.length, 0);

  const missing = harness(
    'playAudio "https://example.com/a.mp3"\nsay "after", instant',
    () => null,
  );
  missing.start();
  assert.deepEqual(missing.loads, [[1, { kind: "failed", message: SOURCE_UNAVAILABLE_MESSAGE }]]);
  assert.deepEqual(missing.texts(), ["after"]);
});

test("device repeats the requested range and stops audible output at the projected end", () => {
  const player = harness(
    'playAudio(file: "music.mp3", startAt: 1 s, endAt: 2 s, repeat: 3 times, volume: 0.5)\nsay "done", instant',
  );
  player.start();
  const [element] = player.elements;
  element!.metadata(10);
  assert.equal(element!.position, 1, "positioned at the range start");
  assert.equal(element!.volume, 0.5);
  player.tick(1100);
  assert.equal(element!.position, 1, "wrapped from the range end back to its start");
  player.tick(1000);
  player.tick(1000);
  assert.deepEqual(player.texts(), ["done"]);
  assert.equal(element!.paused, true);
});

test("pause, resume and a cue seek reposition the element for each new segment", () => {
  const player = harness(
    [
      'let music = playAudio async "music.mp3" {',
      "  at 1 s {",
      "    music.position = 5 s",
      "  }",
      "}",
      "wait 3",
      "music.pause()",
      "wait 1",
      "music.resume()",
      "wait 10",
    ].join("\n"),
  );
  player.start();
  const [element] = player.elements;
  element!.metadata(20);
  player.tick(1200);
  assert.equal(element!.position, 5, "the cue's seek starts a segment at the projected playhead");
  player.tick(2000);
  assert.equal(element!.paused, true, "paused media is silent");
  const pausedAt = element!.position;
  player.tick(1000);
  assert.equal(element!.paused, false, "resumed");
  assert.ok(Math.abs(element!.position - pausedAt) < 0.25, "resumed from the paused playhead");
});

test("refused playback reports no progress until a deliberate retry succeeds", async () => {
  const player = harness('playAudio "bell.mp3"\nsay "after", instant');
  player.start();
  const [element] = player.elements;
  element!.refuse = true;
  element!.metadata(1);
  await settle();
  assert.equal(player.blocked, true);
  player.tick(3000, 0);
  assert.deepEqual(player.texts(), [], "blocked audio is never reported as played");
  element!.refuse = false;
  player.device.retryBlocked();
  await settle();
  assert.equal(player.blocked, false);
  player.tick(1000);
  assert.deepEqual(player.texts(), ["after"]);
});

test("restore reconnects a fresh element at the saved playhead without reloading or repeating cues", () => {
  const source = [
    'let music = playAudio async "music.mp3" {',
    "  at 1 s {",
    '    say "cue", instant',
    "  }",
    "}",
    "wait 10",
    'say "done", instant',
  ].join("\n");
  const original = harness(source);
  original.start();
  original.elements[0]!.metadata(4);
  original.tick(1500);
  assert.deepEqual(original.texts(), ["cue"]);
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(original.session));

  const player = harness(source);
  player.replace(restored);
  const [element] = player.elements;
  assert.equal(element?.src, "asset:music.mp3");
  element!.metadata(4);
  assert.deepEqual(player.loads, [], "restored media is already loaded");
  assert.equal(element!.position, 1.5, "positioned at the restored playhead");
  assert.equal(element!.paused, false);
  // Progress continues from the saved value, so the runtime's playhead advances by what was played since.
  player.tick(1000);
  assert.equal(playerRuntimeMedia(player.session.snapshot).media[0]?.playheadMs, 2500);
  player.tick(10_000, 1.5);
  assert.deepEqual(player.texts(), ["cue", "done"], "the cue ran once across restore");
});
