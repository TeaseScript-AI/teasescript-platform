import type { SyntaxKind } from "../../../src/type-inference/core/slice-syntax.js";

/*
 * The row guard's templates (#2500, `tests/type-core/type-core-row-guard.test.ts`): for each open row of the candidate
 * route's syntax table (`DISPOSITIONS`), one source per operand and store position of the construct, the host global
 * `hostValue` there, so its value is unknown to both checkers, and one per shape of a call (`sliceCall`'s, with each of
 * its arguments). A row without a position has one source that uses it. Sources are minimal
 * programs inside today's slice; the guard adds the `exit` each script ends with.
 */
const BASE_TEMPLATES: Readonly<Partial<Record<SyntaxKind, readonly string[]>>> = {
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
    "hostValue.n = 1",
  ],
  ifStatement: ['if hostValue == null {\n  say "y"\n} else {\n  say "n"\n}'],
  repeatStatement: ['repeat hostValue {\n  say "r"\n}'],
  forStatement: ["for item in hostValue {\n  say item\n}"],
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
  propertyAccessExpression: ["let o = {n: hostValue}\nlet x: integer = o.n", "let x = hostValue.n"],
  indexExpression: ["let xs = [1, 2]\nlet x = xs[hostValue]", "let x = hostValue[0]"],
  rangeExpression: ["for i in 1..hostValue {\n  say i\n}", "for i in hostValue..3 {\n  say i\n}"],
  binaryExpression: [
    "let x: integer = hostValue otherwise 1",
    "let a: integer? = null\nlet x: integer = a otherwise hostValue",
    "let b = hostValue == null",
    "let b = null != hostValue",
  ],
  typeTestExpression: ["let b = hostValue is integer"],
  callExpression: [
    "let xs = [1]\nlet x: integer = xs.get(hostValue, default: 0)",
    "let xs = [1]\nlet x: integer = xs.get(0, default: hostValue)",
    "let n: integer = toInteger(hostValue, default: 0)",
    'let n: integer = toInteger("1", default: hostValue)',
    "let v: integer = fromJson(hostValue, default: 1)",
    'let v: integer = fromJson("bad", default: hostValue)',
    'let v: integer = fromJson("1", default: 1, files: false)',
    "let f = fileFromBase64(hostValue, default: null)",
    'let f = fileFromBase64("YQ==", default: hostValue)',
    'let t = decryptText(hostValue, password: "pw", default: "")',
    'let t = decryptText("x", password: hostValue, default: "")',
    'let t: string = decryptText("x", password: "pw", default: hostValue)',
    'let t = decryptText("x", key: hostValue, default: "")',
    'let f = decryptFile(hostValue, password: "pw", default: null)',
    'let f = decryptFile(hostValue, key: "k", default: null)',
    'let t = "abc"\nlet b = t.contains(hostValue)',
    'let b = hostValue.contains("a")',
    "let xs = [2, 1]\nxs.sort()",
    "let t = toJson(hostValue)",
  ],
  loadExpression: [
    'let n: integer = load "k", default: hostValue',
    "let n = load hostValue, default: 1",
  ],
  // the `pass` rows without operands
  speakerSetterStatement: ['speaker player\nsay "a"'],
  stopAudioStatement: ["stopAudio"],
  hideImageStatement: ["hideImage"],
  // (no nested form after `skippable`, which reads a following `[` as an element of a name)
  sayStatement: ["say skippable hostValue"],
};

/**
 * The operand positions of the commands, by the names their rows cite (`OperandCheck`, `DISPOSITIONS`' `operands`; a
 * `say`'s are its parts), each a source with the host global there: the row guard compares the names with the rows', so
 * a position without a citation, or a citation without a position, fails it.
 */
export const OPERAND_TEMPLATES: Readonly<
  Partial<Record<SyntaxKind, Readonly<Record<string, readonly string[]>>>>
> = {
  showImageStatement: { image: ["showImage hostValue"] },
  openUrlStatement: {
    url: ["openUrl(hostValue)"],
    buttonText: ['openUrl("https://example.com", buttonText: hostValue)'],
    alwaysButton: ['openUrl("https://example.com", alwaysButton: hostValue)'],
  },
  exportTextStatement: {
    text: ["exportText(hostValue)"],
    title: ['exportText("t", title: hostValue)'],
    fileName: ['exportText("t", fileName: hostValue)'],
  },
  showPopupStatement: {
    message: ["showPopup hostValue"],
    buttonText: ['showPopup(message: "m", buttonText: hostValue)'],
  },
  waitStatement: { duration: ["wait hostValue", "wait hostValue s"] },
  deleteStatement: { key: ["delete hostValue"] },
  showButtonStatement: {
    label: ["showButton hostValue"],
    background: ['showButton "Go", background: hostValue'],
    timeout: ['showButton "Go", timeout: hostValue'],
  },
  sayStatement: {
    presentation: ['say bubble(color: hostValue) "a"', 'say prose(align: hostValue) "a"'],
    value: ["say hostValue"],
    pacing: ['say "a", hostValue'],
  },
};

