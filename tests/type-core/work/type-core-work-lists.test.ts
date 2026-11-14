// Work that grows with the program over lists: a list's other members (#1573), lists of one set of choices in many
// orders (#1397), runs of joins with their indexed queries and holder bound (#1384), a join with a list that holds
// itself (#2763), and a join whose operand holds lists at every level by its own decision (#2800).

import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, createFreshRuntimeSession } from "../../../src/index.js";
import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import {
  WorkLedger,
  withTestAllowance,
  type WorkCounter,
} from "../../../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import {
  isPlusValue,
  plusIndexVisits,
} from "../../../src/type-inference/core/indexes/plus-index.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import type { PlaceId } from "../../../src/type-inference/graph.js";
import { regressionCase } from "../../helpers/regression-case.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { type WorkFamily } from "../../helpers/type-core/families/builders.js";
import { narrowingPass } from "../../helpers/type-core/type-core-narrowing.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import {
  DOUBLING,
  sized,
  analysed,
  COUNTER_DOUBLING,
  steepCounters,
  many,
} from "../../helpers/type-core/type-core-work.js";

/**
 * #1573 (Codex r2 on #1628): 33 choices of one class, the k-th list leaving out the choices k and 33 - k, whose ids sum
 * alike in every list: a list's other members are found by their sequence (`setNode`), one step per member, never by
 * comparing them with other lists' members, so the contract's steps the fifth list adds are those the ninth adds, in
 * either order (a search among the sets of equal sums added 30 steps more for each list before); and those steps, one
 * per other member, are charged to the analysis as a shared build, never to a demand (`WorkLedger.shared`): the
 * contract steps a further list adds in shared builds are its 30 other members.
 */
test("a list's other members are found in steps of their own, whatever lists came before (#1573)", () => {
  let shared = 0;
  const original = WorkLedger.prototype.charge;
  WorkLedger.prototype.charge = function (this: WorkLedger, counter: WorkCounter, units = 1) {
    if (this.sharing && this.stopped === null && counter === "invSteps") shared += units;
    original.call(this, counter, units);
  };
  const steps = (lists: number, reversed: boolean): readonly [number, number] => {
    const source = [
      many(
        33,
        (j) =>
          `let p${j} = askChoice {text: "0", value: hostValue.p0}, {text: "1", value: hostValue.p1}`,
      ),
      many(lists, (i) => {
        const left = Array.from({ length: 33 }, (_, j) => j).filter(
          (j) => j !== i + 1 && j !== 32 - i,
        );
        return `let xs${i} = [${left.map((j) => `p${j}`).join(", ")}]\nlet v${i}: integer = xs${i}[hostValue.i]`;
      }),
      "exit",
    ].join("\n");
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, source);
    const run = (): Answers => analyseCore(request);
    const answers = reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, run),
        )
      : run();
    return [answers.budget.counts.get("invSteps") ?? 0, shared] as const;
  };
  try {
    for (const reversed of [false, true]) {
      const [fifth, ninth] = [4, 8].map((before) => {
        shared = 0;
        const [steps0, shared0] = steps(before, reversed);
        shared = 0;
        const [steps1, shared1] = steps(before + 1, reversed);
        return [steps1 - steps0, shared1 - shared0] as const;
      });
      assert.deepEqual(ninth, fifth, `reversed: ${reversed}`);
      assert.equal(fifth![1], 30, `reversed: ${reversed}: the lookup's shared steps`);
    }
  } finally {
    WorkLedger.prototype.charge = original;
  }
});

/**
 * The holder cache's witness: k variables holding `q` joined in another run, then a run of k variables lacking it and
 * one holding it with k properties below it, asked at each of them, so each question looks for the bindings holding
 * `q` among many.
 */
const underOne = (k: number): string =>
  [
    many(k, (i) => `let h${i} = [{q: 1, t${i}: 1}]`),
    `let ys = ${many(k, (i) => `h${i}`, " + ")}`,
    "say ys[0].t0\nsay ys[1].t1\nsay ys[2].t2",
    many(k, (i) => `let l${i} = [{u${i}: 1}]`),
    `let c = [{q: {${many(k, (i) => `x${i}: 1`, ", ")}}}]`,
    `let xs = ${many(k, (i) => `l${i}`, " + ")} + c`,
    "say xs[0].u0\nsay xs[1].u1",
    many(k, (i) => `say xs[${k}].q.x${i}`),
    "exit",
  ].join("\n");

