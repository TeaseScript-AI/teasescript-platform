import { isRecord } from "./ast.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
import {
  JAVA_HELPER_ORDER,
  JAVA_HELPERS,
  javaHelperDependencies,
  type JavaHelperName,
} from "./java-helpers.ts";

/** Generated function that calls the function an action ID (a converted closure value) stands for. */
export const ACTION_DISPATCHER = "sexscriptLegacyCall";
/** Marks that a program calls actions, which requires the dispatcher even without known actions. */
export const ACTION_DISPATCHER_MARKER = "#dispatch";

/**
 * Adds the action dispatcher when the program calls closure values. Each known action calls its function with the
 * supplied arguments, up to the parameters the function declares, so omitted optional parameters keep their
 * defaults. Unlike Groovy, extra arguments are ignored and unknown actions return null.
 */
export function withActionDispatcher(
  program: MigrationProgram,
  /** Actions whose functions return no value, which the dispatcher calls and then leaves with a bare `return`. */
  voidActions: ReadonlySet<string> = new Set(),
): MigrationProgram {
  const actions = program.actions ?? [];
  if (!actions.includes(ACTION_DISPATCHER_MARKER)) return program;
  const signatures = new Map<string, { required: number; total: number }>();
  for (const statement of program.statements) {
    if (statement.kind !== "function") continue;
    const required = statement.parameters.filter(
      (parameter) => parameter.defaultValue === null,
    ).length;
    signatures.set(statement.name, { required, total: statement.parameters.length });
  }
  // A function that returns no value gives null; a bare `return` gives it without fixing the result type (V30 §17).
  const callWith = (action: string, count: number): IrStatement[] => {
    const call: IrExpression = {
      kind: "call",
      name: action,
      positional: Array.from({ length: count }, (_, index) => at(v("args"), lit(index))),
      named: {},
      local: true,
    };
    return voidActions.has(action)
      ? [
          { kind: "expression", expression: call, span: null },
          { kind: "return", value: null, span: null },
        ]
      : [ret(call)];
  };
  const branches = actions
    .filter((action) => action !== ACTION_DISPATCHER_MARKER)
    .toSorted()
    .map((action) => {
      const { required, total } = signatures.get(action) ?? { required: 0, total: 0 };
      // The compared ID follows renames of its function like every other action ID.
      const id: IrExpression = { kind: "literal", value: action, action: true };
      const calls: IrStatement[] = [];
      for (let count = total; count > required; count -= 1) {
        calls.push(ifS(bin(">=", prop(v("args"), "length"), lit(count)), callWith(action, count)));
      }
      calls.push(...callWith(action, required));
      return ifS(bin("==", v("action"), id), calls);
    });
  // An unknown action returns null by reaching the end, which keeps the result type the actions' own (V30 §17).
  const dispatcher = fn(ACTION_DISPATCHER, ["action", "args"], branches);
  const note: IrStatement = {
    kind: "comment",
    text: "// Calls the function an action ID names. Unlike Groovy, extra arguments are ignored and an unknown action returns null.",
    trailing: false,
    span: null,
  };
  return { ...program, statements: [note, dispatcher, ...program.statements] };
}

/**
 * Variables that start with a literal and are later set to a dispatcher result take the dispatcher's declared result
 * type, such as `boolean | number | null`, when it holds the literal: the variable types were settled before the
 * dispatcher existed, and Groovy let the variable hold whatever the called closure returned.
 */
export function withDispatcherResultTypes(statements: IrStatement[]): IrStatement[] {
  const dispatcher = statements.find(
    (statement) => statement.kind === "function" && statement.name === ACTION_DISPATCHER,
  );
  const resultType = dispatcher?.kind === "function" ? dispatcher.returnType : undefined;
  if (resultType === undefined) return statements;
  const members = new Set(
    (resultType.endsWith("?") ? `${resultType.slice(0, -1)} | null` : resultType)
      .replaceAll(/[()]/gu, "")
      .split("|")
      .map((member) => member.trim()),
  );
  const holds = (value: IrExpression): boolean => {
    if (value.kind !== "literal") return false;
    if (value.value === null) return members.has("null");
    if (typeof value.value === "boolean") return members.has("boolean");
    if (typeof value.value === "string") return members.has("string");
    return members.has("number") || (members.has("integer") && Number.isInteger(value.value));
  };
  // The names a body sets to a dispatcher result, outside the functions it defines.
  const dispatched = (body: readonly IrStatement[]): Set<string> => {
    const names = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      if (!isRecord(value) || value.kind === "function") return;
      const { target, value: assigned } = value;
      if (
        value.kind === "assign" &&
        value.operator === "=" &&
        isRecord(target) &&
        target.kind === "variable" &&
        typeof target.name === "string" &&
        isRecord(assigned) &&
        assigned.kind === "call" &&
        assigned.name === ACTION_DISPATCHER
      )
        names.add(target.name);
      Object.values(value).forEach(visit);
    };
    visit(body);
    return names;
  };
  const typed = (body: IrStatement[], names: ReadonlySet<string>): IrStatement[] =>
    body.map((statement): IrStatement => {
      if (statement.kind === "function") {
        const own = dispatched(statement.body);
        return own.size === 0 ? statement : { ...statement, body: typed(statement.body, own) };
      }
      if (
        statement.kind === "let" &&
        statement.type === undefined &&
        names.has(statement.name) &&
        holds(statement.value)
      )
        return { ...statement, type: resultType };
      return withNestedBodies(statement, (inner) => typed(inner, names));
    });
  return typed(statements, dispatched(statements));
}

function withNestedBodies(
  statement: IrStatement,
  map: (body: IrStatement[]) => IrStatement[],
): IrStatement {
  switch (statement.kind) {
    case "if":
      return { ...statement, then: map(statement.then), else: map(statement.else) };
    case "while":
    case "repeat":
    case "for":
      return { ...statement, body: map(statement.body) };
    case "switch":
      return {
        ...statement,
        cases: statement.cases.map((item) => ({ ...item, body: map(item.body) })),
        default: map(statement.default),
      };
    default:
      return statement;
  }
}

/**
 * Small ordinary TeaseScript functions the importer generates when a legacy operation has no single TeaseScript
 * expression. Each is emitted once per generated file that needs it.
 */
export type HelperName =
  | "array"
  | "fixed"
  | "packagePath"
  | "pathTag"
  | "items"
  | "itemAt"
  | "truth"
  | "text"
  | "systemSpeaker"
  | "deviceButtons"
  | "showDevice"
  | "openTray"
  | "askOnce"
  | "deviceId"
  | "maskUrl"
  | "textLines"
  | "endsWithDigits"
  | "plainText"
  | "listPart"
  | "listMinus"
  | "booleanText"
  | "button"
  | "value"
  | "missingText"
  | "loadInteger"
  | "loadFloat"
  | "textMinus"
  | "textAt"
  | "slice"
  | "spliced"
  | "repeatList"
  | "compare"
  | "replaceChars"
  | "askInteger"
  | "askNumber"
  | "sendImage"
  | "switchButton"
  | "switchButtonId"
  | "tokenize"
  | "backgroundSounds"
  | "concat"
  | "count"
  | "indexOf"
  | "listMax"
  | "listMin"
  | "listSum"
  | "loadFirstTrue"
  | "max"
  | "menuOptions"
  | "min"
  | "playBackgroundSound"
  | "random"
  | "shuffled"
  | "stopBackgroundSounds"
  | "unique"
  | JavaHelperName;

