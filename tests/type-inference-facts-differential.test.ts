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

/** Astra's r11 cases of the oracle (work note §11): a possible receiver's member, the copy exemption, the product, a fold. */
const R11: readonly SolverCase[] = [
  {
    name: "r11-possible-property-invented-witness",
    source: 'let x = hostValue + "a"\nlet n = x.length\nexit',
  },
  {
    name: "r11-covered-property-provenance",
    source: 'let x: string = "s"\nx = hostValue + "a"\nlet n = x.length\nexit',
  },
  {
    name: "r11-scalar-length-copy-exemption",
    source: "let a = [1]\nlet b = a.length\na.add(2)\nexit",
  },
  {
    name: "r11-literal-length-copy-exemption",
    source: "let a = [1]\nlet b = [a].length\na.add(2)\nexit",
  },
  { name: "r11-mutation-before-copy-exemption", source: "let a = [1]\na.add(2)\nlet b = a\nexit" },
  { name: "r11-partial-known-pow", source: "let r = pow(round(hostValue),3)\nexit" },
  // PR 3a review r1 (Astra and Sol): a computed scalar beside a real copy, before and after the mutation; a nested
  // written union; the zero-property open shape
  {
    name: "r1-computed-scalar-exemption",
    source: "let a = [1]\nlet b = a\nlet n = a.length\na.add(2)\nexit",
  },
  { name: "r1-copied-length", source: "let a = [1]\nlet b = a\na.add(2)\nlet n = b.length\nexit" },
  {
    name: "r1-computed-text-beside-copy",
    source: "let a = [1]\nlet b = a\na.add(2)\nlet n = toString(a)\nexit",
  },
  { name: "r1-copied-first", source: 'let a = [1]\nlet b = a\na.add("s")\nlet n = b.first\nexit' },
  { name: "r1-nested-written-union", source: "let x: (integer | string)[] = hostValue\nexit" },
  { name: "r1-empty-open-shape", source: "let a = {}\na = -a\nexit" },
  {
    name: "r11-oracle-product-cutoff",
    source: [
      "let a = [1]",
      ...Array.from({ length: 31 }, () => "a = [1]"),
      'a = [fromJson("1"), 1]',
      'let b = ["s"]',
      ...Array.from({ length: 32 }, () => 'b = ["s"]'),
      "let r = a + b",
      "exit",
    ].join("\n"),
  },
];
const R2: readonly SolverCase[] = [
  { name: "r2-direct-length", source: "let a = [1]\nlet b = a\na.add(2)\nlet n = a.length\nexit" },
  {
    name: "r2-joined-length",
    source: "let a = [1]\nlet b = a\na.add(2)\nlet n = a.toSet().length\nexit",
  },
  {
    name: "r2-copied-joined-length",
    source: "let a = [1]\nlet b = a\nlet c = a.toSet()\na.add(2)\nlet n = c.length\nexit",
  },
  {
    name: "r2-projected-text",
    source: "let a = [1]\nlet b = a\na.add(2)\nlet n = toString(a.first)\nexit",
  },
  {
    name: "r2-nested-projected-length",
    source: "let a = [1]\nlet b = a\na.add(2)\nlet n = [a.first].length\nexit",
  },
  { name: "r2-nested-bound-0", source: "let x: (integer | string)[] = hostValue\nexit" },
  { name: "r2-nested-bound-1", source: "let x: (integer | string)[][] = hostValue\nexit" },
  { name: "r2-nested-bound-2", source: "let x: (integer | string) set = hostValue\nexit" },
  { name: "r2-nested-bound-3", source: "let x: (integer | string) dict = hostValue\nexit" },
  {
    name: "r2-random-nested-object",
    source:
      'let a = {weight: 1, x: {y: 1}}\nlet r = randomWeighted([a], weight: "weight")\nlet n = r.x.y\nexit',
  },
  {
    name: "r2-form-0",
    source: 'let fields = {n: {value: 1}}\nlet r = askForm("Q", fields: fields)\nlet n = r.n\nexit',
  },
  {
    name: "r2-form-3",
    source:
      'let choices = [{text: "A", value: 1}]\nlet fields = {n: {options: choices}}\nlet r = askForm("Q", fields: fields)\nlet n = r.n\nexit',
  },
  {
    name: "r2-missing-union",
    source: "let a = {x: {y: 1}}\nlet c = [a].union()\nlet n = c.first.x.y\nexit",
  },
];

