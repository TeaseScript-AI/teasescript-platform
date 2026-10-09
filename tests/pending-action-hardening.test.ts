import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { DiagnosticSeverity } from "../src/diagnostics.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run, RuntimeDataError, stepToEvent } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeDelayActionSnapshot } from "../src/runtime/actions/model.js";
import {
  MAX_RUNTIME_SESSION_TIME_MS,
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

function delayAction(snapshot: RuntimeSnapshot): RuntimeDelayActionSnapshot {
  assert.ok(snapshot.foregroundAction?.kind === "delay");
  return snapshot.foregroundAction;
}

function waiting(source = "wait 10 ms\nexit") {
  const compiled = plan(source);
  const snapshot = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  assert.equal(snapshot.status, "waiting");
  return { compiled, snapshot };
}

function mutable(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  // EVIDENCE: fixture: JSON round-trip preserves the RuntimeSnapshot shape before individual invalid mutations.
  return JSON.parse(JSON.stringify(snapshot)) as RuntimeSnapshot;
}

test("due foreground delays are rejected through direct and checkpoint boundaries", () => {
  const { compiled, snapshot } = waiting();
  for (const currentSessionTimeMs of [9, 10, 11]) {
    const candidate = mutable(snapshot);
    candidate.currentSessionTimeMs = currentSessionTimeMs;
    candidate.observedSessionTimeMs = currentSessionTimeMs;
    assert.equal(validateRuntimeSnapshot(candidate, compiled).valid, currentSessionTimeMs === 9);
  }

  const due = mutable(snapshot);
  due.currentSessionTimeMs = delayAction(due).deadlineMs;
  due.observedSessionTimeMs = due.currentSessionTimeMs;
  const checkpoint = { ...createCheckpoint(compiled, snapshot), snapshot: due };
  assert.throws(() => restoreCheckpoint(checkpoint), checkpointError);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), checkpointError);
  assert.throws(() => serializeCheckpoint(checkpoint), checkpointError);
  const jsonRoundTrip: unknown = JSON.parse(JSON.stringify(checkpoint));
  assert.throws(() => restoreCheckpoint(jsonRoundTrip), checkpointError);
});

test("a final root wait validates, round-trips, settles, and resumes into exit", () => {
  const compiled = plan("wait 1 ms\nexit");
  const uninterruptedWaiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(uninterruptedWaiting.snapshot.status, "waiting");
  assert.equal(validateRuntimeSnapshot(uninterruptedWaiting.snapshot, compiled).valid, true);

  const checkpointJson = serializeCheckpoint(
    createCheckpoint(compiled, uninterruptedWaiting.snapshot),
  );
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
  assert.deepEqual(
    uninterruptedFinal.events.map((event) => event.kind),
    ["exit"],
  );
  assert.equal(validateRuntimeSnapshot(uninterruptedFinal.snapshot, compiled).valid, true);
});

test("a settled final wait runs on at exit, and forged state there or past the root is rejected", () => {
  const compiled = plan("wait 1 ms\nwait 1 ms\nexit");
  const first = run(compiled, createFreshRuntimeSnapshot(compiled));
  const second = run(compiled, observeTime(compiled, first.snapshot, 1).snapshot);
  const settled = observeTime(compiled, second.snapshot, 2).snapshot;
  assert.equal(settled.status, "running");
  assert.equal(compiled.instructions[settled.nextInstruction]?.kind, "exit");
  assert.equal(validateRuntimeSnapshot(settled, compiled).valid, true);

  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture table: callbacks deliberately violate distinct pending-delay snapshot invariants before validation.
  const invalid: Readonly<Record<string, (snapshot: any) => void>> = {
    retainedTemporary: (snapshot) => {
      snapshot.temporaries.push({ id: 999, value: 1 });
    },
    retainedLoopFrame: (snapshot) => {
      snapshot.loopFrames.push({ kind: "while", loopId: 999, scopeDepth: 1, callFrameId: null });
    },
    retainedCallFrame: (snapshot) => {
      snapshot.callFrames.push({});
    },
    foregroundAction: (snapshot) => {
      snapshot.foregroundAction = structuredClone(second.snapshot.foregroundAction);
    },
    backgroundAction: (snapshot) => {
      snapshot.backgroundActions.push({});
    },
    pastRoot: (snapshot) => {
      snapshot.nextInstruction = compiled.files[0]!.rootEndInstruction;
    },
  };
  for (const [name, mutate] of Object.entries(invalid)) {
    const candidate = mutable(settled);
    mutate(candidate);
    const validation = validateRuntimeSnapshot(candidate, compiled);
    assert.equal(validation.valid, false, name);
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(compiled, settled), snapshot: candidate }),
      checkpointError,
      name,
    );
  }

  const arbitrary = mutable(createFreshRuntimeSnapshot(compiled));
  arbitrary.status = "running";
  arbitrary.nextInstruction = compiled.files[0]!.rootEndInstruction;
  assert.equal(validateRuntimeSnapshot(arbitrary, compiled).valid, false);
  assert.throws(
    () => executeInstruction(compiled, arbitrary),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR101",
  );
});

