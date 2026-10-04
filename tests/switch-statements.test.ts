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
import { validateInstructionPlan } from "../src/plan/validation.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function says(source: string): string[] {
  return sayTexts(runValidSource(source));
}

function diagnostics(source: string): string[] {
  const result = compileSource(source);
  assert.equal(result.plan, null);
  return result.diagnostics.map(
    (item) => `${item.code} ${item.span.start.line + 1}:${item.span.start.column + 1}`,
  );
}

test("runs the first case with a matching value, or default", () => {
  const source = [
    "function react(action) {",
    "  switch action {",
    '    case "open", "unlock" { say "door" }',
    '    case "leave" { say "bye" }',
    '    default { say "nothing" }',
    "  }",
    "}",
    'for action in ["open", "unlock", "leave", "dance"] { react(action) }',
    "switch (3) {",
    '  case 1 { say "never" }',
    "}",
    'say "after"',
  ].join("\n");

  assert.deepEqual(says(source), ["door", "door", "bye", "nothing", "after"]);
});

test("matches literal kinds by == and declared speakers by identity", () => {
  const source = [
    "speaker vera {}",
    "speaker guest {}",
    "let who = guest",
    'switch who { case vera { say "vera" } case guest { say "guest" } }',
    "let pause = 5 s",
    'switch pause { case 5000 ms { say "five seconds" } }',
    'switch -1 s { case -1000 ms { say "minus one second" } }',
    "let reply: string? = null",
    'switch reply { case null { say "no reply" } case "yes" { say "yes" } }',
    'switch 2.0 { case 2 { say "two" } }',
    'switch true { case false { say "off" } case true { say "on" } }',
  ].join("\n");

  assert.deepEqual(says(source), [
    "guest",
    "five seconds",
    "minus one second",
    "no reply",
    "two",
    "on",
  ]);
});

test("matches a number range by its bounds, including numbers that are not whole", () => {
  const source = [
    "for score in [-1, 0, 3.5, 4, 7.99, 8, 10, 10.5] {",
    "  switch score {",
    '    case -3..0 { say "negative" }',
    '    case 0..4 { say "low" }',
    '    case 4..8 { say "medium" }',
    '    case 8..=10 { say "high" }',
    '    default { say "out" }',
    "  }",
    "}",
  ].join("\n");

  assert.deepEqual(says(source), [
    "negative",
    "low",
    "low",
    "medium",
    "medium",
    "high",
    "high",
    "out",
  ]);
});

test("a range case never matches a value that is not a number, whatever the case order", () => {
  const source = [
    "let missing: number? = null",
    'switch missing { case 0..4 { say "low" } case null { say "none" } }',
    "function describe(value) {",
    "  switch value {",
    '    case 0..=4 { say "low" }',
    '    case "four" { say "word" }',
    '    default { say "other" }',
    "  }",
    "}",
    'describe("four")',
    "describe(true)",
    "describe(4 s)",
  ].join("\n");

  assert.deepEqual(says(source), ["none", "word", "other", "other"]);
});

test("evaluates the switched expression once and never falls through", () => {
  const source = [
    "let calls = 0",
    "function next {",
    "  calls += 1",
    "  return calls",
    "}",
    "switch next() {",
    '  case 0 { say "zero" }',
    '  case 2 { say "two" }',
    "  case 1 {",
    "    calls = 2",
    '    say "one"',
    "  }",
    '  default { say "other" }',
    "}",
    "say calls",
  ].join("\n");

  assert.deepEqual(says(source), ["one", "2"]);
});

test("case blocks resume after a checkpoint and keep return, break, and continue semantics", () => {
  const scenarios = [
    {
      source: [
        "function grade(score) {",
        "  switch score {",
        '    case 0..5 { return "low" }',
        "    case 5..=10 {",
        "      wait 1 s",
        '      return "high"',
        "    }",
        "  }",
        '  return "out of range"',
        "}",
        "say grade(3)",
        "say grade(10)",
        "say grade(11)",
      ].join("\n"),
      expected: ["low", "high", "out of range"],
    },
    {
      source: [
        "for n in 1..=5 {",
        "  switch n {",
        "    case 2 { continue }",
        "    case 4 { break }",
        "    default { wait 1 s }",
        "  }",
        "  say n",
        "}",
        'say "done"',
      ].join("\n"),
      expected: ["1", "3", "done"],
    },
  ];
  for (const { source, expected } of scenarios) {
    const { events, finalSnapshot } = assertRuntimeResumeEquivalent(source, { seed: 3 });
    assert.deepEqual(
      events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      expected,
    );
    assert.deepEqual(finalSnapshot.temporaries, []);
  }
});

