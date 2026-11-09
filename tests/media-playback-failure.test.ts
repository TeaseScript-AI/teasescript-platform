import assert from "node:assert/strict";
import test from "node:test";
import {
  createCheckpoint,
  deserializeCheckpoint,
  observeTime,
  reportMediaLoad,
  run,
  serializeCheckpoint,
  validateRuntimeSnapshot,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
} from "../src/index.js";
import type { RuntimeMediaActionSnapshot } from "../src/runtime/actions/model.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

// A playback failure after load (#2113): the Player reports `failed` for media it already reported `loaded`, as when the
// browser's audio output errors. It stops the media as a stop does and releases its wait, so the script goes on.

/** A scripted Player over real source: each operation validates the snapshot and continues execution. */
class Session {
  readonly plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
  readonly events: InterpreterEvent[] = [];

  constructor(source: string) {
    this.plan = plan(source);
    this.snapshot = createImmediatePacingRuntimeSnapshot(this.plan);
    this.#run();
  }

  report(mediaId: number, report: { kind: "loaded"; durationMs: number } | { kind: "failed" }) {
    const result = reportMediaLoad(this.plan, this.snapshot, mediaId, report);
    this.#apply(result);
    return result.outcome.kind;
  }

  load(mediaId: number, durationMs: number): this {
    assert.equal(this.report(mediaId, { kind: "loaded", durationMs }), "accepted");
    return this;
  }

  fail(mediaId: number): this {
    assert.equal(this.report(mediaId, { kind: "failed" }), "accepted");
    return this;
  }

