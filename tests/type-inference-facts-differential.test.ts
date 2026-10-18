import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { SolvedTypeFacts } from "../src/type-inference/backend.js";
import { differential, type Difference } from "./helpers/facts-differential.js";

/**
 * The facts differential of O4 stage 3a (work note §7, §10): every straight-line source of the solver's case set and
 * of the hand cases is solved and exported, its facts compared with the legacy's, and every difference classified;
 * a class-4 difference fails. The classifier must reject a changed fact at an arbitrary site and at a site that is
 * otherwise eligible for class 1 or class 2 (the mutation tests).
 */

const FIXTURE = new URL("../../tests/fixtures/type-inference/solver-cases.jsonl", import.meta.url);

interface SolverCase {
  readonly name: string;
  readonly source: string;
}

function readCases(): readonly SolverCase[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      // EVIDENCE: fixture: the solver cases are written by the reference model's run with these fields.
      const parsed = JSON.parse(line) as SolverCase;
      return parsed;
    });
}

const HAND: readonly SolverCase[] = [
  { name: "held-later", source: 'let x = 1\nx = fromJson("1", default: 1)\nexit' },
  { name: "null-first", source: "let x = null\nx = 1\nexit" },
  { name: "empty-literal", source: "let xs = []\nexit" },
  { name: "empty-then-null", source: "let xs = []\nxs.add(null)\nexit" },
  { name: "conflict", source: 'let x = "s"\nx = 1\nexit' },
  { name: "widening", source: "let x = 1\nx = 2.5\nexit" },
  { name: "defined-union", source: 'let x = fromBase64("YQ==", default: 1)\nexit' },
];

/** Astra's r10 cases of the oracle (work note §11): what each must classify, and what an injected fact must get. */
const R10: readonly SolverCase[] = [
  { name: "held-nested-second", source: 'let xs = [[1], [fromJson("1"), 1]]\nexit' },
  { name: "bound-covered-possibility", source: 'let x: string = "s"\nx = hostValue + "a"\nexit' },
  { name: "unconditional-text", source: "let r = toString(hostValue)\nexit" },
  { name: "unconditional-round", source: "let r = round(hostValue)\nexit" },
  { name: "eleven-nested-lists", source: "let r = [[[[[[[[[[[1]]]]]]]]]]]\nexit" },
  {
    name: "unrelated-copy-and-mutation",
    source: "let r = 1\nlet a = 2\nlet b = a\nlet xs = [1]\nxs.add(2)\nexit",
  },
  {
    name: "held-with-unrelated-copy-and-mutation",
    source:
      'let x = 1\nx = fromJson("1", default: 1)\nlet a = 2\nlet b = a\nlet xs = [1]\nxs.add(2)\nexit',
  },
  {
    name: "same-shape-mutation",
    source: "let a = {x:1}\nlet b = {x:1}\nlet c = [a,b].first\nc.x = 2.5\nexit",
  },
  { name: "pow-known", source: "let r = pow(2, 3)\nexit" },
  { name: "pow-folded", source: "let r = pow(1 + 1, 3)\nexit" },
];

const describe = (d: Difference): string =>
  `${d.what} ${d.name} @${d.site.start}: legacy ${d.legacy ?? "(none)"} | candidate ${d.candidate ?? "(none)"} | class ${d.class}: ${d.evidence}`;

test("every difference on the straight-line sources is a decided rule, a replaced mechanism or named as not solved yet", () => {
  const counts: { sources: number; straightLine: number; compared: number; classes: number[] } = {
    sources: 0,
    straightLine: 0,
    compared: 0,
    classes: [0, 0, 0, 0, 0],
  };
  const defects: string[] = [];
  for (const c of [...readCases(), ...HAND, ...R10]) {
    const result = differential(c.source);
    if (result === null) continue;
    counts.sources += 1;
    if (result.straightLine) counts.straightLine += 1;
    counts.compared += result.compared;
    for (const d of result.differences) {
      counts.classes[d.class] = (counts.classes[d.class] ?? 0) + 1;
      if (d.class === 4) defects.push(`${c.name}: ${describe(d)}`);
    }
  }
  assert.ok(counts.straightLine > 50, `straight-line sources compared: ${counts.straightLine}`);
  assert.deepEqual(
    defects,
    [],
    `class-4 differences:\n${defects.join("\n")}\n(${JSON.stringify(counts)})`,
  );
});

test("the hand cases take the classes the decided rules give them", () => {
  const classesOf = (source: string): readonly Difference[] =>
    differential(source)!.differences.filter((d) => d.what === "binding");
  const held = classesOf(HAND[0]!.source);
  assert.equal(held[0]?.class, 1, "a held mark whatever the order is Q3.2a (class 1)");
  assert.match(held[0]!.evidence, /Q3\.2a/);
  const empty = classesOf(HAND[2]!.source);
  assert.equal(
    empty[0]?.class,
    2,
    "the legacy's undecided element slot is a replaced mechanism (class 2)",
  );
  assert.deepEqual(
    classesOf(HAND[4]!.source),
    [],
    "a conflict exports its working kind, as the legacy keeps the first kind",
  );
  assert.deepEqual(classesOf(HAND[6]!.source), [], "a defined union is the legacy's union");
});

