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
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
} from "../src/runtime/state.js";

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

test("invalid runtime pacing fails without committing say evaluation effects", () => {
  const compiled = plan([
    'speaker vera { }',
    'say as vera "first"',
    "let pacing = -1",
    "say as vera random(), pacing",
  ].join("\n"));
  const result = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 77 }));

  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.rng.state, 77);
  assert.equal(result.snapshot.backgroundActions.length, 1);
  assert.equal(result.snapshot.backgroundActions[0]?.kind, "chatPacingGate");
  assert.deepEqual(result.events.map((event) => event.kind), [
    "developerWarning",
    "say",
    "actionRequested",
    "runtimeFailure",
  ]);
  assert.equal(result.events.filter((event) => event.kind === "say").length, 1);
  assert.equal(result.events.filter((event) => event.kind === "actionCompleted").length, 0);
  assert.equal(result.events.filter((event) => event.kind === "developerWarning").length, 1);

  const noWarning = plan([
    "speaker ada {}",
    "let pacing = -1",
    "say as ada random(), pacing",
  ].join("\n"));
  const noWarningResult = run(noWarning, createFreshRuntimeSnapshot(noWarning, { seed: 77 }));
  assert.equal(noWarningResult.snapshot.rng.state, 77);
  assert.deepEqual(noWarningResult.events.map((event) => event.kind), ["runtimeFailure"]);
});

test("unsupported and overflowing runtime pacing leave message evaluation uncommitted", () => {
  const unsupported = plan('say random(), 9007199254740991');
  const unsupportedResult = run(
    unsupported,
    createFreshRuntimeSnapshot(unsupported, { seed: 77 }),
  );
  assert.equal(unsupportedResult.snapshot.status, "failed");
  assert.equal(unsupportedResult.snapshot.rng.state, 77);
  assert.deepEqual(unsupportedResult.events.map((event) => event.kind), ["runtimeFailure"]);

  const nonFinite = plan('say random(), 1 / 0');
  const nonFiniteResult = run(
    nonFinite,
    createFreshRuntimeSnapshot(nonFinite, { seed: 77 }),
  );
  assert.equal(nonFiniteResult.snapshot.status, "failed");
  assert.equal(nonFiniteResult.snapshot.rng.state, 77);
  assert.deepEqual(nonFiniteResult.events.map((event) => event.kind), ["runtimeFailure"]);

  const overflow = plan('say random(), 1');
  const overflowResult = run(
    overflow,
    createFreshRuntimeSnapshot(overflow, {
      seed: 77,
      initialSessionTimeMs: Number.MAX_SAFE_INTEGER,
    }),
  );
  assert.equal(overflowResult.snapshot.status, "failed");
  assert.equal(overflowResult.snapshot.rng.state, 77);
  assert.deepEqual(overflowResult.events.map((event) => event.kind), ["runtimeFailure"]);
});

