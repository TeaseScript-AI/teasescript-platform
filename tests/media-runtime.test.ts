import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  executeInstruction,
  mediaPlaybackProjection,
  observeTime,
  reportMediaLoad,
  run,
  serializeCheckpoint,
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
  callFrames: { timerInterruption: { mediaId?: number } | null }[];
  settledMedia: MutableMedia[];
}

interface MutableMedia {
  mediaId: number;
  loaded: boolean;
  durationMs: number | null;
  points: { atMs: number }[];
  segment: number;
  finishFunctionId: number | null;
  segmentPositionMs: number;
  segmentPasses: number;
  segmentElapsedMs: number;
  positionMs: number;
  passesCompleted: number;
  committedProgressMs: number;
  startCuesPending: boolean;
}

function mediaOf(snapshot: MutableSnapshot, mediaId: number): MutableMedia {
  const media = snapshot.backgroundActions.find(
    (action) => action.media?.mediaId === mediaId,
  )?.media;
  assert.ok(media !== undefined, `media ${mediaId} is active`);
  return media;
}

/**
 * Generous bound for a catch-up that finishes in well under a second. The horizons that use it hold so many silent
 * passes that committing them one at a time would take days, so exceeding it means that regression rather than a slow
 * machine; it is not a performance threshold.
 */
const BOUNDED_CATCH_UP_LIMIT_MS = 20_000;

/** Restores a checkpoint, observes a time with progress reports, and runs the engine; prints the result as JSON. */
const BOUNDED_CATCH_UP_SCRIPT = `
  import { createCheckpoint, deserializeCheckpoint, observeTime, run, serializeCheckpoint }
    from ${JSON.stringify(new URL("../src/index.js", import.meta.url).href)};
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { checkpoint, nowMs, reports } = JSON.parse(input);
  const { plan, snapshot } = deserializeCheckpoint(checkpoint);
  const observed = observeTime(plan, snapshot, nowMs, reports);
  const ran = run(plan, observed.snapshot);
  process.stdout.write(JSON.stringify({
    outcome: observed.outcome.kind,
    events: [...observed.events, ...ran.events],
    checkpoint: serializeCheckpoint(createCheckpoint(plan, ran.snapshot)),
  }));
`;

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

  /** Like `at`, in a child process that must finish within `BOUNDED_CATCH_UP_LIMIT_MS`. */
  atBounded(nowMs: number, ...reports: readonly (readonly [number, number])[]): this {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", BOUNDED_CATCH_UP_SCRIPT],
      {
        input: JSON.stringify({
          checkpoint: serializeCheckpoint(createCheckpoint(this.plan, this.snapshot)),
          nowMs,
          reports: reports.map(([mediaId, progressMs]) => ({
            mediaId,
            segment: this.media(mediaId)?.segment ?? 0,
            progressMs,
          })),
        }),
        encoding: "utf8",
        timeout: BOUNDED_CATCH_UP_LIMIT_MS,
      },
    );
    assert.equal(child.error, undefined, `catch-up to ${nowMs} ms must finish within the bound`);
    assert.equal(child.status, 0, child.stderr);
    // EVIDENCE: fixture: the child prints plain JSON data in this shape.
    const result = JSON.parse(child.stdout) as {
      outcome: string;
      events: InterpreterEvent[];
      checkpoint: string;
    };
    assert.equal(result.outcome, "observed");
    this.#apply({
      snapshot: deserializeCheckpoint(result.checkpoint).snapshot,
      events: result.events,
    });
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
  const blocking = new Session('playAudio "bell.mp3"\nsay "after bell"\nexit');
  assert.equal(blocking.snapshot.foregroundAction?.kind, "mediaPlayback");
  blocking.load(1, 2_000).at(1_000, [1, 1_000]);
  assert.deepEqual(blocking.said(), []);
  blocking.at(2_000, [1, 2_000]);
  assert.deepEqual(blocking.said(), ["after bell"]);
  assert.equal(blocking.snapshot.status, "halted");
  assert.equal(blocking.media(1)?.state, "finished");

  const background = new Session(
    'let music = playAudio async "music.mp3"\nsay "started ${music.duration} ${music.state}"\nexit',
  );
  assert.deepEqual(background.said(), []);
  background.load(1, 90_000);
  assert.deepEqual(background.said(), ["started 1 min 30 s running"]);
});

test("a source the Player cannot load warns, stops without cues or finish, and never blocks", () => {
  const session = new Session(
    [
      'playAudio "missing.mp3" {',
      "  at 0 s {",
      '    say "never: blocking cue"',
      "  }",
      "  finish {",
      '    say "never: finish"',
      "  }",
      "}",
      'let m = playAudio async "gone.mp3" {',
      "  at 0 s {",
      '    say "never: async cue"',
      "  }",
      "}",
      'say "${m.state} ${m.duration} ${m.remaining}"',
      "exit",
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
      "exit",
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

  const compact = new Session(
    'playAudio async repeat "beat.mp3" {\n  say "again"\n}\nwait 10\nexit',
  );
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
      "exit",
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
    "exit",
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
      "exit",
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
      "exit",
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
      "exit",
    ].join("\n"),
  );
  session.load(1, 60_000).at(2_000);
  assert.deepEqual(session.said(), ["paused 0 s"]);
  session.at(3_000, [1, 1_000]).at(7_000, [1, 5_000]);
  assert.deepEqual(session.said(), ["paused 0 s", "start", "at 5 s"]);
  assert.deepEqual(session.warnings(), []);
});

test("a duration repeat can end mid-pass and finishes after the reached cues", () => {
  const session = new Session(
    [
      'playAudio(file: "loop.mp3", repeat: 2500 ms) {',
      "  at 500 ms {",
      '    say "half"',
      "  }",
      "  finish {",
      '    say "finish"',
      "  }",
      "}",
      'say "done"',
      "exit",
    ].join("\n"),
  );
  session.load(1, 1_000).at(0, [1, 0]).at(3_000, [1, 3_000]);
  assert.deepEqual(session.said(), ["half", "half", "half", "finish", "done"]);
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
      "exit",
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
      "exit",
    ].join("\n"),
  );
  session.load(1, 60_000).at(0, [1, 0]);
  session.load(2, 60_000).at(1_000, [1, 1_000], [2, 1_000]).at(2_000, [1, 2_000], [2, 2_000]);
  assert.deepEqual(session.said(), ["quiet", "after video 0.25"]);
  assert.equal(session.media(2)?.state, "stopped");
});

