import assert from "node:assert/strict";
import test from "node:test";
import {
  MediaLoadQueue,
  SOURCE_UNAVAILABLE_MESSAGE,
  VIDEO_UNSUPPORTED_MESSAGE,
} from "../player/media-device.js";
import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeDeadlines,
  playerRuntimeMedia,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { observeTime } from "../src/index.js";
import { harness } from "./helpers/player-media.js";

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
  // Scoped to the current Player, which cannot play video yet; replace this row when video playback lands.
  const video = harness('playVideo "videos/intro.mp4"\nsay "after video", instant');
  video.start();
  assert.deepEqual(video.loads, [[1, { kind: "failed", message: VIDEO_UNSUPPORTED_MESSAGE }]]);
  assert.deepEqual(video.texts(), ["after video"]);

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

test("a stall reports unchanged progress, so a nearby cue waits for actual playback", () => {
  const player = harness(
    [
      'let music = playAudio async "music.mp3" {',
      "  at 1 s {",
      '    say "cue", instant',
      "  }",
      "}",
      "wait 30",
    ].join("\n"),
  );
  player.start();
  player.elements[0]!.metadata(10);
  player.tick(900);
  player.tick(5000, 0);
  assert.deepEqual(player.device.sample(), [{ mediaId: 1, segment: 1, progressMs: 900 }]);
  assert.deepEqual(player.texts(), [], "the cue must not run during the stall");
  player.tick(200);
  assert.deepEqual(player.texts(), ["cue"]);
});

test("an element error after loading stalls progress instead of inventing playback or a second load report", () => {
  const player = harness('let music = playAudio async "music.mp3"\nwait 30');
  player.start();
  const [element] = player.elements;
  element!.metadata(10);
  player.tick(500);
  element!.emit("error");
  assert.equal(element!.paused, true);
  // Later updates must not resume the broken element.
  player.tick(2000);
  player.tick(1000);
  assert.deepEqual(player.device.sample(), [{ mediaId: 1, segment: 1, progressMs: 500 }]);
  assert.equal(player.loads.length, 1);
});

test("a media error clears the refused-playback state it can no longer retry", async () => {
  const player = harness('let music = playAudio async "music.mp3"\nwait 30');
  player.start();
  const [element] = player.elements;
  element!.refuse = true;
  element!.metadata(10);
  await settle();
  assert.equal(player.blocked, true);
  element!.emit("error");
  assert.equal(player.blocked, false);
});

test("a retry never plays audio the script has paused", async () => {
  const player = harness(
    'let music = playAudio async "music.mp3"\nwait 0.1\nmusic.pause()\nwait 10',
  );
  player.start();
  const [element] = player.elements;
  element!.refuse = true;
  element!.metadata(10);
  await settle();
  assert.equal(player.blocked, true);
  player.tick(200, 0);
  assert.equal(playerRuntimeMedia(player.session.snapshot).media[0]?.state, "paused");
  assert.equal(player.blocked, false, "paused media is not refused playback");
  element!.refuse = false;
  const plays = element!.plays;
  player.device.retryBlocked();
  await settle();
  assert.equal(element!.plays, plays, "a retry must not even briefly start paused media");
  assert.equal(element!.paused, true);
});

test("the load queue keeps a report the runtime cannot take yet and offers it again", async () => {
  const offered: number[] = [];
  let accept = false;
  let observations = 0;
  const queue = new MediaLoadQueue(
    () => observations++,
    (mediaId) => {
      offered.push(mediaId);
      return accept ? "delivered" : "pending";
    },
  );
  queue.add(7, { kind: "loaded", durationMs: 1000 });
  await settle();
  assert.deepEqual([observations, offered, queue.size], [1, [7], 1]);
  accept = true;
  queue.retry();
  assert.deepEqual([offered, queue.size], [[7, 7], 0]);
});

// The Player host loop around MediaLoadQueue: observe current time, then deliver; keep pending reports queued.
function queued(initial: PlayerRuntimeSession) {
  let session = initial;
  let now = session.snapshot.observedSessionTimeMs;
  const queue = new MediaLoadQueue(
    () => {
      const result = observePlayerRuntimeTime(session, now);
      if (result.outcome.kind === "observed") session = result.session;
    },
    (mediaId, report) => {
      const result = reportPlayerRuntimeMediaLoad(session, mediaId, report);
      if (result.outcome.kind === "executionPending") return "pending";
      if (result.outcome.kind === "accepted") session = result.session;
      return "delivered";
    },
  );
  return {
    queue,
    get session() {
      return session;
    },
    at(ms: number) {
      now = ms;
    },
  };
}

test("a load report applies at the current scene time, not the last observation", async () => {
  const host = queued(
    createPlayerRuntimeSession('playAudio async "bell.mp3"\nwait 50 ms\nsay "after", instant'),
  );
  host.at(75);
  host.queue.add(1, { kind: "loaded", durationMs: 1000 });
  await settle();
  assert.equal(host.queue.size, 0);
  assert.ok(
    playerRuntimeDeadlines(host.session.snapshot).includes(125),
    "the wait starts when loading was reported",
  );
});

test("an execution-pending load report is delivered after the engine ran queued work", async () => {
  const source =
    'timer async 1 s {\n  say "timer", instant\n}\nplayVideo "intro.mp4"\nsay "after", instant';
  const started = createPlayerRuntimeSession(source);
  // A canonical checkpoint whose timer expiry is queued but has not run yet.
  const observed = observeTime(started.plan, started.snapshot, 2000);
  const checkpointed = { ...started, snapshot: observed.snapshot };
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(checkpointed));
  assert.equal(
    reportPlayerRuntimeMediaLoad(restored, 1, {
      kind: "failed",
      message: VIDEO_UNSUPPORTED_MESSAGE,
    }).outcome.kind,
    "executionPending",
  );
  const host = queued(restored);
  host.at(2000);
  host.queue.add(1, { kind: "failed", message: VIDEO_UNSUPPORTED_MESSAGE });
  await settle();
  assert.equal(host.queue.size, 0);
  const texts = host.session.transcriptEntries.flatMap((entry) =>
    entry.kind === "message" ? [entry.text] : [],
  );
  assert.deepEqual(texts, ["timer", "after"]);
});
