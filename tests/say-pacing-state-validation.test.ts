import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
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

function checkpointSnapshot(
  compiled: ReturnType<typeof plan>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
): any {
  return JSON.parse(serializeCheckpoint(createCheckpoint(compiled, snapshot))).snapshot;
}

function mutateCheckpoint(
  compiled: ReturnType<typeof plan>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
  mutate: (snapshot: any) => void,
): unknown {
  const checkpoint = JSON.parse(serializeCheckpoint(createCheckpoint(compiled, snapshot))) as { snapshot: any };
  mutate(checkpoint.snapshot);
  return checkpoint;
}

function expectInvalidSnapshot(
  label: string,
  compiled: ReturnType<typeof plan>,
  snapshot: unknown,
): void {
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, false, label);
  const checkpoint = JSON.stringify({
    ...JSON.parse(serializeCheckpoint(createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled)))),
    snapshot,
  });
  assert.throws(() => deserializeCheckpoint(checkpoint), label);
}

test("older pacing gate promotes after a newer delay settlement and resumes prepared output once", () => {
  const compiled = plan('say "first"\nwait 1 s\nsay "second"\nexit');
  const initial = run(compiled, createFreshRuntimeSnapshot(compiled));
  const pacing = initial.snapshot.backgroundActions[0];
  const delay = initial.snapshot.foregroundAction;
  assert.equal(pacing?.kind, "chatPacingGate");
  assert.equal(pacing?.actionId, 1);
  assert.equal(delay?.kind, "delay");
  assert.equal(delay?.actionId, 2);

  const delaySettled = observeTime(compiled, initial.snapshot, delay!.deadlineMs);
  assert.equal(delaySettled.snapshot.lastSettlement?.actionId, 2);
  assert.equal(delaySettled.snapshot.backgroundActions[0]?.actionId, 1);

  const promoted = run(compiled, delaySettled.snapshot);
  const gate = promoted.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate?.actionId, 1);
  assert.equal(gate?.deadlineMs, pacing?.deadlineMs);
  assert.equal(promoted.events.filter((event) => event.kind === "actionRequested").length, 0);
  assert.equal(validateRuntimeSnapshot(promoted.snapshot, compiled).valid, true);

  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, promoted.snapshot)));
  assert.deepEqual(restored.snapshot, promoted.snapshot);
  const released = completeAction(restored.plan, restored.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, released.snapshot);
  assert.equal(resumed.events.filter((event) => event.kind === "say" && event.text === "second").length, 1);
});

