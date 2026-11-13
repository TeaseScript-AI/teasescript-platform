import { operandRules, type SyntaxKind } from "../../../src/type-inference/core/slice-syntax.js";

/** A file of a project the guard compiles: its path and its whole source. */
export interface TemplateFile {
  readonly path: string;
  readonly source: string;
}

/** A template: a source, which the guard ends with `exit`, or the files of a project, the first `main.tease`. */
export type Template = string | readonly TemplateFile[];

const main = (source: string): TemplateFile => ({ path: "main.tease", source });
const PART_TYPED: TemplateFile = {
  path: "part.tease",
  source: 'let z: integer = hostValue\nsay "in part"\nexit\n',
};
const PART_NULLABLE: TemplateFile = {
  path: "part.tease",
  source: "let x: integer? = hostValue\nif x != null {\n  let y: integer = x\n}\nexit\n",
};

/*
 * The row guard's templates (#2500, `tests/type-core/type-core-row-guard.test.ts`): for each open row of the candidate
 * route's syntax table (`DISPOSITIONS`), one source per operand and store position of the construct, the host global
 * `hostValue` there, so its value is unknown to both checkers, and one per shape of a call (`sliceCall`'s, with each of
 * its arguments). A row without a position has one source that uses it. Sources are minimal
 * programs inside today's slice; the guard adds the `exit` each script ends with. A template of several files is their
 * list, each file written whole.
 */
const BASE_TEMPLATES: Readonly<Partial<Record<SyntaxKind, readonly Template[]>>> = {
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
  sayStatement: [
    "say skippable hostValue",
    `${declaration("displayName", '"Boss"')}\nsay as boss "a"`,
    'say as player "a"',
    // (the player across a transfer)
    [
      main('say as player "a"\ngoto "part.tease"\n'),
      { path: "part.tease", source: 'say as player "b"\nshowButton as player "Go"\nexit\n' },
    ],
  ],
  showButtonStatement: [
    `${declaration("displayName", '"Boss"')}\nshowButton as boss "Go"`,
    'showButton as player "Go"',
  ],
  // each built-in field (`SPEAKER_FIELD_KINDS`) with the host global where the runtime checks its value, else a literal
  // of a kind it takes; a custom property; a declaration in a block
  speakerDeclaration: [
    ...[
      "displayName",
      "title",
      "shortTitle",
      "firstName",
      "lastName",
      "defaultSaySkippable",
      "presentation",
      "bubble",
      "prose",
      "font",
      "avatar",
      "mood",
    ].map((field) => spoken(declaration(field, "hostValue"))),
    spoken(declaration("color", '"#336699"')),
    spoken(declaration("alias", '"pet"')),
    spoken(declaration("gender", '"female"')),
    `if hostValue == null {\n  speaker boss {\n    displayName: "Boss"\n  }\n}\nsay as boss "a"`,
    // a speaker declared in another file speaks in the first; across a transfer, declared in the entry file and used
    // in the target, and declared in the target
    [
      main('say as boss "Hi"\nshowButton as boss "Go"\nexit\n'),
      {
        path: "other.tease",
        source: 'speaker boss {\n  displayName: hostValue\n  color: "#336699"\n}\nexit\n',
      },
    ],
    [
      main('speaker boss {\n  displayName: hostValue\n}\nsay as boss "a"\ngoto "part.tease"\n'),
      { path: "part.tease", source: 'say as boss "b"\nshowButton as boss "Go"\nexit\n' },
    ],
    [
      main('say "a"\ngoto "part.tease"\n'),
      {
        path: "part.tease",
        source:
          'speaker boss {\n  displayName: hostValue\n  color: "#336699"\n}\nsay as boss "b"\nexit\n',
      },
    ],
  ],
  // a transfer by each target form the row holds (a quoted glob of one file among them), a typed store of the host global
  // in every file; then a nullable stored
  // before each of the literal forms and a computed one, a variable of the same name used in the target (#2514's file
  // starts: `let`s are per file and globals closed, so nothing nullable crosses a file)
  gotoStatement: [
    [main('let n: integer = hostValue\ngoto "part.tease"\n'), PART_TYPED],
    [main('let n: integer = hostValue\ngoto script("part.tease")\n'), PART_TYPED],
    [
      main("let n: string? = hostValue\ngoto script(hostValue)\n"),
      { path: "part.tease", source: 'let z: string = hostValue\nsay "in part"\nexit\n' },
      { path: "third.tease", source: "let w: integer = hostValue\nexit\n" },
    ],
    [
      main('if hostValue == null {\n  goto "part.tease"\n}\nlet n: integer = hostValue\nexit\n'),
      { path: "part.tease", source: "let z: integer? = hostValue\nexit\n" },
    ],
    [main('let n: integer = hostValue\ngoto "p*.tease"\n'), PART_TYPED],
    [
      main('let x: integer? = hostValue\ngoto "part.tease"\n'),
      {
        path: "part.tease",
        source: 'let x: integer? = null\nlet y: integer = x otherwise 1\nsay "in part"\nexit\n',
      },
    ],
    [main('let x: integer? = hostValue\ngoto script("part.tease")\n'), PART_NULLABLE],
    [
      main("let x: integer? = null\ngoto script(hostValue)\n"),
      PART_NULLABLE,
      { path: "third.tease", source: "let x = 1\nlet y: integer = x\nexit\n" },
    ],
  ],
  // (each ask's kind and form, `as` each speaker kind, no question, and the places an answer goes; its operand positions
  // are `ASK_OPERANDS`')
  interactionExpression: [
    'let r: string = askText "q", hint: "h", prefill: "p"',
    'let r: number = askNumber("q", prefill: 2.5)',
    'let r: integer = askInteger("q", prefill: 2)',
    'let r: date = askDate("q")',
    'let r: time = askTime("q")',
    'let r: datetime = askDateTime("q")',
    'let r: string = askPassword("q", hint: "h")',
    'let r: boolean = askBoolean "q", yesText: "y", noText: "n", prefill: true',
    "let r: integer = askChoice 1, 2, prefill: 2",
    'let r = askChoice back: "Back", [{value: "s", text: "S"}, {text: "C"}]',
    'speaker boss {\n  displayName: "Boss"\n}\nlet r = askText as boss("q")',
    'let r = askInteger as player "q"',
    "let r = askText",
    'say askText("q")',
    'if askBoolean("q") {\n  say "y"\n}',
    'repeat askInteger("q") {\n  say "r"\n}',
    'let r = [1, 2][askInteger("q")]',
    'let r: string = hostValue otherwise askText("q")',
    'let o = {n: 1}\no.n = askInteger("q")',
    'let r = askText(askText("q"))',
  ],
};

