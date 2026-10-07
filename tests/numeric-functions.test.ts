import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { NUMERIC_FUNCTIONS } from "../src/numeric-functions.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

function said(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function failure(source: string): [string | undefined, string | undefined] {
  const failed = runValidSource(source).snapshot.failure;
  return [failed?.code, failed?.message];
}

/** Hides a value's type from the compiler, as host data or untyped storage would. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

test("abs, sqrt, and pow compute their results", () => {
  assert.deepEqual(
    said(
      [
        'say "${abs(-3)} ${abs(-2.5)} ${abs(4)} ${sqrt(16)} ${sqrt(2)} ${sqrt(0)}"',
        'say "${pow(2, 10)} ${pow(10, -2)} ${pow(4, 0.5)} ${pow(8, 1 / 3)} ${pow(-2, 3)} ${pow(-2, 2)}"',
        // 0 to the power 0 is 1, and a result too small to represent is 0.
        'say "${pow(0, 0)} ${pow(0, 2.5)} ${pow(10, -400)} ${pow(-0.5, 2001)}"',
        "exit",
      ].join("\n"),
    ),
    ["3 2.5 4 4 1.4142135623730951 0", "1024 0.01 2 2 -8 4", "1 0 0 0"],
  );
});

test("round to decimals rounds the number as written, half away from zero, and gives a number", () => {
  assert.deepEqual(
    said(
      [
        // The doubles nearest 2.675 and 1.005 are slightly below them, but they are written and so rounded as shown.
        'say "${round(2.675, decimals: 2)} ${round(1.005, decimals: 2)} ${round(-2.5, decimals: 0)} ${round(1234.5678, decimals: 1)}"',
        'say "${round(0.005, decimals: 2)} ${round(0.004, decimals: 2)} ${round(1e-7, decimals: 3)} ${round(2.5, decimals: 20)} ${round(pi, decimals: 4)}"',
        "exit",
      ].join("\n"),
    ),
    ["2.68 1.01 -3 1234.6", "0.01 0 0 2.5 3.1416"],
  );
  assert.deepEqual(diagnostics("let whole: integer = round(2.5, decimals: 0)\nexit"), [
    [
      "TSV041",
      "'whole' is declared as integer, so it cannot start as a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let whole: number = ...'.",
      "round(2.5, decimals: 0)",
    ],
  ]);
  assert.deepEqual(diagnostics("say round(2.5, decimals: 1.5)\nexit"), [
    [
      "TSV043",
      "round(...) needs decimals: to be a whole number of at least 0, not 1.5.",
      "round(2.5, decimals: 1.5)",
    ],
  ]);
  assert.deepEqual(diagnostics("say floor(2.5, decimals: 1)\nexit"), [
    ["TSV022", "floor(...) takes no named arguments; remove 'decimals:'.", "decimals"],
  ]);
  assert.deepEqual(failure(`${DYNAMIC}say round(2.5, decimals: dynamic(-1))\nexit`), [
    "TSR039",
    "round(...) needs decimals: to be a whole number of at least 0, not -1.",
  ]);
});

test("mod takes the divisor's sign where % keeps the dividend's, sign gives -1, 0, or 1, and clamp bounds a number", () => {
  assert.deepEqual(
    said(
      [
        'say "${mod(-1, 3)} ${mod(7, -3)} ${mod(-7, -3)} ${mod(5.5, 2)} ${mod(6, 3)} ${-1 % 3} ${7 % -3}"',
        'say "${sign(-4)} ${sign(0)} ${sign(2.5)} ${clamp(15, 1, 10)} ${clamp(-3, 1, 10)} ${clamp(5.5, 1, 10)} ${clamp(4, 4, 4)}"',
        'say "${pi} ${2 * pi}"',
        "exit",
      ].join("\n"),
    ),
    ["2 -2 -1 1.5 0 -1 1", "-1 0 1 10 1 5.5 4", "3.141592653589793 6.283185307179586"],
  );
  assert.deepEqual(
    diagnostics(
      [
        "let wrapped: integer = mod(-7, 3)",
        "let bounded: integer = clamp(4, 1, 10)",
        "let direction: integer = sign(-2.5)",
        "let part: number = mod(7.5, 2)",
        "let circle: number = pi",
        "exit",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    diagnostics("let part: integer = mod(7.5, 2)\nlet area: integer = pi\nexit").map(
      ([code, , text]) => [code, text],
    ),
    [
      ["TSV041", "mod(7.5, 2)"],
      ["TSV041", "pi"],
    ],
  );
  for (const [call, code, message] of [
    ["mod(5, 0)", "TSR036", "mod(5, 0) has no result: it divides by zero."],
    ["clamp(5, 10, 1)", "TSR039", "clamp(5, 10, 1) needs a min that is at most its max."],
  ] as const) {
    assert.deepEqual(diagnostics(`say ${call}\nexit`), [["TSV043", message, call]], call);
    const hidden = call.replace(/-?[\d.]+/gu, (number) => `dynamic(${number})`);
    assert.deepEqual(failure(`${DYNAMIC}say ${hidden}\nexit`), [code, message], hidden);
  }
  // `pi` is a protected name, so neither a script nor a host can declare it.
  assert.deepEqual(diagnostics("let pi = 3\nexit")[0]?.[0], "TSV001");
  assert.deepEqual(
    compileSource("say pi\nexit", { globals: ["pi"] }).diagnostics.map(
      (diagnostic) => diagnostic.message,
    ),
    ["Configured name 'pi' conflicts with a protected TeaseScript name."],
  );
});

test("abs keeps an integer whole, pow of a whole number to a known whole power is whole, and sqrt is a number", () => {
  assert.deepEqual(
    diagnostics(
      [
        "function area(side: integer) {",
        "    let whole: integer = pow(side, 2)",
        "    let distance: integer = abs(side - 10)",
        "    let none: integer = pow(side, 0)",
        "    return whole + distance + none",
        "}",
        "let root: number = sqrt(9)",
        "say area(3)",
        "exit",
      ].join("\n"),
    ),
    [],
  );
  const cannot = (name: string) =>
    `'${name}' is declared as integer, so it cannot start as a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let ${name}: number = ...'.`;
  assert.deepEqual(
    diagnostics(
      [
        "function shapes(power: integer, ratio: number) {",
        "    let root: integer = sqrt(9)",
        "    let grown: integer = pow(2, power)",
        "    let half: integer = pow(4, -1)",
        "    let part: integer = pow(ratio, 2)",
        "    let size: integer = abs(ratio)",
        "}",
        "exit",
      ].join("\n"),
    ),
    [
      ["TSV041", cannot("root"), "sqrt(9)"],
      ["TSV041", cannot("grown"), "pow(2, power)"],
      ["TSV041", cannot("half"), "pow(4, -1)"],
      ["TSV041", cannot("part"), "pow(ratio, 2)"],
      ["TSV041", cannot("size"), "abs(ratio)"],
    ],
  );
  // A value the compiler cannot know is checked where it is stored.
  assert.deepEqual(said(`${DYNAMIC}let whole: integer = abs(dynamic(-2))\nsay "\${whole}"\nexit`), [
    "2",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}let whole: integer = abs(dynamic(-2.5))\nexit`), [
    "TSR058",
    "'whole' holds a whole number (integer), so it cannot take a number.",
  ]);
});

test("a call without a finite result is a compile error when the arguments are known, and a runtime error otherwise", () => {
  const cases: [string, string][] = [
    ["sqrt(-4)", "sqrt(-4) has no result: a negative number has no square root."],
    ["pow(0, -1)", "pow(0, -1) has no result: it divides by zero."],
    ["pow(-8, 0.5)", "pow(-8, 0.5) has no result: a negative base needs a whole exponent."],
    ["pow(10, 400)", "pow(10, 400) gives a number too large to represent. Use smaller values."],
    ["pow(-10, 401)", "pow(-10, 401) gives a number too large to represent. Use smaller values."],
  ];
  for (const [call, message] of cases) {
    assert.deepEqual(diagnostics(`say ${call}\nexit`), [["TSV043", message, call]], call);
    const hidden = call.replace(/-?[\d.]+/gu, (number) => `dynamic(${number})`);
    assert.deepEqual(failure(`${DYNAMIC}say ${hidden}\nexit`), ["TSR036", message], hidden);
  }
});

test("numeric functions check their arguments", () => {
  assert.deepEqual(
    diagnostics(
      [
        "function check(maybe: integer | null, choice: integer | string) {",
        '    say pow(2, "3")',
        "    say sqrt()",
        "    say pow(2)",
        "    say abs(2, by: 1)",
        "    say abs(maybe)",
        "    say sqrt(choice)",
        "}",
        "exit",
      ].join("\n"),
    ),
    [
      [
        "TSV043",
        "pow(...) needs a number, not text (string). Convert text with toNumber(...) first.",
        '"3"',
      ],
      ["TSV020", "sqrt(...) takes 1 argument (value), received 0.", "sqrt()"],
      ["TSV020", "pow(...) takes 2 arguments (base, exponent), received 1.", "pow(2)"],
      ["TSV022", "abs(...) takes no named arguments; remove 'by:'.", "by"],
      ["TSV043", "'maybe' may be null. Check it first: if maybe != null { ... }", "maybe"],
      [
        "TSV043",
        "'choice' may be text (string). Check it first: if choice is integer { ... }",
        "choice",
      ],
    ],
  );
  assert.deepEqual(failure(`${DYNAMIC}say pow(dynamic("2"), 3)\nexit`), [
    "TSR059",
    "pow(...) needs a number, not text (string). Convert text with toNumber(...) first.",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}say abs(dynamic(null))\nexit`), [
    "TSR059",
    "abs(...) needs a number, not null.",
  ]);
});

test("the numeric functions are protected names", () => {
  for (const [source, name] of [
    ["function sqrt(value) {\n    return value\n}\nexit", "sqrt"],
    ["let pow = 2\nexit", "pow"],
    ["function size(abs) {\n    return 1\n}\nexit", "abs"],
    ["let sign = 1\nexit", "sign"],
    ["let mod = 1\nexit", "mod"],
    ["let clamp = 1\nexit", "clamp"],
  ] as const) {
    assert.deepEqual(
      diagnostics(source),
      [
        [
          "TSV001",
          `Declaration '${name}' conflicts with a protected TeaseScript name. Choose another name, such as '${name}Value'.`,
          name,
        ],
      ],
      source,
    );
  }
});

test("pow gives the correctly rounded result with the same operations on every JavaScript engine", () => {
  const pow = (base: number, exponent: number) =>
    NUMERIC_FUNCTIONS.get("pow")!.apply([base, exponent], {}, () => 0);
  // Whole powers of whole numbers, rounded once from the exact BigInt power.
  for (const [base, exponent] of [
    [477, 6],
    [3, 33],
    [7, 18],
    [10, 22],
    [10, 23],
    [999, 11],
    [2, 1023],
  ] as const)
    assert.equal(
      pow(base, exponent),
      Number(BigInt(base) ** BigInt(exponent)),
      `${base}^${exponent}`,
    );
  // Correctly rounded values from 80-digit decimal arithmetic. V8's Math.pow is one unit in the last place off for the
  // first five, and Safari's for 1.1^10, which it computes by repeated multiplication.
  const refereed: [number, number, number][] = [
    [92.63995888177305, -9.85121170990169, 4.2135973070201036e-20],
    [97.43515143636614, -11, 1.3308456538995108e-22],
    [0.9999995740084033, 318580697.75626063, 1.150033965102615e-59],
    [4.83837039250195e-170, -0.6492089240346104, 8.336894623646192e109],
    [2141.365429852158, 0.0625, 1.6149838146607784],
    [1.1, 10, 2.5937424601000023],
    [10, -5, 0.00001],
  ];
  for (const [base, exponent, expected] of refereed)
    assert.equal(pow(base, exponent), expected, `${base}^${exponent}`);
  // Subnormal results round once, and below half the smallest one the result is 0.
  assert.equal(pow(2, -1074), 5e-324);
  assert.equal(pow(0.5, 1074), 5e-324);
  assert.equal(pow(2, -1075), 0);
  // Extreme exponents end quickly: beyond any finite double, or within rounding of 1.
  assert.deepEqual(pow(1.0000001, 1e300), {
    failure: "pow(1.0000001, 1e+300) gives a number too large to represent. Use smaller values.",
    code: "TSR036",
  });
  assert.equal(pow(0.9999999, 1e300), 0);
  assert.equal(pow(3, 5e-324), 1);
  assert.equal(pow(-1, 1e300), 1);
});

test("numeric results survive checkpoint resume", () => {
  const source = [
    "let side = 3",
    "let area = pow(side, 2)",
    "wait 1 s",
    "let root = sqrt(area + 7)",
    "wait 1 s",
    'say "${area} ${root} ${abs(-root)} ${pow(root, 0.5)}"',
    "exit",
  ].join("\n");
  const equivalent = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    equivalent.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["9 4 4 2"],
  );
});
