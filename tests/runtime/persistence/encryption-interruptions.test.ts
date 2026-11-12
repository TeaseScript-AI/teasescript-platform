/*
 * A lock dialog interrupted by a due block and resumed, and a lock's completion, choices and handoff checked on restore,
 * on the encryption tests' shared host.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeLockActionSnapshot } from "../../../src/runtime/actions/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/snapshot/checkpoint.js";
import { run } from "../../../src/runtime/engine.js";
import { completeAction } from "../../../src/runtime/operations/complete-action.js";
import { observeTime } from "../../../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../../../src/runtime/snapshot/state.js";
import { compileValidPlan } from "../../helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "../../helpers/immediate-pacing-runtime.js";
import { validateRuntimeSnapshot } from "../../../src/runtime/snapshot/snapshot-validation.js";
import { WALL_CLOCK_MS, DAY_MS, lockStep } from "../../helpers/runtime/encryption-host.js";

test("a due expiry block interrupts a lock dialog, which asks again afterwards, but waits for a lock step", () => {
  const plan = compileValidPlan(
    [
      'timer async 1 s { say "Time is up", instant\n wait 2 s }',
      'let locked = encryptText("x")',
      "exit",
    ].join("\n"),
  );
  let result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  const dialog = lockStep(result.snapshot);
  assert.deepEqual([dialog.kind, dialog.phase], ["lock", "ask"]);
  // The block interrupts the dialog: while it waits, the dialog is suspended, also through a checkpoint, and a
  // completion of it is refused.
  result = observeTime(plan, result.snapshot, 1000);
  result = run(plan, result.snapshot);
  assert.ok(result.events.some((event) => event.kind === "say" && event.text === "Time is up"));
  assert.equal(result.snapshot.foregroundAction?.kind, "delay");
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, result.snapshot)),
  ).snapshot;
  assert.equal(
    completeAction(plan, restored, {
      actionId: dialog.actionId,
      actionKind: "lock",
      payload: { kind: "submitted" },
    }).outcome.kind,
    "suspendedAction",
  );
  // Once the block returns, the dialog asks again.
  result = observeTime(plan, restored, 3000);
  result = run(plan, result.snapshot);
  assert.deepEqual(validateRuntimeSnapshot(result.snapshot, plan).errors, []);
  const again = lockStep(result.snapshot);
  assert.deepEqual([again.actionId, again.phase], [dialog.actionId, "ask"]);

  const working = compileValidPlan(
    [
      'timer async 1 s { say "Time is up", instant }',
      'let locked = encryptText("x", password: "p", publicKey: false, timeLock: false)',
      "exit",
    ].join("\n"),
  );
  let step = run(
    working,
    createImmediatePacingRuntimeSnapshot(working, { wallClockMs: WALL_CLOCK_MS }),
  );
  const work = lockStep(step.snapshot);
  assert.equal(work.phase, "work");
  step = observeTime(working, step.snapshot, 1000);
  step = run(working, step.snapshot);
  assert.ok(!step.events.some((event) => event.kind === "say"));
  assert.equal(step.snapshot.foregroundAction?.actionId, work.actionId);
  // Once the step settles, the block runs before the script goes on.
  const completed = completeAction(working, step.snapshot, {
    actionId: work.actionId,
    actionKind: "lock",
    payload: { kind: "locked", text: "AAAA" },
  });
  assert.equal(completed.outcome.kind, "completed");
  const after = run(working, completed.snapshot);
  assert.ok(after.events.some((event) => event.kind === "say" && event.text === "Time is up"));
  assert.equal(after.snapshot.status, "halted");

  // The password field of `password: askPassword(...)` is interrupted as the dialog is, and asks anew afterwards.
  const asking = compileValidPlan(
    [
      'timer async 1 s { say "Time is up", instant\n wait 2 s }',
      'let locked = encryptText("x", password: askPassword("Code?"), publicKey: false, timeLock: false)',
      "exit",
    ].join("\n"),
  );
  let field = run(
    asking,
    createImmediatePacingRuntimeSnapshot(asking, { wallClockMs: WALL_CLOCK_MS }),
  );
  const first = lockStep(field.snapshot);
  assert.deepEqual([first.phase, first.passwordField, first.resumes], ["ask", { hint: null }, 0]);
  field = run(asking, observeTime(asking, field.snapshot, 1000).snapshot);
  assert.equal(field.snapshot.foregroundAction?.kind, "delay");
  field = run(asking, observeTime(asking, field.snapshot, 3000).snapshot);
  assert.deepEqual(validateRuntimeSnapshot(field.snapshot, asking).errors, []);
  const anew = lockStep(field.snapshot);
  assert.deepEqual(
    [anew.actionId, anew.phase, anew.passwordField, anew.resumes],
    [first.actionId, "ask", { hint: null }, 1],
  );
});

test("a lock completion must fit its call and step, and its handoff is checked on restore", () => {
  const plan = compileValidPlan(
    'let a = encryptText("x", password: "p", publicKey: false, timeLock: false)\nlet b = decryptText(a, default: null)\nexit',
  );
  const started = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  const action = lockStep(started.snapshot);
  const complete = (payload: unknown) =>
    completeAction(plan, started.snapshot, {
      actionId: action.actionId,
      actionKind: "lock",
      payload,
    }).outcome.kind;
  for (const payload of [
    { kind: "locked", text: "not base64!" },
    { kind: "locked", text: "AAAA", extra: 1 },
    { kind: "locked", file: "stored:1" },
    { kind: "opened", text: "x" },
    { kind: "notOpened" },
    { kind: "cancelled" },
    { kind: "submitted" },
    // A step with a written password never asks.
    { kind: "ask" },
    { kind: "failed", reason: "unreadable" },
    { kind: "failed" },
  ])
    assert.equal(complete(payload), "invalidPayload", JSON.stringify(payload));
  assert.equal(complete({ kind: "failed", reason: "unavailable" }), "completed");
  const locked = completeAction(plan, started.snapshot, {
    actionId: action.actionId,
    actionKind: "lock",
    payload: { kind: "locked", text: "AAAA" },
  });
  assert.equal(locked.outcome.kind, "completed");
  // The handoff carries the outcome and the lock; another outcome or result is rejected on restore.
  const handoff = locked.snapshot.interactionResultHandoff!;
  assert.deepEqual(handoff.result, { kind: "list", items: ["locked", "AAAA"] });
  for (const result of [
    { kind: "list", items: ["opened", "AAAA"] },
    { kind: "list", items: ["locked"] },
    { kind: "list", items: ["locked", "not base64!"] },
    { kind: "list", items: ["notOpened"] },
  ]) {
    const tampered = { ...locked.snapshot, interactionResultHandoff: { ...handoff, result } };
    assert.notDeepEqual(validateRuntimeSnapshot(tampered, plan).errors, [], JSON.stringify(result));
  }
  // The decrypt step without a password may ask; its dialog may only be submitted or cancelled.
  const decrypting = run(plan, locked.snapshot);
  const unlock = lockStep(decrypting.snapshot);
  assert.deepEqual([unlock.call, unlock.phase, unlock.password], ["decryptText", "work", null]);
  const asks = completeAction(plan, decrypting.snapshot, {
    actionId: unlock.actionId,
    actionKind: "lock",
    payload: { kind: "ask", notice: "unreachable" },
  });
  assert.equal(asks.outcome.kind, "completed");
  // A wrong password needs a password the dialog asked for.
  assert.equal(
    completeAction(plan, decrypting.snapshot, {
      actionId: unlock.actionId,
      actionKind: "lock",
      payload: { kind: "ask", notice: "wrongPassword" },
    }).outcome.kind,
    "invalidPayload",
  );
  const dialog = run(plan, asks.snapshot).snapshot;
  const asking = lockStep(dialog);
  assert.deepEqual([asking.phase, asking.notice], ["ask", "unreachable"]);
  for (const payload of [{ kind: "opened", text: "x" }, { kind: "notOpened" }, { kind: "ask" }])
    assert.equal(
      completeAction(plan, dialog, { actionId: asking.actionId, actionKind: "lock", payload })
        .outcome.kind,
      "invalidPayload",
    );
  // A step is not changed into a dialog or given a password on restore.
  for (const change of [
    { phase: "work" },
    { password: "p" },
    { notice: "nonsense" },
    { value: "*" },
  ]) {
    const tampered = { ...dialog, foregroundAction: { ...asking, ...change } };
    assert.notDeepEqual(validateRuntimeSnapshot(tampered, plan).errors, [], JSON.stringify(change));
  }
});

test("a lock dialog's choices fit the call's openers, and are checked on restore", () => {
  const plan = compileValidPlan(
    'let a = encryptText("x", password: "given", publicKey: false, timeLock: true)\nlet b = encryptText("y")\nexit',
  );
  const started = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  const asking = lockStep(started.snapshot);
  assert.deepEqual(
    [asking.phase, asking.password, asking.timeLockMs, asking.choices],
    ["ask", "given", WALL_CLOCK_MS + 7 * DAY_MS, ["timeLock"]],
  );
  /** A change to a lock step's fields, some of them to values the engine never gives. */
  type StepChange = Partial<Record<keyof RuntimeLockActionSnapshot, unknown>>;
  const tampered = (snapshot: RuntimeSnapshot, change: StepChange) =>
    validateRuntimeSnapshot(
      { ...snapshot, foregroundAction: { ...lockStep(snapshot), ...change } },
      plan,
    ).errors;
  for (const change of [
    { choices: [] },
    { choices: ["password", "timeLock"] },
    { choices: ["timeLock", "timeLock"] },
    { choices: ["timeLock", "password"] },
    { timeLockMs: null },
    { choices: ["publicKey", "timeLock"] },
  ])
    assert.notDeepEqual(tampered(started.snapshot, change), [], JSON.stringify(change));
  // The step after the dialog takes the chosen time lock from the player's answer.
  const submitted = completeAction(plan, started.snapshot, {
    actionId: asking.actionId,
    actionKind: "lock",
    payload: { kind: "submitted" },
  });
  const working = run(plan, submitted.snapshot).snapshot;
  assert.deepEqual(
    [lockStep(working).phase, lockStep(working).timeLockMs, lockStep(working).choices],
    ["work", null, ["timeLock"]],
  );
  assert.notDeepEqual(tampered(working, { timeLockMs: WALL_CLOCK_MS }), []);
  assert.notDeepEqual(tampered(working, { choices: [] }), []);
  // A call that writes no opener lets the player choose each.
  const next = run(
    plan,
    completeAction(plan, working, {
      actionId: lockStep(working).actionId,
      actionKind: "lock",
      payload: { kind: "locked", text: "AAAA" },
    }).snapshot,
  ).snapshot;
  assert.deepEqual(lockStep(next).choices, ["timeLock", "password", "publicKey"]);
  assert.deepEqual(tampered(next, {}), []);
  assert.notDeepEqual(tampered(next, { choices: ["timeLock"] }), []);
});

