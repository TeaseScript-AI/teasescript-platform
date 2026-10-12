import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";

// `a otherwise b` (V30 §18, #850) gives `a`, or `b` when `a` is null, and evaluates `b` only then.

/** Hides a value's type from the compiler, so that a variable declared with `?` may really hold null. */
const HIDE = "function hide(value) {\n    return value\n}\n";

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function sayTexts(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return said(result.events);
}

function diagnostics(source: string): [string, string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

test("otherwise gives the value unless it is null, and runs the fallback only then", () => {
  assert.deepEqual(
    sayTexts(
      `${HIDE}let calls = 0
function bump {
    calls += 1
    return 9
}
let missing: integer? = hide(null)
let found: integer? = hide(4)
say null otherwise 1 == 1
say found otherwise 1 == 4
say missing otherwise bump()
say found otherwise bump()
say calls
// A fallback evaluated in place, which would fail here, as one that runs as instructions.
let marks = hide([7])
say found otherwise marks[9]
say missing otherwise marks[0]
exit`,
    ),
    ["true", "true", "9", "4", "1", "4", "7"],
  );
});

test("a fallback that is not null makes the result not null", () => {
  // An integer? with a fallback is an integer, without a check; with a null fallback it stays optional.
  assert.deepEqual(
    sayTexts(
      `${HIDE}let lives: integer? = hide(null)
let left: integer = lives otherwise 3
say left + 1
say (lives otherwise 0) * 2
exit`,
    ),
    ["4", "0"],
  );
  assert.deepEqual(
    diagnostics(
      `${HIDE}let name: string? = hide(null)\nlet shown = name otherwise null\nsay shown + "!"\nexit`,
    ),
    [
      [
        "error",
        "TSV043",
        `'shown' may be null. Check it first: if shown != null { ... }, or give a fallback: shown otherwise ""`,
        "shown",
      ],
    ],
  );
  // A fallback of another type gives a union, which needs a test before an operation of one type.
  assert.deepEqual(
    diagnostics(
      `${HIDE}let name: string? = hide(null)\nlet shown = name otherwise 0\nsay shown + 1\nexit`,
    )[0]?.slice(1, 3),
    ["TSV043", "'shown' may be text (string). Check it first: if shown is integer { ... }"],
  );
});

test("a fallback that may run ends a narrowing that it may change, and one that never runs ends none", () => {
  const source = (value: string) =>
    `${HIDE}let count: integer? = hide(1)
let other: integer? = hide(null)
function reset {
    count = null
    return 0
}
if count != null {
    let result = ${value} otherwise reset()
    say count + 1
}
exit`;
  assert.deepEqual(
    diagnostics(source("other")).map((diagnostic) => diagnostic.slice(1, 3)),
    [
      [
        "TSV043",
        "'count' may be null. Check it first: if count != null { ... }, or give a fallback: count otherwise 0",
      ],
    ],
  );
  assert.deepEqual(
    diagnostics(source("count")).map((diagnostic) => diagnostic[1]),
    ["TSV062"],
  );
});

test("a chain gives the first value that is not null, from left to right", () => {
  const source = (nickname: string, saved: string) =>
    `${HIDE}let tried = []
function note(given, step) {
    tried.add(step)
    return given
}
let nickname: string? = hide(${nickname})
let saved: string? = hide(${saved})
let name = note(nickname, 1) otherwise note(saved, 2) otherwise note("pet", 3)
say "\${name} \${tried.join("")}"
exit`;
  assert.deepEqual(sayTexts(source('"Bo"', '"Al"')), ["Bo 1"]);
  assert.deepEqual(sayTexts(source("null", '"Al"')), ["Al 12"]);
  assert.deepEqual(sayTexts(source("null", "null")), ["pet 123"]);
});

test("otherwise beside arithmetic or a range needs parentheses, and one error names both readings", () => {
  const cases: [string, string, string][] = [];
  for (const operator of ["+", "-", "*", "/", "%"])
    cases.push(
      [
        `a otherwise 3 ${operator} 2`,
        `(a otherwise 3) ${operator} 2`,
        `a otherwise (3 ${operator} 2)`,
      ],
      [
        `3 ${operator} a otherwise 2`,
        `3 ${operator} (a otherwise 2)`,
        `(3 ${operator} a) otherwise 2`,
      ],
    );
  cases.push(
    ["-a otherwise 2", "-(a otherwise 2)", "(-a) otherwise 2"],
    ["+a otherwise 2", "+(a otherwise 2)", "(+a) otherwise 2"],
    ["a otherwise 1..=3", "(a otherwise 1)..=3", "a otherwise (1..=3)"],
    ["1..a otherwise 3", "1..(a otherwise 3)", "(1..a) otherwise 3"],
    // Both sides, a chain, and the issue's own example: the error quotes what was written.
    ["2 * a otherwise 3 + 1", "2 * (a otherwise 3) + 1", "(2 * a) otherwise (3 + 1)"],
    [
      "a otherwise b otherwise 3 + 1",
      "(a otherwise b otherwise 3) + 1",
      "a otherwise b otherwise (3 + 1)",
    ],
    [
      'path.lastIndexOf("/") otherwise -1 + 1',
      '(path.lastIndexOf("/") otherwise -1) + 1',
      'path.lastIndexOf("/") otherwise (-1 + 1)',
    ],
  );
  for (const [written, nearest, all] of cases)
    assert.deepEqual(
      diagnostics(
        `${HIDE}let a: integer? = hide(null)\nlet b: integer? = hide(null)\nlet path = "a/b"\nsay ${written}\nexit`,
      ),
      [
        [
          "error",
          "TSP041",
          `Put parentheses around what 'otherwise' belongs to: '${nearest}' or '${all}'.`,
          "otherwise",
        ],
      ],
      written,
    );
  // A reading too long to quote is named by an example.
  assert.deepEqual(
    diagnostics(
      'let a: string? = null\nsay a otherwise "a fallback long enough to need a generic text" + "!"\nexit',
    ).map((diagnostic) => diagnostic[2]),
    [
      "Put parentheses around what 'otherwise' belongs to, as in '(count otherwise 0) + 1' or 'count otherwise (0 + 1)'.",
    ],
  );
});

test("otherwise needs no parentheses beside comparisons, not, and, or, in a chain, and before a sign or a unit", () => {
  assert.deepEqual(
    sayTexts(
      `${HIDE}let path = "a/b/c"
let count: integer? = hide(null)
let nickname: string? = hide(null)
let ready: boolean? = hide(null)
let delay: duration? = hide(null)
say path.lastIndexOf("/") otherwise -1
say "abc".lastIndexOf("/") otherwise -1
say nickname otherwise "pet" == "pet"
say count otherwise "none" is string
say not ready otherwise false
say ready otherwise true and count otherwise 0 == 0
say ready otherwise false or nickname otherwise "" != ""
say delay otherwise 5 s == 5 s
say nickname otherwise count otherwise "you"
say "\${nickname otherwise "you"} \${count otherwise 0}"
exit`,
    ),
    ["3", "-1", "true", "true", "true", "true", "false", "true", "you", "you 0"],
  );
});

test("with parentheses, either reading compiles and runs as written", () => {
  assert.deepEqual(
    sayTexts(
      `${HIDE}let five: integer? = hide(5)
let known = hide(4)
let none = hide(null)
say (five otherwise 3) + 2
say five otherwise (3 + 2)
say (five otherwise 3) / 2
say five otherwise (3 / 2)
say 2 * (known otherwise 5)
say (2 * known) otherwise 5
say -(none otherwise 1)
say (-known) otherwise 1
let total = 0
for step in (none otherwise 1)..=3 {
    total += step
}
for step in none otherwise (1..=2) {
    total += step * 10
}
say total
exit`,
    ),
    ["7", "5", "2.5", "5", "8", "8", "-1", "-4", "36"],
  );
});

test("a null check also names a fallback of the value's type, but not for a value that is changed", () => {
  const messages = (source: string) =>
    compileSource(`${HIDE}${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.message);
  const check = (name: string, fallback?: string) =>
    `'${name}' may be null. Check it first: if ${name} != null { ... }${fallback === undefined ? "" : `, or give a fallback: ${name} otherwise ${fallback}`}`;
  for (const [declared, use, fallback] of [
    ["integer", "say n + 1", "0"],
    ["number", "say n * 2", "0"],
    ["string", 'say n + "!"', '""'],
    ["boolean", "if n {\n    say 1\n}", "false"],
    ["duration", "wait n", "..."],
    ["integer[]", "say n.count()", "..."],
  ] as const)
    assert.deepEqual(
      messages(`let n: ${declared}? = hide(null)\n${use}`),
      [check("n", fallback)],
      use,
    );
  // A value that is not a variable, and a store into a narrower place.
  assert.deepEqual(messages('say "a/b".lastIndexOf("/") + 1'), [
    "This value may be null. Keep it in a variable and check it first, as in: if value != null { ... }, or give a fallback: value otherwise 0",
  ]);
  assert.deepEqual(messages("let n: integer? = hide(null)\nlet m: integer = n"), [
    "'m' is declared as integer, so it cannot start as a whole number (integer) or null. Check it first: if n != null { ... }, or give a fallback: n otherwise 0",
  ]);
  // A fallback would be a copy, so a value that an assignment or a method changes gets only the check, and so does a
  // handle, for which no fallback can be written.
  for (const source of [
    'let p: object? = hide({ name: "a" })\np.name = "b"',
    "let n: integer[]? = hide([1])\nn[0] = 2",
    "let n: integer? = hide(1)\nn += 1",
    "let n: integer[]? = hide([1])\nn.add(2)",
    "let n: integer[]? = hide([1])\nn.sort()",
    'let n = null\nlet x = true\nif x {\n    n = playAudio async "a.mp3"\n}\nn.stop()',
  ])
    assert.deepEqual(messages(source), [check(source.includes("p.name") ? "p" : "n")], source);
});

test("a fallback that asks waits only for a null value, also across a checkpoint and restore", () => {
  const source = (nickname: string) =>
    `${HIDE}let nickname: string? = hide(${nickname})
let name = nickname otherwise askText "Name?"
say "Hi \${name}"
exit`;
  assert.deepEqual(sayTexts(source('"Bo"')), ["Hi Bo"]);

  const plan = compileValidPlan(source("null"));
  const answer = (snapshot: RuntimeSnapshot, plan: InstructionPlan) => {
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction");
    const completed = completeAction(plan, snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: action.interactionKind,
      payload: { kind: "submittedText", submittedText: "Alex" },
    });
    assert.equal(completed.outcome.kind, "completed");
    const finished = run(plan, completed.snapshot);
    assert.equal(finished.snapshot.status, "halted");
    return [...completed.events, ...finished.events];
  };
  const asking = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(asking.snapshot.foregroundAction?.kind, "interaction");
  const uninterrupted = answer(asking.snapshot, plan);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, asking.snapshot)),
  );
  assert.deepEqual(restored.snapshot, asking.snapshot);
  const resumed = answer(restored.snapshot, restored.plan);
  assert.deepEqual(resumed, uninterrupted);
  assert.deepEqual(said([...asking.events, ...resumed]), ["Name?", "Hi Alex"]);
});

test("a fallback that runs as instructions resumes at every boundary", () => {
  for (const missing of ["null", "2"])
    assertRuntimeResumeEquivalent(
      `${HIDE}function twice(n) {
    return n * 2
}
let count: integer? = hide(${missing})
let result = count otherwise twice(4)
say result
exit`,
    );
});

test("&&, ||, !, and ?? each give one error that names the word, and parsing goes on with the word", () => {
  const symbol = (word: string, written: string, example: string) => [
    "error",
    "TSP037",
    `TeaseScript writes '${word}' instead of '${written}': ${example}`,
    written,
  ];
  const and = symbol("and", "&&", "if a and b { ... }");
  const or = symbol("or", "||", "if a or b { ... }");
  const not = symbol("not", "!", "if not a { ... }");
  const otherwise = symbol("otherwise", "??", 'let name = nickname otherwise "pet"');
  for (const [source, expected] of [
    ['let a = true\nlet b = false\nif a && b { say "x" }\nexit', [and]],
    ['let a = true\nif a || false { say "x" }\nexit', [or]],
    ['let a = true\nif !a { say "x" }\nexit', [not]],
    [`${HIDE}let a: integer? = hide(null)\nlet b = a ?? 0\nexit`, [otherwise]],
    // In an interpolation, a quote after the symbol starts a string, as after the word.
    [
      `${HIDE}let a: string? = hide(null)\nsay "\${a ?? "pet"} \${a || "x"} \${a && "y"} \${!a}"\nexit`,
      [otherwise, or, and, not],
    ],
    // `!=` stays the comparison, and `?` stays the optional type next to `??`.
    [
      `${HIDE}let a: string? = hide(null)\nlet b: string? = a ?? "x"\nsay a != b\nexit`,
      [otherwise],
    ],
    // Wherever the word may stand: a command's operand, a negated type test, and a line continued after the symbol.
    ["let answer = askText !true\nsay !answer\nexit", [not, not]],
    ['let value = 1\nif value is !string { say "whole" }\nexit', [not]],
    [
      'let value: integer | string = 1\nswitch value {\n    case is !string { say "whole" }\n    default { say "text" }\n}\nexit',
      [not],
    ],
    [
      'playAudio "song.mp3" {\n    at null ??\n        1 s { say "cue" }\n    at 1 s &&\n        2 s { say "cue" }\n}\nexit',
      [otherwise, and],
    ],
  ] as const)
    assert.deepEqual(diagnostics(source), expected, source);
});

test("a value the compiler knows is never null gets TSV062, which names the fallback to remove", () => {
  const unused = (subject: string, fix: string, plural = false) =>
    `${subject} is never null here, so ${plural ? "the fallbacks after 'otherwise' are" : "the fallback after 'otherwise' is"} never used. ${fix}`;
  assert.deepEqual(diagnostics("let count = 5\nsay count otherwise 0\nexit"), [
    ["warning", "TSV062", unused("'count'", "Remove 'otherwise 0'."), "otherwise 0"],
  ]);
  // A value narrowed by a check counts as not null.
  assert.deepEqual(
    diagnostics(
      'let pos = "a/b".lastIndexOf("/")\nif pos != null {\n    say pos otherwise 0\n}\nexit',
    ),
    [["warning", "TSV062", unused("'pos'", "Remove 'otherwise 0'."), "otherwise 0"]],
  );
  // In a chain, the first 'otherwise' whose left side can no longer be null, with every fallback after it.
  assert.deepEqual(
    diagnostics(
      `${HIDE}let nickname: string? = hide(null)\nsay nickname otherwise "pet" otherwise "x" otherwise false\nexit`,
    ),
    [
      [
        "warning",
        "TSV062",
        unused(`'nickname otherwise "pet"'`, `Remove 'otherwise "x" otherwise false'.`, true),
        'otherwise "x" otherwise false',
      ],
    ],
  );
  // A fallback that the message cannot quote is named by its place.
  assert.deepEqual(
    diagnostics('let count = 5\nsay count otherwise "${count} is not a fallback"\nexit')[0]?.[2],
    unused("'count'", "Remove 'otherwise' and the fallback after it."),
  );
  // An element read by index fails instead of giving null, so the warning names get with a default.
  assert.deepEqual(
    diagnostics(
      'let items = [1, 2]\nlet toys = dict{ a: "rope" }\nlet key = "b"\nsay items[5] otherwise 0\nsay toys[key] otherwise "none"\nexit',
    ).map((diagnostic) => diagnostic[2]),
    [
      unused(
        "'items[5]'",
        "Reading a position the list does not have is an error, not null. For a fallback there, write 'items.get(5, default: 0)'.",
      ),
      unused(
        "'toys[key]'",
        `Reading a key the dict does not have is an error, not null. For a fallback there, write 'toys.get(key, default: "none")'.`,
      ),
    ],
  );
});

test("a value that may be null, or whose type the compiler cannot know, gets no TSV062", () => {
  for (const source of [
    `${HIDE}let count: integer? = hide(null)\nsay count otherwise 0`,
    // A parameter without a type, a loaded value without one, and an undecided element.
    "function shown(value) {\n    return value otherwise 0\n}\nsay shown(null)",
    'let key = "lvl"\nsay load(key, default: 1) otherwise 0',
    "let empty = []\nsay empty[0] otherwise 0",
    // A list whose elements may be null.
    "let marks: (integer?)[] = [1, null]\nsay marks[1] otherwise 0",
  ])
    assert.deepEqual(diagnostics(`${source}\nexit`), [], source);
});

test("otherwise is a keyword that cannot name a variable but still names a property", () => {
  assert.deepEqual(
    diagnostics("let otherwise = 1\nexit").map((diagnostic) => diagnostic[1]),
    ["TSP013"],
  );
  assert.deepEqual(sayTexts("let choice = { otherwise: 2 }\nsay choice.otherwise\nexit"), ["2"]);
});
