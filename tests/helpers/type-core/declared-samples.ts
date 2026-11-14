// The row guard's declared lists and the declared positions' samples (#2488's reach).

import { operandRules, type SyntaxKind } from "../../../src/type-inference/core/slice-syntax.js";
import { CONVERSIONS, isConversion } from "../../../src/conversions.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import type { ValueKind } from "../../../src/value-kinds.js";
import {
  CHOICE_REFUSED,
  PREFILL_LITERALS,
  PREFILL_OPERANDS,
  PREFILLED_ASKS,
} from "./ask-templates.js";
import {
  declaration,
  spoken,
  NESTED_OPERANDS,
  OPERAND_TEMPLATES,
  SAMPLED_TEMPLATES,
} from "./row-templates.js";

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
  duration: "2 s",
  calendarDuration: "1 calendar month",
  angle: "90 deg",
};

/**
 * The text each conversion the slice admits (`sliceCall`'s: a value's, not `toString`) converts: a sample's second
 * origin, `<conversion>(<text>, default: hostValue)`, a value of the conversion's result kind.
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

/** A command operand's first template, or a prefill's (`PREFILL_OPERANDS`), with `value` in place of the host global. */
const commandWith = (row: SyntaxKind, operand: string, value: string): string =>
  (SAMPLED_TEMPLATES[row]?.[operand]?.[0] ?? PREFILL_OPERANDS[operand]!).replace(
    "hostValue",
    value,
  );