test("active-action and retained-settlement relations admit only canonical cross-kind timing", () => {
  const promotionPlan = plan('say "first"\nwait 1 s\nsay "second"\nexit');
  const initial = run(promotionPlan, createFreshRuntimeSnapshot(promotionPlan));
  const delay = initial.snapshot.foregroundAction;
  assert.equal(delay?.kind, "delay");
  const promoted = run(promotionPlan, observeTime(promotionPlan, initial.snapshot, delay!.deadlineMs).snapshot);
  assert.equal(validateRuntimeSnapshot(promoted.snapshot, promotionPlan).valid, true, "older pacing with newer delay");

  const longWaitPlan = plan('say "first"\nwait 10 s\nexit');
  const longWait = run(longWaitPlan, createFreshRuntimeSnapshot(longWaitPlan));
  const pacingSettled = observeTime(longWaitPlan, longWait.snapshot, 1_800);
  assert.equal(pacingSettled.snapshot.foregroundAction?.kind, "delay");
  assert.equal(pacingSettled.snapshot.lastSettlement?.actionKind, "chatPacingGate");
  assert.equal(validateRuntimeSnapshot(pacingSettled.snapshot, longWaitPlan).valid, true, "active delay after older pacing");

  const newerPlan = plan('say "first"\nsay "second", instant\nwait 10 s\nexit');
  const newer = run(newerPlan, createFreshRuntimeSnapshot(newerPlan));
  assert.equal(newer.snapshot.foregroundAction?.kind, "delay");
  assert.equal(newer.snapshot.lastSettlement?.actionKind, "chatPacingGate");
  assert.equal(validateRuntimeSnapshot(newer.snapshot, newerPlan).valid, true, "new active delay after settlement");

  const duplicateId = checkpointSnapshot(promotionPlan, promoted.snapshot);
  duplicateId.foregroundAction.actionId = duplicateId.lastSettlement.actionId;
  expectInvalidSnapshot("active and retained action identities collide", promotionPlan, duplicateId);

  const newerPacingSettlement = checkpointSnapshot(promotionPlan, promoted.snapshot);
  newerPacingSettlement.lastSettlement = {
    actionId: 2,
    actionKind: "chatPacingGate",
    settlementKind: "skipped",
    owningInstruction: 0,
    continuationInstruction: 1,
    requestEventSequence: 3,
    completionEventSequence: 4,
    deadlineMs: 1_800,
    completedAtMs: 1_000,
    releasedPreparedOutput: false,
  };
  expectInvalidSnapshot("older foreground pacing cannot coexist with newer pacing settlement", promotionPlan, newerPacingSettlement);

  const invalidOrdering = checkpointSnapshot(promotionPlan, promoted.snapshot);
  invalidOrdering.foregroundAction.requestEventSequence = invalidOrdering.lastSettlement.requestEventSequence;
  expectInvalidSnapshot("older pacing must predate the retained delay request", promotionPlan, invalidOrdering);

  const invalidCausalOrdering = checkpointSnapshot(promotionPlan, promoted.snapshot);
  invalidCausalOrdering.lastSettlement.requestEventSequence = 1;
  expectInvalidSnapshot("request ordering remains relational when action IDs look plausible", promotionPlan, invalidCausalOrdering);

  const interactionPlan = plan('say "first"\nwait 1 s\nsay "second"\nshowButton "Continue"\nexit');
  const interactionInitial = run(interactionPlan, createFreshRuntimeSnapshot(interactionPlan));
  const interactionDelay = interactionInitial.snapshot.foregroundAction;
  assert.equal(interactionDelay?.kind, "delay");
  const interactionPromoted = run(
    interactionPlan,
    observeTime(interactionPlan, interactionInitial.snapshot, interactionDelay!.deadlineMs).snapshot,
  );
  const firstGate = interactionPromoted.snapshot.foregroundAction;
  assert.equal(firstGate?.kind, "chatPacingGate");
  const released = completeAction(interactionPlan, interactionPromoted.snapshot, {
    actionId: firstGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const interactionWaiting = run(interactionPlan, released.snapshot);
  const interaction = interactionWaiting.snapshot.foregroundAction;
  assert.equal(interaction?.kind, "interaction");
  const interactionSettled = completeAction(interactionPlan, interactionWaiting.snapshot, {
    actionId: interaction!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });

  const newerInteractionSettlement = checkpointSnapshot(interactionPlan, interactionPromoted.snapshot);
  newerInteractionSettlement.lastSettlement = structuredClone(interactionSettled.snapshot.lastSettlement);
  newerInteractionSettlement.nextActionId = interactionSettled.snapshot.nextActionId;
  newerInteractionSettlement.nextEventSequence = interactionSettled.snapshot.nextEventSequence;
  expectInvalidSnapshot("older foreground pacing cannot coexist with a newer interaction settlement", interactionPlan, newerInteractionSettlement);
});

test("retained replay remains bounded across the legal cross-kind relations", () => {
  const compiled = plan('say "first"\nwait 10 s\nexit');
  const initial = run(compiled, createFreshRuntimeSnapshot(compiled));
  const pacing = initial.snapshot.backgroundActions[0];
  const delay = initial.snapshot.foregroundAction;
  assert.equal(pacing?.kind, "chatPacingGate");
  assert.equal(delay?.kind, "delay");

  const pacingSettled = observeTime(compiled, initial.snapshot, pacing!.deadlineMs);
  assert.equal(completeAction(compiled, pacingSettled.snapshot, {
    actionId: pacing!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  }).outcome.kind, "alreadySettled");

  const delaySettled = observeTime(compiled, pacingSettled.snapshot, delay!.deadlineMs);
  assert.equal(completeAction(compiled, delaySettled.snapshot, {
    actionId: pacing!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  }).outcome.kind, "staleAction");
  assert.equal(completeAction(compiled, delaySettled.snapshot, {
    actionId: 999,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  }).outcome.kind, "unknownAction");

  const baseline = JSON.stringify(initial.snapshot);
  const wrongKind = completeAction(compiled, initial.snapshot, {
    actionId: delay!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(wrongKind.outcome.kind, "wrongActionKind");
  assert.equal(JSON.stringify(wrongKind.snapshot), baseline);
});

test("current pacing serialization versions accept only their exact schemas", () => {
  const compiled = plan('say "first"\nexit');
  const snapshot = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  const checkpoint = JSON.parse(serializeCheckpoint(createCheckpoint(compiled, snapshot)));
  assert.equal(compiled.version, 9);
  assert.equal(snapshot.version, 11);
  assert.equal(checkpoint.version, 13);
  assert.doesNotThrow(() => deserializeCheckpoint(JSON.stringify(checkpoint)));

  const oldSnapshot = structuredClone(snapshot) as any;
  oldSnapshot.version = 10;
  assert.equal(validateRuntimeSnapshot(oldSnapshot, compiled).valid, false);
  const oldCheckpoint = structuredClone(checkpoint);
  oldCheckpoint.version = 12;
  assert.throws(() => deserializeCheckpoint(JSON.stringify(oldCheckpoint)));
});

test("snapshot and checkpoint reject malformed pacing prepared output", () => {
  const compiled = plan('speaker vera { displayName: "Vera" }\nsay as vera "first"\nsay as vera "second"');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const corrupted = JSON.parse(serializeCheckpoint(
    createCheckpoint(compiled, waiting.snapshot),
  )) as {
    snapshot: {
      foregroundAction: {
        preparedOutput: { speaker: Record<string, unknown>; durationMs: number };
      };
    };
  };
  corrupted.snapshot.foregroundAction.preparedOutput.speaker.extra = "unexpected";

  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));

  delete corrupted.snapshot.foregroundAction.preparedOutput.speaker.extra;
  corrupted.snapshot.foregroundAction.preparedOutput.durationMs = 0;
  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));

  corrupted.snapshot.foregroundAction.preparedOutput.durationMs = 1;
  (corrupted.snapshot.foregroundAction as unknown as { skippable: unknown }).skippable = "yes";
  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));
});

