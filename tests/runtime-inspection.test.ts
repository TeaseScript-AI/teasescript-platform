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
  type SourceSpan,
} from "../src/index.js";
import { compileValidPlan as compiled } from "./helpers/compile-valid-plan.js";

test("runtime inspection exposes foreground interaction provenance without mutation", () => {
  const source =
    'speaker mistress { name: "Mistress" }\nlet answer = askText as mistress "Type here"';
  const plan = compiled(source);
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.status, "waiting");
  const before = JSON.stringify(pending.snapshot);
  const inspection = inspectRuntimeState(plan, pending.snapshot);
  assert.equal(inspection.valid, true);
  if (!inspection.valid) return;
  const foreground = inspection.foregroundAction;
  assert.deepEqual(foreground?.action, pending.snapshot.foregroundAction);
  assert.ok(foreground.action.kind === "interaction");
  assert.equal(foreground.action.interactionKind, "text");
  assert.equal(foreground.action.target, "standardChat");
  assert.ok(foreground.action.ui.kind === "text");
  assert.equal(foreground.action.ui.hint, "Type here");
  const mistress = pending.snapshot.speakers.find((speaker) => speaker.identifier === "mistress");
  assert.equal(foreground.action.speakerId, mistress?.id);
  assert.equal(spanText(source, foreground.sourceSpan), 'askText as mistress "Type here"');
  assert.equal(JSON.stringify(pending.snapshot), before);
  assert.equal(Object.isFrozen(inspection), true);
  assert.equal(Object.isFrozen(foreground.action), true);
});

test("runtime inspection exposes pacing settings, deadline, skip policy, and prepared output", () => {
  const source =
    'speaker guide { displayName: "Guide" }\nsay skippable "hello"\nsay as guide "second"';
  const plan = compiled(source);
  const settings = { baseDelayMs: 1_000, delayPerWordMs: 200, delayPerCharacterMs: 100 };
  const pending = run(
    plan,
    createFreshRuntimeSnapshot(plan, { initialSessionTimeMs: 100, ...settings }),
  );
  const inspection = inspectRuntimeState(plan, pending.snapshot);
  assert.equal(inspection.valid, true);
  if (!inspection.valid) return;
  assert.deepEqual(inspection.chatPacingSettings, settings);

  // "hello" paces 1000 + max(1 word * 200, 5 characters * 100) ms from 100 ms and blocks the second say.
  const gate = inspection.foregroundAction;
  assert.ok(gate?.action.kind === "chatPacingGate");
  assert.deepEqual([gate.action.skippable, gate.action.deadlineMs], [true, 1_600]);
  assert.equal(spanText(source, gate.sourceSpan), 'say skippable "hello"');
  // "second" is prepared with its speaker and its own pace: 1000 + max(1 * 200, 6 * 100) ms.
  const prepared = gate.action.preparedOutput;
  assert.deepEqual(
    [prepared?.text, prepared?.speaker?.identifier, prepared?.durationMs],
    ["second", "guide", 1_600],
  );

  // Once the gate settles, the prepared output is inspected with the source of its own say.
  const settled = inspectRuntimeState(plan, observeTime(plan, pending.snapshot, 1_600).snapshot);
  assert.equal(settled.valid, true);
  if (!settled.valid) return;
  assert.deepEqual(settled.preparedSayOutput?.output, prepared);
  assert.equal(spanText(source, settled.preparedSayOutput.sourceSpan), 'say as guide "second"');
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
  const plan = compiled('showButton "Continue"');
  const snapshot = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  const malformed = { ...structuredClone(snapshot), status: "impossible" };
  const before = JSON.stringify(malformed);
  const result = inspectRuntimeState(plan, malformed);
  assert.equal(result.valid, false);
  if (!result.valid) assert.ok(result.errors.some((error) => error.kind === "snapshot"));
  assert.equal(JSON.stringify(malformed), before);
});

function spanText(source: string, span: SourceSpan | null | undefined): string | undefined {
  return span === null || span === undefined
    ? undefined
    : source.slice(span.start.offset, span.end.offset);
}
