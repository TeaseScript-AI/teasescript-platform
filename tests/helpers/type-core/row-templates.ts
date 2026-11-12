import type { SyntaxKind } from "../../../src/type-inference/core/slice-syntax.js";
import type { ValueKind } from "../../../src/value-kinds.js";

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

/**
 * A written value of each kind (`VALUE_KINDS`) the slice admits: each command operand holds each in turn in place of its
 * host global (`misfitSources`).
 */
const ADMITTED_VALUES = {
  integer: "2",
  number: "2.5",
  string: '"text"',
  boolean: "true",
  null: "null",
  regex: "/a/",
  range: "1..=2",
  list: "[1]",
  object: "{v: 1}",
} as const satisfies Partial<Record<ValueKind, string>>;

type AdmittedKind = keyof typeof ADMITTED_VALUES;

/** The kinds the slice admits a value of but `kinds`. */
function but(...kinds: AdmittedKind[]): AdmittedKind[] {
  // EVIDENCE: invariant: the record's keys are its kinds (its type).
  return (Object.keys(ADMITTED_VALUES) as AdmittedKind[]).filter((kind) => !kinds.includes(kind));
}

/**
 * Each other kind (`VALUE_KINDS`), which the slice admits no value of: a source holding one, which the route refuses or
 * publishes no plan for (the row guard requires it). A new kind does not type-check here until it is placed.
 */
export const REFUSED_KINDS: Readonly<Record<Exclude<ValueKind, AdmittedKind>, string>> = {
  duration: "let m = 2 s",
  calendarDuration: "let m = 2 calendar months",
  angle: "let m = 90 deg",
  date: 'let m = toDate("2026-10-04", default: null)',
  time: 'let m = toTime("14:30", default: null)',
  datetime: 'let m = toDateTime("2026-10-04T18:00", default: null)',
  absoluteDateTime: 'let m = toAbsoluteDateTime("2026-10-04T12:30:00Z", default: null)',
  script: 'let m = script("main.tease")',
  set: "let m = set[1]",
  dict: "let m = dict{ a: 1 }",
  speaker: 'speaker guide { displayName: "Guide" }\nlet m = guide',
  timer: "let m = timer async 1 s",
  media: 'let m = playAudio async "a.mp3"',
  camera: "let m = showCamera",
  permanentButton: 'let m = showPermanentButton "Hint" {\n  say "a"\n}',
  messageHandle: 'let m = say "a"',
};

/** A command operand's first template with `value` in place of the host global. */
const misfitSource = (row: SyntaxKind, operand: string, value: string): string =>
  OPERAND_TEMPLATES[row]![operand]![0]!.replace("hostValue", value);

/**
 * Each command operand's first template with a value of each kind the slice admits in place of the host global: the
 * sources on which today's compile-time operand checks may differ from the route's (`DECLARED_RULE_DIFFERENCES`).
 */
export function misfitSources(): { row: SyntaxKind; operand: string; source: string }[] {
  return Object.entries(OPERAND_TEMPLATES).flatMap(([key, operands]) => {
    // EVIDENCE: invariant: the templates' keys are AST kinds (`OPERAND_TEMPLATES`' type).
    const row = key as SyntaxKind;
    return Object.keys(operands!).flatMap((operand) =>
      Object.values(ADMITTED_VALUES).map((value) => ({
        row,
        operand,
        source: misfitSource(row, operand, value),
      })),
    );
  });
}

/**
 * The positions of open rows whose host global, or misfit (`misfitSources`), the route refuses after the syntax gate, by
 * name: that source, which must be refused with `text` in every mode, and the same position with a value the slice
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
  // (a `say`'s value of a kind it shows only by S9b's rules, the misfit sources')
  ...(["regex", "range", "list", "object"] as const).map((kind) => ({
    row: "sayStatement" as const,
    position: `the value, ${kind}`,
    refused: misfitSource("sayStatement", "value", ADMITTED_VALUES[kind]),
    admitted: 'say "text"',
    gate: "outsideAnswers (src/type-inference/core/backend.ts)",
    text: "this say",
  })),
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
 * The command operands where today's checker gives a compile error for a value of a kind the operand does not take, and
 * the route publishes a plan whose instruction refuses that value when it runs (#2488's design rulings, R2: a closed
 * list, which the command operand table empties): the misfit's source (`misfitSources`), today's code, and the route's
 * failure, its code at the text `at`. The guard requires each in every mode, with nothing of the statement's effect
 * happening, and fails on a difference no entry names and on an entry that no longer occurs. Each entry also stands for
 * its twin after `exit` (the lead's R9): today the same error, the route a plan with only the unreachable warning TSV065.
 */
export const DECLARED_RULE_DIFFERENCES: readonly {
  readonly row: SyntaxKind;
  readonly operand: string;
  readonly source: string;
  readonly code: string;
  readonly failure: { readonly code: string; readonly at: string };
}[] = (
  [
    // row, operand, today's code, the route's failure code, whether it stands at the statement or the operand's value,
    // and the kinds (`ADMITTED_VALUES`), each one entry
    ["deleteStatement", "key", "TSV038", "TSR054", "value", but("string")],
    ["exportTextStatement", "text", "TSV043", "TSR050", "statement", but("string")],
    ["exportTextStatement", "title", "TSV040", "TSR021", "statement", ["list"]],
    ["exportTextStatement", "title", "TSV042", "TSR021", "statement", ["range", "object"]],
    ["exportTextStatement", "fileName", "TSV043", "TSR050", "statement", but("string")],
    ["openUrlStatement", "url", "TSV043", "TSR050", "statement", but()],
    ["openUrlStatement", "buttonText", "TSV040", "TSR021", "statement", ["list"]],
    ["openUrlStatement", "buttonText", "TSV042", "TSR021", "statement", ["range", "object"]],
    ["openUrlStatement", "alwaysButton", "TSV043", "TSR050", "statement", but("boolean")],
    ["sayStatement", "pacing", "TSV043", "TSR050", "statement", but()],
    ["showButtonStatement", "label", "TSV040", "TSR021", "statement", ["list"]],
    ["showButtonStatement", "label", "TSV042", "TSR021", "statement", ["range", "object"]],
    ["showButtonStatement", "background", "TSV029", "TSR052", "statement", but("null")],
    ["showButtonStatement", "timeout", "TSV043", "TSR050", "statement", but()],
    ["showImageStatement", "image", "TSV036", "TSR050", "statement", but("string", "null")],
    ["showPopupStatement", "message", "TSV040", "TSR021", "statement", ["list"]],
    ["showPopupStatement", "message", "TSV042", "TSR021", "statement", ["range", "object"]],
    ["showPopupStatement", "buttonText", "TSV040", "TSR021", "statement", ["list"]],
    ["showPopupStatement", "buttonText", "TSV042", "TSR021", "statement", ["range", "object"]],
    ["waitStatement", "duration", "TSV043", "TSR050", "value", but()],
  ] as const
).flatMap(([row, operand, code, failure, at, kinds]) =>
  kinds.map((kind) => {
    const source = misfitSource(row, operand, ADMITTED_VALUES[kind]);
    return {
      row,
      operand,
      source,
      code,
      failure: { code: failure, at: at === "value" ? ADMITTED_VALUES[kind] : source },
    };
  }),
);
