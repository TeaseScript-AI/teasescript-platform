import assert from "node:assert/strict";
import test from "node:test";

import {
  closePlayerRuntimeExport,
  closePlayerRuntimePopup,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeDebugNow,
  playerRuntimeForeground,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { compileSource } from "../src/compiler.js";
import { MAX_INTERACTION_AGGREGATE_UTF8_BYTES } from "../src/interaction-limits.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runUntilExit } from "./helpers/run-until-exit.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot-construction.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot-validation.js";

function started(source: string) {
  const plan = compileValidPlan(source);
  assert.equal(validateInstructionPlan(plan).valid, true);
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  return { plan, snapshot: result.snapshot, events: result.events };
}

function pendingExport(snapshot: RuntimeSnapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(
    action?.kind === "interaction" && action.ui.kind === "export",
    `expected an exportText dialog, got ${action?.kind}`,
  );
  return { ...action, ui: action.ui };
}

function closed(plan: InstructionPlan, snapshot: RuntimeSnapshot, actionId?: number) {
  return completeAction(plan, snapshot, {
    actionId: actionId ?? pendingExport(snapshot).actionId,
    actionKind: "interaction",
    interactionKind: "export",
    payload: { kind: "close" },
  });
}

function binding(snapshot: RuntimeSnapshot, name: string) {
  return snapshot.frames[0]?.bindings.find((candidate) => candidate.name === name)?.value;
}

function transcript(session: PlayerRuntimeSession): string[] {
  return session.transcriptEntries.flatMap((entry) =>
    entry.kind === "message" ? [`${entry.speakerId}: ${entry.text}`] : [],
  );
}

test("exportText shows its text until the player closes it, with default title and file name, and nothing enters the transcript", () => {
  let session = createPlayerRuntimeSession(
    'say "Before", instant\nlet report = toJson({ rounds: 3 })\nexportText(report, title: "Your report", fileName: "report.json")\nexportText("Plain")\nsay "After", instant\nexit',
  );
  assert.equal(session.state.status, "waiting");
  assert.deepEqual(playerRuntimeForeground(session), {
    kind: "export-text",
    accessibleName: "Continue",
    title: "Your report",
    text: '{"rounds":3}',
    fileName: "report.json",
  });
  assert.equal(playerRuntimeDebugNow(session, 0).waitingAt?.kind, "export");
  // Only its own close continues it.
  assert.equal(closePlayerRuntimePopup(session), null);
  const first = closePlayerRuntimeExport(session);
  assert.equal(first?.outcome.kind, "completed");
  session = first.session;
  assert.deepEqual(playerRuntimeForeground(session), {
    kind: "export-text",
    accessibleName: "Continue",
    title: "Copy or download",
    text: "Plain",
    fileName: "text.txt",
  });
  const second = closePlayerRuntimeExport(session);
  assert.equal(second?.outcome.kind, "completed");
  session = second.session;
  assert.equal(session.state.status, "halted");
  // Neither the text, its title, nor closing it is a chat message.
  assert.deepEqual(transcript(session), ["narrator: Before", "narrator: After"]);
  assert.equal(closePlayerRuntimeExport(session), null);
});

test("closing exportText publishes its completion without a player transcript event, and nothing else completes it", () => {
  const { plan, snapshot } = started('exportText("Done")\nsay "Next", instant\nexit');
  const close = closed(plan, snapshot);
  assert.equal(close.outcome.kind, "completed");
  assert.deepEqual(
    close.events.map((event) => event.kind),
    ["actionCompleted"],
  );
  const settlement = close.snapshot.lastSettlement;
  assert.ok(settlement?.actionKind === "interaction");
  assert.equal(settlement.interactionKind, "export");
  assert.equal(settlement.transcriptText, null);
  assert.equal(settlement.transcriptEventSequence, null);
  assert.equal(settlement.result, null);
  assert.equal(validateRuntimeSnapshot(close.snapshot, plan).valid, true);
  // Copying and downloading are the Player's; only closing completes it.
  for (const payload of [
    { kind: "activate" },
    { kind: "close", copied: true },
    { kind: "submittedText", submittedText: "Done" },
  ]) {
    const refused = completeAction(plan, snapshot, {
      actionId: pendingExport(snapshot).actionId,
      actionKind: "interaction",
      interactionKind: "export",
      payload,
    });
    assert.equal(refused.outcome.kind, "invalidPayload", JSON.stringify(payload));
    assert.deepEqual(refused.snapshot, snapshot);
  }
  assert.equal(
    closed(plan, close.snapshot, pendingExport(snapshot).actionId).outcome.kind,
    "alreadySettled",
  );
});

test("the text, title, and file name are evaluated once, in written order, and the text may be longer than an interaction's text", () => {
  const long = "x".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES + 1);
  const { plan, snapshot } = started(
    `let order: string[] = []\nfunction part(value: string): string {\n  order.add(value)\n  return value\n}\nlet count = 3\nexportText(part("data"), fileName: part("data.txt"), title: part("Title"))\nexportText("${long}", title: count)\nlet after = order\nexit`,
  );
  assert.deepEqual(pendingExport(snapshot).ui, {
    kind: "export",
    text: "data",
    title: "Title",
    fileName: "data.txt",
    accessibleName: { kind: "localizedDefault", key: "continue" },
  });
  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
  const second = run(plan, closed(plan, snapshot).snapshot).snapshot;
  // A title is shown text, as in `say`.
  assert.equal(pendingExport(second).ui.title, "3");
  assert.equal(pendingExport(second).ui.text, long);
  assert.equal(validateRuntimeSnapshot(second, plan).valid, true);
  const finished = runUntilExit(plan, closed(plan, second).snapshot).snapshot;
  assert.deepEqual(binding(finished, "after"), {
    kind: "list",
    items: ["data", "data.txt", "Title"],
  });

  // The title and file name share the limit of an interaction's text.
  const titled = createPlayerRuntimeSession(
    `let title = "${long}"\nexportText("short", title: title)\nexit`,
  );
  assert.equal(titled.state.failure?.code, "TSR052");
});