/** Parts of query parameter names whose values a notice hides (helper `maskUrl`, maskedUrl in lower.ts). */
export const SECRET_PARAMETER_PARTS = ["key", "token", "pass", "secret", "auth"];

/** The speaker of the questions and notices the importer adds (helper `systemSpeaker`). */
export const SYSTEM_SPEAKER = "system";

export function helperCall(name: HelperName, args: IrExpression[]): IrExpression {
  return { kind: "call", name: HELPERS[name].name, positional: args, named: {} };
}

/**
 * Position of a generated helper definition in the stable helper order, or -1 for other statements. Every program
 * that needs a helper generates the same definition.
 */
export function helperDefinitionOrder(statement: IrStatement): number {
  if (statement.kind !== "function" && statement.kind !== "let" && statement.kind !== "speaker")
    return -1;
  return HELPER_ORDER.findIndex((name) => HELPERS[name].name === statement.name);
}

/** Helper functions in a stable order, so generated files do not depend on discovery order. */
export function helperStatements(names: ReadonlySet<HelperName>): IrStatement[] {
  const needed = new Set(names);
  if (needed.has("switchButton")) needed.add("switchButtonId");
  if (needed.has("showDevice") || needed.has("openTray")) needed.add("deviceButtons");
  if (needed.has("askOnce")) needed.add("systemSpeaker");
  if (needed.has("loadInteger") || needed.has("loadFloat") || needed.has("slice"))
    needed.add("value");
  if (needed.has("playBackgroundSound")) needed.add("stopBackgroundSounds");
  if (needed.has("stopBackgroundSounds")) needed.add("backgroundSounds");
  for (const name of needed)
    for (const dependency of javaHelperDependencies(name)) needed.add(dependency);
  return HELPER_ORDER.filter((name) => needed.has(name)).map((name) => HELPERS[name].build());
}

/** Every helper definition, for analyses that need what the helpers return. */
export function allHelperStatements(): IrStatement[] {
  return helperStatements(new Set(HELPER_ORDER));
}

const HELPER_ORDER: readonly HelperName[] = [
  "systemSpeaker",
  "backgroundSounds",
  "playBackgroundSound",
  "stopBackgroundSounds",
  "random",
  "loadFirstTrue",
  "value",
  "missingText",
  "loadInteger",
  "loadFloat",
  "button",
  "indexOf",
  "count",
  "concat",
  "array",
  "shuffled",
  "unique",
  "menuOptions",
  "listMax",
  "listMin",
  "listSum",
  "max",
  "min",
  "fixed",
  "packagePath",
  "pathTag",
  "items",
  "itemAt",
  "truth",
  "text",
  "deviceButtons",
  "showDevice",
  "openTray",
  "askOnce",
  "deviceId",
  "maskUrl",
  "textLines",
  "endsWithDigits",
  "plainText",
  "listPart",
  "listMinus",
  "booleanText",
  "textMinus",
  "textAt",
  "slice",
  "spliced",
  "repeatList",
  "compare",
  "replaceChars",
  "askInteger",
  "askNumber",
  "tokenize",
  "sendImage",
  "switchButtonId",
  "switchButton",
  ...JAVA_HELPER_ORDER,
];

const v = (name: string): IrExpression => ({ kind: "variable", name });
const lit = (value: string | number | boolean | null): IrExpression => ({ kind: "literal", value });
const bin = (operator: string, left: IrExpression, right: IrExpression): IrExpression => ({
  kind: "binary",
  operator,
  left,
  right,
});
const at = (target: IrExpression, index: IrExpression): IrExpression => ({
  kind: "index",
  target,
  index,
});
const prop = (target: IrExpression, name: string): IrExpression => ({
  kind: "property",
  target,
  name,
});
const letS = (name: string, value: IrExpression): IrStatement => ({
  kind: "let",
  name,
  value,
  span: null,
});
const set = (
  target: IrExpression,
  value: IrExpression,
  operator: "=" | "+=" | "-=" = "=",
): IrStatement => ({ kind: "assign", target, operator, value, span: null });
const add = (list: string, value: IrExpression): IrStatement => ({
  kind: "expression",
  expression: { kind: "methodCall", target: v(list), name: "add", arguments: [value] },
  span: null,
});
const ret = (value: IrExpression): IrStatement => ({ kind: "return", value, span: null });
const ifS = (
  condition: IrExpression,
  then: IrStatement[],
  otherwise: IrStatement[] = [],
): IrStatement => ({ kind: "if", condition, then, else: otherwise, span: null });
const forS = (variable: string, collection: IrExpression, body: IrStatement[]): IrStatement => ({
  kind: "for",
  variable,
  collection,
  body,
  span: null,
});
/** A storage read whose stored value the conversion parses, with `whenMissing` for a missing key. */
function parsedLoad(name: string, conversion: "toInteger" | "toNumber"): IrStatement {
  return {
    kind: "function",
    name,
    parameters: [
      { name: "key", defaultValue: null },
      { name: "whenMissing", defaultValue: lit(null) },
    ],
    body: [
      letS("value", { kind: "load", key: v("key") }),
      ifS(bin("==", v("value"), lit(null)), [ret(v("whenMissing"))]),
      ret({
        kind: "call",
        name: "sexscriptLegacyValue",
        positional: [{ kind: "call", name: conversion, positional: [v("value")], named: {} }],
        named: {},
      }),
    ],
    span: null,
  };
}

/**
 * The part a Groovy range index `from..to`, or `from..<to` when `exclusive`, covers: the positions from `low` up to but
 * not including `high`, and whether it `runsBack`. Like Groovy's subListBorders, a negative end counts from the end
 * first; the range runs backwards where `from` then comes after `to`, and leaves out its `to` end when exclusive. A
 * read (`fractions`) drops a fraction of an end toward zero, and a fractional end makes Groovy's NumberRange, whose
 * ends come in order of their values first; a write keeps the fraction, which stops the script where Groovy failed too.
 */