test("a settled final delay runs into exit canonically across execute, event stepping, run, and repeated halted entries", () => {
  const compiled = plan('function hidden { say "hidden" }\nwait 1 ms\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const settled = observeTime(compiled, waiting.snapshot, 1);
  assert.deepEqual(
    [...waiting.events, ...settled.events].map((event) => event.sequence),
    [1, 2],
  );

  for (const operation of [executeInstruction, stepToEvent, run]) {
    const completed = operation(compiled, settled.snapshot);
    assert.equal(completed.snapshot.status, "halted");
    assert.equal(validateRuntimeSnapshot(completed.snapshot, compiled).valid, true);
    assert.deepEqual(
      completed.events.map((event) => event.kind),
      ["exit"],
    );
    assert.deepEqual(
      completed.events.map((event) => event.sequence),
      [3],
    );
    assert.deepEqual(operation(compiled, completed.snapshot).events, []);
  }
});

test("zero waits remain immediate, also right before exit", () => {
  const terminalZero = plan("wait 0 s\nexit");
  const zeroResult = run(terminalZero, createFreshRuntimeSnapshot(terminalZero));
  assert.equal(zeroResult.snapshot.status, "halted");
  assert.equal(zeroResult.snapshot.nextActionId, 1);
  assert.equal(zeroResult.snapshot.foregroundAction, null);
  assert.equal(zeroResult.snapshot.lastSettlement, null);
  assert.deepEqual(
    zeroResult.events.map((event) => event.kind),
    ["exit"],
  );

  const visible = plan('wait 0 s\nsay "visible"\nexit');
  const visibleResult = run(visible, createImmediatePacingRuntimeSnapshot(visible));
  assert.equal(visibleResult.snapshot.nextActionId, 1);
  assert.equal(visibleResult.snapshot.foregroundAction, null);
  assert.equal(visibleResult.snapshot.lastSettlement, null);
  assert.deepEqual(
    visibleResult.events.map((event) => event.kind),
    ["say", "exit"],
  );

  const ordinary = plan('say "ordinary"\nexit');
  assert.deepEqual(
    run(ordinary, createImmediatePacingRuntimeSnapshot(ordinary)).events.map((event) => event.kind),
    ["say", "exit"],
  );
});

test("every settlement relationship is validated and valid replay is preserved", () => {
  const compiled = plan("wait 1 ms\nwait 10 ms\nexit");
  const firstWaiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  const firstSettled = observeTime(compiled, firstWaiting, 1).snapshot;
  const active = run(compiled, firstSettled).snapshot;
  assert.equal(active.status, "waiting");
  assert.notEqual(active.lastSettlement, null);

  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture table: callbacks deliberately violate distinct settled-delay snapshot invariants before validation.
  const invalid: Readonly<Record<string, (snapshot: any) => void>> = {
    unissuedActionId: (snapshot) => {
      snapshot.lastSettlement!.actionId = snapshot.nextActionId;
    },
    activeActionId: (snapshot) => {
      snapshot.lastSettlement!.actionId = snapshot.foregroundAction!.actionId;
    },
    unorderedSequences: (snapshot) => {
      snapshot.lastSettlement!.requestEventSequence =
        snapshot.lastSettlement!.completionEventSequence;
    },
    completionAtNextSequence: (snapshot) => {
      snapshot.lastSettlement!.completionEventSequence = snapshot.nextEventSequence;
    },
    beforeDeadline: (snapshot) => {
      snapshot.lastSettlement!.completedAtMs = snapshot.lastSettlement!.deadlineMs - 0.5;
    },
    afterCurrentTime: (snapshot) => {
      snapshot.lastSettlement!.completedAtMs = snapshot.currentSessionTimeMs + 0.5;
    },
    missingOwningInstruction: (snapshot) => {
      delete snapshot.lastSettlement!.owningInstruction;
    },
    wrongContinuationInstruction: (snapshot) => {
      snapshot.lastSettlement!.continuationInstruction += 1;
    },
  };
  for (const [name, mutate] of Object.entries(invalid)) {
    const candidate = mutable(active);
    mutate(candidate);
    assert.equal(validateRuntimeSnapshot(candidate, compiled).valid, false, name);
    const checkpoint = { ...createCheckpoint(compiled, active), snapshot: candidate };
    assert.throws(() => restoreCheckpoint(checkpoint), checkpointError, name);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), checkpointError, name);
  }

  // An independent baseline taken before the replay, so a mutated caller cannot hide changes.
  const beforeReplay = structuredClone(active);
  const replay = completeAction(compiled, active, {
    actionId: beforeReplay.lastSettlement!.actionId,
    actionKind: "delay",
    payload: { kind: "time", currentSessionTimeMs: beforeReplay.currentSessionTimeMs },
  });
  assert.deepEqual(replay.outcome, {
    kind: "alreadySettled",
    settlement: beforeReplay.lastSettlement,
  });
  assert.deepEqual(replay.snapshot, beforeReplay);
  assert.deepEqual(active, beforeReplay);
  assert.deepEqual(replay.events, []);
  assert.equal(replay.instructionsExecuted, 0);
});

