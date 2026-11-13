// A combined stop's more precise labels (#1595).

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { Consumers } from "../../../src/type-inference/core/consumers.js";
import { labelDomain } from "../../../src/type-inference/core/consumers/finishing.js";
import { keyOf } from "../../../src/type-inference/core/definitions.js";
import { REASON } from "../../../src/type-inference/core/items.js";
import type { Obligation } from "../../../src/type-inference/core/result.js";
import type { SourceSite } from "../../../src/type-inference/graph.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import {
  combinedAnalyses,
  heldDemands,
  heldStops,
  HELD_MODES,
  labelIdentities,
  type LabelIdentities,
  type LabelIdentity,
  withLabels,
  provenRelabel,
  recordedAnalysis,
  type HeldCase,
} from "../../helpers/type-core-held-host.js";

/**
 * The owner's one accepted relabel at a combined stop
 * (docs/specifications/type-inference-accepted-record/oracles.md#r4-322, #1595, the lead's rulings), each form accepted
 * alone and each condition alone refusing it. A stopped check under a more precise label than the reference's generic
 * one: E, the same root place with some `element` steps below it spelled `entry`; or E2, a place's own text whose path
 * up the compiler's projections is the reference's. Both labels are the compiler's own as recorded with each emitted
 * check (`labelIdentities`), never read back from a site, an expression or a name: a check at a method call names its
 * receiver (Codex r6's `xs["a"].add(...)`, `.clear()`, `xs.values[0].clear()`). The real cases are each program's first
 * relabel at a settled combined stop, proved by the natural analysis at that site and by the written type alone; the
 * unit cases change one part of a real one: the check, its location, its expected types or its words (2, 3), its
 * label's place or steps (3), its proof (1), or a label the recorder did not capture (refused and counted, never
 * inferred).
 */