const changeFirstBinding =
  (text: string) =>
  (facts: SolvedTypeFacts): SolvedTypeFacts => ({
    ...facts,
    bindings: facts.bindings.map((b, i) => (i === 0 ? { ...b, type: text } : b)),
  });

test("Astra's r10 cases take their classes, and an injected fact at each is rejected", () => {
  const source = (name: string): string => R10.find((c) => c.name === name)!.source;
  const bindings = (name: string, mutate?: (facts: SolvedTypeFacts) => SolvedTypeFacts) =>
    differential(source(name), mutate)!.differences.filter((d) => d.what === "binding");
  const classes = (name: string, mutate?: (facts: SolvedTypeFacts) => SolvedTypeFacts) =>
    bindings(name, mutate).map((d) => d.class);
  // a nested held mark is Q3.2a/Q3.2c in the element (class 1); its loss is a defect
  const nested = bindings("held-nested-second");
  assert.deepEqual(
    nested.map((d) => d.class),
    [1],
  );
  assert.match(nested[0]!.evidence, /Q3\.2a.*in the element/);
  assert.deepEqual(classes("held-nested-second", changeFirstBinding("list<list<integer>>")), [4]);
  // a possibility a written bound covers adds no held mark (r10-B4); a held mark injected there is a defect
  assert.deepEqual(classes("bound-covered-possibility"), []);
  assert.deepEqual(classes("bound-covered-possibility", changeFirstBinding("string!")), [4]);
  // an unconditional answer under a dynamic view is a witness; an injected held mark is a defect
  assert.deepEqual(classes("unconditional-text"), []);
  assert.deepEqual(classes("unconditional-text", changeFirstBinding("string!")), [4]);
  assert.deepEqual(classes("unconditional-round"), []);
  assert.deepEqual(classes("unconditional-round", changeFirstBinding("integer!")), [4]);
  // the derivation is bounded by the cycle, not by a depth: a never injected at depth eleven is a defect
  assert.deepEqual(classes("eleven-nested-lists"), []);
  assert.deepEqual(
    classes(
      "eleven-nested-lists",
      changeFirstBinding(`${"list<".repeat(11)}never${">".repeat(11)}`),
    ),
    [4],
  );
  // a copied value changed in place exempts the bindings it reaches, not the others of the source (r10-B7)
  assert.deepEqual(classes("unrelated-copy-and-mutation"), []);
  assert.deepEqual(classes("unrelated-copy-and-mutation", changeFirstBinding("string")), [4]);
  const unrelated = bindings("held-with-unrelated-copy-and-mutation");
  assert.deepEqual(
    unrelated.map((d) => [d.name, d.class]),
    [["x", 1]],
  );
  assert.match(unrelated[0]!.evidence, /Q3\.2a/);
  assert.deepEqual(
    classes("held-with-unrelated-copy-and-mutation", changeFirstBinding("string")),
    [4],
  );
  const shared = bindings("same-shape-mutation");
  assert.deepEqual(
    shared.map((d) => [d.name, d.class]),
    [
      ["a", 3],
      ["b", 3],
    ],
  );
  assert.match(shared[0]!.evidence, /copied value is changed in place/);
  // the legacy's fold of constant operands is a capability 3a does not model: class 3, named (r10-S1)
  for (const name of ["pow-known", "pow-folded"]) {
    const folded = bindings(name);
    assert.deepEqual(
      folded.map((d) => d.class),
      [3],
      name,
    );
    assert.match(folded[0]!.evidence, /known-value fold/);
  }
  assert.deepEqual(classes("pow-known", changeFirstBinding("string")), [4]);
});

test("the classifier rejects a changed fact at an arbitrary site, a class-1 site and a class-2 site", () => {
  const arbitrary = differential("let x = 1\nexit", changeFirstBinding("string"))!;
  assert.deepEqual(
    arbitrary.differences.filter((d) => d.what === "binding").map((d) => d.class),
    [4],
  );
  const classOne = differential(HAND[0]!.source, changeFirstBinding("string!"))!;
  assert.deepEqual(
    classOne.differences.filter((d) => d.what === "binding").map((d) => d.class),
    [4],
    "a changed fact at a site eligible for class 1 is not class 1",
  );
  const classTwo = differential(HAND[2]!.source, changeFirstBinding("list<string>"))!;
  assert.deepEqual(
    classTwo.differences.filter((d) => d.what === "binding").map((d) => d.class),
    [4],
    "a changed fact at a site eligible for class 2 is not class 2",
  );
});