test("snapshot and checkpoint reject representative malformed pacing action state", () => {
  const backgroundPlan = plan('say "first"\nexit');
  const background = run(backgroundPlan, createFreshRuntimeSnapshot(backgroundPlan));
  const foregroundPlan = plan('say "first"\nsay "second"');
  const foreground = run(foregroundPlan, createFreshRuntimeSnapshot(foregroundPlan));
  const foregroundGate = foreground.snapshot.foregroundAction;
  assert.equal(foregroundGate?.kind, "chatPacingGate");
  if (foregroundGate?.kind !== "chatPacingGate") throw new Error("Expected a promoted pacing gate.");
  const functionPlan = plan('function f { say "first" }\nf()\nexit');
  const functionBackground = run(functionPlan, createFreshRuntimeSnapshot(functionPlan));
  const settled = completeAction(backgroundPlan, background.snapshot, {
    actionId: 1,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const corruptions: Array<[string, unknown, typeof backgroundPlan | typeof foregroundPlan]> = [
    ["action identity", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].actionId = 0; }), backgroundPlan],
    ["action kind", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].kind = "delay"; }), backgroundPlan],
    ["deadline", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].deadlineMs = 0; }), backgroundPlan],
    ["request sequence", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].requestEventSequence = snapshot.nextEventSequence; }), backgroundPlan],
    ["background uniqueness", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions.push(structuredClone(snapshot.backgroundActions[0])); }), backgroundPlan],
    ["foreground/background location", mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => { snapshot.backgroundActions.push(structuredClone(snapshot.foregroundAction)); }), foregroundPlan],
    ["background prepared output", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].preparedOutput = structuredClone(foregroundGate.preparedOutput); }), backgroundPlan],
    ["foreground prepared output ownership", mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => { snapshot.foregroundAction.preparedOutput = null; }), foregroundPlan],
    ["waiting status ownership", mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => { snapshot.status = "running"; }), foregroundPlan],
    ["prepared continuation", mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => { snapshot.foregroundAction.preparedOutput.continuationInstruction += 1; }), foregroundPlan],
    ["pacing settlement", mutateCheckpoint(backgroundPlan, settled.snapshot, (snapshot) => { snapshot.lastSettlement.actionKind = "delay"; }), backgroundPlan],
    ["settlement completed time", mutateCheckpoint(backgroundPlan, settled.snapshot, (snapshot) => { snapshot.lastSettlement.completedAtMs = snapshot.currentSessionTimeMs + 1; }), backgroundPlan],
    ["unwound function provenance", mutateCheckpoint(functionPlan, functionBackground.snapshot, (snapshot) => { snapshot.backgroundActions[0].ownerCallFrameId = snapshot.nextCallFrameId; }), functionPlan],
  ];

  for (const [label, checkpoint, compiled] of corruptions) {
    const snapshot = (checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, false, label);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), label);
  }
});

