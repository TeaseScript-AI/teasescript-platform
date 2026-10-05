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
  | "askBooleans"
  | "fixed"
  | "packagePath"
  | "pathTag"
  | "items"
  | "itemAt"
  | "truth"
  | "askText"
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
  if (needed.has("switchButton")) needed.add("switchButtonId");
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
  "backgroundSounds",
  "playBackgroundSound",
  "stopBackgroundSounds",
  "random",
  "loadFirstTrue",
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
  "abs",
  "askBooleans",
  "fixed",
  "packagePath",
  "pathTag",
  "items",
  "itemAt",
  "truth",
  "askText",
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
  // Workaround for askBooleans(), which main does not implement yet (workarounds.ts): one yes/no choice per item, the
  // preset marked in its button, and a confirmation that can start over.
  askBooleans: {
    name: "sexscriptLegacyAskBooleans",
    build: () =>
      fn(
        "sexscriptLegacyAskBooleans",
        ["message", "texts", "defaults"],
        [
          letS("answers", { kind: "list", items: [] }),
          letS("confirmed", lit(false)),
          {
            kind: "while",
            condition: { kind: "unary", operator: "not", value: v("confirmed") },
            body: [
              set(v("answers"), { kind: "list", items: [] }),
              { kind: "say", value: v("message"), span: null },
              letS("index", lit(0)),
              forS("text", v("texts"), [
                letS("yes", lit("Yes")),
                letS("no", lit("No (preset)")),
                ifS(
                  bin(
                    "and",
                    bin("<", v("index"), prop(v("defaults"), "length")),
                    bin("==", at(v("defaults"), v("index")), lit(true)),
                  ),
                  [set(v("yes"), lit("Yes (preset)")), set(v("no"), lit("No"))],
                ),
                { kind: "say", value: v("text"), span: null },
                add(
                  "answers",
                  bin(
                    "==",
                    { kind: "choice", options: [v("yes"), v("no")], labels: ["yes", "no"] },
                    lit("yes"),
                  ),
                ),
                set(v("index"), lit(1), "+="),
              ]),
              set(
                v("confirmed"),
                bin(
                  "==",
                  {
                    kind: "choice",
                    options: [lit("Confirm"), lit("Change answers")],
                    labels: ["confirm", "change"],
                  },
                  lit("confirm"),
                ),
              ),
            ],
            span: null,
          },
          ret(v("answers")),
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
          letS("sign", lit("")),
          ifS(bin("<", v("scaled"), lit(0)), [
            set(v("sign"), lit("-")),
            set(v("scaled"), { kind: "unary", operator: "-", value: v("scaled") }),
          ]),
          letS("whole", {
            kind: "call",
            name: "toInteger",
            positional: [bin("/", v("scaled"), v("factor"))],
            named: {},
          }),
          ifS(bin("==", v("digits"), lit(0)), [ret(template(v("sign"), v("whole")))]),
          letS("fraction", bin("-", v("scaled"), bin("*", v("whole"), v("factor")))),
          ret(
            template(v("sign"), v("whole"), ".", {
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
  // Legacy input with a prefill that may be blank or null, which a TeaseScript default rejects: no default then.
  askText: {
    name: "sexscriptLegacyAskText",
    build: () =>
      fn(
        "sexscriptLegacyAskText",
        ["prefill"],
        [
          ifS(
            bin(
              "or",
              bin("==", v("prefill"), lit(null)),
              bin(
                "==",
                { kind: "methodCall", target: template(v("prefill")), name: "trim", arguments: [] },
                lit(""),
              ),
            ),
            [ret({ kind: "input", input: "askText" })],
          ),
          ret({ kind: "input", input: "askText", defaultValue: template(v("prefill")) }),
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
  // A list element as Groovy read it: null past the end.
  itemAt: {
    name: "sexscriptLegacyItemAt",
    build: () =>
      fn(
        "sexscriptLegacyItemAt",
        ["list", "position"],
        [
          ifS(bin(">=", v("position"), prop(v("list"), "length")), [ret(lit(null))]),
          ret(at(v("list"), v("position"))),
        ],
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
  // The items a Groovy loop visited: the characters of text, the elements of anything else.
  items: {
    name: "sexscriptLegacyItems",
    build: () =>
      fn(
        "sexscriptLegacyItems",
        ["value"],
        [
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
  ...JAVA_HELPERS,
};