/** Codex r2 on #1562: k variables of one property each, joined once each, each element read at its own property. */
const sparse = (k: number): string =>
  `${many(k, (i) => `let o${i} = [{p${i}: 1}]`)}\nlet xs = ${many(k, (i) => `o${i}`, " + ")}\n${many(k, (i) => `say xs[${i}].p${i}`)}\nexit`;

/**
 * #1384: k joins of lists of objects of distinct properties, a variable of objects read beside each operand, along the
 * left operands and each join in the next one's right, and both with one property throughout: a run's terms are indexed
 * by the properties they hold once its root is asked at a third (`plusRun`), so the value side, the contract side and
 * admission's decider read each property's holders and the ranges between them, never every join below (3.1 to 3.3 at
 * 16 → 32 before, its counters near 4; 3.7 at 64 → 128). And a variable of k properties joined k times, alone and
 * beside k objects of distinct properties (Codex r1 on #1562: its properties posted at every read measured 3.9 at
 * 256 → 512): its reads are one binding's, its properties never posted per read; and k variables of one property each
 * joined once, each element read at its own (Codex r2: every query visited every binding, k(2k − 4) uncharged visits):
 * a query visits the bindings holding its property and one more (the holder bound). One doubling in the four modes; the
 * series to k = 512 is the evidence, outside CI. Each source at the smaller size compiles and runs, saying its list's length
 * or its first element's three properties.
 */
test("a run of joins read beside a variable of objects grows with the program in the four modes (#1384)", () => {
  const joins = (k: number, term: (i: number) => string, o = "{q: 1}"): string =>
    `let o = [${o}]\nlet xs = o + ${many(k, (i) => `${term(i)} + o`, " + ")}\nsay xs.length\nexit`;
  const nested = (k: number, term: (i: number) => string, last: string): string =>
    `let o = [{q: 1}]\nlet xs = ${Array.from({ length: k }).reduce<string>((e, _, i) => `${term(i)} + (o + (${e}))`, last)}\nsay xs.length\nexit`;
  const wide = (k: number): string => `{${many(k, (i) => `p${i}: 1`, ", ")}}`;
  const family = (
    name: string,
    sizes: readonly [number, number],
    said: (k: number) => readonly string[],
    source: (k: number) => string,
  ) => ({
    name: `plus-run-${name}`,
    measures: "#1384: a run's terms by the properties they hold",
    program: (k: number) => [{ path: "main.tease", source: source(k) }],
    sizes,
    said,
  });
  const runs = [
    family(
      "left",
      [16, 32],
      (k) => [String(2 * k + 1)],
      (k) => joins(k, (i) => `[{p${i}: 1}]`),
    ),
    family(
      "right",
      [16, 32],
      (k) => [String(2 * k + 1)],
      (k) => nested(k, (i) => `[{p${i}: 1}]`, "[{lastValue: 0}]"),
    ),
    family(
      "left-one-name",
      [16, 32],
      (k) => [String(2 * k + 1)],
      (k) => joins(k, () => "[{q: 1}]"),
    ),
    family(
      "right-one-name",
      [16, 32],
      (k) => [String(2 * k + 1)],
      (k) => nested(k, () => "[{q: 1}]", "[{q: 0}]"),
    ),
    family(
      "wide-reuse",
      [64, 128],
      () => ["1", "1", "1"],
      (k) =>
        `let o = [${wide(k)}]\nlet xs = ${many(k, () => "o", " + ")}\nsay xs.first.p0\nsay xs.first.p1\nsay xs.first.p2\nexit`,
    ),
    family(
      "wide-beside",
      [64, 128],
      (k) => [String(2 * k + 1)],
      (k) => joins(k, (i) => `[{x${i}: 1}]`, wide(k)),
    ),
    family("sparse-bindings", [64, 128], (k) => Array.from({ length: k }, () => "1"), sparse),
  ];
  for (const { name, program, sizes, said } of runs) {
    const compiled = compileProject(program(sizes[0]));
    assert.ok(compiled.plan !== null, `${name} at ${sizes[0]} compiles`);
    const events = createFreshRuntimeSession(compiled.plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    }).run().events;
    assert.deepEqual(
      events.flatMap((event) =>
        event.kind === "say" || event.kind === "runtimeFailure"
          ? [event.kind === "say" ? event.text : event.code]
          : [],
      ),
      said(sizes[0]),
      `${name} at ${sizes[0]} runs`,
    );
  }
  assert.deepEqual(
    runs.flatMap((run) => [
      ...steepCounters([run], false, undefined, run.sizes),
      ...steepCounters([run], true, undefined, run.sizes),
    ]),
    [],
  );
});

