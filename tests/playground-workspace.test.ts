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
  type WorkspaceControlResult,
} from "../playground/workspace/controller.js";
import { compileSource, type InstructionPlan, type RuntimeSnapshot } from "../src/index.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import { MAX_INTERACTION_STRING_UTF8_BYTES } from "../src/interaction-limits.js";

test("workspace helper exposes production say pacing and returns JSON-safe data", () => {
  const result = executeWorkspaceSource('say "Hello"');
  assert.equal(result.status, "halted");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  const [say, requested] = result.events;
  assert.equal(say?.kind === "say" ? say.text : null, "Hello");
  assert.equal(requested?.kind, "actionRequested");
  if (requested?.kind !== "actionRequested") return;
  assert.equal(requested.action.kind, "chatPacingGate");
  assert.ok(requested.action.deadlineMs > requested.action.createdAtMs, "smart pacing waits");
  assert.deepEqual(result.snapshot?.backgroundActions, [requested.action]);
});

test("workspace helper reports parser and semantic diagnostics", () => {
  for (const source of ["let =", "missing = 1"]) {
    const canonical = compileSource(source).diagnostics;
    assert.ok(canonical.length > 0, source);
    const result = compileWorkspaceSource(source);
    assert.equal(result.status, "compileError", source);
    assert.equal(result.plan, null, source);
    assert.equal(result.snapshot, null, source);
    assert.deepEqual(
      result.diagnostics.map(({ code, line, column, length }) => ({ code, line, column, length })),
      canonical.map((diagnostic) => ({
        code: diagnostic.code,
        line: diagnostic.span.start.line + 1,
        column: diagnostic.span.start.column + 1,
        length: diagnostic.span.end.offset - diagnostic.span.start.offset,
      })),
      source,
    );
  }
});

test("workspace compilation reuses the compiler-validated plan", () => {
  const small = 'say "Hello"';
  const large = Array.from({ length: 100 }, () => small).join("\n");
  for (const operation of [compileWorkspaceSource, executeWorkspaceSource]) {
    const smallWork = validationWork(() => assert.ok(operation(small).plan));
    const largeWork = validationWork(() => assert.ok(operation(large).plan));
    assert.equal(largeWork("instructionPlanCaptureCalls"), 0, operation.name);
    assert.equal(largeWork("runtimeSnapshotCaptureCalls"), 0, operation.name);
    assert.equal(
      largeWork("externalCaptureVisits"),
      smallWork("externalCaptureVisits"),
      `${operation.name} captures no plan-sized external data`,
    );
  }
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
  const work = validationWork(() => {
    const result = executeValidatedWorkspaceSnapshot(compiled.plan!, compiled.snapshot!, "run");
    assert.equal(result.status, "halted");
  });

  assert.equal(JSON.stringify(compiled.snapshot), before);
  assert.equal(work("instructionPlanCaptureCalls"), 0);
  assert.equal(work("runtimeSnapshotCaptureCalls"), 0);
  assert.equal(work("externalCaptureVisits"), 0);
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
  const text = waitingWorkspace('let answer = askText "Answer"\nsay answer, instant');
  assert.equal(text.snapshot.foregroundAction?.kind, "interaction");
  const before = JSON.stringify(text.snapshot);
  const presentation = inspectWorkspacePlayerPresentation(text.snapshot);
  const presentationBefore = JSON.stringify(presentation);
  assert.ok(presentation.activeInteraction);
  Reflect.set(presentation.activeInteraction, "actionId", -1);
  assert.equal(JSON.stringify(text.snapshot), before);
  assert.equal(
    JSON.stringify(inspectWorkspacePlayerPresentation(text.snapshot)),
    presentationBefore,
  );
  assertDelivered(
    text,
    (plan, snapshot) => submitWorkspaceComposer(plan, snapshot, "hello"),
    "hello",
    "hello",
  );
  assertDelivered(
    waitingWorkspace('showButton "Continue"\nsay "after", instant'),
    activateWorkspaceButton,
    "Continue",
    "after",
  );
  assertDelivered(
    waitingWorkspace('let answer = choose first: "First", second: "Second"\nsay answer, instant'),
    (plan, snapshot) => selectWorkspaceChoice(plan, snapshot, { kind: "label", value: "second" }),
    "Second",
    "second",
  );
});