const R3: readonly SolverCase[] = [
  {
    name: "r3-union-extra-nested",
    source:
      "let leaf = {y: 1}\nlet branch = {}\nbranch.x = leaf\nlet a = {}\na.z = branch\nlet c = [a].union([],[])\nlet n = c.first.z.x.y\nexit",
  },
  {
    name: "r3-union-named-nested",
    source:
      "let leaf = {y: 1}\nlet branch = {}\nbranch.x = leaf\nlet a = {}\na.z = branch\nlet c = [a].union(foo: [])\nlet n = c.first.z.x.y\nexit",
  },
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
  for (const c of [...readCases(), ...HAND, ...R10, ...R11, ...R2, ...R3]) {
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

test("Astra's r11 cases take their classes, and an injected fact at each is rejected", () => {
  const source = (name: string): string => R11.find((c) => c.name === name)!.source;
  const bindings = (name: string, mutate?: (facts: SolvedTypeFacts) => SolvedTypeFacts) =>
    differential(source(name), mutate)!.differences.filter((d) => d.what === "binding");
  const classes = (name: string, mutate?: (facts: SolvedTypeFacts) => SolvedTypeFacts) =>
    bindings(name, mutate).map((d) => d.class);
  const changeBinding =
    (name: string, text: string) =>
    (facts: SolvedTypeFacts): SolvedTypeFacts => ({
      ...facts,
      bindings: facts.bindings.map((b) => (b.name === name ? { ...b, type: text } : b)),
    });
  // a possible receiver's member answer is a possibility, not a witness (r11-B3)
  assert.deepEqual(classes("r11-possible-property-invented-witness"), []);
  assert.deepEqual(
    classes("r11-possible-property-invented-witness", changeBinding("n", "integer!")),
    [4],
  );
  const covered = bindings("r11-covered-property-provenance");
  assert.deepEqual(
    covered.map((d) => [d.name, d.class]),
    [["n", 1]],
  );
  assert.match(covered[0]!.evidence, /Q3\.2a/);
  // a computed scalar of a mutated collection is compared; a mutation before the copy exempts nothing (r11-B4)
  for (const name of [
    "r11-scalar-length-copy-exemption",
    "r11-literal-length-copy-exemption",
    "r11-mutation-before-copy-exemption",
  ]) {
    assert.deepEqual(classes(name), [], name);
    assert.deepEqual(classes(name, changeBinding("b", "string")), [4], name);
  }
  // the product of choices is complete: the held mark of the last of 33 members is expected (r11-B5)
  const product = bindings("r11-oracle-product-cutoff");
  assert.equal(product.find((d) => d.name === "r")?.class, 1);
  assert.equal(
    bindings("r11-oracle-product-cutoff", changeBinding("r", "list<integer>")).find(
      (d) => d.name === "r",
    )?.class,
    4,
  );
  // a known operand beside an unknown one narrows the legacy's answer: the fold, class 3 (r11-S1)
  const fold = bindings("r11-partial-known-pow");
  assert.deepEqual(
    fold.map((d) => d.class),
    [3],
  );
  assert.match(fold[0]!.evidence, /known-value fold/);
  // PR review r1-B2 (Astra, Sol): a computed scalar of a copied collection is compared, before or after the mutation
  // and through the copy; a read of the copied content stays class 3
  for (const [name, wrong] of [
    ["r1-computed-scalar-exemption", "string"],
    ["r1-copied-length", "string"],
    ["r1-computed-text-beside-copy", "integer"],
  ] as const) {
    assert.deepEqual(classes(name), [], name);
    assert.deepEqual(classes(name, changeBinding("n", wrong)), [4], name);
  }
  // a read of the copied content keeps the exemption: an injected fact there is class 3, not a defect
  assert.deepEqual(classes("r1-copied-first"), []);
  assert.deepEqual(classes("r1-copied-first", changeBinding("n", "string")), [3]);
  // PR review r1-B3 (Astra): a nested written union keeps every member; the held mark is Q3.2a, the narrowed fact
  // a defect
  const nested = bindings("r1-nested-written-union");
  assert.deepEqual(
    nested.map((d) => [d.name, d.class]),
    [["x", 1]],
  );
  assert.match(nested[0]!.evidence, /Q3\.2a/);
  assert.deepEqual(classes("r1-nested-written-union", changeBinding("x", "list<integer>!")), [4]);
  // PR review r1-S2 (Sol): the zero-property open shape is the legacy's replaced mechanism
  const open = bindings("r1-empty-open-shape");
  assert.deepEqual(
    open.map((d) => [d.name, d.class]),
    [["a", 2]],
  );
});

test("Astra's r2 cases take their classes, and an injected fact at each is rejected", () => {
  const source = (name: string): string => R2.find((c) => c.name === name)!.source;
  const bindings = (name: string, mutate?: (facts: SolvedTypeFacts) => SolvedTypeFacts) =>
    differential(source(name), mutate)!.differences.filter((d) => d.what === "binding");
  const classes = (name: string, mutate?: (facts: SolvedTypeFacts) => SolvedTypeFacts) =>
    bindings(name, mutate).map((d) => d.class);
  const changeBinding =
    (name: string, text: string) =>
    (facts: SolvedTypeFacts): SolvedTypeFacts => ({
      ...facts,
      bindings: facts.bindings.map((b) => (b.name === name ? { ...b, type: text } : b)),
    });
  // PR review r2-B2 (Astra): a computed scalar beside a copied list is compared whether or not its derivation
  // projected the list's elements; only an answer that changes with the content is exempt
  const computed: readonly (readonly [string, string])[] = [
    ["r2-direct-length", "string"],
    ["r2-joined-length", "string"],
    ["r2-copied-joined-length", "string"],
    ["r2-projected-text", "integer"],
    ["r2-nested-projected-length", "string"],
  ];
  for (const [name, wrong] of computed) {
    assert.deepEqual(classes(name), [], name);
    assert.deepEqual(classes(name, changeBinding("n", wrong)), [4], name);
  }
  // PR review r2-S1 (Astra): a written union nested in a collection keeps its members at every level; the held mark
  // on the host's value is Q3.2a
  for (const name of [
    "r2-nested-bound-0",
    "r2-nested-bound-1",
    "r2-nested-bound-2",
    "r2-nested-bound-3",
  ]) {
    const found = bindings(name);
    assert.deepEqual(
      found.map((d) => [d.name, d.class]),
      [["x", 1]],
      name,
    );
    assert.match(found[0]!.evidence, /Q3\.2a/, name);
  }
  // PR review r2-B1 (Astra): a consumer of a nested shape reads it through one store boundary (work note §3.5)
  for (const name of ["r2-random-nested-object", "r2-form-0", "r2-form-3", "r2-missing-union"])
    assert.deepEqual(classes(name), [], name);
});

test("Astra's r3 cases take their classes", () => {
  // PR review r3-S1 (Astra): a `union()` call with an arity or name report still builds the collection from the real
  // parts, so a nested property read through it reaches its type. (An injected fact at `n` is not asserted here: the
  // store `branch.x = leaf` marks `leaf` as a copied value changed in place, the exemption's breadth under review
  // with r3-B3.)
  for (const c of R3)
    assert.deepEqual(
      differential(c.source)!
        .differences.filter((d) => d.what === "binding")
        .map((d) => d.class),
      [],
      c.name,
    );
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