/**
 * The holder bound (#1384, Codex r2 on #1562): an indexed run's query takes one step per literal and per binding holding
 * its property and per item of their answers and one more in each order of its bindings, each charged before it runs. The index counts its query
 * steps (`plusIndexVisits`): on k variables of one property each, joined once and each read at its own, the steps stay
 * under the charged `indexSteps` and grow with the program in either order, the sharing on and off; visiting every
 * binding per query made 32,256 steps at k = 128, none charged. A run asked at k paths below one property that k
 * bindings elsewhere hold looks for its holders once, not at every question.
 */
test("an indexed run's queries take charged steps bounded by the bindings holding their properties (#1384)", () => {
  const steep: string[] = [];
  // (the bindings holding `q` found once per run and property: asked again they took k² steps; in the source order,
  // where the run's root is indexed before its questions below `q`)
  for (const [shape, sizes, modes] of [
    [
      sparse,
      [64, 128],
      [
        [false, false],
        [true, true],
      ],
    ],
    [underOne, [32, 64], [[false, false]]],
  ] as const)
    for (const [reversed, unshared] of modes) {
      const [small, large] = sizes.map((k) => {
        const before = plusIndexVisits();
        const program = () => [{ path: "main.tease", source: shape(k) }];
        const { budget } = analysed(
          sized({ name: shape.name, measures: "", program }, k),
          reversed,
          unshared,
        );
        return {
          visits: plusIndexVisits() - before,
          charged: budget.counts.get("indexSteps") ?? 0,
          nodes: budget.counts.get("syntaxNodes") ?? 0,
        };
      });
      const name = `${shape.name}, ${reversed ? "reversed" : "source order"}${unshared ? ", unshared" : ""}`;
      assert.ok(large!.visits > 0, `${name}: the run is indexed`);
      assert.ok(
        large!.visits <= large!.charged,
        `${name}: ${large!.visits} steps, ${large!.charged} charged`,
      );
      const doubling = (2 * (large!.visits / small!.visits)) / (large!.nodes / small!.nodes);
      if (doubling > DOUBLING) steep.push(`${name}: ${doubling.toFixed(3)}`);
    }
  assert.deepEqual(steep, []);
});

/**
 * The holder bound's whole query (#1384, Codex r3 on #1562): an indexed root asked at a new path below a property whose
 * holders its run already found charges `indexSteps` for exactly the steps it counts, on both sides: with no term holding
 * the property the same few at every width (a range's earliest object is its first literal's, not a tree's height), and
 * with every term holding it one per term and per item, linear (its holders kept in first-read order, never sorted per
 * query: k variables read in another order than the pass found them sorted them at every query, k log k uncounted).
 */
