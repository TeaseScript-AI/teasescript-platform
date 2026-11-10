// The coarse core's work as a sampled regression oracle (`tests/helpers/type-core/type-core-work.ts`), one of three files that
// CI runs side by side.
import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestDemandAllowance, type WorkCounter } from "../../src/type-inference/core/budget.js";
import { CoreProgram, propertyStep } from "../../src/type-inference/core/program.js";
import { coreRequest, type SourceFile } from "../helpers/type-core-analysis.js";
import { ADMISSION_FAMILIES } from "../helpers/type-core/families/admission.js";
import {
  ADMISSION_INGRESS_PRESETS,
  ADMISSION_KNOWN_PRODUCTS,
  ADMISSION_SAME_SOURCES,
  VALUE_CLASS_SITES,
} from "../helpers/type-core/families/admission-products.js";
import { DECISION_HOLDER_FAMILIES } from "../helpers/type-core/families/copy-chains.js";
import { LAYER_FAMILIES } from "../helpers/type-core/families/property-names.js";
import {
  NARROWING_FAMILIES,
  ROUTE_FEASIBILITY_FAMILIES,
} from "../helpers/type-core/families/narrowing.js";
import { type WorkFamily } from "../helpers/type-core/families/builders.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { narrowingPass } from "../helpers/type-core/type-core-narrowing.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";
import {
  DOUBLING,
  type Sized,
  sized,
  analysed,
  COUNTER_DOUBLING,
  type Measured,
  steepCounters,
  many,
} from "../helpers/type-core/type-core-work.js";

/**
 * #1573: two choices of k reads of one host global's properties, one class mixed by their leaves, read in k lists in
 * both orders: each list's contract reads one choice and names the other's leaves (`othersLeaves`) from one walk of
 * each choice's options and one check of the read choice's answer, where `main` walked and checked them again for
 * each list (2.52 total, 3.40 `invSteps` at k = 64 → 128). With the sharing on, in either order.
 */