test("main-story media waits for message pacing, but not inside interrupt blocks", () => {
  const session = new Session(
    [
      'say "This is my room."',
      'showImage "images/bed.jpg"',
      'say "And this is my bed."',
      "exit",
    ].join("\n"),
    { pacing: true },
  );
  assert.equal(session.snapshot.stageImage, null);
  assert.equal(session.snapshot.foregroundAction?.kind, "chatPacingGate");
  session.skip();
  assert.equal(session.snapshot.stageImage, "images/bed.jpg");
  assert.deepEqual(session.said(), ["This is my room.", "And this is my bed."]);

  const interrupt = new Session(
    [
      "timer async 1 {",
      '  say "Now."',
      '  showImage "images/now.jpg"',
      "}",
      "wait 10",
      "exit",
    ].join("\n"),
    { pacing: true },
  );
  interrupt.at(1_000);
  assert.equal(interrupt.snapshot.stageImage, "images/now.jpg");
});

test("the projection reports load state, playhead, and terminal progress of repeated media", () => {
  const session = new Session(
    'let m = playAudio(file: "a.mp3", async: true, repeat: 3 times, startAt: 1 s)\nwait 10\nm.position = 2 s\nwait 10\nexit',
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
    'showImage "a.jpg"\nplayAudio "bell.mp3"\nhideImage\nsay "after"\nexit',
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
      "exit",
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
      "exit",
    ].join("\n"),
    'let v = playVideo async "a.mp4"\nplayVideo "b.mp4" {\n  at 250 ms {\n    showImage "x.jpg"\n  }\n}\nsay "${v.state}"\nexit',
    [
      'let f = playAudio(file: "f.mp3", async: true, repeat: 7 times, endAt: 100.1 ms) {',
      "  at 50.05 ms {",
      "    f.pause()",
      "    f.resume()",
      "  }",
      "  finish {",
      '    say "f ${f.elapsed}"',
      "  }",
      "}",
      'playAudio(file: "b.mp3", repeat: 777.7 ms, startAt: 0.05 ms, endAt: 110.1 ms) {',
      "  beforeEnd 10.1 ms {",
      '    say "b ${f.position}"',
      "  }",
      "}",
      'say "after"',
      "exit",
    ].join("\n"),
  ];
  for (const source of scenarios) assertRuntimeResumeEquivalent(source, { mediaDurationMs: 1_000 });
});

test("a media statement may end the script, also with a finish block or a failed load", () => {
  for (const [source, said] of [
    ['playAudio "a.mp3"\nexit', []],
    ['playAudio async "a.mp3"\nexit', []],
    ['playVideo "a.mp4" {\n  finish {\n    say "finished"\n  }\n}\nexit', ["finished"]],
  ] as const) {
    const session = new Session(source).load(1, 1_000).at(1_000, [1, 1_000]);
    assert.equal(session.snapshot.status, "halted", source);
    assert.deepEqual(session.said(), said, source);
  }
  const failed = new Session('playAudio "missing.mp3"\nexit').fail(1);
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
      "exit",
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
  // [source, the offending source text the failure must point at]
  const indefinite =
    'playAudio(file: "a", async: true, repeat: loop) {\n  finish {\n    say "x"\n  }\n}';
  const hidden = "function dynamic(value) {\n    return value\n}\n";
  for (const [source, offending] of [
    [`let loop = true\n${indefinite}\nexit`, indefinite],
    // A variable just set to null is known to be null, so the function hides it until the media starts.
    [`${hidden}let v = dynamic(null)\nplayAudio(file: "a", volume: v)\nexit`, "v"],
    [`${hidden}let s = dynamic(null)\nplayAudio(file: "a", startAt: s)\nexit`, "s"],
    [`${hidden}let e = dynamic(null)\nplayAudio(file: "a", endAt: e)\nexit`, "e"],
  ] as const) {
    const compiled = plan(source);
    const { snapshot } = run(compiled, createImmediatePacingRuntimeSnapshot(compiled));
    assert.equal(snapshot.status, "failed", source);
    const start = source.lastIndexOf(offending);
    assert.deepEqual(
      [
        snapshot.failure?.code,
        snapshot.failure?.span.start.offset,
        snapshot.failure?.span.end.offset,
      ],
      ["TSR050", start, start + offending.length],
      source,
    );
    assert.equal(snapshot.nextMediaId, 1, `${source}: no media was created`);
  }
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
      "exit",
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
    'timer async 0 s {\n  say "timer"\n}\nlet m = playAudio async "a.mp3"\nsay "${m.state}"\nexit',
  );
  session.load(1, 1_000);
  assert.deepEqual(session.said(), ["timer", "running"]);
  assertRuntimeResumeEquivalent(
    'timer async 0 s {\n  say "timer"\n}\nlet m = playAudio async "a.mp3"\nsay "${m.state}"\nwait 2\nexit',
    { mediaDurationMs: 1_000 },
  );
});

test("a host builtin cannot hand out the handle of media that is still loading", () => {
  const compiled = plan(
    'timer async 1 s {\n  host().pause()\n}\nlet m = playAudio async "a.mp3"\nexit',
    { builtins: ["host"] },
  );
  // The play holds media ID 1 while it waits for the load; only the host could name it before the binding.
  const capabilities = { builtins: { host: () => ({ kind: "mediaHandle" as const, mediaId: 1 }) } };
  let snapshot = run(
    compiled,
    createImmediatePacingRuntimeSnapshot(compiled),
    capabilities,
  ).snapshot;
  assert.equal(snapshot.foregroundAction?.kind, "mediaPlayback");
  snapshot = run(compiled, observeTime(compiled, snapshot, 1_000).snapshot, capabilities).snapshot;
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.failure?.code, "TSR013");
  const media = snapshot.backgroundActions.find(
    (action): action is RuntimeMediaActionSnapshot => action.kind === "media",
  )?.media;
  assert.deepEqual(
    [media?.state, media?.loaded, media?.segment, media?.points],
    ["running", false, 0, []],
  );
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, snapshot)));
  assert.deepEqual(restored.snapshot, snapshot);
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
    "exit",
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
      "exit",
    ].join("\n"),
    { pacing: true },
  );
  session.load(1, 60_000).load(2, 60_000).at(2_000);
  assert.equal(session.media(1)?.state, "paused");
  assert.equal(session.media(2)?.state, "running");
});

test("an async play whose loaded source leaves no range continues as a failed load", () => {
  const session = new Session(
    'let m = playAudio(file: "a", async: true, startAt: 2 s)\nsay "${m.state} ${m.duration}"\nexit',
  );
  session.load(1, 1_000);
  assert.deepEqual(session.said(), ["stopped 1 s"]);
  assert.equal(session.warnings().filter((warning) => warning.startsWith("TSW013")).length, 1);
});

test("a terminal blocking play still runs finish after an earlier cue in one late observation", () => {
  const session = new Session(
    'playAudio "a.mp3" {\n  at 500 ms {\n    say "cue"\n  }\n  finish {\n    say "finish"\n  }\n}\nexit',
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
      "exit",
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
      "exit",
    ].join("\n"),
  );
  session.load(1, 2_000).at(2_000, [1, 2_000]);
  assert.deepEqual(session.said(), ["first", "second", "finish"]);
});

