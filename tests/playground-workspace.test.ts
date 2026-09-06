import assert from "node:assert/strict";
import test from "node:test";

import {
  compileWorkspaceSource,
  decodeWorkspaceSourceBytes,
  executeValidatedWorkspaceSnapshot,
  executeWorkspaceSource,
  activateWorkspaceButton,
  inspectWorkspacePlayerPresentation,
  observeWorkspaceTime,
  restoreWorkspaceCheckpoint,
  selectWorkspaceChoice,
  serializeWorkspaceCheckpoint,
  skipWorkspacePacing,
  submitWorkspaceComposer,
} from "../playground/workspace/controller.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import { MAX_INTERACTION_STRING_UTF8_BYTES } from "../src/interaction-limits.js";

test("workspace helper exposes production say pacing and returns JSON-safe data", () => {
  const compiled = compileWorkspaceSource('say "Hello"');
  assert.ok(compiled.plan);
  const result = executeWorkspaceSource('say "Hello"');
  assert.equal(result.status, "halted");
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["say", "actionRequested", "complete"],
  );
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("workspace helper reports parser and semantic diagnostics", () => {
  assert.equal(compileWorkspaceSource("let =").plan, null);
  assert.equal(compileWorkspaceSource("missing = 1").plan, null);
});

test("workspace compilation reuses the compiler-validated plan", () => {
  const statistics = withValidationTestStatistics((finish) => {
    assert.ok(
      compileWorkspaceSource(Array.from({ length: 100 }, () => 'say "Hello"').join("\n")).plan,
    );
    return finish();
  }).counts;

  assert.equal(
    statistics.externalCaptureVisits,
    1,
    "only the empty fresh-runtime options object is captured",
  );

  const executionStatistics = withValidationTestStatistics((finish) => {
    assert.equal(executeWorkspaceSource('say "Hello"').status, "halted");
    return finish();
  }).counts;
  assert.equal(executionStatistics.externalCaptureVisits, 1);
});

test("workspace helper stops blocking waits in waiting with action events", () => {
  const result = executeWorkspaceSource("wait 1");
  assert.equal(result.status, "waiting");
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["actionRequested"],
  );
});

test("validated workspace execution clones state without hostile-data recapture", () => {
  const compiled = compileWorkspaceSource('say "Hello"');
  assert.ok(compiled.plan);
  assert.ok(compiled.snapshot);
  const before = JSON.stringify(compiled.snapshot);
  const statistics = withValidationTestStatistics((finish) => {
    const result = executeValidatedWorkspaceSnapshot(compiled.plan!, compiled.snapshot!, "run");
    assert.equal(result.status, "halted");
    return finish();
  }).counts;

  assert.equal(JSON.stringify(compiled.snapshot), before);
  assert.equal(statistics.externalCaptureVisits, undefined);
});

test("workspace helper accepts source beyond the former local byte limit", () => {
  const source = `${"// padding\n".repeat(10_000)}say "large source"`;

  const result = compileWorkspaceSource(source);

  assert.ok(result.plan);
  assert.equal(result.status, "ready");
});

test("workspace helper is deterministic and returns runtime instruction-budget failures", () => {
  const source = "say random(1, 10)";
  assert.deepEqual(executeWorkspaceSource(source), executeWorkspaceSource(source));
  const result = executeWorkspaceSource("while true {} ");
  assert.equal(result.status, "failed");
  assert.ok(
    result.events.some((event) => event.kind === "runtimeFailure" && event.code === "TSR037"),
  );
});

test("workspace import decoding accepts large UTF-8 source and rejects malformed UTF-8", () => {
  const source = `say "${"🙂".repeat(20_000)}"`;
  assert.equal(decodeWorkspaceSourceBytes(new TextEncoder().encode(source).buffer), source);
  assert.throws(() => decodeWorkspaceSourceBytes(new Uint8Array([0xc3, 0x28]).buffer), TypeError);
});

