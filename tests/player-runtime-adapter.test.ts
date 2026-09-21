import { preparePlayerMessageMarkup } from "../player/message-markup.js";
import { normalizeColor } from "../src/color.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  compileSource,
  createFreshRuntimeSnapshot,
  run,
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
} from "../src/index.js";

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

test("runtime adapter delivers resolved authored presentation and preserves it on restore", () => {
  const session = createPlayerRuntimeSession(`
speaker guide {
  font: "Georgia"
  color: "red"
  prose: { align: "left" }
}
say as guide prose(position: "right", background: "ivory") "A letter", instant
showButton "Continue"
`);
  const entry = session.transcriptEntries[0];
  if (entry?.kind !== "message") throw new Error("Expected a runtime message.");
  assert.deepEqual(entry.presentation, {
    kind: "prose",
    position: "right",
    align: "left",
    font: "Georgia",
    color: normalizeColor("red"),
    background: normalizeColor("ivory"),
  });
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
});

test("runtime adapter preserves omitted alignment separately from explicit center through restore", () => {
  const session = createPlayerRuntimeSession(`
say "Default bubble", instant
say prose "Default prose", instant
say prose(position: "center", align: "center") "Explicit center", instant
showButton "Continue"
`);
  const positions = session.transcriptEntries.map((entry) => {
    if (entry.kind !== "message") throw new Error("Expected a runtime message.");
    return [entry.presentation?.position, entry.presentation?.align];
  });
  assert.deepEqual(positions, [
    [null, null],
    [null, null],
    ["center", "center"],
  ]);
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
});

test("runtime adapter delegates interaction normalization, transcript, and continuation to the engine", () => {
  let session = createPlayerRuntimeSession(`
speaker guide {
  title: "Guide"
  color: "#b784ff"
}
say as guide "**Ready?**", instant
showButton as guide "Continue"
let text = askText as guide "Text"
let amount = askNumber as guide "Number"
let choice = choose as guide first: "Same", second: "Same"
say as guide "${"${text}"} / ${"${amount}"} / ${"${choice}"}", instant
exit
`);
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Ready?"],
  );
  const firstEntry = session.transcriptEntries[0];
  if (firstEntry?.kind !== "message") throw new Error("Expected a runtime message.");
  const guide = session.speakers[firstEntry.speakerId];
  assert.deepEqual(guide, {
    name: "Guide",
    accent: normalizeColor("#b784ff"),
    avatar: "G",
    fontFamily: "inherit",
  });
  assert.equal(firstEntry.content?.visibleText, "Ready?");
  assert.deepEqual(
    firstEntry.content?.blocks[0]?.kind === "paragraph"
      ? firstEntry.content.blocks[0].lines[0]?.spans.map((span) => span.kind)
      : [],
    ["bold"],
  );

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
  assert.equal(
    session.transcriptEntries[0]?.kind === "message" &&
      session.transcriptEntries[0].content !== undefined,
    true,
  );
  assert.equal(
    session.transcriptEntries[1]?.kind === "message" &&
      session.transcriptEntries[1].content === undefined,
    true,
  );
  assert.equal(
    session.transcriptEntries[5]?.kind === "message" &&
      session.transcriptEntries[5].content !== undefined,
    true,
  );
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

test("runtime checkpoint restore preserves a paced history and its continuation", () => {
  let session = createPlayerRuntimeSession('repeat 4 { say "x" }');
  for (let index = 0; index < 2; index++) session = skipPlayerRuntimePacing(session)!.session;
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.events, session.events);
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
  const resumed = skipPlayerRuntimePacing(restored)!.session;
  const direct = skipPlayerRuntimePacing(session)!.session;
  assert.deepEqual(resumed.snapshot, direct.snapshot);
  assert.deepEqual(resumed.transcriptEntries, direct.transcriptEntries);
});

