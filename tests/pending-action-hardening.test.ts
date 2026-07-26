import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { completeAction, executeInstruction, observeTime, run, stepToEvent } from "../src/runtime/engine.js";
import {
  MAX_RUNTIME_SESSION_TIME_MS,
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";

function plan(source: string) {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  return compiled.plan!;
}

function waiting(source = "wait 10 ms\nexit") {
  const compiled = plan(source);
  const snapshot = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  assert.equal(snapshot.status, "waiting");
  return { compiled, snapshot };
}

function mutable(snapshot: RuntimeSnapshot): any {
  return JSON.parse(JSON.stringify(snapshot)) as RuntimeSnapshot;
}

test("#78 rejects due foreground delays through direct and checkpoint boundaries", () => {
  const { compiled, snapshot } = waiting();
  for (const currentSessionTimeMs of [9, 10, 11]) {
    const candidate = mutable(snapshot);
    candidate.currentSessionTimeMs = currentSessionTimeMs;
    assert.equal(validateRuntimeSnapshot(candidate, compiled).valid, currentSessionTimeMs === 9);
  }

  const due = mutable(snapshot);
  due.currentSessionTimeMs = due.foregroundAction!.deadlineMs;
  const checkpoint = { ...createCheckpoint(compiled, snapshot), snapshot: due };
  assert.throws(() => restoreCheckpoint(checkpoint), checkpointError);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), checkpointError);
  assert.throws(() => serializeCheckpoint(checkpoint), checkpointError);
  const jsonRoundTrip = JSON.parse(JSON.stringify(checkpoint)) as unknown;
  assert.throws(() => restoreCheckpoint(jsonRoundTrip), checkpointError);
});

test("terminal root waits validate, round-trip, settle, and resume at the root completion boundary", () => {
  const compiled = plan("wait 1 ms");
  const uninterruptedWaiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(uninterruptedWaiting.snapshot.status, "waiting");
  assert.equal(
    uninterruptedWaiting.snapshot.foregroundAction!.continuationInstruction,
    compiled.rootEndInstruction,
  );
  assert.equal(validateRuntimeSnapshot(uninterruptedWaiting.snapshot, compiled).valid, true);

  const checkpointJson = serializeCheckpoint(createCheckpoint(compiled, uninterruptedWaiting.snapshot));
  const restored = deserializeCheckpoint(checkpointJson);
  assert.equal(restored.snapshot.status, "waiting");
  assert.deepEqual(restored.snapshot, uninterruptedWaiting.snapshot);

  const uninterruptedSettled = observeTime(compiled, uninterruptedWaiting.snapshot, 1);
  const uninterruptedFinal = run(compiled, uninterruptedSettled.snapshot);
  const restoredSettled = observeTime(restored.plan, restored.snapshot, 1);
  const restoredFinal = run(restored.plan, restoredSettled.snapshot);
  assert.equal(uninterruptedFinal.snapshot.status, "halted");
  assert.equal(restoredFinal.snapshot.status, "halted");
  assert.deepEqual(
    [...uninterruptedWaiting.events, ...uninterruptedSettled.events, ...uninterruptedFinal.events],
    [...uninterruptedWaiting.events, ...restoredSettled.events, ...restoredFinal.events],
  );
  assert.deepEqual(restoredFinal.snapshot, uninterruptedFinal.snapshot);
  assert.deepEqual(uninterruptedFinal.events.map((event) => event.kind), ["complete"]);
  assert.equal(validateRuntimeSnapshot(uninterruptedFinal.snapshot, compiled).valid, true);
});