test("workspace player controls delegate interaction families and preserve presentation", () => {
  const text = compileWorkspaceSource('let answer = askText "Answer"');
  assert.ok(text.plan && text.snapshot);
  const waiting = executeValidatedWorkspaceSnapshot(text.plan, text.snapshot, "run");
  assert.ok(waiting.snapshot);
  const waitingSnapshot = waiting.snapshot;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.snapshot.foregroundAction?.kind, "interaction");
  const before = JSON.stringify(waiting.snapshot);
  const completed = submitWorkspaceComposer(text.plan, waitingSnapshot, "hello");
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(completed.events[0]?.kind, "playerTranscript");
  assert.notEqual(JSON.stringify(completed.snapshot), before);
  assert.equal(Object.isFrozen(completed.presentation), true);

  const button = compileWorkspaceSource('showButton "Continue"');
  assert.ok(button.plan && button.snapshot);
  const buttonWaiting = executeValidatedWorkspaceSnapshot(button.plan, button.snapshot, "run");
  assert.ok(buttonWaiting.snapshot);
  const buttonDone = activateWorkspaceButton(button.plan, buttonWaiting.snapshot);
  assert.equal(buttonDone.outcome.kind, "completed");

  const choice = compileWorkspaceSource('let answer = choose first: "First", second: "Second"');
  assert.ok(choice.plan && choice.snapshot);
  const choiceWaiting = executeValidatedWorkspaceSnapshot(choice.plan, choice.snapshot, "run");
  assert.ok(choiceWaiting.snapshot);
  const choiceDone = selectWorkspaceChoice(choice.plan, choiceWaiting.snapshot, {
    kind: "label",
    value: "second",
  });
  assert.equal(choiceDone.outcome.kind, "completed");
});

test("workspace pacing and checkpoint controls are explicit and restore without time mutation", () => {
  const compiled = compileWorkspaceSource('say "paced"');
  assert.ok(compiled.plan && compiled.snapshot);
  const running = executeValidatedWorkspaceSnapshot(compiled.plan, compiled.snapshot, "run");
  assert.ok(running.snapshot);
  const runningSnapshot = running.snapshot;
  const before = JSON.stringify(runningSnapshot);
  const skipped = skipWorkspacePacing(compiled.plan, runningSnapshot);
  assert.equal(skipped.outcome.kind, "completed");
  const checkpoint = serializeWorkspaceCheckpoint(compiled.plan, runningSnapshot);
  const restored = restoreWorkspaceCheckpoint(checkpoint.outcome.json);
  assert.equal(restored.snapshot.currentSessionTimeMs, runningSnapshot.currentSessionTimeMs);
  assert.deepEqual(restored.snapshot.foregroundAction, runningSnapshot.foregroundAction);
  assert.equal(JSON.stringify(runningSnapshot), before);
  const observed = observeWorkspaceTime(compiled.plan, runningSnapshot, 1_000_000);
  assert.equal(observed.outcome.kind, "observed");
});

test("workspace control rejection clones unchanged state", () => {
  const compiled = compileWorkspaceSource('say "done"');
  assert.ok(compiled.plan && compiled.snapshot);
  const before = JSON.stringify(compiled.snapshot);
  const rejected = submitWorkspaceComposer(compiled.plan, compiled.snapshot, "ignored");
  assert.equal(rejected.outcome.kind, "localRejection");
  assert.equal(JSON.stringify(rejected.snapshot), before);
  assert.notEqual(rejected.snapshot, compiled.snapshot);
  assert.equal(inspectWorkspacePlayerPresentation(rejected.snapshot).activeInteraction, null);
});

