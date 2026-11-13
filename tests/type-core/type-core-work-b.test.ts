// The coarse core's work as a sampled regression oracle (`tests/helpers/type-core/type-core-work.ts`), one of the work files that
// CI runs side by side.
import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../../src/type-inference/core/consumers.js";
import { writtenTypeSteps } from "../../src/type-inference/core/contract.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import {
  ADMISSION_FAMILIES,
  JOIN_REACH_FAMILIES,
} from "../helpers/type-core/families/admission.js";
import {
  COPY_RING_FAMILIES,
  HOT_CANDIDATE_FAMILIES,
  NESTED_OBJECT_SELECTIONS,
} from "../helpers/type-core/families/candidates.js";
import { INHERITED_FIELD_FAMILIES } from "../helpers/type-core/families/inherited.js";
import { OUTPUT_BOUND_FAMILIES } from "../helpers/type-core/families/output-bound.js";
import { W34_KNOWN_PRODUCTS, W34_VARIANTS } from "../helpers/type-core/families/w34-links.js";
import {
  W44_VARIANTS,
  W45_VARIANTS,
  WORK_FAMILIES,
} from "../helpers/type-core/families/work-gates.js";
import { type WorkFamily } from "../helpers/type-core/families/builders.js";
import {
  DOUBLING,
  sized,
  analysed,
  COUNTER_DOUBLING,
  type Measured,
  steepCounters,
  many,
} from "../helpers/type-core/type-core-work.js";

/**
 * S3, revision 14: an admission decision is a demand with the program's nodes' allowance, since a key's stores come
 * from every call site. W5's `shown` places, each a function's own, read a record that every chapter's call stores
 * (their callables' allowances it crossed 4.08 and 8.08 times, reversed): at k = 64 and 128 in either order no decision
 * stops, and the work stays linear.
 */
test("W5's decisions stop at no demand allowance, in either order, and its work stays linear", () => {
  const w5 = WORK_FAMILIES.find((family) => family.name === "W5")!;
  const [at64, at128] = [sized(w5, 64), sized(w5, 128)];
  for (const reversed of [false, true]) {
    const [small, large] = [analysed(at64, reversed).budget, analysed(at128, reversed).budget];
    for (const budget of [small, large])
      assert.deepEqual(
        budget.decisions.filter((d) => d.stopped),
        [],
        `reversed: ${reversed}`,
      );
    const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
    assert.ok((2 * (large.total / small.total)) / scale <= DOUBLING, `reversed: ${reversed}`);
  }
});

/**
 * W34, W44 and W45: every variant in the source order and with the consumers'
 * and the solver's orders reversed, its total and each counter of at least 200 units per doubling of the source. A counter is the raw count of
 * one structure's steps, so a copy walked per field or a mark set made per copy shows in its own counter where the
 * total would hide it; a counter may carry its structure's log factor (a sort, a table of jumps: 2.33 at these sizes
 * where nothing else is charged to it), a product of two dimensions measures 3 and more. The full series to k = 1,024
 * is the step's evidence, outside CI.
 */
test("every W34, W44 and W45 variant's work and each of its counters grow with the program in either order", () => {
  assert.deepEqual(steepCounters([...W34_VARIANTS, ...W44_VARIANTS, ...W45_VARIANTS]), []);
});

/**
 * #1573 (Codex r1's B2 on #1628): a third list of m loads of one class, the members of the first two lists in their order
 * or in another, names their leaves through one node per sequence of its other members (`setNode`), shared with an
 * earlier list of that sequence and else folded anew, one step per member, never by sorting them: the contract's steps
 * (`invSteps`) the third list adds at 16, 32 and 64 members are linear in its members, the second doubling adding at
 * most 2.1 times what the first added, in either order of the analysis (with a sort per list, 2.18 times).
 */
