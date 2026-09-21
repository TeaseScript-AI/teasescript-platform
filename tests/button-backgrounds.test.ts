import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { normalizeOpaqueColor } from "../src/color.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { deserializeCheckpoint } from "../src/runtime/checkpoint.js";
import { validateRuntimeSnapshot } from "../src/runtime/state.js";
import { authoredColorToOklch } from "../player/theme/color.js";
import { storyChoiceVariables } from "../player/theme/story-choice.js";
import {
  activatePlayerRuntimeButton,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  observePlayerRuntimeTime,
  restorePlayerRuntimeSession,
  selectPlayerRuntimeChoice,
  submitPlayerRuntimeComposer,
} from "../player/runtime-adapter.js";

const colours = [
  "red",
  "gold",
  "yellow",
  "blue",
  "#0a7",
  "#123456ff",
  "rgb(10 120 180)",
  "rgba(10, 120, 180, 1)",
  "hsl(280 60% 40%)",
  "hwb(120 20% 30%)",
  "lab(50% 20 30)",
  "lch(60% 40 120)",
  "oklab(0.6 0.1 -0.1)",
  "oklch(0.7 0.18 45)",
];

test("authored CSS backgrounds cross source, runtime, adapter, material and checkpoint for both button kinds", () => {
  for (const colour of colours) {
    const literal = JSON.stringify(colour);
    let session = createPlayerRuntimeSession(
      `let answer = choose yes: { text: "Yes", background: ${literal} }, no: "No"\nshowButton "Continue", background: ${literal}\nsay answer, instant`,
    );
    assert.equal(session.snapshot.status, "waiting", colour);
    assert.equal(validateInstructionPlan(session.plan).valid, true);
    assert.equal(validateRuntimeSnapshot(session.snapshot, session.plan).valid, true);
    const foreground = playerRuntimeForeground(session);
    assert.equal(foreground?.kind, "choose");
    if (foreground?.kind !== "choose") throw new Error("Expected choices");
    assert.equal(foreground.options[0]!.authoredFill, normalizeOpaqueColor(colour));
    assert.equal(foreground.options[1]!.authoredFill, undefined);
    assert.ok(storyChoiceVariables(authoredColorToOklch(foreground.options[0]!.authoredFill!)));
    const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
    assert.deepEqual(playerRuntimeForeground(restored), foreground);
    const direct = selectPlayerRuntimeChoice(session, foreground.options[0]!.id)!;
    const resumed = selectPlayerRuntimeChoice(restored, foreground.options[0]!.id)!;
    assert.equal(direct.outcome.kind, "completed");
    assert.deepEqual(resumed.session.snapshot, direct.session.snapshot);
    session = resumed.session;
    assert.deepEqual(playerRuntimeForeground(session), {
      kind: "show-button",
      label: "Continue",
      accessibleName: "Continue",
      authoredFill: normalizeOpaqueColor(colour),
    });
    const buttonRestored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
    assert.deepEqual(playerRuntimeForeground(buttonRestored), playerRuntimeForeground(session));
    assert.deepEqual(
      activatePlayerRuntimeButton(session)!.session.snapshot,
      activatePlayerRuntimeButton(buttonRestored)!.session.snapshot,
    );
    assert.equal(activatePlayerRuntimeButton(session)!.session.snapshot.status, "halted");
  }
});

test("computed choice objects preserve source evaluation order, typed matching and captured colours", () => {
  const source = `
let order = ""
function record(value) {
  order = "${"${order}"}${"${value}"}"
  return value
}
let option = { text: record("First"), background: record("red") }
let answer = choose option, { background: record("gold"), text: record("Second") }
showButton record("Continue"), background: record("blue")
say order, instant
say answer, instant
`;
  let session = createPlayerRuntimeSession(source);
  assert.equal(session.snapshot.status, "waiting");
  session = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  const submission = submitPlayerRuntimeComposer(session, "Second")!;
  assert.equal(submission.outcome.kind, "completed");
  session = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(submission.session));
  session = activatePlayerRuntimeButton(session)!.session;
  assert.equal(session.snapshot.status, "halted");
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Second", "Continue", "FirstredgoldSecondContinueblue", "Second"],
  );
});

