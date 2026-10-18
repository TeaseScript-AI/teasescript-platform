import assert from "node:assert/strict";
import test from "node:test";

import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot-construction.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot-validation.js";

test("multiple reading times preserve identities, replay, and checkpoint equivalence", () => {
  const compiled = plan(
    [
      'say "one"',
      'say \"two ${["alpha", "beta"]}\"',
      'say "${["three", "three-alt"]}"',
      'say "four"',
      "exit",
    ].join("\n"),
  );
  const initial = createFreshRuntimeSnapshot(compiled, { seed: 77 });
  const first = run(compiled, initial);
  const firstGate = first.snapshot.foregroundAction;
  assert.equal(firstGate?.kind, "chatPacingGate");
  assert.deepEqual(said(first.events), ["one"]);
  assert.equal(first.events.filter((event) => event.kind === "actionRequested").length, 1);
  assert.equal(validateRuntimeSnapshot(first.snapshot, compiled).valid, true);

  const releasedFirst = completeAction(compiled, first.snapshot, {
    actionId: firstGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(releasedFirst.outcome.kind, "completed");
  assert.equal(releasedFirst.snapshot.lastSettlement?.actionId, firstGate!.actionId);
  assert.equal(
    completeAction(compiled, releasedFirst.snapshot, {
      actionId: firstGate!.actionId,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    }).outcome.kind,
    "alreadySettled",
  );

  // Each message is chosen and shown only once the reading time before it has ended.
  assert.deepEqual(releasedFirst.snapshot.rng, first.snapshot.rng);
  const second = run(compiled, releasedFirst.snapshot);
  const secondGate = second.snapshot.foregroundAction;
  assert.equal(secondGate?.kind, "chatPacingGate");
  assert.ok(secondGate!.actionId > firstGate!.actionId);
  assert.equal(said(second.events).length, 1);
  assert.equal(second.events.filter((event) => event.kind === "actionRequested").length, 1);
  assert.equal(validateRuntimeSnapshot(second.snapshot, compiled).valid, true);

  const releasedSecond = observeTime(compiled, second.snapshot, secondGate!.deadlineMs);
  assert.equal(releasedSecond.snapshot.lastSettlement?.actionId, secondGate!.actionId);
  assert.equal(releasedSecond.snapshot.status, "running");
  assert.equal(validateRuntimeSnapshot(releasedSecond.snapshot, compiled).valid, true);

  const third = run(compiled, releasedSecond.snapshot);
  const thirdGate = third.snapshot.foregroundAction;
  assert.equal(thirdGate?.kind, "chatPacingGate");
  assert.ok(thirdGate!.actionId > secondGate!.actionId);
  assert.equal(said(third.events).length, 1);

  const releasedThird = completeAction(compiled, third.snapshot, {
    actionId: thirdGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const fourth = run(compiled, releasedThird.snapshot);
  const fourthGate = fourth.snapshot.foregroundAction;
  assert.deepEqual(said(fourth.events), ["four"]);
  assert.equal(fourthGate?.kind, "chatPacingGate");
  assert.ok(fourthGate!.actionId > thirdGate!.actionId);
  assert.equal(fourth.snapshot.lastSettlement?.actionId, thirdGate!.actionId);
  assert.doesNotThrow(() => createCheckpoint(compiled, fourth.snapshot));
  // The session ends after the last message's reading time.
  const finalRun = run(
    compiled,
    observeTime(compiled, fourth.snapshot, fourthGate!.deadlineMs).snapshot,
  );
  assert.equal(finalRun.snapshot.status, "halted");
  assert.deepEqual(
    finalRun.events.map((event) => event.kind),
    ["exit"],
  );

  const transcript = [first, second, third, fourth].flatMap((step) => said(step.events));
  assert.equal(transcript[0], "one");
  assert.ok(["two alpha", "two beta"].includes(transcript[1]!), transcript[1]);
  assert.ok(["three", "three-alt"].includes(transcript[2]!), transcript[2]);
  assert.equal(transcript[3], "four");

  const cuts = [
    first.snapshot,
    second.snapshot,
    releasedSecond.snapshot,
    third.snapshot,
    releasedThird.snapshot,
    fourth.snapshot,
  ];
  for (const cut of cuts) {
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, cut)));
    assert.deepEqual(
      finishPacingChain(restored.plan, restored.snapshot),
      finishPacingChain(compiled, cut),
    );
  }
});

test("mixed wait, interaction, instant, and pacing composition keeps event ordering canonical", () => {
  const compiled = plan(
    [
      'say "one"',
      "wait 1 s",
      'say "two"',
      'showButton "Continue"',
      'say "now", instant',
      'say "four"',
      "exit",
    ].join("\n"),
  );
  const reading = run(compiled, createFreshRuntimeSnapshot(compiled));
  const firstGate = reading.snapshot.foregroundAction;
  assert.equal(firstGate?.kind, "chatPacingGate");
  assert.deepEqual(
    reading.events.map((event) => event.kind),
    ["say", "actionRequested"],
  );

  // The wait starts when the reading time ends, so it adds its whole second.
  const waiting = run(compiled, observeTime(compiled, reading.snapshot, 1_800).snapshot);
  const delay = waiting.snapshot.foregroundAction;
  assert.equal(delay?.kind, "delay");
  assert.deepEqual(
    delay?.kind === "delay" ? [delay.createdAtMs, delay.deadlineMs] : null,
    [1_800, 2_800],
  );
  assert.deepEqual(
    waiting.events.map((event) => event.kind),
    ["actionRequested"],
  );

  const delayCompleted = observeTime(compiled, waiting.snapshot, 2_800);
  assert.deepEqual(
    delayCompleted.events.map((event) => event.kind),
    ["actionCompleted"],
  );
  const secondReading = run(compiled, delayCompleted.snapshot);
  const secondGate = secondReading.snapshot.foregroundAction;
  assert.equal(secondGate?.kind, "chatPacingGate");
  assert.deepEqual(
    secondReading.events.map((event) => (event.kind === "say" ? event.text : event.kind)),
    ["two", "actionRequested"],
  );

  // The buttons appear only after the reading time, and the button's request is the only event then.
  const released = observeTime(compiled, secondReading.snapshot, secondGate!.deadlineMs);
  const interactionWaiting = run(compiled, released.snapshot);
  assert.deepEqual(
    interactionWaiting.events.map((event) => event.kind),
    ["actionRequested"],
  );
  const interaction = interactionWaiting.snapshot.foregroundAction;
  assert.equal(interaction?.kind, "interaction");
  assert.equal(interaction?.createdAtMs, secondGate!.deadlineMs);

  const interactionCompleted = completeAction(compiled, interactionWaiting.snapshot, {
    actionId: interaction!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });
  assert.deepEqual(
    interactionCompleted.events.map((event) => event.kind),
    ["playerTranscript", "actionCompleted"],
  );
  const lastReading = run(compiled, interactionCompleted.snapshot);
  assert.deepEqual(
    lastReading.events.map((event) => (event.kind === "say" ? event.text : event.kind)),
    ["now", "four", "actionRequested"],
  );
  const lastGate = lastReading.snapshot.foregroundAction;
  assert.equal(lastGate?.kind, "chatPacingGate");
  const finalRun = run(
    compiled,
    observeTime(compiled, lastReading.snapshot, lastGate!.deadlineMs).snapshot,
  );
  assert.deepEqual(
    finalRun.events.map((event) => event.kind),
    ["exit"],
  );
  assert.equal(finalRun.snapshot.backgroundActions.length, 0);
  assert.equal(validateRuntimeSnapshot(finalRun.snapshot, compiled).valid, true);
  assert.doesNotThrow(() =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, finalRun.snapshot))),
  );
});

function said(events: ReturnType<typeof run>["events"]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function finishPacingChain(
  compiled: ReturnType<typeof plan>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
): { snapshot: ReturnType<typeof createFreshRuntimeSnapshot>; events: unknown[] } {
  let current = snapshot;
  const events: unknown[] = [];
  for (let steps = 0; steps < 16; steps += 1) {
    const advanced = run(compiled, current);
    current = advanced.snapshot;
    events.push(...advanced.events);
    if (current.foregroundAction?.kind !== "chatPacingGate") return { snapshot: current, events };
    const settled = completeAction(compiled, current, {
      actionId: current.foregroundAction.actionId,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    });
    current = settled.snapshot;
    events.push(...settled.events);
  }
  throw new Error("Pacing chain did not finish within its bounded test steps.");
}