test("wait keeps representable fractional delays and fails precision-losing deadlines before an action request", () => {
  const conversions: ReadonlyArray<readonly [string, number]> = [
    ["wait 0.5 s", 500],
    ["wait 0.5 ms", 0.5],
    ["wait 0.0005 s", 0.5],
    ["wait 0.000008333333333333334 min", 0.5],
    ["wait 0.0000001388888888888889 h", 0.0000001388888888888889 * 3_600_000],
  ];
  for (const [source, expected] of conversions) {
    const compiled = plan(`${source}\nexit`);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled));
    assert.equal(delayAction(result.snapshot).deadlineMs, expected, source);
    assert.ok(
      delayAction(result.snapshot).deadlineMs > delayAction(result.snapshot).createdAtMs,
      source,
    );
  }

  for (const source of [
    "wait 0.5 ms",
    "wait 0.0005 s",
    "wait 0.000008333333333333334 min",
    "wait 0.0000001 h",
  ]) {
    const compiled = plan(`${source}\nexit`);
    const start = MAX_RUNTIME_SESSION_TIME_MS - 3;
    const result = executeInstruction(
      compiled,
      createFreshRuntimeSnapshot(compiled, { initialSessionTimeMs: start }),
    );
    const failure = result.snapshot.failure;
    assert.equal(result.snapshot.status, "failed", source);
    assert.equal(failure?.code, "TSR050", source);
    // The failure points at the authored duration operand after `wait `.
    assert.deepEqual(
      [failure?.span.start.offset, failure?.span.end.offset],
      ["wait ".length, source.length],
      source,
    );
    assert.deepEqual(
      result.events.map((event) =>
        event.kind === "runtimeFailure"
          ? { kind: event.kind, code: event.code, span: event.span }
          : { kind: event.kind },
      ),
      [{ kind: "runtimeFailure", code: "TSR050", span: failure?.span }],
      source,
    );
    assert.equal(result.snapshot.foregroundAction, null, source);
    assert.equal(result.snapshot.nextActionId, 1, source);
    assert.ok(!result.events.some((event) => event.kind === "actionRequested"), source);
  }

  const sequential = plan("wait 0.1 ms\nwait 0.2 ms\nexit");
  const first = run(sequential, createFreshRuntimeSnapshot(sequential));
  assert.equal(delayAction(first.snapshot).deadlineMs, 0.1);
  const afterFirst = observeTime(sequential, first.snapshot, 0.1);
  const second = run(sequential, afterFirst.snapshot);
  assert.equal(second.snapshot.status, "waiting");
  assert.equal(delayAction(second.snapshot).createdAtMs, 0.1);
  assert.ok(delayAction(second.snapshot).deadlineMs > 0.1);

  const largestFractional = plan("wait 0.5 ms\nexit");
  const start = 2 ** 52 - 0.5;
  const pending = run(
    largestFractional,
    createFreshRuntimeSnapshot(largestFractional, { initialSessionTimeMs: start }),
  );
  assert.equal(delayAction(pending.snapshot).deadlineMs, 2 ** 52);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(largestFractional, pending.snapshot)),
  );
  assert.equal(observeTime(restored.plan, restored.snapshot, 2 ** 52).snapshot.status, "running");
});

