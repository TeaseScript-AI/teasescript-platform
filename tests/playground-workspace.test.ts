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
import {
  compileSource,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
} from "../src/index.js";
import { MAX_INTERACTION_STRING_UTF8_BYTES } from "../src/interaction-limits.js";

test("workspace helper exposes production say pacing and returns JSON-safe data", () => {
  const compiled = compileWorkspaceSource('say "Hello"\nexit');
  assert.ok(compiled.plan);
  const result = executeWorkspaceSource('say "Hello"\nexit');
  assert.equal(result.status, "halted");
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["say", "actionRequested", "exit"],
  );
  const [say, requested] = result.events;
  assert.equal(say?.kind === "say" ? say.text : null, "Hello");
  // Default `say` pacing is smart (not instant) and skippable unless a modifier or speaker says otherwise.
  const pacing = requested?.kind === "actionRequested" ? requested.action : null;
  assert.ok(pacing?.kind === "chatPacingGate");
  assert.equal(pacing.skippable, true);
  assert.ok(pacing.deadlineMs > pacing.createdAtMs);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("workspace helper reports parser and semantic diagnostics", () => {
  for (const source of ["let =", "missing = 1"]) {
    const result = compileWorkspaceSource(source);
    assert.equal(result.status, "compileError", source);
    assert.equal(result.plan, null);
    assert.equal(result.snapshot, null);
    // Workspace diagnostics are the canonical diagnostics with one-based line/column locations.
    const canonical = compileSource(source).diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      line: diagnostic.span.start.line + 1,
      column: diagnostic.span.start.column + 1,
      length: diagnostic.span.end.offset - diagnostic.span.start.offset,
    }));
    assert.notEqual(canonical.length, 0, source);
    assert.deepEqual(
      result.diagnostics.map(({ code, line, column, length }) => ({ code, line, column, length })),
      canonical,
    );
  }
});

test("workspace helper stops blocking waits in waiting with action events", () => {
  const result = executeWorkspaceSource("wait 1 s\nexit");
  assert.equal(result.status, "waiting");
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["actionRequested"],
  );
});

test("validated workspace execution does not mutate the caller snapshot", () => {
  const compiled = compileWorkspaceSource('say "Hello"\nexit');
  assert.ok(compiled.plan);
  assert.ok(compiled.snapshot);
  const before = JSON.stringify(compiled.snapshot);
  const result = executeValidatedWorkspaceSnapshot(compiled.plan, compiled.snapshot, "run");

  assert.equal(result.status, "halted");
  assert.equal(JSON.stringify(compiled.snapshot), before);
});

test("workspace helper accepts source beyond the former local byte limit", () => {
  const source = `${"// padding\n".repeat(10_000)}say "large source"\nexit`;

  const result = compileWorkspaceSource(source);

  assert.ok(result.plan);
  assert.equal(result.status, "ready");
});

