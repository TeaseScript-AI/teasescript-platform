import assert from "node:assert/strict";
import test from "node:test";

import {
  completeAction,
  createFreshRuntimeSnapshot,
  mediaPlaybackProjection,
  observeTime,
  reportMediaLoad,
  run,
  stageProjection,
  validateRuntimeSnapshot,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
} from "../src/index.js";
import type { RuntimeMediaActionSnapshot } from "../src/runtime/actions/model.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

/** A JSON copy of a snapshot for corruption tests. */
interface MutableSnapshot {
  foregroundAction: { mediaId?: number } | null;
  backgroundActions: { kind: string; media?: MutableMedia }[];
  pendingTimerHandlers: Record<string, unknown>[];
  nextMediaId: number;
}

interface MutableMedia {
  mediaId: number;
  loaded: boolean;
  durationMs: number | null;
  points: unknown[];
  segment: number;
  finishFunctionId: number | null;
}

function mediaOf(snapshot: MutableSnapshot, mediaId: number): MutableMedia {
  const media = snapshot.backgroundActions.find(
    (action) => action.media?.mediaId === mediaId,
  )?.media;
  assert.ok(media !== undefined, `media ${mediaId} is active`);
  return media;
}

/** A deterministic scripted Player: every operation validates the snapshot and continues execution. */
class Session {
  readonly plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
  readonly events: InterpreterEvent[] = [];

  constructor(source: string, options: { readonly pacing?: boolean } = {}) {
    this.plan = plan(source);
    this.snapshot =
      options.pacing === true
        ? createFreshRuntimeSnapshot(this.plan)
        : createImmediatePacingRuntimeSnapshot(this.plan);
    this.#run();
  }

  load(mediaId: number, durationMs: number): this {
    this.#apply(reportMediaLoad(this.plan, this.snapshot, mediaId, { kind: "loaded", durationMs }));
    return this;
  }

  fail(mediaId: number): this {
    this.#apply(reportMediaLoad(this.plan, this.snapshot, mediaId, { kind: "failed" }));
    return this;
  }

  /** Observes scene time with progress reports `[mediaId, progressMs]` for the media's current segment. */
  at(nowMs: number, ...reports: readonly (readonly [number, number])[]): this {
    const media = (mediaId: number) =>
      this.snapshot.backgroundActions.find(
        (action): action is RuntimeMediaActionSnapshot =>
          action.kind === "media" && action.media.mediaId === mediaId,
      );
    this.#apply(
      observeTime(
        this.plan,
        this.snapshot,
        nowMs,
        reports.map(([mediaId, progressMs]) => ({
          mediaId,
          segment: media(mediaId)?.media.segment ?? 0,
          progressMs,
        })),
      ),
    );
    return this;
  }

  skip(): this {
    const gate = this.snapshot.foregroundAction;
    assert.equal(gate?.kind, "chatPacingGate");
    this.#apply(
      completeAction(this.plan, this.snapshot, {
        actionId: gate!.actionId,
        actionKind: "chatPacingGate",
        payload: { kind: "skip" },
      }),
    );
    return this;
  }

  said(): string[] {
    return this.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  }

  warnings(): string[] {
    return this.events.flatMap((event) =>
      event.kind === "developerWarning" ? [`${event.code} ${event.message}`] : [],
    );
  }

  media(mediaId: number) {
    return (
      this.snapshot.backgroundActions.find(
        (action): action is RuntimeMediaActionSnapshot =>
          action.kind === "media" && action.media.mediaId === mediaId,
      )?.media ?? this.snapshot.settledMedia.find((media) => media.mediaId === mediaId)
    );
  }

  #apply(operation: {
    readonly snapshot: RuntimeSnapshot;
    readonly events: readonly InterpreterEvent[];
  }): void {
    this.snapshot = operation.snapshot;
    this.events.push(...operation.events);
    this.#validate();
    this.#run();
  }

  #run(): void {
    const operation = run(this.plan, this.snapshot);
    this.snapshot = operation.snapshot;
    this.events.push(...operation.events);
    this.#validate();
  }

  #validate(): void {
    const validation = validateRuntimeSnapshot(this.snapshot, this.plan);
    assert.equal(validation.valid, true, validation.errors.join("; "));
  }
}

