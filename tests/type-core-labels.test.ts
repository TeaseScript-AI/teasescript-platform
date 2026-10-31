import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type CorePass } from "../src/type-inference/core/answers.js";
import {
  BudgetExhausted,
  withTestAllowance,
  type WorkCounter,
} from "../src/type-inference/core/budget.js";
import {
  labelBelow,
  labelPlainText,
  labelRoot,
  labelText,
  withLabelRecords,
  type Label,
  type LabelRecord,
} from "../src/type-inference/core/contract/labels.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { narrowingPass } from "./helpers/type-core-narrowing.js";
import { inMode, MODES } from "./helpers/type-core-oracles.js";

/*
 * G3 stage 1, PR 2 (TABLE r4.196): a path's label is a recipe one step from its parent's (`contract/labels.ts`), its
 * text made once, where a diagnostic or a check shows it, charged as a key cursor's conversion. A decision's label
 * (`Admission.labelOf`) makes no text; the consumers show it where a store's warning or check publishes it.
 */

const GLOBALS = ["hostValue", "hostOther", "hostInit"];

function request(source: string) {
  const made = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(made !== null, source);
  return made;
}

function bindingOf(pass: CorePass, label: string): PlaceId {
  const found = pass.program.places.find(
    (place) => place.kind.kind === "binding" && place.label === label,
  );
  assert.ok(found !== undefined, label);
  return found.id;
}

type Units = Partial<Record<WorkCounter, number>>;

/** The units `run` charges by counter: those counted against the allowance and those apart from it. */
function charged(pass: CorePass, run: () => void): { counted: Units; apart: Units } {
  const { work } = pass.program;
  const before = [work.counts(), work.apartCounts()];
  run();
  const [counted, apart]: Units[] = [{}, {}];
  for (const [index, now] of [work.counts(), work.apartCounts()].entries())
    for (const [counter, units] of now) {
      const spent = units - (before[index]!.get(counter) ?? 0);
      if (spent !== 0) [counted, apart][index]![counter] = spent;
    }
  return { counted: counted!, apart: apart! };
}

/** `keepText`'s units for a text of `length` code units (`SHORT` free, then a unit per eight). */
const kept = (length: number): number => (length > 32 ? (length - 32 + 7) >> 3 : 0);

test("a label is a recipe made once one step from its parent's; its text is made once where it is shown, from the nearest made text above it, charged as a conversion; a plain text charges and keeps nothing", () => {
  const pass = narrowingPass(request("let x = 1\nexit\n"));
  const { contract } = pass;
  const root = labelRoot(contract, bindingOf(pass, "x"));
  assert.equal(labelRoot(contract, bindingOf(pass, "x")), root);
  // (steps of each class a label spells: an element step as `element` or `entry`, a quoted internal name, a member a
  // built-in value answers, one either side of `SHORT`)
  const steps = ["q", "element", "entry", "'element", "values", `p${"a".repeat(31)}`, "q"];
  const recipes: Label[] = [root];
  for (const step of [...steps, ...steps, `p${"a".repeat(32)}`])
    recipes.push(labelBelow(recipes.at(-1)!, step));
  for (const [index, recipe] of recipes.slice(1).entries())
    assert.equal(labelBelow(recipes[index]!, recipe.step), recipe);
  const deep = recipes.at(-1)!;
  const text = ["x", ...recipes.slice(1).map((recipe) => recipe.step)].join(".");
  const { records } = withLabelRecords(() =>
    assert.deepEqual(
      charged(pass, () => assert.equal(labelText(contract, deep), text)),
      { counted: { invSteps: recipes.length, literalUnits: 1 + kept(text.length) }, apart: {} },
    ),
  );
  // (the one text it made: no prefix's)
  assert.deepEqual(
    records.filter((record) => record.kind === "text").map((record) => [record.text, record.made]),
    [[text, true]],
  );
  assert.deepEqual(
    charged(pass, () => assert.equal(labelText(contract, deep), text)),
    { counted: { invSteps: 1 }, apart: {} },
  );
  const below = labelBelow(deep, "z");
  assert.deepEqual(
    charged(pass, () => assert.equal(labelText(contract, below), `${text}.z`)),
    { counted: { invSteps: 2, literalUnits: 1 + kept(text.length + 2) }, apart: {} },
  );
  // a plain text, for a caller that charges what it keeps: nothing charged, nothing kept, so it is made again if shown
  const middle = recipes[9]!;
  const middleText = text.split(".").slice(0, 10).join(".");
  assert.deepEqual(
    charged(pass, () => assert.equal(labelPlainText(middle), middleText)),
    { counted: {}, apart: {} },
  );
  assert.deepEqual(
    charged(pass, () => assert.equal(labelText(contract, middle), middleText)),
    { counted: { invSteps: 10, literalUnits: 1 + kept(middleText.length) }, apart: {} },
  );
  // after a stop a showing is finishing work, apart from the allowance
  pass.program.work.stop("work");
  assert.deepEqual(
    charged(pass, () => assert.equal(labelText(contract, deep), text)),
    { counted: {}, apart: { invSteps: 1 } },
  );
});

