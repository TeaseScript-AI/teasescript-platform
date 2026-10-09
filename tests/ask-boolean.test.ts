import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  restorePlayerRuntimeSession,
  selectPlayerRuntimeChoice,
  submitPlayerRuntimeComposer,
  submitPlayerRuntimeForm,
  type PlayerRuntimeSession,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import { compileSource } from "../src/compiler.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

const PRELUDE = 'speaker mistress {\n  name: "M"\n}\nfunction question { return "Dynamic?" }\n';

/** The labels of the open buttons. */
function buttons(session: PlayerRuntimeSession): readonly string[] {
  const foreground = playerRuntimeForeground(session);
  assert.equal(foreground?.kind, "choose");
  return foreground.options.map((option) => option.label);
}

/** Chooses the open button with `label`. */
function choose(session: PlayerRuntimeSession, label: string): PlayerRuntimeSession {
  const foreground = playerRuntimeForeground(session);
  assert.equal(foreground?.kind, "choose");
  const option = foreground.options.find((candidate) => candidate.label === label);
  assert.ok(option !== undefined, label);
  const result = selectPlayerRuntimeChoice(session, option.id);
  assert.equal(result?.outcome.kind, "completed", label);
  return result!.session;
}

/** The latest transcript entry as `speaker: text`. */
function last(session: PlayerRuntimeSession): string {
  const entry = session.transcriptEntries.at(-1);
  assert.equal(entry?.kind, "message");
  return `${session.speakers[entry.speakerId]?.name ?? entry.speakerId}: ${entry.text}`;
}

