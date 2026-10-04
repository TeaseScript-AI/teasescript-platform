import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

const PHOTO = "captured-media:photo:1";
// The trusted Player store vouches for exactly the photos it captured.
const admission = {
  holds: (reference: string, kind: "image") => kind === "image" && reference === PHOTO,
};

function started(source: string) {
  const plan = compileValidPlan(source);
  assert.equal(validateInstructionPlan(plan).valid, true);
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  return { plan, snapshot: result.snapshot, events: result.events };
}

function pendingCapture(snapshot: RuntimeSnapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(
    action !== null && action.kind === "capture",
    `expected a capture, got ${action?.kind}`,
  );
  return action;
}

function captured(plan: InstructionPlan, snapshot: RuntimeSnapshot, reference = PHOTO) {
  return completeAction(
    plan,
    snapshot,
    {
      actionId: pendingCapture(snapshot).actionId,
      actionKind: "capture",
      payload: { kind: "captured", media: { kind: "image", reference } },
    },
    { capturedMedia: admission },
  );
}

function unavailable(plan: InstructionPlan, snapshot: RuntimeSnapshot, reason: string) {
  return completeAction(plan, snapshot, {
    actionId: pendingCapture(snapshot).actionId,
    actionKind: "capture",
    payload: { kind: "unavailable", reason },
  });
}

function binding(snapshot: RuntimeSnapshot, name: string) {
  return snapshot.frames[0]?.bindings.find((candidate) => candidate.name === name)?.value;
}

const kinds = (events: readonly InterpreterEvent[]) => events.map((event) => event.kind);

test("takePhoto() waits for the Player and its captured reference reaches the Stage", () => {
  const { plan, snapshot, events } = started(
    "let photo: string? = takePhoto()\nif photo != null {\n  showImage photo\n}",
  );
  assert.equal(snapshot.status, "waiting");
  assert.deepEqual(kinds(events), ["actionRequested"]);
  const completion = captured(plan, snapshot);
  assert.equal(completion.outcome.kind, "completed");
  // A capture is silent: no transcript, no warning.
  assert.deepEqual(kinds(completion.events), ["actionCompleted"]);
  const finished = run(plan, completion.snapshot);
  assert.equal(finished.snapshot.status, "halted");
  assert.equal(finished.snapshot.stageImage, PHOTO);
});

test("an unavailable camera yields null with a developer warning and the script continues", () => {
  for (const reason of [
    "unconfigured",
    "denied",
    "notFound",
    "busy",
    "unsupported",
    "revoked",
    "failed",
  ]) {
    const { plan, snapshot } = started(
      'let photo = takePhoto()\nlet seen = photo == null\nshowImage "images/fallback.svg"',
    );
    const completion = unavailable(plan, snapshot, reason);
    assert.equal(completion.outcome.kind, "completed", reason);
    const warning = completion.events.find((event) => event.kind === "developerWarning");
    assert.ok(warning?.kind === "developerWarning" && warning.code === "TSW015", reason);
    assert.match(warning.message, /takePhoto\(\) returned null/u);
    const finished = run(plan, completion.snapshot);
    assert.equal(finished.snapshot.status, "halted", reason);
    assert.equal(binding(finished.snapshot, "seen"), true, reason);
  }
});

test("only a reference the trusted store holds becomes a captured photo", () => {
  const { plan, snapshot } = started("let photo = takePhoto()");
  const before = structuredClone(snapshot);
  const id = pendingCapture(snapshot).actionId;
  const attempts: unknown[] = [
    // A well-formed string the store does not hold, for example a package asset path.
    { kind: "captured", media: { kind: "image", reference: "images/coast.svg" } },
    { kind: "captured", media: { kind: "video", reference: PHOTO } },
    { kind: "captured", media: { kind: "image", reference: "" } },
    { kind: "captured", media: { kind: "image", reference: PHOTO, extra: true } },
    { kind: "captured", media: PHOTO },
    { kind: "unavailable", reason: "lost" },
    { kind: "unavailable" },
    PHOTO,
  ];
  for (const payload of attempts) {
    const outcome = completeAction(
      plan,
      snapshot,
      { actionId: id, actionKind: "capture", payload },
      { capturedMedia: admission },
    );
    assert.equal(outcome.outcome.kind, "invalidPayload", JSON.stringify(payload));
    assert.deepEqual(outcome.events, []);
    assert.deepEqual(outcome.snapshot, before);
  }
  // Without a trusted store even its own reference is not admitted.
  const unvouched = completeAction(plan, snapshot, {
    actionId: id,
    actionKind: "capture",
    payload: { kind: "captured", media: { kind: "image", reference: PHOTO } },
  });
  assert.equal(unvouched.outcome.kind, "invalidPayload");
  const wrongKind = completeAction(plan, snapshot, {
    actionId: id,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "text", text: PHOTO },
  });
  assert.deepEqual(wrongKind.outcome, {
    kind: "wrongActionKind",
    actionId: id,
    expectedActionKind: "capture",
    receivedActionKind: "interaction",
  });
});

