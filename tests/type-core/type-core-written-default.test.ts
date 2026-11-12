// pins: a written default's index and walk units | line /built: \d/u
import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import {
  defaultOf,
  writtenDefault,
  WrittenDefaults,
} from "../../src/type-inference/core/contract.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { narrowingPassIn } from "../helpers/type-core/type-core-narrowing.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";
import { plannedContent, runGlobals } from "../helpers/type-core-route.js";

// #1072 step 0: a typed parse's or load's default with a written type is read by that type (ADR 0021 rule 2.6,
// `writtenDefault` in `core/contract/written-default.ts`), source to runtime, and the forms the rule leaves to the
// snapshot.

const GLOBALS = ["hostValue"];

/**
 * #1072 step 0: a default with a written type is read by that type (ADR 0021 rule 2.6, "its default's type";
 * `writtenDefault`): a row per form the rule admits and per class of its acceptance rows, `@` the typed call, its reader
 * in the plan and what the call's value shows of each JSON text. A variable with a written type gives that type,
 * whatever value it holds at the call, also where a type test or an assignment narrows its read there (rules 5.1, 5.2):
 * the nullable rows below and the type test's.
 */
const WRITTEN_DEFAULTS: readonly {
  readonly name: string;
  readonly source: string;
  readonly fallback: string;
  readonly reader: string;
  readonly runs: readonly (readonly [string, string])[];
}[] = [
  {
    name: "a written binding (#2307's wbind)",
    source: "let fb: number = 0\nlet v = @\nsay v",
    fallback: "fb",
    reader: "number",
    runs: [
      ["2.5", "2.5"],
      ["2", "2"],
      ['"x"', "0"],
    ],
  },
  {
    name: "a copy of a written binding (#2307's wcopy)",
    source: "let fb: number = 0\nlet fc = fb\nlet v = @\nsay v",
    fallback: "fc",
    reader: "number",
    runs: [
      ["2.5", "2.5"],
      ['"x"', "0"],
    ],
  },
  {
    name: "a list literal's element (#2307's nested)",
    source: "let a = [0.5]\nlet w: number = 0\nlet v = a\nv = @\nsay v[0]",
    fallback: "[w]",
    reader: "list<number>",
    runs: [
      ["[2.5]", "2.5"],
      ['["x"]', "0"],
    ],
  },
  {
    name: "an object literal's property",
    source: "let a = {n: 0.5}\nlet w: number = 0\nlet v = a\nv = @\nsay v.n",
    fallback: "{n: w}",
    reader: "{n: number}",
    runs: [
      ['{"n": 2.5}', "2.5"],
      ['{"n": "x"}', "0"],
    ],
  },
  {
    name: "integer? holding null (R11's let-through)",
    source: "let fb: integer? = null\nlet v = @\nsay v",
    fallback: "fb",
    reader: "integer|null",
    runs: [
      ['"x"', "null"],
      ["1.5", "null"],
      ["true", "null"],
      ["[1]", "null"],
      ["2", "2"],
    ],
  },
  {
    name: "number? holding null, through a copy",
    source: "let w: number? = null\nlet fb = w\nlet v = @\nsay v",
    fallback: "fb",
    reader: "null|number",
    runs: [
      ['"x"', "null"],
      ["1.5", "1.5"],
    ],
  },
  {
    // (its kinds certain: as possible ones the plan's later copy `v = a` left the slice, #1072 step 0's R7)
    name: "number? holding a whole number, a written copy stored later (#2307's nullable callfirst)",
    source: "let a: number? = 0\nlet fb: number? = 0\nlet v = @\nsay v\nv = a",
    fallback: "fb",
    reader: "null|number",
    runs: [
      ["1.5", "1.5"],
      ["null", "null"],
      ["2", "2"],
    ],
  },
  {
    name: "string? holding null",
    source: "let fb: string? = null\nlet v = @\nsay v",
    fallback: "fb",
    reader: "null|string",
    runs: [
      ["1", "null"],
      ['"x"', "x"],
    ],
  },
  {
    name: "integer? holding a whole number: JSON null arrives",
    source: "let fb: integer? = 5\nlet v = @\nsay v",
    fallback: "fb",
    reader: "integer|null",
    runs: [
      ["null", "null"],
      ["2", "2"],
      ["1.5", "5"],
    ],
  },
  {
    name: "number? read inside a type test that narrows it to integer",
    source: "let fb: number? = 0\nif fb is integer {\n  let v = @\n  say v\n}",
    fallback: "fb",
    reader: "null|number",
    runs: [
      ["1.5", "1.5"],
      ["null", "null"],
      ['"x"', "0"],
    ],
  },
  {
    name: "an unwritten default a later copy decides (#2307's unchanged)",
    source: "let a: number = 0\nlet d = 0\nlet v = @\nsay v\nd = a",
    fallback: "d",
    reader: "integer",
    runs: [
      ["2.5", "0"],
      ["2", "2"],
    ],
  },
];