test("two choices read in k lists grow with the program in either order, each counter too (#1573)", () => {
  const family: WorkFamily = {
    name: "choices-read-in-lists",
    measures:
      "#1573: each choice's leaves walked and its answer checked once, whichever list reads it",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          many(
            2,
            (j) =>
              `let p${j} = askChoice ${many(k, (r) => `{text: "${r}", value: hostValue.p${r}}`, ", ")}`,
          ),
          many(
            k,
            (i) =>
              `let xs${i} = [${i % 2 === 0 ? "p0, p1" : "p1, p0"}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
          ),
          "exit",
        ].join("\n"),
      },
    ],
  };
  assert.deepEqual(steepCounters([family]), []);
});

/**
 * #1466: a stack of k diamonds of copies, its siblings, wide and nested joins and chains of listing layers read at
 * sparse paths (`LAYER_FAMILIES`), each read answered once per layer and path from the layers below it that hold its
 * property, at one small doubling, in either order and with the sharing off too: the total and the contract's own
 * counter (`invSteps`), which `main` grew as k³ on the diamonds (7.85 per doubling from 16 to 32); where `main` grows
 * faster than the bound on a family's shape, at or under `main`'s growth (`WorkFamily.main`). The
 * support's other counters carry its log factor, which reads above the counters' bound at these sizes. The series to
 * k = 64 in four modes is the PR's evidence, outside CI.
 */
test("a stack of diamonds of copies and its siblings grow with the program in either order (#1466)", () => {
  for (const unshared of [false, true]) {
    const measure = (at: Sized, reversed: boolean): Measured => {
      const { total, counts } = analysed(at, reversed, unshared).budget;
      const kept = ["syntaxNodes", "invSteps"] as const;
      return { total, counts: new Map(kept.map((counter) => [counter, counts.get(counter) ?? 0])) };
    };
    assert.deepEqual(steepCounters(LAYER_FAMILIES, unshared, measure, [16, 32]), []);
  }
});

/**
 * #1466, the READY replay's `graph/224` and `graph/533` (a mutual feedback whose candidate route asks one `q` deeper per
 * question), the deep read they showed and Astra r1's alternating feedback (`a.next.back.next…`):
 * a read `depth` properties down, one holder answering it, asks that holder's source by reference at the caller's own
 * path (`singleSource`), never a layer's summary rebuilt from the path's record, makes no path id (only a summary's
 * demand needs one), and walks its path's steps once, its prefixes' texts never kept. At depths 16 and 32 in the four
 * modes, against `main`'s work there (measured on 7d6c4d3d4: a regression oracle of these shapes): no layer demand; the
 * total, `invSteps` and `checks` at or under `main`'s, `main`'s lead on the total not shrinking, and the literal work's
 * growth at or under `main`'s (kept texts made it a power of the depth steeper; a path id made for every read put the
 * alternating read 2D + 9 units above `main`). At depths 2 to 4 the head's excess over `main` is at most the reference's
 * fixed setup (6, 9 and 1 units on the deep read, 6, 10 and 2 on the alternating one), from 5 none.
 */
test("a deep read asks its one holder's source by reference and walks its path's steps once (#1466)", () => {
  const shapes = [
    {
      name: "a read",
      source: (depth: number): string =>
        [
          "let a={left:1,q:null}",
          "let b={right:2,q:null}",
          "a.q=b",
          "b.q=a",
          `let read=a${".q".repeat(depth)}`,
          "say read",
          "exit",
        ].join("\n"),
      // (`main`'s work at depths 16 and 32, and its totals at 2 to 7, the sharing on and off, equal in either order)
      shared: {
        total: [8855, 23083],
        invSteps: [2103, 7187],
        checks: [260, 356],
        literalUnits: [1974, 6030],
        small: [2410, 2712, 3037, 3385, 3758, 4155],
      },
      unshared: {
        total: [7451, 18875],
        invSteps: [2184, 7364],
        checks: [260, 356],
        literalUnits: [562, 1782],
        small: [2193, 2453, 2727, 3018, 3328, 3656],
      },
      setup: [6, 9, 1, 0, 0, 0],
    },
    {
      name: "an alternating read",
      source: (depth: number): string =>
        [
          "let a={left:1,next:null}",
          "let b={right:2,back:null}",
          "a.next=b",
          "b.back=a",
          `let read=a${Array.from({ length: depth }, (_, index) => (index % 2 ? ".back" : ".next")).join("")}`,
          "say read",
          "exit",
        ].join("\n"),
      shared: {
        total: [10239, 29677],
        invSteps: [2427, 8601],
        checks: [260, 356],
        literalUnits: [3053, 11245],
        small: [2420, 2726, 3061, 3424, 3819, 4263],
      },
      unshared: {
        total: [8647, 24711],
        invSteps: [2508, 8778],
        checks: [260, 356],
        literalUnits: [1453, 6239],
        small: [2200, 2460, 2739, 3039, 3364, 3729],
      },
      setup: [6, 10, 2, 0, 0, 0],
    },
  ];
  type Counter = "total" | "invSteps" | "checks" | "literalUnits";
  const modes = [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const;
  for (const shape of shapes)
    modes.forEach(([reversed, unshared], mode) => {
      const at = (depth: number) => {
        const request = coreRequest([{ path: "main.tease", source: shape.source(depth) }]);
        assert.ok(request !== null, `${shape.name} ${depth} deep: its files parse and resolve`);
        const { budget } = analysed(
          { name: `${shape.name} ${depth} deep`, request },
          reversed,
          unshared,
        );
        const counts: Record<Counter, number> = {
          total: budget.total,
          invSteps: budget.counts.get("invSteps") ?? 0,
          checks: budget.counts.get("checks") ?? 0,
          literalUnits: budget.counts.get("literalUnits") ?? 0,
        };
        return {
          counts,
          demands: budget.facts.layerDemands,
          nodes: budget.counts.get("syntaxNodes") ?? 1,
        };
      };
      const ours = unshared ? shape.unshared : shape.shared;
      const sizes = [at(16), at(32)];
      sizes.forEach((size, index) => {
        const name = `${shape.name}, mode ${mode}, ${16 << index} deep`;
        assert.equal(size.demands, 0, `${name}: no layer demand`);
        for (const counter of ["total", "invSteps", "checks"] as const)
          assert.ok(
            size.counts[counter] <= ours[counter][index]!,
            `${name}: ${counter} ${size.counts[counter]} against main's ${ours[counter][index]}`,
          );
      });
      const lead = (index: number): number => ours.total[index]! - sizes[index]!.counts.total;
      assert.ok(
        lead(1) >= lead(0),
        `${shape.name}, mode ${mode}: main's lead ${lead(0)} then ${lead(1)}`,
      );
      const scale = sizes[1]!.nodes / sizes[0]!.nodes;
      const growth = (2 * sizes[1]!.counts.literalUnits) / sizes[0]!.counts.literalUnits / scale;
      const mains = (2 * ours.literalUnits[1]!) / ours.literalUnits[0]! / scale;
      assert.ok(
        growth <= mains,
        `${shape.name}, mode ${mode}: literalUnits ${growth.toFixed(4)} against main's ${mains.toFixed(4)}`,
      );
      shape.setup.forEach((setup, index) => {
        const excess = at(index + 2).counts.total - ours.small[index]!;
        assert.ok(
          excess <= setup,
          `${shape.name}, mode ${mode}, ${index + 2} deep: ${excess} over main's`,
        );
      });
    });
});

/**
 * #1466, Codex r4's positive hits: k joined layers, each listing a step of its own, read at each, one doubling later, where
 * a read finding its layer by visiting each joined layer grows past the bound (2.40 against the selection's 2.02,
 * `invSteps`): a read finds the one layer listing its step by the place's per-step map, its descent the map's depth.
 */
test("a read finds the joined layer listing its step by the place's map (#1466)", () => {
  const family = LAYER_FAMILIES.find((each) => each.name === "distinct-steps")!;
  for (const unshared of [false, true]) {
    const measure = (at: Sized, reversed: boolean): Measured => {
      const { total, counts } = analysed(at, reversed, unshared).budget;
      return {
        total,
        counts: new Map([
          ["syntaxNodes", counts.get("syntaxNodes") ?? 0],
          ["invSteps", counts.get("invSteps") ?? 0],
        ]),
      };
    };
    assert.deepEqual(steepCounters([family], unshared, measure, [32, 64]), []);
  }
});