test("a switch on a pending compact interaction resumes from a checkpoint", () => {
  const scenarios = [
    {
      source: [
        'switch choose "Stay", "Leave" {',
        '  case "Stay" { say "staying" }',
        '  case "Leave" { say "leaving" }',
        "}",
      ],
      interactionKind: "choice",
      payload: { kind: "selectedOption", optionIndex: 1 },
      expected: ["leaving"],
    },
    {
      source: ["switch askNumber {", '  case 0..3 { say "few" }', '  default { say "many" }', "}"],
      interactionKind: "number",
      payload: { kind: "submittedText", submittedText: "2.5" },
      expected: ["few"],
    },
  ] as const;
  for (const { source, interactionKind, payload, expected } of scenarios) {
    const plan = compileValidPlan(source.join("\n"));
    const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan));
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
    );
    const action = restored.snapshot.foregroundAction;
    assert.ok(action !== null && action.kind === "interaction");
    const answered = completeAction(restored.plan, restored.snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind,
      payload,
    });
    const finished = run(restored.plan, answered.snapshot);

    assert.equal(finished.snapshot.status, "halted");
    assert.deepEqual(sayTexts(finished), expected);
  }
});

test("a range test in an external plan fails with a structured fault unless its right operand is a range", () => {
  const plan = compileValidPlan('switch 2 { case 1..3 { say "in" } }');
  const conditional = plan.instructions.find((instruction) => instruction.kind === "jumpIfFalse");
  assert.ok(
    conditional?.kind === "jumpIfFalse" &&
      conditional.condition.kind === "binary" &&
      conditional.condition.operator === "in",
  );
  assert.equal(validateInstructionPlan(plan).valid, true);
  const malformed = structuredClone(plan);
  const malformedConditional = malformed.instructions[plan.instructions.indexOf(conditional)];
  assert.ok(
    malformedConditional?.kind === "jumpIfFalse" &&
      malformedConditional.condition.kind === "binary",
  );
  // EVIDENCE: fixture: the guard above exposes the readonly operand of this deep clone for malformed-plan input.
  (malformedConditional.condition as { right: unknown }).right = {
    kind: "literal",
    value: 3,
    span: malformedConditional.condition.span,
  };
  assert.equal(validateInstructionPlan(malformed).valid, true);
  const result = run(malformed, createImmediatePacingRuntimeSnapshot(malformed));

  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.failure?.code, "TSR035");
});

test("the block after a switch subject or cue position ends only an ungrouped compact interaction", () => {
  for (const source of [
    'switch askNumber "How many?" { case 1 {} }',
    'switch (askNumber { hint: "Number" }.hint) { case 1 {} }',
    'playAudio "a" {\n  at (askNumber { hint: "Number" }.hint) {}\n}',
  ]) {
    assert.deepEqual(compileSource(source).diagnostics, [], source);
  }
});

test("reports malformed switch structure", () => {
  assert.deepEqual(diagnostics("switch 1 {\n  default {}\n  case 1 {}\n}"), ["TSP038 3:3"]);
  assert.deepEqual(diagnostics("switch 1 {\n  case 1 {}\n  default {}\n  default {}\n}"), [
    "TSP038 4:3",
  ]);
  assert.deepEqual(diagnostics('switch 1 {\n  say "hi"\n  case 1 {}\n}'), ["TSP038 2:3"]);
  assert.deepEqual(diagnostics("switch {\n  case 1 {}\n}"), ["TSP012 1:8"]);
  assert.deepEqual(diagnostics("switch 1 {\n  case {}\n  case 2 {}\n}"), ["TSP012 2:8"]);
  // A missing `{` or clause block keeps the rest of the switch and its enclosing block intact.
  assert.deepEqual(diagnostics('if true {\n  switch 1\n    case 1 {}\n  }\n  say "inside"\n}'), [
    "TSP018 3:5",
  ]);
  assert.deepEqual(
    diagnostics('if true {\n  switch 1 {\n    case 1\n    case 2 {}\n  }\n  say "inside"\n}'),
    ["TSP018 4:5"],
  );
});