test("a text or file name that is not text fails as the dialog opens", () => {
  for (const [call, message] of [
    ["exportText(value)", "exportText needs its text as text (string), but this is 42."],
    [
      'exportText("text", fileName: value)',
      "'fileName:' of exportText takes text (string), but this is 42.",
    ],
  ] as const) {
    const session = createPlayerRuntimeSession(
      `function show(value) {\n  ${call}\n}\nshow(42)\nexit`,
    );
    assert.equal(session.state.failure?.code, "TSR050", call);
    assert.equal(session.state.failure?.message, message, call);
  }
});

test("a waiting exportText survives a JSON checkpoint and a reload, and closing it continues once", () => {
  const source =
    'let data = toBase64("ü 😀")\nexportText(data, title: "Your code", fileName: "code.txt")\nsay "After", instant\nexit';
  const { plan, snapshot } = started(source);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  assert.deepEqual(restored.snapshot, snapshot);
  const original = closed(plan, snapshot);
  const resumed = closed(restored.plan, restored.snapshot);
  assert.equal(resumed.outcome.kind, "completed");
  assert.deepEqual(resumed.events, original.events);
  assert.deepEqual(
    runUntilExit(restored.plan, resumed.snapshot).snapshot,
    runUntilExit(plan, original.snapshot).snapshot,
  );

  // A reload shows it again; the Player copies or downloads nothing by itself.
  const session = createPlayerRuntimeSession(source);
  const reloaded = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(playerRuntimeForeground(reloaded), {
    kind: "export-text",
    accessibleName: "Continue",
    title: "Your code",
    text: "w7wg8J+YgA==",
    fileName: "code.txt",
  });
  const after = closePlayerRuntimeExport(reloaded);
  assert.equal(after?.outcome.kind, "completed");
  assert.equal(after.session.state.status, "halted");
  assert.deepEqual(transcript(after.session), ["narrator: After"]);
});

test("a timer block interrupts a waiting exportText, which returns with its identity when the block ends", () => {
  const { plan, snapshot } = started(
    'let ticks = 0\ntimer async 1 s {\n  wait 1 s\n  ticks = ticks + 1\n}\nexportText("Keep me")\nlet seen = ticks\nexit',
  );
  const id = pendingExport(snapshot).actionId;
  const interrupted = run(plan, observeTime(plan, snapshot, 1500).snapshot).snapshot;
  assert.equal(interrupted.foregroundAction?.kind, "delay");
  assert.equal(closed(plan, interrupted, id).outcome.kind, "suspendedAction");
  const back = run(plan, observeTime(plan, interrupted, 2500).snapshot).snapshot;
  assert.equal(pendingExport(back).actionId, id);
  assert.equal(validateRuntimeSnapshot(back, plan).valid, true);
  const finished = runUntilExit(plan, closed(plan, back).snapshot).snapshot;
  assert.equal(binding(finished, "seen"), 1);
});