test("an indexed run's warm query charges its counted steps alone, a few without holders, linear in them (#1384)", () => {
  const shuffled = (k: number): string =>
    Array.from({ length: k }, (_, i) => `b${(i * 37 + 11) % k}`).join(" + ");
  const shapes: readonly (readonly [string, string, readonly number[], (k: number) => string])[] = [
    [
      "no holder",
      "c",
      [16, 64, 256],
      (k) =>
        `${many(k, (i) => `let o${i} = [{p${i}: 1}]`)}\nlet xs = ${many(k, (i) => (i % 2 ? `o${i}` : `[{s${i}: 1}]`), " + ")}\nsay xs.length\nexit`,
    ],
    [
      "holding variables",
      "q",
      [16, 64],
      (k) =>
        `${many(k, (i) => `let b${i} = [{q: {p${i}: 1}}]`)}\nlet ys = ${many(k, (i) => `b${i}`, " + ")}\nlet xs = ${shuffled(k)}\nsay ys.length\nsay xs.length\nexit`,
    ],
    [
      "holding literals",
      "q",
      [16, 64],
      (k) => `let xs = ${many(k, (i) => `[{q: {p${i}: 1}}]`, " + ")}\nsay xs.length\nexit`,
    ],
  ];
  const failing: string[] = [];
  for (const [name, step, sizes, source] of shapes) {
    const steps = sizes.map((k) => {
      const request = coreRequest([{ path: "main.tease", source: source(k) }]);
      assert.ok(request !== null, `${name} at ${k}: its files parse and resolve`);
      const pass = narrowingPass(request);
      const { program } = pass;
      const ask = (value: PlaceId, path: readonly string[], exact: boolean) => {
        const c = program.opOf.get(value)!;
        const node = c.kind === "operation" ? program.exprAt(c.site) : null;
        pass.solver.run(
          exact
            ? pass.values.valueItems(value, node, path)
            : pass.contract.contractOfValueAt(value, path),
        );
      };
      const roots = [...program.opOf.values()].flatMap((c) =>
        c.kind === "operation" &&
        isPlusValue(pass, c.result) &&
        !(program.consumersOf.get(c.result) ?? []).some(
          (use) => use.kind === "operand" && isPlusValue(pass, use.operation.result),
        )
          ? [c.result]
          : [],
      );
      // (each root indexed and its holders of the property found; the last asked at a new path below it)
      for (const exact of [true, false])
        for (const root of roots)
          for (const first of ["t", "u", "v", step]) ask(root, ["element", first, "warm"], exact);
      return [true, false].map((exact) => {
        const charged = () => program.work.counts().get("indexSteps") ?? 0;
        const [visits, units] = [plusIndexVisits(), charged()];
        ask(roots.at(-1)!, ["element", step, "fresh"], exact);
        const counted = plusIndexVisits() - visits;
        if (counted === 0 || charged() - units !== counted)
          failing.push(
            `${name} at ${k}, ${exact ? "value" : "contract"}: ${counted} steps, ${charged() - units} charged`,
          );
        return counted;
      });
    });
    for (const side of [0, 1]) {
      const [small, ...larger] = steps.map((counted) => counted[side]!);
      for (const [index, counted] of larger.entries())
        if (
          name === "no holder"
            ? counted !== small
            : counted > (small! * sizes[index + 1]!) / sizes[0]!
        )
          failing.push(
            `${name} at ${sizes[index + 1]}, side ${side}: ${counted} steps, ${small} at ${sizes[0]}`,
          );
    }
  }
  assert.deepEqual(failing, []);
});

/**
 * #1397: k/8 choices of k host reads each, read in k lists, each list the choices in a shuffled order of its own
 * (#1359's B1 family, `leaf-permuted` in
 * `tests/families/joins/peer-orders-and-leaves/peer-set-orders-and-subset-windows.mjs`). Each list's item unites its
 * elements in its own order, a node of its own, and C1's site walked each such node's leaves though no list's store
 * lands any or brings an ingress at a siting: k orders × k²/8 leaves. With the sharing off the total and each counter
 * grow with the program in either order; with it on only `checks` is gated, since the sharing's union nodes and the
 * contract's class parts grow faster than the program in the fixed order too (#1573). At 20 → 40, the smallest pair
 * that shows the walk (18 → 36 does not), the walk grew `checks` ×2.97 per doubling in every mode. The series to k =
 * 128, the four modes, the subsets and the other orders are the step's evidence, outside CI; a store that reads the
 * leaves it walks is #1579.
 */
test("lists of one set of choices in many orders site their host data without walking each order (#1397)", () => {
  const shuffled = (m: number, seed: number): number[] => {
    const order = Array.from({ length: m }, (_, j) => j);
    let state = (seed * 2654435761 + 12345) >>> 0;
    for (let j = m - 1; j > 0; j -= 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      const at = state % (j + 1);
      [order[j], order[at]] = [order[at]!, order[j]!];
    }
    return order;
  };
  const family: WorkFamily = {
    name: "choice lists in shuffled orders",
    measures:
      "k lists of k/8 choices of k host reads, each list in its own order: C1's site per list",
    program: (k) => {
      const m = Math.max(2, Math.floor(k / 8));
      const rows = (n: number, row: (i: number) => string, separator = "\n") =>
        Array.from({ length: n }, (_, i) => row(i)).join(separator);
      const choice = `askChoice ${rows(k, (r) => `{text: "${r}", value: hostValue.p${r}}`, ", ")}`;
      const source = [
        rows(m, (j) => `let p${j} = ${choice}`),
        rows(k, (i) => {
          const list = shuffled(m, i).map((j) => `p${j}`);
          return `let xs${i} = [${list.join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`;
        }),
        "exit",
      ].join("\n");
      return [{ path: "main.tease", source }];
    },
  };
  const steep = steepCounters([family], true, undefined, [20, 40]);
  for (const reversed of [false, true]) {
    const [small, large] = [20, 40].map((k) => analysed(sized(family, k), reversed).budget.counts);
    const scale = large!.get("syntaxNodes")! / small!.get("syntaxNodes")!;
    const doubling = (2 * (large!.get("checks")! / small!.get("checks")!)) / scale;
    if (doubling > COUNTER_DOUBLING)
      steep.push(`${family.name}${reversed ? " reversed" : ""} checks: ${doubling.toFixed(3)}`);
  }
  assert.deepEqual(steep, []);
});