test("malformed media reports are rejected atomically without changing state or input", () => {
  const compiled = plan('let m = playAudio async "a.mp3"\nwait 10\nexit');
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
      "exit",
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
    'let m = playAudio async "m.mp3" {\n  at 100 ms {\n    say "cue"\n  }\n}\nwait 1 s\nexit';
  const completion = (session: Session) => {
    const event = session.events.find((candidate) => candidate.kind === "complete");
    assert.ok(event !== undefined);
    return event.span;
  };
  const fine = new Session(source).load(1, 1_000).at(100, [1, 100]).at(1_000, [1, 1_000]);
  const late = new Session(source).load(1, 1_000).at(1_000, [1, 1_000]);
  // Completion is attributed to the authored terminal statement.
  const terminal = source.lastIndexOf("wait 1 s");
  assert.deepEqual(
    [completion(fine).start.offset, completion(fine).end.offset],
    [terminal, terminal + "wait 1 s".length],
  );
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
      "exit",
    ].join("\n"),
  );
  // The timer block waits from 400 ms to 600 ms; the cue at 500 ms queues behind it and is dropped by stop().
  session.load(1, 1_000).at(1_000, [1, 1_000]);
  assert.deepEqual(session.said(), ["stopped"]);
  assert.equal(session.snapshot.pendingTimerHandlers.length, 0);
});