test("a further list of a set's members, in any order, adds contract steps linear in its members (#1573)", () => {
  const steps = (m: number, lists: readonly (readonly number[])[], reversed: boolean): number => {
    const source = [
      many(
        m,
        (j) => `let p${j} = load("same", default: ${j % 2 === 1 ? "hostOther" : "hostValue"})`,
      ),
      ...lists.map(
        (list, i) =>
          `let xs${i} = [${list.map((j) => `p${j}`).join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i].p`,
      ),
      "exit",
    ].join("\n");
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null, source);
    const run = (): Answers => analyseCore(request);
    const answers = reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, run),
        )
      : run();
    return answers.budget.counts.get("invSteps") ?? 0;
  };
  for (const reversed of [false, true])
    for (const turned of [false, true]) {
      // (what the third list adds at 16, 32 and 64 members)
      const [small, middle, large] = [16, 32, 64].map((m) => {
        const order = Array.from({ length: m }, (_, j) => j);
        const third = turned ? order.map((j) => (j * (m - 1) + 1) % m) : order;
        return steps(m, [order, order, third], reversed) - steps(m, [order, order], reversed);
      });
      assert.ok(
        large! - middle! <= 2.1 * (middle! - small!),
        `reversed: ${reversed}, turned: ${turned}: ${small} → ${middle} → ${large}`,
      );
    }
});

/**
 * #1466, Codex r5's F1 (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-245): k reads of
 * `h.p<i>` each answered by k layers holding a source on its path, so the summaries' demands are the answers' own pairs
 * P, counted from the program's holders: at k 16 and 32 in the four modes the demands are exactly P less the pairs one
 * source answers by reference, one per pair a summary answers, never repeated, never a pass-through layer's, `checks`
 * at or under `main`'s, `invSteps` growing at or under `main`'s, and the total's excess over `main` per pair not rising
 * (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-245: the exception for an output-bound
 * family; the control keeps the total's bound). `main`'s work is the family's measured oracle.
 */