test("rejects every forged running root-end shape outside the settled terminal delay transition", () => {
  const compiled = plan("wait 1 ms\nwait 1 ms");
  const first = run(compiled, createFreshRuntimeSnapshot(compiled));
  const second = run(compiled, observeTime(compiled, first.snapshot, 1).snapshot);
  const settled = observeTime(compiled, second.snapshot, 2).snapshot;
  assert.equal(settled.status, "running");
  assert.equal(settled.nextInstruction, compiled.rootEndInstruction);
  assert.equal(validateRuntimeSnapshot(settled, compiled).valid, true);

  const invalid: Readonly<Record<string, (snapshot: any) => void>> = {
    extraRootScope: (snapshot) => {
      snapshot.frames.push({ id: snapshot.nextScopeId, bindings: [] });
      snapshot.nextScopeId += 1;
    },
    retainedTemporary: (snapshot) => { snapshot.temporaries.push({ id: 999, value: 1 }); },
    retainedLoopFrame: (snapshot) => { snapshot.loopFrames.push({ kind: "while", loopId: 999, scopeDepth: 1, callFrameId: null }); },
    retainedCallFrame: (snapshot) => { snapshot.callFrames.push({}); },
    foregroundAction: (snapshot) => { snapshot.foregroundAction = structuredClone(second.snapshot.foregroundAction); },
    backgroundAction: (snapshot) => { snapshot.backgroundActions.push({}); },
    missingSettlement: (snapshot) => { snapshot.lastSettlement = null; },
    incompatibleSettlement: (snapshot) => { snapshot.lastSettlement.actionId = 1; },
  };
  for (const [name, mutate] of Object.entries(invalid)) {
    const candidate = mutable(settled);
    mutate(candidate);
    const validation = validateRuntimeSnapshot(candidate, compiled);
    assert.equal(validation.valid, false, name);
    assert.throws(() => restoreCheckpoint({ ...createCheckpoint(compiled, settled), snapshot: candidate }), checkpointError, name);
  }

  const arbitrary = mutable(createFreshRuntimeSnapshot(compiled));
  arbitrary.status = "running";
  arbitrary.nextInstruction = compiled.rootEndInstruction;
  assert.equal(validateRuntimeSnapshot(arbitrary, compiled).valid, false);
});

test("terminal delay completion is canonical across execute, event stepping, run, and repeated halted entries", () => {
  const compiled = plan('function hidden { say "hidden" }\nwait 1 ms');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const settled = observeTime(compiled, waiting.snapshot, 1);
  assert.deepEqual([...waiting.events, ...settled.events].map((event) => event.sequence), [1, 2]);

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const completed = operation(compiled, settled.snapshot);
    assert.equal(completed.snapshot.status, "halted");
    assert.equal(validateRuntimeSnapshot(completed.snapshot, compiled).valid, true);
    assert.deepEqual(completed.events.map((event) => event.kind), ["complete"]);
    assert.deepEqual(completed.events.map((event) => event.sequence), [3]);
    assert.deepEqual(operation(compiled, completed.snapshot).events, []);
  }
});

test("zero waits remain immediate while terminal waits use ordinary natural completion", () => {
  const terminalZero = plan("wait 0");
  const zeroResult = run(terminalZero, createFreshRuntimeSnapshot(terminalZero));
  assert.equal(zeroResult.snapshot.status, "halted");
  assert.equal(zeroResult.snapshot.nextActionId, 1);
  assert.equal(zeroResult.snapshot.foregroundAction, null);
  assert.equal(zeroResult.snapshot.lastSettlement, null);
  assert.deepEqual(zeroResult.events.map((event) => event.kind), ["complete"]);

  const visible = plan('wait 0\nsay "visible"');
  const visibleResult = run(visible, createFreshRuntimeSnapshot(visible));
  assert.equal(visibleResult.snapshot.nextActionId, 1);
  assert.equal(visibleResult.snapshot.foregroundAction, null);
  assert.equal(visibleResult.snapshot.lastSettlement, null);
  assert.deepEqual(visibleResult.events.map((event) => event.kind), ["say", "complete"]);

  const ordinary = plan('say "ordinary"');
  assert.deepEqual(
    run(ordinary, createFreshRuntimeSnapshot(ordinary)).events.map((event) => event.kind),
    ["say", "complete"],
  );
});

