import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../../src/compiler.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { checkedResult } from "../../src/type-inference/core/check-result/check-result.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { coreRecord } from "../../src/type-inference/core/result.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";

// #2378 R34, R38: a dict's `values` and `keys` are a new list each time they are read (V30), so a statement that
// changes one in place answers as its copy twin does (`let t = d.values` before it, `t` in its place): the same
// diagnostics and checks, and the same answers afterwards for the dict and for its list.

/**
 * One mode's answer: the outcome, each diagnostic by code, class, line and message, each check by kind, types and line
 * (its target names the place in the core's words, the dict's path or the copy's name).
 */
interface Answer {
  readonly outcome: string;
  readonly diagnostics: readonly {
    readonly at: string;
    readonly line: number;
    readonly message: string;
  }[];
  readonly checks: readonly { readonly at: string; readonly line: number }[];
}

function answerIn(source: string, globals: readonly string[]): Answer {
  const request = coreRequest([{ path: "main.tease", source }], globals);
  assert.ok(request !== null, source);
  const result = checkedResult(analyseCore(request), request);
  const shown = messageSource([source], result.diagnostics);
  const line = (offset: number): number => source.slice(0, offset).split("\n").length;
  return {
    outcome: result.outcome,
    diagnostics: result.diagnostics.map((d) => ({
      at: `${d.code} ${d.class}`,
      line: line(d.site.start),
      message: coreMessage(d, shown),
    })),
    checks: coreRecord(result, ["main.tease"]).runtimeChecks.map((check) => ({
      at: `${check.kind} [${[...check.against].sort().join(",")}]${check.boundary === true ? " boundary" : ""}`,
      line: line(check.site.offset),
    })),
  };
}

/** The answer, the same in the four modes (both orders, sharing on and off). */
function answer(source: string, globals: readonly string[] = []): Answer {
  const [first, ...others] = MODES.map((mode) => inMode(mode, () => answerIn(source, globals)));
  for (const other of others) assert.deepEqual(other, first, source);
  return first!;
}

// (the generated table: every statement `src/list-methods.ts` marks as changing its receiver, an index store and a
// compound store, through `.values`, and three through `.keys`, on every dict construction, for each element type, a
// call's written result and a declared variable, each from a literal and from host data)
const TYPES: Readonly<
  Record<
    string,
    { readonly v: string; readonly x: readonly string[]; readonly c: readonly string[] }
  >
> = {
  integer: { v: "1", x: ["3", "2.5", '"s"'], c: ["1", "2.5"] },
  "integer | string": { v: "1", x: ['"s"', "2.5"], c: ["1", "2.5"] },
  "integer[]": { v: "[1]", x: ["[3]", "[2.5]"], c: ["[3]", "[2.5]"] },
};
const VALUES: readonly string[] = ["L.add(X)", "L.addAll([X])", "L.remove(X)", "L[0] = X"];
const PLAIN: readonly string[] = [
  "L.removeAt(0)",
  "L.removeFirst()",
  "L.removeLast()",
  "L.clear()",
  "L.sort()",
  "L.shuffle()",
  "L.reverse()",
];
const KEYS: readonly string[] = ['L.add("s")', "L.add(2)", 'L[0] = "s"', "L[0] = 2", "L.clear()"];

/** Each construction's lines before the statement and the dict it makes (five lines each, so lines match). */
function constructions(type: string, kind: string): readonly (readonly [string, string])[] {
  const { v } = TYPES[type]!;
  const dict = type.includes("|") ? `(${type}) dict` : `${type} dict`;
  const start = kind.endsWith("host") ? "hostValue" : v;
  const head = kind.startsWith("call")
    ? `let item: ${type} = ${start}\nfunction supply(_arg): ${type} {\n    return item\n}\n`
    : `let item: ${type} = ${start}\n\n\n\n`;
  const src = kind.startsWith("call") ? "supply(0)" : "item";
  return [
    ...(kind === "call"
      ? [[`function mk(_x): ${dict} {\n    return dict{a: ${v}}\n}\nlet d = mk(0)\n`, "d"] as const]
      : kind === "variable"
        ? [
            [`\n\n\nlet d: ${dict} = dict{a: ${v}}\n`, "d"] as const,
            [`\n\n\n\nlet d = dict{a: ${v}}\n`, "d"] as const,
          ]
        : []),
    [`${head}let d = dict{a: ${src}, b: ${v}}\n`, "d"],
    [`${head}let d = dict{}\nd["a"] = ${src}\n`, "d"],
    [`${head}let ds = [dict{a: ${src}, b: ${v}}]\n`, "ds[0]"],
    [`${head}let dd = dict{k: dict{a: ${src}, b: ${v}}}\n`, 'dd["k"]'],
    [`${head}let d0 = dict{a: ${src}, b: ${v}}\nlet d = d0\n`, "d"],
  ];
}