test("summaries' demands on output-bound reads are their answers' pairs, at main's growth per pair (#1466)", () => {
  const modes = [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const;
  for (const family of OUTPUT_BOUND_FAMILIES)
    modes.forEach(([reversed, unshared], mode) => {
      const at = (k: 16 | 32) => {
        const request = coreRequest(
          [{ path: "main.tease", source: family.source(k) }],
          ["hostValue", "hostOther"],
        );
        assert.ok(request !== null, `${family.name} at ${k}: its files parse and resolve`);
        const { budget } = analysed(
          { name: `${family.name} at ${k}`, request },
          reversed,
          unshared,
        );
        const [total, checks, invSteps] = family.main[k][mode]!;
        const name = `${family.name} at ${k}, mode ${mode}`;
        assert.equal(
          budget.facts.layerDemands,
          family.pairs(k) - family.references(k),
          `${name}: one demand per pair a summary answers`,
        );
        assert.ok(
          (budget.counts.get("checks") ?? 0) <= checks,
          `${name}: checks at or under main's`,
        );
        return { budget, main: { total, invSteps }, nodes: budget.counts.get("syntaxNodes") ?? 1 };
      };
      const [small, large] = [at(16), at(32)];
      const scale = large.nodes / small.nodes;
      const growth = (before: number, after: number): number => (2 * after) / before / scale;
      const name = `${family.name}, mode ${mode}`;
      assert.ok(
        growth(
          small.budget.counts.get("invSteps") ?? 0,
          large.budget.counts.get("invSteps") ?? 0,
        ) <= growth(small.main.invSteps, large.main.invSteps),
        `${name}: invSteps at or under main's growth`,
      );
      if (family.outputBound) {
        const perPair = (at: typeof small, k: 16 | 32): number =>
          (at.budget.total - at.main.total) / family.pairs(k);
        assert.ok(
          perPair(large, 32) <= perPair(small, 16),
          `${name}: the excess per pair not rising`,
        );
      } else
        assert.ok(
          growth(small.budget.total, large.budget.total) <= DOUBLING,
          `${name}: total within the bound`,
        );
    });
});

/**
 * #1310 (the lead's rule): an operand that reaches an earlier join, through a literal's property, a nested list element,
 * an `otherwise`'s side, a kept variable or a copy, takes that join's composed type, so the join check composes each
 * tree once (beside #1357's prefixes each in an object above): each family's total and its counters grow with the
 * program in either order, the sharing on and off. The kept variables and copies of a written union without a conflicting
 * leaf are reported, not gated: admission's landings walk the chain once per link on `main` too (#1428), the copies'
 * charged work (`landedBelow`'s `copiesAlong`, `landsThrough` and `emit` from `hotSets`) and both forms' ids, made
 * there below the charged length (`keptParts` in `landedBelow`, 14,470 → 57,510 code units kept, 28,974 → 115,217
 * copied, as on `main`); at k = 64 → 128 total and `indexSteps`:
 *
 * | copies of a written union | `main` | this head |
 * | joined at each link | 2.18, 2.47 | 2.16, 2.45 |
 * | only copied | 2.02, 2.04 | 2.02, 2.04 |
 * | joined, from an unwritten list | 2.01, 2.03 | 2.01, 2.02 |
 *
 * Each link an object of its own property, the composed type grows with the chain (Codex r15's and r16's B1): the
 * projections' members are gated at 64 → 128 and 128 → 256, the growing join an operand's first part (an `otherwise`'s
 * first side); a kept variable's and a copy's are reported, a variable read beside each join of distinct properties
 * growing on `main` too (#1384: about 3.4 total, `exactValues` 3.9). An `otherwise` holding the earlier join on its
 * later side is gated below, with the composition's own invariant. (A literal's later element, the other later part, is
 * #1192's accepted nested-literal product on `main`.)
 */
test("a join's operand reaching an earlier join takes its composed type, its work linear either way (#1310)", () => {
  const gated = JOIN_REACH_FAMILIES.filter(
    (family) =>
      !/^join-reach-(kept|copy)-(left|right)(-width)?$/.test(family.name) &&
      !family.name.startsWith("join-reach-choice-later-"),
  );
  assert.equal(gated.length, 22);
  // (a composed type growing with the chain: its second doubling too, where a walk of a growing part first crosses the
  // total's gate, Codex r16's B1)
  const growing = gated.filter((family) => family.name.endsWith("-width"));
  assert.deepEqual(
    [
      ...steepCounters(gated),
      ...steepCounters(gated, true),
      ...steepCounters(growing, false, undefined, [128, 256]),
      ...steepCounters(growing, true, undefined, [128, 256]),
    ],
    [],
  );
});

/**
 * #1310: composing an operand's parts visits the smaller part only, so an earlier join growing with a chain is never
 * walked again where it stands as an operand's later part (`join-reach-choice-later-*`, an `otherwise`'s later side).
 * This gates that one operation, its visits (`partVisits`) at most 2.15 per doubling in either order; a walk of the
 * later part measures 3.9. The same analyses gate the shape's total and counters, the sharing on: its fallback check
 * makes each label below a fallback only where a check or warning names it, charged (#1433), so the shape's work is
 * linear in the code units it makes too (the uncharged-work probe, outside CI; 4.0 per doubling before).
 */
test("the composition of an operand's parts visits only its smaller part, its shape's work linear (#1310, #1433)", () => {
  const later = JOIN_REACH_FAMILIES.filter((family) =>
    family.name.startsWith("join-reach-choice-later-"),
  );
  assert.equal(later.length, 6);
  // (each analysis the counters' gate makes, kept for the visits')
  const budgets = new Map<string, Measured>();
  const steep = steepCounters(later, false, (at, reversed) => {
    const { budget } = analysed(at, reversed);
    budgets.set(`${at.name}${reversed ? " reversed" : ""}`, budget);
    return budget;
  });
  for (const family of later)
    for (const reversed of [false, true]) {
      const [small, large] = [64, 128].map((k) =>
        budgets.get(`${family.name} at ${k}${reversed ? " reversed" : ""}`)!,
      );
      const visits = (budget: Measured): number => budget.counts.get("partVisits") ?? 0;
      assert.ok(visits(large!) >= 128, `${family.name}: each link's parts composed`);
      const scale =
        (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
      const doubling = (2 * (visits(large!) / Math.max(1, visits(small!)))) / scale;
      if (doubling > DOUBLING)
        steep.push(`${family.name}${reversed ? " reversed" : ""}: ${doubling.toFixed(3)}`);
    }
  assert.deepEqual(steep, []);
});

/**
 * #1194: a written type's levels are read once per type, and each walk of it steps on from the prefix before, so k
 * copies of a value of a type k levels deep walk the type about k² steps (each decided path still asks it from its
 * root: the per-path questions, a design round), never k³ (each copy and each label reading every level from the root,
 * 7.45 per doubling before). The walk is uncharged work (`writtenTypeSteps` counts it), gated at its measured doubling.
 *
 * Measured per pass (steps ÷ passes), as `c1Visits`'s bound divides by `rejectPasses`: at 64 levels `out`'s decision
 * crosses its allowance (its cost is depth × copies, G6 in #1319's design-round list), and the pass that restarts it
 * walks the type again.
 */
test("copies of a deep written type walk the type once, not once per copy (#1194)", () => {
  const measured = (k: number): { steps: number; nodes: number } => {
    const source = [
      `let typed: integer${"[]".repeat(k)} = []`,
      "let out = typed",
      ...Array.from({ length: k }, () => "out = typed"),
      "exit",
    ].join("\n");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${k} levels: its file parses and resolves`);
    const before = writtenTypeSteps();
    const answers = analyseCore(request);
    const { counts } = answers.budget;
    const passes = 1 + (counts.get("rejectPasses") ?? 0) + (counts.get("stopPasses") ?? 0);
    return { steps: (writtenTypeSteps() - before) / passes, nodes: counts.get("syntaxNodes") ?? 0 };
  };
  const [small, large] = [measured(32), measured(64)];
  const doubling = (2 * (large.steps / small.steps)) / (large.nodes / small.nodes);
  assert.ok(doubling <= 4.15, `${doubling.toFixed(3)} per doubling of the source`);
});

/**
 * #1188: admission's hot-candidate discovery by touch tries lists no contribution once per context that reaches it (a
 * configuration prefix, a group's place, a read, a literal, a merge place or a cycle), so each family's total and each
 * of its counters grow with the program in either order. The series to k = 1,024, both orders and the sharing off, is
 * the step's evidence, outside CI.
 */
test("every hot-candidate family's work and each of its counters grow with the program in either order (#1188)", () => {
  assert.deepEqual(steepCounters(HOT_CANDIDATE_FAMILIES), []);
});

/**
 * G5 (5a, #1339): a cycle of whole copies is cut at its stops at once, so no member's entry walks the cycle again; each
 * family's total and each of its counters grow with the program in either order, with the sharing on and off. The
 * chord cycle reached the allowance at k = 64 on `main`. The series, the four modes and the conflicting chord cycle (whose
 * per-property components remain, G5's 5b), are the step's evidence, outside CI.
 */
test("a cycle of whole copies read at every member grows with the program in either order, shared or not (#1339)", () => {
  assert.deepEqual(
    [...steepCounters(COPY_RING_FAMILIES), ...steepCounters(COPY_RING_FAMILIES, true)],
    [],
  );
});

/**
 * #1426: in a selection nested k deep whose options are objects, read at a property, each level's literal is read at the
 * path once, its answer composed from the level inside's: the contract's merges and steps grow with the program in
 * either order (a level merged again from every literal inside measured 3.75 to 3.93 here). #1444: admission lists
 * the own structure of each literal's elements once, after the elements inside it, whichever literal the order asks
 * first (`expectStructures`), so its checks and the total grow with the program in either order too (asked outer
 * first, each element's walk of the nest inside it measured 2.64 to 2.76 for `checks` here). The series to k = 256, the
 * four modes and the siblings are the steps' evidence, outside CI.
 */
test("nested selections of objects merge each level's items once, in either order (#1426)", () => {
  const steep: string[] = [];
  for (const family of NESTED_OBJECT_SELECTIONS) {
    const [at32, at64] = [sized(family, 32), sized(family, 64)];
    for (const reversed of [false, true]) {
      const [small, large] = [at32, at64].map((at) => analysed(at, reversed).budget);
      const scale =
        (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      const name = `${family.name}${reversed ? " reversed" : ""}`;
      for (const counter of ["mergeItems", "invSteps", "checks"] as const) {
        const factor = doubling(small!.counts.get(counter) ?? 0, large!.counts.get(counter) ?? 0);
        if (factor > COUNTER_DOUBLING) steep.push(`${name} ${counter}: ${factor.toFixed(3)}`);
      }
      if (doubling(small!.total, large!.total) > DOUBLING)
        steep.push(`${name}: ${doubling(small!.total, large!.total).toFixed(3)}`);
    }
  }
  assert.deepEqual(steep, []);
});

/**
 * A4 through copies (the owner's reviewer's F1 on #1049): the inherited-field families, gated above with
 * the admission families, are gated with the sharing off too, so what a copy costs never hangs on equivalent answers
 * being shared; and his budget witness, a chain of 1,024 whole copies of a root of 1,024 written-typed fields (a source
 * of 6,153 syntax nodes that reached the allowance), completes within the default allowance.
 */
test("the inherited-field families grow with the program with the sharing off, and the 1,024 chain completes", () => {
  assert.deepEqual(steepCounters(INHERITED_FIELD_FAMILIES, true), []);
  const chain = INHERITED_FIELD_FAMILIES.find((family) => family.name === "A4-inherited-chain")!;
  assert.equal(analysed(sized(chain, 1_024)).outcome, "valid");
});

/**
 * S6c: an element selection reads its owner at its step and whole, so a chain of k `.first` read each link twice per
 * link below it, 2^k reads in all (`main` reached the allowance from k = 20); its whole answer is read once per value
 * now, so a list nested 32 deep read through 32 `.first` is answered within the allowance, in either order.
 */
test("a list nested 32 deep read through 32 `.first` is answered within the allowance", () => {
  const source = `let value = ${"[".repeat(32)}1${"]".repeat(32)}\nlet n: integer = value${".first".repeat(32)}\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const named = { name: "the 32-deep `.first` chain", request };
  assert.deepEqual([analysed(named).outcome, analysed(named, true).outcome], ["valid", "valid"]);
});

test("a chain of records over shared inputs is identified in linear space (round 13 B3)", () => {
  const levels = Array.from(
    { length: 32 },
    (_, index) => `let a${index + 1} = {left: a${index}, right: a${index}}`,
  );
  const source = `let a0 = {n: 1}\n${levels.join("\n")}\nlet xs = [a32, a32]\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  assert.equal(analyseCore(request).outcome, "valid");
});

/**
 * W34's two known products, gated known limits by the owner's decision
 * (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-45): a regression check on the 64
 * → 128 growth step only, each held to its measured doubling in either order (3.37 and 2.53); not a bound at larger
 * sizes (128 → 256 grows 3.62 and 2.82), and no linearity is asserted for them.
 */
test("W34's two known products grow no faster than measured", () => {
  const steep: string[] = [];
  for (const family of W34_KNOWN_PRODUCTS) {
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
 * S6-CARRIERS: a class's members are visited only where its side's quiet proof is not quiet, and each such visit
 * emits, so the visits are bounded by the output: per pass, at most the diagnostics, the checks and the decided paths.
 */
test("every family's member visits are bounded by its output and its decided paths", () => {
  const over: string[] = [];
  for (const family of [
    ...WORK_FAMILIES,
    ...W34_VARIANTS,
    ...W44_VARIANTS,
    ...W45_VARIANTS,
    ...ADMISSION_FAMILIES,
  ]) {
    const answers = analysed(sized(family, 32));
    const counts = answers.budget.counts;
    const visits = counts.get("c1Visits") ?? 0;
    const bound =
      (1 + (counts.get("rejectPasses") ?? 0)) *
      (answers.diagnostics.length + answers.checks.length + answers.budget.facts.decidedPaths);
    if (visits > bound) over.push(`${family.name}: ${visits} visits, ${bound} the bound`);
  }
  assert.deepEqual(over, []);
});

/**
 * G3 stage 1: the retained wrapper pairs, one read through k wrappers by a short step and by a long one,
 * their decided paths' keys cursors from birth (`keyLane`), never texts or arrays per prefix: their work and each
 * counter grow with the program in either order, with the sharing on and off (on `main` 2.17 and 2.96 at 16 → 32). The
 * pairs at 64 → 128 and 40 → 80, the uncharged-work probe and the reversed schedule are the PR's evidence, outside CI.
 */
const WRAPPER_PAIRS: readonly WorkFamily[] = ["q", "anUnusuallyLongPropertyName"].map((step) => ({
  name: `wrapper by '${step}'`,
  measures: "a read through k wrappers",
  program: (k: number) => [
    {
      path: "main.tease",
      source:
        [
          "let seed: integer = 1",
          "let root = {f: seed}",
          ...Array.from(
            { length: k },
            (_, i) => `let box${i} = {${step}: ${i ? `box${i - 1}` : "root"}}`,
          ),
          `let out = box${k - 1}.${Array.from({ length: k }, () => step).join(".")}.f`,
          "exit",
        ].join("\n") + "\n",
    },
  ],
}));

test("a read through wrappers decides its paths as cursors: its work and each counter grow with the program (G3 stage 1)", () => {
  assert.deepEqual(
    [
      ...steepCounters(WRAPPER_PAIRS, false, undefined, [16, 32]),
      ...steepCounters(WRAPPER_PAIRS, true, undefined, [16, 32]),
    ],
    [],
  );
});
