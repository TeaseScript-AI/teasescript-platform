import assert from "node:assert/strict";
import test from "node:test";
import {
  MediaLoadQueue,
  SOURCE_UNAVAILABLE_MESSAGE,
  VIDEO_UNSUPPORTED_MESSAGE,
} from "../../player/media/media-device.js";
import {
  createPlayerRuntimeRestorePoint,
  observePlayerRuntimeTime,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSession,
  restorePlayerRuntimeSessionAt,
  type PlayerRuntimeSession,
  playerRuntimeSnapshot,
} from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import { playerRuntimeDeadlines, playerRuntimeMedia } from "../../player/runtime/runtime-view.js";
import { observeTime, type MediaLoadReport } from "../../src/index.js";
import { harness } from "../helpers/player/player-media.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("device loads resolved audio once, plays it, and completes blocking playback from measured progress", async () => {
  const player = harness('playAudio "sounds/bell.mp3"\nsay "after", instant\nexit');
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
  const video = harness('playVideo "videos/intro.mp4"\nsay "after video", instant\nexit');
  video.start();
  assert.deepEqual(video.loads, [[1, { kind: "failed", message: VIDEO_UNSUPPORTED_MESSAGE }]]);
  assert.deepEqual(video.texts(), ["after video"]);

  const missing = harness(
    'playAudio "https://example.com/a.mp3"\nsay "after", instant\nexit',
    () => null,
  );
  missing.start();
  assert.deepEqual(missing.loads, [[1, { kind: "failed", message: SOURCE_UNAVAILABLE_MESSAGE }]]);
  assert.deepEqual(missing.texts(), ["after"]);
});