test("a showing the allowance stops is recorded with what it charged and no text, and leaves its recipe without one", () => {
  const made = request("let x = 1\nexit\n");
  const pass = withTestAllowance(100_000, () => narrowingPass(made));
  const { contract } = pass;
  let deep = labelRoot(contract, bindingOf(pass, "x"));
  for (let depth = 0; depth < 8; depth += 1) deep = labelBelow(deep, "q");
  // (one unit left: the showing's visits pass the allowance)
  const { work } = pass.program;
  work.charge("checks", work.allowance - work.total - 1);
  const { records } = withLabelRecords(() =>
    assert.throws(() => labelText(contract, deep), BudgetExhausted),
  );
  assert.deepEqual(
    records.map((record) =>
      record.kind === "text" ? [record.text, record.made, record.counters, record.apart] : null,
    ),
    [[null, false, { invSteps: 9 }, {}]],
  );
  assert.equal(deep.text, null);
});

const nest = (n: number, leaf: string): string => {
  let value = leaf;
  for (let level = 0; level < n; level += 1) value = `{a: ${value}}`;
  return value;
};
const along = (n: number): string => Array.from({ length: n }, () => "a").join(".");
const long = `anUnusuallyLongPropertyName${"x".repeat(12)}`;

/** Sources with the labels their stores' warnings and checks show; none for those whose decisions show nothing. */
const CASES: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "a dict's entries, by its written type",
    'let d: integer[] dict = {}\nd["k"] = hostValue\nexit\n',
    ["d.entry", "d.entry.element"],
  ],
  [
    "a list's elements below properties, by the contract",
    "let box = {inner: {xs: [1, 2]}}\nbox.inner.xs.add(hostValue)\nlet n: integer = box.inner.xs[0]\nexit\n",
    ["box.inner.xs.element", "n"],
  ],
  [
    "a written nested list, every prefix decided",
    `let xs: integer[][][][][][] = [[[[[[1]]]]]]\nxs[0][0][0][0][0].add(hostValue)\nexit\n`,
    ["xs.element.element.element.element.element.element"],
  ],
  [
    "long names past `SHORT`",
    `let box = {${long}: {${long}: {v: 1}}}\nbox.${long}.${long}.v = hostValue\nlet k: integer = box.${long}.${long}.v\nexit\n`,
    [`box.${long}.${long}.v`, "k"],
  ],
  [
    "a chain whose decisions show nothing",
    `let box = ${nest(12, "1")}\nbox.${along(12)} = 2\nexit\n`,
    [],
  ],
  [
    "reads of every prefix, nothing shown",
    `let box = ${nest(12, "1")}\n${Array.from({ length: 12 }, (_, i) => `let r${i} = box.${along(i + 1)}`).join("\n")}\nexit\n`,
    [],
  ],
  [
    "a rejection cycle's store, decided again in each pass (A6)",
    "let written:integer | string=83\nlet annotated={v:written,tag:1}\nlet inside={v:false,tag:false}\ninside=annotated\nlet outer=inside\nouter={v:83,tag:false}\nlet result=[inside,outer]\nexit\n",
    ["outer.v", "result.element.v"],
  ],
  [
    "a store a handler changes later, its data checked nowhere: nothing shown",
    `let n = 1\nlet box = ${nest(3, "{v: 0}")}\nbox.${along(3)}.v = n\nshowPermanentButton "x" { n = 1.5 }\nlet copy: integer = box.${along(3)}.v\nexit\n`,
    [],
  ],
];