test("wait uses the keyword path, and validation rejects forged ownership and missing wait temporaries", () => {
  // `wait` is a keyword, never a callable builtin: a call form may only fail with a located diagnostic or mean the
  // same one-second delay.
  const callForm = compileSource("wait(1)");
  if (callForm.plan === null) {
    assert.ok(
      callForm.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === DiagnosticSeverity.Error &&
          diagnostic.span.end.offset <= "wait(1)".length,
      ),
    );
  } else {
    const delay = run(callForm.plan, createFreshRuntimeSnapshot(callForm.plan)).snapshot;
    assert.ok(
      delay.foregroundAction?.kind === "delay" && delay.foregroundAction.deadlineMs === 1000,
    );
  }
  assert.equal(compileSource("wait (1 + 2) s\nexit").diagnostics.length, 0);

  const functionWait = waiting("function pause { wait 1 ms }\npause()\nexit");
  const forgedOwner = mutable(functionWait.snapshot);
  // EVIDENCE: fixture: expose the readonly pending-action owner to forge invalid call ownership.
  (forgedOwner.foregroundAction! as { ownerCallFrameId: number | null }).ownerCallFrameId = null;
  assert.equal(validateRuntimeSnapshot(forgedOwner, functionWait.compiled).valid, false);
  const forgedContinuation = mutable(functionWait.snapshot);
  forgedContinuation.nextInstruction = forgedContinuation.foregroundAction!.continuationInstruction;
  assert.equal(validateRuntimeSnapshot(forgedContinuation, functionWait.compiled).valid, false);

  const scopedWait = waiting("if true {\n  wait 1 ms\n}\nexit");
  const forgedScope = mutable(scopedWait.snapshot);
  // EVIDENCE: fixture: expose the readonly pending-action scope depth to forge invalid scope ownership.
  (forgedScope.foregroundAction! as { scopeDepth: number }).scopeDepth = 1;
  assert.equal(validateRuntimeSnapshot(forgedScope, scopedWait.compiled).valid, false);
  const loopWait = waiting("repeat 1 {\n  wait 1 ms\n}\nexit");
  const forgedLoop = mutable(loopWait.snapshot);
  // EVIDENCE: fixture: expose the readonly pending-action loop depth to forge invalid loop ownership.
  (forgedLoop.foregroundAction! as { loopDepth: number }).loopDepth = 0;
  assert.equal(validateRuntimeSnapshot(forgedLoop, loopWait.compiled).valid, false);

  const temporaryWait = waiting("function one { return 1 }\nwait one() ms\nexit");
  const missingTemporary = mutable(temporaryWait.snapshot);
  missingTemporary.temporaries.length = 0;
  assert.equal(validateRuntimeSnapshot(missingTemporary, temporaryWait.compiled).valid, false);
});

test("the final safe action identity is allocated, and the next allocation fails without reuse", () => {
  const source = "wait 1 ms\nwait 1 ms\nexit";
  const compiled = plan(source);
  const initial = createFreshRuntimeSnapshot(compiled);
  initial.nextActionId = Number.MAX_SAFE_INTEGER - 1;
  const first = run(compiled, initial);
  assert.equal(first.snapshot.foregroundAction!.actionId, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(first.snapshot.nextActionId, Number.MAX_SAFE_INTEGER);
  const settled = observeTime(compiled, first.snapshot, 1).snapshot;
  const second = executeInstruction(compiled, settled);
  const failure = second.snapshot.failure;
  const secondWait = source.indexOf("wait 1 ms", 1);
  assert.equal(second.snapshot.status, "failed");
  assert.equal(failure?.code, "TSR051");
  assert.deepEqual(
    [failure?.span.start.offset, failure?.span.end.offset],
    [secondWait, secondWait + "wait 1 ms".length],
  );
  assert.deepEqual(
    second.events.map((event) =>
      event.kind === "runtimeFailure"
        ? { kind: event.kind, code: event.code, span: event.span }
        : { kind: event.kind },
    ),
    [{ kind: "runtimeFailure", code: "TSR051", span: failure?.span }],
  );
  assert.equal(second.snapshot.foregroundAction, null);
  assert.equal(second.snapshot.nextActionId, Number.MAX_SAFE_INTEGER);
  assert.ok(!second.events.some((event) => event.kind === "actionRequested"));
});

function checkpointError(error: unknown): boolean {
  return error instanceof CheckpointError && error.info.code === "TSK002";
}