test("workspace helper is deterministic and returns runtime instruction-budget failures", () => {
  const source = "say random(1, 10)\nexit";
  assert.deepEqual(executeWorkspaceSource(source), executeWorkspaceSource(source));
  // The exit is never taken; a script needs a reachable one.
  const result = executeWorkspaceSource("let stop = false\nwhile true {\n  if stop { exit }\n}");
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
  const text = compileWorkspaceSource('let answer = askText "Answer"\nsay answer, instant\nexit');
  assert.ok(text.plan && text.snapshot);
  const waiting = executeValidatedWorkspaceSnapshot(text.plan, text.snapshot, "run");
  assert.ok(waiting.snapshot);
  const waitingSnapshot = waiting.snapshot;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.snapshot.foregroundAction?.kind, "interaction");
  const before = JSON.stringify(waiting.snapshot);
  const presentation = inspectWorkspacePlayerPresentation(waitingSnapshot);
  const presentationBefore = JSON.stringify(presentation);
  assert.ok(presentation.activeInteraction);
  Reflect.set(presentation.activeInteraction, "actionId", -1);
  Reflect.set(presentation.activeInteraction.ui, "kind", "edited");
  assert.equal(JSON.stringify(waitingSnapshot), before);
  assert.equal(
    JSON.stringify(inspectWorkspacePlayerPresentation(waitingSnapshot)),
    presentationBefore,
  );
  const completed = submitWorkspaceComposer(text.plan, waitingSnapshot, "hello");
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(completed.events[0]?.kind, "playerTranscript");
  assert.deepEqual(transcriptTexts(completed.events), ["hello"]);
  assert.notEqual(JSON.stringify(completed.snapshot), before);
  assert.equal(JSON.stringify(waitingSnapshot), before);
  assert.deepEqual(resumedSayTexts(text.plan, completed.snapshot), ["hello"]);

  const button = compileWorkspaceSource('showButton "Continue"\nexit');
  assert.ok(button.plan && button.snapshot);
  const buttonWaiting = executeValidatedWorkspaceSnapshot(button.plan, button.snapshot, "run");
  assert.ok(buttonWaiting.snapshot);
  const buttonDone = activateWorkspaceButton(
    button.plan,
    buttonWaiting.snapshot,
    buttonWaiting.snapshot.foregroundAction!.actionId,
  );
  assert.equal(buttonDone.outcome.kind, "completed");

  const choice = compileWorkspaceSource(
    'let answer = choose first: "First", second: "Second"\nsay answer, instant\nexit',
  );
  assert.ok(choice.plan && choice.snapshot);
  const choiceWaiting = executeValidatedWorkspaceSnapshot(choice.plan, choice.snapshot, "run");
  assert.ok(choiceWaiting.snapshot);
  const choiceBefore = JSON.stringify(choiceWaiting.snapshot);
  const choiceDone = selectWorkspaceChoice(
    choice.plan,
    choiceWaiting.snapshot,
    choiceWaiting.snapshot.foregroundAction!.actionId,
    1,
  );
  assert.equal(choiceDone.outcome.kind, "completed");
  assert.equal(JSON.stringify(choiceWaiting.snapshot), choiceBefore);
  // A choice with written values returns the value; the transcript shows the selected option's visible text.
  assert.deepEqual(transcriptTexts(choiceDone.events), ["Second"]);
  assert.deepEqual(resumedSayTexts(choice.plan, choiceDone.snapshot), ["second"]);
});

test("a control rendered for an earlier interaction cannot answer a later one", () => {
  const workspace = compileWorkspaceSource(
    'let a = choose oldA: "Old A", oldB: "Old B"\nlet b = choose newA: "New A", newB: "New B"\nshowButton "Go"\nshowButton "Again"\nexit',
  );
  assert.ok(workspace.plan && workspace.snapshot);
  const plan = workspace.plan;
  const runOn = (snapshot: RuntimeSnapshot) => {
    const next = executeValidatedWorkspaceSnapshot(plan, snapshot, "run").snapshot;
    assert.ok(next);
    return next;
  };
  const firstChoice = runOn(workspace.snapshot);
  const oldChoice = firstChoice.foregroundAction!.actionId;
  const secondChoice = runOn(selectWorkspaceChoice(plan, firstChoice, oldChoice, 1).snapshot);
  const stale = selectWorkspaceChoice(plan, secondChoice, oldChoice, 0);
  assert.equal(stale.outcome.kind, "localRejection");
  assert.deepEqual(stale.snapshot, secondChoice);
  assert.deepEqual(stale.events, []);

  const firstButton = runOn(
    selectWorkspaceChoice(plan, secondChoice, secondChoice.foregroundAction!.actionId, 0).snapshot,
  );
  const oldButton = firstButton.foregroundAction!.actionId;
  const secondButton = runOn(activateWorkspaceButton(plan, firstButton, oldButton).snapshot);
  const staleButton = activateWorkspaceButton(plan, secondButton, oldButton);
  assert.equal(staleButton.outcome.kind, "localRejection");
  assert.deepEqual(staleButton.snapshot, secondButton);
});