test("blocking audio waits for load and natural completion; async audio continues after load", () => {
  const blocking = new Session('playAudio "bell.mp3"\nsay "after bell"');
  assert.equal(blocking.snapshot.foregroundAction?.kind, "mediaPlayback");
  blocking.load(1, 2_000).at(1_000, [1, 1_000]);
  assert.deepEqual(blocking.said(), []);
  blocking.at(2_000, [1, 2_000]);
  assert.deepEqual(blocking.said(), ["after bell"]);
  assert.equal(blocking.snapshot.status, "halted");
  assert.equal(blocking.media(1)?.state, "finished");

  const background = new Session(
    'let music = playAudio async "music.mp3"\nsay "started ${music.duration} ${music.state}"',
  );
  assert.deepEqual(background.said(), []);
  background.load(1, 90_000);
  assert.deepEqual(background.said(), ["started 1 min 30 s running"]);
});

test("a source the Player cannot load warns, stops without cues or finish, and never blocks", () => {
  const session = new Session(
    [
      'playAudio "missing.mp3" {',
      "  finish {",
      '    say "never"',
      "  }",
      "}",
      'let m = playAudio async "gone.mp3"',
      'say "${m.state} ${m.duration} ${m.remaining}"',
    ].join("\n"),
  );
  session.fail(1).fail(2);
  assert.deepEqual(session.said(), ["stopped null null"]);
  assert.equal(session.warnings().filter((warning) => warning.startsWith("TSW013")).length, 2);
});

test("cues fire on every natural pass; the compact block is a per-pass end; finish runs once", () => {
  const session = new Session(
    [
      'let beat = playAudio(file: "beat.mp3", async: true, repeat: 2 times) {',
      "  at 0 s {",
      '    say "start ${beat.position}"',
      "  }",
      "  at 1 s {",
      '    say "one"',
      "  }",
      "  beforeEnd 0 s {",
      '    say "end ${beat.elapsed}"',
      "  }",
      "  finish {",
      '    say "finish ${beat.state}"',
      "  }",
      "}",
      "wait 10",
    ].join("\n"),
  );
  session.load(1, 2_000).at(0, [1, 0]).at(4_000, [1, 4_000]);
  assert.deepEqual(session.said(), [
    "start 0 s",
    "one",
    "end 2 s",
    "start 0 s",
    "one",
    "end 4 s",
    "finish finished",
  ]);
  assert.equal(session.media(1)?.passesCompleted, 2);

  const compact = new Session('playAudio async repeat "beat.mp3" {\n  say "again"\n}\nwait 10');
  compact.load(1, 1_000).at(3_500, [1, 3_500]);
  assert.deepEqual(compact.said(), ["again", "again", "again"]);
});

test("stop() never runs finish; stopping again is silent and other controls warn", () => {
  const session = new Session(
    [
      'let music = playAudio async "music.mp3" {',
      "  at 1 s {",
      '    say "cue"',
      "  }",
      "  finish {",
      '    say "never"',
      "  }",
      "}",
      "wait 5",
      "music.stop()",
      "music.stop()",
      "music.pause()",
      'say "${music.state}"',
    ].join("\n"),
  );
  session.load(1, 10_000).at(5_000, [1, 5_000]);
  assert.deepEqual(session.said(), ["cue", "stopped"]);
  assert.deepEqual(
    session.warnings().map((warning) => warning.slice(0, 6)),
    ["TSW010"],
  );
});

test("one late observation and many small ones give the same result under linear playback", () => {
  const source = [
    'let music = playAudio async repeat "loop.mp3" {',
    "  at 3 s {",
    '    say "cue ${music.position}"',
    "  }",
    "}",
    "timer async 5 s {",
    "  music.stop()",
    '  say "timer ${music.elapsed}"',
    "}",
    "wait 12",
    'say "done ${music.state} ${music.elapsed}"',
  ].join("\n");
  const late = new Session(source).load(1, 4_000).at(0, [1, 0]).at(12_000, [1, 12_000]);
  const small = new Session(source).load(1, 4_000).at(0, [1, 0]);
  for (let now = 250; now <= 12_000; now += 250) small.at(now, [1, now]);
  assert.deepEqual(late.said(), small.said());
  assert.deepEqual(late.said(), ["cue 3 s", "timer 5 s", "done stopped 5 s"]);
});

