import assert from "node:assert/strict";
import test from "node:test";

import { rebuildRecordedSession } from "../player/debug-export.js";
import { DebugRecorder } from "../player/debug-recorder.js";
import {
  closePlayerRuntimePopup,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeDebugNow,
  playerRuntimeForeground,
  playerRuntimeSnapshot,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/snapshot/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runUntilExit } from "./helpers/run-until-exit.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-construction.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-validation.js";

function started(source: string) {
  const plan = compileValidPlan(source);
  assert.equal(validateInstructionPlan(plan).valid, true);
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  return { plan, snapshot: result.snapshot, events: result.events };
}

function pendingPopup(snapshot: RuntimeSnapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(
    action?.kind === "interaction" && action.ui.kind === "popup",
    `expected a popup, got ${action?.kind}`,
  );
  return { ...action, ui: action.ui };
}

function closed(plan: InstructionPlan, snapshot: RuntimeSnapshot, actionId?: number) {
  return completeAction(plan, snapshot, {
    actionId: actionId ?? pendingPopup(snapshot).actionId,
    actionKind: "interaction",
    interactionKind: "popup",
    payload: { kind: "activate" },
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

function observe(session: PlayerRuntimeSession, atMs: number): PlayerRuntimeSession {
  const observed = observePlayerRuntimeTime(session, atMs);
  assert.equal(observed.outcome.kind, "observed");
  return observed.session;
}

function close(session: PlayerRuntimeSession): PlayerRuntimeSession {
  const result = closePlayerRuntimePopup(session);
  assert.equal(result?.outcome.kind, "completed");
  return result.session;
}

function seconds(value: number) {
  return { kind: "duration", milliseconds: value * 1000 };
}

test("showPopup waits until the player closes it with its one button, and nothing enters the transcript", () => {
  for (const [form, buttonText] of [
    ['showPopup "Task completed"', "OK"],
    ['showPopup("Task completed")', "OK"],
    ['showPopup(message: "Task completed")', "OK"],
    ['showPopup(message: "Task completed", buttonText: "Continue")', "Continue"],
    ['showPopup(buttonText: "Continue", message: "Task completed")', "Continue"],
    ['showPopup("Task completed", buttonText: "Continue")', "Continue"],
  ] as const) {
    let session = createPlayerRuntimeSession(
      `say "Before", instant\n${form}\nsay "After", instant\nexit`,
    );
    assert.equal(session.state.status, "waiting", form);
    assert.deepEqual(
      playerRuntimeForeground(session),
      { kind: "popup", accessibleName: "Continue", message: "Task completed", buttonText },
      form,
    );
    assert.equal(playerRuntimeDebugNow(session, 0).waitingAt?.kind, "popup");
    assert.deepEqual(transcript(session), ["narrator: Before"], form);
    const result = closePlayerRuntimePopup(session);
    assert.equal(result?.outcome.kind, "completed", form);
    session = result.session;
    assert.equal(session.state.status, "halted", form);
    // Neither the message nor the button's text is a chat message.
    assert.deepEqual(transcript(session), ["narrator: Before", "narrator: After"], form);
  }
});

test("showPopup used as a value returns how long the popup was open as a duration, in both forms", () => {
  for (const form of [
    'let t = showPopup "Stand in the corner. Click when you\'re done."',
    'let t = showPopup "Stand in corner ${n}."',
    'let t = showPopup(message: "Stand in the corner.", buttonText: "Done")',
    'let t = showPopup("Stand in corner ${n}.", buttonText: "Done ${n}")',
  ]) {
    // The popup appears at 1 s and closes at 4 s.
    let session = createPlayerRuntimeSession(
      `let n = 2\nwait 1 s\n${form}\nif t < 5 min {\n  say "Back already? Again.", instant\n}\nsay "\${t}", instant\nexit`,
    );
    session = observe(session, 4_000);
    assert.equal(playerRuntimeForeground(session)?.kind, "popup", form);
    session = close(session);
    assert.equal(session.state.status, "halted", form);
    assert.deepEqual(binding(playerRuntimeSnapshot(session), "t"), seconds(3), form);
    assert.deepEqual(
      transcript(session),
      ["narrator: Back already? Again.", "narrator: 3 seconds"],
      form,
    );
  }
});

test("a popup whose value is ignored gives none, and the script goes on as before", () => {
  let session = createPlayerRuntimeSession(
    'wait 1 s\nshowPopup "First"\nlet t = showPopup "Second"\nsay "${t}", instant\nexit',
  );
  session = close(observe(session, 2_000));
  const ignored = playerRuntimeSnapshot(session).lastSettlement;
  assert.ok(ignored?.actionKind === "interaction");
  assert.equal(ignored.destinationTemporary, null);
  assert.equal(ignored.result, null);
  // The second popup counts from when it appeared, at 2 s.
  session = close(observe(session, 5_000));
  assert.deepEqual(transcript(session), ["narrator: 3 seconds"]);
});

test("a popup's value leaves out the time a block interrupted it, also across a restore while the block runs", () => {
  // The block runs from 1 s to 3 s while the popup, shown at 0 s, waits; it closes at 4 s.
  let session = createPlayerRuntimeSession(
    'timer async 1 s {\n  wait 2 s\n}\nlet t = showPopup "Wait for me"\nsay "${t}", instant\nexit',
  );
  session = observe(session, 2_000);
  assert.equal(closePlayerRuntimePopup(session), null, "the block's wait is in front");
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  for (const current of [session, restored]) {
    const back = observe(current, 3_000);
    assert.equal(playerRuntimeForeground(back)?.kind, "popup");
    assert.deepEqual(transcript(close(observe(back, 4_000))), ["narrator: 2 seconds"]);
  }
});

test("a popup restored while it waits returns the time since it appeared once closed", () => {
  const source = 'wait 1 s\nlet t = showPopup "Wait"\nsay "${t}", instant\nexit';
  const restorePoint = createPlayerRuntimeRestorePoint(
    observe(createPlayerRuntimeSession(source), 2_200),
  );
  const restored = restorePlayerRuntimeSession(restorePoint);
  assert.equal(validateRuntimeSnapshot(playerRuntimeSnapshot(restored), restored.plan).valid, true);
  assert.deepEqual(transcript(close(observe(restored, 3_500))), ["narrator: 2.5 seconds"]);

  // A checkpoint between the close and the script reading the value keeps it.
  const { plan, snapshot } = started('let t = showPopup "Wait"\nexit');
  const settled = closed(plan, observeTime(plan, snapshot, 1_500).snapshot).snapshot;
  assert.equal(validateRuntimeSnapshot(settled, plan).valid, true);
  const checkpoint = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, settled)));
  assert.deepEqual(checkpoint.snapshot, settled);
  assert.deepEqual(
    binding(runUntilExit(checkpoint.plan, checkpoint.snapshot).snapshot, "t"),
    seconds(1.5),
  );
});