test("a default with a written type is read by that type, in the plan and at runtime, in four modes (#1072 step 0)", () => {
  let compared = 0;
  for (const mode of MODES)
    for (const row of WRITTEN_DEFAULTS) {
      const source = `${row.source.replace("@", `fromJson(hostValue, default: ${row.fallback}, files: false)`)}\nexit\n`;
      const where = `${row.name} (mode ${JSON.stringify(mode)})`;
      const compiled = inMode(mode, () =>
        compileProjectWithBackend(
          [{ path: "main.tease", source }],
          { globals: GLOBALS },
          CORE_BACKEND,
        ),
      );
      assert.ok(compiled.plan !== null, `${where}: ${compiled.diagnostics.map((d) => d.code)}`);
      const readers = plannedContent(compiled.plan, source)
        .filter((entry) => entry.startsWith("expected "))
        .map((entry) => entry.split(" ").slice(2).join(" "));
      assert.deepEqual(readers, [row.reader], where);
      for (const [json, shown] of row.runs) {
        const ran = runGlobals(compiled.plan, { hostValue: json });
        assert.equal(ran.status, "halted", `${where}: ${json}: ${ran.failure}`);
        assert.deepEqual(
          ran.said.map((entry) => entry.text),
          [shown],
          `${where}: ${json}`,
        );
      }
      compared += 1;
    }
  assert.equal(compared, MODES.length * WRITTEN_DEFAULTS.length);
});

