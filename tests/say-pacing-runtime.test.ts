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
import { executeInstruction } from "../src/runtime/engine.js";

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

test("say lowering preserves contextual skip words as value identifiers", () => {
  const compiled = plan([
    'let skippable = "one"',
    'let unskippable = "two"',
    "say skippable",
    "say unskippable",
    "say skippable, instant",
  ].join("\n"));
  const says = compiled.instructions.filter(
    (instruction): instruction is Extract<typeof instruction, { kind: "say" }> => instruction.kind === "say",
  );

  assert.deepEqual(says.map((instruction) => [instruction.skipPolicy, instruction.value.kind, instruction.pacing]), [
    [null, "identifier", "smart"],
    [null, "identifier", "smart"],
    [null, "identifier", "instant"],
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

test("background pacing survives scope, loop, and call unwinding through checkpoint restore", () => {
  const scenarios = [
    'if true { say "branch" }\nexit',
    'repeat 1 { say "loop" }\nexit',
    'function f { say "call" }\nf()\nexit',
  ];

  for (const source of scenarios) {
    const compiled = plan(source);
    const completed = run(compiled, createFreshRuntimeSnapshot(compiled));
    const gate = completed.snapshot.backgroundActions[0];
    assert.equal(gate?.kind, "chatPacingGate", source);
    assert.equal(validateRuntimeSnapshot(completed.snapshot, compiled).valid, true, source);

    const restored = deserializeCheckpoint(serializeCheckpoint(
      createCheckpoint(compiled, completed.snapshot),
    ));
    assert.deepEqual(restored.snapshot, completed.snapshot, source);

    const settled = completeAction(restored.plan, restored.snapshot, {
      actionId: gate!.actionId,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    });
    assert.equal(settled.outcome.kind, "completed", source);
  }
});

test("a pacing gate created by a returned function promotes and resumes later output", () => {
  const compiled = plan('function f { say "first" }\nf()\nsay ["second", "second-alt"]');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 77 }));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const preparedText = gate?.preparedOutput?.text;
  assert.equal(typeof preparedText, "string");
  assert.equal(validateRuntimeSnapshot(waiting.snapshot, compiled).valid, true);

  const restored = deserializeCheckpoint(serializeCheckpoint(
    createCheckpoint(compiled, waiting.snapshot),
  ));
  const settled = observeTime(restored.plan, restored.snapshot, gate!.deadlineMs);
  const resumed = run(restored.plan, settled.snapshot);
  assert.deepEqual(
    resumed.events.filter((event) => event.kind === "say").map((event) => event.text),
    [preparedText],
  );
});

test("positive pacing control-flow paths have equivalent uninterrupted and restored results", () => {
  const scenarios = [
    'if true { say "branch" }\nsay "after"',
    'repeat 1 { say "loop" }\nsay "after"',
    'function f { say "call" }\nf()\nsay "after"',
    'function f(count) { if count == 0 { say "recursive" } else { f(count - 1) } }\nf(1)\nsay "after"',
  ];

  for (const source of scenarios) {
    const compiled = plan(source);
    const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
    const gate = waiting.snapshot.foregroundAction;
    assert.equal(gate?.kind, "chatPacingGate", source);

    const uninterruptedSettled = observeTime(compiled, waiting.snapshot, gate!.deadlineMs);
    const uninterrupted = run(compiled, uninterruptedSettled.snapshot);
    const restored = deserializeCheckpoint(serializeCheckpoint(
      createCheckpoint(compiled, waiting.snapshot),
    ));
    const restoredSettled = observeTime(restored.plan, restored.snapshot, gate!.deadlineMs);
    const resumed = run(restored.plan, restoredSettled.snapshot);

    assert.deepEqual(
      [...restoredSettled.events, ...resumed.events],
      [...uninterruptedSettled.events, ...uninterrupted.events],
      source,
    );
    assert.deepEqual(resumed.snapshot, uninterrupted.snapshot, source);
  }
});

test("pacing creation provenance rejects an impossible function owner", () => {
  const compiled = plan('function f { say "first" }\nf()\nexit');
  const completed = run(compiled, createFreshRuntimeSnapshot(compiled));
  const corrupted = JSON.parse(serializeCheckpoint(
    createCheckpoint(compiled, completed.snapshot),
  )) as { snapshot: { backgroundActions: Array<{ ownerCallFrameId: number | null }> } };
  corrupted.snapshot.backgroundActions[0]!.ownerCallFrameId = null;

  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));
});

