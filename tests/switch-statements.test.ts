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
    // A function result hides the null, which assignment narrowing would otherwise know.
    "function noReply: string? { return null }",
    "let reply: string? = noReply()",
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
    "function none: number? { return null }",
    "let missing: number? = none()",
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
  const messages = compileSource(source).diagnostics.map((item) => item.message);
  assert.equal(
    messages[3],
    "The range 5..5 excludes its end, so it contains no numbers. Write case 5, or 5..=5 to include the end.",
  );
  assert.equal(
    messages[4],
    "The range 6..1 counts down, so it contains no numbers. Put the lower bound first, as in 1..6 or 1..=6.",
  );
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

test("type cases test the switched value's type and narrow the switched variable", () => {
  const source = [
    "function describe(answer: integer | string?) {",
    "  switch answer {",
    '    case null { say "none" }',
    '    case is integer { say "number ${answer + 1}" }',
    '    default { say "text ${answer.length}" }',
    "  }",
    "}",
    "function kind(value) {",
    "  switch value {",
    '    case is not integer | string { say "other" }',
    '    case is integer { say "integer" }',
    '    default { say "string" }',
    "  }",
    "}",
    "describe(null)",
    "describe(4)",
    'describe("abc")',
    "kind(true)",
    "kind(2)",
    'kind("x")',
    "kind(2.5)",
  ].join("\n");

  assert.deepEqual(says(source), [
    "none",
    "number 5",
    "text 3",
    "other",
    "integer",
    "string",
    "other",
  ]);
  // `default` knows only what the cases above did not take: here text, so `+ 1` is a type error.
  const leftover = compileSource(
    "function f(x: integer | string) {\n  switch x {\n    case is integer { }\n    default { say x + 1 }\n  }\n}",
  );
  assert.deepEqual(
    leftover.diagnostics.map((item) => item.code),
    ["TSV043"],
  );
});

test("a case that can never match is a warning that does not block the script", () => {
  const warnings = (source: string) => {
    const result = compileSource(source);
    assert.notEqual(result.plan, null, source);
    return result.diagnostics.map(
      (item) =>
        `${item.severity} ${item.code} ${item.span.start.line + 1}:${item.span.start.column + 1}`,
    );
  };
  const inFunction = (subject: string, cases: string) =>
    `function f(x: ${subject}) {\n  switch x {\n${cases}\n  }\n}`;

  assert.deepEqual(warnings(inFunction("integer", "    case is string { }")), [
    "warning TSV046 3:10",
  ]);
  assert.deepEqual(warnings(inFunction("integer", "    case is not integer { }")), [
    "warning TSV046 3:10",
  ]);
  assert.deepEqual(
    warnings(inFunction("integer | string", "    case is integer { }\n    case is integer { }")),
    ["warning TSV046 4:10"],
  );
  assert.deepEqual(
    warnings(inFunction("integer | string", "    case is integer { }\n    case 5 { }")),
    ["warning TSV046 4:10"],
  );
  assert.equal(
    compileSource(inFunction("integer | string", "    case is integer { }\n    case 5 { }"))
      .diagnostics[0]?.message,
    "'x' holds text (string) here, after the cases above, so this case never matches.",
  );
  // A value the compiler cannot know keeps every case possible.
  assert.deepEqual(
    warnings("function f(x) {\n  switch x {\n    case is integer { }\n    case 5 { }\n  }\n}"),
    [],
  );
});

test("a type case names its fix when it is not one type", () => {
  assert.deepEqual(diagnostics('switch 5 {\n  case is "open" { }\n}'), ["TSP021 2:11"]);
  assert.deepEqual(diagnostics('switch 5 {\n  case is integer, "x" { }\n}'), ["TSP038 2:18"]);
});

test("a type case block resumes after a checkpoint", () => {
  const { events, finalSnapshot } = assertRuntimeResumeEquivalent(
    [
      "function f(value) {",
      "  switch value {",
      "    case is integer {",
      "      wait 1 s",
      "      say value + 1",
      "    }",
      '    default { say "other" }',
      "  }",
      "}",
      "f(3)",
      'f("x")',
    ].join("\n"),
    { seed: 3 },
  );

  assert.deepEqual(
    events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["4", "other"],
  );
  assert.deepEqual(finalSnapshot.temporaries, []);
});
