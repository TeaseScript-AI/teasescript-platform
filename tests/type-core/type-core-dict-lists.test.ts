import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../src/type-inference/core/answers.js";
import { checkedResult } from "../../src/type-inference/core/check-result/check-result.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { coreRecord } from "../../src/type-inference/core/result.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";
import { SWEEP } from "../helpers/sweep.js";

// #2378 R43, R49, R50: a dict's `values` and `keys` are a new list of copies each time they are read (V30, ADR 0014),
// so a store into or below such a list goes into nothing. A statement that stores there answers as its deletion twin:
// the same program with the statement replaced, on its own line, by `let z1 = <its operands>` (`z2` for a second
// statement). What the operation itself requires of what it reads (an emptiness check, a kind it can order, a compound
// store's read) stays, judged on the list the dict gives.

/**
 * One mode's answer: the outcome, each diagnostic by code, class, line and message, each check by kind, types and line.
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
      at: `${check.kind} ${check.target} [${[...check.against].sort().join(",")}]${check.boundary === true ? " boundary" : ""}`,
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

// (the generated table: each statement that changes a list a dict's `values` or `keys` gives in place, on every dict
// construction, for each element type, a call's written result, a declared variable and host data, alone, twice, before
// a statement that reads the list, in a loop body and in a function on the dict or on a dict parameter; the dict, its
// list and a copy of the list read afterwards. `TEASESCRIPT_SWEEP=full` runs it whole; any other run a sample that
// keeps every statement kind, construction, context, pairing, reader and source, and each statement kind at each
// element type, at least once: `docs/TESTING.md`, "Sampled sweeps")
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

/**
 * A statement that changes the list in place: its kind, the list, the statement with `L` for the list, its twin's
 * operands, and whether it stores nothing (a removal, an order change), so what it requires of the list it reads stands
 * at its own line (R50).
 */
interface Change {
  readonly name: string;
  readonly list: "values" | "keys";
  readonly statement: string;
  readonly operands: string;
  readonly free?: true;
}

function changes(type: string): readonly Change[] {
  const { x, c } = TYPES[type]!;
  const free = (name: string, list: Change["list"], statement: string): Change => ({
    name,
    list,
    statement,
    operands: "0",
    free: true,
  });
  return [
    ...x.flatMap((value): Change[] => [
      { name: "add", list: "values", statement: `L.add(${value})`, operands: value },
      { name: "addAll", list: "values", statement: `L.addAll([${value}])`, operands: `[${value}]` },
      { name: "remove", list: "values", statement: `L.remove(${value})`, operands: value },
      { name: "index store", list: "values", statement: `L[0] = ${value}`, operands: value },
    ]),
    ...c.map((value): Change => ({
      name: "compound store",
      list: "values",
      statement: `L[0] += ${value}`,
      operands: `L[0] + ${value}`,
    })),
    ...['"s"', "2"].flatMap((value): Change[] => [
      { name: "keys add", list: "keys", statement: `L.add(${value})`, operands: value },
      { name: "keys index store", list: "keys", statement: `L[0] = ${value}`, operands: value },
    ]),
    ...[
      "removeAt(0)",
      "removeFirst()",
      "removeLast()",
      "clear()",
      "sort()",
      "shuffle()",
      "reverse()",
    ].map((call) => free(call.slice(0, call.indexOf("(")), "values", `L.${call}`)),
    free("keys clear", "keys", "L.clear()"),
  ];
}

/** Each construction's name, its lines before the statements and the dict it makes (five lines each, so lines match). */
function constructions(type: string, kind: string): readonly (readonly [string, string, string])[] {
  const { v } = TYPES[type]!;
  const dict = type.includes("|") ? `(${type}) dict` : `${type} dict`;
  const start = kind.endsWith("host") ? "hostValue" : v;
  const head = kind.startsWith("call")
    ? `let item: ${type} = ${start}\nfunction supply(_arg): ${type} {\n    return item\n}\n`
    : `let item: ${type} = ${start}\n\n\n\n`;
  const src = kind.startsWith("call") ? "supply(0)" : "item";
  return [
    ...(kind === "call"
      ? [
          [
            "written",
            `function mk(_x): ${dict} {\n    return dict{a: ${v}}\n}\nlet d = mk(0)\n`,
            "d",
          ] as const,
        ]
      : kind === "variable"
        ? [
            ["written", `\n\n\nlet d: ${dict} = dict{a: ${v}}\n`, "d"] as const,
            ["plain literal", `\n\n\n\nlet d = dict{a: ${v}}\n`, "d"] as const,
          ]
        : []),
    ["literal of the source", `${head}let d = dict{a: ${src}, b: ${v}}\n`, "d"],
    ["filled by an index store", `${head}let d = dict{}\nd["a"] = ${src}\n`, "d"],
    ["a list's element", `${head}let ds = [dict{a: ${src}, b: ${v}}]\n`, "ds[0]"],
    ["nested", `${head}let dd = dict{k: dict{a: ${src}, b: ${v}}}\n`, 'dd["k"]'],
    ["a copy of the dict", `${head}let d0 = dict{a: ${src}, b: ${v}}\nlet d = d0\n`, "d"],
  ];
}

