import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";

// The `{` after a block head, such as the condition of an `if`, starts the block. A head that stops at it, as
// `if x == {`, lacks its last value: one error at the `{` names the operator, and the block and the rest of the script
// parse as usual. A `{` there starts an object literal only when the literal cannot be the block.

function diagnostics(source: string): [string, string, number][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    diagnostic.span.start.offset,
  ]);
}

function sayTexts(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

const missing = (symbol: string) =>
  `Expected a value after '${symbol}': the '{' that follows starts the block. Write the value before the '{'.`;

const source = (form: string) =>
  `let a = true\nlet x = 1\nlet xs = [1]\n${form}\nsay "after", instant\nexit\n`;

/** The one error of `form`, at the `{` that ends `head`. */
function assertOneError(form: string, head: string, code: string, message: string): void {
  const written = source(form);
  const brace = written.indexOf(head) + head.length - 1;
  assert.equal(written[brace], "{", head);
  assert.deepEqual(diagnostics(written), [[code, message, brace]], form);
}

test("a head that stops at the '{' of its block is one error that names the operator, and the block parses as usual", () => {
  const body = ' {\n    say "yes", instant\n}';
  const forms: [string, string, string][] = [
    [`if x ==${body}`, "if x == {", "=="],
    [`if x <${body}`, "if x < {", "<"],
    [`if not${body}`, "if not {", "not"],
    [`if x == not${body}`, "if x == not {", "not"],
    [`if a otherwise not${body}`, "if a otherwise not {", "not"],
    [`if a otherwise${body}`, "if a otherwise {", "otherwise"],
    [`if a and${body}`, "if a and {", "and"],
    [`if a or${body}`, "if a or {", "or"],
    [`if not x ==${body}`, "if not x == {", "=="],
    [`if a and x ==${body}`, "if a and x == {", "=="],
    [`if x == x +${body}`, "if x == x + {", "+"],
    [`if x == -${body}`, "if x == - {", "-"],
    ["while x == {\n    x = 2\n}", "while x == {", "=="],
    [`repeat x *${body}`, "repeat x * {", "*"],
    [`for item in xs +${body}`, "for item in xs + {", "+"],
    [
      'if a {\n    say "no", instant\n} else if x == {\n    say "yes", instant\n}',
      "else if x == {",
      "==",
    ],
    [`if x ==${body} else {\n    say "no", instant\n}`, "if x == {", "=="],
    [`if x ==${body}\nelse {\n    say "no", instant\n}`, "if x == {", "=="],
    [
      'switch x == {\n    case true {\n        say "yes", instant\n    }\n    default {\n        say "no", instant\n    }\n}',
      "switch x == {",
      "==",
    ],
    [`if x ==\n    {\n    say "yes", instant\n}`, "if x ==\n    {", "=="],
    // An empty block is the block too, as the head ends with it.
    ["if x == {}", "if x == {", "=="],
    ["if x == {\n}", "if x == {", "=="],
    [
      'if a {\n    if x == {\n        say "yes", instant\n    }\n    say "still", instant\n}',
      "if x == {",
      "==",
    ],
  ];
  for (const [form, head, symbol] of forms) assertOneError(form, head, "TSP012", missing(symbol));
  assertOneError(
    `if x is${body}`,
    "if x is {",
    "TSP021",
    "Expected a type such as string, integer, number, boolean, duration, or a list type such as string[].",
  );
  // `&&` has its own error and is read as `and`.
  assert.deepEqual(
    diagnostics(source(`if a &&${body}`)).map(([code, message]) => [code, message]),
    [
      [
        "TSP037",
        "TeaseScript writes 'and' with a space on each side instead of '&&': if a and b { say \"both\" }",
      ],
      ["TSP012", missing("and")],
    ],
  );
});

test("a value missing after nested operators is one error, also where no block follows", () => {
  const forms: [string, string][] = [
    ["let y = a and x ==", "Expected an expression after the comparison operator."],
    ["let y = not not", "Expected an expression after 'not'."],
    ["let y = - -", "Expected an expression after the unary operator."],
  ];
  for (const [form, message] of forms) {
    const written = source(form);
    assert.deepEqual(
      diagnostics(written),
      [["TSP012", message, written.indexOf('say "after"')]],
      form,
    );
  }
});

test("the '{' of an object literal in a head stays a value, so a comparison with one compiles and runs", () => {
  const forms = [
    'if door == { open: true } {\n    say "yes", instant\n}',
    'if door == {\n    open: true\n} {\n    say "yes", instant\n}',
    'if door == { open: true }\n{\n    say "yes", instant\n}',
    'if box == {} {\n    say "yes", instant\n}',
    'if box == {}\n{\n    say "yes", instant\n}',
    'if { open: true }.open {\n    say "yes", instant\n}',
    'if door != { open: false } and door.open {\n    say "yes", instant\n}',
    'while door != { open: false } {\n    door = { open: false }\n    say "yes", instant\n}',
    'switch door == { open: true } {\n    case true {\n        say "yes", instant\n    }\n}',
    'repeat { times: 1 }.times {\n    say "yes", instant\n}',
  ];
  for (const form of forms)
    assert.deepEqual(
      sayTexts(`let door = { open: true }\nlet box = {}\n${form}\nexit\n`),
      ["yes"],
      form,
    );
});

test("a permanent button's text or a cue position that stops at its block is one error", () => {
  const button = 'showPermanentButton "Stop" + {\n    say "x", instant\n}';
  assertOneError(button, '"Stop" + {', "TSP012", missing("+"));
  assertOneError(
    'showPermanentButton {\n    say "x", instant\n}',
    "showPermanentButton {",
    "TSP028",
    "Expected button text after 'showPermanentButton'.",
  );
  assertOneError(
    'playAudio "a" {\n    at 1 s + {\n        say "x", instant\n    }\n}',
    "at 1 s + {",
    "TSP012",
    missing("+"),
  );
  // A button inside a list or a call ends at the grouping's closer.
  for (const form of [
    'let buttons = [showPermanentButton "Stop" + { say "x", instant }]',
    'function keep(id) {\n    return id\n}\nlet button = keep(showPermanentButton "Stop" + { say "x", instant })',
  ])
    assertOneError(form, '"Stop" + {', "TSP012", missing("+"));
});