test("plan and snapshot validation refuse an exportText that its request did not give", () => {
  const { plan, snapshot } = started(
    'let text = "data"\nexportText(text, title: "Mine")\nexportText("other")\nexit',
  );
  const request = pendingExport(snapshot);
  for (const ui of [
    { ...request.ui, text: "changed" },
    { ...request.ui, title: "Yours" },
    { ...request.ui, fileName: "other.txt" },
    { ...request.ui, text: 5 },
  ]) {
    const edited = { ...snapshot, foregroundAction: { ...request, ui } };
    assert.equal(validateRuntimeSnapshot(edited, plan).valid, false, JSON.stringify(ui));
  }
  const second = run(plan, closed(plan, snapshot).snapshot).snapshot;
  const defaults = pendingExport(second);
  assert.equal(validateRuntimeSnapshot(second, plan).valid, true);
  for (const ui of [
    { ...defaults.ui, title: "Other" },
    { ...defaults.ui, fileName: "text.json" },
  ]) {
    const edited = { ...second, foregroundAction: { ...defaults, ui } };
    assert.equal(validateRuntimeSnapshot(edited, plan).valid, false, JSON.stringify(ui));
  }
  const settled = closed(plan, second).snapshot;
  const settlement = settled.lastSettlement;
  assert.ok(settlement?.actionKind === "interaction");
  for (const changed of [
    { transcriptText: "other", transcriptEventSequence: 3 },
    { result: "other" },
  ]) {
    const edited: RuntimeSnapshot = { ...settled, lastSettlement: { ...settlement, ...changed } };
    assert.equal(validateRuntimeSnapshot(edited, plan).valid, false, JSON.stringify(changed));
  }

  // A plan always prepares the dialog, and it gives no value.
  const index = plan.instructions.findIndex(
    (instruction) => instruction.kind === "interaction" && instruction.interactionKind === "export",
  );
  const instruction = plan.instructions[index]!;
  assert.ok(instruction.kind === "interaction" && "preparedUi" in instruction);
  const { preparedUi, speakerTemporary, ...rest } = instruction;
  for (const changed of [
    { ...rest, speaker: null, ui: { ...request.ui } },
    { ...instruction, destinationTemporary: speakerTemporary + 100 },
    { ...instruction, preparedUi: { ...preparedUi, extra: 1 } },
  ]) {
    const instructions = plan.instructions.map((item, at) => (at === index ? changed : item));
    assert.equal(
      validateInstructionPlan({ ...plan, instructions }).valid,
      false,
      JSON.stringify(changed),
    );
  }
});

test("the compiler checks exportText's arguments, it gives no value, and its name is reserved", () => {
  const diagnostics = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.code);
  assert.deepEqual(diagnostics('exportText("a", title: "T", fileName: "a.txt")'), []);
  assert.deepEqual(diagnostics("exportText()"), ["TSV020"]);
  assert.deepEqual(diagnostics('exportText("a", "b")'), ["TSV020"]);
  assert.deepEqual(diagnostics('exportText(title: "T")'), ["TSV020"]);
  assert.deepEqual(diagnostics('exportText(text: "a")'), ["TSV020"]);
  assert.deepEqual(diagnostics('exportText(title: "T", "a")'), ["TSP019"]);
  assert.deepEqual(diagnostics('exportText("a", name: "b")'), ["TSV022"]);
  assert.deepEqual(diagnostics('exportText("a", title: "b", title: "c")'), ["TSV023"]);
  assert.deepEqual(diagnostics('exportText "a"'), ["TSP017"]);
  // The text and file name are text; the title is shown text.
  assert.deepEqual(diagnostics("exportText(42)"), ["TSV043"]);
  assert.deepEqual(diagnostics('exportText(["a"])'), ["TSV043"]);
  assert.deepEqual(diagnostics('exportText("a", fileName: 5)'), ["TSV043"]);
  assert.deepEqual(diagnostics('exportText("a", title: 5)'), []);
  assert.deepEqual(diagnostics('exportText("a", title: ["b"])'), ["TSV040"]);
  // It gives no value, and its name is reserved.
  assert.deepEqual(diagnostics('let shown = exportText("a")'), ["TSV028"]);
  assert.deepEqual(diagnostics("let exportText = 1"), ["TSV001"]);
});