test("#79 validates every settlement relationship and preserves valid replay", () => {
  const compiled = plan("wait 1 ms\nwait 10 ms\nexit");
  const firstWaiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  const firstSettled = observeTime(compiled, firstWaiting, 1).snapshot;
  const active = run(compiled, firstSettled).snapshot;
  assert.equal(active.status, "waiting");
  assert.notEqual(active.lastSettlement, null);

  const invalid: Readonly<Record<string, (snapshot: any) => void>> = {
    unissuedActionId: (snapshot) => { snapshot.lastSettlement!.actionId = snapshot.nextActionId; },
    activeActionId: (snapshot) => { snapshot.lastSettlement!.actionId = snapshot.foregroundAction!.actionId; },
    unorderedSequences: (snapshot) => { snapshot.lastSettlement!.requestEventSequence = snapshot.lastSettlement!.completionEventSequence; },
    completionAtNextSequence: (snapshot) => { snapshot.lastSettlement!.completionEventSequence = snapshot.nextEventSequence; },
    beforeDeadline: (snapshot) => { snapshot.lastSettlement!.completedAtMs = snapshot.lastSettlement!.deadlineMs - 0.5; },
    afterCurrentTime: (snapshot) => { snapshot.lastSettlement!.completedAtMs = snapshot.currentSessionTimeMs + 0.5; },
  };
  for (const [name, mutate] of Object.entries(invalid)) {
    const candidate = mutable(active);
    mutate(candidate);
    assert.equal(validateRuntimeSnapshot(candidate, compiled).valid, false, name);
    const checkpoint = { ...createCheckpoint(compiled, active), snapshot: candidate };
    assert.throws(() => restoreCheckpoint(checkpoint), checkpointError, name);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), checkpointError, name);
  }

  const replay = completeAction(compiled, active, {
    actionId: active.lastSettlement!.actionId,
    actionKind: "delay",
    payload: { kind: "time", currentSessionTimeMs: active.currentSessionTimeMs },
  });
  assert.equal(replay.outcome.kind, "alreadySettled");
});

test("#81 keeps representable fractional waits and rejects precision-losing deadlines before an action request", () => {
  const conversions: ReadonlyArray<readonly [string, number]> = [
    ["wait 0.5", 500],
    ["wait 0.5 ms", 0.5],
    ["wait 0.0005 s", 0.5],
    ["wait 0.000008333333333333334 min", 0.5],
    ["wait 0.0000001388888888888889 h", 0.0000001388888888888889 * 3_600_000],
  ];
  for (const [source, expected] of conversions) {
    const compiled = plan(`${source}\nexit`);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled));
    assert.equal(result.snapshot.foregroundAction!.deadlineMs, expected, source);
    assert.ok(result.snapshot.foregroundAction!.deadlineMs > result.snapshot.foregroundAction!.createdAtMs, source);
  }

  for (const source of [
    "wait 0.5 ms",
    "wait 0.0005 s",
    "wait 0.000008333333333333334 min",
    "wait 0.0000001 h",
  ]) {
    const compiled = plan(`${source}\nexit`);
    const start = MAX_RUNTIME_SESSION_TIME_MS - 3;
    const result = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled, { initialSessionTimeMs: start }));
    assert.equal(result.snapshot.foregroundAction, null, source);
    assert.equal(result.snapshot.nextActionId, 1, source);
    assert.ok(!result.events.some((event) => event.kind === "actionRequested"), source);
  }

  const sequential = plan("wait 0.1 ms\nwait 0.2 ms\nexit");
  const first = run(sequential, createFreshRuntimeSnapshot(sequential));
  assert.equal(first.snapshot.foregroundAction!.deadlineMs, 0.1);
  const afterFirst = observeTime(sequential, first.snapshot, 0.1);
  const second = run(sequential, afterFirst.snapshot);
  assert.equal(second.snapshot.status, "waiting");
  assert.equal(second.snapshot.foregroundAction!.createdAtMs, 0.1);
  assert.ok(second.snapshot.foregroundAction!.deadlineMs > 0.1);

  const largestFractional = plan("wait 0.5 ms\nexit");
  const start = 2 ** 52 - 0.5;
  const pending = run(largestFractional, createFreshRuntimeSnapshot(largestFractional, { initialSessionTimeMs: start }));
  assert.equal(pending.snapshot.foregroundAction!.deadlineMs, 2 ** 52);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(largestFractional, pending.snapshot)));
  assert.equal(observeTime(restored.plan, restored.snapshot, 2 ** 52).snapshot.status, "running");
});

