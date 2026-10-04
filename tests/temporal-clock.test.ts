import assert from "node:assert/strict";
import test from "node:test";

import type { InstructionPlan } from "../src/plan/model.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { recordContinueCapture } from "../src/runtime/operations/continue-capture.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { temporalCapturesProblem } from "../src/runtime/temporal-captures.js";
import { DEFAULT_TEMPORAL_CONTEXT, type TemporalContext } from "../src/temporal.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { AMSTERDAM, utc } from "./helpers/temporal-fixtures.js";

/** 18:00 in Amsterdam on Sunday 4 October 2026. */
const START = utc("2026-10-04T16:00:00");
const NEUTRAL = DEFAULT_TEMPORAL_CONTEXT;

type RuntimeEvent = ReturnType<typeof run>["events"][number];

/** A session driven as the Player drives it; every operation keeps its events and is a checkpoint boundary. */
interface Session {
  readonly plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
  readonly events: RuntimeEvent[];
}

function session(
  source: string,
  options: {
    readonly wallClockMs?: number | null;
    readonly persistentScriptStorage?: boolean;
  } = {},
): Session {
  const plan = compileValidPlan(source);
  const { wallClockMs = START, ...rest } = options;
  const snapshot = createImmediatePacingRuntimeSnapshot(plan, {
    temporalContext: AMSTERDAM,
    ...(wallClockMs === null ? {} : { wallClockMs }),
    ...rest,
  });
  return { plan, snapshot, events: [] };
}

function apply<
  T extends { readonly snapshot: RuntimeSnapshot; readonly events: readonly RuntimeEvent[] },
>(current: Session, operation: T): T {
  current.snapshot = operation.snapshot;
  current.events.push(...operation.events);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(current.plan, current.snapshot)),
  );
  assert.deepEqual(restored.snapshot, current.snapshot);
  current.snapshot = restored.snapshot;
  return operation;
}

function runSession(current: Session): Session {
  apply(current, run(current.plan, current.snapshot));
  return current;
}

/** Observes `atMs` and runs whatever became due, as a live Player does. */
function observe(current: Session, atMs: number): Session {
  const observed = apply(current, observeTime(current.plan, current.snapshot, atMs));
  assert.equal(observed.outcome.kind, "observed");
  return runSession(current);
}

/** Records a Continue capture without running; the Player runs the session right after it. */
function continueAt(
  current: Session,
  wallClockMs: number,
  temporalContext?: TemporalContext,
): Session {
  const recorded = apply(
    current,
    recordContinueCapture(current.plan, current.snapshot, {
      wallClockMs,
      ...(temporalContext === undefined ? {} : { temporalContext }),
    }),
  );
  assert.equal(recorded.outcome.kind, "recorded");
  return current;
}

function answer(current: Session, optionIndex = 0): Session {
  const action = current.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction");
  const completed = apply(
    current,
    completeAction(current.plan, current.snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: action.interactionKind,
      payload: { kind: "selectedOption", optionIndex },
    }),
  );
  assert.equal(completed.outcome.kind, "completed");
  return current;
}

