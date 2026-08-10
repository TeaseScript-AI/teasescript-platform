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

function expectCheckpointJsonRoundTrip(
  label: string,
  compiled: ReturnType<typeof plan>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
): void {
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true, label);

  const checkpoint = createCheckpoint(compiled, snapshot);
  const restored = deserializeCheckpoint(serializeCheckpoint(checkpoint));

  assert.equal(validateRuntimeSnapshot(restored.snapshot, compiled).valid, true, label);
  assert.deepEqual(restored.snapshot, snapshot, label);
}

function checkpointWithSnapshot(
  baseline: { snapshot: any },
  snapshot: unknown,
): unknown {
  const checkpoint = structuredClone(baseline);
  checkpoint.snapshot = snapshot;
  return checkpoint;
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

test("explicit exit cleans released pacing lineage without admitting forged pacing work", () => {
  const compiled = plan('say "first", 5\nsay "second", 5\nexit');
  const promoted = run(compiled, createFreshRuntimeSnapshot(compiled));
  const gate = promoted.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const released = completeAction(compiled, promoted.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const beforeExit = executeInstruction(compiled, released.snapshot);
  const replacement = beforeExit.snapshot.backgroundActions[0];
  assert.equal(replacement?.kind, "chatPacingGate");
  const exited = executeInstruction(compiled, beforeExit.snapshot);

  assert.equal(exited.snapshot.status, "halted");
  assert.equal(validateRuntimeSnapshot(exited.snapshot, compiled).valid, true);
  expectCheckpointJsonRoundTrip("explicit exit after released pacing output", compiled, exited.snapshot);

  const forgedPacing = checkpointSnapshot(compiled, exited.snapshot);
  forgedPacing.backgroundActions.push(structuredClone(replacement));
  expectInvalidSnapshot("explicit exit cannot retain pacing work", compiled, forgedPacing);

  const forgedPreparedOutput = checkpointSnapshot(compiled, exited.snapshot);
  forgedPreparedOutput.preparedSayOutput = structuredClone(released.snapshot.preparedSayOutput);
  expectInvalidSnapshot("explicit exit cannot retain prepared pacing output", compiled, forgedPreparedOutput);

  const naturalRoot = plan('say "first", 5');
  const naturallyHalted = run(naturalRoot, createFreshRuntimeSnapshot(naturalRoot));
  assert.equal(naturallyHalted.snapshot.status, "halted");
  assert.equal(naturallyHalted.snapshot.backgroundActions.length, 1);
  expectCheckpointJsonRoundTrip("natural root may retain background pacing", naturalRoot, naturallyHalted.snapshot);
});

test("terminal continuation handoffs reject malformed external state and preserve result-free buttons", () => {
  const delayPlan = plan('say "first", 5\nwait 1 ms');
  const waiting = run(delayPlan, createFreshRuntimeSnapshot(delayPlan));
  const delay = waiting.snapshot.foregroundAction;
  assert.equal(delay?.kind, "delay");
  const settled = observeTime(delayPlan, waiting.snapshot, delay!.deadlineMs);
  assert.notEqual(settled.snapshot.terminalContinuationHandoff, null);
  expectCheckpointJsonRoundTrip("terminal delay handoff", delayPlan, settled.snapshot);

  const corruptions = [
    {
      name: "missing terminal continuation handoff",
      checkpoint: mutateCheckpoint(delayPlan, settled.snapshot, (snapshot) => {
        snapshot.terminalContinuationHandoff = null;
      }),
    },
    {
      name: "terminal handoff cannot claim a pacing instruction",
      checkpoint: mutateCheckpoint(delayPlan, settled.snapshot, (snapshot) => {
        snapshot.terminalContinuationHandoff.owningInstruction = 0;
      }),
    },
    {
      name: "terminal handoff action identity cannot be stale",
      checkpoint: mutateCheckpoint(delayPlan, settled.snapshot, (snapshot) => {
        snapshot.terminalContinuationHandoff.actionId = 1;
      }),
    },
    {
      name: "terminal handoff requires its settlement or later pacing replacement",
      checkpoint: mutateCheckpoint(delayPlan, settled.snapshot, (snapshot) => {
        snapshot.lastSettlement = null;
      }),
    },
    {
      name: "terminal handoff cannot survive root completion",
      checkpoint: mutateCheckpoint(delayPlan, settled.snapshot, (snapshot) => {
        snapshot.status = "halted";
      }),
    },
  ];
  for (const corruption of corruptions) {
    const snapshot = (corruption.checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, delayPlan).valid, false, corruption.name);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)), corruption.name);
  }

  const buttonPlan = plan('showButton "Continue"');
  const buttonWaiting = run(buttonPlan, createFreshRuntimeSnapshot(buttonPlan));
  const button = buttonWaiting.snapshot.foregroundAction;
  assert.equal(button?.kind, "interaction");
  const buttonSettled = completeAction(buttonPlan, buttonWaiting.snapshot, {
    actionId: button!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });
  assert.equal(buttonSettled.snapshot.terminalContinuationHandoff?.actionKind, "interaction");
  assert.equal(validateRuntimeSnapshot(buttonSettled.snapshot, buttonPlan).valid, true);
  assert.deepEqual(run(buttonPlan, buttonSettled.snapshot).events.map((event) => event.kind), ["complete"]);
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
    releasedPreparedOutputInstruction: null,
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
  const compiled = plan('say "first"');
  const snapshot = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  const checkpoint = JSON.parse(serializeCheckpoint(createCheckpoint(compiled, snapshot)));
  assert.equal(compiled.version, 10);
  assert.equal(snapshot.version, 14);
  assert.equal(checkpoint.version, 17);
  assert.doesNotThrow(() => deserializeCheckpoint(JSON.stringify(checkpoint)));

  const oldSnapshot = structuredClone(snapshot) as any;
  oldSnapshot.version = 13;
  assert.equal(validateRuntimeSnapshot(oldSnapshot, compiled).valid, false);
  const oldCheckpoint = structuredClone(checkpoint);
  oldCheckpoint.version = 16;
  assert.throws(() => deserializeCheckpoint(JSON.stringify(oldCheckpoint)));
});