test("runtime-produced pacing states validate and checkpoint through their lifecycle", () => {
  const positive = plan('say "first"\nexit');
  const background = run(positive, createFreshRuntimeSnapshot(positive));

  const waitPlan = plan('say "first"\nwait 10 s\nexit');
  const withWait = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const waitGate = withWait.snapshot.backgroundActions[0];
  assert.equal(waitGate?.kind, "chatPacingGate");
  const backgroundSkipped = completeAction(waitPlan, withWait.snapshot, {
    actionId: waitGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const backgroundTimed = observeTime(waitPlan, withWait.snapshot, 1_800);

  const shortWaitPlan = plan('say "first"\nwait 1 s\nexit');
  const shortWait = run(shortWaitPlan, createFreshRuntimeSnapshot(shortWaitPlan));
  const delaySettled = observeTime(shortWaitPlan, shortWait.snapshot, 1_000);

  const interactionPlan = plan('say "first"\nshowButton "Continue"');
  const interaction = run(interactionPlan, createFreshRuntimeSnapshot(interactionPlan));

  const instantPlan = plan('say "first"\nsay "now", instant');
  const instant = run(instantPlan, createFreshRuntimeSnapshot(instantPlan));

  const promotionPlan = plan('say "first"\nsay "second"');
  const promoted = run(promotionPlan, createFreshRuntimeSnapshot(promotionPlan));
  const promotedGate = promoted.snapshot.foregroundAction;
  assert.equal(promotedGate?.kind, "chatPacingGate");
  const releasedByTime = observeTime(promotionPlan, promoted.snapshot, promotedGate!.deadlineMs);
  const releasedBySkip = completeAction(promotionPlan, promoted.snapshot, {
    actionId: promotedGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const replacement = run(promotionPlan, releasedBySkip.snapshot);

  const unwoundPlans = [
    plan('if true { say "branch" }\nexit'),
    plan('repeat 1 { say "loop" }\nexit'),
    plan('function f { say "call" }\nf()\nexit'),
  ];
  const unwound = unwoundPlans.map((compiled) => ({
    compiled,
    snapshot: run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot,
  }));

  const states: Array<[string, ReturnType<typeof plan>, unknown]> = [
    ["initial background gate", positive, background.snapshot],
    ["background gate with foreground wait", waitPlan, withWait.snapshot],
    ["background skip while wait remains", waitPlan, backgroundSkipped.snapshot],
    ["background time settlement while wait remains", waitPlan, backgroundTimed.snapshot],
    ["foreground delay settlement with older background gate", shortWaitPlan, delaySettled.snapshot],
    ["interaction consumption", interactionPlan, interaction.snapshot],
    ["instant supersession", instantPlan, instant.snapshot],
    ["later say promotion", promotionPlan, promoted.snapshot],
    ["foreground pacing time release", promotionPlan, releasedByTime.snapshot],
    ["foreground pacing skip release", promotionPlan, releasedBySkip.snapshot],
    ["prepared output normal re-entry", promotionPlan, replacement.snapshot],
    ["branch unwind", unwound[0]!.compiled, unwound[0]!.snapshot],
    ["loop unwind", unwound[1]!.compiled, unwound[1]!.snapshot],
    ["function unwind", unwound[2]!.compiled, unwound[2]!.snapshot],
    ["halted execution with a background gate", positive, background.snapshot],
  ];

  for (const [label, compiled, snapshot] of states) {
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true, label);
    const restored = deserializeCheckpoint(serializeCheckpoint(
      createCheckpoint(compiled, snapshot as ReturnType<typeof createFreshRuntimeSnapshot>),
    ));
    assert.deepEqual(restored.snapshot, snapshot, label);
  }
});

test("pacing state validation rejects relational identity, property, duration, and prepared-output corruption", () => {
  const waitPlan = plan('say "first"\nwait 10 s\nexit');
  const waiting = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const gate = waiting.snapshot.backgroundActions[0];
  assert.equal(gate?.kind, "chatPacingGate");
  const retained = completeAction(waitPlan, waiting.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const speakerPlan = plan('speaker vera { defaultSaySkippable: true\ncustom: "kept" }\nexit');
  const speakerState = run(speakerPlan, createFreshRuntimeSnapshot(speakerPlan));
  assert.equal(validateRuntimeSnapshot(speakerState.snapshot, speakerPlan).valid, true);
  const falseSpeakerCheckpoint = mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
    snapshot.speakers[0].properties[0].value = false;
  });
  assert.equal(validateRuntimeSnapshot((falseSpeakerCheckpoint as { snapshot: unknown }).snapshot, speakerPlan).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(JSON.stringify(falseSpeakerCheckpoint)));

  const preparedPlan = plan('say "first"\nsay "second"');
  const promoted = run(preparedPlan, createFreshRuntimeSnapshot(preparedPlan));
  const promotedGate = promoted.snapshot.foregroundAction;
  assert.equal(promotedGate?.kind, "chatPacingGate");
  const prepared = completeAction(preparedPlan, promoted.snapshot, {
    actionId: promotedGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.notEqual(prepared.snapshot.preparedSayOutput, null);

  const validMaximumDuration = mutateCheckpoint(preparedPlan, promoted.snapshot, (snapshot) => {
    snapshot.foregroundAction.preparedOutput.durationMs = Number.MAX_SAFE_INTEGER;
  });
  assert.equal(validateRuntimeSnapshot((validMaximumDuration as { snapshot: unknown }).snapshot, preparedPlan).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(JSON.stringify(validMaximumDuration)));
  const nonFiniteDuration = mutateCheckpoint(preparedPlan, promoted.snapshot, (snapshot) => {
    snapshot.foregroundAction.preparedOutput.durationMs = Number.POSITIVE_INFINITY;
  });
  assert.equal(validateRuntimeSnapshot((nonFiniteDuration as { snapshot: unknown }).snapshot, preparedPlan).valid, false);

  const corruptions = [
    {
      name: "duplicate active action ID",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].actionId = snapshot.foregroundAction.actionId;
      }),
    },
    {
      name: "duplicate active request sequence",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].requestEventSequence = snapshot.foregroundAction.requestEventSequence;
      }),
    },
    {
      name: "active ID equals settlement ID",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, retained.snapshot, (snapshot) => {
        snapshot.foregroundAction.actionId = snapshot.lastSettlement.actionId;
      }),
    },
    {
      name: "active request equals settlement request",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, retained.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence = snapshot.lastSettlement.requestEventSequence;
      }),
    },
    {
      name: "active request equals settlement completion",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, retained.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence = snapshot.lastSettlement.completionEventSequence;
      }),
    },
    {
      name: "malformed settlement events",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, retained.snapshot, (snapshot) => {
        snapshot.lastSettlement.requestEventSequence = snapshot.lastSettlement.completionEventSequence;
      }),
    },
    {
      name: "invalid speaker default number",
      compiled: speakerPlan,
      checkpoint: mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
        snapshot.speakers[0].properties[0].value = 123;
      }),
    },
    {
      name: "invalid speaker default string",
      compiled: speakerPlan,
      checkpoint: mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
        snapshot.speakers[0].properties[0].value = "false";
      }),
    },
    {
      name: "invalid speaker default null",
      compiled: speakerPlan,
      checkpoint: mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
        snapshot.speakers[0].properties[0].value = null;
      }),
    },
    {
      name: "invalid speaker default object",
      compiled: speakerPlan,
      checkpoint: mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
        snapshot.speakers[0].properties[0].value = { kind: "object", properties: [] };
      }),
    },
    {
      name: "invalid speaker default list",
      compiled: speakerPlan,
      checkpoint: mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
        snapshot.speakers[0].properties[0].value = { kind: "list", items: [] };
      }),
    },
    {
      name: "prepared duration exceeds supported domain",
      compiled: preparedPlan,
      checkpoint: mutateCheckpoint(preparedPlan, promoted.snapshot, (snapshot) => {
        snapshot.foregroundAction.preparedOutput.durationMs = Number.MAX_SAFE_INTEGER + 1;
      }),
    },
    {
      name: "top-level prepared output without release settlement",
      compiled: preparedPlan,
      checkpoint: mutateCheckpoint(preparedPlan, prepared.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutput = false;
      }),
    },
    {
      name: "top-level prepared output with incompatible status",
      compiled: preparedPlan,
      checkpoint: mutateCheckpoint(preparedPlan, prepared.snapshot, (snapshot) => {
        snapshot.status = "waiting";
      }),
    },
    {
      name: "top-level prepared output with a background gate",
      compiled: preparedPlan,
      checkpoint: mutateCheckpoint(preparedPlan, prepared.snapshot, (snapshot) => {
        snapshot.backgroundActions.push(structuredClone(waiting.snapshot.backgroundActions[0]));
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = (corruption.checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, corruption.compiled).valid, false, corruption.name);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)), corruption.name);
  }
});