test("workspace pacing and checkpoint controls are explicit and restore without time mutation", () => {
  const compiled = compileWorkspaceSource('say "paced"');
  assert.ok(compiled.plan && compiled.snapshot);
  const running = executeValidatedWorkspaceSnapshot(compiled.plan, compiled.snapshot, "run");
  assert.ok(running.snapshot);
  const runningSnapshot = running.snapshot;
  const gate = inspectWorkspacePlayerPresentation(runningSnapshot).pacingGate;
  assert.ok(gate);
  const before = JSON.stringify(runningSnapshot);

  const checkpoint = serializeWorkspaceCheckpoint(compiled.plan, runningSnapshot);
  const restored = restoreWorkspaceCheckpoint(checkpoint.outcome.json);
  assert.deepEqual(restored.outcome.plan, compiled.plan);
  assert.deepEqual(restored.snapshot, runningSnapshot);
  assert.deepEqual(restored.presentation, inspectWorkspacePlayerPresentation(runningSnapshot));

  const skipped = skipWorkspacePacing(compiled.plan, runningSnapshot);
  assert.equal(skipped.outcome.kind, "completed");
  assert.deepEqual(settlements(skipped), [{ actionId: gate.actionId, settlementKind: "skipped" }]);
  assert.equal(skipped.presentation.pacingGate, null);
  assert.equal(skipped.snapshot.currentSessionTimeMs, runningSnapshot.currentSessionTimeMs);

  const observed = observeWorkspaceTime(compiled.plan, runningSnapshot, 1_000_000);
  assert.deepEqual(observed.outcome, { kind: "observed", currentSessionTimeMs: 1_000_000 });
  assert.equal(observed.snapshot.currentSessionTimeMs, 1_000_000);
  assert.deepEqual(settlements(observed), [
    { actionId: gate.actionId, settlementKind: "completed" },
  ]);
  assert.equal(observed.presentation.pacingGate, null);
  assert.equal(JSON.stringify(runningSnapshot), before);
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
  assertDelivered(
    waitingWorkspace('let amount = askNumber "Amount"\nsay amount * 2, instant'),
    (plan, snapshot) => submitWorkspaceComposer(plan, snapshot, " 12.5 "),
    "12.5",
    "25",
  );

  const choice = waitingWorkspace('let selected = choose "Alpha", "Beta"\nsay selected, instant');
  const interaction = inspectWorkspacePlayerPresentation(choice.snapshot).activeInteraction;
  assert.equal(interaction?.interactionKind, "choice");
  assert.ok(interaction?.ui.kind === "choice");
  assert.deepEqual(
    interaction.ui.options.map(({ label, text }) => ({ label, text })),
    [
      { label: null, text: "Alpha" },
      { label: null, text: "Beta" },
    ],
  );
  assertDelivered(
    choice,
    (plan, snapshot) => selectWorkspaceChoice(plan, snapshot, { kind: "text", value: "Beta" }),
    "Beta",
    "Beta",
  );
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

  const text = waitingWorkspace("let answer = askText");
  const textBefore = JSON.stringify(text.snapshot);
  const oversized = submitWorkspaceComposer(
    text.plan,
    text.snapshot,
    "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1),
  );
  assert.equal(oversized.outcome.kind, "invalidPayload");
  assert.deepEqual(oversized.events, []);
  assert.deepEqual(oversized.snapshot, text.snapshot);
  assert.equal(JSON.stringify(text.snapshot), textBefore);
});

/** Returns a reader for validation work counters; an unrecorded counter means no work. */
function validationWork(operation: () => void): (counter: string) => number {
  const counts = withValidationTestStatistics((finish) => {
    operation();
    return finish();
  }).counts;
  return (counter) => counts[counter] ?? 0;
}

interface WaitingWorkspace {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
}

function waitingWorkspace(source: string): WaitingWorkspace {
  const compiled = compileWorkspaceSource(source);
  assert.ok(compiled.plan && compiled.snapshot, source);
  const waiting = executeValidatedWorkspaceSnapshot(compiled.plan, compiled.snapshot, "run");
  assert.equal(waiting.status, "waiting", source);
  assert.ok(waiting.snapshot, source);
  return { plan: compiled.plan, snapshot: waiting.snapshot };
}

/** Asserts the control leaves its input untouched and the script resumes with the delivered value. */
function assertDelivered(
  waiting: WaitingWorkspace,
  control: (plan: InstructionPlan, snapshot: RuntimeSnapshot) => WorkspaceControlResult,
  transcriptText: string,
  resumedSay: string,
): void {
  const before = JSON.stringify(waiting.snapshot);
  const completed = control(waiting.plan, waiting.snapshot);
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(
    completed.events.flatMap((event) => (event.kind === "playerTranscript" ? [event.text] : [])),
    [transcriptText],
  );
  const resumed = executeValidatedWorkspaceSnapshot(waiting.plan, completed.snapshot, "run");
  assert.equal(resumed.status, "halted");
  assert.deepEqual(
    resumed.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    [resumedSay],
  );
  assert.equal(JSON.stringify(waiting.snapshot), before);
}

function settlements(result: WorkspaceControlResult) {
  return result.events.flatMap((event) =>
    event.kind === "actionCompleted"
      ? [{ actionId: event.settlement.actionId, settlementKind: event.settlement.settlementKind }]
      : [],
  );
}
