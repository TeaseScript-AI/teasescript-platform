import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  inspectRuntimeState,
  run,
  serializeCheckpoint,
} from "../src/index.js";

function compiled(source: string) {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

test("runtime inspection exposes foreground interaction provenance without mutation", () => {
  const plan = compiled('speaker mistress { name: "Mistress" }\nlet answer = askText as mistress "Type here"');
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.status, "waiting");
  const before = JSON.stringify(pending.snapshot);
  const inspection = inspectRuntimeState(plan, pending.snapshot);
  assert.equal(inspection.valid, true);
  if (!inspection.valid) return;
  assert.equal(inspection.foregroundAction?.action.kind, "interaction");
  if (inspection.foregroundAction?.action.kind === "interaction") {
    assert.equal(inspection.foregroundAction.action.interactionKind, "text");
    assert.equal(inspection.foregroundAction.action.target, "standardChat");
    assert.equal(inspection.foregroundAction.action.ui.kind, "text");
    assert.notEqual(inspection.foregroundAction.sourceSpan, null);
  }
  assert.equal(JSON.stringify(pending.snapshot), before);
  assert.equal(Object.isFrozen(inspection), true);
  assert.equal(Object.isFrozen(inspection.foregroundAction?.action), true);
});

test("runtime inspection exposes pacing settings, deadline, skip policy, and prepared output", () => {
  const plan = compiled('say skippable "hello"');
  const pending = run(plan, createFreshRuntimeSnapshot(plan, { initialSessionTimeMs: 100 }));
  const inspection = inspectRuntimeState(plan, pending.snapshot);
  assert.equal(inspection.valid, true);
  if (!inspection.valid) return;
  const gate = inspection.backgroundActions.find((item) => item.action.kind === "chatPacingGate");
  assert.equal(gate?.action.kind, "chatPacingGate");
  if (gate?.action.kind === "chatPacingGate") {
    assert.equal(gate.action.skippable, true);
    assert.ok(gate.action.deadlineMs >= 100);
  }
  assert.equal(inspection.chatPacingSettings.baseDelayMs, 1500);
});

test("runtime inspection survives checkpoint JSON restore and exposes settlement", () => {
  const plan = compiled('let answer = askText "Type here"\nsay answer, instant');
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.equal(action?.kind, "interaction");
  if (action?.kind !== "interaction") return;
  const completed = completeAction(plan, pending.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "answer" },
  });
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, completed.snapshot)));
  const directInspection = inspectRuntimeState(plan, completed.snapshot);
  const restoredInspection = inspectRuntimeState(restored.plan, restored.snapshot);
  assert.deepEqual(restoredInspection, directInspection);
  assert.equal(restoredInspection.valid, true);
  if (restoredInspection.valid) assert.equal(restoredInspection.lastSettlement?.settlement.actionKind, "interaction");
});

test("runtime inspection rejects malformed external state without changing it", () => {
  const plan = compiled('showButton "Continue"');
  const snapshot = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  const malformed = structuredClone(snapshot) as unknown as Record<string, unknown>;
  malformed.status = "impossible";
  const before = JSON.stringify(malformed);
  const result = inspectRuntimeState(plan, malformed);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((error) => error.kind === "snapshot"));
  assert.equal(JSON.stringify(malformed), before);
});
