import assert from "node:assert/strict";
import test from "node:test";

import {
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  inspectRuntimeState,
  observeTime,
  run,
  serializeCheckpoint,
  type RuntimeInspectionResult,
} from "../src/index.js";
import { compileValidPlan as compiled } from "./helpers/compile-valid-plan.js";

test("runtime inspection exposes foreground interaction provenance without mutation", () => {
  const source =
    'speaker mistress { name: "Mistress" }\nlet answer = askText as mistress "Type here"\nexit';
  const ask = 'askText as mistress "Type here"';
  const plan = compiled(source);
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.status, "waiting");
  const callerState = structuredClone(pending.snapshot);
  const before = JSON.stringify(callerState);
  const inspection = inspectRuntimeState(plan, callerState);
  assert.equal(inspection.valid, true);
  if (!inspection.valid) return;
  const mistress = callerState.speakers.find((speaker) => speaker.identifier === "mistress");
  assert.notEqual(mistress, undefined);
  const action = inspection.foregroundAction?.action;
  assert.equal(action?.kind, "interaction");
  if (action?.kind !== "interaction") return;
  assert.equal(action.actionId, callerState.foregroundAction?.actionId);
  assert.equal(action.interactionKind, "text");
  assert.equal(action.target, "standardChat");
  assert.equal(action.speakerId, mistress?.id);
  assert.equal(action.ui.kind, "text");
  if (action.ui.kind === "text") assert.equal(action.ui.hint, "Type here");
  assert.deepEqual(
    [
      inspection.foregroundAction?.sourceSpan?.start.offset,
      inspection.foregroundAction?.sourceSpan?.end.offset,
    ],
    [source.indexOf(ask), source.indexOf(ask) + ask.length],
  );
  assert.equal(JSON.stringify(callerState), before);

  // Writing to a view, whether or not the view accepts the write, cannot change the inspected state.
  Reflect.set(foregroundTextUi(inspectRuntimeState(plan, callerState)), "hint", "changed in view");
  assert.equal(JSON.stringify(callerState), before);
  assert.equal(foregroundTextUi(inspectRuntimeState(plan, callerState)).hint, "Type here");

  assert.equal(callerState.foregroundAction?.kind, "interaction");
  if (callerState.foregroundAction?.kind === "interaction") {
    assert.equal(Reflect.set(callerState.foregroundAction.ui, "hint", "changed"), true);
  }
  if (action.ui.kind === "text") assert.equal(action.ui.hint, "Type here");
});

test("runtime inspection exposes pacing settings, deadline, skip policy, and prepared output", () => {
  const source =
    'speaker guide { displayName: "Guide" }\nsay unskippable "hello there"\nsay as guide "one two three"\nexit';
  const settings = { baseDelayMs: 1000, delayPerWordMs: 200, delayPerCharacterMs: 10 };
  const plan = compiled(source);
  const pending = run(
    plan,
    createFreshRuntimeSnapshot(plan, { initialSessionTimeMs: 100, ...settings }),
  );
  assert.equal(pending.snapshot.status, "waiting");
  const inspection = inspectRuntimeState(plan, pending.snapshot);
  assert.equal(inspection.valid, true);
  if (!inspection.valid) return;
  assert.deepEqual(inspection.chatPacingSettings, settings);
  assert.deepEqual(inspection.backgroundActions, []);
  const gate = inspection.foregroundAction?.action;
  assert.equal(gate?.kind, "chatPacingGate");
  if (gate?.kind !== "chatPacingGate") return;
  // First say: 100 + 1000 + max(2 words * 200, 11 characters * 10).
  assert.equal(gate.deadlineMs, 1500);
  assert.equal(gate.skippable, false);

  const prepared = gate.preparedOutput;
  assert.equal(prepared?.text, "one two three");
  assert.deepEqual(
    [prepared?.speaker?.identifier, prepared?.speaker?.displayName],
    ["guide", "Guide"],
  );
  // Second say: 1000 + max(3 words * 200, 13 characters * 10); the platform default is skippable.
  assert.equal(prepared?.durationMs, 1600);
  assert.equal(prepared?.skippable, true);
  const secondSay = 'say as guide "one two three"';
  assert.equal(prepared?.owningInstruction, inspection.nextInstruction);
  assert.deepEqual(
    [
      inspection.nextInstructionSourceSpan?.start.offset,
      inspection.nextInstructionSourceSpan?.end.offset,
    ],
    [source.indexOf(secondSay), source.indexOf(secondSay) + secondSay.length],
  );

  // After the gate expires, the held prepared output keeps the second say's own source span.
  const released = inspectRuntimeState(
    plan,
    observeTime(plan, pending.snapshot, gate.deadlineMs).snapshot,
  );
  assert.equal(released.valid, true);
  if (!released.valid) return;
  assert.deepEqual(released.preparedSayOutput?.output, prepared);
  assert.deepEqual(
    [
      released.preparedSayOutput?.sourceSpan?.start.offset,
      released.preparedSayOutput?.sourceSpan?.end.offset,
    ],
    [source.indexOf(secondSay), source.indexOf(secondSay) + secondSay.length],
  );
});

test("runtime inspection survives checkpoint JSON restore and exposes settlement", () => {
  const plan = compiled('let answer = askText "Type here"\nsay answer, instant\nexit');
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
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, completed.snapshot)),
  );
  const directInspection = inspectRuntimeState(plan, completed.snapshot);
  const restoredInspection = inspectRuntimeState(restored.plan, restored.snapshot);
  assert.deepEqual(restoredInspection, directInspection);
  assert.equal(restoredInspection.valid, true);
  if (restoredInspection.valid)
    assert.equal(restoredInspection.lastSettlement?.settlement.actionKind, "interaction");
});

test("runtime inspection rejects malformed external state without changing it", () => {
  const plan = compiled('showButton "Continue"\nexit');
  const snapshot = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  const malformed = { ...structuredClone(snapshot), status: "impossible" };
  const before = JSON.stringify(malformed);
  const result = inspectRuntimeState(plan, malformed);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((error) => error.kind === "snapshot"));
  assert.equal(JSON.stringify(malformed), before);
});

function foregroundTextUi(inspection: RuntimeInspectionResult) {
  const action = inspection.valid ? inspection.foregroundAction?.action : undefined;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "text");
  return action.ui;
}