test("a repeated completion replays its settlement instead of capturing twice", () => {
  const { plan, snapshot } = started("let photo = takePhoto()\nlet again = takePhoto()");
  const request = {
    actionId: pendingCapture(snapshot).actionId,
    actionKind: "capture",
    payload: { kind: "unavailable", reason: "denied" },
  };
  const first = completeAction(plan, snapshot, request);
  const replay = completeAction(plan, first.snapshot, request);
  assert.equal(replay.outcome.kind, "alreadySettled");
  assert.deepEqual(replay.events, []);
  const next = run(plan, first.snapshot);
  const finished = run(plan, captured(plan, next.snapshot).snapshot);
  assert.equal(completeAction(plan, finished.snapshot, request).outcome.kind, "staleAction");
});

test("a pending capture survives a JSON checkpoint and completes like the original", () => {
  const { plan, snapshot } = started('let photo = takePhoto()\nshowImage photo\nlet done = "yes"');
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  assert.deepEqual(restored.snapshot, snapshot);
  const original = run(plan, captured(plan, snapshot).snapshot);
  const resumed = captured(restored.plan, restored.snapshot);
  const resumedRun = run(restored.plan, resumed.snapshot);
  assert.deepEqual(resumedRun.snapshot, original.snapshot);
  assert.deepEqual(resumedRun.events, original.events);
  assert.equal(resumedRun.snapshot.stageImage, PHOTO);
  // A settled capture also round-trips, with its replayable settlement.
  const settled = unavailable(plan, snapshot, "busy").snapshot;
  const settledRestored = restoreCheckpoint(createCheckpoint(plan, settled));
  assert.deepEqual(settledRestored.snapshot, settled);
});

test("captures keep source order inside expressions and as discarded statements", () => {
  const { plan, snapshot } = started(
    "takePhoto()\nlet pair = [takePhoto(), takePhoto()]\nlet first = pair[0]\nlet second = pair[1]",
  );
  let current = unavailable(plan, snapshot, "denied").snapshot;
  current = run(plan, current).snapshot;
  current = captured(plan, current).snapshot;
  current = run(plan, current).snapshot;
  current = unavailable(plan, current, "busy").snapshot;
  const finished = run(plan, current).snapshot;
  assert.equal(finished.status, "halted");
  assert.equal(binding(finished, "first"), PHOTO);
  assert.equal(binding(finished, "second"), null);
});

test("a timer expiry block waits until a pending capture settles", () => {
  const { plan, snapshot } = started(
    "let fired = false\ntimer async 1 {\n  fired = true\n}\nlet photo = takePhoto()\nwait 5",
  );
  const late = observeTime(plan, snapshot, 2000);
  assert.equal(late.snapshot.foregroundAction?.kind, "capture");
  assert.equal(binding(late.snapshot, "fired"), false);
  const completion = unavailable(plan, late.snapshot, "denied");
  assert.equal(completion.outcome.kind, "completed");
  const continued = run(plan, completion.snapshot);
  assert.equal(binding(continued.snapshot, "fired"), true);
});

test("takePhoto() is a reserved call, not a value, argument-taking call, or host builtin", () => {
  const diagnostics = (source: string, options: Parameters<typeof compileSource>[1] = {}) =>
    compileSource(source, options).diagnostics.map((diagnostic) => diagnostic.code);
  assert.deepEqual(diagnostics("let photo = takePhoto(1)"), ["TSV020"]);
  assert.deepEqual(diagnostics("let take = takePhoto"), ["TSV028"]);
  assert.deepEqual(diagnostics("function frame(photo = takePhoto()) {\n}"), ["TSV032"]);
  assert.ok(diagnostics("let takePhoto = 1").length > 0);
  assert.ok(diagnostics("let photo = takePhoto()", { builtins: ["takePhoto"] }).length > 0);
});