/** The answer with the copy twin's line dropped: its two lines are the in-place statement's one. */
function asInPlace(copy: Answer, twinLine: number): Answer {
  const at = (line: number): number => (line > twinLine ? line - 1 : line);
  return {
    outcome: copy.outcome,
    diagnostics: copy.diagnostics.map((d) => ({ ...d, line: at(d.line), message: "" })),
    checks: copy.checks.map((c) => ({ ...c, line: at(c.line) })),
  };
}

/** An answer's diagnostics and checks in one order. */
function sorted(a: Answer): Answer {
  const order = <T>(items: readonly T[]): T[] =>
    items.toSorted((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q)));
  return { ...a, diagnostics: order(a.diagnostics), checks: order(a.checks) };
}

test("a statement through a dict's `values` or `keys` answers as its copy twin, and the dict and its list read the same afterwards (#2378 R34)", () => {
  let twins = 0;
  for (const type of Object.keys(TYPES))
    for (const kind of ["call", "variable", "call host", "variable host"]) {
      if (kind.endsWith("host") && type.endsWith("[]")) continue;
      const { x, c } = TYPES[type]!;
      const statements = [
        ...VALUES.flatMap((s) => x.map((value) => ["values", s.replace("X", value)] as const)),
        ...PLAIN.map((s) => ["values", s] as const),
        ...c.map((value) => ["values", `L[0] += ${value}`] as const),
        ...KEYS.map((s) => ["keys", s] as const),
      ];
      for (const [pre, dict] of constructions(type, kind))
        for (const [list, statement] of statements) {
          const after = `let n: ${type} = ${dict}["a"]\nlet m: ${type} = ${dict}.values[0]\nexit\n`;
          const read = `${dict}.${list}`;
          const inPlace = `${pre}${statement.replace("L", read)}\n${after}`;
          const copy = `${pre}let t = ${read}\n${statement.replace("L", "t")}\n${after}`;
          const globals = kind.endsWith("host") ? ["hostValue"] : [];
          // (one mode here; the four modes agree on every case in the evidence's records, `i2378-r4-t12`)
          const [here, twin] = [inPlace, copy].map((source) =>
            inMode(MODES[0]!, () => answerIn(source, globals)),
          );
          const strip = (a: Answer): Answer => ({
            ...a,
            diagnostics: a.diagnostics.map((d) => ({ ...d, message: "" })),
          });
          assert.deepEqual(
            sorted(strip(here!)),
            sorted(asInPlace(twin!, pre.split("\n").length)),
            inPlace,
          );
          twins += 1;
        }
    }
  assert.equal(twins, 1390);
});

test('in place and copied, `d.values.add("s")` on `dict{a: 1}` is TSV041, and `d["a"]` still reads a whole number (#2378 R37)', () => {
  for (const [form, lines] of [
    ["in place", 'let d = dict{a: 1}\nd.values.add("s")\nlet n: integer = d["a"]\nexit\n'],
    ["copied", 'let d = dict{a: 1}\nlet t = d.values\nt.add("s")\nlet n: integer = d["a"]\nexit\n'],
  ] as const) {
    const { outcome, diagnostics, checks } = answer(lines);
    assert.equal(outcome, "compile-error", form);
    assert.deepEqual(
      diagnostics.map((d) => `${d.at} ${d.line}`),
      [`TSV041 compile-error ${form === "in place" ? 2 : 3}`],
      form,
    );
    assert.deepEqual(checks, [], form);
  }
});