const positions = (fractions: boolean): IrStatement[] => {
  const whole = (name: string): IrExpression =>
    fractions ? { kind: "call", name: "toInteger", positional: [v(name)], named: {} } : v(name);
  return [
    ...(fractions
      ? [
          letS("start", v("from")),
          letS("finish", v("to")),
          ifS(
            bin(
              "and",
              {
                kind: "unary",
                operator: "not",
                value: bin(
                  "and",
                  { kind: "typeTest", value: v("from"), type: "integer" },
                  { kind: "typeTest", value: v("to"), type: "integer" },
                ),
              },
              bin(">", v("from"), v("to")),
            ),
            [set(v("start"), v("to")), set(v("finish"), v("from"))],
          ),
        ]
      : []),
    letS("first", whole(fractions ? "start" : "from")),
    ifS(bin("<", v("first"), lit(0)), [set(v("first"), prop(v("value"), "length"), "+=")]),
    letS("last", whole(fractions ? "finish" : "to")),
    ifS(bin("<", v("last"), lit(0)), [set(v("last"), prop(v("value"), "length"), "+=")]),
    letS("runsBack", bin(">", v("first"), v("last"))),
    letS("low", v("first")),
    letS("high", bin("+", v("last"), lit(1))),
    ifS(v("exclusive"), [set(v("high"), v("last"))]),
    ifS(v("runsBack"), [
      set(v("low"), v("last")),
      ifS(v("exclusive"), [set(v("low"), bin("+", v("last"), lit(1)))]),
      set(v("high"), bin("+", v("first"), lit(1))),
    ]),
  ];
};
const fn = (
  name: string,
  parameters: string[],
  body: IrStatement[],
  defaults: Record<string, IrExpression> = {},
): IrStatement => ({
  kind: "function",
  name,
  parameters: parameters.map((parameter) => ({
    name: parameter,
    defaultValue: defaults[parameter] ?? null,
  })),
  body,
  span: null,
});
const range = (to: IrExpression, inclusive = false): IrExpression => ({
  kind: "range",
  from: lit(0),
  to,
  inclusive,
});
const template = (...parts: Array<string | IrExpression>): IrExpression => ({
  kind: "template",
  parts: parts.map((part) => (typeof part === "string" ? { text: part } : { value: part })),
});

/**
 * The body of a switch-state helper: ON or OFF by the command's last word (`on`, `ein`, `an`, `off`, `aus`), shown by
 * `show`; another command changes nothing.
 */
function switchStateBody([show]: [(state: "ON" | "OFF") => IrStatement[]]): IrStatement[] {
  const words = (...items: string[]): IrExpression => ({
    kind: "list",
    items: items.map((item) => lit(item)),
  });
  return [
    letS("last", {
      kind: "methodCall",
      target: prop(
        {
          kind: "methodCall",
          target: { kind: "methodCall", target: v("command"), name: "trim", arguments: [] },
          name: "split",
          arguments: [lit(" ")],
        },
        "last",
      ),
      name: "lowercase",
      arguments: [],
    }),
    ifS(
      {
        kind: "methodCall",
        target: words("on", "ein", "an"),
        name: "contains",
        arguments: [v("last")],
      },
      show("ON"),
    ),
    ifS(
      { kind: "methodCall", target: words("off", "aus"), name: "contains", arguments: [v("last")] },
      show("OFF"),
    ),
  ];
}

/** Picks the larger or smaller element; Groovy max()/min() return null for an empty list. */
function extremum(name: string, operator: ">" | "<"): IrStatement {
  return fn(
    name,
    ["items"],
    [
      ifS(bin("==", prop(v("items"), "length"), lit(0)), [ret(lit(null))]),
      letS("best", prop(v("items"), "first")),
      forS("item", v("items"), [
        ifS(bin(operator, v("item"), v("best")), [set(v("best"), v("item"))]),
      ]),
      ret(v("best")),
    ],
  );
}

const randomBelow = (max: IrExpression): IrExpression => ({
  kind: "call",
  name: "randomInteger",
  positional: [range(max)],
  named: {},
});

/** The button of a device in the device buttons (helper `deviceButtons`). */
function deviceButton(device: IrExpression): IrExpression {
  return { kind: "index", target: v("sexscriptLegacyDeviceButtons"), index: device, dict: true };
}

/** Removes a device's button, if it has one. */
function removeDeviceButton(device: IrExpression): IrStatement[] {
  return [
    ifS(
      {
        kind: "methodCall",
        target: v("sexscriptLegacyDeviceButtons"),
        name: "contains",
        arguments: [device],
        dict: true,
      },
      [
        {
          kind: "expression",
          expression: {
            kind: "call",
            name: "removePermanentButton",
            positional: [deviceButton(device)],
            named: {},
          },
          span: null,
        },
      ],
    ),
  ];
}