/**
 * The files a row's one-file sources compile with beside `main.tease`: a transfer's destination, so that a fitting path
 * starts a file other than the one transferring.
 */
const DESTINATIONS: Readonly<Partial<Record<SyntaxKind, readonly TemplateFile[]>>> = {
  gotoStatement: [{ path: "part.tease", source: "exit\n" }],
};

/** A source of `row` as the project the guard compiles: `main.tease`, then the row's destinations. */
export const filesOf = (row: SyntaxKind, source: string): readonly TemplateFile[] => [
  main(source),
  ...(DESTINATIONS[row] ?? []),
];

/** The host values a row's runs take beside the domain: for a transfer, the paths of the files it may start. */
export const ROW_HOSTS: Readonly<Partial<Record<SyntaxKind, readonly string[]>>> = {
  gotoStatement: ["part.tease", "third.tease"],
};

/** A declaration of the speaker `boss` with one property. */
export function declaration(field: string, value: string): string {
  return `speaker boss {\n  ${field}: ${value}\n}`;
}

/** A declaration followed by a message of its speaker, which reads its fields. */
export function spoken(declared: string): string {
  return `${declared}\nsay as boss "a"`;
}

/**
 * Sources the guard requires the route to answer as today's compiler does, which gives them a compile error: a `say as`
 * of a name that declares no speaker (the lead's R26).
 */
export const ANSWERED_AS_TODAY: readonly string[] = [
  'say as nobody "a"',
  'let x = 1\nsay as x "a"',
];

/** The basic asks with a `prefill:` (`askPassword` takes none), by the name an ask's position starts with. */
export const PREFILLED_ASKS = [
  "askText",
  "askNumber",
  "askInteger",
  "askDate",
  "askTime",
  "askDateTime",
];