test("restore validation keeps elapsed and sample history coherent with scene time", () => {
  const compiled = plan(
    'let m = playAudio async "m.mp3" {\n  at 500 ms {\n    say "cue"\n  }\n}\nwait 10\nexit',
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

test("reporting the projected terminal progress ends fractional ranges, also after a pause or seek", () => {
  const terminal = (session: Session): number => {
    const [media] = mediaPlaybackProjection(session.snapshot);
    assert.notEqual(media?.terminalProgressMs, null);
    return media!.terminalProgressMs!;
  };
  for (const endAt of ["0.1 ms", "10.1 ms", "1000.1 ms"]) {
    for (const repeat of ["3 times", "10 times", "100 times", "1000.3 ms"]) {
      const session = new Session(
        `playAudio(file: "a", repeat: ${repeat}, endAt: ${endAt})\nsay "done"\nexit`,
      );
      session.load(1, 5_000);
      session.at(1, [1, terminal(session)]);
      assert.deepEqual(session.said(), ["done"], `${endAt} ${repeat}`);
      assert.equal(session.media(1)?.points.length, 1, "settled media keeps one sample");
    }
    const controlled = new Session(
      [
        `let m = playAudio(file: "a", async: true, repeat: 7 times, endAt: ${endAt})`,
        "wait 1",
        "m.pause()",
        "m.resume()",
        "m.position = 0.05 ms",
        "wait 1000000",
        "exit",
      ].join("\n"),
    );
    controlled.load(1, 5_000).at(1_000, [1, 0.25]);
    controlled.at(2_000, [1, terminal(controlled)]);
    assert.equal(controlled.media(1)?.state, "finished", endAt);
  }
});

test("restore validation relates segment anchors to the committed cursor and current scene time", () => {
  const corrupt = (
    compiled: InstructionPlan,
    snapshot: RuntimeSnapshot,
    mutate: (media: MutableMedia) => void,
    name: string,
  ): void => {
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true, name);
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(snapshot)) as MutableSnapshot;
    mutate(mediaOf(corrupted, 1));
    assert.equal(validateRuntimeSnapshot(corrupted, compiled).valid, false, name);
  };
  const budget = new Session(
    'let m = playAudio(file: "a", async: true, repeat: 1500 ms) {\n  at 500 ms { }\n}\nwait 10\nexit',
  );
  budget.load(1, 1_000).at(500, [1, 500]);
  corrupt(budget.plan, budget.snapshot, (media) => (media.segmentPositionMs = 100), "position");
  const counted = new Session(
    'let m = playAudio(file: "a", async: true, repeat: 3 times)\nwait 10\nexit',
  );
  counted.load(1, 1_000).at(1_000, [1, 1_000]);
  corrupt(counted.plan, counted.snapshot, (media) => (media.segmentPasses = 1), "passes");
  // A seek during catch-up anchors its segment at the current scene time, before the observed time.
  const held = new Session(
    'timer async 500 ms {\n  b.position = 600 ms\n}\nlet b = playAudio async "b"\nwait 2 s\nexit',
  );
  held.load(1, 2_000);
  let snapshot = observeTime(held.plan, held.snapshot, 1_000, [
    { mediaId: 1, segment: 1, progressMs: 1_000 },
  ]).snapshot;
  for (let step = 0; held.media(1)?.segment === 1 && snapshot.status !== "halted"; step += 1) {
    assert.ok(step < 100, "the timer block's seek must start a new segment");
    snapshot = executeInstruction(held.plan, snapshot).snapshot;
    held.snapshot = snapshot;
  }
  assert.equal(snapshot.currentSessionTimeMs, 500);
  corrupt(
    held.plan,
    snapshot,
    (media) => (media.points[0]!.atMs = 900),
    "future sample after a seek",
  );
});

test("a load report waits for catch-up like host input and anchors at the observed time", () => {
  const compiled = plan(
    'timer async 500 ms {\n  let x = 1\n}\nlet a = playAudio async "a.mp3"\nwait 10\nexit',
  );
  let snapshot = run(compiled, createImmediatePacingRuntimeSnapshot(compiled)).snapshot;
  snapshot = observeTime(compiled, snapshot, 1_000).snapshot;
  assert.equal(snapshot.currentSessionTimeMs, 500);
  const pending = reportMediaLoad(compiled, snapshot, 1, { kind: "loaded", durationMs: 2_000 });
  assert.deepEqual(pending.outcome, { kind: "executionPending", mediaId: 1 });
  assert.deepEqual(pending.snapshot, snapshot);
  assert.deepEqual(pending.events, []);
  snapshot = run(compiled, snapshot).snapshot;
  assert.equal(snapshot.currentSessionTimeMs, 1_000);
  const accepted = reportMediaLoad(compiled, snapshot, 1, { kind: "loaded", durationMs: 2_000 });
  assert.deepEqual(accepted.outcome, { kind: "accepted" });
  const media = accepted.snapshot.backgroundActions.find(
    (action): action is RuntimeMediaActionSnapshot => action.kind === "media",
  )?.media;
  assert.deepEqual(media?.points, [{ atMs: 1_000, progressMs: 0 }]);
  assert.equal(validateRuntimeSnapshot(accepted.snapshot, compiled).valid, true);
});

test("the main path reads and stops media at scene time however late playback is observed", () => {
  const source = [
    'let music = playAudio async "a.mp3"',
    "wait 1",
    'say "${music.position}", instant',
    "music.stop()",
    "wait 1",
    'say "${music.elapsed}", instant',
    "exit",
  ].join("\n");
  const fine = new Session(source).load(1, 10_000);
  fine.at(1_000, [1, 1_000]).at(5_000, [1, 5_000]);
  const late = new Session(source).load(1, 10_000);
  late.at(5_000, [1, 5_000]);
  assert.deepEqual(late.said(), ["1 s", "1 s"]);
  assert.deepEqual(late.said(), fine.said());
  assert.deepEqual(late.media(1)?.positionMs, fine.media(1)?.positionMs);
});

test("restore validation rejects incoherent anchor elapsed and a cue frame of another media", () => {
  const session = new Session(
    [
      'let a = playAudio async "a.mp3" {',
      "  at 500 ms {",
      "    wait 1",
      "  }",
      "}",
      'let b = playAudio async "b.mp3"',
      "wait 10",
      "exit",
    ].join("\n"),
  );
  session.load(1, 2_000).load(2, 2_000).at(600, [1, 600], [2, 600]);
  const valid = session.snapshot;
  assert.equal(validateRuntimeSnapshot(valid, session.plan).valid, true);
  const mutations: readonly (readonly [string, (snapshot: MutableSnapshot) => void])[] = [
    ["anchor elapsed", (snapshot) => (mediaOf(snapshot, 1).segmentElapsedMs = 100)],
    [
      "running cue frame of another media",
      (snapshot) => {
        const frame = snapshot.callFrames.find((candidate) => candidate.timerInterruption !== null);
        assert.ok(frame?.timerInterruption, "a cue block is running");
        frame.timerInterruption.mediaId = 2;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(valid)) as MutableSnapshot;
    mutate(corrupted);
    assert.equal(validateRuntimeSnapshot(corrupted, session.plan).valid, false, name);
  }
});

test("fractional controls, budget ends, and terminal playheads agree with the arrival they reach", () => {
  // A pause exactly when a fractional range end is due keeps that arrival, however coarse the samples.
  const source = [
    "timer async 10 ms {",
    "  m.pause()",
    "}",
    'let m = playAudio(file: "m", async: true, endAt: 10.1 ms) {',
    "  beforeEnd 0 ms {",
    '    say "end"',
    "  }",
    "  finish {",
    '    say "finish ${m.elapsed}"',
    "  }",
    "}",
    "wait 100 ms",
    "exit",
  ].join("\n");
  const fine = new Session(source).load(1, 20).at(10, [1, 10.1]).at(20);
  const late = new Session(source).load(1, 20).at(20, [1, 20.2]);
  assert.deepEqual(fine.said(), ["end", "finish 10.1 ms"]);
  assert.deepEqual(late.said(), fine.said());
  // A repeat duration ending inside the last pass never carries the position past the range.
  const budget = new Session(
    'playAudio(file: "a", repeat: 7.7 ms, endAt: 1.1 ms)\nsay "done"\nexit',
  );
  budget.load(1, 100);
  const [projected] = mediaPlaybackProjection(budget.snapshot);
  budget.at(10, [1, projected!.terminalProgressMs!]);
  assert.deepEqual(budget.said(), ["done"]);
  assert.ok(budget.media(1)!.positionMs <= 1.1);
  // Reported playback at the terminal progress projects the end of the last pass.
  const terminal = new Session(
    'playAudio(file: "a", repeat: 7 times, endAt: 1000.1 ms) {\n  at 500.05 ms {\n    wait 1\n  }\n}\nexit',
  );
  terminal.load(1, 10_000);
  const end = mediaPlaybackProjection(terminal.snapshot)[0]!.terminalProgressMs!;
  terminal.snapshot = observeTime(terminal.plan, terminal.snapshot, 20_000, [
    { mediaId: 1, segment: 1, progressMs: end },
  ]).snapshot;
  const [held] = mediaPlaybackProjection(terminal.snapshot);
  assert.equal(held?.reportedProgressMs, end);
  assert.equal(held?.playheadMs, 1000.1);
});

test("anchor coherence tolerates rounding only at the magnitude of segment progress", () => {
  const corrupt = (session: Session, mutate: (media: MutableMedia) => void, name: string): void => {
    assert.equal(validateRuntimeSnapshot(session.snapshot, session.plan).valid, true, name);
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(session.snapshot)) as MutableSnapshot;
    mutate(mediaOf(corrupted, 1));
    assert.equal(validateRuntimeSnapshot(corrupted, session.plan).valid, false, name);
  };
  const far = new Session(
    'let m = playAudio(file: "a", async: true, startAt: 1000000000000000 ms, endAt: 1000000000001000 ms) {\n  at 1000000000000500 ms { }\n}\nwait 10\nexit',
  );
  far.load(1, 1_000_000_000_002_000).at(500, [1, 500]);
  corrupt(far, (media) => (media.segmentPositionMs += 1), "far anchor position");
  const passes = new Session(
    'let m = playAudio(file: "a", async: true, repeat: 3 times, startAt: 8000000000000000 ms, endAt: 8000000000000010 ms)\nwait 10\nexit',
  );
  passes.load(1, 8_000_000_000_000_100).at(10, [1, 10]);
  corrupt(passes, (media) => (media.segmentPasses = 1), "far anchor passes");
});

test("the playhead projection stays finite and in range at pass counts beyond exact integers", () => {
  for (const [endAt, repeat] of [
    ["0.1 ms", "true"],
    ["1.1 ms", "true"],
    ["0.1 ms", "9007199254740991 times"],
    ["0.0000000000000001 ms", "true"],
  ] as const) {
    const session = new Session(
      `let m = playAudio(file: "a", async: true, repeat: ${repeat}, endAt: ${endAt}) {\n  at 0 ms { }\n}\nwait 10\nexit`,
    );
    session.load(1, 100);
    session.snapshot = observeTime(session.plan, session.snapshot, Number.MAX_SAFE_INTEGER, [
      { mediaId: 1, segment: 1, progressMs: Number.MAX_SAFE_INTEGER },
    ]).snapshot;
    const [media] = mediaPlaybackProjection(session.snapshot);
    assert.ok(
      media !== undefined && media.playheadMs >= 0 && media.playheadMs <= media.endMs!,
      `${endAt} ${repeat}`,
    );
  }
});

test("crossings never become due before an on-time observation could report them", () => {
  // A control at 10 ms on the curve progress = time does not reach a 10.1 ms range end, however late it is observed.
  const control = [
    "timer async 10 ms {",
    "  m.pause()",
    "}",
    'let m = playAudio(file: "m", async: true, endAt: 10.1 ms, repeat: 3 times) {',
    "  beforeEnd 0 ms {",
    '    say "end"',
    "  }",
    "}",
    "wait 100 ms",
    "exit",
  ].join("\n");
  const fine = new Session(control).load(1, 20).at(10, [1, 10]).at(20);
  const late = new Session(control).load(1, 20).at(20, [1, 20]);
  assert.deepEqual(late.said(), fine.said());
  assert.deepEqual(
    [late.media(1)?.elapsedMs, late.media(1)?.passesCompleted],
    [fine.media(1)?.elapsedMs, fine.media(1)?.passesCompleted],
  );
  // An exact sample at a fractional time and an interpolation of the same curve give the same cue time.
  for (const q of [10, 10.1, 10.5, 10.9]) {
    const source = `let clock = timer async 100 ms\nlet m = playAudio(file: "m", async: true, endAt: ${q} ms, repeat: 3 times) {\n  beforeEnd 0 ms {\n    say "\${clock.elapsed}"\n  }\n}\nwait 100 ms\nexit`;
    const exact = new Session(source).load(1, 30).at(q, [1, q]).at(20, [1, 20]);
    const interpolated = new Session(source).load(1, 30).at(20, [1, 20]);
    assert.deepEqual(interpolated.said(), exact.said(), String(q));
  }
});

test("reads at a fractional sample are whole milliseconds like interpolated reads", () => {
  const source = [
    'let m = playAudio async "a"',
    "wait 10 ms",
    'say "${m.position} ${m.elapsed} ${m.remaining}", instant',
    "m.pause()",
    "wait 100 ms",
    "exit",
  ].join("\n");
  const fine = new Session(source).load(1, 1_000).at(10, [1, 10.1]).at(20);
  const late = new Session(source).load(1, 1_000).at(20, [1, 20.2]);
  assert.deepEqual(fine.said(), ["10 ms 10 ms 990 ms"]);
  assert.deepEqual(late.said(), fine.said());
  assert.deepEqual(late.media(1), fine.media(1));
});

test("a load report waits for a due block even when scene time has caught up", () => {
  const compiled = plan(
    'timer async 500 ms {\n  let x = 1\n}\nlet a = playAudio async "a.mp3"\nwait 10\nexit',
  );
  let snapshot = run(compiled, createImmediatePacingRuntimeSnapshot(compiled)).snapshot;
  snapshot = observeTime(compiled, snapshot, 500).snapshot;
  assert.equal(snapshot.currentSessionTimeMs, snapshot.observedSessionTimeMs);
  for (const report of [{ kind: "loaded", durationMs: 2_000 }, { kind: "failed" }] as const) {
    const pending = reportMediaLoad(compiled, snapshot, 1, report);
    assert.deepEqual(pending.outcome, { kind: "executionPending", mediaId: 1 });
    assert.deepEqual(pending.snapshot, snapshot);
    assert.deepEqual(pending.events, []);
  }
  snapshot = run(compiled, snapshot).snapshot;
  const accepted = reportMediaLoad(compiled, snapshot, 1, { kind: "loaded", durationMs: 2_000 });
  assert.deepEqual(accepted.outcome, { kind: "accepted" });
  assert.equal(validateRuntimeSnapshot(accepted.snapshot, compiled).valid, true);
});

test("anchor coherence follows the producing arithmetic exactly", () => {
  const corrupt = (session: Session, mutate: (media: MutableMedia) => void, name: string): void => {
    assert.equal(validateRuntimeSnapshot(session.snapshot, session.plan).valid, true, name);
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(session.snapshot)) as MutableSnapshot;
    const media =
      corrupted.backgroundActions.find((action) => action.media?.mediaId === 1)?.media ??
      corrupted.settledMedia.find((candidate) => candidate.mediaId === 1);
    assert.ok(media !== undefined, name);
    mutate(media);
    assert.equal(validateRuntimeSnapshot(corrupted, session.plan).valid, false, name);
  };
  const large = new Session(
    'let m = playAudio(file: "a", async: true, endAt: 8000000000001000 ms) {\n  at 8000000000000000 ms { }\n  at 8000000000000100 ms { }\n}\nwait 9000000000000000 ms\nexit',
  );
  large.load(1, 8_000_000_000_002_000).at(8_000_000_000_000_000, [1, 8_000_000_000_000_000]);
  corrupt(large, (media) => (media.segmentPositionMs = 1), "large progress anchor");
  const duration = new Session(
    'let m = playAudio(file: "a", async: true, startAt: 8000000000000000 ms, endAt: 8000000000001000 ms, repeat: 500 ms)\nwait 10\nexit',
  );
  duration.load(1, 8_000_000_000_002_000).at(500, [1, 500]);
  corrupt(duration, (media) => (media.positionMs += 1), "duration finish position");
  for (const repeat of ["false", "3 times"]) {
    const counted = new Session(
      `let m = playAudio(file: "a", async: true, endAt: 1000 ms, repeat: ${repeat})\nwait 10\nexit`,
    );
    const end = repeat === "false" ? 1_000 : 3_000;
    counted.load(1, 1_000).at(end, [1, end]);
    corrupt(counted, (media) => (media.positionMs = 0), `finished ${repeat} at the start`);
  }
  const aligned = new Session(
    'let m = playAudio(file: "a", async: true, endAt: 1000 ms, repeat: 2000 ms)\nwait 10\nexit',
  );
  aligned.load(1, 1_000).at(2_000, [1, 2_000]);
  corrupt(aligned, (media) => (media.positionMs = 0), "duration ending at a pass end");
  // Genuine states at rounding edges stay valid: a wrapped start beyond the previous pass end, and a repeat duration
  // that ends exactly at a cue arrival.
  new Session(
    'let m = playAudio(file: "a", async: true, repeat: 7 times, endAt: 1.1 ms)\nwait 10\nexit',
  )
    .load(1, 100)
    .at(1, [1, 6.6]);
  new Session(
    'let m = playAudio(file: "m", async: true, startAt: 0.1 ms, endAt: 0.3 ms, repeat: 0.7 ms) {\n  at 0.2 ms { }\n}\nwait 10\nexit',
  )
    .load(1, 5_000)
    .at(16, [1, 0.7]);
});