/**
 * The statements in a context: at the top, in a loop body, in a function on the dict, in a function on a dict
 * parameter (`p`, given the dict).
 */
function placed(context: string, dict: string, lines: readonly string[]): string {
  const body = lines.map((line) => `    ${line}\n`).join("");
  switch (context) {
    case "loop":
      return `for i in [1, 2] {\n${body}}\n`;
    case "function":
      return `function change {\n${body}}\nchange()\n`;
    case "parameter":
      return `function change(p) {\n${body}}\nchange(${dict})\n`;
    default:
      return lines.map((line) => `${line}\n`).join("");
  }
}

/**
 * The comparison of a program with its deletion twin: at the statement's own line a diagnostic's sentence quotes the
 * statement (`+=` against the twin's `+`, and a compound store's fix clause, R51), so there its code, class and line
 * are compared, and a statement that stores nothing keeps what it requires there (R50); a twin's diagnostic about its
 * own binding `z1` or `z2` (a copy where its operands are, the twin's form) is not the program's.
 */
function comparable(
  program: Answer,
  twin: Answer,
  line: number,
  free: boolean,
): readonly [Answer, Answer] {
  const own = twin.diagnostics.filter((d) => /'z\d'/.test(d.message));
  const required = (a: Answer): boolean =>
    free && [...a.diagnostics, ...a.checks].some((item) => item.line === line);
  const order = <T>(items: readonly T[]): T[] =>
    items.toSorted((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q)));
  // (the outcome is compared where neither the twin's own binding nor the statement's requirement may decide it)
  const blind = own.length > 0 || required(program) || required(twin);
  const view = (a: Answer): Answer => ({
    outcome: blind ? "" : a.outcome,
    diagnostics: order(
      a.diagnostics
        .filter((d) => !own.includes(d) && !(free && d.line === line))
        .map((d) => (d.line === line ? { ...d, message: "" } : d)),
    ),
    checks: order(a.checks.filter((c) => !(free && c.line === line))),
  });
  return [view(program), view(twin)];
}

/** One pair of the table: the program, its deletion twin, the twin's line, and what the pair covers. */
interface Pair {
  readonly program: string;
  readonly twin: string;
  readonly line: number;
  readonly free: boolean;
  readonly globals: readonly string[];
  readonly covers: readonly string[];
}

function table(): readonly Pair[] {
  const pairs: Pair[] = [];
  for (const type of Object.keys(TYPES))
    for (const kind of ["call", "variable", "call host", "variable host"]) {
      if (kind.endsWith("host") && type.endsWith("[]")) continue;
      const globals = kind.endsWith("host") ? ["hostValue"] : [];
      const [first] = TYPES[type]!.c;
      // (a statement after the change that reads the list the dict gives: its requirement judged on that list, R50)
      const readers = [
        ["removeFirst", "L.removeFirst()"],
        ["sort", "L.sort()"],
        ["a compound store", `L[0] += ${first}`],
        ["a typed read", "let w: integer = L[0]"],
      ] as const;
      for (const [construction, pre, dict] of constructions(type, kind))
        for (const change of changes(type)) {
          const shapes: (readonly [string, readonly Change[], number, string])[] = [
            ["top", [change], 0, "alone"],
          ];
          if (kind === "variable") {
            if (change.free === undefined) {
              for (const context of ["loop", "function", "parameter"])
                shapes.push([context, [change], 0, "alone"]);
              shapes.push(["top", [change, change], 1, "twice"]);
            }
            for (const [reader, statement] of readers)
              shapes.push([
                "top",
                [change, { name: reader, list: "values", statement, operands: "0" }],
                0,
                `before ${reader}`,
              ]);
          }
          for (const [context, statements, at, shape] of shapes) {
            const receiver = context === "parameter" ? "p" : dict;
            const lines = (deleted: number): string[] =>
              statements.map((s, index) =>
                (index === deleted ? `let z${index + 1} = ${s.operands}` : s.statement).replace(
                  /\bL\b/g,
                  `${receiver}.${s.list}`,
                ),
              );
            const after = `let n: ${type} = ${dict}["a"]\nlet m: ${type} = ${dict}.values[0]\nlet c = ${dict}.values\nlet k: ${type} = c[0]\nexit\n`;
            const twin = `${pre}${placed(context, dict, lines(at))}${after}`;
            pairs.push({
              program: `${pre}${placed(context, dict, lines(-1))}${after}`,
              twin,
              line: twin.split("\n").findIndex((l) => l.trim().startsWith(`let z${at + 1} = `)) + 1,
              free: change.free === true,
              globals,
              covers: [
                `statement ${change.name}`,
                `construction ${construction}`,
                `context ${context}`,
                `shape ${shape}`,
                `source ${kind}`,
                `type ${type} ${change.name}`,
              ],
            });
          }
        }
    }
  return pairs;
}