test("speaker default and explicit skip policy determine pacing gate skippability", () => {
  const compiled = plan('speaker vera { defaultSaySkippable: false }\nsay as vera "one"\nsay skippable "two"');
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(result.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(result.snapshot.foregroundAction?.skippable, false);
});

test("smart pacing uses the final visible text and captured settings", () => {
  const cases = [
    { source: 'let name = "Ada"\nsay `Hi ${name}`', options: {}, text: "Hi Ada", deadlineMs: 2_100 },
    { source: 'say ["short", "selected text"]', options: { seed: 77 }, text: "short", deadlineMs: 1_800 },
    { source: 'say "😀"', options: {}, text: "😀", deadlineMs: 1_800 },
    { source: 'say "one\\ttwo\\nthree"', options: {}, text: "one\ttwo\nthree", deadlineMs: 2_400 },
    {
      source: 'say "hello 😀"',
      options: { baseDelayMs: 7, delayPerWordMs: 11, delayPerCharacterMs: 13 },
      text: "hello 😀",
      deadlineMs: 98,
    },
  ];

  for (const scenario of cases) {
    const compiled = plan(scenario.source);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled, scenario.options));
    const gate = result.snapshot.backgroundActions[0];
    assert.equal(gate?.kind, "chatPacingGate", scenario.source);
    assert.equal(gate?.deadlineMs, scenario.deadlineMs, scenario.source);
    assert.equal(result.events.find((event) => event.kind === "say")?.kind === "say" ? result.events.find((event) => event.kind === "say")?.text : null, scenario.text, scenario.source);
  }

  const zero = plan('say "no gate"');
  const immediate = run(zero, createFreshRuntimeSnapshot(zero, {
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  }));
  assert.deepEqual(immediate.events.map((event) => event.kind), ["say", "complete"]);
  assert.equal(immediate.snapshot.nextActionId, 1);
  assert.equal(immediate.snapshot.lastSettlement, null);
});

test("say skip policy follows explicit, speaker, and fallback precedence", () => {
  const cases = [
    ['speaker vera { defaultSaySkippable: false }\nsay skippable "text"', true],
    ['speaker vera { defaultSaySkippable: true }\nsay unskippable "text"', false],
    ['speaker vera { defaultSaySkippable: false }\nsay as vera "text"', false],
    ['speaker vera { defaultSaySkippable: true }\nsay as vera "text"', true],
    ['say "text"', true],
  ] as const;
  for (const [source, expected] of cases) {
    const compiled = plan(source);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled));
    const gate = result.snapshot.backgroundActions[0];
    assert.equal(gate?.kind, "chatPacingGate", source);
    if (gate?.kind === "chatPacingGate") {
      assert.equal(gate.skippable, expected, source);
    }
  }

  const promotedPlan = plan([
    'speaker vera { defaultSaySkippable: false }',
    'say as vera "first"',
    'say as vera skippable "second"',
  ].join("\n"));
  const waiting = run(promotedPlan, createFreshRuntimeSnapshot(promotedPlan));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate?.skippable, false);
  assert.equal(gate?.preparedOutput?.skippable, true);
  const settled = observeTime(promotedPlan, waiting.snapshot, gate!.deadlineMs);
  const resumed = run(promotedPlan, settled.snapshot);
  const replacement = resumed.snapshot.backgroundActions[0];
  assert.equal(replacement?.kind, "chatPacingGate");
  if (replacement?.kind === "chatPacingGate") assert.equal(replacement.skippable, true);

  const invalid = plan('speaker vera { defaultSaySkippable: random() }');
  const rejected = run(invalid, createFreshRuntimeSnapshot(invalid, { seed: 77 }));
  assert.equal(rejected.snapshot.status, "failed");
  assert.equal(rejected.snapshot.speakers.length, 0);
  assert.equal(rejected.snapshot.frames[0]?.bindings.length, 0);
  assert.equal(rejected.snapshot.rng.state, 77);
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

