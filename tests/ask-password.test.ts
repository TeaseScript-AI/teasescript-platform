import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import type { RuntimeInteractionActionSnapshot } from "../src/runtime/actions/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { validateRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

/*
 * askPassword (V30 §20): a masked field whose answer is the SHA-256 of what was typed, as hashText gives it. The Player
 * hashes; the engine records only the hash and adds no player line to the transcript.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function passwordStep(snapshot: RuntimeSnapshot): RuntimeInteractionActionSnapshot {
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.interactionKind === "password");
  return action;
}

function diagnostics(source: string): [string, string][] {
  return compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
  ]);
}

test("askPassword says its question, opens a masked field, and gives the hash of what was typed", () => {
  const plan = compileValidPlan(
    [
      'let typed = askPassword "Keyholder, your code?", hint: "The code"',
      'let same = typed == hashText("corner")',
      'say "Done", instant',
      "exit",
    ].join("\n"),
  );
  const started = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const step = passwordStep(started.snapshot);
  assert.deepEqual(step.ui, {
    kind: "password",
    hint: "The code",
    accessibleName: { kind: "localizedDefault", key: "password" },
  });
  assert.ok(
    started.events.some((event) => event.kind === "say" && event.text === "Keyholder, your code?"),
  );
  // Through a checkpoint, the field waits as any ask does.
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, started.snapshot)),
  ).snapshot;
  const completed = completeAction(plan, restored, {
    actionId: step.actionId,
    actionKind: "interaction",
    interactionKind: "password",
    payload: { kind: "submittedPassword", hash: sha256("corner") },
  });
  assert.equal(completed.outcome.kind, "completed");
  // No player line enters the transcript.
  assert.ok(!completed.events.some((event) => event.kind === "playerTranscript"));
  const ended = run(plan, completed.snapshot);
  assert.equal(ended.snapshot.status, "halted");
  assert.deepEqual(validateRuntimeSnapshot(ended.snapshot, plan).errors, []);
  const bindings = Object.fromEntries(
    ended.snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
  );
  assert.deepEqual(bindings, { typed: sha256("corner"), same: true });
});

test("a password answer must be a SHA-256 in lowercase hexadecimal digits, never the text", () => {
  const plan = compileValidPlan('let typed = askPassword("Code?")\nexit');
  const started = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const step = passwordStep(started.snapshot);
  for (const payload of [
    { kind: "submittedText", submittedText: "corner" },
    { kind: "submittedPassword", hash: "corner" },
    { kind: "submittedPassword", hash: sha256("corner").toUpperCase() },
    { kind: "submittedPassword", hash: sha256("corner"), text: "corner" },
  ])
    assert.equal(
      completeAction(plan, started.snapshot, {
        actionId: step.actionId,
        actionKind: "interaction",
        interactionKind: "password",
        payload,
      }).outcome.kind,
      "invalidPayload",
      JSON.stringify(payload),
    );
});

test("askPassword takes no prefill:, as a password is never suggested", () => {
  assert.deepEqual(diagnostics('let typed = askPassword("Code?", prefill: "corner")'), [
    [
      "TSV043",
      "askPassword takes no 'prefill:', since a password is never suggested. Remove 'prefill:'.",
    ],
  ]);
});

test("plans and states keep a password field's shape: no prefill, and no written password beside the field", () => {
  const plan = compileValidPlan(
    'let typed = askPassword("Code?", hint: "The code")\nlet locked = encryptText("x", password: askPassword("New code"))\nexit',
  );
  assert.equal(validateInstructionPlan(plan).valid, true);
  const changed = (
    change: (instruction: Record<string, unknown>) => Record<string, unknown> | null,
  ) =>
    validateInstructionPlan({
      ...plan,
      instructions: plan.instructions.map(
        (instruction) => change({ ...instruction }) ?? instruction,
      ),
    }).valid;
  assert.equal(
    changed((instruction) =>
      instruction.kind === "interaction" && "ui" in instruction
        ? { ...instruction, ui: Object.assign({}, instruction.ui, { prefill: "corner" }) }
        : null,
    ),
    false,
  );
  assert.equal(
    changed((instruction) =>
      instruction.kind === "lock"
        ? { ...instruction, password: { kind: "literal", value: "corner", span: instruction.span } }
        : null,
    ),
    false,
  );

  const started = run(plan, createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: 0 }));
  const field = completeAction(plan, started.snapshot, {
    actionId: passwordStep(started.snapshot).actionId,
    actionKind: "interaction",
    interactionKind: "password",
    payload: { kind: "submittedPassword", hash: sha256("corner") },
  });
  const asking = run(plan, field.snapshot).snapshot;
  const lock = asking.foregroundAction;
  assert.ok(lock?.kind === "lock" && lock.phase === "ask");
  assert.deepEqual(validateRuntimeSnapshot(asking, plan).errors, []);
  for (const passwordField of [null, { hint: 5 }, { hint: null, text: "corner" }])
    assert.notDeepEqual(
      validateRuntimeSnapshot({ ...asking, foregroundAction: { ...lock, passwordField } }, plan)
        .errors,
      [],
      JSON.stringify(passwordField),
    );
});

test("a password field that a block interrupted counts its return, also after a block that returned at once", () => {
  const plan = compileValidPlan(
    [
      'timer async 1 s { say "Time is up", instant }',
      'let typed = askPassword("Code?")',
      'let text = askText("Name?")',
      "exit",
    ].join("\n"),
  );
  let result = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const asked = passwordStep(result.snapshot);
  assert.equal(asked.resumes, undefined);
  result = run(plan, observeTime(plan, result.snapshot, 1000).snapshot);
  assert.ok(result.events.some((event) => event.kind === "say" && event.text === "Time is up"));
  const again = passwordStep(result.snapshot);
  assert.deepEqual([again.actionId, again.resumes], [asked.actionId, 1]);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, result.snapshot)),
  ).snapshot;
  assert.deepEqual(validateRuntimeSnapshot(restored, plan).errors, []);
  assert.equal(passwordStep(restored).resumes, 1);
  // Another kind of interaction keeps no count: askText's state is valid without one, and not with one.
  const answered = run(
    plan,
    completeAction(plan, restored, {
      actionId: again.actionId,
      actionKind: "interaction",
      interactionKind: "password",
      payload: { kind: "submittedPassword", hash: sha256("corner") },
    }).snapshot,
  ).snapshot;
  const text = answered.foregroundAction;
  assert.ok(text?.kind === "interaction" && text.interactionKind === "text");
  assert.deepEqual(validateRuntimeSnapshot(answered, plan).errors, []);
  assert.notDeepEqual(
    validateRuntimeSnapshot({ ...answered, foregroundAction: { ...text, resumes: 1 } }, plan)
      .errors,
    [],
  );
});