/** A value of one kind, from one origin, in one command operand position (the lead's R14). */
export interface Sample {
  readonly row: SyntaxKind;
  readonly operand: string;
  /** Its value's kind; none where the value fails before it is one (`FAILING_PRODUCER`). */
  readonly kind: string;
  readonly origin:
    | "literal"
    | "conversion"
    | "ingress"
    | "failing"
    | "nested"
    | "carrier"
    | "otherwise"
    | "property"
    | "narrowed";
  /** What stands before the command. */
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
const FAILING_PRODUCER = "[1][4]";

/** The kinds a typed ingress is read with through an element, as a property or narrowed. */
const NESTED_KINDS = ["integer", "string", "boolean", "list", "date"] as const;

/** The host global carried, or a read of a place whose type is undecided, as (prelude, value). */
const CARRIERS: readonly (readonly [string, string])[] = [
  ["", "[hostValue][0]"],
  ["", "[hostValue].get(0, default: hostValue)"],
  ["", "{v: hostValue}.v"],
  ["let u = hostValue\n", "[u][0]"],
  ["let u = hostValue\n", "u"],
  ["let u = {v: hostValue}\n", "u.v"],
];

/**
 * The origins the route may decline where today's checker plans: an outside value carried, whose kind the core does not
 * know at the operand, and a typed ingress narrowed by a test.
 */
export const DECLINED_ORIGINS: ReadonlySet<Sample["origin"]> = new Set([
  "conversion",
  "nested",
  "carrier",
  "otherwise",
  "property",
  "narrowed",
]);

/**
 * Every sample: each command operand position (`SAMPLED_TEMPLATES`, or the templates given) with each origin's values,
 * each origin with its own kinds.
 */
export function samples(
  templates: Readonly<
    Partial<Record<SyntaxKind, Readonly<Record<string, readonly string[]>>>>
  > = SAMPLED_TEMPLATES,
): Sample[] {
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
    // (a typed ingress read through an element: the outside value its store's check stands for, carried)
    ...NESTED_KINDS.flatMap((kind) =>
      ["[m][0]", "[m].get(0, default: m)"].map((value) => ({
        kind,
        origin: "nested" as const,
        prelude: `let m: ${kind} = hostValue\n`,
        value,
        host: HOST_VALUES[kind],
      })),
    ),
    ...CARRIERS.map(([prelude, value]) => ({
      kind: "unknown",
      origin: "carrier" as const,
      prelude,
      value,
    })),
    ...NESTED_KINDS.flatMap((kind) =>
      LITERALS[kind] === undefined
        ? []
        : [
            {
              kind,
              origin: "otherwise" as const,
              prelude: "",
              value: `hostValue otherwise ${LITERALS[kind]}`,
            },
          ],
    ),
    // (a typed ingress's property: an outside value its store's check does not stand for)
    ...NESTED_KINDS.map((kind) => ({
      kind,
      origin: "property" as const,
      prelude: "let m: object = hostValue\n",
      value: "m.v",
      host: {
        kind: "object",
        properties: [{ name: "v", value: HOST_VALUES[kind] }],
      } satisfies SerializableRuntimeValue,
    })),
    ...NESTED_KINDS.map((kind) => ({
      kind,
      origin: "narrowed" as const,
      prelude: `let m: ${kind}? = hostValue\nif m == null {\n  exit\n}\n`,
      value: "m",
      host: HOST_VALUES[kind],
    })),
  ];
  return Object.entries(templates).flatMap(([key, operands]) => {
    // EVIDENCE: invariant: the templates' keys are AST kinds (`SAMPLED_TEMPLATES`' type).
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
  "duration",
  "calendarDuration",
  "angle",
]);

/** A fitting value of each declared position: the command with it is a sample's fitting twin. */
const FITTING_OPERANDS: Readonly<Partial<Record<SyntaxKind, Readonly<Record<string, string>>>>> = {
  showImageStatement: { image: '"a.png"' },
  openUrlStatement: { url: '"https://example.com"', buttonText: '"Go"', alwaysButton: "true" },
  exportTextStatement: { text: '"t"', title: '"t"', fileName: '"f.txt"' },
  showPopupStatement: { message: '"m"', buttonText: '"Go"' },
  waitStatement: { duration: "2 s" },
  deleteStatement: { key: '"k"' },
  showButtonStatement: { label: '"Go"', background: '"red"', timeout: "2 s" },
  sayStatement: { pacing: "instant" },
  gotoStatement: { path: '"part.tease"' },
  interactionExpression: {
    ...Object.fromEntries(
      [...PREFILLED_ASKS, "askPassword"].flatMap((ask) => [
        [`${ask}.question`, '"q"'],
        [`${ask}.hint`, '"h"'],
      ]),
    ),
    "askText.prefill": '"p"',
    "askNumber.prefill": "2.5",
    "askInteger.prefill": "2",
    "askBoolean.question": '"q"',
    "askBoolean.yesText": '"y"',
    "askBoolean.noText": '"n"',
    "askBoolean.prefill": "true",
    "askChoice.prefill": "2",
    "askChoice.option": "1",
    "askChoice.element": "1",
    "askChoice.label": '"A"',
    "askChoice.labelledElement": '"A"',
    "askChoice.background": '"red"',
    "askChoice.text": '"t"',
  },
};

/**
 * The fitting twins written whole, for a position whose fitting value no expression of the slice writes without the host
 * global, which a context narrows to no value of its kind: a date or time prefill, whose twin asks without one.
 */
const FITTING_COMMANDS: Readonly<Record<string, string>> = {
  "askDate.prefill": 'let r = askDate("q")',
  "askTime.prefill": 'let r = askTime("q")',
  "askDateTime.prefill": 'let r = askDateTime("q")',
};

/** A sample's fitting twin: its command with the position's fitting value, or the twin written whole. */
const twinCommand = (sample: Sample): string =>
  FITTING_COMMANDS[sample.operand] ??
  commandWith(sample.row, sample.operand, FITTING_OPERANDS[sample.row]![sample.operand]!);

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
    gate: "outsideAnswers (src/type-inference/core/backend.ts)",
    text: "this operand",
  },
  {
    row: "whileStatement",
    position: "the condition",
    refused: "while hostValue {\n  break\n}",
    admitted: "let b = hostValue == null\nwhile b {\n  break\n}",
    gate: "outsideAnswers (src/type-inference/core/backend.ts)",
    text: "this operand",
  },
  // (a case value no value of the subject may equal)
  ...[
    [
      'switch 1 {\n  case "a" {\n    say "a"\n  }\n}',
      'switch 1 {\n  case 2 {\n    say "b"\n  }\n}',
    ],
    [
      'let s = "a"\nswitch s {\n  case true {\n    say "t"\n  }\n}',
      'let s = "a"\nswitch s {\n  case "b" {\n    say "b"\n  }\n}',
    ],
    [
      'let s: integer? = hostValue\nswitch s {\n  case "a" {\n    say "a"\n  }\n}',
      'let s: integer? = hostValue\nswitch s {\n  case null {\n    say "n"\n  }\n}',
    ],
    [
      'let s = "a"\nswitch s {\n  case 1..3 {\n    say "r"\n  }\n}',
      'let s = 2\nswitch s {\n  case 1..3 {\n    say "r"\n  }\n}',
    ],
  ].map(([refused, admitted], at) => ({
    row: "switchStatement" as const,
    position: `a case value that may never match, ${at}`,
    refused: refused!,
    admitted: admitted!,
    gate: "neverMatching (src/type-inference/core/backend.ts)",
    text: "this case",
  })),
  {
    row: "callExpression",
    position: "`get`'s receiver",
    refused: "let x: integer = hostValue.get(0, default: 0)",
    admitted: "let xs = [1]\nlet x: integer = xs.get(0, default: 0)",
    gate: "outsideAnswers (src/type-inference/core/backend.ts)",
    text: "this operand",
  },
  {
    row: "durationLiteral",
    position: "a calendar amount of no whole months",
    refused: "let c = 1.5 calendar months",
    admitted: "let c = 2 calendar months",
    gate: "the durationLiteral row (src/type-inference/core/slice-syntax.ts)",
    text: "this duration literal",
  },
  {
    row: "unitExpression",
    position: "the amount, text",
    refused: 'let t = "a"\nlet d = t s',
    admitted: "let t = 2\nlet d = t s",
    gate: "outsideAnswers (src/type-inference/core/backend.ts)",
    text: "this unit expression",
  },
  {
    row: "unitExpression",
    position: "the amount, a known fraction of calendar months",
    refused: "let n = 1.5\nlet c = n calendar months",
    admitted: "let n = 1\nlet c = n calendar months",
    gate: "coreCheckResult (src/type-inference/core/check-result/check-result.ts)",
    text: "this unit expression",
  },
  {
    row: "angleExpression",
    position: "the amount, a known overflow",
    refused: "let n = 1e308\nlet a = n rad",
    admitted: "let n = 1\nlet a = n rad",
    gate: "coreCheckResult (src/type-inference/core/check-result/check-result.ts)",
    text: "this angle expression",
  },
  // (a `say`'s value of a kind it shows only by S9b's rules, written in place)
  ...samples()
    .filter(
      (sample) =>
        sample.row === "sayStatement" &&
        sample.operand === "value" &&
        (sample.origin === "literal" ||
          sample.origin === "conversion" ||
          sample.origin === "failing") &&
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
  ...samples()
    .filter(
      (sample) =>
        sample.row === "gotoStatement" &&
        ["literal", "conversion", "failing"].includes(sample.origin) &&
        sample.kind !== "string",
    )
    .map((sample) => ({
      row: "gotoStatement" as const,
      position: `the path, ${sample.kind} (${sample.origin})`,
      refused: sample.command,
      admitted: 'goto script("part.tease")',
      gate: "outsideAnswers (src/type-inference/core/backend.ts)",
      text: "an operand its instruction does not take",
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
  // (a check that no store takes: a typed default inside a command's operand or a `say`'s value)
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
      ...(row === "sayStatement"
        ? {
            gate: "runtimeChecks (src/type-inference/core/check-result/runtime-plan.ts)",
            text: "a check that no store takes",
          }
        : {
            gate: "outsideAnswers (src/type-inference/core/backend.ts)",
            text: "an operand its instruction does not take",
          }),
    };
  }),
  ...samples()
    .filter((sample) => sample.origin === "ingress" && sample.kind === "null")
    .map((sample) => ({
      row: sample.row,
      position: `${sample.operand}, ${sample.kind} (${sample.origin})`,
      refused: `${sample.prelude}${sample.command}`,
      admitted: commandWith(
        sample.row,
        sample.operand,
        ["askChoice.returnedText", "askChoice.value"].includes(sample.operand)
          ? '"t"'
          : "hostValue",
      ),
      gate: "annotationOutside (src/type-inference/core/slice-syntax.ts)",
      text: "this written type",
    })),
  // (an ask's prefill but a literal the request takes as written: the host global there and every sample of the first
  // four origins, the `null` ingress aside, which its written type refuses first)
  ...[
    ...Object.entries(PREFILL_OPERANDS).map(([operand, template]) => ({
      operand,
      position: `${operand}, the host global`,
      refused: template,
    })),
    ...samples({
      interactionExpression: Object.fromEntries(
        Object.entries(PREFILL_OPERANDS).map(([operand, template]) => [operand, [template]]),
      ),
    })
      .filter(
        (sample) =>
          ["literal", "conversion", "ingress", "failing"].includes(sample.origin) &&
          !(
            sample.origin === "literal" && PREFILL_LITERALS[sample.operand]!.includes(sample.kind)
          ) &&
          !(sample.origin === "ingress" && sample.kind === "null"),
      )
      .map((sample) => ({
        operand: sample.operand,
        position: `${sample.operand}, ${sample.kind} (${sample.origin})`,
        refused: `${sample.prelude}${sample.command}`,
      })),
  ].map(({ operand, position, refused }) => ({
    row: "interactionExpression" as const,
    position,
    refused,
    admitted:
      FITTING_COMMANDS[operand] ??
      commandWith(
        "interactionExpression",
        operand,
        FITTING_OPERANDS.interactionExpression![operand]!,
      ),
    gate: "askPrefillAdmitted (src/type-inference/core/slice-syntax.ts)",
    text: "this ask",
  })),
  // (an `askChoice` button the core's check of the buttons has something to say of, `CHOICE_REFUSED`)
  ...samples()
    .filter((sample) => CHOICE_REFUSED[sample.operand]?.includes(`${sample.origin} ${sample.kind}`))
    .map((sample) => ({
      row: "interactionExpression" as const,
      position: `${sample.operand}, ${sample.kind} (${sample.origin})`,
      refused: `${sample.prelude}${sample.command}`,
      admitted: twinCommand(sample),
      gate: "outsideAnswers (src/type-inference/core/backend.ts)",
      text: "this operand",
    })),
  ...Object.entries(OPERAND_TEMPLATES).flatMap(([row, operands]) =>
    Object.entries(operands ?? {}).flatMap(([operand, templates]) =>
      operandRules(row)?.[operand] === undefined
        ? []
        : templates.flatMap((template, at) =>
            NESTED_OPERANDS.map((nested) => ({
              // EVIDENCE: invariant: the templates' keys are AST kinds (`OPERAND_TEMPLATES`' type).
              row: row as SyntaxKind,
              position: `${operand} ${at}, ${nested}`,
              refused: template.replace("hostValue", nested),
              admitted: template,
              gate: "outsideAnswers (src/type-inference/core/backend.ts)",
              text: "an operand its instruction does not take",
            })),
          ),
    ),
  ),
  // (a choice object's text or value from the host: what the button returns, which the script cannot know)
  ...[
    [
      "askChoice.returnedText",
      "let r = askChoice {text: hostValue}",
      'let r = askChoice {text: "t"}',
    ],
    [
      "askChoice.value",
      'let r = askChoice {value: hostValue, text: "t"}',
      'let r = askChoice {value: 1, text: "t"}',
    ],
  ].map(([position, refused, admitted]) => ({
    row: "interactionExpression" as const,
    position: `${position!}, the host global`,
    refused: refused!,
    admitted: admitted!,
    gate: "outsideAnswers (src/type-inference/core/backend.ts)",
    text: "this operand",
  })),
];

/**
 * A `switch` without `default` whose cases take every value its subject's type holds, with nothing after it that ends
 * the file: today's checker plans it, the route gives TSV052 and no plan, a compile error on valid code (V30 §32, #2660).
 * The boolean and `askChoice` forms are declared here because they have no twin without a `switch`; the type-case form
 * is inherited (`if s is integer { exit }` gives it on the route without a `switch`).
 */
export const DECLARED_WAY_ERRORS: readonly {
  readonly form: string;
  readonly files: readonly { readonly path: string; readonly source: string }[];
}[] = [
  {
    form: "both booleans",
    files: [
      {
        path: "main.tease",
        source:
          "let b = hostValue == null\nswitch b {\n  case true {\n    exit\n  }\n  case false {\n    exit\n  }\n}\n",
      },
    ],
  },
  {
    form: "every button of an `askChoice`",
    files: [
      {
        path: "main.tease",
        source:
          'let c = askChoice "a", "b"\nswitch c {\n  case "a" {\n    goto "part.tease"\n  }\n  case "b" {\n    exit\n  }\n}\n',
      },
      { path: "part.tease", source: "exit\n" },
    ],
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

/** The control-flow contexts the guard samples a command in (R12, R16). */
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