test("cross-field pacing snapshot corruption rejects at direct and checkpoint boundaries", () => {
  const waitPlan = plan('say "first"\nwait 10 s\nexit');
  const waiting = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const promotedPlan = plan('say "first"\nsay "second"');
  const promoted = run(promotedPlan, createFreshRuntimeSnapshot(promotedPlan));
  const promotedGate = promoted.snapshot.foregroundAction;
  assert.equal(promotedGate?.kind, "chatPacingGate");
  const speakerPlan = plan('speaker vera { defaultSaySkippable: true }\nexit');
  const speakerState = run(speakerPlan, createFreshRuntimeSnapshot(speakerPlan));
  const interactionPlan = plan('say "first"\nshowButton "Continue"\nwait 10 s\nexit');
  const interactionWaiting = run(interactionPlan, createFreshRuntimeSnapshot(interactionPlan));
  const interaction = interactionWaiting.snapshot.foregroundAction;
  assert.equal(interaction?.kind, "interaction");
  const interactionSettled = completeAction(interactionPlan, interactionWaiting.snapshot, {
    actionId: interaction!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });
  const laterWait = run(interactionPlan, interactionSettled.snapshot);

  const corruptions: Array<[string, ReturnType<typeof plan>, unknown]> = [
    ["foreground gate moved to background", promotedPlan, mutateCheckpoint(promotedPlan, promoted.snapshot, (snapshot) => {
      snapshot.backgroundActions.push(snapshot.foregroundAction);
      snapshot.foregroundAction = null;
    })],
    ["prepared output moved to top level while foreground remains", promotedPlan, mutateCheckpoint(promotedPlan, promoted.snapshot, (snapshot) => {
      snapshot.preparedSayOutput = snapshot.foregroundAction.preparedOutput;
    })],
    ["pacing deadline before current time", waitPlan, mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
      snapshot.backgroundActions[0].deadlineMs = snapshot.currentSessionTimeMs;
    })],
    ["next action ID reuses active identity", waitPlan, mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
      snapshot.nextActionId = snapshot.foregroundAction.actionId;
    })],
    ["next event sequence reuses request identity", waitPlan, mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
      snapshot.nextEventSequence = snapshot.foregroundAction.requestEventSequence;
    })],
    ["prepared continuation is not say", promotedPlan, mutateCheckpoint(promotedPlan, promoted.snapshot, (snapshot) => {
      snapshot.foregroundAction.preparedOutput.owningInstruction = 2;
      snapshot.foregroundAction.preparedOutput.continuationInstruction = 3;
      snapshot.nextInstruction = 2;
    })],
    ["background gate carries prepared output", waitPlan, mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
      snapshot.backgroundActions[0].preparedOutput = structuredClone(promotedGate?.preparedOutput);
    })],
    ["multiple background gates", waitPlan, mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
      snapshot.backgroundActions.push(structuredClone(snapshot.backgroundActions[0]));
    })],
    ["extra pacing setting", waitPlan, mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
      snapshot.chatPacingSettings.extra = 1;
    })],
    ["missing pacing setting", waitPlan, mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
      delete snapshot.chatPacingSettings.baseDelayMs;
    })],
    ["duplicate speaker pacing property", speakerPlan, mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
      snapshot.speakers[0].properties.push(structuredClone(snapshot.speakers[0].properties[0]));
    })],
    ["active request collides with interaction transcript", interactionPlan, mutateCheckpoint(interactionPlan, laterWait.snapshot, (snapshot) => {
      snapshot.foregroundAction.requestEventSequence = snapshot.lastSettlement.transcriptEventSequence;
    })],
  ];

  for (const [label, compiled, checkpoint] of corruptions) {
    const snapshot = (checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, false, label);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), label);
  }
});

