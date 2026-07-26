import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { createCheckpoint, deserializeCheckpoint, serializeCheckpoint } from "../src/runtime/checkpoint.js";
import { completeAction, observeTime, run } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";

function plan(source: string) {
  const result = compileSource(source);
  assert.equal(result.diagnostics.length, 0);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

test("wait lowers to a foreground delay and settles only after an explicit observation", () => {
  const compiled = plan('wait 1.5 s\nsay "done"\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(waiting.snapshot.status, "waiting");
  assert.equal(waiting.snapshot.foregroundAction?.deadlineMs, 1500);
  assert.deepEqual(waiting.events.map((event) => event.kind), ["actionRequested"]);

  const early = observeTime(compiled, waiting.snapshot, 1499);
  assert.equal(early.outcome.kind, "observed");
  assert.equal(early.snapshot.status, "waiting");
  assert.equal(early.events.length, 0);

  const due = observeTime(compiled, early.snapshot, 1500);
  assert.equal(due.snapshot.status, "running");
  assert.deepEqual(due.events.map((event) => event.kind), ["actionCompleted"]);
  const done = run(compiled, due.snapshot);
  assert.equal(done.snapshot.status, "halted");
  assert.deepEqual(done.events.map((event) => event.kind), ["say", "exit"]);
});

test("zero waits allocate no action and waiting checkpoints restore without clock reads", () => {
  const zero = plan("wait 0\nexit");
  const completed = run(zero, createFreshRuntimeSnapshot(zero));
  assert.equal(completed.snapshot.nextActionId, 1);
  assert.deepEqual(completed.events.map((event) => event.kind), ["exit"]);

  const delayed = plan("wait 2 min\nexit");
  const waiting = run(delayed, createFreshRuntimeSnapshot(delayed));
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(delayed, waiting.snapshot)));
  assert.equal(restored.snapshot.status, "waiting");
  assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);
  assert.equal(observeTime(restored.plan, restored.snapshot, 120_000).snapshot.status, "running");
});

test("negative static waits fail compilation and backward observations never move session time backward", () => {
  assert.equal(compileSource("wait -1").plan, null);
  const compiled = plan("wait 1 ms\nexit");
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled, { initialSessionTimeMs: 10 }));
  const observation = observeTime(compiled, waiting.snapshot, 2);
  assert.equal(observation.snapshot.currentSessionTimeMs, 10);
});

test("typed completion is idempotent and classifies invalid, early, stale, and unknown IDs", () => {
  const compiled = plan("wait 10 ms\nwait 10 ms\nexit");
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const actionId = waiting.snapshot.foregroundAction!.actionId;
  const early = completeAction(compiled, waiting.snapshot, { actionId, actionKind: "delay", payload: { kind: "time", currentSessionTimeMs: 9 } });
  assert.equal(early.outcome.kind, "notDue");
  const settled = completeAction(compiled, waiting.snapshot, { actionId, actionKind: "delay", payload: { kind: "time", currentSessionTimeMs: 10 } });
  assert.equal(settled.outcome.kind, "completed");
  const duplicate = completeAction(compiled, settled.snapshot, { actionId, actionKind: "delay", payload: { kind: "time", currentSessionTimeMs: 10 } });
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  assert.deepEqual(duplicate.events, []);
  const secondWaiting = run(compiled, settled.snapshot);
  const secondId = secondWaiting.snapshot.foregroundAction!.actionId;
  const secondSettled = completeAction(compiled, secondWaiting.snapshot, { actionId: secondId, actionKind: "delay", payload: { kind: "time", currentSessionTimeMs: 20 } });
  assert.equal(completeAction(compiled, secondSettled.snapshot, { actionId, actionKind: "delay", payload: { kind: "time", currentSessionTimeMs: 20 } }).outcome.kind, "staleAction");
  assert.equal(completeAction(compiled, secondSettled.snapshot, { actionId: secondId + 1, actionKind: "delay", payload: { kind: "time", currentSessionTimeMs: 20 } }).outcome.kind, "unknownAction");
});
