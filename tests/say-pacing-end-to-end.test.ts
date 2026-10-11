import assert from "node:assert/strict";
import test from "node:test";

import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

test("multiple pacing cycles preserve prepared output, identities, replay, and checkpoint equivalence", () => {
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

  // Each released message is emitted from the text prepared before its wait.
  const second = run(compiled, releasedFirst.snapshot);
  const secondGate = second.snapshot.foregroundAction;
  assert.equal(secondGate?.kind, "chatPacingGate");
  assert.ok(secondGate!.actionId > firstGate!.actionId);
  assert.deepEqual(said(second.events), [firstGate?.preparedOutput?.text]);
  assert.equal(second.events.filter((event) => event.kind === "actionRequested").length, 1);
  assert.notEqual(secondGate?.preparedOutput, null);
  assert.equal(validateRuntimeSnapshot(second.snapshot, compiled).valid, true);

  const releasedSecond = observeTime(compiled, second.snapshot, secondGate!.deadlineMs);
  assert.equal(releasedSecond.snapshot.lastSettlement?.actionId, secondGate!.actionId);
  assert.equal(releasedSecond.snapshot.preparedSayOutput?.text, secondGate?.preparedOutput?.text);
  assert.equal(validateRuntimeSnapshot(releasedSecond.snapshot, compiled).valid, true);

  const third = run(compiled, releasedSecond.snapshot);
  const thirdGate = third.snapshot.foregroundAction;
  assert.equal(thirdGate?.kind, "chatPacingGate");
  assert.ok(thirdGate!.actionId > secondGate!.actionId);
  assert.deepEqual(said(third.events), [secondGate?.preparedOutput?.text]);
  assert.equal(third.events.filter((event) => event.kind === "actionRequested").length, 1);
  // Emitting the selected list item and preparing the literal "four" draw nothing.
  assert.deepEqual(third.snapshot.rng, releasedSecond.snapshot.rng);

  const releasedThird = completeAction(compiled, third.snapshot, {
    actionId: thirdGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const fourthOutput = executeInstruction(compiled, releasedThird.snapshot);
  assert.deepEqual(said(fourthOutput.events), [thirdGate?.preparedOutput?.text]);
  assert.equal(fourthOutput.snapshot.backgroundActions[0]?.kind, "chatPacingGate");
  assert.ok(fourthOutput.snapshot.backgroundActions[0]!.actionId > thirdGate!.actionId);
  assert.equal(fourthOutput.snapshot.lastSettlement?.actionId, thirdGate!.actionId);
  assert.equal(validateRuntimeSnapshot(fourthOutput.snapshot, compiled).valid, true);
  assert.doesNotThrow(() => createCheckpoint(compiled, fourthOutput.snapshot));
  // The exit waits for the last message's pacing.
  const exitWaiting = executeInstruction(compiled, fourthOutput.snapshot);
  const lastGate = exitWaiting.snapshot.foregroundAction;
  assert.equal(lastGate?.kind, "chatPacingGate");
  assert.equal(lastGate?.preparedOutput, null);
  assert.deepEqual(exitWaiting.events, []);
  const finalRun = run(
    compiled,
    observeTime(compiled, exitWaiting.snapshot, lastGate!.deadlineMs).snapshot,
  );
  assert.equal(finalRun.snapshot.status, "halted");
  assert.equal(finalRun.snapshot.backgroundActions.length, 0);

  const transcript = [first, second, third, fourthOutput, finalRun].flatMap((step) =>
    said(step.events),
  );
  assert.equal(transcript.length, 4);
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
  // The wait replaces the reading time of "one".
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const delay = waiting.snapshot.foregroundAction;
  assert.equal(delay?.kind, "delay");
  assert.deepEqual(waiting.snapshot.backgroundActions, []);
  assert.deepEqual(
    waiting.events.map((event) =>
      event.kind === "actionCompleted" ? event.settlement.settlementKind : event.kind,
    ),
    ["say", "actionRequested", "replacedByWait", "actionRequested"],
  );

  const delayCompleted = observeTime(compiled, waiting.snapshot, 1_000);
  assert.deepEqual(
    delayCompleted.events.map((event) => event.kind),
    ["actionCompleted"],
  );
  assert.equal(delayCompleted.snapshot.foregroundAction, null);

  // The button waits for the reading time of "two" without a second request for its gate.
  const held = run(compiled, delayCompleted.snapshot);
  assert.deepEqual(
    held.events.map((event) => event.kind),
    ["say", "actionRequested"],
  );
  const pacing = held.snapshot.foregroundAction;
  assert.equal(pacing?.kind, "chatPacingGate");
  assert.equal(pacing?.preparedOutput, null);

  const released = observeTime(compiled, held.snapshot, pacing!.deadlineMs);
  assert.deepEqual(
    released.events.map((event) =>
      event.kind === "actionCompleted" ? event.settlement.settlementKind : event.kind,
    ),
    ["completed"],
  );
  const interactionWaiting = run(compiled, released.snapshot);
  assert.deepEqual(
    interactionWaiting.events.map((event) => event.kind),
    ["actionRequested"],
  );
  const interaction = interactionWaiting.snapshot.foregroundAction;
  assert.equal(interaction?.kind, "interaction");
  assert.equal(
    interaction?.kind === "interaction" ? interaction.createdAtMs : null,
    pacing!.deadlineMs,
  );

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
  // "now" follows at once, as no reading time runs; the exit waits for that of "four".
  const exitWaiting = run(compiled, interactionCompleted.snapshot);
  assert.deepEqual(
    exitWaiting.events.map((event) => event.kind),
    ["say", "say", "actionRequested"],
  );
  const lastGate = exitWaiting.snapshot.foregroundAction;
  assert.equal(lastGate?.kind, "chatPacingGate");
  const finalRun = run(
    compiled,
    observeTime(compiled, exitWaiting.snapshot, lastGate!.deadlineMs).snapshot,
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
    if (current.foregroundAction?.kind === "chatPacingGate") {
      const settled = completeAction(compiled, current, {
        actionId: current.foregroundAction.actionId,
        actionKind: "chatPacingGate",
        payload: { kind: "skip" },
      });
      current = settled.snapshot;
      events.push(...settled.events);
      continue;
    }
    if (current.status === "halted" && current.backgroundActions[0]?.kind === "chatPacingGate") {
      const settled = completeAction(compiled, current, {
        actionId: current.backgroundActions[0].actionId,
        actionKind: "chatPacingGate",
        payload: { kind: "skip" },
      });
      current = settled.snapshot;
      events.push(...settled.events);
    }
    return { snapshot: current, events };
  }
  throw new Error("Pacing chain did not finish within its bounded test steps.");
}