test("a function ends at a switch only when a default and every case return", () => {
  const resultType = (cases: string) =>
    compileSource(
      [
        "function grade(score) {",
        "  switch score {",
        "    case 0..5 { return 1 }",
        cases,
        "  }",
        "}",
        "let text: string = grade(3)",
      ].join("\n"),
    ).diagnostics.map((item) => item.message);

  // The mismatch message names the function's result type, which is nullable only when it may end without `return`.
  assert.match(resultType("    default { return 2 }").join(), /a whole number \(integer\)\. /);
  assert.match(
    resultType("    case 5..=10 { return 2 }").join(),
    /a whole number \(integer\) or null\./,
  );
});

test("rejects case values that are not literals, speakers, or number ranges", () => {
  const source = [
    "let limit = 3",
    "switch limit {",
    "  case limit {}",
    "  case limit + 1 {}",
    "  case 1..limit {}",
    "  case 5..5 {}",
    "  case 6..1 {}",
    "}",
    'switch "a" {',
    '  case "${limit}" {}',
    "}",
  ].join("\n");

  assert.deepEqual(diagnostics(source), [
    "TSV047 3:8",
    "TSV047 4:8",
    "TSV047 5:8",
    "TSV047 6:8",
    "TSV047 7:8",
    "TSV047 10:8",
  ]);
});

test("rejects repeated and overlapping case values on the later value", () => {
  const source = [
    "speaker vera {}",
    "function check(value) {",
    "  switch value {",
    '    case "a", "b" {}',
    '    case "a" {}',
    "    case 1..5 {}",
    "    case 4 {}",
    "    case 2.0, 2 {}",
    "    case 0..=1 {}",
    "    case 5..8 {}",
    "    case 7..=9 {}",
    "    case vera, vera {}",
    "    case -1 s, -1000 ms {}",
    "  }",
    "}",
  ].join("\n");

  assert.deepEqual(diagnostics(source), [
    "TSV048 5:10",
    "TSV048 7:10",
    "TSV048 8:10",
    "TSV048 8:15",
    "TSV048 9:10",
    "TSV048 11:10",
    "TSV048 12:16",
    "TSV048 13:16",
  ]);
  const message = compileSource(source).diagnostics.find((item) => item.span.start.line === 6);
  assert.equal(
    message?.message,
    "The case value 4 overlaps 1..5 on line 6. Each value may match only one case; change or remove one of them.",
  );
});

test("a speaker case is a speaker even in a function called before the speaker is declared", () => {
  const source = [
    "speaker vera {}",
    "function greet {",
    "  switch vera {",
    '    case guest { say "guest" }',
    '    default { say "vera" }',
    "  }",
    "}",
    "if false { greet() }",
    "speaker guest {}",
    "greet()",
  ].join("\n");

  assert.deepEqual(says(source), ["vera"]);
  assert.deepEqual(diagnostics("speaker vera {}\nswitch 1 { case vera {} }"), ["TSV049 2:17"]);
});

test("rejects case values whose type can never match the switched value's known type", () => {
  const source = [
    "speaker vera {}",
    "let count = 3",
    'let mood = "calm"',
    "switch count {",
    '  case "3" {}',
    "  case null {}",
    "  case vera {}",
    "  case 3.0 {}",
    "}",
    "switch mood {",
    "  case 1..5 {}",
    "  case true {}",
    "}",
  ].join("\n");

  assert.deepEqual(diagnostics(source), [
    "TSV049 5:8",
    "TSV049 6:8",
    "TSV049 7:8",
    "TSV049 11:8",
    "TSV049 12:8",
  ]);
  assert.equal(
    compileSource(source).diagnostics[0]?.message,
    "This case can never match: 'count' is a whole number (integer), but \"3\" is text (string). " +
      "Use a case value of the same type.",
  );
});