test("a stall reported by equal progress delays cues; elapsed excludes stalls and pauses", () => {
  const session = new Session(
    [
      'let music = playAudio async "music.mp3" {',
      "  at 2 s {",
      '    say "cue ${music.elapsed}"',
      "  }",
      "}",
      "timer async 3 s {",
      '  say "timer ${music.elapsed}"',
      "  music.pause()",
      "}",
      "wait 10",
      'say "done ${music.elapsed} ${music.state}"',
    ].join("\n"),
  );
  // Plays 1 s, stalls for 3 s, then plays again.
  session
    .load(1, 60_000)
    .at(0, [1, 0])
    .at(1_000, [1, 1_000])
    .at(4_000, [1, 1_000])
    .at(6_000, [1, 3_000]);
  session.at(10_000, [1, 3_000]);
  assert.deepEqual(session.said(), ["timer 1 s", "done 1 s paused"]);
});

test("seeks clamp, skip jumped cues, fire a landing cue once playback proceeds, and end a pass at once", () => {
  const session = new Session(
    [
      'let m = playAudio async repeat "loop.mp3" {',
      "  at 1 s {",
      '    say "one"',
      "  }",
      "  at 2 s {",
      '    say "two"',
      "  }",
      "  beforeEnd 0 s {",
      '    say "end"',
      "  }",
      "}",
      "m.position = 2 s",
      'say "seek ${m.position}"',
      "wait 1",
      "m.remaining = 0 s",
      'say "after end ${m.position} ${m.elapsed}"',
      "m.position = -5 s",
      'say "clamped ${m.position}"',
      "m.stop()",
    ].join("\n"),
  );
  session.load(1, 3_000).at(0, [1, 0]).at(500, [1, 500]).at(1_000, [1, 1_000]);
  // The wait ends as the pass ends naturally; the seek then completes the next pass at once.
  assert.deepEqual(session.said(), [
    "seek 2 s",
    "two",
    "end",
    "end",
    "after end 0 s 1 s",
    "clamped 0 s",
  ]);
});

test("pausing keeps the position and cues pending; resume continues; no-op calls stay silent", () => {
  const session = new Session(
    [
      'let m = playAudio async "music.mp3" {',
      "  at 0 s {",
      '    say "start"',
      "  }",
      "}",
      "m.pause()",
      "m.pause()",
      'say "paused ${m.position}"',
      "wait 2",
      "m.resume()",
      "m.resume()",
      "wait 5",
      'say "at ${m.position}"',
    ].join("\n"),
  );
  session.load(1, 60_000).at(2_000);
  assert.deepEqual(session.said(), ["paused 0 s"]);
  session.at(3_000, [1, 1_000]).at(7_000, [1, 5_000]);
  assert.deepEqual(session.said(), ["paused 0 s", "start", "at 5 s"]);
  assert.deepEqual(session.warnings(), []);
});

test("a count or duration repeat can end mid-pass and finishes after the reached cues", () => {
  const session = new Session(
    [
      'playAudio(file: "loop.mp3", repeat: 2500 ms) {',
      "  at 500 ms {",
      '    say "half ${m}"',
      "  }",
      "}",
      'say "done"',
    ]
      .join("\n")
      .replace(" ${m}", ""),
  );
  session.load(1, 1_000).at(0, [1, 0]).at(3_000, [1, 3_000]);
  assert.deepEqual(session.said(), ["half", "half", "half", "done"]);
  assert.equal(session.media(1)?.elapsedMs, 2_500);
  assert.equal(session.media(1)?.state, "finished");
});