test("workspace controls preserve number input and authored choice order", () => {
  const number = compileWorkspaceSource('let amount = askNumber "Amount"');
  assert.ok(number.plan && number.snapshot);
  const waiting = executeValidatedWorkspaceSnapshot(number.plan, number.snapshot, "run");
  assert.ok(waiting.snapshot);
  const before = JSON.stringify(waiting.snapshot);
  const completed = submitWorkspaceComposer(number.plan, waiting.snapshot, " 12.5 ");
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(JSON.stringify(waiting.snapshot), before);

  const choice = compileWorkspaceSource('let selected = choose "Alpha", "Beta"');
  assert.ok(choice.plan && choice.snapshot);
  const choiceWaiting = executeValidatedWorkspaceSnapshot(choice.plan, choice.snapshot, "run");
  assert.ok(choiceWaiting.snapshot);
  assert.deepEqual(
    inspectWorkspacePlayerPresentation(choiceWaiting.snapshot).activeInteraction?.ui,
    {
      kind: "choice",
      labelType: "none",
      options: [
        { label: null, text: "Alpha" },
        { label: null, text: "Beta" },
      ],
      accessibleName: { kind: "localizedDefault", key: "chooseOption" },
    },
  );
  const selected = selectWorkspaceChoice(choice.plan, choiceWaiting.snapshot, {
    kind: "text",
    value: "Beta",
  });
  assert.equal(selected.outcome.kind, "completed");
});

test("labelled composer text remains engine-owned and rejects ambiguous visible text", () => {
  const compiled = compileWorkspaceSource('let selected = choose first: "Same", second: "Same"');
  assert.ok(compiled.plan && compiled.snapshot);
  const waiting = executeValidatedWorkspaceSnapshot(compiled.plan, compiled.snapshot, "run");
  assert.ok(waiting.snapshot);
  const before = JSON.stringify(waiting.snapshot);
  const rejected = submitWorkspaceComposer(compiled.plan, waiting.snapshot, "Same");
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.deepEqual(rejected.events, []);
  assert.equal(JSON.stringify(rejected.snapshot), before);
  assert.equal(
    rejected.snapshot.foregroundAction?.actionId,
    waiting.snapshot.foregroundAction?.actionId,
  );
});

test("workspace controls preserve engine pacing and completion rejection outcomes", () => {
  const unskippable = compileWorkspaceSource('say unskippable "paced"');
  assert.ok(unskippable.plan && unskippable.snapshot);
  const waiting = executeValidatedWorkspaceSnapshot(unskippable.plan, unskippable.snapshot, "run");
  assert.ok(waiting.snapshot);
  const before = JSON.stringify(waiting.snapshot);
  const rejectedSkip = skipWorkspacePacing(unskippable.plan, waiting.snapshot);
  assert.equal(rejectedSkip.outcome.kind, "invalidPayload");
  assert.deepEqual(rejectedSkip.events, []);
  assert.equal(JSON.stringify(rejectedSkip.snapshot), before);

  const skippable = compileWorkspaceSource('say "paced"');
  assert.ok(skippable.plan && skippable.snapshot);
  const running = executeValidatedWorkspaceSnapshot(skippable.plan, skippable.snapshot, "run");
  assert.ok(running.snapshot);
  const completed = skipWorkspacePacing(skippable.plan, running.snapshot);
  const duplicate = skipWorkspacePacing(skippable.plan, completed.snapshot);
  assert.equal(duplicate.outcome.kind, "localRejection");
  assert.deepEqual(duplicate.events, []);
  assert.deepEqual(duplicate.snapshot, completed.snapshot);

  const text = compileWorkspaceSource("let answer = askText");
  assert.ok(text.plan && text.snapshot);
  const textWaiting = executeValidatedWorkspaceSnapshot(text.plan, text.snapshot, "run");
  assert.ok(textWaiting.snapshot);
  const oversized = submitWorkspaceComposer(
    text.plan,
    textWaiting.snapshot,
    "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1),
  );
  assert.equal(oversized.outcome.kind, "invalidPayload");
  assert.deepEqual(oversized.events, []);
  assert.equal(
    oversized.snapshot.foregroundAction?.actionId,
    textWaiting.snapshot.foregroundAction?.actionId,
  );
});
