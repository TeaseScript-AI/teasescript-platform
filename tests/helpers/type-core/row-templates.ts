import type { SyntaxKind } from "../../../src/type-inference/core/slice-syntax.js";
import { CONVERSIONS, isConversion } from "../../../src/conversions.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
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
  sayStatement: [
    "say skippable hostValue",
    `${declaration("displayName", '"Boss"')}\nsay as boss "a"`,
    'say as player "a"',
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
  ],
};

/** A declaration of the speaker `boss` with one property. */
function declaration(field: string, value: string): string {
  return `speaker boss {\n  ${field}: ${value}\n}`;
}

/** A declaration followed by a message of its speaker, which reads its fields. */
function spoken(declared: string): string {
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

/** A literal of each kind the slice writes one of: a sample's first origin. */
const LITERALS: Readonly<Partial<Record<ValueKind, string>>> = {
  integer: "2",
  number: "2.5",
  string: '"text"',
  boolean: "true",
  null: "null",
  regex: "/a/",
  range: "1..=2",
  list: "[1]",
  object: "{v: 1}",
};

/**
 * The text each conversion the slice admits (`sliceCall`'s: a value's, not `toString`) converts: a sample's second
 * origin, `<conversion>(<text>, default: hostValue)`, a value of the conversion's result kind. The declared positions'
 * test requires one for each such conversion.
 */
export const CONVERSION_INPUTS: Readonly<Record<string, string>> = {
  toNumber: '"2.5"',
  toInteger: '"8"',
  toBoolean: '"true"',
  toDate: '"2027-04-17"',
  toTime: '"14:30"',
  toDateTime: '"2027-04-17T18:00"',
  toAbsoluteDateTime: '"2027-04-17T12:30:00Z"',
};

/** The kinds no host value can be (`HOSTLESS_VALUES`). */
type HostlessKind = "speaker" | "timer" | "media" | "messageHandle" | "camera" | "permanentButton";

/**
 * A host value of each other kind (`VALUE_KINDS`): a sample's third origin, a typed ingress of the host global
 * (`let m: <kind> = hostValue`) whose runs take that value too. A new kind does not type-check here until it is placed.
 */
export const HOST_VALUES: Readonly<
  Record<Exclude<ValueKind, HostlessKind>, SerializableRuntimeValue>
> = {
  integer: 2,
  number: 2.5,
  string: "text",
  boolean: true,
  null: null,
  duration: { kind: "duration", milliseconds: 2000 },
  calendarDuration: { kind: "calendarDuration", months: 1, days: 0, milliseconds: 0 },
  angle: { kind: "angle", degrees: 90 },
  date: { kind: "date", year: 2027, month: 4, day: 17 },
  time: { kind: "time", hour: 14, minute: 30, second: 0, millisecond: 0 },
  datetime: {
    kind: "datetime",
    year: 2027,
    month: 4,
    day: 17,
    hour: 14,
    minute: 30,
    second: 0,
    millisecond: 0,
  },
  absoluteDateTime: { kind: "absoluteDateTime", epochMilliseconds: 1807000000000 },
  script: { kind: "script", path: "main.tease" },
  regex: { kind: "regex", source: "a", flags: "" },
  range: { kind: "range", start: 1, end: 2, inclusive: true },
  list: { kind: "list", items: [1] },
  set: { kind: "set", items: [1] },
  dict: { kind: "dict", entries: [{ key: "n", value: 1 }] },
  object: { kind: "object", properties: [{ name: "v", value: 1 }] },
};

/**
 * A value of each kind no host value can be: a speaker reference and a timer, media or message handle, which only the
 * runtime creates, and a camera view and a permanent button, which have no written type either. The declared positions'
 * test requires the host to refuse each.
 */
export const HOSTLESS_VALUES: Readonly<Record<HostlessKind, SerializableRuntimeValue>> = {
  speaker: { kind: "speakerReference", speakerId: 0, identifier: "guide" },
  timer: { kind: "timerHandle", timerId: 1 },
  media: { kind: "mediaHandle", mediaId: 1 },
  messageHandle: { kind: "messageHandle", messageId: 1 },
  camera: { kind: "cameraView" },
  permanentButton: { kind: "permanentButtonHandle", buttonId: 1 },
};

/** A command operand's first template with `value` in place of the host global. */
const commandWith = (row: SyntaxKind, operand: string, value: string): string =>
  OPERAND_TEMPLATES[row]![operand]![0]!.replace("hostValue", value);

/** A value of one kind, from one origin, in one command operand position (the lead's R14). */
export interface Sample {
  readonly row: SyntaxKind;
  readonly operand: string;
  /** Its value's kind; none where the value fails before it is one (`FAILING_PRODUCER`). */
  readonly kind: string;
  readonly origin: "literal" | "conversion" | "ingress" | "failing";
  /** What stands before the command: the typed ingress, or nothing. */
  readonly prelude: string;
  /** The operand's value as the command writes it. */
  readonly value: string;
  /** The command holding it. */
  readonly command: string;
  /** The host value its runs take besides `DOMAIN`'s: the ingress's kind. */
  readonly host?: SerializableRuntimeValue;
}

/**
 * A value whose producer the slice admits and which fails at run time, before it is a value of any kind: a list read past
 * its end. A sample's fourth origin, without a kind (the lead's R18).
 */
export const FAILING_PRODUCER = "[1][4]";

/** Every sample: each command operand position (`OPERAND_TEMPLATES`) with each kind from each origin. */
export function samples(): Sample[] {
  const values = [
    ...Object.entries(LITERALS).map(([kind, value]) => ({
      kind,
      origin: "literal" as const,
      prelude: "",
      value: value!,
    })),
    ...Object.entries(CONVERSION_INPUTS).map(([name, text]) => ({
      kind: isConversion(name) ? CONVERSIONS[name].result : name,
      origin: "conversion" as const,
      prelude: "",
      value: `${name}(${text}, default: hostValue)`,
    })),
    ...Object.entries(HOST_VALUES).map(([kind, host]) => ({
      kind,
      origin: "ingress" as const,
      prelude: `let m: ${kind} = hostValue\n`,
      value: "m",
      host,
    })),
    { kind: "none", origin: "failing" as const, prelude: "", value: FAILING_PRODUCER },
  ];
  return Object.entries(OPERAND_TEMPLATES).flatMap(([key, operands]) => {
    // EVIDENCE: invariant: the templates' keys are AST kinds (`OPERAND_TEMPLATES`' type).
    const row = key as SyntaxKind;
    return Object.keys(operands!).flatMap((operand) =>
      values.map((value) => ({
        row,
        operand,
        ...value,
        command: commandWith(row, operand, value.value),
      })),
    );
  });
}

/** A `say`'s value of a kind it shows only by S9b's rules, written in place: the route refuses it after the analysis. */
const SAY_REFUSED: ReadonlySet<string> = new Set([
  "regex",
  "range",
  "list",
  "object",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
]);

/**
 * The positions of open rows whose host global, or sample (`samples`), the route refuses after the syntax gate, by
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
  // (a `say`'s value of a kind it shows only by S9b's rules, written in place)
  ...samples()
    .filter(
      (sample) =>
        sample.row === "sayStatement" &&
        sample.operand === "value" &&
        sample.origin !== "ingress" &&
        SAY_REFUSED.has(sample.kind),
    )
    .map((sample) => ({
      row: "sayStatement" as const,
      position: `the value, ${sample.kind} (${sample.origin})`,
      refused: sample.command,
      admitted: 'say "text"',
      gate: "outsideAnswers (src/type-inference/core/backend.ts)",
      text: "this say",
    })),
  // (a built-in speaker field's value of a kind it does not take, or unknown where no runtime check is cited; a
  // `defaultSaySkippable` of any known kind but a truth value is today's compile error, so it has no entry here)
  ...(
    [
      ["displayName", "/a/", '"Vera"'],
      ["title", "/a/", '"Vera"'],
      ["shortTitle", "/a/", '"Vera"'],
      ["firstName", "/a/", '"Vera"'],
      ["lastName", "/a/", '"Vera"'],
      ["presentation", "[1]", '"bubble"'],
      ["bubble", '"x"', '{background: "#334455"}'],
      ["prose", '"x"', '{align: "left"}'],
      ["font", "5", '"Georgia"'],
      ["avatar", "5", '"a.jpg"'],
      ["color", "[1]", '"#336699"'],
      ["color", "hostValue", '"#336699"'],
      ["alias", "5", '"pet"'],
      ["alias", "hostValue", '"pet"'],
      ["gender", "5", '"female"'],
      ["gender", "hostValue", '"female"'],
    ] as const
  ).map(([field, refused, admitted]) => ({
    row: "speakerDeclaration" as const,
    position: `the field ${field}, ${refused}`,
    refused: spoken(declaration(field, refused)),
    admitted: spoken(declaration(field, admitted)),
    gate: "outsideAnswers (src/type-inference/core/backend.ts)",
    text: "this speaker property",
  })),
  // (a check that no store takes: a typed default inside a command's operand or a `say`'s value, the lead's R11; its
  // place is the command operand table's, step 1½)
  ...(
    [
      [
        "showPopupStatement",
        "the message, a `fromJson` with a typed default",
        "showPopup",
        "fromJson",
      ],
      ["showPopupStatement", "the message, a load with a typed default", "showPopup", "load"],
      ["sayStatement", "the value, a `fromJson` with a typed default", "say", "fromJson"],
    ] as const
  ).map(([row, position, command, form]) => {
    const value =
      form === "load"
        ? 'load "n", default: toInteger("8", default: hostValue)'
        : 'fromJson("broken", default: toInteger("8", default: hostValue))';
    return {
      row,
      position,
      refused: `${command} ${value}`,
      admitted: `let m = ${value}\n${command} m`,
      gate: "runtimeChecks (src/type-inference/core/check-result/runtime-plan.ts)",
      text: "a check that no store takes",
    };
  }),
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
 * The command operand positions with a declared rule difference (#2488's design rulings, R2, keyed by position as the
 * lead's R14 has it: a closed list, which the command operand table empties). For a value the operand does not take,
 * whatever its kind and origin, where today's checker gives one of `today`'s compile errors, the route publishes as for
 * the command with a fitting operand (its fitting twin, `FITTING_OPERANDS`), and each run ends in one of three ways, in
 * the order the runtime works (R18): where it does not reach the command, as the twin's; where an operand's evaluation
 * fails, as that operand alone does (`let v = <operand>` there), same code and site; where every operand evaluates, the
 * command refuses the value with one of `failure`'s codes, at the statement or at the value, nothing of its effect
 * happening. Where today's checker gives no error, both publish and their runs are equal. That holds wherever the command
 * stands (R12), where the route admits the value alone there; where it refuses that, it refuses the command alike (R16).
 * The guard samples kinds and origins (`samples`, `PAIRED_SAMPLES`) and contexts (`CONTEXTS`).
 */
export const DECLARED_RULE_DIFFERENCES: readonly {
  readonly row: SyntaxKind;
  readonly operand: string;
  readonly today: readonly string[];
  readonly failure: readonly string[];
  readonly at: "statement" | "value";
}[] = (
  [
    ["deleteStatement", "key", ["TSV038"], ["TSR054"], "value"],
    ["exportTextStatement", "text", ["TSV043"], ["TSR050"], "statement"],
    ["exportTextStatement", "title", ["TSV040", "TSV042"], ["TSR021"], "statement"],
    ["exportTextStatement", "fileName", ["TSV043"], ["TSR050"], "statement"],
    ["openUrlStatement", "url", ["TSV043"], ["TSR050"], "statement"],
    ["openUrlStatement", "buttonText", ["TSV040", "TSV042"], ["TSR021"], "statement"],
    ["openUrlStatement", "alwaysButton", ["TSV043"], ["TSR050"], "statement"],
    ["sayStatement", "pacing", ["TSV043"], ["TSR050", "TSR065"], "statement"],
    ["showButtonStatement", "label", ["TSV040", "TSV042"], ["TSR021"], "statement"],
    ["showButtonStatement", "background", ["TSV029"], ["TSR052"], "statement"],
    ["showButtonStatement", "timeout", ["TSV043"], ["TSR050", "TSR065"], "statement"],
    ["showImageStatement", "image", ["TSV036"], ["TSR050"], "statement"],
    ["showPopupStatement", "message", ["TSV040", "TSV042"], ["TSR021"], "statement"],
    ["showPopupStatement", "buttonText", ["TSV040", "TSV042"], ["TSR021"], "statement"],
    ["waitStatement", "duration", ["TSV043"], ["TSR050", "TSR065"], "value"],
  ] as const
).map(([row, operand, today, failure, at]) => ({ row, operand, today, failure, at }));

/**
 * A fitting value of each declared position: the command with it is a sample's fitting twin (the lead's R12). A duration
 * literal is outside the slice, so a twin with one is compared on today's checker.
 */
const FITTING_OPERANDS: Readonly<Partial<Record<SyntaxKind, Readonly<Record<string, string>>>>> = {
  showImageStatement: { image: '"a.png"' },
  openUrlStatement: { url: '"https://example.com"', buttonText: '"Go"', alwaysButton: "true" },
  exportTextStatement: { text: '"t"', title: '"t"', fileName: '"f.txt"' },
  showPopupStatement: { message: '"m"', buttonText: '"Go"' },
  waitStatement: { duration: "2 s" },
  deleteStatement: { key: '"k"' },
  showButtonStatement: { label: '"Go"', background: '"red"', timeout: "2 s" },
  sayStatement: { pacing: "instant" },
};

/** A sample's fitting twin: its command with the position's fitting value. */
export const twinCommand = (sample: Sample): string =>
  commandWith(sample.row, sample.operand, FITTING_OPERANDS[sample.row]![sample.operand]!);

/**
 * For each command with more than one operand position, the command with one operand it does not take and another whose
 * producer fails at run time (R18): its run fails, whichever comes first.
 */
export const PAIRED_SAMPLES: readonly {
  readonly row: SyntaxKind;
  readonly misfit: string;
  readonly failing: string;
  readonly command: string;
}[] = [
  {
    row: "openUrlStatement",
    misfit: "url",
    failing: "buttonText",
    command: `openUrl(2, buttonText: ${FAILING_PRODUCER})`,
  },
  {
    row: "exportTextStatement",
    misfit: "text",
    failing: "title",
    command: `exportText(2, title: ${FAILING_PRODUCER})`,
  },
  {
    row: "showPopupStatement",
    misfit: "message",
    failing: "buttonText",
    command: `showPopup(message: [1], buttonText: ${FAILING_PRODUCER})`,
  },
  {
    row: "showButtonStatement",
    misfit: "background",
    failing: "timeout",
    command: `showButton "Go", background: 2, timeout: ${FAILING_PRODUCER}`,
  },
  {
    row: "sayStatement",
    misfit: "pacing",
    failing: "presentation",
    command: `say bubble(color: ${FAILING_PRODUCER}) "a", 2`,
  },
];

/**
 * The control-flow contexts the guard samples a command in (R12, R16): wherever it stands, the route answers as for its
 * fitting twin, but that a run reaching it fails there.
 */
export const CONTEXTS: Readonly<Record<string, (command: string) => string>> = {
  straight: (command) => `${command}\nexit\n`,
  "after exit": (command) => `exit\n${command}\n`,
  "after an exiting if": (command) => `if true {\n  exit\n}\n${command}\nexit\n`,
  "after an exiting for": (command) => `for part in [1] {\n  exit\n}\n${command}\nexit\n`,
  "in a branch": (command) => `let b = hostValue == null\nif b {\n  ${command}\n}\nexit\n`,
  "where the host global is null": (command) => `if hostValue == null {\n  ${command}\n}\nexit\n`,
  "where it is not null": (command) =>
    `if hostValue == null {\n  say "n"\n} else {\n  ${command}\n}\nexit\n`,
  "where it is text": (command) => `if hostValue is string {\n  ${command}\n}\nexit\n`,
  "where it is no text": (command) =>
    `if hostValue is string {\n  say "t"\n} else {\n  ${command}\n}\nexit\n`,
};
