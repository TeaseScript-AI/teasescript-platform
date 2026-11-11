// pins: a written default's walk units | line /units: \d/u
import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { defaultOf, writtenDefault } from "../../src/type-inference/core/contract.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { narrowingPassIn } from "../helpers/type-core/type-core-narrowing.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";
import { plannedContent, runGlobals } from "../helpers/type-core-route.js";

// #1072 step 0: a typed parse's or load's default with a written type is read by that type (ADR 0021 rule 2.6,
// `writtenDefault` in `core/contract/terms.ts`), source to runtime, and the forms the rule leaves to the snapshot.

const GLOBALS = ["hostValue"];

/**
 * #1072 step 0: a default with a written type is read by that type (ADR 0021 rule 2.6, "its default's type";
 * `writtenDefault`): a row per form the rule admits and per class of its acceptance rows, `@` the typed call, its reader
 * in the plan and what the call's value shows of each JSON text. The written `T?` rows read the written type where the
 * owner has not yet decided between it and the narrowed one (rules 5.1, 5.2; the pull request's open question).
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

/** The rule's answer for the one typed call of `text` (`@`, its default `fb`) at `rest`, and the units it charged. */
function ruleAt(
  text: string,
  rest: readonly string[],
  reversed: boolean,
): { readonly items: string[] | null; readonly units: number } {
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
  const before = pass.program.work.counts().get("invSteps") ?? 0;
  const items = writtenDefault(pass, fallback, rest);
  return {
    items: items === null ? null : items.map((item) => `${item.tag} ${item.cert}`),
    units: (pass.program.work.counts().get("invSteps") ?? 0) - before,
  };
}

test("a written parameter or global, which the candidate route declines, and a chain of copies give their written type, a unit per binding followed (#1072 step 0)", () => {
  const rows = [
    { text: "function f(fb: number) {\n  @\n}\nf(0)", units: 1 },
    { text: "global fb: number = 0\n@", units: 1 },
    { text: "let w: number = 0\nlet f1 = w\nlet fb = f1\n@", units: 3 },
  ];
  for (const { text, units } of rows)
    for (const reversed of [false, true])
      assert.deepEqual(ruleAt(text, [], reversed), { items: ["number def"], units }, text);
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