test("the Stage image persists; a video covers it and stops when replaced", () => {
  const session = new Session(
    [
      'showImage "images/room.jpg"',
      'let fire = playVideo async repeat "videos/fire.mp4"',
      'playVideo async "videos/other.mp4"',
      'say "${fire.state}"',
      "hideImage",
      "showImage null",
      'showImage "images/bed.jpg"',
      "wait 1",
    ].join("\n"),
  );
  assert.deepEqual(stageProjection(session.snapshot), {
    image: "images/room.jpg",
    videoMediaId: 1,
  });
  session.load(1, 5_000);
  assert.deepEqual(stageProjection(session.snapshot), {
    image: "images/room.jpg",
    videoMediaId: 2,
  });
  session.load(2, 5_000);
  assert.deepEqual(session.said(), ["stopped"]);
  assert.deepEqual(stageProjection(session.snapshot), {
    image: "images/bed.jpg",
    videoMediaId: null,
  });
  assert.equal(session.media(2)?.state, "stopped");
  assert.deepEqual(
    session.warnings().map((warning) => warning.slice(0, 6)),
    ["TSW011"],
  );
});

test("a cue block may control its own media inside a function and interrupts a blocking wait", () => {
  const session = new Session(
    [
      "function scene {",
      '  let music = playAudio async "music.mp3" {',
      "    at 1 s {",
      "      music.volume = 0.25",
      '      say "quiet"',
      "    }",
      "  }",
      '  playVideo "videos/long.mp4" {',
      "    at 2 s {",
      '      showImage "images/end.jpg"',
      "    }",
      "  }",
      '  say "after video ${music.volume}"',
      "}",
      "scene()",
    ].join("\n"),
  );
  session.load(1, 60_000).at(0, [1, 0]);
  session.load(2, 60_000).at(1_000, [1, 1_000], [2, 1_000]).at(2_000, [1, 2_000], [2, 2_000]);
  assert.deepEqual(session.said(), ["quiet", "after video 0.25"]);
  assert.equal(session.media(2)?.state, "stopped");
});

test("main-story media waits for message pacing, but not inside interrupt blocks", () => {
  const session = new Session(
    ['say "This is my room."', 'showImage "images/bed.jpg"', 'say "And this is my bed."'].join(
      "\n",
    ),
    { pacing: true },
  );
  assert.equal(session.snapshot.stageImage, null);
  assert.equal(session.snapshot.foregroundAction?.kind, "chatPacingGate");
  session.skip();
  assert.equal(session.snapshot.stageImage, "images/bed.jpg");
  assert.deepEqual(session.said(), ["This is my room.", "And this is my bed."]);

  const interrupt = new Session(
    ["timer async 1 {", '  say "Now."', '  showImage "images/now.jpg"', "}", "wait 10"].join("\n"),
    { pacing: true },
  );
  interrupt.at(1_000);
  assert.equal(interrupt.snapshot.stageImage, "images/now.jpg");
});

test("the projection reports load state, playhead, and terminal progress of repeated media", () => {
  const session = new Session(
    'let m = playAudio(file: "a.mp3", async: true, repeat: 3 times, startAt: 1 s)\nwait 10\nm.position = 2 s\nwait 10',
  );
  let [media] = mediaPlaybackProjection(session.snapshot);
  assert.equal(media?.loaded, false);
  session.load(1, 3_000).at(0, [1, 0]).at(2_500, [1, 2_500]);
  [media] = mediaPlaybackProjection(session.snapshot);
  assert.deepEqual(
    {
      segment: media?.segment,
      playheadMs: media?.playheadMs,
      reported: media?.reportedProgressMs,
      terminal: media?.terminalProgressMs,
      end: media?.endMs,
    },
    { segment: 1, playheadMs: 1_500, reported: 2_500, terminal: 6_000, end: 3_000 },
  );
  session.at(10_000, [1, 10_000]);
  assert.equal(session.media(1)?.state, "finished");
});