/** The pairs a run takes: all under `SWEEP`, else in table order each that covers something no earlier one has. */
function sample(pairs: readonly Pair[]): readonly Pair[] {
  if (SWEEP) return pairs;
  const covered = new Set<string>();
  return pairs.filter((pair) => {
    const fresh = pair.covers.filter((item) => !covered.has(item));
    for (const item of fresh) covered.add(item);
    return fresh.length > 0;
  });
}

test("a statement that changes a list a dict's `values` or `keys` gives in place answers as its deletion twin, alone, twice, before a statement that reads the list, and in a loop or a function (#2378)", () => {
  const pairs = table();
  assert.equal(pairs.length, 4638);
  const taken = sample(pairs);
  assert.equal(taken.length, SWEEP ? 4638 : 62);
  for (const { program, twin, line, free, globals } of taken) {
    // (one mode here; the four modes agree on every case in the evidence's records, `i2378-r5-final`)
    const [here, there] = [program, twin].map((source) =>
      inMode(MODES[0]!, () => answerIn(source, globals)),
    );
    const [mine, its] = comparable(here!, there!, line, free);
    assert.deepEqual(mine, its, program);
  }
});

test('`d.values.add("s")` on `dict{a: 1}` is valid and `d["a"]` still reads a whole number; its copied form is TSV041 (#2378)', () => {
  const inPlace = answer('let d = dict{a: 1}\nd.values.add("s")\nlet n: integer = d["a"]\nexit\n');
  assert.deepEqual(inPlace, { outcome: "valid", diagnostics: [], checks: [] });
  const copied = answer(
    'let d = dict{a: 1}\nlet t = d.values\nt.add("s")\nlet n: integer = d["a"]\nexit\n',
  );
  assert.deepEqual(
    copied.diagnostics.map((d) => `${d.at} ${d.line}`),
    ["TSV041 compile-error 3"],
  );
});

test("a store below a dict's list goes into nothing too: an element of `d.values` is a copy nobody holds (#2378)", () => {
  for (const source of [
    'let item: integer[] = [1]\nlet d = dict{a: item}\nd.values[0].add(2.5)\nlet n: integer[] = d["a"]\nexit\n',
    'let item: integer[] = [1]\nlet d = dict{a: item}\nd.values[0][0] = "s"\nexit\n',
    // (main decided the element `number` from the store and checked the literal against it)
    "let seed: integer | string = 1\nfunction src(_x): integer | string { return seed }\nlet d = [dict{a: [src(0)]}]\nd[0].values[0].add(2.5)\nexit\n",
  ])
    assert.deepEqual(answer(source), { outcome: "valid", diagnostics: [], checks: [] }, source);
});

test("an object's own property named `values` or `keys` keeps its store, as any property does (#2378, #2551)", () => {
  for (const [property, statement] of [
    ["values", "o.values.add(2.5)"],
    ["keys", "o.keys[0] = 2.5"],
    ["list", "o.list.add(2.5)"],
  ] as const) {
    const { outcome, diagnostics } = answer(
      `let item: integer = 1\nlet o = {${property}: [item]}\n${statement}\nexit\n`,
    );
    assert.equal(outcome, "compile-error", property);
    assert.deepEqual(
      diagnostics.map((d) => `${d.at} ${d.line}`),
      ["TSV041 compile-error 3"],
      property,
    );
  }
});