test("say pacing expression temporaries are required before checkpoint restore", () => {
  const compiled = plan([
    "function pace(value) { return value }",
    'say "first", 5',
    'say "second", pace(5)',
  ].join("\n"));
  const say = compiled.instructions.find(
    (instruction) =>
      instruction.kind === "say" &&
      typeof instruction.pacing === "object" &&
      instruction.pacing.kind === "temporary",
  );
  assert.notEqual(say, undefined);
  assert.equal(say?.kind, "say");
  if (say?.kind !== "say" || typeof say.pacing !== "object" || say.pacing.kind !== "temporary") {
    throw new Error("Expected a materialized say pacing expression.");
  }

  const pacingTemporary = say.pacing.temporaryId;
  let pending = createFreshRuntimeSnapshot(compiled);
  while (pending.nextInstruction !== compiled.instructions.indexOf(say)) {
    pending = executeInstruction(compiled, pending).snapshot;
  }
  assert.ok(pending.temporaries.some((temporary) => temporary.id === pacingTemporary));
  assert.equal(validateRuntimeSnapshot(pending, compiled).valid, true);

  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, pending)));
  const promoted = executeInstruction(restored.plan, restored.snapshot);
  assert.equal(promoted.snapshot.foregroundAction?.kind, "chatPacingGate");

  const missingPacingTemporary = structuredClone(pending) as any;
  missingPacingTemporary.temporaries = missingPacingTemporary.temporaries.filter(
    (temporary: { id: number }) => temporary.id !== pacingTemporary,
  );
  assert.equal(validateRuntimeSnapshot(missingPacingTemporary, compiled).valid, false);
  assert.throws(() => createCheckpoint(compiled, missingPacingTemporary));

  for (const temporaryId of [say.speakerTemporary, say.textTemporary]) {
    assert.equal(typeof temporaryId, "number");
    const missingPreparedTemporary = structuredClone(pending) as any;
    missingPreparedTemporary.temporaries = missingPreparedTemporary.temporaries.filter(
      (temporary: { id: number }) => temporary.id !== temporaryId,
    );
    assert.equal(validateRuntimeSnapshot(missingPreparedTemporary, compiled).valid, false);
  }
});