const HELPERS: Record<HelperName, { name: string; build: () => IrStatement }> = {
  // Legacy background sounds overlapped and playBackgroundSound(null) stopped them all; TeaseScript stops async
  // media through its handle, so the handles are collected.
  backgroundSounds: {
    name: "sexscriptBackgroundSounds",
    build: () => letS("sexscriptBackgroundSounds", { kind: "list", items: [] }),
  },
  playBackgroundSound: {
    name: "sexscriptLegacyPlayBackgroundSound",
    build: () =>
      fn(
        "sexscriptLegacyPlayBackgroundSound",
        ["file", "passes"],
        [
          // A null file stopped all background sounds; fewer than one pass played nothing.
          ifS(bin("==", v("file"), lit(null)), [
            {
              kind: "expression",
              expression: {
                kind: "call",
                name: "sexscriptLegacyStopBackgroundSounds",
                positional: [],
                named: {},
              },
              span: null,
            },
            { kind: "return", value: null, span: null },
          ]),
          ifS(bin("<", v("passes"), lit(1)), [{ kind: "return", value: null, span: null }]),
          {
            kind: "playAudio",
            file: v("file"),
            async: true,
            repeatCount: v("passes"),
            handle: "sound",
            span: null,
          },
          add("sexscriptBackgroundSounds", v("sound")),
        ],
      ),
  },
  stopBackgroundSounds: {
    name: "sexscriptLegacyStopBackgroundSounds",
    build: () =>
      fn(
        "sexscriptLegacyStopBackgroundSounds",
        [],
        [
          forS("sound", v("sexscriptBackgroundSounds"), [
            {
              kind: "expression",
              expression: { kind: "methodCall", target: v("sound"), name: "stop", arguments: [] },
              span: null,
            },
          ]),
          set(v("sexscriptBackgroundSounds"), { kind: "list", items: [] }),
        ],
      ),
  },
  random: {
    // SexScript getRandom(max) computed (int) (Math.random() * (int) max): 0 for 0, toward zero for a negative
    // max, and 0..99 for null. randomInteger() rejects the empty range 0..0.
    name: "sexscriptLegacyRandom",
    build: () =>
      fn(
        "sexscriptLegacyRandom",
        ["limit"],
        [
          ifS(bin("==", v("limit"), lit(null)), [ret(randomBelow(lit(100)))]),
          // A fractional bound was truncated toward zero, like (int) max.
          letS("bound", bin("-", v("limit"), bin("%", v("limit"), lit(1)))),
          ifS(bin(">", v("bound"), lit(0)), [ret(randomBelow(v("bound")))]),
          ifS(bin("<", v("bound"), lit(0)), [
            ret({
              kind: "unary",
              operator: "-",
              value: randomBelow({ kind: "unary", operator: "-", value: v("bound") }),
            }),
          ]),
          ret(lit(0)),
        ],
      ),
  },
  // Java %.Nf: the number rounded to `digits` decimals, written with exactly that many.
  fixed: {
    name: "sexscriptLegacyFixed",
    build: () =>
      fn(
        "sexscriptLegacyFixed",
        ["value", "digits", "factor"],
        [
          letS("scaled", {
            kind: "call",
            name: "round",
            positional: [bin("*", v("value"), v("factor"))],
            named: {},
          }),
          letS("minus", lit("")),
          ifS(bin("<", v("scaled"), lit(0)), [
            set(v("minus"), lit("-")),
            set(v("scaled"), { kind: "unary", operator: "-", value: v("scaled") }),
          ]),
          letS("whole", {
            kind: "call",
            name: "toInteger",
            positional: [bin("/", v("scaled"), v("factor"))],
            named: {},
          }),
          ifS(bin("==", v("digits"), lit(0)), [ret(template(v("minus"), v("whole")))]),
          letS("fraction", bin("-", v("scaled"), bin("*", v("whole"), v("factor")))),
          ret(
            template(v("minus"), v("whole"), ".", {
              kind: "methodCall",
              target: { kind: "call", name: "toString", positional: [v("fraction")], named: {} },
              name: "padStart",
              arguments: [v("digits"), lit("0")],
            }),
          ),
        ],
      ),
  },
  // Groovy tokenize(): the parts between any of the delimiter characters, without empty parts.
  tokenize: {
    name: "sexscriptLegacyTokenize",
    build: () =>
      fn(
        "sexscriptLegacyTokenize",
        ["text", "delimiters"],
        [
          letS("tokens", { kind: "list", items: [] }),
          letS("current", lit("")),
          forS(
            "character",
            { kind: "methodCall", target: v("text"), name: "split", arguments: [lit("")] },
            [
              ifS(
                {
                  kind: "methodCall",
                  target: v("delimiters"),
                  name: "contains",
                  arguments: [v("character")],
                },
                [
                  ifS(bin("!=", v("current"), lit("")), [add("tokens", v("current"))]),
                  set(v("current"), lit("")),
                ],
                [set(v("current"), template(v("current"), v("character")))],
              ),
            ],
          ),
          ifS(bin("!=", v("current"), lit("")), [add("tokens", v("current"))]),
          ret(v("tokens")),
        ],
      ),
  },
  // The image tag of a legacy folder path (pathTag in image-tags.ts): lower case, every run of other characters than
  // ASCII letters and digits as one hyphen, none at either end.
  pathTag: {
    name: "sexscriptLegacyPathTag",
    build: () =>
      fn(
        "sexscriptLegacyPathTag",
        ["path"],
        [
          letS("tag", lit("")),
          letS("gap", lit(false)),
          forS(
            "character",
            {
              kind: "methodCall",
              target: { kind: "methodCall", target: v("path"), name: "lowercase", arguments: [] },
              name: "split",
              arguments: [lit("")],
            },
            [
              ifS(
                {
                  kind: "methodCall",
                  target: lit("abcdefghijklmnopqrstuvwxyz0123456789"),
                  name: "contains",
                  arguments: [v("character")],
                },
                [
                  ifS(bin("and", v("gap"), bin("!=", v("tag"), lit(""))), [
                    set(v("tag"), template(v("tag"), "-")),
                  ]),
                  set(v("tag"), template(v("tag"), v("character"))),
                  set(v("gap"), lit(false)),
                ],
                [set(v("gap"), lit(true))],
              ),
            ],
          ),
          ret(v("tag")),
        ],
      ),
  },
  // Java replaceAll() with one character class: each character in `chars` (or, with `keep`, each other character)
  // becomes the replacement, a run of them at once with `runs`.
  replaceChars: {
    name: "sexscriptLegacyReplaceChars",
    build: () =>
      fn(
        "sexscriptLegacyReplaceChars",
        ["text", "chars", "keep", "replacement", "runs"],
        [
          letS("result", lit("")),
          letS("inRun", lit(false)),
          forS(
            "character",
            { kind: "methodCall", target: v("text"), name: "split", arguments: [lit("")] },
            [
              ifS(
                bin(
                  "==",
                  {
                    kind: "methodCall",
                    target: v("chars"),
                    name: "contains",
                    arguments: [v("character")],
                  },
                  v("keep"),
                ),
                [
                  set(v("result"), template(v("result"), v("character"))),
                  set(v("inRun"), lit(false)),
                ],
                [
                  ifS(
                    { kind: "unary", operator: "not", value: bin("and", v("runs"), v("inRun")) },
                    [set(v("result"), template(v("result"), v("replacement")))],
                  ),
                  set(v("inRun"), lit(true)),
                ],
              ),
            ],
          ),
          ret(v("result")),
        ],
      ),
  },
  // Groovy's ordering, with null below every value: -1, 0, or 1.
  compare: {
    name: "sexscriptLegacyCompare",
    build: () =>
      fn(
        "sexscriptLegacyCompare",
        ["left", "right"],
        [
          ifS(bin("==", v("left"), lit(null)), [
            ifS(bin("==", v("right"), lit(null)), [ret(lit(0))]),
            ret(lit(-1)),
          ]),
          ifS(bin("==", v("right"), lit(null)), [ret(lit(1))]),
          ifS(bin("<", v("left"), v("right")), [ret(lit(-1))]),
          ifS(bin(">", v("left"), v("right")), [ret(lit(1))]),
          ret(lit(0)),
        ],
      ),
  },
  askInteger: {
    name: "sexscriptLegacyAskInteger",
    build: () =>
      fn(
        "sexscriptLegacyAskInteger",
        ["prefill"],
        [
          ifS({ kind: "typeTest", value: v("prefill"), type: "number" }, [
            ifS(bin("==", bin("%", v("prefill"), lit(1)), lit(0)), [
              ret({
                kind: "input",
                input: "askInteger",
                defaultValue: {
                  kind: "call",
                  name: "floor",
                  positional: [v("prefill")],
                  named: {},
                },
              }),
            ]),
          ]),
          ret({ kind: "input", input: "askInteger" }),
        ],
      ),
  },
  askNumber: {
    name: "sexscriptLegacyAskNumber",
    build: () =>
      fn(
        "sexscriptLegacyAskNumber",
        ["prefill"],
        [
          ifS({ kind: "typeTest", value: v("prefill"), type: "number" }, [
            ret({ kind: "input", input: "askNumber", defaultValue: v("prefill") }),
          ]),
          ret({ kind: "input", input: "askNumber" }),
        ],
      ),
  },
  // A list element as Groovy read it: null past the end, and a negative position counted from the end.
  itemAt: {
    name: "sexscriptLegacyItemAt",
    build: () =>
      fn(
        "sexscriptLegacyItemAt",
        ["list", "position"],
        [
          ifS(bin("<", v("position"), lit(0)), [
            ret(at(v("list"), bin("+", prop(v("list"), "length"), v("position")))),
          ]),
          ifS(bin(">=", v("position"), prop(v("list"), "length")), [ret(lit(null))]),
          ret(at(v("list"), v("position"))),
        ],
      ),
  },
  // The speaker of the questions and notices the importer adds, which the legacy author never wrote (owner decision).
  systemSpeaker: {
    name: SYSTEM_SPEAKER,
    build: () => ({
      kind: "speaker",
      name: SYSTEM_SPEAKER,
      properties: [{ name: "title", value: lit("System") }],
      span: null,
    }),
  },
  // The permanent buttons that show the state of each device the legacy script controlled through a program.
  deviceButtons: {
    name: "sexscriptLegacyDeviceButtons",
    build: () =>
      letS("sexscriptLegacyDeviceButtons", { kind: "object", properties: [], dict: true }),
  },
  // A device's state as a permanent button, `Estim: RUNNING`, replacing the device's earlier button (owner decision).
  showDevice: {
    name: "sexscriptLegacyShowDevice",
    build: () =>
      fn(
        "sexscriptLegacyShowDevice",
        ["device", "state"],
        [
          ...removeDeviceButton(v("device")),
          {
            kind: "permanentButton",
            target: deviceButton(v("device")),
            label: template(v("device"), ": ", v("state")),
            persist: true,
            span: null,
          },
        ],
      ),
  },
  // An open CD tray as a permanent button; clicking it closes the tray, so the button goes (owner decision).
  openTray: {
    name: "sexscriptLegacyOpenTray",
    build: () =>
      fn(
        "sexscriptLegacyOpenTray",
        [],
        [
          ...removeDeviceButton(lit("CD tray")),
          {
            kind: "permanentButton",
            target: deviceButton(lit("CD tray")),
            label: lit("CD tray: OPEN"),
            persist: true,
            body: removeDeviceButton(lit("CD tray")).flatMap((statement) =>
              statement.kind === "if" ? statement.then : [],
            ),
            span: null,
          },
        ],
      ),
  },
  // Information the legacy player's computer provided, asked once as the system speaker and saved (owner decision).
  askOnce: {
    name: "sexscriptLegacyAskOnce",
    build: () =>
      fn(
        "sexscriptLegacyAskOnce",
        ["key", "question"],
        [
          ifS(bin("==", { kind: "load", key: v("key") }, lit(null)), [
            {
              kind: "save",
              key: v("key"),
              value: {
                kind: "input",
                input: "askText",
                question: v("question"),
                speaker: SYSTEM_SPEAKER,
              },
              span: null,
            },
          ]),
          ret({ kind: "load", key: v("key") }),
        ],
      ),
  },
  // A random ID made once and saved, where the legacy script used the computer's network hardware address.
  deviceId: {
    name: "sexscriptLegacyDeviceId",
    build: () =>
      fn(
        "sexscriptLegacyDeviceId",
        [],
        [
          ifS(bin("==", { kind: "load", key: lit("system.deviceId") }, lit(null)), [
            {
              kind: "save",
              key: lit("system.deviceId"),
              value: template({
                kind: "call",
                name: "randomInteger",
                positional: [
                  { kind: "range", from: lit(0), to: lit(2147483647), inclusive: false },
                ],
                named: {},
              }),
              span: null,
            },
          ]),
          ret({ kind: "load", key: lit("system.deviceId") }),
        ],
      ),
  },
  // A URL for a notice, with the values of query parameters named like a key, token, or password hidden.
  maskUrl: {
    name: "sexscriptLegacyMaskUrl",
    build: () => {
      const method = (
        target: IrExpression,
        name: string,
        ...args: IrExpression[]
      ): IrExpression => ({ kind: "methodCall", target, name, arguments: args });
      const secret = SECRET_PARAMETER_PARTS.map((part) =>
        method(v("name"), "contains", lit(part)),
      ).reduce((left, right) => bin("or", left, right));
      return fn(
        "sexscriptLegacyMaskUrl",
        ["url"],
        [
          letS("parts", method(template(v("url")), "split", lit("?"))),
          ifS(bin("<", prop(v("parts"), "length"), lit(2)), [ret(template(v("url")))]),
          letS("masked", { kind: "list", items: [] }),
          forS("pair", method(at(v("parts"), lit(1)), "split", lit("&")), [
            letS("field", at(method(v("pair"), "split", lit("=")), lit(0))),
            letS("name", method(v("field"), "lowercase")),
            ifS(
              secret,
              [
                {
                  kind: "expression",
                  expression: method(v("masked"), "add", template(v("field"), "=…")),
                  span: null,
                },
              ],
              [
                {
                  kind: "expression",
                  expression: method(v("masked"), "add", v("pair")),
                  span: null,
                },
              ],
            ),
          ]),
          ret(template(at(v("parts"), lit(0)), "?", method(v("masked"), "join", lit("&")))),
        ],
      );
    },
  },
  // The lines of a text as File.readLines() split them: at LF, CR, or CRLF, without an empty last line.
  textLines: {
    name: "sexscriptLegacyTextLines",
    build: () => {
      const replace = (target: IrExpression, from: string, to: string): IrExpression => ({
        kind: "methodCall",
        target,
        name: "replace",
        arguments: [lit(from), lit(to)],
      });
      return fn(
        "sexscriptLegacyTextLines",
        ["text"],
        [
          letS("lines", {
            kind: "methodCall",
            target: replace(replace(template(v("text")), "\r\n", "\n"), "\r", "\n"),
            name: "split",
            arguments: [lit("\n")],
          }),
          ifS(bin("==", prop(v("lines"), "last"), lit("")), [
            {
              kind: "expression",
              expression: {
                kind: "methodCall",
                target: v("lines"),
                name: "removeLast",
                arguments: [],
              },
              span: null,
            },
          ]),
          ret(v("lines")),
        ],
      );
    },
  },
  // Whether a text ends with digits and then `tail`, as a whole match of `.*\d+tail` (regex-subset parseTailPattern).
  endsWithDigits: {
    name: "sexscriptLegacyEndsWithDigits",
    build: () => {
      const method = (
        target: IrExpression,
        name: string,
        ...args: IrExpression[]
      ): IrExpression => ({ kind: "methodCall", target, name, arguments: args });
      return fn(
        "sexscriptLegacyEndsWithDigits",
        ["text", "tail"],
        [
          ifS({ kind: "unary", operator: "not", value: method(v("text"), "endsWith", v("tail")) }, [
            ret(lit(false)),
          ]),
          letS(
            "head",
            method(
              v("text"),
              "substring",
              lit(0),
              bin("-", prop(v("text"), "length"), prop(v("tail"), "length")),
            ),
          ),
          ret(
            bin(
              "and",
              bin(">", prop(v("head"), "length"), lit(0)),
              method(
                lit("0123456789"),
                "contains",
                method(v("head"), "substring", bin("-", prop(v("head"), "length"), lit(1))),
              ),
            ),
          ),
        ],
      );
    },
  },
  // Text without message markup markers, for a loop that shows it character by character (lower.ts plainCharacters).
  plainText: {
    name: "sexscriptLegacyPlainText",
    build: () => {
      const method = (
        target: IrExpression,
        name: string,
        ...args: IrExpression[]
      ): IrExpression => ({ kind: "methodCall", target, name, arguments: args });
      const stripped = ["**", "~~", "[u]", "[/u]", "[/color]"].reduce(
        (text, marker) => method(text, "replace", lit(marker), lit("")),
        template(v("value")),
      );
      return fn(
        "sexscriptLegacyPlainText",
        ["value"],
        [
          letS("text", stripped),
          letS("start", method(v("text"), "indexOf", lit("[color="))),
          {
            kind: "while",
            condition: bin(">=", v("start"), lit(0)),
            body: [
              letS("end", method(v("text"), "indexOf", lit("]"))),
              ifS(bin("<", v("end"), v("start")), [
                ret(method(v("text"), "replace", lit("*"), lit(""))),
              ]),
              set(
                v("text"),
                template(
                  method(v("text"), "substring", lit(0), v("start")),
                  method(v("text"), "substring", bin("+", v("end"), lit(1))),
                ),
              ),
              set(v("start"), method(v("text"), "indexOf", lit("[color="))),
            ],
            span: null,
          },
          ret(method(v("text"), "replace", lit("*"), lit(""))),
        ],
      );
    },
  },
  // Legacy loadBoolean(): a stored value read as text is true only as "true" in any case; a missing one is false here.
  // Legacy showButton() with a timeout known only at runtime: the seconds until the click, at most the timeout; a zero
  // timeout kept the button for its 10 ms safety margin and gave 0, where TeaseScript rejects a zero timeout (#531).
  button: {
    name: "sexscriptLegacyShowButton",
    build: () =>
      fn(
        "sexscriptLegacyShowButton",
        ["text", "timeout"],
        [
          ifS(bin("==", v("timeout"), lit(0)), [
            {
              kind: "showButton",
              label: v("text"),
              timeout: { kind: "duration", value: 10, unit: "ms" },
              span: null,
            },
            ret(lit(0)),
          ]),
          ret(
            bin(
              "/",
              { kind: "button", label: v("text"), timeout: v("timeout") },
              { kind: "duration", value: 1, unit: "s" },
            ),
          ),
        ],
      ),
  },
  // A value whose type the compiler leaves open, as it does a storage read's.
  value: {
    name: "sexscriptLegacyValue",
    build: () => fn("sexscriptLegacyValue", ["value"], [ret(v("value"))]),
  },
  // A text that legacy tested for null, missing, which a missing text read now gives as the empty text; the value may
  // hold null from elsewhere too, so both count, and a call that gives it runs once.
  missingText: {
    name: "sexscriptLegacyMissingText",
    build: () =>
      fn(
        "sexscriptLegacyMissingText",
        ["value"],
        [ret(bin("or", bin("==", v("value"), lit(null)), bin("==", v("value"), lit(""))))],
      ),
  },
  // Legacy loadInteger() and loadFloat() parsed the stored text as a number, loadInteger() dropping its fraction toward
  // zero, and read null for a missing key, which the script could replace with a value of its own (`whenMissing`). The
  // parsed value passes through `value`, so that its type stays open, as a storage read's does.
  loadInteger: {
    name: "sexscriptLegacyLoadInteger",
    build: () => parsedLoad("sexscriptLegacyLoadInteger", "toInteger"),
  },
  loadFloat: {
    name: "sexscriptLegacyLoadFloat",
    build: () => parsedLoad("sexscriptLegacyLoadFloat", "toNumber"),
  },
  booleanText: {
    name: "sexscriptLegacyBooleanText",
    build: () =>
      fn(
        "sexscriptLegacyBooleanText",
        ["value"],
        [
          ret(
            bin(
              "==",
              {
                kind: "methodCall",
                target: template(v("value")),
                name: "lowercase",
                arguments: [],
              },
              lit("true"),
            ),
          ),
        ],
      ),
  },
  // A value stored in a Groovy String variable: its text, and null stays null.
  text: {
    name: "sexscriptLegacyText",
    build: () =>
      fn(
        "sexscriptLegacyText",
        ["value"],
        [ifS(bin("==", v("value"), lit(null)), [ret(lit(null))]), ret(template(v("value")))],
      ),
  },
  // Groovy truth: false for null, false, zero, empty text, and an empty list, set, dict, or map.
  truth: {
    name: "sexscriptLegacyTruth",
    build: () => {
      const is = (type: string): IrExpression => ({ kind: "typeTest", value: v("value"), type });
      const filled = prop(v("value"), "length");
      return fn(
        "sexscriptLegacyTruth",
        ["value"],
        [
          ifS(is("boolean"), [ret(v("value"))]),
          ifS(is("number"), [ret(bin("!=", v("value"), lit(0)))]),
          ifS(is("string"), [ret(bin("!=", v("value"), lit("")))]),
          ifS(bin("or", is("list"), is("set")), [ret(bin(">", filled, lit(0)))]),
          ifS(is("dict"), [
            ret(
              bin(
                ">",
                { kind: "property", target: v("value"), name: "length", dict: true },
                lit(0),
              ),
            ),
          ]),
          ifS(is("object"), [ret(bin("!=", v("value"), { kind: "object", properties: [] }))]),
          ret(bin("!=", v("value"), lit(null))),
        ],
      );
    },
  },
  // What Groovy `list + value` appended: the elements of a list, or any other value, also null, as one element.
  listPart: {
    name: "sexscriptLegacyListPart",
    build: () =>
      fn(
        "sexscriptLegacyListPart",
        ["value"],
        [
          ifS({ kind: "typeTest", value: v("value"), type: "list" }, [ret(v("value"))]),
          ret({ kind: "list", items: [v("value")] }),
        ],
      ),
  },
  // Groovy `text[position]`: the one character there as text, a negative position counting from the end.
  textAt: {
    name: "sexscriptLegacyTextAt",
    build: () =>
      fn(
        "sexscriptLegacyTextAt",
        ["text", "position"],
        [
          letS("at", v("position")),
          ifS(bin("<", v("at"), lit(0)), [set(v("at"), prop(v("text"), "length"), "+=")]),
          ret({
            kind: "methodCall",
            target: v("text"),
            name: "substring",
            arguments: [v("at"), bin("+", v("at"), lit(1))],
          }),
        ],
      ),
  },
  // Groovy `value[from..to]` and `value[from..<to]`: the elements of a list, or the characters of a text, that the range
  // covers (positions), in reverse order where it runs backwards.
  slice: {
    name: "sexscriptLegacySlice",
    build: () => {
      const walk = (step: IrStatement): IrStatement => ({
        kind: "while",
        condition: bin("!=", v("position"), v("stop")),
        body: [step, set(v("position"), v("step"), "+=")],
        span: null,
      });
      return fn(
        "sexscriptLegacySlice",
        ["value", "from", "to", "exclusive"],
        [
          ...positions(true),
          letS("position", v("low")),
          letS("stop", v("high")),
          letS("step", lit(1)),
          ifS(v("runsBack"), [
            set(v("position"), bin("-", v("high"), lit(1))),
            set(v("stop"), bin("-", v("low"), lit(1))),
            set(v("step"), lit(-1)),
          ]),
          letS("part", v("value")),
          ifS(
            { kind: "typeTest", value: v("value"), type: "string" },
            [
              letS("text", lit("")),
              walk(
                set(
                  v("text"),
                  {
                    kind: "methodCall",
                    target: v("value"),
                    name: "substring",
                    arguments: [v("position"), bin("+", v("position"), lit(1))],
                  },
                  "+=",
                ),
              ),
              set(v("part"), v("text")),
            ],
            [
              letS("items", { kind: "list", items: [] }),
              walk(add("items", at(v("value"), v("position")))),
              set(v("part"), v("items")),
            ],
          ),
          // Through `value`, the part keeps an open type, as Groovy's did.
          ret({ kind: "call", name: "sexscriptLegacyValue", positional: [v("part")], named: {} }),
        ],
        { exclusive: lit(false) },
      );
    },
  },
  // Groovy `list[from..to] = values`: the list with the elements the range covers (positions) replaced by the values, a
  // list or one value, in their own order also where the range runs backwards.
  spliced: {
    name: "sexscriptLegacySpliced",
    build: () =>
      fn(
        "sexscriptLegacySpliced",
        ["value", "from", "to", "values", "exclusive"],
        [
          ...positions(false),
          // A part that reaches past the end replaces the elements up to the end; a fractional end stays, to fail.
          ifS(
            bin("and", bin(">", v("high"), prop(v("value"), "length")), {
              kind: "typeTest",
              value: v("to"),
              type: "integer",
            }),
            [set(v("high"), prop(v("value"), "length"))],
          ),
          letS("items", {
            kind: "methodCall",
            target: v("value"),
            name: "take",
            arguments: [v("low")],
          }),
          ifS(
            { kind: "typeTest", value: v("values"), type: "list" },
            [
              {
                kind: "expression",
                expression: {
                  kind: "methodCall",
                  target: v("items"),
                  name: "addAll",
                  arguments: [v("values")],
                },
                span: null,
              },
            ],
            [add("items", v("values"))],
          ),
          {
            kind: "expression",
            expression: {
              kind: "methodCall",
              target: v("items"),
              name: "addAll",
              arguments: [
                {
                  kind: "methodCall",
                  target: v("value"),
                  name: "takeLast",
                  arguments: [bin("-", prop(v("value"), "length"), v("high"))],
                },
              ],
            },
            span: null,
          },
          ret(v("items")),
        ],
        { exclusive: lit(false) },
      ),
  },
  // Groovy `text - part`: the text without the first occurrence of the part.
  textMinus: {
    name: "sexscriptLegacyTextMinus",
    build: () =>
      fn(
        "sexscriptLegacyTextMinus",
        ["text", "part"],
        [
          letS("position", {
            kind: "methodCall",
            target: v("text"),
            name: "indexOf",
            arguments: [v("part")],
          }),
          ifS(bin("<", v("position"), lit(0)), [ret(v("text"))]),
          ret(
            template(
              {
                kind: "methodCall",
                target: v("text"),
                name: "substring",
                arguments: [lit(0), v("position")],
              },
              {
                kind: "methodCall",
                target: v("text"),
                name: "substring",
                arguments: [bin("+", v("position"), prop(v("part"), "length"))],
              },
            ),
          ),
        ],
      ),
  },
  // Groovy `list - other`: the elements that `removed` does not hold, repeated ones too, in order.
  listMinus: {
    name: "sexscriptLegacyListMinus",
    build: () =>
      fn(
        "sexscriptLegacyListMinus",
        ["items", "removed"],
        [
          { kind: "let", name: "kept", value: { kind: "list", items: [] }, span: null },
          {
            kind: "for",
            variable: "item",
            collection: v("items"),
            body: [
              ifS(
                {
                  kind: "unary",
                  operator: "not",
                  value: {
                    kind: "methodCall",
                    target: v("removed"),
                    name: "contains",
                    arguments: [v("item")],
                  },
                },
                [
                  {
                    kind: "expression",
                    expression: {
                      kind: "methodCall",
                      target: v("kept"),
                      name: "add",
                      arguments: [v("item")],
                    },
                    span: null,
                  },
                ],
              ),
            ],
            span: null,
          },
          ret(v("kept")),
        ],
      ),
  },
  // Groovy `list * n`: the list's elements, n times over.
  repeatList: {
    name: "sexscriptLegacyRepeatList",
    build: () =>
      fn(
        "sexscriptLegacyRepeatList",
        ["items", "times"],
        [
          { kind: "let", name: "result", value: { kind: "list", items: [] }, span: null },
          { kind: "let", name: "round", value: lit(0), span: null },
          {
            kind: "while",
            condition: bin("<", v("round"), v("times")),
            body: [
              {
                kind: "assign",
                target: v("result"),
                operator: "+=",
                value: v("items"),
                span: null,
              },
              { kind: "assign", target: v("round"), operator: "+=", value: lit(1), span: null },
            ],
            span: null,
          },
          ret(v("result")),
        ],
      ),
  },
  // The items a Groovy loop visited: none of null, the characters of text, the elements of anything else.
  items: {
    name: "sexscriptLegacyItems",
    build: () =>
      fn(
        "sexscriptLegacyItems",
        ["value"],
        [
          ifS(bin("==", v("value"), lit(null)), [ret({ kind: "list", items: [] })]),
          ifS({ kind: "typeTest", value: v("value"), type: "string" }, [
            ret({ kind: "methodCall", target: v("value"), name: "split", arguments: [lit("")] }),
          ]),
          ret(v("value")),
        ],
      ),
  },
  // A path of the package as file tests compare it (packageFilePath in lower.ts).
  packagePath: {
    name: "sexscriptLegacyPackagePath",
    build: () => {
      const path = v("path");
      const startsWith = (text: string): IrExpression => ({
        kind: "methodCall",
        target: path,
        name: "startsWith",
        arguments: [lit(text)],
      });
      const drop = (length: number): IrStatement =>
        set(path, {
          kind: "methodCall",
          target: path,
          name: "substring",
          arguments: [lit(length)],
        });
      return fn(
        "sexscriptLegacyPackagePath",
        ["path"],
        [
          set(path, {
            kind: "methodCall",
            target: {
              kind: "methodCall",
              target: path,
              name: "replace",
              arguments: [lit("\\"), lit("/")],
            },
            name: "lowercase",
            arguments: [],
          }),
          { kind: "while", condition: startsWith("/"), body: [drop(1)], span: null },
          ifS(startsWith("./"), [drop(2)]),
          ifS(startsWith("scripts/"), [drop(8)]),
          ret(path),
        ],
      );
    },
  },
  // The legacy online service kept a sent image and gave back a code to receive it with; the package's storage keeps
  // the photo reference under its code instead (owner decision 2026-10-05).
  sendImage: {
    name: "sexscriptLegacySendImage",
    build: () =>
      fn(
        "sexscriptLegacySendImage",
        ["reference"],
        [
          letS(
            "code",
            template("image-", {
              kind: "call",
              name: "randomInteger",
              positional: [range(lit(1000000000))],
              named: {},
            }),
          ),
          {
            kind: "save",
            key: template("sexscript.image.", v("code")),
            value: v("reference"),
            span: null,
          },
          ret(v("code")),
        ],
      ),
  },
  // A persistent permanent button that shows a device's switch state and replaces the previous one.
  switchButtonId: {
    name: "sexscriptLegacySwitchButton",
    build: () => letS("sexscriptLegacySwitchButton", lit(null)),
  },
  switchButton: {
    name: "sexscriptLegacyShowSwitch",
    build: () =>
      fn(
        "sexscriptLegacyShowSwitch",
        ["command"],
        switchStateBody([
          (state) => [
            ifS(bin("!=", v("sexscriptLegacySwitchButton"), lit(null)), [
              {
                kind: "expression",
                expression: {
                  kind: "call",
                  name: "removePermanentButton",
                  positional: [v("sexscriptLegacySwitchButton")],
                  named: {},
                },
                span: null,
              },
            ]),
            {
              kind: "permanentButton",
              target: v("sexscriptLegacySwitchButton"),
              label: lit(`Power: ${state}`),
              persist: true,
              span: null,
            },
          ],
        ]),
      ),
  },
  loadFirstTrue: {
    name: "sexscriptLegacyLoadFirstTrue",
    build: () =>
      fn(
        "sexscriptLegacyLoadFirstTrue",
        ["keys"],
        [
          forS("key", v("keys"), [
            letS("value", { kind: "load", key: v("key") }),
            ifS(bin("==", v("value"), lit(true)), [ret(v("key"))]),
          ]),
          ret(lit(null)),
        ],
      ),
  },
  indexOf: {
    name: "sexscriptLegacyIndexOf",
    build: () =>
      fn(
        "sexscriptLegacyIndexOf",
        ["items", "value"],
        [
          letS("index", lit(0)),
          forS("item", v("items"), [
            ifS(bin("==", v("item"), v("value")), [ret(v("index"))]),
            set(v("index"), lit(1), "+="),
          ]),
          ret(lit(-1)),
        ],
      ),
  },
  // Groovy count(value) on a list counts the elements equal to the value.
  count: {
    name: "sexscriptLegacyCount",
    build: () =>
      fn(
        "sexscriptLegacyCount",
        ["items", "value"],
        [
          letS("matches", lit(0)),
          forS("item", v("items"), [
            ifS(bin("==", v("item"), v("value")), [set(v("matches"), lit(1), "+=")]),
          ]),
          ret(v("matches")),
        ],
      ),
  },
  concat: {
    name: "sexscriptLegacyConcat",
    build: () =>
      fn(
        "sexscriptLegacyConcat",
        ["lists"],
        [
          letS("combined", { kind: "list", items: [] }),
          forS("part", v("lists"), [forS("item", v("part"), [add("combined", v("item"))])]),
          ret(v("combined")),
        ],
      ),
  },
  array: {
    name: "sexscriptLegacyArray",
    build: () =>
      fn(
        "sexscriptLegacyArray",
        ["size", "value"],
        [
          letS("items", { kind: "list", items: [] }),
          { kind: "repeat", count: v("size"), body: [add("items", v("value"))], span: null },
          ret(v("items")),
        ],
      ),
  },
  shuffled: {
    // Fisher-Yates shuffle over a copy, using the deterministic session RNG.
    name: "sexscriptLegacyShuffled",
    build: () =>
      fn(
        "sexscriptLegacyShuffled",
        ["items"],
        [
          letS("shuffled", v("items")),
          letS("index", bin("-", prop(v("shuffled"), "length"), lit(1))),
          {
            kind: "while",
            condition: bin(">", v("index"), lit(0)),
            span: null,
            body: [
              letS("other", {
                kind: "call",
                name: "randomInteger",
                positional: [range(v("index"), true)],
                named: {},
              }),
              letS("swap", at(v("shuffled"), v("index"))),
              set(at(v("shuffled"), v("index")), at(v("shuffled"), v("other"))),
              set(at(v("shuffled"), v("other")), v("swap")),
              set(v("index"), lit(1), "-="),
            ],
          },
          ret(v("shuffled")),
        ],
      ),
  },
  unique: {
    name: "sexscriptLegacyUnique",
    build: () =>
      fn(
        "sexscriptLegacyUnique",
        ["items"],
        [
          letS("unique", { kind: "list", items: [] }),
          forS("item", v("items"), [
            ifS(
              {
                kind: "unary",
                operator: "not",
                value: {
                  kind: "methodCall",
                  target: v("unique"),
                  name: "contains",
                  arguments: [v("item")],
                },
              },
              [add("unique", v("item"))],
            ),
          ]),
          ret(v("unique")),
        ],
      ),
  },
  menuOptions: {
    // Choice objects whose values are consecutive numbers from `first`, as the zero-based index that legacy
    // getSelectedValue() returns.
    name: "sexscriptLegacyMenuOptions",
    build: () =>
      fn(
        "sexscriptLegacyMenuOptions",
        ["texts", "first"],
        [
          letS("options", { kind: "list", items: [] }),
          letS("position", v("first")),
          forS("text", v("texts"), [
            add("options", {
              kind: "object",
              properties: [
                { name: "value", value: v("position") },
                { name: "text", value: v("text") },
              ],
            }),
            set(v("position"), lit(1), "+="),
          ]),
          ret(v("options")),
        ],
      ),
  },
  listMax: { name: "sexscriptLegacyListMax", build: () => extremum("sexscriptLegacyListMax", ">") },
  listMin: { name: "sexscriptLegacyListMin", build: () => extremum("sexscriptLegacyListMin", "<") },
  listSum: {
    name: "sexscriptLegacyListSum",
    build: () =>
      fn(
        "sexscriptLegacyListSum",
        ["items"],
        [
          // Groovy sum() of an empty list is null.
          ifS(bin("==", prop(v("items"), "length"), lit(0)), [ret(lit(null))]),
          letS("total", lit(0)),
          forS("item", v("items"), [set(v("total"), v("item"), "+=")]),
          ret(v("total")),
        ],
      ),
  },
  max: {
    name: "sexscriptLegacyMax",
    build: () =>
      fn(
        "sexscriptLegacyMax",
        ["first", "second"],
        [ifS(bin(">=", v("first"), v("second")), [ret(v("first"))]), ret(v("second"))],
      ),
  },
  min: {
    name: "sexscriptLegacyMin",
    build: () =>
      fn(
        "sexscriptLegacyMin",
        ["first", "second"],
        [ifS(bin("<=", v("first"), v("second")), [ret(v("first"))]), ret(v("second"))],
      ),
  },
  ...JAVA_HELPERS,
};
