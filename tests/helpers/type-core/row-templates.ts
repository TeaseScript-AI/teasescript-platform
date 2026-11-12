import type { SyntaxKind } from "../../../src/type-inference/core/slice-syntax.js";

/*
 * The row guard's templates (#2500, `tests/type-core/type-core-row-guard.test.ts`): for each open row of the candidate
 * route's syntax table (`DISPOSITIONS`), one source per operand and store position of the construct, the host global
 * `hostValue` there, so its value is unknown to both checkers. A position whose value the slice refuses unless it is
 * known to be of a kind (a member's receiver, a list read by index) holds a variable of that kind instead, and the host
 * global stands in the operand beside it. A row without a position has one source that uses it. Sources are minimal
 * programs inside today's slice; the guard adds the `exit` each script ends with.
 */
export const ROW_TEMPLATES: Readonly<Partial<Record<SyntaxKind, readonly string[]>>> = {
  letStatement: [
    "let x: integer = hostValue",
    "let x = hostValue",
    "let xs: integer[] = hostValue",
    "let x: integer? = hostValue",
  ],
  assignmentStatement: [
    "let x: integer = 1\nx = hostValue",
    "let x = 1\nx = hostValue",
    "let o = {n: 1}\no.n = hostValue",
  ],
  ifStatement: ['if hostValue == null {\n  say "y"\n} else {\n  say "n"\n}'],
  repeatStatement: ['repeat hostValue {\n  say "r"\n}'],
  forStatement: ["for item in hostValue {\n  say item\n}"],
  sayStatement: ["say hostValue"],
  expressionStatement: ["toJson(hostValue)"],
  // (the guard ends every source with `exit`, which a script needs; this row's source is that `exit`)
  exitStatement: ['say "a"'],
  identifier: ["let x = hostValue"],
  booleanLiteral: ["let b: boolean = true"],
  nullLiteral: ["let n: integer? = null"],
  numberLiteral: ["let n: number = 1.5"],
  stringLiteral: ['let t: string = "a"'],
  regexLiteral: ["let r = /a+/"],
  listLiteral: ["let xs: integer[] = [1, hostValue]"],
  objectLiteral: ["let o = {n: hostValue}"],
  parenthesizedExpression: ["let x: integer = (hostValue)"],
  propertyAccessExpression: ["let o = {n: hostValue}\nlet x: integer = o.n"],
  indexExpression: ["let xs = [1, 2]\nlet x = xs[hostValue]"],
  rangeExpression: ["for i in 1..hostValue {\n  say i\n}"],
  binaryExpression: ["let x: integer = hostValue otherwise 1", "let b = hostValue == null"],
  typeTestExpression: ["let b = hostValue is integer"],
  callExpression: [
    "let xs = [1]\nlet x: integer = xs.get(hostValue, default: 0)",
    "let n: integer = toInteger(hostValue, default: 0)",
    "let v: integer = fromJson(hostValue, default: 1)",
    "let f = fileFromBase64(hostValue, default: null)",
    'let t = decryptText(hostValue, password: "pw", default: "")',
    'let t = "abc"\nlet b = t.contains(hostValue)',
    "let t = toJson(hostValue)",
  ],
  loadExpression: [
    'let n: integer = load "k", default: hostValue',
    "let n = load hostValue, default: 1",
  ],
};

/**
 * The positions of open rows whose host global the route refuses after the syntax gate, by name: the source with the
 * host global there, which must be refused with `text` in every mode, and the same position with a value the slice
 * admits, which must pass the guard's three rules. `gate` names the refusal's place; the record carries only `text`,
 * which only that gate writes. A refusal not listed fails the guard, and so does a listed one that no longer occurs.
 */
export const DECLARED_REFUSALS: readonly {
  readonly row: SyntaxKind;
  readonly position: string;
  readonly refused: string;
  readonly admitted: string;
  readonly gate: string;
  readonly text: string;
}[] = [
  {
    row: "ifStatement",
    position: "the condition",
    refused: 'if hostValue {\n  say "y"\n}',
    admitted: 'let b = hostValue == null\nif b {\n  say "y"\n}',
    // (an unknown condition's operator diagnostic, which the route refuses after the analysis)
    gate: "outsideAnswers (src/type-inference/core/backend.ts)",
    text: "this operand",
  },
];

/**
 * The runs of a template in which the route's plan fails where today's does not, by an accepted record: the template,
 * the record, the check's field in the route's plan, and the failure's code at `at`, the template's text where it
 * fails. The guard requires exactly that difference in at least one run, and fails on any other difference.
 */
export const DECLARED_RUN_DIFFERENCES: readonly {
  readonly template: string;
  readonly record: string;
  readonly field: string;
  readonly code: string;
  readonly at: string;
}[] = [
  {
    template: "let xs = [1]\nlet x: integer = xs.get(hostValue, default: 0)",
    record:
      "V30 §16, reading an element with a default: a non-whole index of unknown type fails with TSR024 on the new type checker, and still gives the default on today's",
    field: "indexCheck",
    code: "TSR024",
    at: "hostValue",
  },
];