test("pacing creation provenance requires a positive historical scope depth", () => {
  const rootPlan = plan('say "root", 5\nexit');
  const root = executeInstruction(rootPlan, createFreshRuntimeSnapshot(rootPlan)).snapshot;
  assert.equal(root.backgroundActions[0]?.kind, "chatPacingGate");
  assert.equal(root.backgroundActions[0]?.scopeDepth, 1);
  assert.equal(validateRuntimeSnapshot(root, rootPlan).valid, true);
  assert.doesNotThrow(() => createCheckpoint(rootPlan, root));

  const zeroDepth = structuredClone(root) as any;
  zeroDepth.backgroundActions[0].scopeDepth = 0;
  assert.equal(validateRuntimeSnapshot(zeroDepth, rootPlan).valid, false);
  assert.throws(() => createCheckpoint(rootPlan, zeroDepth));

  const functionPlan = plan('function f { say "inside", 5 }\nf()');
  const unwound = run(functionPlan, createFreshRuntimeSnapshot(functionPlan)).snapshot;
  assert.equal(unwound.status, "halted");
  assert.equal(unwound.frames.length, 1);
  assert.equal(unwound.backgroundActions[0]?.kind, "chatPacingGate");
  assert.ok((unwound.backgroundActions[0]?.scopeDepth ?? 0) > unwound.frames.length);
  assert.equal(validateRuntimeSnapshot(unwound, functionPlan).valid, true);
  assert.doesNotThrow(() => createCheckpoint(functionPlan, unwound));
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
  const backgroundPlan = plan('say "first"');
  const background = run(backgroundPlan, createFreshRuntimeSnapshot(backgroundPlan));
  const foregroundPlan = plan('say "first"\nsay "second"');
  const foreground = run(foregroundPlan, createFreshRuntimeSnapshot(foregroundPlan));
  const foregroundGate = foreground.snapshot.foregroundAction;
  assert.equal(foregroundGate?.kind, "chatPacingGate");
  if (foregroundGate?.kind !== "chatPacingGate") throw new Error("Expected a promoted pacing gate.");
  const functionPlan = plan('function f { say "first" }\nf()');
  const functionBackground = run(functionPlan, createFreshRuntimeSnapshot(functionPlan));
  const settled = completeAction(backgroundPlan, background.snapshot, {
    actionId: 1,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const corruptions = [
    {
      name: "action identity",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].actionId = 0;
      }),
    },
    {
      name: "action kind",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].kind = "delay";
      }),
    },
    {
      name: "deadline",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].deadlineMs = 0;
      }),
    },
    {
      name: "request sequence",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].requestEventSequence = snapshot.nextEventSequence;
      }),
    },
    {
      name: "background uniqueness",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions.push(structuredClone(snapshot.backgroundActions[0]));
      }),
    },
    {
      name: "foreground/background location",
      plan: foregroundPlan,
      checkpoint: mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => {
        snapshot.backgroundActions.push(structuredClone(snapshot.foregroundAction));
      }),
    },
    {
      name: "background prepared output",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].preparedOutput = structuredClone(foregroundGate.preparedOutput);
      }),
    },
    {
      name: "foreground prepared output ownership",
      plan: foregroundPlan,
      checkpoint: mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => {
        snapshot.foregroundAction.preparedOutput = null;
      }),
    },
    {
      name: "waiting status ownership",
      plan: foregroundPlan,
      checkpoint: mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => {
        snapshot.status = "running";
      }),
    },
    {
      name: "prepared continuation",
      plan: foregroundPlan,
      checkpoint: mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => {
        snapshot.foregroundAction.preparedOutput.continuationInstruction += 1;
      }),
    },
    {
      name: "pacing settlement",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, settled.snapshot, (snapshot) => {
        snapshot.lastSettlement.actionKind = "delay";
      }),
    },
    {
      name: "settlement completed time",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, settled.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.currentSessionTimeMs + 1;
      }),
    },
    {
      name: "unwound function provenance",
      plan: functionPlan,
      checkpoint: mutateCheckpoint(functionPlan, functionBackground.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].ownerCallFrameId = snapshot.nextCallFrameId;
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = (corruption.checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, corruption.plan).valid, false, corruption.name);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)), corruption.name);
  }
});