test("workspace pacing and checkpoint controls are explicit and restore without time mutation", () => {
  // The long wait keeps the session running while the message's pacing gate is in the background.
  const compiled = compileWorkspaceSource('say "paced"\nwait 2000 s\nexit');
  assert.ok(compiled.plan && compiled.snapshot);
  const running = executeValidatedWorkspaceSnapshot(compiled.plan, compiled.snapshot, "run");
  assert.ok(running.snapshot);
  const runningSnapshot = running.snapshot;
  const before = JSON.stringify(runningSnapshot);
  const presentation = inspectWorkspacePlayerPresentation(runningSnapshot);
  const gate = presentation.pacingGate;
  assert.ok(gate);
  const skipped = skipWorkspacePacing(compiled.plan, runningSnapshot);
  assert.equal(skipped.outcome.kind, "completed");
  assert.deepEqual(settledActionIds(skipped.events), [gate.actionId]);
  assert.equal(skipped.presentation.pacingGate, null);
  const checkpoint = serializeWorkspaceCheckpoint(compiled.plan, runningSnapshot);
  const restored = restoreWorkspaceCheckpoint(checkpoint.outcome.json);
  assert.deepEqual(restored.outcome.plan, compiled.plan);
  assert.deepEqual(restored.snapshot, runningSnapshot);
  assert.deepEqual(restored.presentation, presentation);
  assert.equal(JSON.stringify(runningSnapshot), before);
  assert.ok(gate.deadlineMs <= 1_000_000);
  const observed = observeWorkspaceTime(compiled.plan, runningSnapshot, 1_000_000);
  assert.equal(observed.outcome.kind, "observed");
  assert.equal(observed.snapshot.currentSessionTimeMs, 1_000_000);
  assert.deepEqual(settledActionIds(observed.events), [gate.actionId]);
  assert.equal(observed.presentation.pacingGate, null);
  assert.equal(JSON.stringify(runningSnapshot), before);
});

test("workspace control rejection clones unchanged state", () => {
  const compiled = compileWorkspaceSource('say "done"\nexit');
  assert.ok(compiled.plan && compiled.snapshot);
  const before = JSON.stringify(compiled.snapshot);
  const rejected = submitWorkspaceComposer(compiled.plan, compiled.snapshot, "ignored");
  assert.equal(rejected.outcome.kind, "localRejection");
  assert.equal(JSON.stringify(rejected.snapshot), before);
  assert.notEqual(rejected.snapshot, compiled.snapshot);
  assert.equal(inspectWorkspacePlayerPresentation(rejected.snapshot).activeInteraction, null);
});

test("workspace controls preserve number input and authored choice order", () => {
  const number = compileWorkspaceSource(
    'let amount = askNumber "Amount"\nsay amount, instant\nexit',
  );
  assert.ok(number.plan && number.snapshot);
  const waiting = executeValidatedWorkspaceSnapshot(number.plan, number.snapshot, "run");
  assert.ok(waiting.snapshot);
  const before = JSON.stringify(waiting.snapshot);
  const completed = submitWorkspaceComposer(number.plan, waiting.snapshot, " 12.5 ");
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(JSON.stringify(waiting.snapshot), before);
  // The transcript keeps the trimmed submitted text; the script receives the number 12.5.
  assert.deepEqual(transcriptTexts(completed.events), ["12.5"]);
  assert.deepEqual(resumedSayTexts(number.plan, completed.snapshot), ["12.5"]);

  const choice = compileWorkspaceSource(
    'let selected = choose "Alpha", "Beta"\nsay selected, instant\nexit',
  );
  assert.ok(choice.plan && choice.snapshot);
  const choiceWaiting = executeValidatedWorkspaceSnapshot(choice.plan, choice.snapshot, "run");
  assert.ok(choiceWaiting.snapshot);
  const choiceBefore = JSON.stringify(choiceWaiting.snapshot);
  const ui = inspectWorkspacePlayerPresentation(choiceWaiting.snapshot).activeInteraction?.ui;
  assert.equal(ui?.kind, "choice");
  assert.deepEqual(
    ui.options.map((option) => option.text),
    ["Alpha", "Beta"],
  );
  const selected = selectWorkspaceChoice(
    choice.plan,
    choiceWaiting.snapshot,
    choiceWaiting.snapshot.foregroundAction!.actionId,
    1,
  );
  assert.equal(selected.outcome.kind, "completed");
  assert.equal(JSON.stringify(choiceWaiting.snapshot), choiceBefore);
  assert.deepEqual(transcriptTexts(selected.events), ["Beta"]);
  assert.deepEqual(resumedSayTexts(choice.plan, selected.snapshot), ["Beta"]);
});