test("an external plan cannot call takePhoto() as an ordinary function", () => {
  const plan = compileValidPlan('let photo = random()\nshowImage "a"');
  const forged = JSON.parse(JSON.stringify(plan));
  const declare = forged.instructions.find(
    (instruction: { kind: string }) => instruction.kind === "declareBinding",
  );
  declare.value.callee.name = "takePhoto";
  declare.value.arguments = [];
  assert.equal(validateInstructionPlan(forged).valid, false);
});

test("restored state rejects a tampered capture action or settlement", () => {
  const { plan, snapshot } = started("let photo = takePhoto()");
  const json = serializeCheckpoint(createCheckpoint(plan, snapshot));
  const pending = () => JSON.parse(json);
  const wrongDestination = pending();
  wrongDestination.snapshot.foregroundAction.destinationTemporary = 999;
  assert.throws(() => restoreCheckpoint(wrongDestination));
  const wrongCapture = pending();
  wrongCapture.snapshot.foregroundAction.capture = "video";
  assert.throws(() => restoreCheckpoint(wrongCapture));
  const settled = JSON.parse(
    serializeCheckpoint(createCheckpoint(plan, unavailable(plan, snapshot, "denied").snapshot)),
  );
  // An unavailable camera always produced a warning and a null result.
  settled.snapshot.lastSettlement.warningEventSequence = null;
  assert.throws(() => restoreCheckpoint(settled));
});

test("a restored capture result must match its canonical settlement until the script consumes it", () => {
  const { plan, snapshot } = started("let photo = takePhoto()\nshowImage photo");
  const settled = unavailable(plan, snapshot, "denied").snapshot;
  assert.equal(settled.interactionResultHandoff?.result, null);
  const restored = JSON.parse(serializeCheckpoint(createCheckpoint(plan, settled)));
  const destination = restored.snapshot.interactionResultHandoff.destinationTemporary;
  const temporary = restored.snapshot.temporaries.find(
    (candidate: { id: number }) => candidate.id === destination,
  );
  temporary.value = "images/coast.svg";
  assert.throws(() => restoreCheckpoint(restored));
  // The consume clears the handoff, and execution shows nothing.
  const finished = run(plan, settled).snapshot;
  assert.equal(finished.interactionResultHandoff, null);
  assert.equal(finished.stageImage, null);
});

test("a capture reserves its events on top of what active actions still need", () => {
  const plan = compileValidPlan("timer async 1\nlet photo = takePhoto()");
  let snapshot = createFreshRuntimeSnapshot(plan);
  while (plan.instructions[snapshot.nextInstruction]?.kind !== "capture")
    snapshot = executeInstruction(plan, snapshot).snapshot;
  const crowded = structuredClone(snapshot);
  // The active timer still needs one completion event; the capture needs three more.
  crowded.nextEventSequence = Number.MAX_SAFE_INTEGER - 3;
  assert.equal(validateRuntimeSnapshot(crowded, plan).valid, true);
  const result = executeInstruction(plan, crowded);
  assert.notEqual(result.snapshot.foregroundAction?.kind, "capture");
  assert.equal(validateRuntimeSnapshot(result.snapshot, plan).valid, true);
});

test("an earlier pacing gate may settle after a capture before its result is consumed", () => {
  for (const answer of ["captured", "unavailable"] as const) {
    const { plan, snapshot } = started('say "hi"\nlet photo = takePhoto()\nshowImage photo');
    const gate = snapshot.backgroundActions.find((action) => action.kind === "chatPacingGate");
    assert.ok(gate !== undefined, "the message is still pacing in the background");
    const settled =
      answer === "captured"
        ? captured(plan, snapshot).snapshot
        : unavailable(plan, snapshot, "denied").snapshot;
    const skipped = completeAction(plan, settled, {
      actionId: gate.actionId,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    });
    assert.equal(skipped.outcome.kind, "completed", answer);
    assert.equal(validateRuntimeSnapshot(skipped.snapshot, plan).valid, true, answer);
    assert.deepEqual(
      restoreCheckpoint(createCheckpoint(plan, skipped.snapshot)).snapshot,
      skipped.snapshot,
    );
    const finished = run(plan, skipped.snapshot).snapshot;
    assert.equal(finished.stageImage, answer === "captured" ? PHOTO : null, answer);
  }
});