test("a recorded popup value replays the same, and a repeated close replays its settlement", () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    'wait 1 s\nlet t = showPopup "Wait"\nsay "${t}", instant\nexit',
    { recorder },
  );
  session = observe(session, 2_000);
  const popup = pendingPopup(playerRuntimeSnapshot(session));
  session = close(observe(session, 3_500));
  const recording = recorder.recording()!;
  const rebuilt = rebuildRecordedSession(
    recording.plan,
    recording.anchorSnapshot,
    recording.operations,
  ).exportSnapshot();
  assert.deepEqual(rebuilt, playerRuntimeSnapshot(session));
  assert.deepEqual(binding(rebuilt, "t"), seconds(2.5));

  const settled = playerRuntimeSnapshot(session);
  const repeated = closed(session.plan, settled, popup.actionId);
  assert.ok(
    repeated.outcome.kind === "alreadySettled" &&
      repeated.outcome.settlement.actionKind === "interaction",
  );
  assert.deepEqual(repeated.outcome.settlement.result, seconds(2.5));
  assert.deepEqual(repeated.snapshot, settled);
});

test("closing a popup publishes its completion without a player transcript event", () => {
  const { plan, snapshot } = started('showPopup "Done"\nsay "Next", instant\nexit');
  const close = closed(plan, snapshot);
  assert.equal(close.outcome.kind, "completed");
  assert.deepEqual(
    close.events.map((event) => event.kind),
    ["actionCompleted"],
  );
  const settlement = close.snapshot.lastSettlement;
  assert.ok(settlement?.actionKind === "interaction");
  assert.equal(settlement.interactionKind, "popup");
  assert.equal(settlement.transcriptText, null);
  assert.equal(settlement.transcriptEventSequence, null);
  assert.equal(settlement.result, null);
  assert.equal(validateRuntimeSnapshot(close.snapshot, plan).valid, true);
  // Only the button closes it; the popup takes no text and no other payload.
  for (const payload of [
    { kind: "submittedText", submittedText: "OK" },
    { kind: "activate", extra: true },
    { kind: "selectedOption", optionIndex: 0 },
  ]) {
    const refused = completeAction(plan, snapshot, {
      actionId: pendingPopup(snapshot).actionId,
      actionKind: "interaction",
      interactionKind: "popup",
      payload,
    });
    assert.equal(refused.outcome.kind, "invalidPayload", JSON.stringify(payload));
    assert.deepEqual(refused.snapshot, snapshot);
  }
  // A repeated close replays its settlement.
  assert.equal(
    closed(plan, close.snapshot, pendingPopup(snapshot).actionId).outcome.kind,
    "alreadySettled",
  );
});

test("a computed message and button text are evaluated once, in written order, and shown as text", () => {
  const { plan, snapshot } = started(
    'let order: string[] = []\nfunction part(value: string): string {\n  order.add(value)\n  return value\n}\nlet count = 3\nshowPopup(buttonText: part("Go"), message: part("Done ${count}"))\nshowPopup count\nlet after = order\nexit',
  );
  assert.deepEqual(pendingPopup(snapshot).ui, {
    kind: "popup",
    message: "Done 3",
    buttonText: "Go",
    accessibleName: { kind: "localizedDefault", key: "continue" },
  });
  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
  const second = run(plan, closed(plan, snapshot).snapshot).snapshot;
  // A number is shown as text, as in `say`.
  assert.equal(pendingPopup(second).ui.message, "3");
  assert.equal(pendingPopup(second).ui.buttonText, "OK");
  const finished = runUntilExit(plan, closed(plan, second).snapshot).snapshot;
  assert.deepEqual(binding(finished, "after"), { kind: "list", items: ["Go", "Done 3"] });
});