test("background pacing actions require dense JSON-safe array entries", () => {
  const compiled = plan('say "first"');
  const background = run(compiled, createFreshRuntimeSnapshot(compiled));
  const baselineCheckpoint = JSON.parse(serializeCheckpoint(
    createCheckpoint(compiled, background.snapshot),
  )) as { snapshot: any };

  const sparseSnapshot = structuredClone(baselineCheckpoint.snapshot);
  sparseSnapshot.backgroundActions = new Array(1);
  assert.equal(validateRuntimeSnapshot(sparseSnapshot, compiled).valid, false);
  assert.throws(() => createCheckpoint(compiled, sparseSnapshot));

  const jsonSparseCheckpoint = structuredClone(baselineCheckpoint);
  jsonSparseCheckpoint.snapshot.backgroundActions = [null];
  assert.throws(() => deserializeCheckpoint(JSON.stringify(jsonSparseCheckpoint)));

  const foregroundPlan = plan('say "first"\nsay "second"');
  const foreground = run(foregroundPlan, createFreshRuntimeSnapshot(foregroundPlan));
  const foregroundCheckpoint = JSON.parse(serializeCheckpoint(
    createCheckpoint(foregroundPlan, foreground.snapshot),
  )) as { snapshot: any };

  const undefinedEntrySnapshot = structuredClone(baselineCheckpoint.snapshot);
  undefinedEntrySnapshot.backgroundActions = [undefined];

  const nullEntrySnapshot = structuredClone(baselineCheckpoint.snapshot);
  nullEntrySnapshot.backgroundActions = [null];

  const nonObjectEntrySnapshot = structuredClone(baselineCheckpoint.snapshot);
  nonObjectEntrySnapshot.backgroundActions = [42];

  const duplicateGateSnapshot = structuredClone(baselineCheckpoint.snapshot);
  duplicateGateSnapshot.backgroundActions.push(
    structuredClone(duplicateGateSnapshot.backgroundActions[0]),
  );

  const preparedOutputArraySnapshot = checkpointSnapshot(
    foregroundPlan,
    foreground.snapshot,
  );
  preparedOutputArraySnapshot.foregroundAction.preparedOutput = [];

  const skipped = completeAction(compiled, background.snapshot, {
    actionId: 1,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const skippedCheckpoint = JSON.parse(serializeCheckpoint(
    createCheckpoint(compiled, skipped.snapshot),
  )) as { snapshot: any };
  const obsoleteLineageSnapshot = checkpointSnapshot(compiled, skipped.snapshot);
  delete obsoleteLineageSnapshot.lastSettlement.releasedPreparedOutputInstruction;
  obsoleteLineageSnapshot.lastSettlement.releasedPreparedOutput = true;

  const corruptions = [
    {
      name: "undefined direct snapshot entry",
      compiled,
      snapshot: undefinedEntrySnapshot,
      checkpoint: checkpointWithSnapshot(baselineCheckpoint, undefinedEntrySnapshot),
    },
    {
      name: "null background entry",
      compiled,
      snapshot: nullEntrySnapshot,
      checkpoint: checkpointWithSnapshot(baselineCheckpoint, nullEntrySnapshot),
    },
    {
      name: "non-object background entry",
      compiled,
      snapshot: nonObjectEntrySnapshot,
      checkpoint: checkpointWithSnapshot(baselineCheckpoint, nonObjectEntrySnapshot),
    },
    {
      name: "second background pacing gate",
      compiled,
      snapshot: duplicateGateSnapshot,
      checkpoint: checkpointWithSnapshot(baselineCheckpoint, duplicateGateSnapshot),
    },
    {
      name: "array prepared output",
      compiled: foregroundPlan,
      snapshot: preparedOutputArraySnapshot,
      checkpoint: checkpointWithSnapshot(
        foregroundCheckpoint,
        preparedOutputArraySnapshot,
      ),
    },
    {
      name: "obsolete settlement lineage field",
      compiled,
      snapshot: obsoleteLineageSnapshot,
      checkpoint: checkpointWithSnapshot(
        skippedCheckpoint,
        obsoleteLineageSnapshot,
      ),
    },
  ];

  for (const corruption of corruptions) {
    assert.equal(
      validateRuntimeSnapshot(corruption.snapshot, corruption.compiled).valid,
      false,
      corruption.name,
    );
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)),
      corruption.name,
    );
  }
});

