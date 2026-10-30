import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type CorePass } from "../src/type-inference/core/answers.js";
import type { WorkCounter } from "../src/type-inference/core/budget.js";
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

/** The units `run` charges by counter, against the allowance and apart alike. */
function charged(pass: CorePass, run: () => void): Partial<Record<WorkCounter, number>> {
  const { work } = pass.program;
  const before = [work.counts(), work.apartCounts()];
  run();
  const out: Partial<Record<WorkCounter, number>> = {};
  for (const [index, now] of [work.counts(), work.apartCounts()].entries())
    for (const [counter, units] of now) {
      const spent = units - (before[index]!.get(counter) ?? 0);
      if (spent !== 0) out[counter] = (out[counter] ?? 0) + spent;
    }
  return out;
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
      { invSteps: recipes.length, literalUnits: 1 + kept(text.length) },
    ),
  );
  // (the one text it made: no prefix's)
  assert.deepEqual(
    records.filter((record) => record.kind === "text").map((record) => [record.text, record.made]),
    [[text, true]],
  );
  assert.deepEqual(
    charged(pass, () => assert.equal(labelText(contract, deep), text)),
    { invSteps: 1 },
  );
  const below = labelBelow(deep, "z");
  assert.deepEqual(
    charged(pass, () => assert.equal(labelText(contract, below), `${text}.z`)),
    { invSteps: 2, literalUnits: 1 + kept(text.length + 2) },
  );
  // a plain text, for a caller that charges what it keeps: nothing charged, nothing kept, so it is made again if shown
  const middle = recipes[9]!;
  const middleText = text.split(".").slice(0, 10).join(".");
  assert.deepEqual(
    charged(pass, () => assert.equal(labelPlainText(middle), middleText)),
    {},
  );
  assert.deepEqual(
    charged(pass, () => assert.equal(labelText(contract, middle), middleText)),
    { invSteps: 10, literalUnits: 1 + kept(middleText.length) },
  );
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
];

test("a decision's label makes no text: in every mode the labels shown are those the store's warnings and checks publish, each text made at most once in the pass, spelled by the contract or the written type", () => {
  for (const [name, source, shown] of CASES)
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
});

test("the recipes a decision makes grow with its path, not with its prefixes' texts: a chain twice as deep makes about twice the recipes and no text more than it shows", () => {
  const counts = [16, 32].map((n) => {
    const source = `let xs: integer${"[]".repeat(n)} = ${"[".repeat(n)}1${"]".repeat(n)}\nxs${"[0]".repeat(n - 1)}.add(hostValue)\nexit\n`;
    const { records } = withLabelRecords(() => analyseCore(request(source)));
    const recipes = records.filter((record) => record.kind === "recipe" && record.made).length;
    const made = records
      .filter((record) => record.kind === "text" && record.made)
      .map((record) => (record.kind === "text" ? record.text.length : 0));
    return { n, recipes, made };
  });
  for (const { n, recipes, made } of counts) {
    assert.equal(recipes, n + 1, `${n}: one recipe per step and the root`);
    assert.deepEqual(made, [2 + 8 * n], `${n}: the one label shown, made once`);
  }
});