function says(current: Session): string[] {
  return current.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function copy(current: Session): Session {
  return {
    plan: current.plan,
    snapshot: structuredClone(current.snapshot),
    events: [...current.events],
  };
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(".000Z", "Z");
}

function choiceTexts(current: Session): string[] {
  const action = current.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  return action.ui.options.map((option) => option.text);
}

test("the getters read the captured wall clock through the captured zone as scene time advances", () => {
  const day = observe(
    runSession(
      session(
        [
          "say getTimestamp().toISO()",
          "say getDateTime().toISO()",
          "wait 90 s",
          "say getTime().toISO()",
          "say getDate().weekday",
        ].join("\n"),
      ),
    ),
    90_000,
  );
  assert.deepEqual(says(day), ["2026-10-04T16:00:00Z", "2026-10-04T18:00", "18:01:30", "Sunday"]);

  // When summer time ends, the timestamp moves on while the local clock goes back an hour.
  const fallBack = observe(
    runSession(
      session(
        [
          "say getTimestamp().toISO()",
          "say getTime().toISO()",
          "wait 1 s",
          "say getTimestamp().toISO()",
          "say getTime().toISO()",
        ].join("\n"),
        { wallClockMs: utc("2026-10-25T00:59:59") },
      ),
    ),
    1_000,
  );
  assert.deepEqual(says(fallBack), [
    "2026-10-25T00:59:59Z",
    "02:59:59",
    "2026-10-25T01:00:00Z",
    "02:00",
  ]);
});

test("a late observation gives the same events and state as observing every deadline on time", () => {
  const plain = runSession(
    session("wait 1 s\nsay getTimestamp().toISO()\nwait 1.0004 s\nsay getTimestamp().toISO()"),
  );
  const onTime = observe(observe(copy(plain), 1_000), 2_000.4);
  const late = observe(copy(plain), 2_000.4);
  // A fractional scene time rounds to a whole millisecond.
  assert.deepEqual(says(late), ["2026-10-04T16:00:01Z", "2026-10-04T16:00:02Z"]);
  assert.deepEqual(late.events, onTime.events);
  assert.deepEqual(late.snapshot, onTime.snapshot);

  // The same holds for a timer handler interrupting the script, with a Continue recorded before catch-up.
  const interrupted = observe(
    runSession(
      session(
        [
          "timer async 50 ms {",
          "    say getTimestamp().toISO()",
          "    wait 75 ms",
          "    say getTimestamp().toISO()",
          "}",
          "wait 200 ms",
          "say getTimestamp().toISO()",
        ].join("\n"),
      ),
    ),
    100,
  );
  continueAt(interrupted, START + 10_000, NEUTRAL);
  const lateCatchUp = observe(runSession(copy(interrupted)), 200);
  const onTimeCatchUp = observe(observe(runSession(copy(interrupted)), 125), 200);
  assert.deepEqual(says(lateCatchUp), [iso(START + 50), iso(START + 10_025), iso(START + 10_100)]);
  assert.deepEqual(lateCatchUp.events, onTimeCatchUp.events);
  assert.deepEqual(lateCatchUp.snapshot, onTimeCatchUp.snapshot);
});

test("a Continue capture applies from the saved observed time; saved catch-up keeps the earlier one", () => {
  const saved = runSession(
    session("wait 1 s\nsay getTimestamp().toISO()\nwait 10 s\nsay getTimestamp().toISO()"),
  );
  // The session was saved after observing 5 s, with the 1 s wait due but its continuation not yet run.
  apply(saved, observeTime(saved.plan, saved.snapshot, 5_000));
  assert.equal(saved.snapshot.currentSessionTimeMs, 1_000);
  const resumed = observe(runSession(continueAt(saved, utc("2026-10-05T09:00:00"))), 11_000);
  assert.deepEqual(says(resumed), ["2026-10-04T16:00:01Z", "2026-10-05T09:00:06Z"]);

  // Due exactly at the boundary: execution from the boundary on uses the new capture.
  const atBoundary = runSession(session("wait 1 s\nsay getTimestamp().toISO()"));
  apply(atBoundary, observeTime(atBoundary.plan, atBoundary.snapshot, 1_000));
  continueAt(atBoundary, utc("2026-10-05T09:00:00"));
  assert.deepEqual(says(runSession(atBoundary)), ["2026-10-05T09:00:00Z"]);
});

test("Continues recorded before catch-up each apply from their own boundary", () => {
  const pending = runSession(
    session(
      [
        "wait 1 s",
        "say getTimestamp().toISO()",
        "wait 5.5 s",
        "say getTimestamp().toISO()",
        "wait 5 s",
        "say getTimestamp().toISO()",
      ].join("\n"),
    ),
  );
  apply(pending, observeTime(pending.plan, pending.snapshot, 5_000));
  continueAt(pending, utc("2026-10-05T09:00:00"));
  // A second Continue before the first boundary was reached, after observing 8 s while nothing ran.
  apply(pending, observeTime(pending.plan, pending.snapshot, 8_000));
  continueAt(pending, utc("2026-10-06T07:00:00"));
  assert.deepEqual(
    pending.snapshot.temporalCaptures.map((capture) => capture.boundaryMs),
    [0, 5_000, 8_000],
  );
  // 1 s still uses the start capture; 6.5 s lies after the first Continue and before the second.
  assert.deepEqual(says(observe(runSession(pending), 12_000)), [
    "2026-10-04T16:00:01Z",
    "2026-10-05T09:00:01.500Z",
    "2026-10-06T07:00:03.500Z",
  ]);

  // A held storage acknowledgement keeps scene time at 2 ms while the Player observes 100 ms and 120 ms and continues
  // at each; the 110 ms handler then runs with the first Continue and the end of the script with the second.
  const held = runSession(
    session(
      [
        'timer async 1 ms { save 2 as "k"\nsay getTimestamp().toISO() }',
        "timer async 2 ms { say getTimestamp().toISO() }",
        "timer async 110 ms { say getTimestamp().toISO() }",
        "wait 200 ms",
        "say getTimestamp().toISO()",
      ].join("\n"),
      { persistentScriptStorage: true },
    ),
  );
  observe(held, 100);
  assert.equal(held.snapshot.currentSessionTimeMs, 2);
  continueAt(held, START + 10_000, NEUTRAL);
  apply(held, observeTime(held.plan, held.snapshot, 120));
  continueAt(held, START + 20_000, NEUTRAL);
  const write = held.snapshot.foregroundAction;
  assert.ok(write?.kind === "storageWrite");
  const stored = apply(
    held,
    completeAction(held.plan, held.snapshot, {
      actionId: write.actionId,
      actionKind: "storageWrite",
      payload: { kind: "stored" },
    }),
  );
  assert.equal(stored.outcome.kind, "completed");
  observe(runSession(held), 200);
  assert.deepEqual(says(held), [
    iso(START + 2),
    iso(START + 2),
    iso(START + 10_010),
    iso(START + 20_080),
  ]);
});

test("an open choice keeps the capture it was shown with through Continues, interrupts, and compaction", () => {
  const shown = session('let day = choose [toDate("2026-10-04"), toDate("2026-10-05")]\nsay day');
  // Continues at one boundary with nothing in between replace each other.
  continueAt(continueAt(shown, START + 10_000), START + 20_000);
  assert.equal(shown.snapshot.temporalCaptures.length, 1);
  runSession(shown);
  // Once the choice is shown, a Continue at the same boundary keeps its capture, and a further one replaces only the
  // new capture.
  continueAt(continueAt(shown, START + 30_000, NEUTRAL), START + 40_000, NEUTRAL);
  assert.equal(shown.snapshot.temporalCaptures.length, 2);
  assert.deepEqual(choiceTexts(shown), ["4-10-2026", "5-10-2026"]);
  // After the answer, the next Continue drops the choice's capture; later text uses the new presentation.
  continueAt(answer(shown, 1), START + 50_000, NEUTRAL);
  assert.equal(shown.snapshot.temporalCaptures.length, 1);
  assert.deepEqual(says(runSession(shown)), ["2026-10-05"]);

  // A choice suspended by a timer handler keeps its buttons through Continues during and after the interrupt.
  const suspended = runSession(
    session(
      [
        "timer async 50 ms { wait 100 ms\nsay getTimestamp().toISO() }",
        'let day = choose [toDate("2026-10-04")]',
        "say day",
        "say getTimestamp().toISO()",
      ].join("\n"),
    ),
  );
  observe(suspended, 50);
  continueAt(suspended, START + 10_000, NEUTRAL);
  apply(suspended, observeTime(suspended.plan, suspended.snapshot, 100));
  continueAt(suspended, START + 20_000, NEUTRAL);
  observe(suspended, 150);
  continueAt(suspended, START + 30_000, NEUTRAL);
  assert.deepEqual(choiceTexts(suspended), ["4-10-2026"]);
  assert.deepEqual(says(runSession(answer(suspended))), [
    iso(START + 20_050),
    "2026-10-04",
    iso(START + 30_000),
  ]);
});

/** The session's checkpoint as plain data, to damage as a corrupted save would be. */
function savedData(current: Session) {
  // EVIDENCE: the serialized checkpoint was created from this validated plan and runtime-produced snapshot.
  return JSON.parse(serializeCheckpoint(createCheckpoint(current.plan, current.snapshot))) as {
    snapshot: {
      temporalCaptures: Record<string, unknown>[];
      foregroundAction: { ui: { options: { text: string }[] } };
    };
  };
}

test("a checkpoint rejects captures out of recording order and an open choice without its capture", () => {
  const saved = runSession(session('wait 1 s\nlet day = choose [toDate("2026-10-04")]\nsay day'));
  observe(saved, 1_000);
  apply(saved, observeTime(saved.plan, saved.snapshot, 1_500));
  continueAt(saved, START + 10_000, NEUTRAL);
  assert.doesNotThrow(() => restoreCheckpoint(savedData(saved)));
  const corruptions: Record<string, (captures: Record<string, unknown>[]) => void> = {
    "no capture": (captures) => captures.splice(0),
    "negative recording sequence": (captures) => (captures[0]!.sinceEventSequence = -1),
    "boundaries out of order": (captures) => captures.reverse(),
    "the same capture twice": (captures) => (captures[1] = { ...captures[0] }),
    "a boundary past the observed time": (captures) => (captures[1]!.boundaryMs = 1_501),
    "a sequence past the next event": (captures) =>
      (captures[1]!.sinceEventSequence = saved.snapshot.nextEventSequence + 1),
    "a fractional clock": (captures) => (captures[1]!.epochMs = 1.5),
    "a context without presentation": (captures) =>
      (captures[1]!.context = { zone: AMSTERDAM.zone }),
    // The choice was requested before the first capture's event sequence, so no capture shows its buttons.
    "every capture recorded after the open choice": (captures) =>
      (captures[0]!.sinceEventSequence = captures[1]!.sinceEventSequence),
  };
  for (const [name, corrupt] of Object.entries(corruptions)) {
    const data = savedData(saved);
    corrupt(data.snapshot.temporalCaptures);
    assert.throws(() => restoreCheckpoint(data), CheckpointError, name);
  }

  // A choice shown before a Continue at the same boundary cannot be validated with the later capture alone.
  const relabeled = runSession(session('let day = choose [toDate("2026-10-04")]\nsay day'));
  continueAt(relabeled, START + 10_000, NEUTRAL);
  const data = savedData(relabeled);
  data.snapshot.temporalCaptures.shift();
  data.snapshot.foregroundAction.ui.options[0]!.text = "2026-10-04";
  assert.throws(() => restoreCheckpoint(data), CheckpointError);

  // Captures that share one context object check it once, but each capture's own fields still count, a later
  // distinct context is checked too, and every check of a list starts afresh.
  const shared: { zone: unknown; presentation: { hourCycle: unknown } } = JSON.parse(
    JSON.stringify(NEUTRAL),
  );
  const capture = (boundaryMs: number, sinceEventSequence: number, context: unknown) => ({
    boundaryMs,
    sinceEventSequence,
    epochMs: START + boundaryMs,
    context,
  });
  const captures = [capture(0, 0, shared), capture(10, 1, shared)];
  assert.equal(temporalCapturesProblem(captures, 10, 10, 3), null);
  assert.notEqual(
    temporalCapturesProblem([captures[0], { ...captures[1], epochMs: 1.5 }], 10, 10, 3),
    null,
  );
  assert.notEqual(
    temporalCapturesProblem([...captures, capture(10, 2, { zone: shared.zone })], 10, 10, 3),
    null,
  );
  shared.presentation.hourCycle = "h99";
  assert.notEqual(temporalCapturesProblem(captures, 10, 10, 3), null);
});

test("without a clock the getters fail, and a Continue capture is checked before it is recorded", () => {
  const noClock = runSession(session("say getDate()", { wallClockMs: null }));
  assert.equal(noClock.snapshot.failure?.code, "TSR064");
  const failed = recordContinueCapture(noClock.plan, noClock.snapshot, { wallClockMs: START });
  assert.equal(failed.outcome.kind, "invalidCapture");
  assert.deepEqual(failed.snapshot, noClock.snapshot);
  assert.deepEqual(failed.events, []);

  const waiting = runSession(session("wait 1 s"));
  for (const capture of [
    null,
    {},
    { wallClockMs: 1.5 },
    { wallClockMs: START, extra: true },
    { wallClockMs: START, temporalContext: { zone: AMSTERDAM.zone } },
  ]) {
    const outcome = recordContinueCapture(waiting.plan, waiting.snapshot, capture).outcome;
    assert.equal(outcome.kind, "invalidCapture", JSON.stringify(capture));
  }
});
