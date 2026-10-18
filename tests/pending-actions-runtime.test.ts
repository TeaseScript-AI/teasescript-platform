import assert from "node:assert/strict";
import test from "node:test";

import {
  createFreshRuntimeSession,
  runtimeTimedWork,
  type RuntimeSession,
  type RuntimeTimedWork,
} from "../src/index.js";
import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-construction.js";

test("wait lowers to a foreground delay and settles only after an explicit observation", () => {
  const compiled = plan('wait 1.5 s\nsay "done"\nexit');
  const waiting = run(compiled, createImmediatePacingRuntimeSnapshot(compiled));
  assert.equal(waiting.snapshot.status, "waiting");
  assert.ok(waiting.snapshot.foregroundAction?.kind === "delay");
  assert.equal(waiting.snapshot.foregroundAction.deadlineMs, 1500);
  assert.deepEqual(
    waiting.events.map((event) => event.kind),
    ["actionRequested"],
  );

  const early = observeTime(compiled, waiting.snapshot, 1499);
  assert.equal(early.outcome.kind, "observed");
  assert.equal(early.snapshot.status, "waiting");
  assert.equal(early.events.length, 0);

  const due = observeTime(compiled, early.snapshot, 1500);
  assert.equal(due.snapshot.status, "running");
  assert.deepEqual(
    due.events.map((event) => event.kind),
    ["actionCompleted"],
  );
  const done = run(compiled, due.snapshot);
  assert.equal(done.snapshot.status, "halted");
  assert.deepEqual(
    done.events.map((event) => event.kind),
    ["say", "exit"],
  );
});

test("negative static waits fail compilation and backward observations never move session time backward", () => {
  // ADR 0016: a statically provable negative duration is a compile-time error at the duration, whether it is a
  // negated literal or folded from arithmetic.
  for (const [source, end] of [
    ["wait -1 s", 9],
    ["wait (1 - 2) s", 12],
    ["wait 1 s - 2 s", 14],
  ] as const) {
    assert.deepEqual(
      compileSource(source).diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      [["TSV011", 5, end]],
      source,
    );
  }
  const compiled = plan("wait 1 ms\nexit");
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled, { initialSessionTimeMs: 10 }));
  const observation = observeTime(compiled, waiting.snapshot, 2);
  assert.equal(observation.snapshot.currentSessionTimeMs, 10);
});

test("typed completion is idempotent and classifies time-driven, stale, and unknown IDs", () => {
  const timed = plan("wait 10 ms\nexit");
  const waiting = run(timed, createFreshRuntimeSnapshot(timed));
  const callerBefore = structuredClone(waiting.snapshot);
  const delay = completeAction(timed, waiting.snapshot, {
    actionId: waiting.snapshot.foregroundAction!.actionId,
    actionKind: "delay",
    payload: { kind: "time", currentSessionTimeMs: 10 },
  });
  assert.equal(
    delay.outcome.kind,
    "invalidPayload",
    "time reaches a wait only through observation",
  );
  assert.deepEqual(delay.events, []);
  assert.deepEqual(delay.snapshot, callerBefore);
  assert.deepEqual(waiting.snapshot, callerBefore);

  const compiled = plan('showButton "A"\nshowButton "B"\nexit');
  const first = run(compiled, createFreshRuntimeSnapshot(compiled));
  const actionId = first.snapshot.foregroundAction!.actionId;
  const press = (snapshot: typeof first.snapshot, id: number) =>
    completeAction(compiled, snapshot, {
      actionId: id,
      actionKind: "interaction",
      interactionKind: "button",
      payload: { kind: "activate" },
    });
  const settled = press(first.snapshot, actionId);
  assert.equal(settled.outcome.kind, "completed");
  const duplicate = press(settled.snapshot, actionId);
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  assert.deepEqual(duplicate.events, []);
  const secondWaiting = run(compiled, settled.snapshot);
  const secondId = secondWaiting.snapshot.foregroundAction!.actionId;
  const secondSettled = press(secondWaiting.snapshot, secondId);
  assert.equal(press(secondSettled.snapshot, actionId).outcome.kind, "staleAction");
  assert.equal(press(secondSettled.snapshot, secondId + 1).outcome.kind, "unknownAction");
});

