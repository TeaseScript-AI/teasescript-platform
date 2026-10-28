import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";

// `not` binds more loosely than a comparison, `otherwise`, arithmetic, and a range (V30 §5), so `x == not a` has no
// operand after the `==`: one error names the code to write instead, and the rest of the script parses on.

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

// A `!` there names no code to paste in its place, which the error for the `not` gives.
const BANG_AFTER_OPERATOR =
  "TeaseScript uses 'not' instead of '!', but 'not' cannot directly follow the operator before the '!'.";

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
    ["TSP037", BANG_AFTER_OPERATOR, "!"],
    ["TSP012", EQUAL_NOT, "!"],
  ]);
  assert.deepEqual(diagnostics(source('if x == not not a {\n    say "yes", instant\n}')), [
    ["TSP012", "'not' cannot follow '==' directly. Write 'x == a'.", "not"],
  ]);
  assert.deepEqual(diagnostics(source('if x == a == not x {\n    say "yes", instant\n}')), [
    ["TSP020", "Comparisons may not be chained.", "=="],
  ]);
});

test("a comparison too long to quote, an operand with an error of its own, or an otherwise, is named by an example", () => {
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
        "TeaseScript writes 'otherwise' with a space on each side instead of '??': let name = nickname otherwise \"pet\"",
        "??",
      ],
      [
        "TSP012",
        "'not' cannot follow '==' directly. Write it as in 'x != a', or 'x == (not a)'.",
        "not",
      ],
    ],
  );
  // Quoted, `x otherwise false != a` would need parentheses too, which their own error names, and the readings of
  // `otherwise` would hold the `not`.
  assert.deepEqual(
    diagnostics(
      "let x: boolean? = null\nlet a = false\nsay x otherwise false == not a, instant\nexit\n",
    ),
    [
      [
        "TSP012",
        "'not' cannot follow '==' directly. Write it as in 'x != a', or 'x == (not a)'.",
        "not",
      ],
      [
        "TSP041",
        "It is unclear what 'otherwise' belongs to. Put parentheses around what to work out first.",
        "otherwise",
      ],
    ],
  );
});

const OTHERWISE_NOT = "'not' cannot follow 'otherwise' directly. Write 'a otherwise (not b)'.";

test("'not' right after 'otherwise' is one error, and the code it names runs as the fallback meant", () => {
  const source = (form: string) => `let a: boolean? = null\nlet b = true\n${form}\nexit\n`;
  assert.deepEqual(diagnostics(source('if a otherwise not b {\n    say "yes", instant\n}')), [
    ["TSP012", OTHERWISE_NOT, "not"],
  ]);
  for (const [b, expected] of [
    ["true", "false"],
    ["false", "true"],
  ])
    assert.deepEqual(
      sayTexts(`let a: boolean? = null\nlet b = ${b}\nsay a otherwise (not b), instant\nexit\n`),
      [expected],
      b,
    );
  const forms = [
    "while a otherwise not b {\n    a = false\n}",
    'if b {\n    say "no", instant\n} else if a otherwise not b {\n    say "yes", instant\n}',
    "let c = a otherwise not b\nsay c, instant",
    "function check {\n    return a otherwise not b\n}\nsay check(), instant",
    "say a otherwise not b, instant",
    "function same(value) {\n    return value\n}\nsay same(a otherwise not b), instant",
    'if a otherwise not b and true {\n    say "yes", instant\n}',
    'if a otherwise not b == true {\n    say "yes", instant\n}',
    'if a otherwise\n    not b {\n    say "yes", instant\n}',
  ];
  for (const form of forms)
    assert.deepEqual(diagnostics(source(form)), [["TSP012", OTHERWISE_NOT, "not"]], form);
  // A chain is quoted whole; `!` has its own error and is then read as `not`; two `not`s cancel out; `??` has its own
  // error, and the `not` gets one once it is the word.
  assert.deepEqual(diagnostics(source("let c = a otherwise a otherwise not b")), [
    [
      "TSP012",
      "'not' cannot follow 'otherwise' directly. Write 'a otherwise a otherwise (not b)'.",
      "not",
    ],
  ]);
  assert.deepEqual(diagnostics(source("let c = a otherwise !b")), [
    ["TSP037", BANG_AFTER_OPERATOR, "!"],
    ["TSP012", OTHERWISE_NOT, "!"],
  ]);
  assert.deepEqual(diagnostics(source("let c = a otherwise not not b")), [
    ["TSP012", "'not' cannot follow 'otherwise' directly. Write 'a otherwise b'.", "not"],
  ]);
  assert.deepEqual(diagnostics(source("let c = a ?? not b")), [
    [
      "TSP037",
      "TeaseScript writes 'otherwise' with a space on each side instead of '??': let name = nickname otherwise \"pet\"",
      "??",
    ],
  ]);
  // Arithmetic before `otherwise` needs parentheses that only its own error names, once the `not` has its own.
  const example = "'not' cannot follow 'otherwise' directly. Write it as in 'a otherwise (not b)'.";
  assert.deepEqual(diagnostics(source("let m: integer? = null\nlet c = m + 1 otherwise not b")), [
    ["TSP012", example, "not"],
  ]);
  assert.deepEqual(
    diagnostics(
      "let firstLongerVariableName: boolean? = null\nlet secondLongerVariableName = true\n" +
        "let c = firstLongerVariableName otherwise not secondLongerVariableName\nexit\n",
    ),
    [["TSP012", example, "not"]],
  );
});