test("device repeats the requested range and stops audible output at the projected end", () => {
  const player = harness(
    'playAudio(file: "music.mp3", startAt: 1 s, endAt: 2 s, repeat: 3 times, volume: 0.5)\nsay "done", instant\nexit',
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
      "wait 3 s",
      "music.pause()",
      "wait 1 s",
      "music.resume()",
      "wait 10 s",
      "exit",
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
  const player = harness('playAudio "bell.mp3"\nsay "after", instant\nexit');
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
    "wait 10 s",
    'say "done", instant',
    "exit",
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
  assert.equal(playerRuntimeMedia(player.session.state).media[0]?.playheadMs, 2500);
  player.tick(10_000, 1.5);
  assert.deepEqual(player.texts(), ["cue", "done"], "the cue ran once across restore");
});

test("overlapping instances of one file each play out once, also when a seek completes after playback began", () => {
  const player = harness(
    [
      'playAudio async "swat.wav"',
      "wait 400 ms",
      'playAudio async "swat.wav"',
      "wait 2 s",
      'say "after", instant',
      "exit",
    ].join("\n"),
  );
  player.start();
  const [first] = player.elements;
  first!.deferSeeked = true;
  first!.metadata(0.7);
  // The browser reports the seek done only after the element already played on from its target.
  first!.advance(0.1);
  first!.completeSeek();
  player.tick(100, 0);
  player.tick(300);
  const second = player.elements[1]!;
  assert.notEqual(second, first, "each instance has its own element");
  second.metadata(0.7);
  player.tick(200);
  assert.equal(first!.paused, false, "the second instance does not stop the first");
  assert.equal(second.paused, false);
  player.tick(200);
  // The first instance reached its end: it releases its element instead of replaying as another pass.
  assert.equal(first!.src, "");
  assert.equal(first!.plays, 1);
  assert.equal(second.paused, false);
  player.tick(2000);
  assert.deepEqual(player.texts(), ["after"]);
  assert.equal(second.plays, 1);
  assert.equal(second.src, "");
});

test("measured progress that ends a rounding error short of the projected end does not replay the range", () => {
  const player = harness('playAudio "tone.wav"\nsay "after", instant\nexit');
  player.start();
  const [element] = player.elements;
  element!.metadata(1);
  // Browser-like positions whose summed steps reach the end as 999.9999999999999 ms.
  for (const played of [0.042796, 0.067988, 0.07439, 0.066488, 0.071681]) player.tick(100, played);
  player.tick(700);
  assert.deepEqual(player.texts(), ["after"]);
  assert.equal(
    element!.src,
    "",
    "the ended instance released its element instead of starting another pass",
  );
});

test("refused playback within the end tolerance of a short range still waits for a retry", async () => {
  const player = harness(
    'playAudio(file: "tone.wav", repeat: 1 ms) {\n  finish {\n    say "finish", instant\n  }\n}\nsay "after", instant\nexit',
  );
  player.start();
  const [element] = player.elements;
  element!.refuse = true;
  element!.metadata(1);
  await settle();
  player.tick(100, 0);
  assert.deepEqual(player.texts(), [], "unplayed audio must not complete");
  assert.equal(player.blocked, true);
  element!.refuse = false;
  player.device.retryBlocked();
  await settle();
  player.tick(100);
  assert.deepEqual(player.texts(), ["finish", "after"]);
});

test("a stall reports unchanged progress, so a nearby cue waits for actual playback", () => {
  const player = harness(
    [
      'let music = playAudio async "music.mp3" {',
      "  at 1 s {",
      '    say "cue", instant',
      "  }",
      "}",
      "wait 30 s",
      "exit",
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

test("an element error after loading reports one playback failure, invents no progress, and ends a blocking play (#2113)", () => {
  const player = harness('playAudio "music.mp3"\nsay "after"\nexit');
  player.start();
  const [element] = player.elements;
  element!.metadata(10);
  player.tick(500);
  assert.deepEqual(player.device.sample(), [{ mediaId: 1, segment: 1, progressMs: 500 }]);
  element!.emit("error");
  element!.emit("ended");
  element!.emit("error");
  assert.equal(element!.paused, true);
  assert.deepEqual(
    player.loads.map(([, report]) => report),
    [
      { kind: "loaded", durationMs: 10_000 },
      { kind: "failed", message: "The Player could not play this media source." },
    ],
  );
  assert.deepEqual(player.phases, ["load", "playback"]);
  // The runtime stopped the media: reconciliation released it, and the script went on.
  assert.deepEqual(player.device.sample(), []);
  assert.deepEqual(player.texts(), ["after"]);
});

test("restored media that was loaded already reports an element error as a playback failure, once", () => {
  const source = 'playAudio "music.mp3"\nsay "after"\nexit';
  const original = harness(source);
  original.start();
  original.elements[0]!.metadata(10);
  original.tick(1000);
  const player = harness(source);
  player.replace(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(original.session)));
  const [element] = player.elements;
  element!.metadata(10);
  assert.equal(player.loads.length, 0, "restored media is already loaded");
  element!.emit("error");
  element!.emit("error");
  assert.deepEqual(
    player.loads.map(([, report]) => report),
    [{ kind: "failed", message: "The Player could not play this media source." }],
  );
  assert.deepEqual(player.phases, ["playback"]);
  assert.deepEqual(player.texts(), ["after"]);
});

test("an element error between the loaded report and its publication is still reported, once", () => {
  const player = harness('playAudio "music.mp3"\nsay "after"\nexit');
  player.start();
  const [element] = player.elements;
  // The loaded report is sent, but the error comes before its publication reaches the device.
  const { device } = player;
  const reconcile = device.reconcile.bind(device);
  const deferred: Array<Parameters<typeof reconcile>[0]> = [];
  device.reconcile = (media) => void deferred.push(media);
  element!.metadata(10);
  // Twice, before either publication: the device's own flag keeps it to one report.
  element!.emit("error");
  element!.emit("error");
  device.reconcile = reconcile;
  for (const media of deferred) reconcile(media);
  assert.deepEqual(
    player.loads.map(([, report]) => report.kind),
    ["loaded", "failed"],
  );
  assert.deepEqual(player.texts(), ["after"]);
});

test("a media error clears the refused-playback state it can no longer retry", async () => {
  const player = harness('let music = playAudio async "music.mp3"\nwait 30 s\nexit');
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
    'let music = playAudio async "music.mp3"\nwait 0.1 s\nmusic.pause()\nwait 10 s\nexit',
  );
  player.start();
  const [element] = player.elements;
  element!.refuse = true;
  element!.metadata(10);
  await settle();
  assert.equal(player.blocked, true);
  player.tick(200, 0);
  assert.equal(playerRuntimeMedia(player.session.state).media[0]?.state, "paused");
  assert.equal(player.blocked, false, "paused media is not refused playback");
  element!.refuse = false;
  const plays = element!.plays;
  player.device.retryBlocked();
  await settle();
  assert.equal(element!.plays, plays, "a retry must not even briefly start paused media");
  assert.equal(element!.paused, true);
});

/** A queue whose deliveries the test answers one by one: each records what it was offered and waits for `finish`. */
function gatedQueue() {
  const deliveries: {
    readonly reports: readonly (readonly [number, MediaLoadReport])[];
    readonly observe: boolean;
    readonly acknowledge: (mediaId: number) => void;
    readonly finish: (error?: Error) => void;
  }[] = [];
  let changes = 0;
  const failures: unknown[] = [];
  const queue = new MediaLoadQueue(
    (reports, observe, acknowledge) =>
      new Promise<void>((resolve, reject) =>
        deliveries.push({
          reports,
          observe,
          acknowledge,
          finish: (error) => (error === undefined ? resolve() : reject(error)),
        }),
      ),
    () => changes++,
    (error) => failures.push(error),
  );
  return { queue, deliveries, changes: () => changes, failures };
}
const LOADED = { kind: "loaded", durationMs: 1000 } as const;
const FAILED = { kind: "failed", message: "no" } as const;

test("the load queue offers new reports in order after an observation, and keeps what was not acknowledged", async () => {
  const { queue, deliveries, changes } = gatedQueue();
  queue.add(7, LOADED);
  queue.add(3, FAILED);
  await settle();
  assert.equal(deliveries.length, 1, "one delivery for the reports of one task");
  assert.deepEqual(
    deliveries[0]!.reports.map(([mediaId]) => mediaId),
    [7, 3],
  );
  assert.equal(deliveries[0]!.observe, true);
  // 7 cannot be taken yet (`executionPending`); 3 is.
  deliveries[0]!.acknowledge(3);
  deliveries[0]!.finish();
  await settle();
  assert.deepEqual([queue.size, changes()], [1, 1]);
  // A retry, after the session changed, offers 7 again without observing; a delivery's end requests nothing more.
  queue.retry();
  await settle();
  assert.equal(deliveries.length, 2);
  assert.deepEqual([deliveries[1]!.reports, deliveries[1]!.observe], [[[7, LOADED]], false]);
  deliveries[1]!.acknowledge(7);
  deliveries[1]!.finish();
  await settle();
  assert.deepEqual([queue.size, deliveries.length], [0, 2]);
});

test("the load queue runs one delivery at a time and coalesces requests made meanwhile", async () => {
  const { queue, deliveries } = gatedQueue();
  queue.add(1, LOADED);
  await settle();
  // While the first delivery runs: a newer report for 1, a report for 2, and two retries.
  queue.add(1, FAILED);
  queue.add(2, LOADED);
  queue.retry();
  queue.retry();
  await settle();
  assert.equal(deliveries.length, 1);
  // Acknowledging the report it offered keeps the newer one for the same medium.
  deliveries[0]!.acknowledge(1);
  deliveries[0]!.finish();
  await settle();
  assert.equal(deliveries.length, 2, "one more delivery for everything requested meanwhile");
  assert.deepEqual(deliveries[1]!.reports, [
    [1, FAILED],
    [2, LOADED],
  ]);
  assert.equal(deliveries[1]!.observe, true, "new reports arrived, so it observes");
});

test("a report added as a delivery ends is offered only after an observation, also by the delivery that follows", async () => {
  const { queue, deliveries } = gatedQueue();
  queue.add(1, LOADED);
  queue.add(3, LOADED);
  await settle();
  deliveries[0]!.acknowledge(1);
  // A retry while 3 waits; then, as the delivery ends, a new report, whose own request comes only after a microtask.
  queue.retry();
  deliveries[0]!.finish();
  queue.add(2, LOADED);
  await settle();
  assert.deepEqual(
    deliveries[1]!.reports.map(([mediaId]) => mediaId),
    [3, 2],
  );
  assert.equal(deliveries[1]!.observe, true, "2 is new, so the delivery observes first");
});

test("a cleared load queue keeps nothing a delivery under way acknowledges after the clear", async () => {
  const { queue, deliveries } = gatedQueue();
  queue.add(1, LOADED);
  await settle();
  queue.clear();
  queue.add(1, LOADED);
  deliveries[0]!.acknowledge(1);
  deliveries[0]!.finish();
  await settle();
  // The report added after the clear is another one, still queued and offered next.
  assert.equal(queue.size, 1);
  assert.equal(deliveries.length, 2);
});

test("a delivery that ends with an error keeps the acknowledgements it made", async () => {
  const { queue, deliveries, failures } = gatedQueue();
  queue.add(1, LOADED);
  queue.add(2, LOADED);
  await settle();
  deliveries[0]!.acknowledge(1);
  deliveries[0]!.finish(new Error("refused"));
  await settle();
  assert.equal(queue.size, 1, "1 stays acknowledged, 2 waits");
  assert.equal(failures.length, 1, "the error is not lost");
  queue.retry();
  await settle();
  assert.deepEqual(deliveries[1]!.reports, [[2, LOADED]]);
});

// The Player host loop around MediaLoadQueue: observe current time, then deliver; keep pending reports queued.
function queued(initial: PlayerRuntimeSession) {
  let session = initial;
  let now = session.state.observedSessionTimeMs;
  const queue = new MediaLoadQueue(async (reports, observe, acknowledge) => {
    if (observe) {
      const result = observePlayerRuntimeTime(session, now);
      if (result.outcome.kind === "observed") session = result.session;
    }
    for (const [mediaId, report] of reports) {
      const result = reportPlayerRuntimeMediaLoad(session, mediaId, report);
      if (result.outcome.kind === "executionPending") continue;
      if (result.outcome.kind === "accepted") session = result.session;
      acknowledge(mediaId);
    }
  });
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
    createPlayerRuntimeSession(
      'playAudio async "bell.mp3"\nwait 50 ms\nsay "after", instant\nexit',
    ),
  );
  host.at(75);
  host.queue.add(1, { kind: "loaded", durationMs: 1000 });
  await settle();
  assert.equal(host.queue.size, 0);
  assert.ok(
    playerRuntimeDeadlines(host.session.state).includes(125),
    "the wait starts when loading was reported",
  );
});

test("an execution-pending load report is delivered after the engine ran queued work", async () => {
  const source =
    'timer async 1 s {\n  say "timer", instant\n}\nplayVideo "intro.mp4"\nsay "after", instant\nexit';
  const started = createPlayerRuntimeSession(source);
  // A canonical checkpoint whose timer expiry is queued but has not run yet.
  const observed = observeTime(started.plan, playerRuntimeSnapshot(started), 2000);
  const restored = restorePlayerRuntimeSessionAt(
    started.plan,
    JSON.stringify(observed.snapshot),
    started.events,
  );
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

test("a released element is reused for the next media without keeping the previous media's listeners", () => {
  const player = harness(
    'playAudio "sounds/a.mp3"\nplayAudio "sounds/b.mp3"\nsay "after", instant\nexit',
    undefined,
    { reuse: true },
  );
  player.start();
  const [element] = player.elements;
  element!.metadata(1);
  player.tick(1000);
  // The first media ended; the second took over its element, which a browser may already allow to play.
  assert.equal(player.elements.length, 1);
  assert.equal(element!.src, "asset:sounds/b.mp3");
  for (const type of ["loadedmetadata", "error", "seeked", "ended"])
    assert.equal(element!.listeners.get(type)?.length, 1, type);
  element!.metadata(1);
  assert.deepEqual(
    player.loads.map(([mediaId]) => mediaId),
    [1, 2],
  );
  player.tick(1000);
  assert.deepEqual(player.texts(), ["after"]);
});

test("a late play() result of a released media never pauses the element's next media", async () => {
  const player = harness('playAudio "sounds/a.mp3"\nexit', undefined, { reuse: true });
  player.start();
  const [element] = player.elements;
  element!.deferPlays = true;
  element!.metadata(5);
  assert.equal(element!.pendingPlays.length, 1);
  // Another session takes over the element while the first play() is still pending.
  player.replace(createPlayerRuntimeSession('playAudio "sounds/b.mp3"\nexit'));
  assert.equal(element!.src, "asset:sounds/b.mp3");
  element!.metadata(5);
  element!.pendingPlays[0]!();
  await settle();
  assert.equal(element!.paused, false);
  element!.pendingPlays[1]!();
  await settle();
  assert.equal(element!.paused, false);
});