test("runtime checkpoint restore handles retained event histories above the native spread limit", () => {
  // Size is the regression input: spreading this many arguments exceeded the supported Node stack.
  const count = 150_000;
  const { plan } = compileSource(`repeat ${count} { say "x", instant }`);
  assert.ok(plan);
  const result = run(plan, createFreshRuntimeSnapshot(plan), {}, { instructionBudget: count * 20 });
  assert.equal(result.snapshot.status, "halted");
  const restored = restorePlayerRuntimeSession({
    checkpointJson: serializeCheckpoint(createCheckpoint(plan, result.snapshot)),
    events: result.events,
  });
  assert.deepEqual(restored.events, result.events);
  assert.equal(restored.transcriptEntries.length, count);
  assert.equal(new Set(restored.transcriptEntries.map((entry) => entry.id)).size, count);
  assert.equal(restored.transcriptEntries[0]?.text, "x");
  assert.equal(restored.transcriptEntries.at(-1)?.text, "x");
  assert.deepEqual(restored.snapshot, result.snapshot);
});

test("runtime development scenarios compile through the real Player adapter", async () => {
  const scenarios = [
    ["show-button", "interaction", "button", null],
    ["choose", "interaction", "choice", null],
    ["ask-text", "interaction", "text", null],
    ["ask-number", "interaction", "number", null],
    ["skippable-pacing", "chatPacingGate", null, true],
    ["unskippable-pacing", "chatPacingGate", null, false],
  ] as const;

  for (const [fileName, actionKind, interactionKind, skippable] of scenarios) {
    const source = await readFile(
      resolve(process.cwd(), `player/vue/src/runtime-scenarios/${fileName}.tease`),
      "utf8",
    );
    const session = createPlayerRuntimeSession(source);
    const action =
      actionKind === "interaction"
        ? session.snapshot.foregroundAction
        : playerRuntimePacingGate(session);
    assert.equal(action?.kind, actionKind, `${fileName} action kind`);
    if (action?.kind === "interaction") {
      assert.equal(action.interactionKind, interactionKind, `${fileName} interaction kind`);
    } else if (action?.kind === "chatPacingGate") {
      assert.equal(action.skippable, skippable, `${fileName} skip policy`);
    }
  }
});

test("invalid dynamic markup colours preserve enclosing colours in delivered pieces", () => {
  const session = createPlayerRuntimeSession(`
let bad = "invalid"
say "[color=red][bg=ivory]outer [color=\${bad}][bg=\${bad}]inner **bold**[/bg][/color] outer[/bg][/color] [color=\${bad}][bg=\${bad}]plain[/bg][/color]", instant
`);
  const entry = session.transcriptEntries[0];
  if (entry?.kind !== "message" || entry.content === undefined) throw new Error("Expected markup.");
  const block = preparePlayerMessageMarkup(entry.content)[0];
  if (block?.kind !== "paragraph") throw new Error("Expected paragraph.");
  const pieces = block.lines[0]!.pieces;
  for (const piece of pieces.filter((piece) => /outer|inner|bold/u.test(piece.text))) {
    assert.equal(piece.style.color, normalizeColor("red"));
    assert.equal(piece.style.backgroundColor, normalizeColor("ivory"));
  }
  assert.deepEqual(pieces.at(-1)?.style, {});
});

test("response presentation distinguishes choices and buttons from typed answers after restore", () => {
  let session = createPlayerRuntimeSession(`
let reply = askText "Reply"
let answer = choose left: "Left", right: "Right"
showButton "Continue"
exit
`);
  session = submitPlayerRuntimeComposer(session, "Hello")!.session;
  session = submitPlayerRuntimeComposer(session, "Left")!.session;
  session = activatePlayerRuntimeButton(session)!.session;
  const kinds = (value: typeof session) =>
    value.transcriptEntries.map((entry) =>
      entry.kind === "message" ? entry.responseKind : undefined,
    );
  assert.deepEqual(kinds(session), [undefined, "choice", "button"]);
  assert.deepEqual(
    kinds(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session))),
    kinds(session),
  );
});