test("#82 uses the wait keyword path and rejects forged ownership, missing wait temporaries, and hostile completion fields", () => {
  assert.equal(compileSource("wait(1)").plan, null);
  assert.equal(compileSource("wait 1 - 2").plan, null);
  assert.equal(compileSource("wait (1 + 2)").diagnostics.length, 0);

  const functionWait = waiting("function pause { wait 1 ms }\npause()\nexit");
  const forgedOwner = mutable(functionWait.snapshot);
  forgedOwner.foregroundAction!.ownerCallFrameId = null;
  assert.equal(validateRuntimeSnapshot(forgedOwner, functionWait.compiled).valid, false);
  const forgedContinuation = mutable(functionWait.snapshot);
  forgedContinuation.nextInstruction = forgedContinuation.foregroundAction!.continuationInstruction;
  assert.equal(validateRuntimeSnapshot(forgedContinuation, functionWait.compiled).valid, false);

  const scopedWait = waiting("if true {\n  wait 1 ms\n}\nexit");
  const forgedScope = mutable(scopedWait.snapshot);
  forgedScope.foregroundAction!.scopeDepth = 1;
  assert.equal(validateRuntimeSnapshot(forgedScope, scopedWait.compiled).valid, false);
  const loopWait = waiting("repeat 1 {\n  wait 1 ms\n}\nexit");
  const forgedLoop = mutable(loopWait.snapshot);
  forgedLoop.foregroundAction!.loopDepth = 0;
  assert.equal(validateRuntimeSnapshot(forgedLoop, loopWait.compiled).valid, false);

  const temporaryWait = waiting("function one { return 1 }\nwait one() ms\nexit");
  const missingTemporary = mutable(temporaryWait.snapshot);
  missingTemporary.temporaries.length = 0;
  assert.equal(validateRuntimeSnapshot(missingTemporary, temporaryWait.compiled).valid, false);

  const hostileKind = Object.create(null) as Record<string, unknown>;
  assert.doesNotThrow(() => completeAction(temporaryWait.compiled, temporaryWait.snapshot, {
    actionId: temporaryWait.snapshot.foregroundAction!.actionId,
    actionKind: hostileKind,
    payload: { kind: "time", currentSessionTimeMs: 1 },
  }));
  const completion = completeAction(temporaryWait.compiled, temporaryWait.snapshot, {
    actionId: temporaryWait.snapshot.foregroundAction!.actionId,
    actionKind: hostileKind,
    payload: { kind: "time", currentSessionTimeMs: 1 },
  });
  assert.equal(completion.outcome.kind, "wrongActionKind");
});

test("#82 allocates the final safe action identity and then fails without reuse", () => {
  const compiled = plan("wait 1 ms\nwait 1 ms\nexit");
  const initial = createFreshRuntimeSnapshot(compiled);
  initial.nextActionId = Number.MAX_SAFE_INTEGER - 1;
  const first = run(compiled, initial);
  assert.equal(first.snapshot.foregroundAction!.actionId, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(first.snapshot.nextActionId, Number.MAX_SAFE_INTEGER);
  const settled = observeTime(compiled, first.snapshot, 1).snapshot;
  const second = executeInstruction(compiled, settled);
  assert.equal(second.snapshot.foregroundAction, null);
  assert.equal(second.snapshot.nextActionId, Number.MAX_SAFE_INTEGER);
  assert.ok(!second.events.some((event) => event.kind === "actionRequested"));
});

function checkpointError(error: unknown): boolean {
  return error instanceof CheckpointError && error.info.code === "TSK002";
}