/**
 * #1466, Codex r2's sibling and its shared shape: a read below nested joins, or below joined copies over a record listing
 * the same step, asks only the layer holding its property, never a joining layer or a copy it passes through. Below
 * nested joins that layer's one source answers the read by reference, so no summary's demand is made;
 * over the shared record a listing layer lies below the step, so each property's holder makes its summary's demand, one
 * per property: k, at each size and in either order (a regression oracle of the selection, where a
 * joining layer asked too would make the read's summaries' demands).
 */
test("a read below nested or shared joins asks only the layers holding its path (#1466)", () => {
  const families = LAYER_FAMILIES.filter(
    (each) => each.name.startsWith("nested-join") || each.name === "shared-join",
  );
  for (const family of families)
    for (const k of [8, 16, 32, 64])
      for (const reversed of [false, true])
        assert.equal(
          analysed(sized(family, k), reversed).budget.facts.layerDemands,
          family.name === "shared-join" ? k : 0,
          `${family.name} at ${k}${reversed ? " reversed" : ""}`,
        );
});

/**
 * N5's families through the analysis (S10 part 2b): a read in a stored value takes its narrowing, so the stores' own
 * preserving tests run as the analysis asks them, components included; the same gate.
 */
test("stage 3b's N5 families grow with the program through the analysis too, in either order (§13.3)", () => {
  assert.deepEqual(
    steepCounters(NARROWING_FAMILIES.filter((family) => family.name.startsWith("W29"))),
    [],
  );
});

/**
 * The route rule's narrowed default (#1938): in a program holding an arm no run enters, every use's route query passes
 * one feasibility layer and its chains' arms; the same gate, in either order. The series to k = 1,024 is the step's
 * evidence, outside CI.
 */
test("the route rule's queries beside arms no run enters grow with the program in either order (#1938)", () => {
  assert.deepEqual(steepCounters(ROUTE_FEASIBILITY_FAMILIES), []);
});

/**
 * #1438: a decider group's region holds each path below the group as a node one step below its parent's, never an
 * array or a text, so the decision of a literal nested k deep grows with k: the largest decision's units per doubling
 * of the source, for a literal of two kinds in either order and for one copying a written union in the source order
 * (2.01 and 2.06 here). Reversed, that one's decision costs depth × copies, G6 in #1319's design-round list (about 3.6,
 * as before G3 2c). A region that made each level's path and its text measured 4.42 and 4.45, and stopped both shapes'
 * decisions at their allowance at 300 levels.
 */
