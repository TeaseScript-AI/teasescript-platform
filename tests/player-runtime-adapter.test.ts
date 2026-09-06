import assert from "node:assert/strict";
import test from "node:test";

import { deserializeCheckpoint } from "../src/index.js";

import {
  activatePlayerRuntimeButton,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeForeground,
  playerRuntimePacingGate,
  restorePlayerRuntimeSession,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimePacing,
  submitPlayerRuntimeComposer,
} from "../player/runtime-adapter.js";

test("runtime adapter delegates interaction normalization, transcript, and continuation to the engine", () => {
  let session = createPlayerRuntimeSession(`
speaker guide {
  title: "Guide"
  color: "#b784ff"
}
say as guide "Ready?", instant
showButton as guide "Continue"
let text = askText as guide "Text"
let amount = askNumber as guide "Number"
let choice = choose as guide first: "Same", second: "Same"
say as guide \`${"${text}"} / ${"${amount}"} / ${"${choice}"}\`, instant
exit
`);
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Ready?"],
  );
  const firstEntry = session.transcriptEntries[0];
  if (firstEntry?.kind !== "message") throw new Error("Expected a runtime message.");
  const guide = session.speakers[firstEntry.speakerId];
  assert.deepEqual(guide, { name: "Guide", accent: "#b784ff", avatar: "G", fontFamily: "inherit" });

  const buttonSnapshot = structuredClone(session.snapshot);
  assert.equal(submitPlayerRuntimeComposer(session, "Continue"), null);
  assert.deepEqual(session.snapshot, buttonSnapshot);
  const button = activatePlayerRuntimeButton(session);
  assert.equal(button?.outcome.kind, "completed");
  session = button!.session;

  const invalidText = submitPlayerRuntimeComposer(session, " \t ");
  assert.equal(invalidText?.outcome.kind, "invalidPayload");
  assert.deepEqual(
    invalidText?.session.snapshot.foregroundAction,
    session.snapshot.foregroundAction,
  );
  const text = submitPlayerRuntimeComposer(session, "  A\r\nB\r  ");
  assert.equal(text?.outcome.kind, "completed");
  session = text!.session;

  const invalidNumber = submitPlayerRuntimeComposer(session, "not a number");
  assert.equal(invalidNumber?.outcome.kind, "invalidPayload");
  const number = submitPlayerRuntimeComposer(session, "  -0e2  ");
  assert.equal(number?.outcome.kind, "completed");
  session = number!.session;

  const foreground = playerRuntimeForeground(session);
  assert.equal(foreground?.kind, "choose");
  if (foreground?.kind !== "choose") throw new Error("Expected choice presentation.");
  assert.deepEqual(
    foreground.options.map((option) => option.label),
    ["Same", "Same"],
  );
  const ambiguous = submitPlayerRuntimeComposer(session, "Same");
  assert.equal(ambiguous?.outcome.kind, "invalidPayload");
  assert.deepEqual(ambiguous?.session.snapshot.foregroundAction, session.snapshot.foregroundAction);

  const selected = selectPlayerRuntimeChoice(session, foreground.options[1]!.id);
  assert.equal(selected?.outcome.kind, "completed");
  session = selected!.session;
  assert.equal(session.snapshot.status, "halted");
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Ready?", "Continue", "  A\nB\n  ", "-0e2", "Same", "  A\nB\n   / 0 / second"],
  );
  const transcriptIds = session.transcriptEntries.map((entry) => entry.id);
  assert.equal(new Set(transcriptIds).size, transcriptIds.length);
  assert.ok(transcriptIds.every((id) => /^runtime-event-\d+$/u.test(id)));
});

test("runtime adapter preserves unlabelled choice order and rendered-selection semantics", () => {
  let session = createPlayerRuntimeSession(
    'let choice = choose "First", "Second"\nsay choice, instant',
  );
  const foreground = playerRuntimeForeground(session);
  assert.equal(foreground?.kind, "choose");
  if (foreground?.kind !== "choose") throw new Error("Expected choice presentation.");
  assert.deepEqual(
    foreground.options.map((option) => option.label),
    ["First", "Second"],
  );
  const selected = selectPlayerRuntimeChoice(session, foreground.options[1]!.id);
  assert.equal(selected?.outcome.kind, "completed");
  session = selected!.session;
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Second", "Second"],
  );
});

test("runtime adapter routes pacing skip and explicit time through canonical operations", () => {
  let session = createPlayerRuntimeSession(
    'say unskippable "First", 10\nsay skippable "Second", 10\nwait 20 s',
  );
  const firstGate = playerRuntimePacingGate(session);
  assert.equal(firstGate?.skippable, false);
  const beforeRejectedSkip = structuredClone(session.snapshot);
  const rejected = skipPlayerRuntimePacing(session);
  assert.equal(rejected?.outcome.kind, "invalidPayload");
  assert.deepEqual(rejected?.session.snapshot, beforeRejectedSkip);

  const observed = observePlayerRuntimeTime(session, firstGate!.deadlineMs);
  assert.equal(observed.outcome.kind, "observed");
  session = observed.session;
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["First", "Second"],
  );
  assert.equal(playerRuntimePacingGate(session)?.skippable, true);

  const skipped = skipPlayerRuntimePacing(session);
  assert.equal(skipped?.outcome.kind, "completed");
  assert.equal(playerRuntimePacingGate(skipped!.session), null);
  assert.equal(skipped?.session.snapshot.foregroundAction?.kind, "delay");
});

test("runtime checkpoint restore reconstructs presentation without replay or completion", () => {
  let session = createPlayerRuntimeSession(
    'say "Question", instant\nlet answer = choose one: "One", two: "Two"\nsay answer, instant',
  );
  const before = playerRuntimeForeground(session);
  const restorePoint = createPlayerRuntimeRestorePoint(session);
  const roundTrippedCheckpoint = deserializeCheckpoint(restorePoint.checkpointJson);
  assert.deepEqual(roundTrippedCheckpoint.snapshot, session.snapshot);

  if (before?.kind !== "choose") throw new Error("Expected choice presentation.");
  session = selectPlayerRuntimeChoice(session, before.options[0]!.id)!.session;
  assert.equal(session.snapshot.status, "halted");

  const restored = restorePlayerRuntimeSession(restorePoint);
  assert.deepEqual(playerRuntimeForeground(restored), before);
  assert.deepEqual(
    restored.transcriptEntries.map((entry) => entry.text),
    ["Question"],
  );
  assert.equal(restored.snapshot.status, "waiting");
  assert.equal(restored.events.length, restorePoint.events.length);
});

test("runtime checkpoint restore handles retained event histories above the native spread limit", () => {
  let session = createPlayerRuntimeSession('repeat 42002 { say "x" }');
  for (let skipCount = 0; skipCount < 41_999; skipCount += 1) {
    const skipped = skipPlayerRuntimePacing(session);
    assert.equal(skipped?.outcome.kind, "completed");
    session = skipped!.session;
  }

  const restorePoint = createPlayerRuntimeRestorePoint(session);
  assert.equal(restorePoint.events.length, 125_999);
  const restored = restorePlayerRuntimeSession(restorePoint);
  assert.equal(restored.events.length, restorePoint.events.length);
  assert.equal(restored.transcriptEntries.length, session.transcriptEntries.length);
  assert.deepEqual(restored.snapshot, session.snapshot);
});