/**
 * What an operand may hold in place of the host global, each holding it in turn: a load's default, a `get`'s default and
 * a call's argument, so a nested expression of each kind the check result indexes stands at every operand position.
 */
export const NESTED_OPERANDS: readonly string[] = [
  // (none starts with a parenthesis, which some commands read as their own argument list)
  '[load "n", default: hostValue][0]',
  "[hostValue].get(0, default: hostValue)",
  "fromJson(hostValue, default: hostValue)",
];

/** A command's templates: each operand's own, then each again with every nested form in place of the host global. */
function operandTemplates(operands: Readonly<Record<string, readonly string[]>>): string[] {
  const own = Object.values(operands).flat();
  return [
    ...own,
    ...own.flatMap((template) =>
      NESTED_OPERANDS.map((nested) => template.replace("hostValue", nested)),
    ),
  ];
}

export const ROW_TEMPLATES: Readonly<Partial<Record<SyntaxKind, readonly string[]>>> = {
  ...BASE_TEMPLATES,
  ...Object.fromEntries(
    Object.entries(OPERAND_TEMPLATES).map(([row, operands]) => {
      // EVIDENCE: invariant: the templates' keys are AST kinds (`OPERAND_TEMPLATES`' type).
      const kind = row as SyntaxKind;
      return [row, [...(BASE_TEMPLATES[kind] ?? []), ...operandTemplates(operands)]];
    }),
  ),
};

/** A value of each kind class in place of an operand's host global: a whole number, text, a truth value, `null`. */
export const MISFIT_LITERALS: readonly string[] = ["2", '"text"', "true", "null"];

/**
 * Each command operand's first template with each literal of `MISFIT_LITERALS` in place of the host global: the sources
 * on which today's compile-time operand checks may differ from the route's (`DECLARED_RULE_DIFFERENCES`).
 */
export function misfitSources(): { row: SyntaxKind; operand: string; source: string }[] {
  return Object.entries(OPERAND_TEMPLATES).flatMap(([row, operands]) =>
    Object.entries(operands!).flatMap(([operand, [template]]) =>
      MISFIT_LITERALS.map((literal) => ({
        // EVIDENCE: invariant: the templates' keys are AST kinds (`OPERAND_TEMPLATES`' type).
        row: row as SyntaxKind,
        operand,
        source: template!.replace("hostValue", literal),
      })),
    ),
  );
}

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
  {
    row: "callExpression",
    position: "`get`'s receiver",
    refused: "let x: integer = hostValue.get(0, default: 0)",
    admitted: "let xs = [1]\nlet x: integer = xs.get(0, default: 0)",
    // (`get` on a receiver of unknown kind, which the route refuses after the analysis)
    gate: "outsideAnswers (src/type-inference/core/backend.ts)",
    text: "this operand",
  },
];

/**
 * The runs of a template in which the route's plan fails otherwise than today's: the template, why the difference
 * stands (an accepted record, or the open issue that decides it while nothing accepted does), the check's field and
 * place in the route's plan, the failure's code at `at` on the route, and where today's run fails instead (`null`
 * where it does not fail). The guard requires exactly that difference in every mode, and fails on any other difference.
 */
export const DECLARED_RUN_DIFFERENCES: readonly {
  readonly template: string;
  readonly basis: { readonly record: string } | { readonly issue: number };
  readonly field: string;
  /** The template's text the check stands at in the route's plan (`main.tease`). */
  readonly checkAt: string;
  readonly code: string;
  readonly at: string;
  readonly todayAt: string | null;
}[] = [
  {
    template: "let xs = [1]\nlet x: integer = xs.get(hostValue, default: 0)",
    basis: {
      record:
        "V30 §16, reading an element with a default: a non-whole index of unknown type fails with TSR024 on the new type checker, and still gives the default on today's",
    },
    field: "indexCheck",
    checkAt: "xs.get(hostValue, default: 0)",
    code: "TSR024",
    at: "hostValue",
    todayAt: null,
  },
  // undecided (#2536): which span TSR058 stands at when the value arrives through a call's default
  ...[
    ['let v: integer = fromJson("bad", default: hostValue)', 'fromJson("bad", default: hostValue)'],
    [
      'let t: string = decryptText("x", password: "pw", default: hostValue)',
      'decryptText("x", password: "pw", default: hostValue)',
    ],
  ].map(([template, call]) => ({
    template: template!,
    basis: { issue: 2536 },
    field: "fallbackCheck",
    checkAt: "hostValue",
    code: "TSR058",
    at: "hostValue",
    todayAt: call!,
  })),
];

/**
 * The command operands where today's checker gives a compile error for a literal of a kind the operand does not take,
 * and the route publishes a plan whose instruction refuses that value when it runs (#2488's design rulings, R2: a
 * closed list, which the command operand table empties): the misfit's source (`misfitSources`), today's code, and the
 * route's failure, its code at the text `at`. The guard requires each in every mode, with nothing of the statement's
 * effect happening, and fails on a difference no entry names and on an entry that no longer occurs.
 */
