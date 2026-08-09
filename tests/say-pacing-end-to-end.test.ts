import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
} from "../src/runtime/state.js";

function plan(source: string) {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  return compiled.plan!;
}

test("multiple pacing cycles preserve prepared output, identities, replay, and checkpoint equivalence", () => {
  const compiled = plan([
    'say "one"',
    'say `two ${["alpha", "beta"]}`',
    'say ["three", "three-alt"]',
    'say "four"',
    "exit",
  ].join("\n"));
  const initial = createFreshRuntimeSnapshot(compiled, { seed: 77 });
  const first = run(compiled, initial);
  const firstGate = first.snapshot.foregroundAction;
  assert.equal(firstGate?.kind, "chatPacingGate");
  assert.equal(firstGate?.actionId, 1);
  assert.equal(firstGate?.preparedOutput?.owningInstruction, 1);
  assert.equal(first.events.filter((event) => event.kind === "actionRequested").length, 1);
  assert.equal(validateRuntimeSnapshot(first.snapshot, compiled).valid, true);

  const releasedFirst = completeAction(compiled, first.snapshot, {
    actionId: firstGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(releasedFirst.outcome.kind, "completed");
  assert.equal(releasedFirst.snapshot.lastSettlement?.actionId, 1);
  assert.equal(completeAction(compiled, releasedFirst.snapshot, {
    actionId: 1,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  }).outcome.kind, "alreadySettled");

  const second = run(compiled, releasedFirst.snapshot);
  const secondGate = second.snapshot.foregroundAction;
  assert.equal(secondGate?.kind, "chatPacingGate");
  assert.equal(secondGate?.actionId, 2);
  assert.equal(second.events.filter((event) => event.kind === "say").length, 1);
  assert.equal(second.events.filter((event) => event.kind === "actionRequested").length, 1);
  assert.notEqual(secondGate?.preparedOutput, null);
  assert.equal(validateRuntimeSnapshot(second.snapshot, compiled).valid, true);

  const releasedSecond = observeTime(compiled, second.snapshot, secondGate!.deadlineMs);
  assert.equal(releasedSecond.snapshot.lastSettlement?.actionId, 2);
  assert.equal(releasedSecond.snapshot.preparedSayOutput?.text, secondGate?.preparedOutput?.text);
  assert.equal(validateRuntimeSnapshot(releasedSecond.snapshot, compiled).valid, true);

  const third = run(compiled, releasedSecond.snapshot);
  const thirdGate = third.snapshot.foregroundAction;
  assert.equal(thirdGate?.kind, "chatPacingGate");
  assert.equal(thirdGate?.actionId, 3);
  assert.equal(third.events.filter((event) => event.kind === "say").length, 1);
  assert.equal(third.events.filter((event) => event.kind === "actionRequested").length, 1);

  const releasedThird = completeAction(compiled, third.snapshot, {
    actionId: thirdGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const finalRun = run(compiled, releasedThird.snapshot);
  assert.equal(finalRun.snapshot.status, "halted");
  assert.equal(finalRun.snapshot.backgroundActions[0]?.kind, "chatPacingGate");
  assert.equal(finalRun.snapshot.backgroundActions[0]?.actionId, 4);
  assert.equal(finalRun.snapshot.lastSettlement?.actionId, 3);
  assert.equal(validateRuntimeSnapshot(finalRun.snapshot, compiled).valid, true);
  assert.doesNotThrow(() => createCheckpoint(compiled, finalRun.snapshot));

  const cuts = [first.snapshot, second.snapshot, releasedSecond.snapshot, third.snapshot, releasedThird.snapshot];
  for (const cut of cuts) {
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, cut)));
    assert.deepEqual(finishPacingChain(restored.plan, restored.snapshot), finishPacingChain(compiled, cut));
  }
});

test("mixed wait, interaction, instant, and pacing composition keeps event ordering canonical", () => {
  const compiled = plan([
    'say "one"',
    "wait 1 s",
    'say "two"',
    'showButton "Continue"',
    'say "now", instant',
    'say "four"',
    "exit",
  ].join("\n"));
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const delay = waiting.snapshot.foregroundAction;
  const background = waiting.snapshot.backgroundActions[0];
  assert.equal(delay?.kind, "delay");
  assert.equal(background?.kind, "chatPacingGate");
  assert.deepEqual(waiting.events.map((event) => event.kind), ["say", "actionRequested", "actionRequested"]);

  const delayCompleted = observeTime(compiled, waiting.snapshot, 1_000);
  assert.deepEqual(delayCompleted.events.map((event) => event.kind), ["actionCompleted"]);
  assert.equal(delayCompleted.snapshot.backgroundActions[0]?.actionId, background?.actionId);
  assert.equal(delayCompleted.snapshot.foregroundAction, null);

  const promoted = run(compiled, delayCompleted.snapshot);
  const pacing = promoted.snapshot.foregroundAction;
  assert.equal(pacing?.kind, "chatPacingGate");
  assert.equal(pacing?.actionId, background?.actionId);
  assert.equal(promoted.events.filter((event) => event.kind === "actionRequested").length, 0);

  const released = observeTime(compiled, promoted.snapshot, pacing!.deadlineMs);
  const interactionWaiting = run(compiled, released.snapshot);
  assert.deepEqual(interactionWaiting.events.map((event) => event.kind), ["say", "actionRequested", "actionCompleted", "actionRequested"]);
  assert.equal(
    interactionWaiting.events[2]?.kind === "actionCompleted" &&
      interactionWaiting.events[2].settlement.settlementKind,
    "consumedByForegroundInteraction",
  );
  const interaction = interactionWaiting.snapshot.foregroundAction;
  assert.equal(interaction?.kind, "interaction");

  const interactionCompleted = completeAction(compiled, interactionWaiting.snapshot, {
    actionId: interaction!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });
  assert.deepEqual(interactionCompleted.events.map((event) => event.kind), ["playerTranscript", "actionCompleted"]);
  const finalRun = run(compiled, interactionCompleted.snapshot);
  assert.deepEqual(finalRun.events.map((event) => event.kind), ["say", "say", "actionRequested", "exit"]);
  assert.equal(finalRun.snapshot.backgroundActions[0]?.kind, "chatPacingGate");
  assert.equal(finalRun.snapshot.backgroundActions[0]?.actionId, interaction!.actionId + 1);
  assert.equal(validateRuntimeSnapshot(finalRun.snapshot, compiled).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, finalRun.snapshot))));
});

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
