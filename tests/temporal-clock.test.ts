import assert from "node:assert/strict";
import test from "node:test";

import type { InstructionPlan } from "../src/plan/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { recordContinueCapture } from "../src/runtime/operations/continue-capture.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { DEFAULT_TEMPORAL_CONTEXT, type TemporalContext } from "../src/temporal.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { AMSTERDAM, utc } from "./helpers/temporal-fixtures.js";

/** 18:00 in Amsterdam on Sunday 4 October 2026. */
const START = utc("2026-10-04T16:00:00");

function says(events: readonly { readonly kind: string; readonly text?: string }[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text!] : []));
}

function fresh(source: string, wallClockMs: number | null = START, context = AMSTERDAM) {
  const plan = compileValidPlan(source);
  const snapshot = createImmediatePacingRuntimeSnapshot(plan, {
    temporalContext: context,
    ...(wallClockMs === null ? {} : { wallClockMs }),
  });
  return { plan, first: run(plan, snapshot) };
}

/** Observes `atMs` and runs whatever became due, as a live Player does. */
function advance(plan: InstructionPlan, snapshot: RuntimeSnapshot, atMs: number) {
  const observed = observeTime(plan, snapshot, atMs);
  assert.equal(observed.outcome.kind, "observed");
  const ran = run(plan, observed.snapshot);
  return { snapshot: ran.snapshot, says: [...says(observed.events), ...says(ran.events)] };
}

function continueWith(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  wallClockMs: number,
  temporalContext?: TemporalContext,
): RuntimeSnapshot {
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  const recorded = recordContinueCapture(plan, restored.snapshot, {
    wallClockMs,
    ...(temporalContext === undefined ? {} : { temporalContext }),
  });
  assert.equal(recorded.outcome.kind, "recorded");
  return recorded.snapshot;
}

test("the getters read the captured wall clock through the captured zone as scene time advances", () => {
  const { plan, first } = fresh(
    [
      "say getTimestamp().toISO()",
      "say getDateTime().toISO()",
      "wait 90 s",
      "say getTime().toISO()",
      "say getDate().weekday",
    ].join("\n"),
  );
  assert.deepEqual(says(first.events), ["2026-10-04T16:00:00Z", "2026-10-04T18:00"]);
  assert.deepEqual(advance(plan, first.snapshot, 90_000).says, ["18:01:30", "Sunday"]);
});

test("a late observation gives the same times and state as observing every deadline on time", () => {
  const source = "wait 1 s\nsay getTimestamp().toISO()\nwait 1.0004 s\nsay getTimestamp().toISO()";
  const { plan, first } = fresh(source);
  const onTime = advance(plan, first.snapshot, 1_000);
  const onTimeEnd = advance(plan, onTime.snapshot, 2_000.4);
  const late = advance(plan, first.snapshot, 2_000.4);
  // A fractional scene time rounds to a whole millisecond.
  assert.deepEqual(late.says, ["2026-10-04T16:00:01Z", "2026-10-04T16:00:02Z"]);
  assert.deepEqual([...onTime.says, ...onTimeEnd.says], late.says);
  assert.deepEqual(late.snapshot, onTimeEnd.snapshot);
});

test("a Continue capture applies from the saved observed time; saved catch-up keeps the earlier one", () => {
  const { plan, first } = fresh(
    "wait 1 s\nsay getTimestamp().toISO()\nwait 10 s\nsay getTimestamp().toISO()",
  );
  // The session was saved after observing 5 s, with the 1 s wait due but its continuation not yet run.
  const saved = observeTime(plan, first.snapshot, 5_000).snapshot;
  assert.equal(saved.currentSessionTimeMs, 1_000);
  const later = utc("2026-10-05T09:00:00");
  const continued = continueWith(plan, saved, later);
  assert.deepEqual(says(run(plan, continued).events), ["2026-10-04T16:00:01Z"]);
  const resumed = advance(plan, run(plan, continued).snapshot, 11_000);
  assert.deepEqual(resumed.says, ["2026-10-05T09:00:06Z"]);
});

test("the capture in force changes exactly at the boundary, also with a second Continue before catch-up ends", () => {
  const { plan, first } = fresh(
    [
      "wait 1 s",
      "say getTimestamp().toISO()",
      "wait 5.5 s",
      "say getTimestamp().toISO()",
      "wait 5 s",
      "say getTimestamp().toISO()",
    ].join("\n"),
  );
  // Due exactly at the boundary: execution from the boundary on uses the new capture.
  const atBoundary = observeTime(plan, first.snapshot, 1_000).snapshot;
  const boundaryClock = utc("2026-10-05T09:00:00");
  assert.equal(
    says(run(plan, continueWith(plan, atBoundary, boundaryClock)).events)[0],
    "2026-10-05T09:00:00Z",
  );

  const saved = observeTime(plan, first.snapshot, 5_000).snapshot;
  const continuedOnce = continueWith(plan, saved, utc("2026-10-05T09:00:00"));
  // A second Continue before the first boundary was reached, after observing 8 s while nothing ran.
  const observedAgain = observeTime(plan, continuedOnce, 8_000).snapshot;
  const second = continueWith(plan, observedAgain, utc("2026-10-06T07:00:00"));
  assert.deepEqual(
    second.temporalCaptures.map((capture) => capture.boundaryMs),
    [0, 5_000, 8_000],
  );
  const caughtUp = run(plan, second);
  // 1 s still uses the start capture; 6.5 s lies after the first Continue and before the second.
  assert.deepEqual(says(caughtUp.events), ["2026-10-04T16:00:01Z", "2026-10-05T09:00:01.500Z"]);
  assert.deepEqual(advance(plan, caughtUp.snapshot, 12_000).says, ["2026-10-06T07:00:03.500Z"]);
});

test("a choice shown before a Continue keeps its buttons, and later text uses the new presentation", () => {
  const { plan, first } = fresh(
    'let day = choose [toDate("2026-10-04"), toDate("2026-10-05")]\nsay day',
  );
  const continued = continueWith(plan, first.snapshot, START + 60_000, DEFAULT_TEMPORAL_CONTEXT);
  const action = continued.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  assert.deepEqual(
    action.ui.options.map((option) => option.text),
    ["4-10-2026", "5-10-2026"],
  );
  const completed = completeAction(plan, continued, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 1 },
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(says(run(plan, completed.snapshot).events), ["2026-10-05"]);
});

test("without a clock the getters fail, and a Continue capture is checked before it is recorded", () => {
  const noClock = fresh("say getDate()", null);
  assert.equal(noClock.first.snapshot.failure?.code, "TSR064");

  const { plan, first } = fresh("wait 1 s");
  for (const capture of [
    null,
    {},
    { wallClockMs: 1.5 },
    { wallClockMs: START, extra: true },
    { wallClockMs: START, temporalContext: { zone: AMSTERDAM.zone } },
  ]) {
    const outcome = recordContinueCapture(plan, first.snapshot, capture).outcome;
    assert.equal(outcome.kind, "invalidCapture", JSON.stringify(capture));
  }
  assert.equal(
    recordContinueCapture(noClock.plan, noClock.first.snapshot, { wallClockMs: START }).outcome
      .kind,
    "invalidCapture",
  );
});