/** In every mode the labels `cases` show are those they publish, each text made at most once in a pass. */
function showsPublished(cases: typeof CASES): void {
  for (const [name, source, shown] of cases)
    for (const mode of MODES) {
      const at = `${name}, ${JSON.stringify(mode)}`;
      const made = request(source);
      const { result, records } = withLabelRecords(() => inMode(mode, () => analyseCore(made)));
      const texts = records.filter(
        (record): record is Extract<LabelRecord, { kind: "text" }> =>
          record.kind === "text" && record.pass !== null,
      );
      assert.deepEqual(
        [...new Set(texts.map((record) => record.text))].sort(),
        [...shown].sort(),
        at,
      );
      const published = JSON.stringify([result.diagnostics, result.checks]);
      for (const text of shown) {
        assert.ok(published.includes(`"${text}"`), `${at}: ${text} published`);
        // (in each pass at most once; a place's own label is its place's, never made)
        const passes = texts.filter((record) => record.text === text && record.made);
        assert.equal(
          new Set(passes.map((record) => record.pass)).size,
          passes.length,
          `${at}: ${text}`,
        );
      }
    }
}

test("a decision's label makes no text: in every mode the labels shown are those the store's warnings and checks publish, each text made at most once in the pass, spelled by the contract or the written type", () => {
  showsPublished(CASES);
});

/**
 * #1484: a consumer's label is its target's recipe (`keyLabel`), its text made where its warning or check shows it. Each
 * consumer that names a label, by the label's kind: a variable's path, an element, a dict's entry, a call's result, a
 * `get`'s result, a parameter, a loop variable, an anonymous value's own text, a fallback's steps below it; and consumers
 * that show nothing.
 */
const CONSUMER_CASES: typeof CASES = [
  ["a member read's receivers", "let raw = hostValue\nsay raw.a.b\nexit\n", ["raw", "raw.a"]],
  ["a method's receiver", "let raw = hostValue\nraw.items.clear()\nexit\n", ["raw", "raw.items"]],
  ["a store's receiver", "let raw = hostValue\nraw.inner.v = 1\nexit\n", ["raw", "raw.inner"]],
  [
    "an add's receiver, a place's path",
    "let box = {items: [1]}\nbox.items = hostValue\nbox.items.add(2)\nexit\n",
    ["box.items"],
  ],
  ["a selection", "let raw = hostValue\nsay raw.items.first\nexit\n", ["raw", "raw.items"]],
  ["a count", "let raw = hostValue\nrepeat raw.n {}\nexit\n", ["raw", "raw.n"]],
  ["an argument", 'let raw = hostValue\nsay "abc".contains(raw.part)\nexit\n', ["raw", "raw.part"]],
  [
    "an operand that may be null",
    'let maybe = "ok"\nif askBoolean("Clear?") { maybe = null }\nlet box = {v: maybe}\nlet n = box.v + "x"\nexit\n',
    ["box.v"],
  ],
  ["an element", "let xs = [hostValue]\nsay xs[0].v.w\nexit\n", ["xs.element", "xs.element.v"]],
  [
    "a dict's entry",
    'let d = dict{ a: hostValue }\nsay d["a"].v.w\nexit\n',
    ["d.entry", "d.entry.v"],
  ],
  [
    "a call's result",
    "function f {\n  return hostValue\n}\nsay f().v.w\nexit\n",
    ["f.result", "f.result.v"],
  ],
  ["an anonymous value's own text", "say [hostValue][0].v\nexit\n", ["[hostValue][0]"]],
  [
    "a `get`'s result",
    "let xs = [hostValue]\nsay xs.get(0, default: hostOther).v.w\nexit\n",
    ["xs.element", "xs.element.v"],
  ],
  ["a parameter", "function g(p) {\n  say p.v.w\n}\ng(hostValue)\nexit\n", ["g.p", "g.p.v"]],
  ["a loop variable", "let xs = [hostValue]\nfor x in xs {\n  say x.v.w\n}\nexit\n", ["x", "x.v"]],
  ["a list's elements at `join`", "let xs = [hostValue]\nsay xs.join()\nexit\n", ["xs.element"]],
  [
    "a dict's values, a new list each read",
    "let d = dict{ a: hostValue }\nsay d.values[0].v\nexit\n",
    ["d.values[0]"],
  ],
  [
    "a fallback",
    "let raw = hostValue\nlet n = 1\nlet k = n otherwise raw.m\nexit\n",
    ["raw", "raw.m"],
  ],
  [
    "a fallback's elements by depth",
    "let raw = hostValue\nlet xs = [[1, 2]]\nlet ys = xs otherwise [[1], raw.b]\nexit\n",
    [
      "raw",
      "ys.element",
      "ys.element.element",
      "[[1], raw.b].element",
      "[[1], raw.b].element.element",
    ],
  ],
  // (a written union whose other type lacks the member, the value here the one that has it: nothing shown)
  ["a method's receiver, nothing shown", "let v: integer[] | string = [1]\nv.clear()\nexit\n", []],
  [
    "a member read's receiver, nothing shown",
    "let v: object | string = {a: 1}\nsay v.a\nexit\n",
    [],
  ],
  ["a store's receiver, nothing shown", "let v: object | string = {a: 1}\nv.a = 2\nexit\n", []],
  [
    "a method's receiver below properties, nothing shown",
    "let xs: integer[] | string = [1]\nlet v = {inner: {xs: xs}}\nv.inner.xs.clear()\nexit\n",
    [],
  ],
];