// (R39: each fix clause an in-place sentence gives, its twin's, a sentence or its clause, and its code applied where
// the sentence stands)
const CLAUSES: readonly (readonly [string, string, string, string])[] = [
  [
    "the copy made first",
    'let d = dict{a: 1}\nd.values.add("s")\nexit\n',
    "'d.values' holds whole numbers (integer[]) since line 2, so it cannot contain text (string). 'd.values' is a new list each time: to allow both, copy it first, as 'let values: (integer | string)[] = d.values'.",
    'let d = dict{a: 1}\nlet values: (integer | string)[] = d.values\nvalues.add("s")\nexit\n',
  ],
  [
    "the copy made first, of a list's dict",
    'let ds = [dict{a: 1}]\nds[0].values[0] = "s"\nexit\n',
    "'ds[0].values' holds whole numbers (integer[]) since line 2, so it cannot contain text (string). 'ds[0].values' is a new list each time: to allow both, copy it first, as 'let values: (integer | string)[] = ds[0].values'.",
    'let ds = [dict{a: 1}]\nlet values: (integer | string)[] = ds[0].values\nvalues[0] = "s"\nexit\n',
  ],
  [
    "rounding",
    "let d: integer dict = dict{a: 1}\nd.values.add(2.5)\nexit\n",
    "'d.values' holds whole numbers (integer[]) since line 2, so it cannot contain a number. Round the number with the floor, round or ceil function first.",
    "let d: integer dict = dict{a: 1}\nd.values.add(round(2.5))\nexit\n",
  ],
  [
    "the length checked first",
    "function src(_x): integer {\n    return 1\n}\nlet d = dict{a: src(0), b: 1}\nd.values.removeFirst()\nexit\n",
    "Check 'd.values.length' first, as in 'if d.values.length > 0 { d.values.removeFirst() }'.",
    "function src(_x): integer {\n    return 1\n}\nlet d = dict{a: src(0), b: 1}\nif d.values.length > 0 { d.values.removeFirst() }\nexit\n",
  ],
  [
    "the element checked first",
    "function mk(_x): (integer | string) dict {\n    return dict{a: 1}\n}\nlet d = mk(0)\nd.values[0] += 1\nexit\n",
    "Check that 'd.values[0]' is a whole number (integer) first.",
    "function mk(_x): (integer | string) dict {\n    return dict{a: 1}\n}\nlet d = mk(0)\nif d.values[0] is integer {\n    d.values[0] += 1\n}\nexit\n",
  ],
];

test("an in-place statement's sentence takes its twin's fix clause, the copy made first where the twin declares it, and the code it names compiles where it stands (#2378 R39)", () => {
  for (const [name, source, sentence, applied] of CLAUSES) {
    const messages = answer(source).diagnostics.map((d) => d.message);
    assert.ok(
      messages.some((message) => message.includes(sentence)),
      `${name}: ${messages.join(" / ")}`,
    );
    assert.ok(!messages.some((message) => message.includes("a first value")), name);
    assert.notEqual(answer(applied).outcome, "compile-error", `${name}: applied`);
  }
  // (the copy made first compiles in today's compiler too, where every in-place change is TSV067)
  for (const [name, , , applied] of CLAUSES.slice(0, 2))
    assert.deepEqual(
      compileProject([{ path: "main.tease", source: applied }]).diagnostics.filter(
        (d) => d.severity === "error",
      ),
      [],
      name,
    );
});

test("an in-place statement through `.keys` keeps its twin's clause: the list in a new variable, each element checked (#2378 R39)", () => {
  const source =
    "function mk(_x): integer dict {\n    return dict{a: 1}\n}\nlet d = mk(0)\nd.keys.add(2)\nexit\n";
  const { diagnostics } = answer(source);
  assert.deepEqual(
    diagnostics.map((d) => d.message),
    [
      "'d.keys' holds whole numbers (integer[]) because of line 5, but 'd.keys' may be text (string) here. If it is, the Tease stops with an error at this line. Keep 'd.keys' in a new variable and check that every element of it is a whole number (integer) first.",
    ],
  );
  const applied =
    'function mk(_x): integer dict {\n    return dict{a: 1}\n}\nlet d = mk(0)\nlet kept = d.keys\nfor key in kept {\n    if key is integer {\n        say "whole"\n    }\n}\nexit\n';
  assert.notEqual(answer(applied).outcome, "compile-error");
});
