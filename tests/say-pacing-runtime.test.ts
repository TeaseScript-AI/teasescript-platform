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
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

function plan(source: string) {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  return compiled.plan!;
}

test("say lowers smart, exact, and instant pacing with explicit skip policy", () => {
  const compiled = plan('say skippable "a"\nsay unskippable "b", 1.5\nsay "c", instant');
  assert.deepEqual(compiled.instructions.map((instruction) => instruction.kind === "say" ? [instruction.skipPolicy, instruction.pacing === "smart" || instruction.pacing === "instant" ? instruction.pacing : instruction.pacing.kind] : instruction.kind), [
    ["skippable", "smart"],
    ["unskippable", "literal"],
    [null, "instant"],
  ]);
});

test("first smart say creates a background gate and later say promotes it without a second request", () => {
  const compiled = plan('say "first"\nsay "second"');
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(result.events.map((event) => event.kind), ["say", "actionRequested"]);
  const gate = result.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate?.preparedOutput?.text, "second");
  assert.equal(gate?.actionId, 1);
  assert.equal(gate?.deadlineMs, 1_800);
});

test("pacing skip settles only a skippable foreground gate and emits prepared output later", () => {
  const compiled = plan('say "first"\nsay "second"');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const rejected = completeAction(compiled, waiting.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(rejected.outcome.kind, "completed");
  assert.deepEqual(rejected.events.map((event) => event.kind), ["actionCompleted"]);
  const resumed = run(compiled, rejected.snapshot);
  assert.ok(resumed.events.some((event) => event.kind === "say" && event.text === "second"));
});

test("instant output supersedes a background pacing gate", () => {
  const compiled = plan('say "first"\nsay "second", instant');
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(result.events.map((event) => event.kind), ["say", "actionRequested", "actionCompleted", "say", "complete"]);
  assert.equal(result.snapshot.lastSettlement?.actionKind, "chatPacingGate");
  assert.equal(result.snapshot.lastSettlement?.settlementKind, "supersededByInstantOutput");
});

test("pacing gate survives checkpoint JSON restore and settles through observed time", () => {
  const compiled = plan('say "first"\nsay "second"');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)));
  const settled = observeTime(restored.plan, restored.snapshot, 1_800);
  assert.deepEqual(settled.events.map((event) => event.kind), ["actionCompleted"]);
  const resumed = run(restored.plan, settled.snapshot);
  assert.ok(resumed.events.some((event) => event.kind === "say" && event.text === "second"));
});

test("speaker default and explicit skip policy determine pacing gate skippability", () => {
  const compiled = plan('speaker vera { defaultSaySkippable: false }\nsay as vera "one"\nsay skippable "two"');
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(result.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(result.snapshot.foregroundAction?.skippable, false);
});