export const DECLARED_RULE_DIFFERENCES: readonly {
  readonly row: SyntaxKind;
  readonly operand: string;
  readonly source: string;
  readonly code: string;
  readonly failure: { readonly code: string; readonly at: string };
}[] = (
  [
    // row, operand, source, today's code, the route's failure code, and the text it stands at
    ["deleteStatement", "key", "delete 2", "TSV038", "TSR054", "2"],
    ["deleteStatement", "key", "delete true", "TSV038", "TSR054", "true"],
    ["deleteStatement", "key", "delete null", "TSV038", "TSR054", "null"],
    [
      "exportTextStatement",
      "fileName",
      'exportText("t", fileName: 2)',
      "TSV043",
      "TSR050",
      'exportText("t", fileName: 2)',
    ],
    [
      "exportTextStatement",
      "fileName",
      'exportText("t", fileName: true)',
      "TSV043",
      "TSR050",
      'exportText("t", fileName: true)',
    ],
    [
      "exportTextStatement",
      "fileName",
      'exportText("t", fileName: null)',
      "TSV043",
      "TSR050",
      'exportText("t", fileName: null)',
    ],
    ["exportTextStatement", "text", "exportText(2)", "TSV043", "TSR050", "exportText(2)"],
    ["exportTextStatement", "text", "exportText(true)", "TSV043", "TSR050", "exportText(true)"],
    ["exportTextStatement", "text", "exportText(null)", "TSV043", "TSR050", "exportText(null)"],
    [
      "openUrlStatement",
      "alwaysButton",
      'openUrl("https://example.com", alwaysButton: 2)',
      "TSV043",
      "TSR050",
      'openUrl("https://example.com", alwaysButton: 2)',
    ],
    [
      "openUrlStatement",
      "alwaysButton",
      'openUrl("https://example.com", alwaysButton: "text")',
      "TSV043",
      "TSR050",
      'openUrl("https://example.com", alwaysButton: "text")',
    ],
    [
      "openUrlStatement",
      "alwaysButton",
      'openUrl("https://example.com", alwaysButton: null)',
      "TSV043",
      "TSR050",
      'openUrl("https://example.com", alwaysButton: null)',
    ],
    ["openUrlStatement", "url", "openUrl(2)", "TSV043", "TSR050", "openUrl(2)"],
    ["openUrlStatement", "url", 'openUrl("text")', "TSV043", "TSR050", 'openUrl("text")'],
    ["openUrlStatement", "url", "openUrl(true)", "TSV043", "TSR050", "openUrl(true)"],
    ["openUrlStatement", "url", "openUrl(null)", "TSV043", "TSR050", "openUrl(null)"],
    ["sayStatement", "pacing", 'say "a", 2', "TSV043", "TSR050", 'say "a", 2'],
    ["sayStatement", "pacing", 'say "a", "text"', "TSV043", "TSR050", 'say "a", "text"'],
    ["sayStatement", "pacing", 'say "a", true', "TSV043", "TSR050", 'say "a", true'],
    ["sayStatement", "pacing", 'say "a", null', "TSV043", "TSR050", 'say "a", null'],
    [
      "showButtonStatement",
      "background",
      'showButton "Go", background: 2',
      "TSV029",
      "TSR052",
      'showButton "Go", background: 2',
    ],
    [
      "showButtonStatement",
      "background",
      'showButton "Go", background: "text"',
      "TSV029",
      "TSR052",
      'showButton "Go", background: "text"',
    ],
    [
      "showButtonStatement",
      "background",
      'showButton "Go", background: true',
      "TSV029",
      "TSR052",
      'showButton "Go", background: true',
    ],
    [
      "showButtonStatement",
      "timeout",
      'showButton "Go", timeout: 2',
      "TSV043",
      "TSR050",
      'showButton "Go", timeout: 2',
    ],
    [
      "showButtonStatement",
      "timeout",
      'showButton "Go", timeout: "text"',
      "TSV043",
      "TSR050",
      'showButton "Go", timeout: "text"',
    ],
    [
      "showButtonStatement",
      "timeout",
      'showButton "Go", timeout: true',
      "TSV043",
      "TSR050",
      'showButton "Go", timeout: true',
    ],
    [
      "showButtonStatement",
      "timeout",
      'showButton "Go", timeout: null',
      "TSV043",
      "TSR050",
      'showButton "Go", timeout: null',
    ],
    ["showImageStatement", "image", "showImage 2", "TSV036", "TSR050", "showImage 2"],
    ["showImageStatement", "image", "showImage true", "TSV036", "TSR050", "showImage true"],
    ["waitStatement", "duration", "wait 2", "TSV043", "TSR050", "2"],
    ["waitStatement", "duration", 'wait "text"', "TSV043", "TSR050", '"text"'],
    ["waitStatement", "duration", "wait true", "TSV043", "TSR050", "true"],
    ["waitStatement", "duration", "wait null", "TSV043", "TSR050", "null"],
  ] as const
).map(([row, operand, source, code, failure, at]) => ({
  row,
  operand,
  source,
  code,
  failure: { code: failure, at },
}));