/**
 * #2763: a list joined with a list that holds it grows a level each turn of its cycle; the nesting cut (#2764) knows it one
 * level deeper than what enters the cycle and leaves it unknown below, so the join check's descent ends and the join is
 * accepted, far below an allowance the base's descent ran out of (125 levels at 300,000 units). Each shape is one way a
 * list comes to hold itself through a join.
 */
regressionCase(
  "a join with a list that holds itself ends far below the allowance, accepted (#2763)",
  { pr: 2794, atBase: /self-holding join .*: the join check ends below the allowance/ },
  () => {
    const shapes: Record<string, string> = {
      once: "let a = [[]]\na = a + [a]\nexit\n",
      "in a loop": "let a = []\nrepeat 3 {\n  a = a + [a]\n}\nexit\n",
      compound: "let a = [[]]\na += [a]\nexit\n",
      "on the left": "let a = [[]]\na = [a] + a\nexit\n",
      "nested in a loop, then joined":
        "let a = []\nrepeat 3 {\n  a = [a]\n}\nlet b = a + a\nexit\n",
      "through a parameter":
        "function f(d) {\n  return d\n}\nlet a = [f([])]\na = a + [f(a)]\nexit\n",
    };
    for (const [shape, source] of Object.entries(shapes)) {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, `${shape}: parses and resolves`);
      const answers = withTestAllowance(300_000, () => analyseCore(request));
      assert.equal(
        answers.budget.exhausted,
        null,
        `self-holding join ${shape}: the join check ends below the allowance`,
      );
      assert.ok(answers.work.total < 30_000, `${shape}: ${answers.work.total} units`);
      assert.deepEqual(
        answers.diagnostics.map((d) => d.code),
        [],
        `${shape}: the join is accepted`,
      );
    }
  },
);

/**
 * #2800: a `+` over the result of a loader that fills a written `list` or `dict` with its own result settles far below
 * the allowance in every mode, also where the function that holds the `+` is never called.
 */
regressionCase(
  "a join whose operand holds lists at every level by its own decision ends far below the allowance (#2800)",
  {
    pr: 2813,
    atBase:
      /a join over a recursive loader's levels: the level loop ends below the allowance in .+/,
  },
  () => {
    const source =
      "function loadValue(key, fallback = null) {\n  let value = load key, default: null\n" +
      "  if value == null {\n    let names: string[] = []\n    let numbered = true\n" +
      "    if names.length > 0 and numbered {\n      let items: list = []\n      value = items\n" +
      "    } else if names.length > 0 {\n      let entries: dict = dict{}\n      for name in names {\n" +
      '        entries[name] = loadValue("${key}.${name}")\n      }\n      value = entries\n    }\n  }\n' +
      "  return value otherwise fallback\n}\n" +
      'function getProp(name, f, d = null) {\n  let v = loadValue("p.${name}")\n  return v otherwise d\n}\n' +
      "function setProp(name, v) {\n}\n" +
      'function bump(name, amount = 1) {\n  setProp(name, getProp(name, "int", 0) + amount)\n}\nexit\n';
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    for (const mode of MODES)
      inMode(mode, () => {
        const answers = withTestAllowance(300_000, () => analyseCore(request));
        assert.equal(
          answers.budget.exhausted,
          null,
          `a join over a recursive loader's levels: the level loop ends below the allowance in ${JSON.stringify(mode)}`,
        );
        assert.ok(answers.work.total < 30_000, `${answers.work.total} units`);
      });
  },
);