test("pacing settlement release provenance and chronology accept only canonical lifecycle states", () => {
  const backgroundPlan = plan('say "first"\nsay "second"');
  const background = executeInstruction(backgroundPlan, createFreshRuntimeSnapshot(backgroundPlan));
  const backgroundGate = background.snapshot.backgroundActions[0];
  assert.equal(backgroundGate?.kind, "chatPacingGate");
  const backgroundCompleted = observeTime(backgroundPlan, background.snapshot, backgroundGate!.deadlineMs);
  const backgroundSkipped = completeAction(backgroundPlan, background.snapshot, {
    actionId: backgroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const interactionPlan = plan('say "first"\nshowButton "Continue"');
  const interaction = run(interactionPlan, createFreshRuntimeSnapshot(interactionPlan));
  const instantPlan = plan('say "first"\nsay "second", instant');
  const superseded = run(instantPlan, createFreshRuntimeSnapshot(instantPlan));

  const promotionPlan = plan('say "first"\nsay "second"');
  const promoted = run(promotionPlan, createFreshRuntimeSnapshot(promotionPlan));
  const foregroundGate = promoted.snapshot.foregroundAction;
  assert.equal(foregroundGate?.kind, "chatPacingGate");
  const foregroundCompleted = observeTime(promotionPlan, promoted.snapshot, foregroundGate!.deadlineMs);
  const foregroundSkipped = completeAction(promotionPlan, promoted.snapshot, {
    actionId: foregroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const cases = [
    {
      name: "background time completion",
      compiled: backgroundPlan,
      snapshot: backgroundCompleted.snapshot,
      kind: "completed",
      releasedPreparedOutput: false,
      hasPreparedOutput: false,
    },
    {
      name: "background typed skip",
      compiled: backgroundPlan,
      snapshot: backgroundSkipped.snapshot,
      kind: "skipped",
      releasedPreparedOutput: false,
      hasPreparedOutput: false,
    },
    {
      name: "interaction consumes background pacing",
      compiled: interactionPlan,
      snapshot: interaction.snapshot,
      kind: "consumedByForegroundInteraction",
      releasedPreparedOutput: false,
      hasPreparedOutput: false,
    },
    {
      name: "instant output supersedes background pacing",
      compiled: instantPlan,
      snapshot: superseded.snapshot,
      kind: "supersededByInstantOutput",
      releasedPreparedOutput: false,
      hasPreparedOutput: false,
    },
    {
      name: "foreground time completion releases prepared output",
      compiled: promotionPlan,
      snapshot: foregroundCompleted.snapshot,
      kind: "completed",
      releasedPreparedOutput: true,
      hasPreparedOutput: true,
    },
    {
      name: "foreground typed skip releases prepared output",
      compiled: promotionPlan,
      snapshot: foregroundSkipped.snapshot,
      kind: "skipped",
      releasedPreparedOutput: true,
      hasPreparedOutput: true,
    },
  ] as const;

  for (const scenario of cases) {
    const settlement = scenario.snapshot.lastSettlement;
    assert.equal(settlement?.actionKind, "chatPacingGate", scenario.name);
    if (settlement?.actionKind !== "chatPacingGate") throw new Error(scenario.name);
    assert.equal(settlement?.settlementKind, scenario.kind, scenario.name);
    assert.equal(settlement?.releasedPreparedOutput, scenario.releasedPreparedOutput, scenario.name);
    assert.equal(scenario.snapshot.preparedSayOutput !== null, scenario.hasPreparedOutput, scenario.name);
    assert.equal(validateRuntimeSnapshot(scenario.snapshot, scenario.compiled).valid, true, scenario.name);
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(scenario.compiled, scenario.snapshot)));
    assert.deepEqual(restored.snapshot, scenario.snapshot, scenario.name);
  }

  const advancedAfterSkip = observeTime(backgroundPlan, backgroundSkipped.snapshot, 2_000);
  const corruptions = [
    {
      name: "prepared output requires release evidence",
      compiled: promotionPlan,
      checkpoint: mutateCheckpoint(promotionPlan, foregroundSkipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutput = false;
      }),
    },
    {
      name: "background skip cannot falsely claim prepared-output release",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutput = true;
      }),
    },
    {
      name: "background skip cannot release injected prepared output",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        snapshot.preparedSayOutput = structuredClone(
          foregroundSkipped.snapshot.preparedSayOutput,
        );
      }),
    },
    {
      name: "consumption cannot claim prepared-output release",
      compiled: interactionPlan,
      checkpoint: mutateCheckpoint(interactionPlan, interaction.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutput = true;
      }),
    },
    {
      name: "supersession cannot claim prepared-output release",
      compiled: instantPlan,
      checkpoint: mutateCheckpoint(instantPlan, superseded.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutput = true;
      }),
    },
    {
      name: "non-time settlement cannot complete at its deadline",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, advancedAfterSkip.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.lastSettlement.deadlineMs;
      }),
    },
    {
      name: "non-time settlement cannot complete after its deadline",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, advancedAfterSkip.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.lastSettlement.deadlineMs + 1;
      }),
    },
    {
      name: "time settlement cannot complete before its deadline",
      compiled: promotionPlan,
      checkpoint: mutateCheckpoint(promotionPlan, foregroundCompleted.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.lastSettlement.deadlineMs - 1;
      }),
    },
    {
      name: "pacing settlement requires boolean release evidence",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutput = "false";
      }),
    },
    {
      name: "pacing settlement requires the release evidence key",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        delete snapshot.lastSettlement.releasedPreparedOutput;
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = (corruption.checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, corruption.compiled).valid, false, corruption.name);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)), corruption.name);
  }
});