/**
 * The operand positions of the asks (`askParts`), by ask and operand, each a `let` of the answer with the host global
 * there. An `askChoice`'s option stands alone, so the buttons' kinds are the sample's (two kinds are refused as a mixed
 * choice, `outsideAnswers`).
 */
const ASK_OPERANDS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    [...PREFILLED_ASKS, "askPassword"].flatMap((ask) => [
      [`${ask}.question`, [`let r = ${ask}(hostValue)`]],
      [`${ask}.hint`, [`let r = ${ask}("q", hint: hostValue)`]],
      ...(ask === "askPassword"
        ? []
        : [[`${ask}.prefill`, [`let r = ${ask}("q", prefill: hostValue)`]]]),
    ]),
  ),
  "askText.presentation": ['let r = askText bubble(color: hostValue) "q"'],
  "askBoolean.question": [
    "let r = askBoolean(hostValue)",
    "let r = askBoolean(message: hostValue)",
  ],
  "askBoolean.yesText": ['let r = askBoolean("q", yesText: hostValue)'],
  "askBoolean.noText": ['let r = askBoolean("q", noText: hostValue)'],
  "askBoolean.prefill": ['let r = askBoolean("q", prefill: hostValue)'],
  "askBoolean.presentation": ['let r = askBoolean prose(align: hostValue) "q"'],
  "askChoice.option": ["let r = askChoice hostValue"],
  "askChoice.element": ["let r = askChoice [hostValue]"],
  "askChoice.label": ["let r = askChoice a: hostValue"],
  "askChoice.text": ["let r = askChoice {text: hostValue, value: 1}"],
  "askChoice.background": ['let r = askChoice {text: "t", background: hostValue}'],
  "askChoice.prefill": ["let r = askChoice 1, 2, prefill: hostValue"],
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
  waitStatement: { duration: ["wait hostValue"], amount: ["wait hostValue s"] },
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
  gotoStatement: { path: ["goto script(hostValue)"] },
  interactionExpression: ASK_OPERANDS,
};

/**
 * The positions of a choice object written in place whose value the button returns (`COMMAND_OPERANDS`'
 * `askChoice.returnedText` and `.value`), each with the host global there, which the core's check of the buttons refuses
 * (`DECLARED_REFUSALS`): the declared positions' samples hold other values there; no guard template has them.
 */
const CHOICE_OBJECT_OPERANDS: Readonly<Record<string, readonly string[]>> = {
  "askChoice.returnedText": ["let r = askChoice {text: hostValue}"],
  "askChoice.value": ['let r = askChoice {text: "t", value: hostValue}'],
};

/** Every command operand position the declared positions sample: the guard's (`OPERAND_TEMPLATES`) and a choice object's. */
export const SAMPLED_TEMPLATES: typeof OPERAND_TEMPLATES = {
  ...OPERAND_TEMPLATES,
  interactionExpression: { ...ASK_OPERANDS, ...CHOICE_OBJECT_OPERANDS },
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
function operandTemplates(
  row: SyntaxKind,
  operands: Readonly<Record<string, readonly string[]>>,
): string[] {
  return [
    ...Object.values(operands).flat(),
    // (at a position of the command operand table, a nested form is an outside value carried, which the table declines,
    // R10: `DECLARED_REFUSALS`)
    ...Object.entries(operands).flatMap(([operand, templates]) =>
      operandRules(row)?.[operand] === undefined
        ? templates.flatMap((template) =>
            NESTED_OPERANDS.map((nested) => template.replace("hostValue", nested)),
          )
        : [],
    ),
  ];
}

export const ROW_TEMPLATES: Readonly<Partial<Record<SyntaxKind, readonly Template[]>>> = {
  ...BASE_TEMPLATES,
  ...Object.fromEntries(
    Object.entries(OPERAND_TEMPLATES).map(([row, operands]) => {
      // EVIDENCE: invariant: the templates' keys are AST kinds (`OPERAND_TEMPLATES`' type).
      const kind = row as SyntaxKind;
      return [row, [...(BASE_TEMPLATES[kind] ?? []), ...operandTemplates(kind, operands)]];
    }),
  ),
};