test("runtimeTimedWork lists the work that comes due by time, which is where a host observes next", () => {
  const immediate = { seed: 5, baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 };
  const due = (session: RuntimeSession) =>
    runtimeTimedWork(session.view())
      .map(({ kind, deadlineMs, silent, drawsNextRound }) => ({
        kind,
        deadlineMs,
        silent,
        drawsNextRound,
      }))
      .sort((left, right) => left.deadlineMs - right.deadlineMs);
  const work = (kind: RuntimeTimedWork["kind"], deadlineMs: number, silent = false) => ({
    kind,
    deadlineMs,
    silent,
    drawsNextRound: false,
  });

  // A reading time and timer rounds: a round of a repeating timer without a block runs nothing, and a range draws
  // each next round.
  const timers = createFreshRuntimeSession(
    plan(
      [
        "let silent = timer(duration: 1 s, async: true, repeat: true)",
        "let ranged = timer(duration: (2..=3) s, async: true, repeat: true)",
        'let ticking = timer(duration: 1500 ms, async: true, repeat: true) {\n  say "tick", instant\n}',
        'say "Read this", 4 s',
        "exit",
      ].join("\n"),
    ),
    immediate,
  );
  timers.run();
  const [first, second, third, fourth] = due(timers);
  assert.deepEqual([first, second], [work("timer", 1_000, true), work("timer", 1_500)]);
  assert.deepEqual(fourth, work("chatPacingGate", 4_000));
  assert.ok(third?.kind === "timer" && third.silent && third.drawsNextRound, JSON.stringify(third));
  assert.ok(third.deadlineMs >= 2_000 && third.deadlineMs <= 3_000, JSON.stringify(third));

  // A presented button times out, but stands still while a block that waits interrupts it.
  const button = createFreshRuntimeSession(
    plan('timer async 1 s {\n  wait 2 s\n}\nlet e = showButton "Go", timeout: 5 s\nexit'),
    immediate,
  );
  button.run();
  assert.deepEqual(due(button), [work("timer", 1_000), work("interaction", 5_000)]);
  button.observeTime(1_000);
  button.run();
  assert.equal(button.view().suspendedAction?.kind, "interaction");
  assert.deepEqual(due(button), [work("delay", 3_000)]);
  button.observeTime(3_000);
  button.run();
  assert.deepEqual(due(button), [work("interaction", 7_000)]);

  // A media event comes due once reported progress reached it. While a cue's block is queued, the foreground wait
  // stands still and the next cue the progress covers waits for it.
  const media = createFreshRuntimeSession(
    plan(
      [
        'playAudio async "beat.mp3" {',
        '  at 1 s {\n    say "one", instant\n  }',
        '  at 2 s {\n    say "two", instant\n  }',
        "}",
        "wait 10 s",
        "exit",
      ].join("\n"),
    ),
    immediate,
  );
  const playing = () => {
    const action = media.view().backgroundActions.find((candidate) => candidate.kind === "media");
    assert.ok(action?.kind === "media");
    return action.media;
  };
  media.run();
  assert.equal(media.view().foregroundAction?.kind, "mediaPlayback");
  assert.deepEqual(due(media), [], "the media waits for its load, which has no deadline");
  media.reportMediaLoad(playing().mediaId, { kind: "loaded", durationMs: 5_000 });
  media.run();
  assert.deepEqual(due(media), [work("delay", 10_000)], "no media event without progress");
  const { mediaId, segment } = playing();
  media.observeTime(2_500, [{ mediaId, segment, progressMs: 2_500 }]);
  assert.equal(media.view().queuedBlocks, 1);
  assert.deepEqual(due(media), [work("media", 2_000)]);
  media.run();
  assert.deepEqual(due(media), [work("delay", 10_000)]);

  // A failed session settles nothing further.
  const failed = createFreshRuntimeSession(
    plan(
      'timer async 1 s {\n  say "x", instant\n}\nlet parts = "x,abc".split(",")\nsay "${toInteger(parts[1])}"\nexit',
    ),
    immediate,
  );
  failed.run();
  assert.equal(failed.view().status, "failed");
  assert.equal(failed.view().backgroundActions.length, 1);
  assert.deepEqual(due(failed), []);
});