test("crossings and reads use the exact reported values", () => {
  const crossing = new Session(
    'let clock = timer async 100 ms\nlet m = playAudio async "a" {\n  at 1.7 ms {\n    say "${clock.elapsed}", instant\n  }\n}\nwait 100 ms\nexit',
  );
  crossing.load(1, 100).at(3, [1, 5.1]);
  assert.deepEqual(crossing.said(), ["2 ms"]);
  const read = new Session(
    'let m = playAudio async "a"\nwait 5 ms\nsay "${m.position} ${m.elapsed} ${m.remaining}", instant\nm.pause()\nwait 100 ms\nexit',
  );
  read.load(1, 100).at(6, [1, 0.6]);
  assert.deepEqual(read.said(), ["0 s 0 s 100 ms"]);
});

test("a terminal playhead stays at the range end beyond exactly countable passes", () => {
  for (const [endAt, repeat] of [
    ["0.7 ms", "9007199254740991 times"],
    ["0.00000000000001 ms", "9007199254740991 times"],
    ["0.0625 ms", "1000000000000000 ms"],
    ["0.1 ms", "1000000000000000 ms"],
  ] as const) {
    const session = new Session(
      `let m = playAudio(file: "a", async: true, repeat: ${repeat}, endAt: ${endAt}) {\n  at 0 ms { }\n}\nwait 1000000\nexit`,
    );
    session.load(1, 100);
    const terminal = mediaPlaybackProjection(session.snapshot)[0]!.terminalProgressMs!;
    session.snapshot = observeTime(session.plan, session.snapshot, 1, [
      { mediaId: 1, segment: 1, progressMs: terminal },
    ]).snapshot;
    const [media] = mediaPlaybackProjection(session.snapshot);
    const playhead = media?.playheadMs ?? Number.NaN;
    if (endAt === "0.1 ms") {
      // The double nearest 0.1 ms does not divide the repeat duration, so it ends inside a pass and stays there.
      assert.ok(
        Number.isFinite(playhead) && playhead > 0 && playhead < media!.endMs!,
        String(playhead),
      );
    } else {
      assert.equal(playhead, media?.endMs, `${endAt} ${repeat}`);
    }
  }
});