test("'not' right after arithmetic or a range operator is one error that names no grouping, which could not compile", () => {
  const source = (form: string) => `let n = 1\nlet b = true\n${form}\nexit\n`;
  const operators: [string, string][] = [
    ["+", "'+'"],
    ["-", "'-'"],
    ["*", "'*'"],
    ["/", "'/'"],
    ["%", "'%'"],
    ["..", "a range"],
    ["..=", "a range"],
  ];
  for (const [operator, user] of operators) {
    const message = `'not' cannot follow '${operator}': it gives true or false, which ${user} cannot use. Remove the 'not'.`;
    const range = operator.startsWith("..");
    const form = (operand: string) =>
      range
        ? `for i in 1${operator}${operand} {\n    say "yes", instant\n}`
        : `if n ${operator} ${operand} == 2 {\n    say "yes", instant\n}`;
    assert.deepEqual(diagnostics(source(form("not b"))), [["TSP012", message, "not"]], operator);
    assert.deepEqual(
      diagnostics(source(form("!b"))),
      [
        ["TSP037", BANG_AFTER_OPERATOR, "!"],
        ["TSP012", message, "!"],
      ],
      operator,
    );
    // In parentheses, the true or false still reaches the operator, which rejects it; a range rejects it as its bound.
    assert.deepEqual(
      diagnostics(source(form("(not b)"))).map(([code]) => code),
      [range ? "TSV010" : "TSV043"],
      operator,
    );
  }
  assert.deepEqual(diagnostics(source("let c = n * 2 + not b\nsay c, instant")), [
    [
      "TSP012",
      "'not' cannot follow '+': it gives true or false, which '+' cannot use. Remove the 'not'.",
      "not",
    ],
  ]);
});

test("'not' right after a sign is one error, as after arithmetic", () => {
  const source = (form: string) => `let n = 1\nlet b = true\n${form}\nexit\n`;
  const message = (sign: string) =>
    `'not' cannot follow '${sign}': it gives true or false, which '${sign}' cannot use. Remove the 'not'.`;
  const forms: [string, string][] = [
    ["let c = -not b", "-"],
    ["let c = +not b", "+"],
    ["let c = - not b", "-"],
    ["let c = -\n    not b", "-"],
    ["let c = - -not b", "-"],
    ["let c = -not not b", "-"],
    ["let c = -not b * 2", "-"],
    ["let c = n * -not b", "-"],
    ["let c = n + -not b", "-"],
    ['if -not b {\n    say "yes", instant\n}', "-"],
  ];
  for (const [form, sign] of forms)
    assert.deepEqual(diagnostics(source(form)), [["TSP012", message(sign), "not"]], form);
  assert.deepEqual(diagnostics(source("let c = -!b")), [
    ["TSP037", BANG_AFTER_OPERATOR, "!"],
    ["TSP012", message("-"), "!"],
  ]);
  assert.deepEqual(diagnostics(source("let c = -not")), [
    ["TSP012", "Expected an expression after 'not'.", ""],
  ]);
});