  /** Observes scene time with progress reports `[mediaId, progressMs]` for the media's current segment. */
  at(nowMs: number, ...reports: readonly (readonly [number, number])[]): this {
    this.#apply(
      observeTime(
        this.plan,
        this.snapshot,
        nowMs,
        reports.map(([mediaId, progressMs]) => ({
          mediaId,
          segment: this.#media(mediaId)?.segment ?? 0,
          progressMs,
        })),
      ),
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

  /** Each media and media-wait settlement, in order. */
  settlements(): string[] {
    return this.events.flatMap((event) =>
      event.kind === "actionCompleted" && event.settlement.actionKind === "media"
        ? [`${event.settlement.mediaId} ${event.settlement.settlementKind}`]
        : event.kind === "actionCompleted" && event.settlement.actionKind === "mediaPlayback"
          ? [`wait ${event.settlement.mediaId} ${event.settlement.outcome}`]
          : [],
    );
  }

  #media(mediaId: number) {
    return this.snapshot.backgroundActions.find(
      (action): action is RuntimeMediaActionSnapshot =>
        action.kind === "media" && action.media.mediaId === mediaId,
    )?.media;
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

test("a blocking play that fails after load warns, stops, and releases its wait without later cues or finish", () => {
  const session = new Session(
    [
      'playAudio "bell.mp3" {',
      "  at 1 s {",
      '    say "played cue"',
      "  }",
      "  at 5 s {",
      '    say "never: later cue"',
      "  }",
      "  finish {",
      '    say "never: finish"',
      "  }",
      "}",
      'say "after"',
      "exit",
    ].join("\n"),
  );
  session.load(1, 10_000).at(2_000, [1, 2_000]);
  assert.deepEqual(session.said(), ["played cue"]);
  session.fail(1);
  assert.deepEqual(session.said(), ["played cue", "after"]);
  assert.deepEqual(session.warnings(), ['TSW013 Media "bell.mp3" could not be played.']);
  assert.deepEqual(session.settlements(), ["1 stopped", "wait 1 stopped"]);
  assert.equal(session.snapshot.status, "halted");
});

test("an async play that fails after load stops, keeps its duration, and leaves the foreground wait alone", () => {
  const session = new Session(
    [
      'let m = playAudio async "music.mp3"',
      "wait 10 s",
      'say "${m.state} ${m.duration} ${m.remaining}"',
      "exit",
    ].join("\n"),
  );
  session.load(1, 90_000).at(1_000, [1, 1_000]).fail(1);
  assert.equal(session.snapshot.foregroundAction?.kind, "delay");
  assert.deepEqual(session.said(), []);
  session.at(10_000);
  assert.deepEqual(session.said(), ["stopped 1 minute 30 seconds 0 seconds"]);
  assert.deepEqual(session.settlements(), ["wait 1 loaded", "1 stopped"]);
});

test("a failure while a cue block runs lets that block complete and drops the cues not yet started", () => {
  const session = new Session(
    [
      'playAudio "bell.mp3" {',
      "  at 1 s {",
      '    say "cue starts"',
      "    wait 5 s",
      '    say "cue ends"',
      "  }",
      "  at 3 s {",
      '    say "never: queued cue"',
      "  }",
      "}",
      'say "after"',
      "exit",
    ].join("\n"),
  );
  session.load(1, 10_000).at(1_000, [1, 1_000]);
  assert.deepEqual(session.said(), ["cue starts"]);
  session.fail(1).at(6_000);
  assert.deepEqual(session.said(), ["cue starts", "cue ends", "after"]);
  assert.deepEqual(session.settlements(), ["1 stopped", "wait 1 stopped"]);
});

test("a failure after load waits for catch-up like host input, unchanged, and is accepted on retry", () => {
  const compiled = plan(
    'timer async 500 ms {\n  let x = 1\n}\nlet a = playAudio async "a.mp3"\nwait 10 s\nexit',
  );
  let snapshot = run(compiled, createImmediatePacingRuntimeSnapshot(compiled)).snapshot;
  snapshot = run(
    compiled,
    reportMediaLoad(compiled, snapshot, 1, { kind: "loaded", durationMs: 5_000 }).snapshot,
  ).snapshot;
  snapshot = observeTime(compiled, snapshot, 1_000).snapshot;
  assert.equal(snapshot.currentSessionTimeMs, 500);
  const pending = reportMediaLoad(compiled, snapshot, 1, { kind: "failed" });
  assert.deepEqual(pending.outcome, { kind: "executionPending", mediaId: 1 });
  assert.deepEqual(pending.snapshot, snapshot);
  assert.deepEqual(pending.events, []);
  snapshot = run(compiled, snapshot).snapshot;
  const accepted = reportMediaLoad(compiled, snapshot, 1, { kind: "failed" });
  assert.deepEqual(accepted.outcome, { kind: "accepted" });
  assert.equal(validateRuntimeSnapshot(accepted.snapshot, compiled).valid, true);
});

test("a second failure, a second load, and a report for media that finished are ignored", () => {
  const failed = new Session('let m = playAudio async "music.mp3"\nwait 10 s\nexit');
  failed.load(1, 5_000);
  assert.equal(failed.report(1, { kind: "loaded", durationMs: 5_000 }), "ignored");
  failed.fail(1);
  assert.equal(failed.report(1, { kind: "failed" }), "ignored");
  assert.deepEqual(failed.settlements(), ["wait 1 loaded", "1 stopped"]);

  const finished = new Session('playAudio "bell.mp3"\nwait 10 s\nexit');
  finished.load(1, 2_000).at(2_000, [1, 2_000]);
  assert.deepEqual(finished.settlements(), ["1 finished", "wait 1 finished"]);
  assert.equal(finished.report(1, { kind: "failed" }), "ignored");
});

test("the state a playback failure leaves survives a checkpoint round trip and goes on as before", () => {
  const session = new Session(
    'let m = playAudio async "music.mp3"\nwait 3 s\nsay "${m.state}"\nexit',
  );
  session.load(1, 5_000).at(1_000, [1, 1_000]).fail(1);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(session.plan, session.snapshot)),
  );
  assert.deepEqual(restored.snapshot, session.snapshot);
  const resumed = run(restored.plan, observeTime(restored.plan, restored.snapshot, 3_000).snapshot);
  session.at(3_000);
  assert.deepEqual(resumed.snapshot, session.snapshot);
  assert.deepEqual(session.said(), ["stopped"]);
});