test("a repeat duration ends inside its stretch, after its exact cue arrival, and before any departure", () => {
  // After a seek and a wrap, the duration's end stays inside the range and can be saved.
  const seek = new Session(
    'let m = playAudio(file: "m", async: true, startAt: 0.3 ms, endAt: 1000 ms, repeat: 1.0000000000000002 ms)\nm.position = 999 ms\nwait 100 ms\nexit',
  );
  seek.load(1, 1_000).at(2, [1, 1.0000000000000002]);
  const finished = seek.media(1)!;
  assert.equal(finished.state, "finished");
  assert.ok(finished.positionMs >= 0.3 && finished.positionMs <= 1_000);
  // A duration ending at the cue it reached fires that cue once.
  const atCue = new Session(
    'let m = playAudio(file: "m", async: true, startAt: 1.1 ms, endAt: 10.3 ms, repeat: 2.3000000000000007 ms) {\n  at 3.4000000000000004 ms {\n    say "Q", instant\n  }\n  at 5.700000000000001 ms {\n    say "C", instant\n  }\n}\nwait 100 ms\nexit',
  );
  atCue.load(1, 100).at(5, [1, 2.3000000000000007]);
  assert.deepEqual(atCue.said(), ["Q"]);
  // A duration used up where a pause left start cues pending fires them and finishes.
  const paused = new Session(
    [
      "timer async 16 ms {",
      "  m.pause()",
      "  m.resume()",
      "}",
      'let m = playAudio(file: "m", async: true, endAt: 1 ms, repeat: 0.5 ms) {',
      "  at 0.5 ms {",
      '    say "C", instant',
      "  }",
      "  finish {",
      '    say "F", instant',
      "  }",
      "}",
      "wait 1000 ms",
      "exit",
    ].join("\n"),
  );
  paused.load(1, 100).at(32, [1, 1]);
  assert.deepEqual(paused.said(), ["C", "F"]);
});

test("restore validation accepts only positions the runtime can stand on", () => {
  const corrupt = (session: Session, mutate: (media: MutableMedia) => void, name: string): void => {
    assert.equal(validateRuntimeSnapshot(session.snapshot, session.plan).valid, true, name);
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(session.snapshot)) as MutableSnapshot;
    const media =
      corrupted.backgroundActions.find((action) => action.media?.mediaId === 1)?.media ??
      corrupted.settledMedia.find((candidate) => candidate.mediaId === 1);
    assert.ok(media !== undefined, name);
    mutate(media);
    assert.equal(validateRuntimeSnapshot(corrupted, session.plan).valid, false, name);
  };
  const wrapped = new Session(
    'let m = playAudio(file: "a", async: true, endAt: 1.1 ms, repeat: 3 times)\nwait 2 ms\nwait 200 ms\nexit',
  );
  wrapped.load(1, 100).at(1, [1, 1.1]);
  corrupt(wrapped, (media) => (media.positionMs = Number.MIN_VALUE), "wrapped start alias");
  const tail = new Session(
    'let m = playAudio(file: "a", async: true, endAt: 1000000000000000.1 ms, repeat: 6700000000000001 ms)\nwait 8000000000000000 ms\nexit',
  );
  tail.load(1, 1_000_000_000_000_000.1).at(6_700_000_000_000_001, [1, 6_700_000_000_000_001]);
  corrupt(tail, (media) => (media.positionMs += 0.125), "duration tail alias");
});

test("restore validation never coerces media settlement enumerations to text", () => {
  const session = new Session('let a = playAudio async "a.mp3"\nwait 10\nexit').load(1, 1_000);
  const settlement = session.snapshot.lastSettlement;
  assert.equal(settlement?.actionKind, "mediaPlayback");
  for (const field of ["outcome", "actionKind"] as const) {
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(session.snapshot)) as {
      lastSettlement: Record<string, unknown>;
    };
    // A one-element array stringifies to its element, so only an exact type check rejects it.
    corrupted.lastSettlement[field] = [corrupted.lastSettlement[field]];
    assert.equal(validateRuntimeSnapshot(corrupted, session.plan).valid, false, field);
    // Without the plan, only the settlement's own shape rules apply.
    assert.equal(validateRuntimeSnapshot(corrupted).valid, false, `${field} without the plan`);
  }
});