test("a combined stop's more precise label is accepted only as the owner's three conditions allow (#1595)", () => {
  const mode = HELD_MODES[0]!;
  const same = (x: Obligation, u: Obligation): boolean =>
    x.kind === u.kind &&
    JSON.stringify(x.site) === JSON.stringify(u.site) &&
    x.boundary === u.boundary &&
    JSON.stringify(x.against) === JSON.stringify(u.against);
  // (a program's first relabel at a settled combined stop, demands up to 3, with both analyses' recorded labels)
  const relabel = (source: string) => {
    const c: HeldCase = { name: source, source, slice: true, values: [] };
    for (const demand of heldDemands(c, mode).filter((each) => each <= 3)) {
      const { reference, natural, stoppedAt } = combinedAnalyses(
        [{ path: "main.tease", source }],
        mode,
        demand,
      );
      for (const { allowance } of heldStops(c, mode, 1, demand)) {
        const stopped = stoppedAt(allowance);
        if (!stopped.budget.settled) continue;
        const owed = [...stopped.checks, ...stopped.budget.deferred.map((mark) => mark.obligation)];
        for (const u of reference.checks) {
          const x = owed.find((each) => same(each, u) && each.target !== u.target);
          if (x === undefined || owed.some((each) => JSON.stringify(each) === JSON.stringify(u)))
            continue;
          const [from, to] = [labelIdentities(reference)!, labelIdentities(stopped)!];
          return { u, x, graph: reference.graph, natural: natural.checks, from, to };
        }
      }
    }
    assert.fail(`no relabel: ${source}`);
  };
  const cases = [
    // (E at a method call, its receiver's label: Codex r6's witnesses)
    ['let xs: dict = dict {a: hostValue}\nxs["a"].add(hostOther)', "xs.element", "xs.entry"],
    ['let xs: dict = dict {a: [hostValue]}\nxs["a"].clear()', "xs.element", "xs.entry"],
    // (E2 at a method call: Codex r6's derived receiver)
    [
      "let xs: dict = dict {a: [hostValue]}\nxs.values[0].clear()",
      "xs.values.element",
      "xs.values[0]",
    ],
    // (E at a call's result; E2 at a binding and at a parameter)
    [
      'function build: integer dict {return dict {a: hostValue, b: 4}}\nsay "BEFORE"\nrepeat build()["a"] {say "ok"}',
      "build.result.element",
      "build.result.entry",
    ],
    [
      'let xs: dict = dict {a: hostValue, b: 4}\nsay "BEFORE"\nrepeat xs.values[0] {say "ok"}',
      "xs.values.element",
      "xs.values[0]",
    ],
    [
      'function show(xs: dict) {repeat xs.values[0] {say "ok"}}\nsay "BEFORE"\nshow(dict {a: hostValue})',
      "show.xs.values",
      "xs.values",
    ],
  ] as const;
  const found = cases.map(([program, reference, stopped]) => {
    const real = relabel(`${program}\nsay "AFTER"\nexit\n`);
    assert.deepEqual([real.u.target, real.x.target], [reference, stopped], program);
    const { u, x, graph, natural, from, to } = real;
    assert.equal(provenRelabel(u, [x], natural, graph, from, to), x, program);
    assert.equal(provenRelabel(u, [x], [], graph, from, to), x, `${program}: written`);
    return real;
  });
  const [entry, , own] = found;
  const { u, x, graph, natural, from, to } = entry!;
  const idOf = (labels: LabelIdentities, check: Obligation) => labels.of(check)!;
  const [root, read] = [idOf(from, u), idOf(own!.to, own!.x)];
  assert.deepEqual(
    [root.kind, root.steps, read.kind, read.steps],
    ["path", ["element"], "own", []],
  );
  // (2) another check, location or expected types under the label; (3) other words: refused before any label is read
  for (const other of [
    { ...x, kind: "integer-check" as const },
    { ...x, site: { ...x.site, end: x.site.end - 1 } },
    { ...x, boundary: true },
    { ...x, against: ["number" as const] },
    { ...x, on: "check that the count is a whole number" },
  ])
    assert.equal(
      provenRelabel(u, [other], natural, graph, from, to),
      undefined,
      JSON.stringify(other),
    );
  assert.deepEqual([...from.missing, ...to.missing], []);
  // (3) the label's place and steps: another root place, a step count or a step other than an element spelled `entry`,
  // own text with a step below it; a reference that is own text itself
  const other = [...Array(to.places).keys()].find(
    (place) => place !== root.place && to.site(place) !== null,
  )!;
  for (const label of [
    { kind: "path" as const, place: other, steps: ["entry"] },
    { kind: "path" as const, place: root.place, steps: ["element", "entry"] },
    { kind: "path" as const, place: root.place, steps: ["values"] },
    { kind: "own" as const, place: root.place, steps: ["entry"] },
  ])
    assert.equal(
      provenRelabel(u, [x], natural, graph, from, withLabels(to, [[x, label]])),
      undefined,
      JSON.stringify(label),
    );
  assert.equal(
    provenRelabel(u, [x], natural, graph, withLabels(from, [[u, { ...root, kind: "own" }]]), to),
    undefined,
  );
  // (3) with the natural analysis naming the stopped label there: an `entry` for a reference's property step, and the
  // read's own text where no derived list is on its path (the compiler spells that read's path)
  const element = [...Array(to.places).keys()].find((place) => {
    const path = to.climb(place);
    return path?.root === root.place && path.steps.join() === "element";
  })!;
  assert.ok(element !== undefined);
  assert.equal(
    provenRelabel(
      u,
      [x],
      natural,
      graph,
      withLabels(from, [[u, { ...root, steps: ["values"] }]]),
      withLabels(to, [[x, { kind: "path", place: root.place, steps: ["entry"] }]]),
    ),
    undefined,
  );
  assert.equal(
    provenRelabel(
      u,
      [x],
      natural,
      graph,
      from,
      withLabels(to, [[x, { kind: "own", place: element, steps: [] }]]),
    ),
    undefined,
  );
  // (3) E2: another expression's own text on the read's chain (its receiver, `xs.values`), own text with a step below
  // it, an `entry` path through the derived list
  {
    const { u, x, graph, natural, from, to } = own!;
    const receiver = [...Array(to.places).keys()].find((place) => {
      const path = to.climb(place);
      return path !== null && path.root === idOf(from, u).place && path.steps.join() === "values";
    })!;
    assert.ok(receiver !== undefined);
    for (const label of [
      { kind: "own" as const, place: receiver, steps: [] },
      { kind: "own" as const, place: read.place, steps: ["element"] },
      { kind: "path" as const, place: idOf(from, u).place, steps: ["values", "entry"] },
    ])
      assert.equal(
        provenRelabel(
          u,
          [x],
          label.kind === "path" ? [] : natural,
          graph,
          from,
          withLabels(to, [[x, label]]),
        ),
        undefined,
        JSON.stringify(label),
      );
  }
  // (1) neither proves it: a root place with no written type, the natural analysis naming it at another value's site,
  // otherwise or not at all
  const untyped = [...Array(to.places).keys()].find(
    (place) => place !== root.place && to.site(place) !== null && from.site(place) !== null,
  )!;
  const [bare, bareFrom] = [
    withLabels(to, [[x, { kind: "path", place: untyped, steps: ["entry"] }]]),
    withLabels(from, [[u, { kind: "path", place: untyped, steps: ["element"] }]]),
  ];
  const at = (target: string, site = x.site): Obligation => ({ ...x, target, site });
  assert.equal(provenRelabel(u, [x], [at(x.target)], graph, bareFrom, bare), x);
  assert.equal(provenRelabel(u, [x], [at(`${x.target}.f`)], graph, bareFrom, bare), x);
  for (const proof of [[], [at(x.target, { ...x.site, start: 0 })], [at(u.target)]])
    assert.equal(
      provenRelabel(u, [x], proof, graph, bareFrom, bare),
      undefined,
      JSON.stringify(proof),
    );
  // (a root's written type is its own declaration's, by its file and offsets: two files' locals at the same offsets,
  // each its own written type)
  {
    const sources = [
      'function f {\nlet ys: integer dict = dict {a: hostValue}\nrepeat ys[0] {say "a"}\n}\nf()\nexit\n',
      'function g {\nlet ys: integer[] = [hostValue, hostValue]\nrepeat ys[0] {say "a"}\n}\ng()\nexit\n',
    ];
    const answers = recordedAnalysis(
      sources.map((source, i) => ({ path: `${"ab"[i]!}.tease`, source })),
    );
    const labels = labelIdentities(answers)!;
    const roots = [...Array(labels.places).keys()].flatMap((place) => {
      const path = labels.climb(place);
      return path?.steps.join() === "element" ? [path.root] : [];
    });
    const rootIn = (file: number) => roots.find((each) => labels.site(each)?.file === file)!;
    const [ru, rx] = [
      { ...u, target: "ys.element", on: "check that ys.element is a whole number" },
      { ...u, target: "ys.entry", on: "check that ys.entry is a whole number" },
    ];
    const proved = (file: number) =>
      provenRelabel(
        ru,
        [rx],
        [],
        answers.graph,
        withLabels(labels, [[ru, { kind: "path", place: rootIn(file), steps: ["element"] }]]),
        withLabels(labels, [[rx, { kind: "path", place: rootIn(file), steps: ["entry"] }]]),
      );
    assert.equal(proved(0), rx);
    assert.equal(proved(1), undefined);
  }
  // (a stopped check whose label the recorder did not capture: refused and counted, never inferred)
  const unrecorded = { ...x, target: "xs.other", on: u.on.split(u.target).join("xs.other") };
  assert.equal(provenRelabel(u, [unrecorded], natural, graph, from, to), undefined);
  assert.deepEqual([...to.missing], [JSON.stringify(unrecorded)]);
  // (a read's path is the compiler's climb up its projections, linear in its length: twelve and twenty-three
  // selections within milliseconds)
  for (const length of [12, 23]) {
    const answers = recordedAnalysis([
      {
        path: "main.tease",
        source: `let xs: dict = dict {a: hostValue}\nrepeat xs.values${".first".repeat(length)} {say "a"}\nexit\n`,
      },
    ]);
    const labels = labelIdentities(answers)!;
    // (the read's own text: of the own labels its checks carry, the one deepest below its root)
    const deep = answers.checks
      .map((check) => labels.of(check))
      .filter((label) => label?.kind === "own")
      .sort(
        (a, b) =>
          (labels.climb(b!.place)?.steps.length ?? 0) - (labels.climb(a!.place)?.steps.length ?? 0),
      )[0];
    assert.ok(deep !== undefined && deep !== null, `${length}`);
    const started = performance.now();
    const path = labels.climb(deep.place);
    const took = performance.now() - started;
    assert.deepEqual(path?.steps, ["values", ...Array(length).fill("element")]);
    assert.ok(took < 100, `${length} selections: ${took} ms`);
  }
});