test("media scenarios resume equivalently from every checkpoint boundary", () => {
  const scenarios = [
    'showImage "a.jpg"\nplayAudio "bell.mp3"\nhideImage\nsay "after"',
    [
      'let music = playAudio async repeat "loop.mp3" {',
      "  at 0 s {",
      '    say "start ${music.position}"',
      "  }",
      "  beforeEnd 0 s {",
      '    say "end"',
      "  }",
      "}",
      "wait 2",
      "music.position = 500 ms",
      "wait 1",
      "music.stop()",
    ].join("\n"),
    [
      "function scene {",
      '  let m = playAudio(file: "a.mp3", async: true, repeat: 2 times) {',
      "    at 250 ms {",
      "      m.pause()",
      '      say "paused"',
      "      m.resume()",
      "    }",
      "    finish {",
      '      say "finished"',
      "    }",
      "  }",
      "  wait 3",
      "}",
      "scene()",
    ].join("\n"),
    'let v = playVideo async "a.mp4"\nplayVideo "b.mp4" {\n  at 250 ms {\n    showImage "x.jpg"\n  }\n}\nsay "${v.state}"',
  ];
  for (const source of scenarios) assertRuntimeResumeEquivalent(source, { mediaDurationMs: 1_000 });
});

test("a media statement may end the script, also with a finish block or a failed load", () => {
  for (const source of [
    'playAudio "a.mp3"',
    'playAudio async "a.mp3"',
    'playVideo "a.mp4" {\n  finish {\n    say "finished"\n  }\n}',
  ]) {
    const session = new Session(source).load(1, 1_000).at(1_000, [1, 1_000]);
    assert.equal(session.snapshot.status, "halted", source);
  }
  const finished = new Session('playVideo "a.mp4" {\n  finish {\n    say "finished"\n  }\n}');
  finished.load(1, 1_000).at(1_000, [1, 1_000]);
  assert.deepEqual(finished.said(), ["finished"]);
  const failed = new Session('playAudio "missing.mp3"').fail(1);
  assert.equal(failed.snapshot.status, "halted");
});

test("controlling other media inside a cue block keeps the catch-up order of work due at the same time", () => {
  const source = (timerBody: string) =>
    [
      'let a = playAudio async "a.mp3" {',
      "  at 500 ms {",
      '    say "a"',
      "    b.pause()",
      "  }",
      "}",
      "timer async 500 ms {",
      `  ${timerBody}`,
      "}",
      'let b = playAudio async "b.mp3" {',
      "  at 500 ms {",
      '    say "b"',
      "  }",
      "}",
      "wait 10",
      'say "${b.state} ${b.position}"',
      "b.resume()",
      "wait 10",
    ].join("\n");
  const paused = new Session(source('say "timer"'))
    .load(1, 1_000)
    .load(2, 1_000)
    .at(1_000, [1, 1_000], [2, 1_000]);
  // The cue of b at 500 ms follows the timer; b was paused exactly there, so it fires once b plays on.
  assert.deepEqual(paused.said(), ["a", "timer"]);
  paused.at(10_000).at(10_500, [2, 500]);
  assert.deepEqual(paused.said(), ["a", "timer", "paused 500 ms", "b"]);

  const stopped = new Session(source('say "timer"\n  b.stop()'))
    .load(1, 1_000)
    .load(2, 1_000)
    .at(1_000, [1, 1_000], [2, 1_000]);
  assert.deepEqual(stopped.said(), ["a", "timer"]);
});

test("dynamic media options are validated when supplied, including null and indefinite finish", () => {
  const failure = (source: string) => {
    const compiled = plan(source);
    const operation = run(compiled, createImmediatePacingRuntimeSnapshot(compiled));
    assert.equal(operation.snapshot.status, "failed", source);
    return operation.snapshot.failure?.message ?? "";
  };
  assert.match(
    failure(
      'let loop = true\nplayAudio(file: "a", async: true, repeat: loop) {\n  finish {\n    say "x"\n  }\n}',
    ),
    /finish' never runs/u,
  );
  assert.match(failure('let v = null\nplayAudio(file: "a", volume: v)'), /volume/u);
  assert.match(failure('let s = null\nplayAudio(file: "a", startAt: s)'), /startAt/u);
  assert.match(failure('let e = null\nplayAudio(file: "a", endAt: e)'), /endAt/u);
});