test("askBoolean says its question, shows Yes and No or its own texts, and returns the chosen boolean", () => {
  let session = createPlayerRuntimeSession(
    [
      PRELUDE,
      'let ready = askBoolean as mistress "Ready?"',
      'if askBoolean "Again?" {\n    say "again", instant\n}',
      'let sure = askBoolean("Sure?", yesText: "Sure!", noText: "No, thanks")',
      'say "${ready} ${sure}", instant',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual([last(session), buttons(session)], ["mistress: Ready?", ["Yes", "No"]]);
  session = choose(session, "Yes");
  assert.deepEqual([last(session), buttons(session)], ["Narrator: Again?", ["Yes", "No"]]);
  session = choose(session, "No");
  assert.deepEqual(buttons(session), ["Sure!", "No, thanks"]);
  session = choose(session, "No, thanks");
  assert.equal(session.state.status, "halted");
  // Each answer is the chosen button's text; `if` skipped its block for No.
  assert.deepEqual(
    session.transcriptEntries.slice(-6).map((entry) => entry.text),
    ["Yes", "Again?", "No", "Sure?", "No, thanks", "true false"],
  );
});

test("compact and parenthesized askBoolean and askBooleans compile to the same plan", () => {
  const program = (source: string) =>
    JSON.stringify(compileValidPlan(`${PRELUDE}${source}\nexit`), (key: string, value: unknown) =>
      key === "span" || key === "sourceSpan" ? undefined : value,
    );
  const plan = (expression: string) => program(`let result = ${expression}`);
  for (const [bounded, compact] of [
    ["askBoolean()", "askBoolean"],
    ['askBoolean("Ready?")', 'askBoolean "Ready?"'],
    [
      'askBoolean as mistress (\n    "Ready?",\n    yesText: "Sure!", noText: "No"\n)',
      'askBoolean as mistress "Ready?",\n    yesText: "Sure!", noText: "No"',
    ],
    ['askBoolean(question(), noText: "Nope")', 'askBoolean question(), noText: "Nope"'],
    [
      'askBooleans("Which?", texts: ["A", "B"], prefill: [true, false], cancel: "Back")',
      'askBooleans "Which?", texts: ["A", "B"], prefill: [true, false], cancel: "Back"',
    ],
    [
      'askBooleans as mistress (message: question(), texts: ["A"], prefill: [true])',
      'askBooleans as mistress message: question(), texts: ["A"], prefill: [true]',
    ],
  ])
    assert.equal(plan(bounded!), plan(compact!), bounded);
  // The block's `{` ends a compact ask without a question in the head of a block statement.
  for (const head of ["if askBoolean", "while askBoolean", "repeat askInteger"]) {
    const block = (ask: string) => program(`${ask} {\n    say "Again", instant\n}`);
    assert.equal(block(`${head}()`), block(head), head);
  }

  const errors = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.message);
  assert.deepEqual(errors('let a = askBoolean "Q", message: "M"'), [
    "askBoolean has a question and 'message:'. Keep one.",
  ]);
  assert.deepEqual(errors('let a = askBoolean "Q", yes: "Sure"'), [
    "Unknown askBoolean option 'yes'. Use 'yesText:', 'noText:', 'prefill:', 'message:'.",
  ]);
  assert.deepEqual(errors('let a = askBoolean "Q", yesText: ["Sure"]'), [
    'A list cannot be a button text. Select one element with "${list}" or list.random.',
  ]);
  assert.deepEqual(errors('let a = askBooleans "Q", texts: ["A"]'), [
    `askBooleans needs prefill:, as in 'askBooleans "Choose", texts: ["A", "B"], prefill: [true, false]'.`,
  ]);
});

test("askBoolean evaluates runtime operands once, in written order, and keeps its buttons across a restore", () => {
  let session = createPlayerRuntimeSession(
    [
      'let a = askBoolean(noText: askText("No text?"), message: askText("Question?"))',
      'say "${a}", instant',
      "exit",
    ].join("\n"),
  );
  for (const text of ["Nope", "Ready?"]) {
    const result = submitPlayerRuntimeComposer(session, text);
    assert.equal(result?.outcome.kind, "completed", text);
    session = result!.session;
  }
  assert.deepEqual([last(session), buttons(session)], ["Narrator: Ready?", ["Yes", "Nope"]]);
  const restored = restorePlayerRuntimeSession(
    JSON.parse(JSON.stringify(createPlayerRuntimeRestorePoint(session))),
  );
  assert.deepEqual(playerRuntimeForeground(restored), playerRuntimeForeground(session));
  const direct = choose(session, "Nope");
  const resumed = choose(restored, "Nope");
  assert.equal(resumed.state.status, "halted");
  assert.deepEqual(playerRuntimeSnapshot(resumed), playerRuntimeSnapshot(direct));
  assert.deepEqual(resumed.transcriptEntries, direct.transcriptEntries);
  assert.equal(resumed.transcriptEntries.at(-1)?.text, "false");
});

test("a for loop goes through the answers of askBooleans in both forms", () => {
  for (const ask of [
    'askBooleans("Choose", texts: ["A", "B"], prefill: [true, false])',
    'askBooleans "Choose", texts: ["A", "B"], prefill: [true, false]',
  ]) {
    const session = createPlayerRuntimeSession(
      `for value in ${ask} {\n    say "\${value}", instant\n}\nexit`,
    );
    const result = submitPlayerRuntimeForm(session);
    assert.equal(result?.outcome.kind, "completed", ask);
    assert.equal(result!.session.state.status, "halted", ask);
    assert.deepEqual(
      result!.session.transcriptEntries.slice(-2).map((entry) => entry.text),
      ["true", "false"],
      ask,
    );
  }
});

test("askBooleans may stand alone as a statement in both forms, and its answers are dropped", () => {
  for (const ask of [
    'askBooleans("Choose", texts: ["A", "B"], prefill: [true, false])',
    'askBooleans "Choose", texts: ["A", "B"], prefill: [true, false]',
  ]) {
    const session = createPlayerRuntimeSession(`${ask}\nsay "done", instant\nexit`);
    const restored = restorePlayerRuntimeSession(
      JSON.parse(JSON.stringify(createPlayerRuntimeRestorePoint(session))),
    );
    const direct = submitPlayerRuntimeForm(session);
    const resumed = submitPlayerRuntimeForm(restored);
    assert.equal(resumed?.session.state.status, "halted", ask);
    assert.deepEqual(
      playerRuntimeSnapshot(resumed!.session),
      playerRuntimeSnapshot(direct!.session),
      ask,
    );
    assert.deepEqual(
      resumed!.session.transcriptEntries.map((entry) => entry.text),
      ["Choose", "✓ A, ✗ B", "done"],
      ask,
    );
  }
});