test("restore validation accepts exactly the cursors the runtime's own arrivals produce", () => {
  const corrupt = (session: Session, mutate: (media: MutableMedia) => void, name: string): void => {
    assert.equal(validateRuntimeSnapshot(session.snapshot, session.plan).valid, true, name);
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(session.snapshot)) as MutableSnapshot;
    const media =
      corrupted.backgroundActions.find((action) => action.media?.mediaId === 1)?.media ??
      corrupted.settledMedia.find((candidate) => candidate.mediaId === 1);
    assert.ok(media !== undefined, name);
    mutate(media);
    assert.equal(validateRuntimeSnapshot(corrupted, session.plan).valid, false, name);
  };
  const counted = (cue = "") =>
    new Session(
      `let m = playAudio(file: "a", async: true, endAt: 1000 ms, repeat: 3 times)${cue}\nwait 10\nexit`,
    ).load(1, 1_000);
  corrupt(counted(), (media) => (media.positionMs = 5), "anchor position");
  corrupt(counted(), (media) => (media.passesCompleted = 1), "anchor passes");
  corrupt(
    counted().at(1_000, [1, 1_000]),
    (media) => (media.committedProgressMs = 999),
    "wrap progress",
  );
  corrupt(
    counted(" {\n  at 500 ms { }\n}").at(1_000, [1, 1_000]),
    (media) => (media.positionMs = 500),
    "wrapped start moved to a cue",
  );
  const seek = new Session(
    'let m = playAudio(file: "a", async: true, endAt: 1000 ms, repeat: 3 times)\nm.position = 0.01 ms\nwait 10\nexit',
  ).load(1, 1_000);
  corrupt(seek, (media) => (media.positionMs = 0), "seek anchor moved to the range start");
  const duration = (cues: string) =>
    new Session(
      `let m = playAudio(file: "a", async: true, endAt: 1000 ms, repeat: 500 ms) {\n${cues}\n}\nwait 10\nexit`,
    )
      .load(1, 1_000)
      .at(500, [1, 500]);
  corrupt(duration("  at 600 ms { }"), (media) => (media.positionMs = 600), "unreached cue");
  corrupt(duration("  at 400 ms { }"), (media) => (media.positionMs = 400), "earlier cue");
  corrupt(duration("  at 0 ms { }"), (media) => (media.positionMs = 0), "start cue");
  corrupt(
    duration(""),
    (media) => {
      media.positionMs = 1_000;
      media.passesCompleted = 1;
    },
    "duration moved to the range end",
  );
  corrupt(
    new Session(
      'let m = playAudio(file: "a", async: true, endAt: 10 ms, repeat: 2 times) {\n  at 5 ms { }\n}\nwait 10\nexit',
    )
      .load(1, 10)
      .at(5, [1, 5]),
    (media) => (media.startCuesPending = true),
    "start cues pending at an interior cue",
  );
});

test("position reads and the terminal playhead use the arrival the timeline commits", () => {
  const read = new Session(
    [
      'timer async 3 ms { say "before ${m.position}", instant }',
      'let m = playAudio(file: "m", async: true, startAt: 0 ms, endAt: 4503599627370496 ms, repeat: 1.125 ms) {',
      '  at 0.1 ms { say "C ${m.position}", instant }',
      '  finish { say "after ${m.position}", instant }',
      "}",
      "m.position = 4503599627370495 ms",
      "wait 100 ms",
      "exit",
    ].join("\n"),
  );
  read.load(1, 4_503_599_627_370_496).at(2, [1, 1]).at(4, [1, 1.25]);
  assert.deepEqual(read.said(), ["C 0.1 ms", "before 0.1 ms", "after 0.1 ms"]);
  const terminal = new Session(
    'let m = playAudio(file: "a", async: true, startAt: 1.1 ms, endAt: 1000.3 ms, repeat: 2498 ms) {\n  at 1.1 ms { }\n}\nwait 10000 ms\nexit',
  );
  terminal.load(1, 2_000);
  terminal.snapshot = observeTime(terminal.plan, terminal.snapshot, 2_499, [
    { mediaId: 1, segment: 1, progressMs: 2_498 },
  ]).snapshot;
  const projected = mediaPlaybackProjection(terminal.snapshot)[0]!.playheadMs;
  terminal.at(2_500);
  assert.equal(terminal.media(1)?.state, "finished");
  assert.equal(projected, terminal.media(1)?.positionMs);
});

test("restore validation ties start cues and queued cue counts to playback since loading", () => {
  const source =
    'let m = playAudio(file: "a", async: true, endAt: 10 ms) {\n  at 0 ms { say "start", instant }\n  at 5 ms { say "cue", instant }\n  finish { say "finish", instant }\n}\nwait 100 ms\nexit';
  const rejects = (
    snapshot: RuntimeSnapshot,
    compiled: InstructionPlan,
    mutate: (state: MutableSnapshot) => void,
    name: string,
  ): void => {
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true, name);
    // EVIDENCE: JSON serialization preserves the validated snapshot's plain-data shape; each case applies one invalid mutation.
    const corrupted = JSON.parse(JSON.stringify(snapshot)) as MutableSnapshot;
    mutate(corrupted);
    assert.equal(validateRuntimeSnapshot(corrupted, compiled).valid, false, name);
  };
  const compiled = plan(source);
  let snapshot = run(compiled, createImmediatePacingRuntimeSnapshot(compiled)).snapshot;
  snapshot = run(
    compiled,
    reportMediaLoad(compiled, snapshot, 1, { kind: "loaded", durationMs: 10 }).snapshot,
  ).snapshot;
  rejects(
    snapshot,
    compiled,
    (state) => (mediaOf(state, 1).startCuesPending = false),
    "start cue cleared before departing",
  );
  const departed = observeTime(compiled, snapshot, 1, [
    { mediaId: 1, segment: 1, progressMs: 1 },
  ]).snapshot;
  rejects(
    departed,
    compiled,
    (state) => (mediaOf(state, 1).startCuesPending = true),
    "start cue pending after it was queued",
  );
  const atCue = observeTime(compiled, snapshot, 5, [
    { mediaId: 1, segment: 1, progressMs: 5 },
  ]).snapshot;
  rejects(
    atCue,
    compiled,
    (state) => {
      const invocation = state.pendingTimerHandlers.at(-1)!;
      invocation.count = 2;
    },
    "cue queued more often than reached",
  );
  // A start cue that pauses its media leaves a valid paused anchor without later samples.
  const pausing = new Session(
    'let m = playAudio(file: "a", async: true, endAt: 10 ms) {\n  at 0 ms {\n    m.pause()\n  }\n}\nwait 100 ms\nexit',
  );
  pausing.load(1, 10).at(1, [1, 1]);
  assert.equal(pausing.media(1)?.state, "paused");
});