test("a background pacing gate restores before promotion and preserves prepared output equivalence", () => {
  const compiled = plan('say ["first", "first-alt"]\nsay ["second", "second-alt"]');
  const initial = createFreshRuntimeSnapshot(compiled, { seed: 77 });
  const first = executeInstruction(compiled, initial);
  const originalGate = first.snapshot.backgroundActions[0];
  assert.equal(originalGate?.kind, "chatPacingGate");
  assert.equal(first.snapshot.status, "running");

  const uninterruptedWaiting = run(compiled, first.snapshot);
  const uninterruptedGate = uninterruptedWaiting.snapshot.foregroundAction;
  assert.equal(uninterruptedGate?.kind, "chatPacingGate");

  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, first.snapshot)));
  const restoredWaiting = run(restored.plan, restored.snapshot);
  const restoredGate = restoredWaiting.snapshot.foregroundAction;
  assert.equal(restoredGate?.kind, "chatPacingGate");
  assert.equal(restoredGate?.actionId, originalGate?.actionId);
  assert.equal(restoredGate?.deadlineMs, originalGate?.deadlineMs);
  assert.equal(restoredWaiting.events.some((event) => event.kind === "actionRequested"), false);
  assert.deepEqual(restoredWaiting.snapshot, uninterruptedWaiting.snapshot);

  const uninterruptedSettled = completeAction(compiled, uninterruptedWaiting.snapshot, {
    actionId: uninterruptedGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const uninterrupted = run(compiled, uninterruptedSettled.snapshot);
  const restoredSettled = completeAction(restored.plan, restoredWaiting.snapshot, {
    actionId: restoredGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, restoredSettled.snapshot);
  assert.deepEqual(
    [...restoredSettled.events, ...resumed.events],
    [...uninterruptedSettled.events, ...uninterrupted.events],
  );
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
});

test("pacing completion preserves active-first, replay, stale, unknown, and wrong-kind outcomes", () => {
  const compiled = plan('say "first"\nwait 10 s\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const delay = waiting.snapshot.foregroundAction;
  const background = waiting.snapshot.backgroundActions[0];
  assert.equal(delay?.kind, "delay");
  assert.equal(background?.kind, "chatPacingGate");

  const wrongKind = completeAction(compiled, waiting.snapshot, {
    actionId: delay!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(wrongKind.outcome.kind, "wrongActionKind");
  assert.deepEqual(wrongKind.snapshot, waiting.snapshot);

  const skipped = completeAction(compiled, waiting.snapshot, {
    actionId: background!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(skipped.outcome.kind, "completed");
  assert.equal(skipped.snapshot.foregroundAction?.kind, "delay");
  assert.equal(skipped.events.some((event) => event.kind === "playerTranscript"), false);

  const duplicate = completeAction(compiled, skipped.snapshot, {
    actionId: background!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  assert.deepEqual(duplicate.events, []);

  const newer = observeTime(compiled, skipped.snapshot, 10_000);
  const stale = completeAction(compiled, newer.snapshot, {
    actionId: background!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.deepEqual(stale.outcome, { kind: "staleAction", actionId: background!.actionId });
  const unknown = completeAction(compiled, newer.snapshot, {
    actionId: 99,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.deepEqual(unknown.outcome, { kind: "unknownAction", actionId: 99 });
});

test("pacing capacity and action-ID failures do not partially commit transitions", () => {
  const max = Number.MAX_SAFE_INTEGER;

  const initialPlan = plan("say random()");
  const initial = createFreshRuntimeSnapshot(initialPlan, { seed: 77 });
  initial.nextEventSequence = max - 1;
  const initialFailure = run(initialPlan, initial);
  assert.equal(initialFailure.snapshot.status, "failed");
  assert.equal(initialFailure.snapshot.rng.state, 77);
  assert.equal(initialFailure.snapshot.backgroundActions.length, 0);
  assert.equal(initialFailure.snapshot.nextActionId, 1);
  assert.deepEqual(initialFailure.events.map((event) => event.kind), ["runtimeFailure"]);

  const supersedePlan = plan('say "first"\nsay "now", instant');
  const afterFirst = executeInstruction(
    supersedePlan,
    createFreshRuntimeSnapshot(supersedePlan),
  );
  const supersedeInput = structuredClone(afterFirst.snapshot);
  supersedeInput.nextEventSequence = max - 1;
  const supersedeFailure = executeInstruction(supersedePlan, supersedeInput);
  assert.equal(supersedeFailure.snapshot.status, "failed");
  assert.equal(supersedeFailure.snapshot.backgroundActions.length, 1);
  assert.equal(supersedeFailure.snapshot.lastSettlement, null);
  assert.equal(supersedeFailure.events.filter((event) => event.kind === "say").length, 0);

  const interactionPlan = plan('say "first"\nshowButton "Continue"');
  const beforeInteraction = executeInstruction(
    interactionPlan,
    createFreshRuntimeSnapshot(interactionPlan),
  );
  const interactionInput = structuredClone(beforeInteraction.snapshot);
  interactionInput.nextEventSequence = max - 3;
  const interactionFailure = executeInstruction(interactionPlan, interactionInput);
  assert.equal(interactionFailure.snapshot.status, "failed");
  assert.equal(interactionFailure.snapshot.backgroundActions.length, 1);
  assert.equal(interactionFailure.snapshot.foregroundAction, null);
  assert.equal(interactionFailure.snapshot.lastSettlement, null);

  const promotedPlan = plan('say "first"\nsay "second"');
  const promotedWaiting = run(promotedPlan, createFreshRuntimeSnapshot(promotedPlan));
  const promotedGate = promotedWaiting.snapshot.foregroundAction;
  assert.equal(promotedGate?.kind, "chatPacingGate");
  const promotedInput = structuredClone(promotedWaiting.snapshot);
  promotedInput.nextEventSequence = max - 2;
  const promotedSettled = completeAction(promotedPlan, promotedInput, {
    actionId: promotedGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const preparedFailure = run(promotedPlan, promotedSettled.snapshot);
  assert.equal(preparedFailure.snapshot.status, "failed");
  assert.equal(preparedFailure.snapshot.preparedSayOutput?.text, "second");
  assert.equal(preparedFailure.snapshot.backgroundActions.length, 0);
  assert.equal(preparedFailure.events.some((event) => event.kind === "say"), false);

  const exhaustedId = createFreshRuntimeSnapshot(initialPlan, { seed: 77 });
  exhaustedId.nextActionId = max;
  const idFailure = run(initialPlan, exhaustedId);
  assert.equal(idFailure.snapshot.status, "failed");
  assert.equal(idFailure.snapshot.rng.state, 77);
  assert.equal(idFailure.snapshot.backgroundActions.length, 0);
  assert.equal(idFailure.snapshot.nextActionId, max);
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

test("snapshot and checkpoint reject representative malformed pacing action state", () => {
  const backgroundPlan = plan('say "first"\nexit');
  const background = run(backgroundPlan, createFreshRuntimeSnapshot(backgroundPlan));
  const foregroundPlan = plan('say "first"\nsay "second"');
  const foreground = run(foregroundPlan, createFreshRuntimeSnapshot(foregroundPlan));
  const foregroundGate = foreground.snapshot.foregroundAction;
  assert.equal(foregroundGate?.kind, "chatPacingGate");
  if (foregroundGate?.kind !== "chatPacingGate") throw new Error("Expected a promoted pacing gate.");
  const functionPlan = plan('function f { say "first" }\nf()\nexit');
  const functionBackground = run(functionPlan, createFreshRuntimeSnapshot(functionPlan));
  const settled = completeAction(backgroundPlan, background.snapshot, {
    actionId: 1,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const corruptions: Array<[string, unknown, typeof backgroundPlan | typeof foregroundPlan]> = [
    ["action identity", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].actionId = 0; }), backgroundPlan],
    ["action kind", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].kind = "delay"; }), backgroundPlan],
    ["deadline", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].deadlineMs = 0; }), backgroundPlan],
    ["request sequence", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].requestEventSequence = snapshot.nextEventSequence; }), backgroundPlan],
    ["background uniqueness", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions.push(structuredClone(snapshot.backgroundActions[0])); }), backgroundPlan],
    ["foreground/background location", mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => { snapshot.backgroundActions.push(structuredClone(snapshot.foregroundAction)); }), foregroundPlan],
    ["background prepared output", mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => { snapshot.backgroundActions[0].preparedOutput = structuredClone(foregroundGate.preparedOutput); }), backgroundPlan],
    ["foreground prepared output ownership", mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => { snapshot.foregroundAction.preparedOutput = null; }), foregroundPlan],
    ["waiting status ownership", mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => { snapshot.status = "running"; }), foregroundPlan],
    ["prepared continuation", mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => { snapshot.foregroundAction.preparedOutput.continuationInstruction += 1; }), foregroundPlan],
    ["pacing settlement", mutateCheckpoint(backgroundPlan, settled.snapshot, (snapshot) => { snapshot.lastSettlement.actionKind = "delay"; }), backgroundPlan],
    ["settlement completed time", mutateCheckpoint(backgroundPlan, settled.snapshot, (snapshot) => { snapshot.lastSettlement.completedAtMs = snapshot.currentSessionTimeMs + 1; }), backgroundPlan],
    ["unwound function provenance", mutateCheckpoint(functionPlan, functionBackground.snapshot, (snapshot) => { snapshot.backgroundActions[0].ownerCallFrameId = snapshot.nextCallFrameId; }), functionPlan],
  ];

  for (const [label, checkpoint, compiled] of corruptions) {
    const snapshot = (checkpoint as { snapshot: unknown }).snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, false, label);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), label);
  }
});

function mutateCheckpoint(
  compiled: ReturnType<typeof plan>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
  mutate: (snapshot: any) => void,
): unknown {
  const checkpoint = JSON.parse(serializeCheckpoint(createCheckpoint(compiled, snapshot))) as { snapshot: any };
  mutate(checkpoint.snapshot);
  return checkpoint;
}