test("media controls on any receiver wait for pacing and evaluate the receiver once", () => {
  const session = new Session(
    [
      'let music = playAudio async "music.mp3"',
      "let calls = 0",
      "let box = [music]",
      "function current {",
      "  calls += 1",
      "  return music",
      "}",
      'say "Pause now."',
      "current().pause()",
      'say "Paused ${calls}."',
      "box[0 + 0].resume()",
      'say "${music.state}"',
    ].join("\n"),
    { pacing: true },
  );
  session.load(1, 60_000);
  assert.equal(session.media(1)?.state, "running", "the pause waits for the message");
  session.skip();
  assert.equal(session.media(1)?.state, "paused");
  session.skip();
  assert.deepEqual(session.said(), ["Pause now.", "Paused 1.", "running"]);
});

test("an interrupt before an async media assignment keeps a valid, resumable state", () => {
  const session = new Session(
    'timer async 0 s {\n  say "timer"\n}\nlet m = playAudio async "a.mp3"\nsay "${m.state}"',
  );
  session.load(1, 1_000);
  assert.deepEqual(session.said(), ["timer", "running"]);
  assertRuntimeResumeEquivalent(
    'timer async 0 s {\n  say "timer"\n}\nlet m = playAudio async "a.mp3"\nsay "${m.state}"\nwait 2',
    { mediaDurationMs: 1_000 },
  );
});

test("restore validation rejects malformed media state", () => {
  const source = [
    'let a = playAudio async repeat "a.mp3" {',
    "  at 0 s {",
    "    a.volume = 0.5",
    "  }",
    "}",
    'playAudio "b.mp3" {',
    "  finish {",
    '    say "done"',
    "  }",
    "}",
  ].join("\n");
  const session = new Session(source).load(1, 1_000).load(2, 2_000);
  const valid = session.snapshot;
  assert.equal(validateRuntimeSnapshot(valid, session.plan).valid, true);
  const mutations: readonly (readonly [string, (snapshot: MutableSnapshot) => void])[] = [
    ["empty active range", (snapshot) => (mediaOf(snapshot, 1).durationMs = 0)],
    ["unloaded media with samples", (snapshot) => (mediaOf(snapshot, 2).loaded = false)],
    ["wait on another media", (snapshot) => (snapshot.foregroundAction!.mediaId = 1)],
    [
      "cue invocation before load",
      (snapshot) => {
        const media = mediaOf(snapshot, 2);
        media.loaded = false;
        media.durationMs = null;
        media.points = [];
        media.segment = 0;
        snapshot.pendingTimerHandlers.push({
          mediaId: 2,
          handlerFunctionId: media.finishFunctionId!,
          dueAtMs: 0,
          count: 1,
        });
      },
    ],
    [
      "finish invocation before finishing",
      (snapshot) =>
        snapshot.pendingTimerHandlers.push({
          mediaId: 2,
          handlerFunctionId: mediaOf(snapshot, 2).finishFunctionId!,
          dueAtMs: 0,
          count: 1,
        }),
    ],
    ["handle to unissued media", (snapshot) => (snapshot.nextMediaId = 2)],
  ];
  for (const [name, mutate] of mutations) {
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(valid)) as MutableSnapshot;
    mutate(corrupted);
    assert.equal(validateRuntimeSnapshot(corrupted, session.plan).valid, false, name);
  }
});

test("a media control uses the receiver it had before the pacing wait", () => {
  const session = new Session(
    [
      'let a = playAudio async "a.mp3"',
      'let b = playAudio async "b.mp3"',
      "let h = a",
      "timer async 1 {",
      "  h = b",
      "}",
      'say "gate", 2',
      "h.pause()",
      "wait 10",
    ].join("\n"),
    { pacing: true },
  );
  session.load(1, 60_000).load(2, 60_000).at(2_000);
  assert.equal(session.media(1)?.state, "paused");
  assert.equal(session.media(2)?.state, "running");
});