test("invalid and transparent authored backgrounds fail statically or before publishing a computed interaction", () => {
  for (const colour of [
    "transparent",
    "#1234",
    "#12345680",
    "rgb(10 20 30 / 0.5)",
    "var(--accent)",
    "not-a-colour",
    "rood",
  ]) {
    const literal = JSON.stringify(colour);
    for (const source of [
      `showButton "Continue", background: ${literal}`,
      `let answer = choose { text: "Yes", background: ${literal} }`,
    ]) {
      assert.equal(compileSource(source).plan, null, source);
    }
    for (const source of [
      `let fill = ${literal}\nshowButton "Continue", background: fill`,
      `let fill = ${literal}\nlet answer = choose { text: "Yes", background: fill }`,
    ]) {
      const session = createPlayerRuntimeSession(source);
      assert.equal(session.snapshot.status, "failed", source);
      assert.equal(playerRuntimeForeground(session), null);
      assert.equal(validateRuntimeSnapshot(session.snapshot, session.plan).valid, true);
    }
  }
  for (const source of [
    'let answer = choose { background: "red" }',
    'let answer = choose { text: "Yes", typo: "red" }',
  ])
    assert.equal(compileSource(source).plan, null, source);
});

test("checkpoint boundaries reject altered colours and invalid plan background temporaries", () => {
  for (const source of [
    'let answer = choose yes: { text: "Yes", background: "red" }',
    'showButton "Continue", background: "red"',
  ]) {
    const session = createPlayerRuntimeSession(source);
    const restorePoint = createPlayerRuntimeRestorePoint(session);
    for (const colour of ["transparent", normalizeOpaqueColor("blue")]) {
      const checkpoint = JSON.parse(restorePoint.checkpointJson);
      const ui = checkpoint.snapshot.foregroundAction.ui;
      if (ui.kind === "button") ui.background = colour;
      else ui.options[0].background = colour;
      assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)));
    }
  }
  const session = createPlayerRuntimeSession('showButton "Continue", background: "red"');
  const plan = JSON.parse(JSON.stringify(session.plan));
  const instruction = plan.instructions.find(
    (item: { kind: string }) => item.kind === "interaction",
  );
  instruction.preparedUi.backgroundTemporary = plan.temporaryCount + 1;
  assert.equal(validateInstructionPlan(plan).valid, false);
});

test("background expressions can suspend and resume before either interaction is published", () => {
  let session = createPlayerRuntimeSession(`
function fill(value) {
  wait 1 ms
  return value
}
let answer = choose 1: { text: "First", background: fill("gold") }, 2: "Second"
showButton "Continue", background: fill("blue")
say answer, instant
`);
  assert.equal(session.snapshot.foregroundAction?.kind, "delay");
  session = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  session = observePlayerRuntimeTime(session, 10)!.session;
  const choices = playerRuntimeForeground(session);
  assert.equal(choices?.kind, "choose");
  if (choices?.kind !== "choose") throw new Error("Expected choices");
  assert.equal(choices.options[0]!.authoredFill, normalizeOpaqueColor("gold"));
  session = selectPlayerRuntimeChoice(session, choices.options[0]!.id)!.session;
  assert.equal(session.snapshot.foregroundAction?.kind, "delay");
  session = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  session = observePlayerRuntimeTime(session, 20)!.session;
  const button = playerRuntimeForeground(session);
  assert.equal(button?.kind, "show-button");
  if (button?.kind !== "show-button") throw new Error("Expected button");
  assert.equal(button.authoredFill, normalizeOpaqueColor("blue"));
  session = activatePlayerRuntimeButton(session)!.session;
  assert.equal(session.snapshot.status, "halted");
  assert.equal(session.transcriptEntries.at(-1)?.text, "1");
});

test("option objects retain static and dynamic unlabelled uniqueness rules", () => {
  assert.equal(
    compileSource('let answer = choose { text: "Same", background: "red" }, "Same"').plan,
    null,
  );
  const session = createPlayerRuntimeSession(
    'let text = "Same"\nlet answer = choose { text: text, background: "red" }, "Same"',
  );
  assert.equal(session.snapshot.status, "failed");
  assert.equal(playerRuntimeForeground(session), null);
  const plain = createPlayerRuntimeSession('let answer = choose { text: "Plain" }, "Other"');
  assert.equal(plain.snapshot.status, "waiting");
  assert.deepEqual(
    playerRuntimeForeground(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(plain))),
    playerRuntimeForeground(plain),
  );
});