test("workspace composer answers date and time asks with ISO text", () => {
  for (const [command, answer] of [
    ["askDate", "2026-10-04"],
    ["askTime", "14:30"],
    ["askDateTime", "2026-10-04T18:00"],
  ] as const) {
    const compiled = compileWorkspaceSource(
      `let value = ${command} "When?"\nsay value.toISO(), instant\nexit`,
    );
    assert.ok(compiled.plan && compiled.snapshot);
    const waiting = executeValidatedWorkspaceSnapshot(compiled.plan, compiled.snapshot, "run");
    assert.ok(waiting.snapshot);
    const completed = submitWorkspaceComposer(compiled.plan, waiting.snapshot, answer);
    assert.equal(completed.outcome.kind, "completed", command);
    assert.deepEqual(resumedSayTexts(compiled.plan, completed.snapshot), [answer], command);
  }
});

test("composer text for a choice remains engine-owned and rejects ambiguous visible text", () => {
  const compiled = compileWorkspaceSource(
    'let selected = choose first: "Same", second: "Same"\nexit',
  );
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
  // Each long wait keeps the session running while the message's pacing gate is in the background.
  const unskippable = compileWorkspaceSource('say unskippable "paced"\nwait 2000 s\nexit');
  assert.ok(unskippable.plan && unskippable.snapshot);
  const waiting = executeValidatedWorkspaceSnapshot(unskippable.plan, unskippable.snapshot, "run");
  assert.ok(waiting.snapshot);
  const before = JSON.stringify(waiting.snapshot);
  const rejectedSkip = skipWorkspacePacing(unskippable.plan, waiting.snapshot);
  assert.equal(rejectedSkip.outcome.kind, "invalidPayload");
  assert.deepEqual(rejectedSkip.events, []);
  assert.equal(JSON.stringify(rejectedSkip.snapshot), before);

  const skippable = compileWorkspaceSource('say "paced"\nwait 2000 s\nexit');
  assert.ok(skippable.plan && skippable.snapshot);
  const running = executeValidatedWorkspaceSnapshot(skippable.plan, skippable.snapshot, "run");
  assert.ok(running.snapshot);
  const completed = skipWorkspacePacing(skippable.plan, running.snapshot);
  const duplicate = skipWorkspacePacing(skippable.plan, completed.snapshot);
  assert.equal(duplicate.outcome.kind, "localRejection");
  assert.deepEqual(duplicate.events, []);
  assert.deepEqual(duplicate.snapshot, completed.snapshot);

  const text = compileWorkspaceSource("let answer = askText\nexit");
  assert.ok(text.plan && text.snapshot);
  const textWaiting = executeValidatedWorkspaceSnapshot(text.plan, text.snapshot, "run");
  assert.ok(textWaiting.snapshot);
  const textBefore = JSON.stringify(textWaiting.snapshot);
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
  assert.equal(JSON.stringify(oversized.snapshot), textBefore);
  assert.equal(JSON.stringify(textWaiting.snapshot), textBefore);
});

function transcriptTexts(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "playerTranscript" ? [event.text] : []));
}

function settledActionIds(events: readonly InterpreterEvent[]): number[] {
  return events.flatMap((event) =>
    event.kind === "actionCompleted" ? [event.settlement.actionId] : [],
  );
}

/** Resumes through the workspace controller and returns the visible text of each emitted `say`. */
function resumedSayTexts(plan: InstructionPlan, snapshot: RuntimeSnapshot): string[] {
  return executeValidatedWorkspaceSnapshot(plan, snapshot, "run").events.flatMap((event) =>
    event.kind === "say" ? [event.text] : [],
  );
}

test("the workspace has no camera, so continuing past takePhoto() yields null with a warning", () => {
  const compiled = compileWorkspaceSource(
    "let photo = takePhoto()\nlet missing = photo == null\nexit",
  );
  assert.ok(compiled.plan && compiled.snapshot);
  const waiting = executeValidatedWorkspaceSnapshot(compiled.plan, compiled.snapshot, "run");
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.snapshot?.foregroundAction?.kind, "capture");
  const continued = executeValidatedWorkspaceSnapshot(compiled.plan, waiting.snapshot!, "run");
  assert.equal(continued.status, "halted");
  assert.ok(
    continued.events.some((event) => event.kind === "developerWarning" && event.code === "TSW015"),
  );
  const missing = continued.snapshot?.frames[0]?.bindings.find(
    (binding) => binding.name === "missing",
  );
  assert.equal(missing?.value, true);
});