test("an async play whose loaded source leaves no range continues as a failed load", () => {
  const session = new Session(
    'let m = playAudio(file: "a", async: true, startAt: 2 s)\nsay "${m.state} ${m.duration}"',
  );
  session.load(1, 1_000);
  assert.deepEqual(session.said(), ["stopped 1 s"]);
  assert.equal(session.warnings().filter((warning) => warning.startsWith("TSW013")).length, 1);
});

test("a terminal blocking play still runs finish after an earlier cue in one late observation", () => {
  const session = new Session(
    'playAudio "a.mp3" {\n  at 500 ms {\n    say "cue"\n  }\n  finish {\n    say "finish"\n  }\n}',
  );
  session.load(1, 1_000).at(1_000, [1, 1_000]);
  assert.deepEqual(session.said(), ["cue", "finish"]);
  assert.equal(session.snapshot.status, "halted");
});

test("pausing media exactly where its repeat duration runs out still finishes it", () => {
  const session = new Session(
    [
      'playAudio async "a.mp3" {',
      "  at 500 ms {",
      "    b.pause()",
      "  }",
      "}",
      'let b = playAudio(file: "b.mp3", async: true, repeat: 500 ms) {',
      "  finish {",
      '    say "b finished ${b.elapsed}"',
      "  }",
      "}",
      "wait 10",
    ].join("\n"),
  );
  session.load(1, 1_000).load(2, 1_000).at(1_000, [1, 1_000], [2, 1_000]);
  assert.equal(session.media(2)?.state, "finished");
  assert.deepEqual(session.said(), ["b finished 500 ms"]);
});

test("cues at one point run in source order, also when written differently, before finish", () => {
  const session = new Session(
    [
      'playAudio "a.mp3" {',
      "  beforeEnd 1500 ms {",
      '    say "first"',
      "  }",
      "  at 500 ms {",
      '    say "second"',
      "  }",
      "  finish {",
      '    say "finish"',
      "  }",
      "}",
    ].join("\n"),
  );
  session.load(1, 2_000).at(2_000, [1, 2_000]);
  assert.deepEqual(session.said(), ["first", "second", "finish"]);
});

test("malformed media reports are rejected atomically without changing state or input", () => {
  const compiled = plan('let m = playAudio async "a.mp3"\nwait 10');
  let snapshot = run(compiled, createImmediatePacingRuntimeSnapshot(compiled)).snapshot;
  snapshot = reportMediaLoad(compiled, snapshot, 1, { kind: "loaded", durationMs: 5_000 }).snapshot;
  snapshot = run(compiled, snapshot).snapshot;
  const before = structuredClone(snapshot);
  const valid = { mediaId: 1, segment: 1, progressMs: 500 };
  for (const reports of [
    [{ mediaId: 1, segment: 1, progressMs: -1 }],
    [{ mediaId: 1, segment: 1 }],
    [valid, { mediaId: 0, segment: 1, progressMs: 500 }],
    [{ mediaId: 1, segment: -1, progressMs: 500 }, valid],
    "not a list",
  ]) {
    const input = structuredClone(reports);
    const result = observeTime(compiled, snapshot, 1_000, reports);
    assert.equal(result.outcome.kind, "invalidObservation", JSON.stringify(reports));
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.snapshot, before);
    assert.deepEqual(reports, input, "caller input stays unchanged");
  }
  for (const report of [
    { kind: "loaded", durationMs: -1 },
    { kind: "loaded" },
    { kind: "paused" },
    null,
  ]) {
    const result = reportMediaLoad(compiled, snapshot, 1, report);
    assert.equal(result.outcome.kind, "invalidReport", JSON.stringify(report));
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.snapshot, before);
  }
  assert.equal(
    reportMediaLoad(compiled, snapshot, 2, { kind: "failed" }).outcome.kind,
    "unknownMedia",
  );
  assert.equal(
    reportMediaLoad(compiled, snapshot, 1, { kind: "loaded", durationMs: 1 }).outcome.kind,
    "ignored",
  );
});