test("a late time observation lets a due block interrupt a lock dialog, and the state stays valid until it runs", () => {
  const plan = compileValidPlan(
    [
      'timer async 1 s { say "Time is up", instant\n wait 2 s }',
      'let locked = encryptText("x")',
      "exit",
    ].join("\n"),
  );
  const started = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  const dialog = lockStep(started.snapshot);
  // Observed after the block's moment: the state waits for the block, checkpoints, and runs it after a restore.
  const observed = observeTime(plan, started.snapshot, 1500);
  assert.deepEqual(validateRuntimeSnapshot(observed.snapshot, plan).errors, []);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, observed.snapshot)),
  ).snapshot;
  const ran = run(plan, restored);
  assert.ok(ran.events.some((event) => event.kind === "say" && event.text === "Time is up"));
  assert.deepEqual(validateRuntimeSnapshot(ran.snapshot, plan).errors, []);
  const back = run(plan, observeTime(plan, ran.snapshot, 4000).snapshot);
  assert.equal(lockStep(back.snapshot).actionId, dialog.actionId);
});

test("a lock dialog that a block interrupted counts the return, also after a block that returned at once", () => {
  const plan = compileValidPlan(
    ['timer async 1 s { say "due", instant }', 'let locked = encryptText("x")', "exit"].join("\n"),
  );
  const started = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  assert.equal(lockStep(started.snapshot).resumes, 0);
  const back = run(plan, observeTime(plan, started.snapshot, 1000).snapshot);
  assert.ok(back.events.some((event) => event.kind === "say" && event.text === "due"));
  const again = lockStep(back.snapshot);
  assert.deepEqual(
    [again.actionId, again.phase, again.resumes],
    [lockStep(started.snapshot).actionId, "ask", 1],
  );
  assert.deepEqual(validateRuntimeSnapshot(back.snapshot, plan).errors, []);
  // A step is never resumed, and a count is a whole number.
  for (const resumes of [-1, 1.5]) {
    const tampered = { ...back.snapshot, foregroundAction: { ...again, resumes } };
    assert.notDeepEqual(validateRuntimeSnapshot(tampered, plan).errors, []);
  }
});