test("#112 persisted arrays reject custom own keys that JSON would omit", () => {
  const backgroundPlan = plan('say "first"');
  const background = run(
    backgroundPlan,
    createFreshRuntimeSnapshot(backgroundPlan),
  );
  const speakerPlan = plan('speaker vera { custom: "kept" }\nexit');
  const speakerState = run(
    speakerPlan,
    createFreshRuntimeSnapshot(speakerPlan),
  );

  const backgroundExtra = structuredClone(background.snapshot) as any;
  backgroundExtra.backgroundActions.extra = "lost";

  const speakersExtra = structuredClone(speakerState.snapshot) as any;
  speakersExtra.speakers.extra = "lost";

  const propertiesExtra = structuredClone(speakerState.snapshot) as any;
  propertiesExtra.speakers[0].properties.extra = "lost";

  const corruptions = [
    {
      name: "backgroundActions custom key",
      compiled: backgroundPlan,
      snapshot: backgroundExtra,
    },
    {
      name: "speakers custom key",
      compiled: speakerPlan,
      snapshot: speakersExtra,
    },
    {
      name: "speaker properties custom key",
      compiled: speakerPlan,
      snapshot: propertiesExtra,
    },
  ];

  for (const corruption of corruptions) {
    assert.equal(
      validateRuntimeSnapshot(corruption.snapshot, corruption.compiled).valid,
      false,
      corruption.name,
    );
    assert.throws(
      () => createCheckpoint(corruption.compiled, corruption.snapshot),
      corruption.name,
    );
  }
});

test("ready snapshots reject pacing progress", () => {
  const compiled = plan('say "first", 5\nexit');
  const afterSay = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled));
  const forged = structuredClone(afterSay.snapshot);
  forged.status = "ready";
  forged.nextInstruction = 0;
  assert.equal(validateRuntimeSnapshot(forged, compiled).valid, false);
  assert.throws(() => createCheckpoint(compiled, forged));
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
    expectCheckpointJsonRoundTrip(
      label,
      compiled,
      snapshot as ReturnType<typeof createFreshRuntimeSnapshot>,
    );
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
        snapshot.lastSettlement.releasedPreparedOutputInstruction = null;
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

  const corruptions = [
    {
      name: "foreground gate moved to background",
      plan: promotedPlan,
      checkpoint: mutateCheckpoint(promotedPlan, promoted.snapshot, (snapshot) => {
        snapshot.backgroundActions.push(snapshot.foregroundAction);
        snapshot.foregroundAction = null;
      }),
    },
    {
      name: "prepared output moved to top level while foreground remains",
      plan: promotedPlan,
      checkpoint: mutateCheckpoint(promotedPlan, promoted.snapshot, (snapshot) => {
        snapshot.preparedSayOutput = snapshot.foregroundAction.preparedOutput;
      }),
    },
    {
      name: "pacing deadline before current time",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].deadlineMs = snapshot.currentSessionTimeMs;
      }),
    },
    {
      name: "next action ID reuses active identity",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.nextActionId = snapshot.foregroundAction.actionId;
      }),
    },
    {
      name: "next event sequence reuses request identity",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.nextEventSequence = snapshot.foregroundAction.requestEventSequence;
      }),
    },
    {
      name: "prepared continuation is not say",
      plan: promotedPlan,
      checkpoint: mutateCheckpoint(promotedPlan, promoted.snapshot, (snapshot) => {
        snapshot.foregroundAction.preparedOutput.owningInstruction = 2;
        snapshot.foregroundAction.preparedOutput.continuationInstruction = 3;
        snapshot.nextInstruction = 2;
      }),
    },
    {
      name: "background gate carries prepared output",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].preparedOutput = structuredClone(promotedGate?.preparedOutput);
      }),
    },
    {
      name: "multiple background gates",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.backgroundActions.push(structuredClone(snapshot.backgroundActions[0]));
      }),
    },
    {
      name: "extra pacing setting",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.chatPacingSettings.extra = 1;
      }),
    },
    {
      name: "missing pacing setting",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        delete snapshot.chatPacingSettings.baseDelayMs;
      }),
    },
    {
      name: "duplicate speaker pacing property",
      plan: speakerPlan,
      checkpoint: mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
        snapshot.speakers[0].properties.push(structuredClone(snapshot.speakers[0].properties[0]));
      }),
    },
    {
      name: "active request collides with interaction transcript",
      plan: interactionPlan,
      checkpoint: mutateCheckpoint(interactionPlan, laterWait.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence = snapshot.lastSettlement.transcriptEventSequence;
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = (corruption.checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, corruption.plan).valid, false, corruption.name);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)), corruption.name);
  }
});