test("instruction boundaries preserve pacing release provenance before and after promotion", () => {
  const compiled = plan('say ["first", "first-alt"]\nsay ["second", "second-alt"]');
  const afterFirst = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled, { seed: 77 }));
  const backgroundGate = afterFirst.snapshot.backgroundActions[0];
  assert.equal(backgroundGate?.kind, "chatPacingGate");

  const restoredBackground = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, afterFirst.snapshot)));
  const backgroundSkip = completeAction(restoredBackground.plan, restoredBackground.snapshot, {
    actionId: backgroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(backgroundSkip.snapshot.lastSettlement?.actionKind, "chatPacingGate");
  if (backgroundSkip.snapshot.lastSettlement?.actionKind !== "chatPacingGate") throw new Error("Expected pacing settlement.");
  assert.equal(backgroundSkip.snapshot.lastSettlement.releasedPreparedOutput, false);
  assert.equal(backgroundSkip.snapshot.preparedSayOutput, null);

  const secondAsFreshOutput = executeInstruction(compiled, backgroundSkip.snapshot);
  assert.equal(secondAsFreshOutput.events.filter((event) => event.kind === "say").length, 1);
  assert.equal(secondAsFreshOutput.snapshot.backgroundActions[0]?.actionId, 2);

  const promoted = run(restoredBackground.plan, restoredBackground.snapshot);
  const foregroundGate = promoted.snapshot.foregroundAction;
  assert.equal(foregroundGate?.kind, "chatPacingGate");
  assert.equal(foregroundGate?.actionId, backgroundGate?.actionId);
  assert.equal(foregroundGate?.deadlineMs, backgroundGate?.deadlineMs);
  assert.equal(promoted.events.filter((event) => event.kind === "actionRequested").length, 0);

  const released = completeAction(compiled, promoted.snapshot, {
    actionId: foregroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(released.snapshot.lastSettlement?.actionKind, "chatPacingGate");
  if (released.snapshot.lastSettlement?.actionKind !== "chatPacingGate") throw new Error("Expected pacing settlement.");
  assert.equal(released.snapshot.lastSettlement.releasedPreparedOutput, true);
  assert.notEqual(released.snapshot.preparedSayOutput, null);

  const restoredRelease = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, released.snapshot)));
  const resumed = executeInstruction(restoredRelease.plan, restoredRelease.snapshot);
  assert.equal(resumed.events.filter((event) => event.kind === "say").length, 1);
  assert.equal(resumed.snapshot.backgroundActions[0]?.actionId, 2);
  assert.equal(resumed.snapshot.rng.state, secondAsFreshOutput.snapshot.rng.state);
});