test("typed skip resolves an active background pacing gate without disturbing a foreground wait", () => {
  const standalone = plan('say "first"\nexit');
  const standaloneWaiting = run(standalone, createFreshRuntimeSnapshot(standalone));
  const standaloneGate = standaloneWaiting.snapshot.backgroundActions[0];
  assert.equal(standaloneGate?.kind, "chatPacingGate");
  const standaloneSkipped = completeAction(standalone, standaloneWaiting.snapshot, {
    actionId: standaloneGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(standaloneSkipped.outcome.kind, "completed");
  assert.equal(standaloneSkipped.snapshot.backgroundActions.length, 0);
  assert.equal(standaloneSkipped.events[0]?.kind, "actionCompleted");

  const withWait = plan('say "first"\nwait 1 s\nexit');
  const waiting = run(withWait, createFreshRuntimeSnapshot(withWait));
  const backgroundGate = waiting.snapshot.backgroundActions[0];
  assert.equal(waiting.snapshot.foregroundAction?.kind, "delay");
  assert.equal(backgroundGate?.kind, "chatPacingGate");
  const skipped = completeAction(withWait, waiting.snapshot, {
    actionId: backgroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(skipped.outcome.kind, "completed");
  assert.equal(skipped.snapshot.foregroundAction?.kind, "delay");
  assert.equal(skipped.snapshot.backgroundActions.length, 0);
  assert.equal(skipped.events.some((event) => event.kind === "playerTranscript"), false);
});

test("unskippable pacing rejects typed skips without mutating foreground or background state", () => {
  const foreground = plan('say unskippable "first"\nsay "second"');
  const foregroundWaiting = run(foreground, createFreshRuntimeSnapshot(foreground));
  const foregroundGate = foregroundWaiting.snapshot.foregroundAction;
  assert.equal(foregroundGate?.kind, "chatPacingGate");
  const foregroundRejected = completeAction(foreground, foregroundWaiting.snapshot, {
    actionId: foregroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(foregroundRejected.outcome.kind, "invalidPayload");
  assert.deepEqual(foregroundRejected.snapshot, foregroundWaiting.snapshot);

  const background = plan('say unskippable "first"\nexit');
  const backgroundActive = run(background, createFreshRuntimeSnapshot(background));
  const backgroundGate = backgroundActive.snapshot.backgroundActions[0];
  assert.equal(backgroundGate?.kind, "chatPacingGate");
  const backgroundRejected = completeAction(background, backgroundActive.snapshot, {
    actionId: backgroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(backgroundRejected.outcome.kind, "invalidPayload");
  assert.deepEqual(backgroundRejected.snapshot, backgroundActive.snapshot);
});

test("delay completion returns its own settlement when it also settles background pacing", () => {
  const compiled = plan('say "first"\nwait 1 s\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const delay = waiting.snapshot.foregroundAction;
  assert.equal(delay?.kind, "delay");

  const completed = completeAction(compiled, waiting.snapshot, {
    actionId: delay!.actionId,
    actionKind: "delay",
    payload: { kind: "time", currentSessionTimeMs: 2_000 },
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(completed.outcome.settlement.actionId, delay!.actionId);
  assert.deepEqual(completed.events.map((event) => event.kind), ["actionCompleted", "actionCompleted"]);
  assert.deepEqual(
    completed.events.map((event) => event.kind === "actionCompleted" ? event.settlement.actionId : null),
    [delay!.actionId, 1],
  );
  assert.equal(completed.snapshot.foregroundAction, null);
  assert.equal(completed.snapshot.backgroundActions.length, 0);
});

test("equal due pacing and delay actions settle by action ID", () => {
  const compiled = plan('say "first"\nwait 1.8 s\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const observed = observeTime(compiled, waiting.snapshot, 1_800);

  assert.deepEqual(
    observed.events.map((event) => event.kind === "actionCompleted" ? event.settlement.actionId : null),
    [1, 2],
  );
  assert.equal(observed.snapshot.foregroundAction, null);
  assert.equal(observed.snapshot.backgroundActions.length, 0);
});

test("foreground interaction consumes background pacing before its action request", () => {
  const compiled = plan('say "first"\nshowButton "Continue"');
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));

  assert.deepEqual(result.events.map((event) => event.kind), [
    "say",
    "actionRequested",
    "actionCompleted",
    "actionRequested",
  ]);
  assert.equal(
    result.events[2]?.kind === "actionCompleted"
      ? result.events[2].settlement.settlementKind
      : null,
    "consumedByForegroundInteraction",
  );
  assert.equal(result.snapshot.foregroundAction?.kind, "interaction");
  assert.equal(result.snapshot.backgroundActions.length, 0);
});

test("exact, zero, and instant pacing create only the required actions", () => {
  const exact = plan('say "first", 0.5\nexit');
  const exactResult = run(exact, createFreshRuntimeSnapshot(exact));
  assert.equal(exactResult.snapshot.backgroundActions[0]?.kind, "chatPacingGate");
  assert.equal(exactResult.snapshot.backgroundActions[0]?.deadlineMs, 500);

  const zero = plan('say "now", 0');
  const zeroResult = run(zero, createFreshRuntimeSnapshot(zero));
  assert.deepEqual(zeroResult.events.map((event) => event.kind), ["say", "complete"]);
  assert.equal(zeroResult.snapshot.nextActionId, 1);
  assert.equal(zeroResult.snapshot.lastSettlement, null);
});

test("prepared output is emitted exactly once after checkpoint JSON restore", () => {
  const compiled = plan('say ["first", "first-alt"]\nsay ["second", "second-alt"]');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 77 }));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.notEqual(gate?.preparedOutput, null);
  const preparedText = gate!.preparedOutput!.text;
  const preparedRng = waiting.snapshot.rng.state;
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)));
  const settled = completeAction(restored.plan, restored.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, settled.snapshot);
  assert.equal(resumed.events.filter((event) => event.kind === "say" && event.text === preparedText).length, 1);
  assert.equal(settled.snapshot.rng.state, preparedRng);
});

test("prepared pacing output has the same result with and without checkpoint restore", () => {
  const compiled = plan('say ["first", "first-alt"]\nsay ["second", "second-alt"]');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 77 }));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");

  const uninterruptedCompletion = completeAction(compiled, waiting.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const uninterrupted = run(compiled, uninterruptedCompletion.snapshot);

  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)));
  const resumedCompletion = completeAction(restored.plan, restored.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, resumedCompletion.snapshot);

  assert.deepEqual(
    [...resumedCompletion.events, ...resumed.events],
    [...uninterruptedCompletion.events, ...uninterrupted.events],
  );
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
});

test("snapshot and checkpoint reject malformed pacing prepared output", () => {
  const compiled = plan('speaker vera { displayName: "Vera" }\nsay as vera "first"\nsay as vera "second"');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const corrupted = JSON.parse(serializeCheckpoint(
    createCheckpoint(compiled, waiting.snapshot),
  )) as {
    snapshot: {
      foregroundAction: {
        preparedOutput: { speaker: Record<string, unknown>; durationMs: number };
      };
    };
  };
  corrupted.snapshot.foregroundAction.preparedOutput.speaker.extra = "unexpected";

  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));

  delete corrupted.snapshot.foregroundAction.preparedOutput.speaker.extra;
  corrupted.snapshot.foregroundAction.preparedOutput.durationMs = 0;
  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));

  corrupted.snapshot.foregroundAction.preparedOutput.durationMs = 1;
  (corrupted.snapshot.foregroundAction as unknown as { skippable: unknown }).skippable = "yes";
  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));
});