test("held projections and reads at an arrival use the position the timeline commits there", () => {
  // A held nonterminal cue arrival projects the exact cue position.
  const cue = new Session(
    [
      "timer async 5 ms {",
      "  let x = 1",
      "}",
      'let m = playAudio(file: "a", async: true, startAt: 0.2 ms, endAt: 10.3 ms, repeat: 3 times) {',
      "  at 0.9 ms { }",
      "}",
      "wait 1000 ms",
      "exit",
    ].join("\n"),
  );
  cue.load(1, 100);
  cue.snapshot = observeTime(cue.plan, cue.snapshot, 5, [
    { mediaId: 1, segment: 1, progressMs: 0.7 },
  ]).snapshot;
  assert.equal(mediaPlaybackProjection(cue.snapshot)[0]!.playheadMs, 0.9);
  // A held first-pass duration end at a cue projects that cue exactly.
  const terminal = new Session(
    'let m = playAudio(file: "m", async: true, startAt: 1.1 ms, endAt: 10.3 ms, repeat: 2.3000000000000007 ms) {\n  at 1.1 ms { }\n  at 3.4000000000000004 ms { }\n}\nwait 100 ms\nexit',
  );
  terminal.load(1, 100);
  terminal.snapshot = observeTime(terminal.plan, terminal.snapshot, 5, [
    { mediaId: 1, segment: 1, progressMs: 2.3000000000000007 },
  ]).snapshot;
  assert.equal(mediaPlaybackProjection(terminal.snapshot)[0]!.playheadMs, 3.4000000000000004);
  // `remaining` read just before a duration arrival agrees with the position committed there.
  const remaining = new Session(
    [
      "let saved = 0 ms",
      "timer async 2498 ms {",
      // `remaining` is null while the media's length is unknown, so it is checked first.
      "  let left = m.remaining",
      "  if left != null {",
      "    saved = left",
      "  }",
      "}",
      'let m = playAudio(file: "a", async: true, startAt: 1.1 ms, endAt: 1000.3 ms, repeat: 2498 ms) {',
      "  finish {",
      '    say "${saved == 1000.3 ms - m.position}", instant',
      "  }",
      "}",
      "wait 10000 ms",
      "exit",
    ].join("\n"),
  );
  remaining.load(1, 2_000).at(2_498, [1, 2_498]);
  assert.deepEqual(remaining.said(), ["true"]);
});

test("a control at the end of a pass leaves pending start cues at the start until playback departs", () => {
  for (const control of ["m.pause()", "m.stop()"]) {
    const session = new Session(
      `let m = playAudio(file: "a", async: true, startAt: 1.1 ms, endAt: 3.4000000000000004 ms, repeat: 3 times) {\n  at 1.1 ms { say "start", instant }\n  beforeEnd 0 ms { ${control} }\n}\nwait 100 ms\nexit`,
    );
    session.load(1, 100).at(50, [1, 50]);
    const media = session.media(1)!;
    assert.equal(media.positionMs, 1.1, control);
    if (control === "m.pause()") assert.equal(media.startCuesPending, true, control);
    assert.equal(validateRuntimeSnapshot(session.snapshot, session.plan).valid, true, control);
  }
});

test("a late observation across silent repeat passes equals observing every pass end on time", () => {
  // Pass ends without in-range cues are skipped arithmetically during catch-up (docs/RUNTIME.md). The oracle observes
  // in 5-millisecond steps, shorter than every pass here, so it commits each pass end separately.
  const scenarios = [
    'let m = playAudio(file: "a", async: true, endAt: 5.1 ms, repeat: true)\nwait 997 ms\nsay "${m.elapsed} ${m.position}"',
    'let m = playAudio(file: "a", async: true, endAt: 6.3 ms, repeat: 150 times) {\n  finish { say "done" }\n}\nwait 1000 ms\nsay "${m.state} ${m.elapsed}"',
    'let m = playAudio(file: "a", async: true, startAt: 0.05 ms, endAt: 6.3 ms, repeat: 777.7 ms) {\n  finish { say "done ${m.position}" }\n}\nwait 1000 ms',
    'let m = playAudio(file: "a", async: true, startAt: 2 ms, endAt: 9.3 ms, repeat: true) {\n  at 1 ms { say "never" }\n}\nm.position = 2.4 ms\nwait 500 ms\nsay "${m.elapsed} ${m.position}"',
    'let m = playAudio(file: "a", async: true, endAt: 7.5 ms, repeat: true)\nlet t = timer(duration: 97 ms, async: true, repeat: true) { say "${m.elapsed} ${m.position}" }\nwait 1000 ms',
    // A lower action ID at a pass end's exact time runs before that pass end commits, so it reads the arrival unwrapped.
    'timer async 100 ms { say "${m.position}" }\nlet m = playAudio(file: "a", async: true, endAt: 10 ms, repeat: true)\nwait 150 ms\nsay "${m.elapsed}"',
    'let m = playAudio(file: "a", async: true, endAt: 5.7 ms, repeat: true)\nlet n = playAudio(file: "b", async: true, endAt: 8.9 ms, repeat: 100 times)\nwait 1000 ms\nsay "${m.position} ${n.state} ${n.elapsed}"',
  ];
  for (const source of scenarios) {
    const start = (): Session => {
      const session = new Session(source).load(1, 10);
      return session.media(2) === undefined ? session : session.load(2, 10);
    };
    const reports = (session: Session, nowMs: number): [number, number][] =>
      [1, 2].flatMap((mediaId): [number, number][] =>
        session.media(mediaId)?.state === "running" ? [[mediaId, nowMs]] : [],
      );
    const fine = start();
    for (let nowMs = 5; nowMs <= 1_200; nowMs += 5) fine.at(nowMs, ...reports(fine, nowMs));
    const late = start();
    late.at(1_200, ...reports(late, 1_200));
    assert.deepEqual(late.events, fine.events, source);
    assert.deepEqual(late.said(), fine.said(), source);
    assert.ok(late.said().length > 0, source);
    assert.deepEqual(late.media(1), fine.media(1), source);
    assert.deepEqual(late.media(2), fine.media(2), source);
    assert.equal(late.snapshot.status, fine.snapshot.status, source);
  }
});

test("catch-up across 10^12 silent repeat passes finishes within the bound with on-time values", () => {
  const forever = new Session(
    'let m = playAudio(file: "a", async: true, endAt: 1 ms, repeat: true)\nwait 1000000000 s\nsay "${m.elapsed == 1000000000 s}"',
  )
    .load(1, 10)
    .atBounded(1e12, [1, 1e12]);
  assert.deepEqual(forever.said(), ["true"]);
  assert.equal(forever.media(1)?.passesCompleted, 1e12);

  const counted = new Session(
    'let m = playAudio(file: "a", async: true, endAt: 1 ms, repeat: 1000000000000 times) {\n  finish { say "done ${m.elapsed == 1000000000 s}" }\n}\nwait 2000000000 s',
  )
    .load(1, 10)
    .atBounded(2e12, [1, 2e12]);
  assert.deepEqual(counted.said(), ["done true"]);
  assert.equal(counted.media(1)?.state, "finished");
  assert.equal(counted.media(1)?.passesCompleted, 1e12);

  const budget = new Session(
    'let m = playAudio(file: "a", async: true, endAt: 1.5 ms, repeat: 1000000000.25 s) {\n  finish { say "done ${m.position}" }\n}\nwait 2000000000 s',
  )
    .load(1, 10)
    .atBounded(2e12, [1, 2e12]);
  assert.equal(budget.media(1)?.state, "finished");
  assert.equal(budget.media(1)?.elapsedMs, 1_000_000_000_250);
  assert.equal(budget.said().length, 1);
});