test("a consumer's label makes its text only where its warning or check shows it: in every mode the labels shown are those published, each text made at most once in the pass", () => {
  showsPublished(CONSUMER_CASES);
});

test("a consumer's labels grow with what they show: a read chain twice as deep asks each value's recipe once and makes each label it shows once, a quiet one none", () => {
  const counts = [16, 32].map((n) => {
    const shown = withLabelRecords(() =>
      analyseCore(request(`let raw = hostValue\nsay raw${".a".repeat(n)}\nexit\n`)),
    ).records;
    const quiet = withLabelRecords(() =>
      analyseCore(
        request(
          `let xs: integer${"[]".repeat(n)} = ${"[".repeat(n)}1${"]".repeat(n)}\nxs${"[0]".repeat(n - 1)}.add(2)\nlet k: integer = xs${"[0]".repeat(n)}\nexit\n`,
        ),
      ),
    ).records;
    const made = (records: readonly LabelRecord[]): string[] =>
      records.flatMap((record) =>
        record.kind === "text" && record.pass !== null && record.made ? [record.text ?? ""] : [],
      );
    return {
      n,
      asked: shown.filter((record) => record.kind === "recipe").length,
      made: made(shown),
      quiet: made(quiet),
    };
  });
  for (const { n, made, quiet } of counts) {
    assert.deepEqual(
      made.sort(),
      Array.from({ length: n - 1 }, (_, depth) => `raw${".a".repeat(depth + 1)}`).sort(),
      `${n}: each label shown made once`,
    );
    assert.deepEqual(quiet, [], `${n}: a quiet chain makes no text`);
  }
  const [small, large] = counts;
  assert.ok(large!.asked <= 2.2 * small!.asked, `${small!.asked} -> ${large!.asked} recipes asked`);
});

test("the recipes a decision makes grow with its path, not with its prefixes' texts: a chain twice as deep makes about twice the recipes and no text more than it shows", () => {
  const counts = [16, 32].map((n) => {
    const source = `let xs: integer${"[]".repeat(n)} = ${"[".repeat(n)}1${"]".repeat(n)}\nxs${"[0]".repeat(n - 1)}.add(hostValue)\nexit\n`;
    const { records } = withLabelRecords(() => analyseCore(request(source)));
    const recipes = records.filter((record) => record.kind === "recipe" && record.made).length;
    const made = records
      .filter((record) => record.kind === "text" && record.made)
      .map((record) => (record.kind === "text" ? (record.text?.length ?? 0) : 0));
    return { n, recipes, made };
  });
  for (const { n, recipes, made } of counts) {
    assert.equal(recipes, n + 1, `${n}: one recipe per step and the root`);
    assert.deepEqual(made, [2 + 8 * n], `${n}: the one label shown, made once`);
  }
});