test("a default's written type is certain: a number default is no repeat count (#1072 step 0, ADR 0021 1.2)", () => {
  const source =
    "let fb: number = 0\nlet v = fromJson(hostValue, default: fb, files: false)\nrepeat v {}\nexit\n";
  for (const mode of MODES) {
    const compiled = inMode(mode, () =>
      compileProjectWithBackend(
        [{ path: "main.tease", source }],
        { globals: GLOBALS },
        CORE_BACKEND,
      ),
    );
    assert.deepEqual(
      compiled.diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code}`),
      ["error TSV011"],
      JSON.stringify(mode),
    );
  }
});

test("a load's default with a written type is read by that type, in the plan and at runtime (#1072 step 0)", () => {
  const source = 'let fb: integer? = 5\nlet v = load("k", default: fb)\nsay v\nexit\n';
  for (const mode of MODES) {
    const where = JSON.stringify(mode);
    const compiled = inMode(mode, () =>
      compileProjectWithBackend(
        [{ path: "main.tease", source }],
        { globals: GLOBALS },
        CORE_BACKEND,
      ),
    );
    assert.ok(compiled.plan !== null, `${where}: ${compiled.diagnostics.map((d) => d.code)}`);
    assert.deepEqual(
      plannedContent(compiled.plan, source)
        .filter((entry) => entry.startsWith("load "))
        .map((entry) => entry.split(" ")[2]),
      ["integer|null"],
      where,
    );
    // (no stored value is null: an absent key has none, and gives the default)
    for (const [stored, shown] of [
      [undefined, "5"],
      [2, "2"],
      [1.5, "5"],
      ["x", "5"],
    ] as const) {
      const ran = runGlobals(
        compiled.plan,
        { hostValue: "" },
        stored === undefined ? [] : [{ key: "k", value: stored }],
      );
      assert.equal(ran.status, "halted", `${where}: ${String(stored)}: ${ran.failure}`);
      assert.deepEqual(
        ran.said.map((entry) => entry.text),
        [shown],
        `${where}: ${String(stored)}`,
      );
    }
  }
});

/**
 * The rule's answer for the one typed call of `text` (`@`, its default `fb`) at `rest`, the units its index charges
 * where it is built and the units its walk charges.
 */
function ruleAt(
  text: string,
  rest: readonly string[],
  reversed: boolean,
): { readonly items: string[] | null; readonly built: number; readonly walked: number } {
  const source = `${text.replace("@", "let v = fromJson(hostValue, default: fb, files: false)")}\nexit\n`;
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, text);
  const pass = narrowingPassIn(request, reversed);
  const fallbacks = pass.program.constraints.flatMap((c) => {
    const fallback = c.kind === "operation" ? defaultOf(c) : undefined;
    return fallback === undefined ? [] : [fallback];
  });
  const [fallback] = fallbacks;
  assert.ok(fallbacks.length === 1 && fallback !== undefined, text);
  const count = (counter: "indexSteps" | "invSteps") =>
    pass.program.work.counts().get(counter) ?? 0;
  const indexed = count("indexSteps");
  void new WrittenDefaults(pass.program, pass.definitions);
  const built = count("indexSteps") - indexed;
  const before = count("invSteps");
  const items = writtenDefault(pass, fallback, rest);
  return {
    items: items === null ? null : items.map((item) => `${item.tag} ${item.cert}`),
    built,
    walked: count("invSteps") - before,
  };
}

test("a written parameter or global, which the candidate route declines, a chain of copies and a literal's cells give their written type; the index pays per binding and cell, the walk per literal and type (#1072 step 0)", () => {
  const rows = [
    { text: "function f(fb: number) {\n  @\n}\nf(0)", built: 2, walked: 1 },
    { text: "global fb: number = 0\n@", built: 2, walked: 1 },
    { text: "let w: number = 0\nlet f1 = w\nlet fb = f1\n@", built: 4, walked: 1 },
    // (the index: the binding, the literal's step, each cell and the binding each reads, and each written type taken
    // apart once; the walk: the literal and the one written type its cells hold, however many cells hold it)
    { text: "let w: number = 0\nlet fb = [w, w]\n@", rest: ["element"], built: 7, walked: 2 },
    {
      text: "let w: number = 0\nlet fb = [w, w, w, w]\n@",
      rest: ["element"],
      built: 11,
      walked: 2,
    },
    // (a literal in a literal: each entered once by the index; the walk enters each and follows the one reference)
    {
      text: "let w: number = 0\nlet a = [w]\nlet fb = [a, a]\n@",
      rest: ["element", "element"],
      built: 10,
      walked: 4,
    },
    // (a written type read three steps down: the walk pays each step)
    {
      text: "let fb: number[][][] = [[[0]]]\n@",
      rest: ["element", "element", "element"],
      built: 5,
      walked: 4,
    },
  ];
  for (const { text, rest = [], built, walked } of rows)
    for (const reversed of [false, true])
      assert.deepEqual(
        ruleAt(text, rest, reversed),
        { items: ["number def"], built, walked },
        text,
      );
});

test("literals that share the literals below them: the walk pays each reference it follows, as many as it makes (#2403's final review)", () => {
  // (n literals `a` of one written cell, n literals `b` each listing every `a`, and `fb` listing every `b`: read three
  // steps down, the walk enters `fb`, n `b`s and n `a`s, follows n references from `fb` and n² from the `b`s, and
  // meets `w` in each `a`; d1c7c787 charged only the literals entered and the types met, 3n + 1)
  for (const n of [2, 4, 8]) {
    const names = (prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    const text = [
      "let w: number = 0",
      ...names("a").map((a) => `let ${a} = [w]`),
      ...names("b").map((b) => `let ${b} = [${names("a").join(", ")}]`),
      `let fb = [${names("b").join(", ")}]`,
      "@",
    ].join("\n");
    for (const reversed of [false, true]) {
      const { items, walked } = ruleAt(text, ["element", "element", "element"], reversed);
      assert.deepEqual({ items, walked }, { items: ["number def"], walked: n * n + 4 * n + 1 }, `n = ${n}`);
    }
  }
});

test("a default's written type is none outside the forms the rule admits, the default then read as it holds at the call (#1072 step 0)", () => {
  const sources: readonly (string | readonly [string, readonly (readonly string[])[]])[] = [
    // #2307's open residual: a default that starts as `null` and takes its type from a later copy
    "let w: integer? = null\nlet fb = null\nfb = w\n@",
    // cells that disagree, by syntax or by their written types; a written type silent at the level
    "let w: number = 0\nlet fb = [w, 1]\n@",
    "let w: number = 0\nlet u: integer = 1\nlet fb = [w, u]\n@",
    ["let fb: list = [1]\n@", [["element"]]],
    // a loop variable, a part of a written list, a computed default, an unwritten parameter
    "let xs: number[] = [0]\nfor fb in xs {\n  @\n}",
    "let xs: number[] = [0]\nlet fb = xs[0]\n@",
    "let w: number? = 0\nlet fb = w otherwise 1\n@",
    "function f(fb) {\n  @\n}\nf(0)",
  ];
  for (const source of sources) {
    // (a written `list` gives its kind at the root and nothing below it)
    const [text, rests] = typeof source === "string" ? [source, [[], ["element"]]] : source;
    for (const reversed of [false, true])
      for (const rest of rests)
        assert.equal(ruleAt(text, rest, reversed).items, null, `${text} at ${rest.join(".")}`);
  }
});