test("active pacing locations allow only runtime-produced foreground and background compositions", () => {
  const waitPlan = plan('say "first"\nwait 10 s\nexit');
  const waitState = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const backgroundPacing = waitState.snapshot.backgroundActions[0];
  const foregroundDelay = waitState.snapshot.foregroundAction;
  assert.equal(backgroundPacing?.kind, "chatPacingGate");
  assert.equal(foregroundDelay?.kind, "delay");
  assert.equal(validateRuntimeSnapshot(waitState.snapshot, waitPlan).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(serializeCheckpoint(
    createCheckpoint(waitPlan, waitState.snapshot),
  )));

  const promotionPlan = plan('say "first"\nsay "second"');
  const promoted = run(promotionPlan, createFreshRuntimeSnapshot(promotionPlan));
  const foregroundPacing = promoted.snapshot.foregroundAction;
  assert.equal(foregroundPacing?.kind, "chatPacingGate");

  const interactionPlan = plan('say "first"\nshowButton "Continue"');
  const afterFirst = executeInstruction(
    interactionPlan,
    createFreshRuntimeSnapshot(interactionPlan),
  );
  assert.equal(afterFirst.snapshot.backgroundActions[0]?.kind, "chatPacingGate");
  assert.equal(validateRuntimeSnapshot(afterFirst.snapshot, interactionPlan).valid, true);

  const interactionState = run(interactionPlan, afterFirst.snapshot);
  assert.equal(interactionState.snapshot.foregroundAction?.kind, "interaction");
  assert.equal(interactionState.snapshot.backgroundActions.length, 0);
  assert.equal(
    interactionState.snapshot.lastSettlement?.settlementKind,
    "consumedByForegroundInteraction",
  );
  assert.equal(validateRuntimeSnapshot(interactionState.snapshot, interactionPlan).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(serializeCheckpoint(
    createCheckpoint(interactionPlan, interactionState.snapshot),
  )));

  const corruptions = [
    {
      name: "foreground and background cannot retain two pacing gates",
      compiled: promotionPlan,
      checkpoint: mutateCheckpoint(promotionPlan, promoted.snapshot, (snapshot) => {
        const duplicate = structuredClone(snapshot.foregroundAction);
        duplicate.actionId = snapshot.nextActionId;
        duplicate.requestEventSequence = snapshot.nextEventSequence;
        duplicate.preparedOutput = null;
        snapshot.nextActionId += 1;
        snapshot.nextEventSequence += 1;
        snapshot.backgroundActions.push(duplicate);
      }),
    },
    {
      name: "foreground interaction cannot retain a background pacing gate",
      compiled: interactionPlan,
      checkpoint: mutateCheckpoint(interactionPlan, interactionState.snapshot, (snapshot) => {
        const replacement = structuredClone(
          afterFirst.snapshot.backgroundActions[0],
        ) as any;
        replacement.actionId = snapshot.nextActionId;
        replacement.requestEventSequence = snapshot.nextEventSequence;
        snapshot.nextActionId += 1;
        snapshot.nextEventSequence += 1;
        snapshot.backgroundActions.push(replacement);
      }),
    },
    {
      name: "background pacing must predate the foreground delay action ID",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waitState.snapshot, (snapshot) => {
        const pacingActionId = snapshot.backgroundActions[0].actionId;
        snapshot.backgroundActions[0].actionId = snapshot.foregroundAction.actionId;
        snapshot.foregroundAction.actionId = pacingActionId;
      }),
    },
    {
      name: "background pacing must predate the foreground delay request sequence",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waitState.snapshot, (snapshot) => {
        const pacingRequestSequence = snapshot.backgroundActions[0].requestEventSequence;
        snapshot.backgroundActions[0].requestEventSequence =
          snapshot.foregroundAction.requestEventSequence;
        snapshot.foregroundAction.requestEventSequence = pacingRequestSequence;
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = (corruption.checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, corruption.compiled).valid, false, corruption.name);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)), corruption.name);
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
      releasedPreparedOutputInstruction: null,
      hasPreparedOutput: false,
    },
    {
      name: "background typed skip",
      compiled: backgroundPlan,
      snapshot: backgroundSkipped.snapshot,
      kind: "skipped",
      releasedPreparedOutputInstruction: null,
      hasPreparedOutput: false,
    },
    {
      name: "interaction consumes background pacing",
      compiled: interactionPlan,
      snapshot: interaction.snapshot,
      kind: "consumedByForegroundInteraction",
      releasedPreparedOutputInstruction: null,
      hasPreparedOutput: false,
    },
    {
      name: "instant output supersedes background pacing",
      compiled: instantPlan,
      snapshot: superseded.snapshot,
      kind: "supersededByInstantOutput",
      releasedPreparedOutputInstruction: null,
      hasPreparedOutput: false,
    },
    {
      name: "foreground time completion releases prepared output",
      compiled: promotionPlan,
      snapshot: foregroundCompleted.snapshot,
      kind: "completed",
      releasedPreparedOutputInstruction: 1,
      hasPreparedOutput: true,
    },
    {
      name: "foreground typed skip releases prepared output",
      compiled: promotionPlan,
      snapshot: foregroundSkipped.snapshot,
      kind: "skipped",
      releasedPreparedOutputInstruction: 1,
      hasPreparedOutput: true,
    },
  ] as const;

  for (const scenario of cases) {
    const settlement = scenario.snapshot.lastSettlement;
    assert.equal(settlement?.actionKind, "chatPacingGate", scenario.name);
    if (settlement?.actionKind !== "chatPacingGate") throw new Error(scenario.name);
    assert.equal(settlement?.settlementKind, scenario.kind, scenario.name);
    assert.equal(
      settlement?.releasedPreparedOutputInstruction,
      scenario.releasedPreparedOutputInstruction,
      scenario.name,
    );
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
        snapshot.lastSettlement.releasedPreparedOutputInstruction = null;
      }),
    },
    {
      name: "background skip cannot falsely claim prepared-output release",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 1;
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
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 1;
      }),
    },
    {
      name: "supersession cannot claim prepared-output release",
      compiled: instantPlan,
      checkpoint: mutateCheckpoint(instantPlan, superseded.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 1;
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
        snapshot.lastSettlement.releasedPreparedOutputInstruction = "1";
      }),
    },
    {
      name: "pacing settlement requires the release evidence key",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        delete snapshot.lastSettlement.releasedPreparedOutputInstruction;
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
  assert.equal(backgroundSkip.snapshot.lastSettlement.releasedPreparedOutputInstruction, null);
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
  assert.equal(released.snapshot.lastSettlement.releasedPreparedOutputInstruction, 1);
  assert.notEqual(released.snapshot.preparedSayOutput, null);

  const restoredRelease = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, released.snapshot)));
  const resumed = executeInstruction(restoredRelease.plan, restoredRelease.snapshot);
  assert.equal(resumed.events.filter((event) => event.kind === "say").length, 1);
  assert.equal(resumed.snapshot.backgroundActions[0]?.actionId, 2);
  assert.equal(resumed.snapshot.rng.state, secondAsFreshOutput.snapshot.rng.state);
});

