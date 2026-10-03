import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";

/** Generated function that calls the function an action ID (a converted closure value) stands for. */
export const ACTION_DISPATCHER = "sexscriptLegacyCall";
/** Marks that a program calls actions, which requires the dispatcher even without known actions. */
export const ACTION_DISPATCHER_MARKER = "#dispatch";

/**
 * Adds the action dispatcher when the program calls closure values. Each known action calls its function with the
 * supplied arguments, up to the parameters the function declares, so omitted optional parameters keep their
 * defaults. Unlike Groovy, extra arguments are ignored and unknown actions return null.
 */
export function withActionDispatcher(program: MigrationProgram): MigrationProgram {
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
  const callWith = (action: string, count: number): IrStatement =>
    ret({
      kind: "call",
      name: action,
      positional: Array.from({ length: count }, (_, index) => at(v("args"), lit(index))),
      named: {},
      local: true,
    });
  const branches = actions
    .filter((action) => action !== ACTION_DISPATCHER_MARKER)
    .toSorted()
    .map((action) => {
      const { required, total } = signatures.get(action) ?? { required: 0, total: 0 };
      // The compared ID follows renames of its function like every other action ID.
      const id: IrExpression = { kind: "literal", value: action, action: true };
      const calls: IrStatement[] = [];
      for (let count = total; count > required; count -= 1) {
        calls.push(
          ifS(bin(">=", prop(v("args"), "length"), lit(count)), [callWith(action, count)]),
        );
      }
      calls.push(callWith(action, required));
      return ifS(bin("==", v("action"), id), calls);
    });
  const dispatcher = fn(ACTION_DISPATCHER, ["action", "args"], [...branches, ret(lit(null))]);
  const note: IrStatement = {
    kind: "comment",
    text: "// Calls the function an action ID names. Unlike Groovy, extra arguments are ignored and an unknown action returns null.",
    trailing: false,
    span: null,
  };
  return { ...program, statements: [note, dispatcher, ...program.statements] };
}

/**
 * Small ordinary TeaseScript functions the importer generates when a legacy operation has no single TeaseScript
 * expression. Each is emitted once per generated file that needs it.
 */
export type HelperName =
  | "abs"
  | "array"
  | "backgroundSounds"
  | "concat"
  | "indexOf"
  | "join"
  | "listMax"
  | "listMin"
  | "listSum"
  | "loadFirstTrue"
  | "max"
  | "menuOptions"
  | "min"
  | "playBackgroundSound"
  | "random"
  | "removeAt"
  | "shuffled"
  | "stopBackgroundSounds"
  | "unique";

export function helperCall(name: HelperName, args: IrExpression[]): IrExpression {
  return { kind: "call", name: HELPERS[name].name, positional: args, named: {} };
}

/**
 * Position of a generated helper definition in the stable helper order, or -1 for other statements. Every program
 * that needs a helper generates the same definition.
 */
export function helperDefinitionOrder(statement: IrStatement): number {
  if (statement.kind !== "function" && statement.kind !== "let") return -1;
  return HELPER_ORDER.findIndex((name) => HELPERS[name].name === statement.name);
}

/** Helper functions in a stable order, so generated files do not depend on discovery order. */
export function helperStatements(names: ReadonlySet<HelperName>): IrStatement[] {
  const needed = new Set(names);
  if (needed.has("playBackgroundSound")) needed.add("stopBackgroundSounds");
  if (needed.has("stopBackgroundSounds")) needed.add("backgroundSounds");
  return HELPER_ORDER.filter((name) => needed.has(name)).map((name) => HELPERS[name].build());
}

const HELPER_ORDER: readonly HelperName[] = [
  "backgroundSounds",
  "playBackgroundSound",
  "stopBackgroundSounds",
  "random",
  "loadFirstTrue",
  "indexOf",
  "concat",
  "array",
  "shuffled",
  "unique",
  "removeAt",
  "menuOptions",
  "listMax",
  "listMin",
  "listSum",
  "join",
  "max",
  "min",
  "abs",
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
const fn = (name: string, parameters: string[], body: IrStatement[]): IrStatement => ({
  kind: "function",
  name,
  parameters: parameters.map((parameter) => ({ name: parameter, defaultValue: null })),
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
        ["max"],
        [
          ifS(bin("==", v("max"), lit(null)), [ret(randomBelow(lit(100)))]),
          // A fractional bound was truncated toward zero, like (int) max.
          letS("bound", bin("-", v("max"), bin("%", v("max"), lit(1)))),
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
  concat: {
    name: "sexscriptLegacyConcat",
    build: () =>
      fn(
        "sexscriptLegacyConcat",
        ["lists"],
        [
          letS("combined", { kind: "list", items: [] }),
          forS("list", v("lists"), [forS("item", v("list"), [add("combined", v("item"))])]),
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
  removeAt: {
    // Groovy list.remove(index) with a number removes by position; TeaseScript remove(value) removes by value.
    name: "sexscriptLegacyRemoveAt",
    build: () =>
      fn(
        "sexscriptLegacyRemoveAt",
        ["items", "position"],
        [
          letS("remaining", { kind: "list", items: [] }),
          forS("index", range(prop(v("items"), "length")), [
            ifS(bin("!=", v("index"), v("position")), [
              add("remaining", at(v("items"), v("index"))),
            ]),
          ]),
          ret(v("remaining")),
        ],
      ),
  },
  menuOptions: {
    // Options of a proposed `choose` (choose-lists) labelled with consecutive numbers from `first`, as the
    // zero-based index that legacy getSelectedValue() returns.
    name: "sexscriptLegacyMenuOptions",
    build: () =>
      fn(
        "sexscriptLegacyMenuOptions",
        ["texts", "first"],
        [
          letS("options", { kind: "list", items: [] }),
          letS("label", v("first")),
          forS("text", v("texts"), [
            add("options", {
              kind: "object",
              properties: [
                { name: "label", value: v("label") },
                { name: "text", value: v("text") },
              ],
            }),
            set(v("label"), lit(1), "+="),
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
  join: {
    name: "sexscriptLegacyJoin",
    build: () =>
      fn(
        "sexscriptLegacyJoin",
        ["items", "separator"],
        [
          letS("text", lit("")),
          forS("index", range(prop(v("items"), "length")), [
            ifS(
              bin("==", v("index"), lit(0)),
              [set(v("text"), template(at(v("items"), v("index"))))],
              [set(v("text"), template(v("text"), v("separator"), at(v("items"), v("index"))))],
            ),
          ]),
          ret(v("text")),
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
  abs: {
    name: "sexscriptLegacyAbs",
    build: () =>
      fn(
        "sexscriptLegacyAbs",
        ["value"],
        [
          ifS(bin("<", v("value"), lit(0)), [
            ret({ kind: "unary", operator: "-", value: v("value") }),
          ]),
          ret(v("value")),
        ],
      ),
  },
};