/**
 * After a program stop a label's step is spelled from a proof the stopped analysis holds (`labelDomain`, the lead's ruling
 * on #1595's HEAD 0): never from an open retained answer. A copy of an element of a list written without its element's
 * type, which every kind fits, read at every settled stop of a real run where its contract asked then is unsettled,
 * four modes: no label domain there.
 */
test("a label's step after a stop never rests on an open retained answer (#1595)", () => {
  const source =
    'let a: list = [hostValue]\nlet b = a[0]\nsay "BEFORE"\nsay "${b}"\nsay "AFTER"\nexit\n';
  const c: HeldCase = { name: "an open retained answer", source, slice: true, values: [] };
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
  let open = 0;
  for (const mode of HELD_MODES)
    for (const { allowance } of heldStops(c, mode)) {
      let walk: Consumers | undefined;
      const check = Consumers.prototype.check;
      Consumers.prototype.check = function (this: Consumers) {
        walk = this;
        return check.call(this);
      };
      try {
        mode.run(() => withTestAllowance(allowance, () => analyseCore(request)));
      } finally {
        Consumers.prototype.check = check;
      }
      if (!walk!.settled) continue;
      const place = walk!.pass.program.places.find(
        (each) => each.kind.kind === "binding" && each.kind.name === "b",
      )!.id;
      const { work } = walk!.pass.program;
      work.apart(() => {
        const contract = walk!.run(walk!.pass.contract.contractOf(keyOf(place, [])));
        const retained = walk!.admission.retained(place, []);
        if (
          !contract.some(
            (item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0,
          ) ||
          retained?.tags.includes("unknown") !== true
        )
          return;
        open += 1;
        assert.equal(labelDomain(walk!, keyOf(place, [])), null, `${mode.name} @${allowance}`);
      });
    }
  // (the source reaches the open answer: the test is not vacuous)
  assert.ok(open > 0);
});

/**
 * A combined stop names a dictionary's value and a derived list's read as the unstopped analysis does (#1595, Codex r1's
 * B3 on #1687): the issue's witnesses, forward, at each stopping demand allowance up to 3, where the demand-only
 * analysis ran out of demand reading the key and spells it `element`: where a settled stop makes the check after it,
 * the stopped analysis owes it under the more precise label (`build.result.entry`, `xs.values[0]`). A check made before
 * the stop keeps the demand-only analysis's own.
 */
test("a combined stop spells a dictionary's value and a derived list's read as the unstopped analysis does (#1595)", () => {
  const witnesses = [
    {
      source:
        'function build: integer dict {return dict {a: hostValue, b: 4}}\nsay "BEFORE"\nrepeat build()["a"] {say "ok"}\nsay "AFTER"\nexit\n',
      precise: "build.result.entry",
    },
    {
      source:
        'let xs: dict = dict {a: hostValue, b: 4}\nsay "BEFORE"\nrepeat xs.values[0] {say "ok"}\nsay "AFTER"\nexit\n',
      precise: "xs.values[0]",
    },
  ];
  const mode = HELD_MODES[0]!;
  for (const { source, precise } of witnesses) {
    const c: HeldCase = { name: precise, source, slice: true, values: [] };
    let spelled = 0;
    for (const demand of heldDemands(c, mode).filter((each) => each <= 3)) {
      const { stoppedAt } = combinedAnalyses([{ path: "main.tease", source }], mode, demand);
      for (const { allowance } of heldStops(c, mode, 1, demand)) {
        const stopped = stoppedAt(allowance);
        if (!stopped.budget.settled) continue;
        const targets = [
          ...stopped.checks,
          ...stopped.budget.deferred.map((mark) => mark.obligation),
        ].map((check) => check.target);
        if (targets.includes(precise)) spelled += 1;
      }
    }
    assert.ok(spelled > 0, precise);
  }
});

// (a level's container: a list, a dictionary, a nullable dictionary, a union of dictionaries)
type Level = "list" | "dict" | "dict?" | "dicts";
const shapes: { readonly levels: readonly Level[]; readonly written?: string }[] = [
  { levels: ["list"] },
  { levels: ["dict"] },
  { levels: ["dict", "dict"] },
  { levels: ["list", "dict"] },
  { levels: ["dict", "list"] },
  { levels: ["dict", "list", "dict"] },
  { levels: ["list", "dict?"], written: "integer dict?[]" },
  { levels: ["list", "dicts"], written: "(integer dict | integer[] dict)[]" },
  { levels: ["list", "dict"], written: "integer dict[]?" },
  { levels: ["list", "dict"], written: "integer dict[] | integer dict set" },
];
const annotation = (levels: readonly Level[]) =>
  [...levels]
    .reverse()
    .reduce((type, level) => (level === "list" ? `${type}[]` : `${type} dict`), "integer");
const roots = [
  {
    name: "xs",
    path: ["xs"],
    own: "xs",
    program: (t: string, v: string, read: string) =>
      `let xs: ${t} = ${v}\nrepeat ${read} {say "a"}\nexit\n`,
  },
  {
    name: "values",
    path: ["values"],
    own: "values",
    program: (t: string, v: string, read: string) =>
      `let values: ${t} = ${v}\nrepeat ${read} {say "a"}\nexit\n`,
  },
  {
    name: "parameter",
    path: ["show", "xs"],
    own: "xs",
    program: (t: string, _: string, read: string) =>
      `function show(xs: ${t}) {repeat ${read} {say "a"}}\nexit\n`,
  },
  {
    name: "result",
    path: ["build", "result"],
    own: "build()",
    program: (t: string, v: string, read: string) =>
      `function build: ${t} {return ${v}}\nrepeat ${read} {say "a"}\nexit\n`,
  },
];
// (a value of the written type: each level's container holding one, `hostValue` at the bottom)
const literal = (levels: readonly Level[]) =>
  [...levels]
    .reverse()
    .reduce(
      (value, level) => (level === "list" ? `[${value}]` : `dict {a: ${value}}`),
      "hostValue",
    );
// (every chain down the levels: at each its element; at a dictionary its `values` then an element, or, last, its
// `keys` then an element; at a list, last, its `values` or `keys`, a property no written type follows, then an
// element; each step with its owner's container, a derived list's `derived`, past a property `unknown`)
type Step = { readonly step: string; readonly owner: Level | "derived" | "unknown" };
const chains = (levels: readonly Level[]): Step[][] => {
  const out: Step[][] = [];
  const down = (at: number, chain: Step[]) => {
    if (chain.length > 0) out.push(chain);
    if (at === levels.length) return;
    const level = levels[at]!;
    down(at + 1, [...chain, { step: "element", owner: level }]);
    if (level === "list") {
      for (const step of ["values", "keys"])
        out.push([...chain, { step, owner: level }, { step: "element", owner: "unknown" }]);
      return;
    }
    down(at + 1, [
      ...chain,
      { step: "values", owner: level },
      { step: "element", owner: "derived" },
    ]);
    if (at === levels.length - 1)
      out.push([...chain, { step: "keys", owner: level }, { step: "element", owner: "derived" }]);
  };
  down(0, []);
  return out;
};
// (the grammar's second reading, from the shape alone: a chain is derived where a `values` or `keys` step has a
// dictionary among its owner's kinds; E where it is not and every `entry` has a dictionary owner, every kind of it;
// E2 where it is, its own text exactly)
const DERIVED_STEPS = new Set(["values", "keys"]);
const hasDict = (owner: Step["owner"]) =>
  owner === "dict" || owner === "dict?" || owner === "dicts";
const expected = (chain: readonly Step[], label: { form: string; entries?: readonly number[] }) => {
  const derived = chain.some(
    ({ step, owner }) => (step === "values" || step === "keys") && hasDict(owner),
  );
  if (label.form === "E")
    return (
      !derived &&
      label.entries!.every(
        (i) =>
          chain[i]!.step === "element" &&
          (chain[i]!.owner === "dict" || chain[i]!.owner === "dicts"),
      )
    );
  return label.form === "E2" && derived;
};
const check = (target: string, site: SourceSite): Obligation => ({
  kind: "integer-check",
  target,
  against: ["integer"],
  on: `check that ${target} is a whole number before the read`,
  site,
  boundary: false,
});

/**
 * The written proof of a combined stop's more precise label, total over the compiler's label grammar (#1595, the lead's
 * ruling after Codex r3 on #1687). `keyLabel` (`consumers/names.ts`) makes every check's target:
 * - a root: a binding's name `N`, a function's parameter `F.P` or result `F.result` (an anonymous start is its own text,
 *   the same in both runs);
 * - each step below: a property's name; a selection, an index or a `get` spelled `element`, or `entry` where every kind
 *   of its owner is a dictionary (`elementStepOf`, whose kinds after a stop `labelDomain` gives); `values` or `keys`;
 * - where a `values` or `keys` step has a dictionary among its owner's kinds (`derivedChain`), the whole target is
 *   instead the value's own text: `N`, `P` or `F(...)`, each element step as written (`[e]`, `get(e)`, `first`, `last`,
 *   `random`).
 * So a stopped check's label is more precise than the demand-only reference's in exactly two productions, each with one
 * clause of the predicate (`provenRelabel`'s (3) recognizes the form, `relabelForm`; its (1) proves it from a written
 * type, `writtenProves`):
 * - E (`"entry"`): the reference's path with some `element` steps spelled `entry`, nothing else changed: each such
 *   step's owner a written dictionary, every kind of it, and no `values` or `keys` step on the way with a dictionary
 *   among its owner's kinds (there the compiler spells E2 instead);
 * - E2 (`"own"`): the value's own text where the reference spells the path, its root and every step as written, at
 *   least one `values` or `keys`: such a step on the way with a dictionary among its owner's written kinds.
 * The family: written types of lists, dictionaries, nullable dictionaries and unions of dictionaries nested up to three
 * deep (list, dict, dict of dicts, list of dicts, dict of lists, dict of lists of dicts, a list of nullable dicts, a
 * list of a union of dicts, an optional and a union container), at a `let`, a parameter and a result, and a root named
 * `values`; every chain down them, a `values` or `keys` step at each level or none (on a list, a property that derives
 * nothing); and for each chain every E label (each subset of its element steps), every step but an element spelled
 * `entry`, its E2 text, and E2 texts that mix in a generic `element` or an `entry` or spell another derived list. Each
 * pair's answer is read a second time from the shape alone, by the grammar (`expected`), never by the predicate's walk,
 * and the two agree on every pair. Codex r1's to r3's written shapes are members (a nested written dict, an optional
 * and a union container, a composed tail, an ordinary list, a nested derived chain).
 *
 * The reading is derived from the grammar above, read off the compiler's `keyLabel`, `elementStepOf` and
 * `derivedChain`, and from the shape's containers alone: an element step's owner is its level's container (a derived
 * list past `values` or `keys`, nothing known past a list's `values` or `keys`, a property), and a level's kinds are its
 * container's (a nullable dictionary's include `null`, a union's every member's). It is wrong where the grammar is: a
 * label form `keyLabel` makes that the grammar lacks, an `elementStepOf` or `derivedChain` rule it states otherwise (every
 * kind against some kind), or a container whose kinds it reads otherwise than `termAt` follows the written type. Its
 * "accept" answers are checked against the compiler itself outside CI: a sample of the family's programs compiled at
 * settled combined stops, every precise label `labelDomain` gives there one the reading accepts (#1687's evidence,
 * `produced.mjs`); its "refuse" answers stand on the grammar alone.
 */
test("a combined stop's more precise label is proved by its written type exactly as the label grammar allows (#1595)", () => {
  const disagree: string[] = [];
  let pairs = 0;
  for (const shape of shapes)
    for (const root of roots) {
      if (root.name === "values" && shape.levels.join() !== "list,dict") continue;
      const written = shape.written ?? annotation(shape.levels);
      for (const chain of chains(shape.levels)) {
        // (the read the chain names, as a source writes it: a dictionary's index `["a"]`, a list's `[0]`; a real
        // program reading it, the checks at its site, its own text the source there)
        const spelled = (i: number, step: string) =>
          step !== "element"
            ? `.${step}`
            : ["dict", "dict?", "dicts"].includes(chain[i]!.owner)
              ? '["a"]'
              : "[0]";
        const read = root.own + chain.map(({ step }, i) => spelled(i, step)).join("");
        const program = root.program(written, literal(shape.levels), read);
        const start = program.indexOf(read);
        const at = { file: 0, start, end: start + read.length };
        const answers = recordedAnalysis([{ path: "main.tease", source: program }]);
        const labels = labelIdentities(answers)!;
        // (the read's place, the one whose path up the compiler's projections is the chain's, its root's place, and the
        // places on the way, its receivers: the identities the compiler's labels of it would carry)
        const generic = chain.map(({ step }) => step);
        const paths = [...Array(labels.places).keys()].flatMap((place) => {
          const path = labels.climb(place);
          return path === null ? [] : [{ place, ...path }];
        });
        const reads = paths.filter(({ steps }) => steps.join(".") === generic.join("."));
        assert.equal(reads.length, 1, `${written} ${root.name}: ${read}`);
        const { place, root: rootPlace } = reads[0]!;
        const receivers = paths.filter(
          ({ root: start, steps }) =>
            start === rootPlace &&
            steps.length > 0 &&
            steps.length < generic.length &&
            steps.every((step, i) => step === generic[i]),
        );
        for (const partial of [false, true]) {
          // (the reference generic, or already spelling `entry` at its first element step a dictionary owns, as a
          // reference that read part of its key settled does)
          const first = chain.findIndex(
            ({ step, owner }) => step === "element" && (owner === "dict" || owner === "dicts"),
          );
          if (partial && first < 0) continue;
          const steps = generic.map((step, i) => (partial && i === first ? "entry" : step));
          const reference: LabelIdentity = { kind: "path", place: rootPlace, steps };
          const labelled: { identity: LabelIdentity; form: string; entries?: readonly number[] }[] =
            [];
          // (E: each subset of the chain's steps spelled `entry`, element steps or not)
          for (let mask = 1; mask < 1 << chain.length; mask += 1) {
            const entries = chain.flatMap((_, i) =>
              (mask >> i) & 1 || (partial && i === first) ? [i] : [],
            );
            labelled.push({
              identity: {
                kind: "path",
                place: rootPlace,
                steps: generic.map((step, i) => (entries.includes(i) ? "entry" : step)),
              },
              form: "E",
              entries,
            });
          }
          // (E2: the read's own text; beside it labels the compiler never makes of it: own text with a step below it,
          // a receiver's own text, the path through another derived list)
          labelled.push({ identity: { kind: "own", place, steps: [] }, form: "E2" });
          labelled.push({ identity: { kind: "own", place, steps: ["element"] }, form: "other" });
          for (const receiver of receivers)
            labelled.push({
              identity: { kind: "own", place: receiver.place, steps: [] },
              form: "other",
            });
          for (const [i, step] of generic.entries())
            if (DERIVED_STEPS.has(step))
              labelled.push({
                identity: {
                  kind: "path",
                  place: rootPlace,
                  steps: generic.map((each, j) =>
                    j === i ? (step === "values" ? "keys" : "values") : each,
                  ),
                },
                form: "other",
              });
          // (each label once, by its first form)
          const seen = new Set([JSON.stringify(reference)]);
          const u = check(`${root.path.join(".")}.${steps.join(".")}`, at);
          for (const label of labelled) {
            const text = JSON.stringify(label.identity);
            if (seen.has(text)) continue;
            seen.add(text);
            pairs += 1;
            const x = check(`label ${pairs}`, at);
            const accepted =
              provenRelabel(
                u,
                [x],
                [],
                answers.graph,
                withLabels(labels, [[u, reference]]),
                withLabels(labels, [[x, label.identity]]),
              ) !== undefined;
            if (accepted !== expected(chain, label))
              disagree.push(
                `${written} ${root.name}: ${u.target} -> ${text} (${label.form}): walk ${accepted}`,
              );
          }
        }
      }
    }
  assert.deepEqual(disagree, []);
  assert.ok(pairs > 1000, `${pairs} pairs`);
});

/**
 * A combined stop's label after a call's result is one of the compiler's two precise forms, never half of each (#1595,
 * #1687): its recipe made wholly after the stop, and an owner's kinds read by one route (`labelKey`), a call's result
 * through an index into it as well. A read through an index into a call's result, then a derived list
 * (`build()["a"].values[0]`), and a derived list's element, then an index (`build().values[0]["a"]`), four modes, each
 * stopping demand allowance up to 3, every settled stop: each check the stopped analysis owes under another label than
 * the demand-only reference's own check there (the same kind, whole site, boundary and expected types) is one of the
 * label grammar's two forms of it, proved by the program's written types (`provenRelabel` with no natural analysis):
 * never an `entry` path through a dictionary's derived list, nor own text with a path step below it.
 */
test("a combined stop's label after a call's result is one precise form, made wholly after the stop (#1595)", () => {
  const sources = [
    'function build: integer dict dict {return dict {a: dict {a: hostValue}}}\nsay "BEFORE"\nrepeat build()["a"].values[0] {say "ok"}\nsay "AFTER"\nexit\n',
    'function build: integer dict dict {return dict {a: dict {a: hostValue}}}\nsay "BEFORE"\nrepeat build().values[0]["a"] {say "ok"}\nsay "AFTER"\nexit\n',
  ];
  const problems: string[] = [];
  let relabelled = 0;
  for (const source of sources)
    for (const mode of HELD_MODES) {
      const c: HeldCase = { name: "a call's result", source, slice: true, values: [] };
      for (const demand of heldDemands(c, mode).filter((each) => each <= 3)) {
        const { reference, stoppedAt } = combinedAnalyses(
          [{ path: "main.tease", source }],
          mode,
          demand,
        );
        for (const { allowance } of heldStops(c, mode, 1, demand)) {
          const stopped = stoppedAt(allowance);
          if (!stopped.budget.settled) continue;
          const owed = [
            ...stopped.checks,
            ...stopped.budget.deferred.map((mark) => mark.obligation),
          ];
          for (const u of reference.checks)
            for (const x of owed) {
              if (
                x.target === u.target ||
                x.kind !== u.kind ||
                JSON.stringify(x.site) !== JSON.stringify(u.site) ||
                x.boundary !== u.boundary ||
                JSON.stringify(x.against) !== JSON.stringify(u.against)
              )
                continue;
              relabelled += 1;
              // (one of the grammar's two forms of `u`, proved by the program's written types alone)
              if (
                provenRelabel(
                  u,
                  [x],
                  [],
                  reference.graph,
                  labelIdentities(reference),
                  labelIdentities(stopped),
                ) === undefined
              )
                problems.push(`${mode.name} @${demand}/${allowance}: ${u.target} -> ${x.target}`);
            }
        }
      }
    }
  assert.deepEqual([...new Set(problems)], []);
  assert.ok(relabelled > 0);
});