test("pacing settlements retain exact prepared-output lineage through release and consumption", () => {
  const threeSays = plan('say "first"\nsay "second"\nsay "third"');
  const promoted = run(threeSays, createFreshRuntimeSnapshot(threeSays));
  const firstGate = promoted.snapshot.foregroundAction;
  assert.equal(firstGate?.kind, "chatPacingGate");

  const released = completeAction(threeSays, promoted.snapshot, {
    actionId: firstGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(
    released.snapshot.lastSettlement?.actionKind === "chatPacingGate" &&
      released.snapshot.lastSettlement.releasedPreparedOutputInstruction,
    1,
  );
  assert.equal(released.snapshot.preparedSayOutput?.owningInstruction, 1);
  assert.equal(validateRuntimeSnapshot(released.snapshot, threeSays).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(serializeCheckpoint(createCheckpoint(threeSays, released.snapshot))));

  const forgedThird = checkpointSnapshot(threeSays, released.snapshot);
  forgedThird.preparedSayOutput.owningInstruction = 2;
  forgedThird.preparedSayOutput.continuationInstruction = 3;
  forgedThird.preparedSayOutput.text = "forged third";
  forgedThird.nextInstruction = 2;
  expectInvalidSnapshot("settlement lineage must match the released prepared say", threeSays, forgedThird);

  const consumed = executeInstruction(threeSays, released.snapshot);
  const replacement = consumed.snapshot.backgroundActions[0];
  assert.equal(replacement?.kind, "chatPacingGate");
  assert.equal(replacement?.owningInstruction, 1);
  assert.equal(replacement?.actionId, 2);
  assert.equal(validateRuntimeSnapshot(consumed.snapshot, threeSays).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(serializeCheckpoint(createCheckpoint(threeSays, consumed.snapshot))));

  const promotedReplacement = run(threeSays, consumed.snapshot);
  assert.equal(promotedReplacement.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(promotedReplacement.snapshot.foregroundAction?.actionId, replacement?.actionId);
  assert.equal(validateRuntimeSnapshot(promotedReplacement.snapshot, threeSays).valid, true);

  const waitPlan = plan('say "first"\nsay "second"\nwait 10 s\nexit');
  const waitPromoted = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const waitGate = waitPromoted.snapshot.foregroundAction;
  assert.equal(waitGate?.kind, "chatPacingGate");
  const waitReleased = completeAction(waitPlan, waitPromoted.snapshot, {
    actionId: waitGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const replacementWithWait = run(waitPlan, waitReleased.snapshot);
  assert.equal(replacementWithWait.snapshot.backgroundActions[0]?.owningInstruction, 1);
  assert.equal(replacementWithWait.snapshot.foregroundAction?.kind, "delay");
  assert.equal(validateRuntimeSnapshot(replacementWithWait.snapshot, waitPlan).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(serializeCheckpoint(createCheckpoint(waitPlan, replacementWithWait.snapshot))));

  const corruptions = [
    {
      name: "top-level prepared output requires a matching lineage instruction",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, released.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 2;
      }),
    },
    {
      name: "released lineage cannot remain without prepared output or replacement gate",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, released.snapshot, (snapshot) => {
        snapshot.preparedSayOutput = null;
      }),
    },
    {
      name: "replacement gate must belong to the released prepared say",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, consumed.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].owningInstruction = 0;
        snapshot.backgroundActions[0].continuationInstruction = 1;
      }),
    },
    {
      name: "replacement gate must be newer than its releasing settlement",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, consumed.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].actionId = snapshot.lastSettlement.actionId;
      }),
    },
    {
      name: "replacement request must follow the releasing completion",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, consumed.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].requestEventSequence =
          snapshot.lastSettlement.completionEventSequence;
      }),
    },
    {
      name: "lineage must be null for background completion",
      compiled: plan('say "first"'),
      checkpoint: (() => {
        const backgroundPlan = plan('say "first"');
        const background = run(backgroundPlan, createFreshRuntimeSnapshot(backgroundPlan));
        const gate = background.snapshot.backgroundActions[0];
        if (gate?.kind !== "chatPacingGate") throw new Error("Expected a background pacing gate.");
        const settled = observeTime(backgroundPlan, background.snapshot, gate!.deadlineMs);
        return mutateCheckpoint(backgroundPlan, settled.snapshot, (snapshot) => {
          snapshot.lastSettlement.releasedPreparedOutputInstruction = 0;
        });
      })(),
    },
    {
      name: "obsolete boolean release evidence is rejected",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, released.snapshot, (snapshot) => {
        delete snapshot.lastSettlement.releasedPreparedOutputInstruction;
        snapshot.lastSettlement.releasedPreparedOutput = true;
      }),
    },
    {
      name: "lineage instruction must be a say in the current plan",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, released.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 3;
      }),
    },
    {
      name: "lineage instruction must be non-negative",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, released.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = -1;
      }),
    },
    {
      name: "lineage instruction cannot name a non-say instruction",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waitReleased.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 2;
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = (corruption.checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, corruption.compiled).valid, false, corruption.name);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)), corruption.name);
  }
});