test("restore validation rejects a queued cue owned by another media", () => {
  const session = new Session(
    [
      'let a = playAudio async "a.mp3" {',
      "  at 500 ms {",
      '    say "a"',
      "  }",
      "}",
      'let b = playAudio async "b.mp3"',
      "timer async 0 s {",
      '  say "hold"',
      "  wait 5",
      "}",
      "wait 10",
    ].join("\n"),
  );
  session.load(1, 1_000).load(2, 1_000).at(1_000, [1, 1_000], [2, 1_000]);
  const queued = session.snapshot.pendingTimerHandlers.find((entry) => "mediaId" in entry);
  assert.ok(queued !== undefined, "a cue block waits behind the running timer block");
  assert.equal(validateRuntimeSnapshot(session.snapshot, session.plan).valid, true);
  // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; the case moves one cue owner.
  const corrupted = JSON.parse(JSON.stringify(session.snapshot)) as MutableSnapshot;
  const entry = corrupted.pendingTimerHandlers.find((candidate) => "mediaId" in candidate)!;
  entry.mediaId = 2;
  assert.equal(validateRuntimeSnapshot(corrupted, session.plan).valid, false);
});

test("root completion keeps the terminal instruction's span however late the media is observed", () => {
  const source =
    'let m = playAudio async "m.mp3" {\n  at 100 ms {\n    say "cue"\n  }\n}\nwait 1 s';
  const completion = (session: Session) => {
    const event = session.events.find((candidate) => candidate.kind === "complete");
    assert.ok(event !== undefined);
    return event.span;
  };
  const fine = new Session(source).load(1, 1_000).at(100, [1, 100]).at(1_000, [1, 1_000]);
  const late = new Session(source).load(1, 1_000).at(1_000, [1, 1_000]);
  assert.deepEqual(completion(late), completion(fine));
});

test("stop() cancels a cue block that is queued and not yet started", () => {
  const session = new Session(
    [
      'let m = playAudio async "m.mp3" {',
      "  at 500 ms {",
      '    say "never"',
      "  }",
      "}",
      "timer async 400 ms {",
      "  wait 200 ms",
      "  m.stop()",
      '  say "stopped"',
      "}",
      "wait 2",
    ].join("\n"),
  );
  // The timer block waits from 400 ms to 600 ms; the cue at 500 ms queues behind it and is dropped by stop().
  session.load(1, 1_000).at(1_000, [1, 1_000]);
  assert.deepEqual(session.said(), ["stopped"]);
  assert.equal(session.snapshot.pendingTimerHandlers.length, 0);
});

test("restore validation keeps elapsed and sample history coherent with scene time", () => {
  const compiled = plan(
    'let m = playAudio async "m.mp3" {\n  at 500 ms {\n    say "cue"\n  }\n}\nwait 10',
  );
  let snapshot = run(compiled, createImmediatePacingRuntimeSnapshot(compiled)).snapshot;
  snapshot = reportMediaLoad(compiled, snapshot, 1, { kind: "loaded", durationMs: 5_000 }).snapshot;
  snapshot = run(compiled, snapshot).snapshot;
  // The cue at 500 ms holds catch-up there while the later sample stays retained.
  snapshot = observeTime(compiled, snapshot, 1_000, [
    { mediaId: 1, segment: 1, progressMs: 1_000 },
  ]).snapshot;
  assert.equal(snapshot.currentSessionTimeMs, 500);
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);
  const corrupt = (mutate: (media: { elapsedMs: number; points: { atMs: number }[] }) => void) => {
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; the case changes one media field.
    const copy = JSON.parse(JSON.stringify(snapshot)) as {
      backgroundActions: {
        kind: string;
        media?: { elapsedMs: number; points: { atMs: number }[] };
      }[];
    };
    mutate(copy.backgroundActions.find((action) => action.kind === "media")!.media!);
    return validateRuntimeSnapshot(copy, compiled).valid;
  };
  assert.equal(
    corrupt((media) => (media.elapsedMs = 0)),
    false,
    "elapsed below committed progress",
  );
  assert.equal(
    corrupt((media) => (media.points[0]!.atMs = 501)),
    false,
    "no retained sample at or before current scene time",
  );
});