test("a deep literal's decision grows with its depth, never with its square (#1438)", () => {
  const nest = (k: number, leaf: string): string => `${"[".repeat(k)}${leaf}${"]".repeat(k)}`;
  const shapes: readonly (readonly [string, (k: number) => string, readonly boolean[]])[] = [
    ["of two kinds", (k) => `let xs = [${nest(k, "1")}, ${nest(k, '"bad"')}]`, [false, true]],
    [
      "copying a written union",
      (k) => `let typed: integer | string = 1\nlet xs = [${nest(k, "typed")}, ${nest(k, '"ok"')}]`,
      [false],
    ],
  ];
  const largest = (budget: Answers["budget"]): number =>
    Math.max(...budget.decisions.map((decision) => decision.units));
  const steep: string[] = [];
  for (const [name, source, orders] of shapes) {
    const [at64, at128] = [64, 128].map((k): Sized => {
      const request = coreRequest([{ path: "main.tease", source: `${source(k)}\nexit` }]);
      assert.ok(request !== null, `${name} at ${k}: its file parses and resolves`);
      return { name: `${name} at ${k}`, request };
    });
    for (const reversed of orders) {
      const [small, large] = [at64!, at128!].map((at) => analysed(at, reversed).budget);
      const scale =
        (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
      const doubling = (2 * (largest(large!) / largest(small!))) / scale;
      if (doubling > DOUBLING)
        steep.push(`${name}${reversed ? " reversed" : ""}: ${doubling.toFixed(3)}`);
    }
  }
  assert.deepEqual(steep, []);
});

/**
 * Admission (the port plan's §3.3): its decisions, rejections, candidates and boundary checks, gated as W34 is; A6's
 * chain of dependent rejections, which takes a pass per link (§8's passes × stores, each pass charged), is a gated
 * known limit by the owner's decision (docs/specifications/type-inference-accepted-record/admission.md#r4-49, option
 * A): a regression check on the 64 → 128 step only, at its measured doubling, not a bound at larger sizes; a change to
 * admission's passes re-measures and proposes the gate with its counts, never retunes it. Copies interleaved with
 * conditional stores below their path (S6-CARRIERS §4.7, condition (b)) are gated in the same form, a known limit by
 * the owner's decision too, and so are copies separated by calls storing their source.
 */
test("every admission family's work and each of its counters grow with the program in either order", () => {
  assert.deepEqual(steepCounters(ADMISSION_FAMILIES), []);
  const steep: string[] = [];
  for (const family of ADMISSION_KNOWN_PRODUCTS) {
    const [at64, at128] = [sized(family, 64), sized(family, 128)];
    for (const reversed of [false, true]) {
      const small = analysed(at64, reversed).budget;
      const large = analysed(at128, reversed).budget;
      const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
      const doubling = (2 * (large.total / small.total)) / scale;
      if (doubling > family.measured)
        steep.push(`${family.name}${reversed ? " reversed" : ""}: ${doubling.toFixed(3)}`);
    }
  }
  assert.deepEqual(steep, []);
});

/**
 * #1444(b,c): the same nests with a written union at the property, its copy in the level inside (`[x, {p: typed}][0]`),
 * directly and through a copy of the written binding: each literal's elements asked their earliest decider outside
 * every decision are answered from the groups' summaries, each level once (`writtenDecider`), not each level's walk of
 * the nest inside it again (`checks` 4.11 to 4.29 per doubling before). With the leaf an object of another type, each
 * level's list mixes the property's types and each rejection shows only in the next pass, k passes (A6's chain, gated
 * as its own known limit): each pass's work grows with the program (2.69 per doubling before at k = 32 → 64). The
 * series to k = 128 in the four modes and the siblings are the step's evidence, outside CI.
 */
const WRITTEN_NESTS: readonly WorkFamily[] = (
  [
    ["a written union", "", "{p: typed}"],
    ["a copy of a written union", "let copied = typed\n", "{p: copied}"],
    ["a written option of another type", "", '{p: "origin"}'],
  ] as const
).map(([shape, setup, leaf]) => ({
  name: `written nest ${shape}`,
  measures: `#1444: k selections of objects nested, ${shape} at the property`,
  program: (k: number) => {
    const other = setup === "" ? "{p: typed}" : "{p: copied}";
    let value: string = leaf;
    for (let i = 0; i < k; i += 1) value = `[${value}, ${other}][0]`;
    const source = `let typed: integer | string = 1\n${setup}let out = ${value}\nsay "\${out.p}"\nexit\n`;
    return [{ path: "main.tease", source }];
  },
}));

test("a written decider in nested selections is answered once per level, each pass in proportion (#1444)", () => {
  const steep: string[] = [];
  for (const family of WRITTEN_NESTS) {
    // (the option's k passes, A6's, are its known limit: the work of each pass is gated)
    const passes = family.name.includes("option");
    const [small, large] = (passes ? [16, 32] : [32, 64]).map((k) => sized(family, k));
    for (const reversed of [false, true]) {
      const [a, b] = [small!, large!].map((at) => analysed(at, reversed).budget);
      const scale = (b!.counts.get("syntaxNodes") ?? 0) / (a!.counts.get("syntaxNodes") ?? 1);
      const per = (budget: typeof a, units: number): number =>
        passes ? units / ((budget!.counts.get("rejectPasses") ?? 0) + 1) : units;
      const doubling = (before: number, after: number): number =>
        (2 * (per(b, after) / Math.max(1, per(a, before)))) / scale;
      const name = `${family.name}${reversed ? " reversed" : ""}`;
      if (doubling(a!.total, b!.total) > DOUBLING)
        steep.push(`${name}: ${doubling(a!.total, b!.total).toFixed(3)}`);
      const checks = doubling(a!.counts.get("checks") ?? 0, b!.counts.get("checks") ?? 0);
      if (checks > COUNTER_DOUBLING) steep.push(`${name} checks: ${checks.toFixed(3)}`);
    }
  }
  assert.deepEqual(steep, []);
});

/**
 * S6c: the value side's inherited products, gated as W34 is: same-source adds, choices
 * and a literal's `get`s (S6-CARRIERS §4.5, §4.7: `ADMISSION_SAME_SOURCES`), product (c) of W34's class, k literals of
 * typed ingresses of one default (`ADMISSION_INGRESS_PRESETS`), and each discovery site's class (`VALUE_CLASS_SITES`),
 * their totals and each counter of at least 200 units in either order (they were gated at their measured doublings,
 * 2.04 to 3.65, while the value side read each copy at each field).
 */
test("the value side's work on same sources and typed presets grows with the program in either order", () => {
  assert.deepEqual(
    steepCounters([...ADMISSION_SAME_SOURCES, ...ADMISSION_INGRESS_PRESETS, ...VALUE_CLASS_SITES]),
    [],
  );
});

/**
 * #1403: what a decision's stop forgets by, each demand's reader and each key a demand asked whether it
 * stopped, is counted apart from the allowance (`countApart`), never in `total`, so no stop point moves. It is kept only
 * where a decision can still stop (#1599): what admission's walk asks of a place before that place's last decision
 * ends, and the readers of what a stop may then forget; nothing once every decision has run. So a program whose later
 * reads come after every decision keeps the same records however many there are, and one whose decisions read a place a
 * later decision can stop keeps records growing with them. On nested selections the records double at one doubling of
 * the source; on a chain of wrappers read through every link the charged reads themselves grow faster (G6's deep
 * shapes), and the records stay below one per charged read (`yields`). Both orders, the sharing on and off.
 */
test("what a stop forgets by is counted apart and kept only where a decision can still stop (#1403, #1599)", () => {
  const nest = (k: number, leaf: string): string =>
    Array.from({ length: k }).reduce<string>((inner) => `[${inner}, "other"][0]`, leaf);
  const program = (source: string): SourceFile[] => [{ path: "main.tease", source }];
  const lines = (k: number, line: (i: number) => string): string =>
    Array.from({ length: k }, (_, i) => line(i)).join("\n");
  // (each shape: its name, its program, whether its records grow linearly, and whether a decision reads a place a later
  // one can stop (records growing with the source), none does after the first decisions (the same records at both
  // sizes), or neither is asserted)
  type Kept = "growing" | "constant" | null;
  const shapes: readonly (readonly [string, (k: number) => SourceFile[], boolean, Kept])[] = [
    [
      "nested selections of a variable",
      (k) => program(`let seed = "origin"\nlet out = ${nest(k, "seed")}\nsay out\nexit\n`),
      true,
      null,
    ],
    [
      "nested selections of a literal",
      (k) => program(`let out = ${nest(k, '"origin"')}\nsay out\nexit\n`),
      true,
      null,
    ],
    [
      "a chain of wrappers read through every link",
      (k) =>
        program(
          [
            "let typed: integer = 1",
            "let root = {f: typed, q: null}",
            ...Array.from(
              { length: k },
              (_, i) => `let a${i} = {q: ${i === 0 ? "root" : `a${i - 1}`}}`,
            ),
            `let out = a${k - 1}.${Array.from({ length: k }, () => "q").join(".")}.f`,
            "exit",
          ].join("\n") + "\n",
        ),
      false,
      null,
    ],
    [
      "reads after every decision",
      (k) =>
        program(`let seed = {n: "origin"}\n${lines(k, () => 'say [seed.n, "other"][0]')}\nexit\n`),
      true,
      "constant",
    ],
    [
      "decisions reading a place a later decision can stop",
      (k) =>
        program(
          `let seed = {n: "origin"}\n${lines(k, (i) => `let c${i} = seed.n`)}\nseed.n = "later"\nexit\n`,
        ),
      true,
      "growing",
    ],
  ];
  const apart: readonly WorkCounter[] = ["readerRecords", "stopAsks"];
  const over: string[] = [];
  for (const [shape, make, linear, kept] of shapes) {
    const sizes = linear ? [32, 64] : [8, 16];
    const family: WorkFamily = { name: shape, measures: shape, program: make };
    const at = sizes.map((k) => sized(family, k));
    for (const reversed of [false, true])
      for (const unshared of [false, true]) {
        const where = `${shape}${reversed ? " reversed" : ""}${unshared ? " unshared" : ""}`;
        const [small, large] = at.map((one) => analysed(one, reversed, unshared).budget);
        for (const budget of [small!, large!]) {
          // (counted apart, never in the charged work, so never what stops the analysis)
          assert.ok(
            apart.every((counter) => !budget.counts.has(counter)),
            where,
          );
          assert.equal(
            [...budget.counts.values()].reduce((sum, units) => sum + units, 0),
            budget.total,
            where,
          );
          const records = apart.map((counter) => budget.apart.get(counter) ?? 0);
          if (records[0]! + records[1]! > (budget.counts.get("yields") ?? 0))
            over.push(
              `${where}: ${records.join(" + ")} records, ${budget.counts.get("yields")} reads`,
            );
        }
        const records = (budget: Answers["budget"]): number =>
          apart.reduce((sum, counter) => sum + (budget.apart.get(counter) ?? 0), 0);
        const [before, after] = [records(small!), records(large!)];
        if (kept === "constant" && after !== before)
          over.push(`${where}: ${before} → ${after} records after every decision`);
        if (kept === "growing" && after < before + sizes[0]!)
          over.push(`${where}: ${before} → ${after} records before a later decision`);
        if (!linear) continue;
        const scale =
          (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
        for (const counter of apart) {
          const before = small!.apart.get(counter) ?? 0;
          const doubling = (2 * ((large!.apart.get(counter) ?? 0) / Math.max(1, before))) / scale;
          if (before > 0 && doubling > DOUBLING)
            over.push(`${where} ${counter}: ${doubling.toFixed(3)}`);
        }
      }
  }
  assert.deepEqual(over, []);
});

/**
 * #1456: a prefix of closed objects read once costs what its levels do: its first property read is theirs, nothing
 * charged or kept for it (`propertyItems`). Every counter of a place replaced by two objects and of 8 places each
 * replaced by two wide objects, each read at one property, in either order with the sharing on and off, is `main`'s
 * at `465532f4a`, the wide places' `eventSteps` 40 fewer since #1221 charges its event searches by comparison, and since
 * #1251 no narrowing index made for these programs without a test (a regression oracle of this construction only; before it, the wide places took 2 `structureSteps` and
 * 2 `literalUnits` each).
 */
test("a prefix of closed objects read once has main's counters, in either order, shared or not (#1456)", () => {
  const wide = (k: number): string =>
    `let a = {${many(k, (i) => `f${i}: hostValue`, ", ")}}\nlet b = {${many(k, (i) => `g${i}: hostOther`, ", ")}}\n` +
    `${many(k, (i) => `let r${i} = a\nr${i} = b\nrepeat r${i}.f${i} {}`)}\nexit`;
  const cases: readonly (readonly [string, string, readonly [string, string]])[] = [
    [
      "a place replaced by two objects",
      'let a = {n: 1}\nlet b = {n: 2, m: "x"}\nlet c = a\nc = b\nsay c.n\nexit',
      [
        "checks 142 checksSkipped 3 defScan 4 defSortElements 4 defs 4 domSteps 42 eventSteps 25 exactQueries 1 exactValues 1 frames 39 graphEdges 21 graphNodes 21 indexSteps 345 invSteps 105 literalUnits 504 mergeItems 17 ownerSteps 4 parentStackSteps 2 rdQueries 3 rdWalk 9 regionWalks 15 structureSteps 26 syntaxNodes 28 yields 75",
        "checks 142 checksSkipped 3 defScan 4 defSortElements 4 defs 4 domSteps 42 eventSteps 25 exactQueries 1 exactValues 1 frames 39 graphEdges 21 graphNodes 21 indexSteps 345 invSteps 103 literalUnits 346 mergeItems 17 ownerSteps 4 parentStackSteps 2 rdQueries 3 rdWalk 9 regionWalks 15 structureSteps 12 syntaxNodes 28 yields 75",
      ],
    ],
    [
      "8 places each replaced by two wide objects",
      wide(8),
      [
        "checks 708 checksSkipped 32 defScan 18 defSortElements 18 defs 18 domSteps 206 eventSteps 441 exactQueries 226 exactValues 26 frames 342 graphEdges 107 graphNodes 99 indexSteps 1744 invSteps 822 literalUnits 2533 mergeItems 114 ownerSteps 18 parentStackSteps 16 rdQueries 80 rdWalk 192 regionWalks 134 structureSteps 124 syntaxNodes 144 yields 724",
        "checks 708 checksSkipped 32 defScan 18 defSortElements 18 defs 18 domSteps 206 eventSteps 441 exactQueries 226 exactValues 26 frames 342 graphEdges 107 graphNodes 99 indexSteps 1744 invSteps 820 literalUnits 1785 mergeItems 114 ownerSteps 18 parentStackSteps 16 rdQueries 80 rdWalk 192 regionWalks 134 structureSteps 56 syntaxNodes 144 yields 724",
      ],
    ],
  ];
  for (const [name, source, [shared, unshared]] of cases) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null, name);
    for (const reversed of [false, true])
      for (const off of [false, true]) {
        const measured: Measured = analysed({ name, request }, reversed, off).budget;
        assert.equal(
          [...measured.counts]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([counter, units]) => `${counter} ${units}`)
            .join(" "),
          off ? unshared : shared,
          `${name}${reversed ? " reversed" : ""}${off ? " unshared" : ""}`,
        );
      }
  }
});

