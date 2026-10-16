import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";

// `not` binds more loosely than a comparison (V30 §5), so `x == not a` has no operand after the `==`: one error names
// the code to write instead, and the rest of the script parses on.

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function sayTexts(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

const EQUAL_NOT = "'not' cannot follow '==' directly. Write 'x != a', or 'x == (not a)'.";

test("'not' right after each comparison operator is one error, and the code it names runs as the comparison meant", () => {
  // Each value pair is `x`, `a`, and the comparison with the `not` applied: to `a` after `==` and `!=`, and to the whole
  // comparison after `<`, `<=`, `>`, and `>=`, which do not compare true and false.
  const cases: [string, string, [string, string, string][]][] = [
    [
      "x == not a",
      EQUAL_NOT,
      [
        ["true", "false", "true"],
        ["true", "true", "false"],
      ],
    ],
    [
      "x != not a",
      "'not' cannot follow '!=' directly. Write 'x == a', or 'x != (not a)'.",
      [
        ["true", "true", "true"],
        ["false", "true", "false"],
      ],
    ],
    [
      "x < not a",
      "'not' cannot follow '<' directly. Write 'x >= a', or 'not (x < a)'.",
      [
        ["2", "2", "true"],
        ["1", "2", "false"],
      ],
    ],
    [
      "x <= not a",
      "'not' cannot follow '<=' directly. Write 'x > a', or 'not (x <= a)'.",
      [
        ["2", "2", "false"],
        ["3", "2", "true"],
      ],
    ],
    [
      "x > not a",
      "'not' cannot follow '>' directly. Write 'x <= a', or 'not (x > a)'.",
      [
        ["2", "2", "true"],
        ["3", "2", "false"],
      ],
    ],
    [
      "x >= not a",
      "'not' cannot follow '>=' directly. Write 'x < a', or 'not (x >= a)'.",
      [
        ["2", "2", "false"],
        ["1", "2", "true"],
      ],
    ],
  ];
  for (const [comparison, message, values] of cases) {
    assert.deepEqual(
      diagnostics(`let a = 1\nlet x = 1\nif ${comparison} {\n    say "yes", instant\n}\nexit\n`),
      [["TSP012", message, "not"]],
      comparison,
    );
    // The quoted code after 'not' and the operator.
    const written = [...message.matchAll(/'([^']+)'/g)].slice(2).map((match) => match[1]!);
    for (const [x, a, expected] of values) {
      for (const code of written) {
        assert.deepEqual(
          sayTexts(`let a = ${a}\nlet x = ${x}\nsay ${code}, instant\nexit\n`),
          [expected],
          `${code} with x = ${x}, a = ${a}`,
        );
      }
    }
  }
});

test("after 'not' right after a comparison operator, the statement and the script parse on without another error", () => {
  const forms = [
    "while x == not a {\n    x = false\n}",
    'if a {\n    say "no", instant\n} else if x == not a {\n    say "yes", instant\n}',
    "let y = x == not a\nsay y, instant",
    "function check {\n    return x == not a\n}\nsay check(), instant",
    "say x == not a, instant",
    "function same(value) {\n    return value\n}\nsay same(x == not a), instant",
    'if x == not a and true {\n    say "yes", instant\n}',
    'if x ==\n    not a {\n    say "yes", instant\n}',
    'if not x == not a {\n    say "yes", instant\n}',
  ];
  const source = (form: string) => `let a = false\nlet x = true\n${form}\nexit\n`;
  for (const form of forms) {
    assert.deepEqual(diagnostics(source(form)), [["TSP012", EQUAL_NOT, "not"]], form);
  }
  // `!` has its own error and is then read as `not`; two `not`s cancel out; a chain has its own error already.
  assert.deepEqual(diagnostics(source('if x == !a {\n    say "yes", instant\n}')), [
    ["TSP037", "TeaseScript writes 'not' instead of '!': if not a { ... }", "!"],
    ["TSP012", EQUAL_NOT, "!"],
  ]);
  assert.deepEqual(diagnostics(source('if x == not not a {\n    say "yes", instant\n}')), [
    ["TSP012", "'not' cannot follow '==' directly. Write 'x == a'.", "not"],
  ]);
  assert.deepEqual(diagnostics(source('if x == a == not x {\n    say "yes", instant\n}')), [
    ["TSP020", "Comparisons may not be chained.", "=="],
  ]);
});

test("a comparison too long to quote, or an operand with an error of its own, is named by an example", () => {
  const long =
    "let firstLongVariableName = 1\nlet secondLongVariableName = 2\nlet thirdLongName = false\n" +
    'if firstLongVariableName + secondLongVariableName < not thirdLongName {\n    say "yes", instant\n}\nexit\n';
  assert.deepEqual(diagnostics(long), [
    [
      "TSP012",
      "'not' cannot follow '<' directly. Write it as in 'x >= a', or 'not (x < a)'.",
      "not",
    ],
  ]);
  // `??` has its own error and is read as `otherwise`, so the left operand would be quoted with it.
  assert.deepEqual(
    diagnostics("let x = true\nlet a = false\nsay x ?? false == not a, instant\nexit\n"),
    [
      [
        "TSP037",
        "TeaseScript writes 'otherwise' instead of '??': let name = nickname otherwise \"pet\"",
        "??",
      ],
      [
        "TSP012",
        "'not' cannot follow '==' directly. Write it as in 'x != a', or 'x == (not a)'.",
        "not",
      ],
    ],
  );
  // The `{` of an unfinished condition starts an object literal, as after `==` alone.
  assert.ok(
    diagnostics('let x = true\nif x == not {\n    say "yes", instant\n}\nexit\n').some(
      ([, message]) =>
        message ===
        "'not' cannot follow '==' directly. Write it as in 'x != a', or 'x == (not a)'.",
    ),
  );
});