test("a waiting popup survives a JSON checkpoint and a Player restore, and closing it continues once", () => {
  const source =
    'let name = "Anna"\nshowPopup(message: "Well done, ${name}", buttonText: "Thanks")\nsay "After", instant\nexit';
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

  // A reload restores the Player's session with the popup open again.
  const session = createPlayerRuntimeSession(source);
  const reloaded = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(playerRuntimeForeground(reloaded), {
    kind: "popup",
    accessibleName: "Continue",
    message: "Well done, Anna",
    buttonText: "Thanks",
  });
  const after = closePlayerRuntimePopup(reloaded);
  assert.equal(after?.outcome.kind, "completed");
  assert.equal(after.session.state.status, "halted");
  assert.deepEqual(transcript(after.session), ["narrator: After"]);
  assert.equal(closePlayerRuntimePopup(after.session), null);
});

test("a timer block interrupts a waiting popup, which returns with its identity when the block ends", () => {
  const { plan, snapshot } = started(
    'let ticks = 0\ntimer async 1 s {\n  wait 1 s\n  ticks = ticks + 1\n}\nshowPopup "Wait for me"\nlet seen = ticks\nexit',
  );
  const id = pendingPopup(snapshot).actionId;
  const interrupted = run(plan, observeTime(plan, snapshot, 1500).snapshot).snapshot;
  // While the block waits, the popup is suspended: not presented and not closable.
  assert.equal(interrupted.foregroundAction?.kind, "delay");
  assert.equal(closed(plan, interrupted, id).outcome.kind, "suspendedAction");
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, interrupted)));
  assert.deepEqual(restored.snapshot, interrupted);
  const back = run(plan, observeTime(plan, restored.snapshot, 2500).snapshot).snapshot;
  assert.equal(pendingPopup(back).actionId, id);
  assert.equal(validateRuntimeSnapshot(back, plan).valid, true);
  const finished = runUntilExit(plan, closed(plan, back).snapshot).snapshot;
  assert.equal(binding(finished, "seen"), 1);
});

test("snapshot validation refuses a popup settlement with a transcript and a popup its prepared texts did not give", () => {
  const { plan, snapshot } = started('let n = 1\nshowPopup "Number ${n}"\nexit');
  const settled = closed(plan, snapshot).snapshot;
  const settlement = settled.lastSettlement;
  assert.ok(settlement?.actionKind === "interaction");
  const transcribed = {
    ...settled,
    lastSettlement: { ...settlement, transcriptText: "OK", transcriptEventSequence: 2 },
  };
  assert.equal(validateRuntimeSnapshot(transcribed, plan).valid, false);
  const popup = pendingPopup(snapshot);
  const edited = {
    ...snapshot,
    foregroundAction: { ...popup, ui: { ...popup.ui, message: "Number 2" } },
  };
  assert.equal(validateRuntimeSnapshot(edited, plan).valid, false);
  const renamed = {
    ...snapshot,
    foregroundAction: { ...popup, ui: { ...popup.ui, buttonText: "Close" } },
  };
  assert.equal(validateRuntimeSnapshot(renamed, plan).valid, false);
});

test("the compiler checks showPopup's arguments and its value, and its name is reserved", () => {
  const diagnostics = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.code);
  assert.deepEqual(diagnostics('showPopup("a", "b")'), ["TSV020"]);
  assert.deepEqual(diagnostics('showPopup("a", message: "b")'), ["TSV020"]);
  assert.deepEqual(diagnostics('showPopup(buttonText: "b")'), ["TSV024"]);
  assert.deepEqual(diagnostics('showPopup("a", title: "b")'), ["TSV022"]);
  assert.deepEqual(diagnostics('showPopup("a", buttonText: "b", buttonText: "c")'), ["TSV023"]);
  // The command form takes only the message.
  assert.deepEqual(diagnostics('showPopup "a", buttonText: "b"'), ["TSP032"]);
  assert.deepEqual(diagnostics("showPopup"), ["TSP012"]);
  // The message and the button's text are shown text.
  assert.deepEqual(diagnostics('showPopup ["a"]'), ["TSV040"]);
  assert.deepEqual(diagnostics('showPopup("a", buttonText: ["b"])'), ["TSV040"]);
  // Its value is a duration in both forms, which needs a message, and its name is reserved.
  assert.deepEqual(diagnostics('let shown: duration = showPopup("a")'), []);
  assert.deepEqual(diagnostics('let shown: string = showPopup "a"'), ["TSV041"]);
  assert.deepEqual(diagnostics('let shown = showPopup "a", buttonText: "b"'), ["TSP032"]);
  assert.deepEqual(diagnostics("let shown = showPopup"), ["TSP012"]);
  assert.deepEqual(diagnostics("let showPopup = 1"), ["TSV001"]);
});