/**
 * #1456: a prefix the cheap checks refuse walks no holder's marks: whether its holders mark nothing is asked only of a
 * prefix every entry of which is otherwise a closed object. A place given one object, 16 property stores and then a
 * host value charges `main`'s total at `007a90112` under a demand allowance of 16 in either order, shared or not (a
 * regression oracle of that order only; asking each object's holder first moved 285 units into the decisions that stop,
 * reversed).
 */
test("a prefix the cheap checks refuse walks no holder's marks, main's total under a demand allowance of 16 (#1456)", () => {
  const source = `let b = {f0: 1}\n${many(16, (i) => `b.f${i} = ${i}`)}\nb = hostValue\nsay "AFTER"\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const at = { name: "an object, 16 property stores and a host value", request };
  assert.deepEqual(
    [false, true].flatMap((reversed) =>
      [false, true].map(
        (unshared) =>
          withTestDemandAllowance(16, () => analysed(at, reversed, unshared)).budget.total,
      ),
    ),
    [3988, 3988, 4844, 4862],
  );
});

/**
 * #1221: a search of a sorted list of event positions charges each comparison it makes, so its charge grows with the
 * list's logarithm (before, two flat units a pair of searches whatever the list's length: a warmed X6 query read a list
 * of 1,025 events 22 times). X6's first event of `n` in a span after k conditional stores of it, its list built by a
 * first query: the second query's charge is at least the comparisons a binary search over k + 1 positions makes; and
 * its one search a range finds an event at the range's end, none between two events and none past the last.
 */
test("a search of a key's events charges each comparison it makes (#1221)", () => {
  for (const k of [64, 1024]) {
    const source = `let flag = askBoolean "Change it?"\nlet n = 1\n${many(k, (i) => `if flag { n = ${i + 2} }`)}\nsay n\nexit`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const { definitions, lists, program } = narrowingPass(request);
    // (`n`'s key: the one with k + 1 definitions)
    const key = [...definitions.byKey].find(([, list]) => list.length === k + 1)![0];
    const span = [[0, Number.MAX_SAFE_INTEGER]] as const;
    assert.equal(lists.eventIn(key, span), "branch");
    const before = program.work.total;
    lists.eventIn(key, span);
    const charged = program.work.total - before;
    assert.ok(charged >= Math.log2(k + 1), `k = ${k}: ${charged} units`);
    // (one search a range: an event is in a range ending at it, and none in a range between two events or past the last)
    const [first, second] = [...lists.ownEvents(key).stores].sort((a, b) => a - b);
    const last = Math.max(...lists.ownEvents(key).stores);
    assert.ok(second! - first! >= 2, `k = ${k}: positions between the first two events`);
    assert.equal(lists.eventIn(key, [[last, last]]), "branch", `k = ${k}`);
    assert.equal(lists.eventIn(key, [[first! + 1, second! - 1]]), null, `k = ${k}`);
    assert.equal(lists.eventIn(key, [[last + 1, Number.MAX_SAFE_INTEGER]]), null, `k = ${k}`);
  }
});

/**
 * #2065 (#2059, #1585): a decided path below an ordinary property reads, of its prefix's whole stores and settled
 * stores, those that may hold the property and those unproved (`holdersOf`), once the reads it saves pay for the index.
 * Every family of `DECISION_HOLDER_FAMILIES` (k objects stored into a place or copied into it from k terminal places;
 * one holder each, none, every one, or every other store an unproved copy; decided below, at and past the index's
 * first bound) grows from k = 16 to 32 within the suite's bound, or within 1 % of `main`'s own growth where `main` grows
 * faster (`MAIN_GROWTH`, measured once on `53c7b4bfc`, sharing on and off). Publications equal `main`'s on every family,
 * size and mode, and each counter keeps within its row's declared term (the PR's evidence, outside CI).
 */
test("a decided path reads its prefix's stores that may hold its first step, the family within main's growth (#2065)", () => {
  const MAIN_GROWTH: Record<string, readonly [number, number]> = {
    "holders-direct-holders-below": [3.069, 3.158],
    "holders-direct-holders-at": [3.169, 3.258],
    "holders-direct-holders-past": [2.797, 2.867],
    "holders-direct-none-below": [3.053, 3.134],
    "holders-direct-none-at": [3.146, 3.216],
    "holders-direct-none-past": [2.777, 2.832],
    "holders-direct-every-below": [2.625, 2.692],
    "holders-direct-every-at": [2.678, 2.743],
    "holders-direct-every-past": [2.765, 2.729],
    "holders-direct-unproved-below": [2.78, 2.966],
    "holders-direct-unproved-at": [2.892, 3.076],
    "holders-direct-unproved-past": [2.496, 2.631],
    "holders-copy-holders-below": [2.074, 2.065],
    "holders-copy-holders-at": [2.044, 2.032],
    "holders-copy-holders-past": [3.05, 3.093],
    "holders-copy-none-below": [2.107, 2.099],
    "holders-copy-none-at": [2.203, 2.191],
    "holders-copy-none-past": [3.305, 3.326],
    "holders-copy-every-below": [2.084, 2.083],
    "holders-copy-every-at": [2.156, 2.151],
    "holders-copy-every-past": [2.898, 2.905],
    "holders-copy-unproved-below": [2.022, 2.012],
    "holders-copy-unproved-at": [1.925, 1.894],
    "holders-copy-unproved-past": [2.801, 2.79],
  };
  assert.deepEqual(
    DECISION_HOLDER_FAMILIES.map((family) => family.name).sort(),
    Object.keys(MAIN_GROWTH).sort(),
  );
  const steep: string[] = [];
  for (const family of DECISION_HOLDER_FAMILIES)
    for (const [index, mode] of [MODES[0]!, MODES[1]!].entries()) {
      const [small, large] = [16, 32].map((k) => {
        const request = coreRequest(family.program(k), ["hostValue", "hostOther"]);
        assert.ok(request !== null, family.name);
        const { budget } = inMode(mode, () => analyseCore(request));
        assert.equal(budget.exhausted, null, family.name);
        return { total: budget.total, nodes: budget.counts.get("syntaxNodes") ?? 1 };
      });
      const growth = (2 * (large!.total / small!.total)) / (large!.nodes / small!.nodes);
      const bound = Math.max(DOUBLING, 1.01 * MAIN_GROWTH[family.name]![index]!);
      if (growth > bound)
        steep.push(`${family.name} ${JSON.stringify(mode)}: ${growth.toFixed(3)}`);
    }
  assert.deepEqual(steep, []);
});

/**
 * #2065: a place's decided path below a property that sixteen earlier stores lack, read after sixteen paths the index
 * is paid by, so its last walk is the built index's (in the forward order), decides as the full scan does: each
 * program's diagnostics, by code, severity and line, are `main`'s in every held mode, and so are the decision of `a.p`
 * (kinds, decider, inherited, what it holds) and, where its holders store lists, of its element. Each witness keeps
 * one part of the selection: a whole copy of a terminal place, its literal's names (Sol's copied-source witness); a
 * source's own store below its root, a layer no settled store shows (#1466), after the decider, where it offends, and
 * before it, where it decides; a holder whose element is `null` alone beside a written list, which decides nothing and
 * leaves its element nullable; two holders of different kinds; a host value's store and a copy of a place of two
 * stores, each unproved, which hold every step; a copy of a written binding, whose written type decides; stores the
 * first pass rejects (A6) before the path's holder, so the next pass's admission lists the stores without them and
 * decides afresh, where a state kept from the first misreads.
 */
test("a decided path past the decision index's first bound decides as the full scan does (#2065)", () => {
  const irrelevant = ["let a={x0:1}", ...Array.from({ length: 15 }, (_, i) => `a={x${i + 1}:1}`)];
  const reads = Array.from({ length: 16 }, (_, i) => `repeat a.x${i} {}`);
  const program = (
    before: readonly string[],
    holders: readonly string[],
    after: readonly string[],
  ) => [...before, ...irrelevant, ...holders, ...reads, ...after, "exit"].join("\n");
  const cases: readonly {
    readonly source: string;
    readonly diagnostics: readonly string[];
    readonly decided: readonly string[];
  }[] = [
    {
      source: program(["let root={p:1}"], ["a=root", 'a={p:"wrong"}'], ["repeat a.p {}"]),
      diagnostics: ["TSV041 error L18"],
      decided: ["integer by root L17, holds integer|unknown"],
    },
    {
      source: program(["let s={q:1}", 's.p="wrong"'], ["a={p:1}", "a=s"], ["repeat a.p {}"]),
      diagnostics: ["TSV043 error L0", "TSV041 error L19"],
      decided: ["integer by 1 L18, holds integer|unknown"],
    },
    {
      source: program(["let s={q:1}", 's.p="wrong"'], ["a=s", "a={p:1}"], ["repeat a.p {}"]),
      diagnostics: ["TSV043 error L0", "TSV041 error L19", "TSV011 error L36"],
      decided: ["string by s L18, holds string|unknown"],
    },
    {
      source: program(
        ["let typed:integer[]=[]"],
        ["a={p:[null]}", "a={p:typed}"],
        ["let b=a.p", "let c=b[0]", "repeat c {}"],
      ),
      diagnostics: [],
      decided: [
        "list by [null] L17, holds list|unknown",
        "integer|null by typed L18 inherited, holds integer|null|unknown",
      ],
    },
    {
      source: program([], ["a={p:1}", 'a={p:"wrong"}'], ["repeat a.p {}"]),
      diagnostics: ["TSV041 error L17"],
      decided: ["integer by 1 L16, holds integer|unknown"],
    },
    {
      source: program(["let t:integer=1"], ["a=hostValue", "a={p:t}"], ["repeat a.p {}"]),
      diagnostics: ["TSV041 warning L17", "TSV041 warning L17"],
      decided: ["integer by t L18 inherited, holds integer|unknown"],
    },
    {
      source: program(
        ["let t:integer=1", "let s={p:t}", "s={q:1}"],
        ["a=s", 'a={p:"wrong"}'],
        ["repeat a.p {}"],
      ),
      diagnostics: ["TSV041 error L20", "TSV011 warning L37", "TSV043 warning L37"],
      decided: ["integer by s L19 inherited, holds integer|unknown"],
    },
    {
      source: program(["let typed:object={x:1}"], ["a=typed", 'a={p:"wrong"}'], ["repeat a.p {}"]),
      diagnostics: ["TSV011 error L35"],
      decided: ["unknown by typed L17 inherited, holds string|unknown"],
    },
    {
      source: program(
        [],
        ["a={q:1}", 'a={q:"wrong"}', "a={p:1}", 'a={p:"text"}'],
        ["repeat a.q {}", "repeat a.p {}"],
      ),
      diagnostics: [
        "TSV041 error L17",
        "TSV041 error L19",
        "TSV011 warning L36",
        "TSV043 warning L36",
      ],
      decided: ["integer by 1 L18, holds integer|unknown"],
    },
  ];
  const lineOf = (text: string) => Number(text.slice(text.lastIndexOf("L") + 1));
  for (const { source, diagnostics, decided } of cases) {
    // (each read of an irrelevant property: a count that may be another type, of an object that may lack it)
    const padding = source
      .split("\n")
      .flatMap((line, at) =>
        line.startsWith("repeat a.x") ? [`TSV011 warning L${at}`, `TSV043 warning L${at}`] : [],
      );
    const expected = [...diagnostics, ...padding].sort((x, y) => lineOf(x) - lineOf(y));
    for (const mode of HELD_MODES) {
      const result = mode.run(() =>
        compileProjectWithBackend(
          [{ path: "main.tease", source }],
          { globals: ["hostValue"] },
          CORE_BACKEND,
        ),
      );
      assert.deepEqual(
        result.diagnostics.map((d) => `${d.code} ${d.severity} L${d.span.start.line}`),
        expected,
        `${mode.name}: ${source}`,
      );
    }
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, source);
    const a = new CoreProgram(request).places.find(
      ({ kind }) => kind.kind === "binding" && kind.name === "a",
    )!.id;
    for (const mode of [MODES[0]!, MODES[1]!]) {
      const answers: Answers = inMode(mode, () => analyseCore(request));
      const paths = [[propertyStep("p")], [propertyStep("p"), "element"]] as const;
      const shown = paths.slice(0, decided.length).map((path): string => {
        const { admitted, contract } = answers.place(a, path);
        assert.ok(admitted.by === "decided" && admitted.decider !== null, source);
        const { start, end } = admitted.decider;
        const line = source.slice(0, start).split("\n").length - 1;
        const holds = contract.kinds.map((item) => item.tag).join("|");
        return `${admitted.kinds.join("|")} by ${source.slice(start, end)} L${line}${admitted.inherited ? " inherited" : ""}, holds ${holds}`;
      });
      assert.deepEqual(shown, decided, `${JSON.stringify(mode)}: ${source}`);
    }
  }
});
