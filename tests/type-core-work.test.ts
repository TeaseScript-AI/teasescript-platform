import assert from "node:assert/strict";
import test from "node:test";

import { withMemberOracle } from "../src/type-inference/core/admission.js";
import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import {
  ADMISSION_FAMILIES,
  ADMISSION_INGRESS_PRESETS,
  ADMISSION_KNOWN_PRODUCTS,
  ADMISSION_SAME_SOURCES,
  W34_KNOWN_PRODUCTS,
  W34_VARIANTS,
  W44_VARIANTS,
  W45_VARIANTS,
  WORK_FAMILIES,
  type WorkFamily,
} from "./helpers/type-core-families.js";
import { readFixture } from "./helpers/type-core-fixture.js";

/**
 * The work of the coarse core (checkpoint 9, TABLE §8 and §10.1's W rows) as a sampled regression oracle: every
 * family's charged work at k = 128 against k = 64, per doubling of the programs' syntax nodes, since a family's source
 * need not double exactly. Linear work doubles; a structure bounded by a product of two program dimensions about
 * quadruples. The TABLE's `n log n` structures (a key's definitions sorted, its lifting table, its own events) give up
 * to 2.33 at these sizes where nothing else is charged: W26's k stores of one place in one block measure 2.12 here and
 * 2.08 at k = 1,024, while the products the reference model's calibration found measured 2.56 and more. Two sizes
 * calibrate on known products; they prove no bound: the full series to k = 1,024 is the step's evidence, outside CI.
 */
const DOUBLING = 2.15;

/** A family's analysis at size k, in the source order or with the consumers' and the solver's orders reversed. */
function analysed(family: WorkFamily, k: number, reversed = false): Answers {
  const request = coreRequest(family.program(k));
  assert.ok(request !== null, `${family.name} at ${k}: its files parse and resolve`);
  const answers = reversed
    ? withConsumerOrder(
        (list) => [...list].reverse(),
        () => withSolverSeam({ reverseWorklist: true }, () => analyseCore(request)),
      )
    : analyseCore(request);
  assert.notEqual(answers.outcome, "budget-error", `${family.name} at ${k}: within the allowance`);
  return answers;
}

/** The charged work of a family's program at size k, and its syntax nodes. */
function work(family: WorkFamily, k: number): { total: number; nodes: number } {
  const answers = analysed(family, k);
  return { total: answers.budget.total, nodes: answers.budget.counts.get("syntaxNodes") ?? 0 };
}

test("every sampled family's work grows with its program, not with a product of its dimensions", () => {
  const steep = WORK_FAMILIES.flatMap((family) => {
    const small = work(family, 64);
    const large = work(family, 128);
    // the work ratio per doubling of the source: 2 for linear work
    const doubling = (2 * (large.total / small.total)) / (large.nodes / small.nodes);
    return doubling > DOUBLING ? [`${family.name}: ${doubling.toFixed(3)}`] : [];
  });
  assert.deepEqual(steep, []);
});

/**
 * W34 (TABLE §13.3, r4.33–r4.38), W44 and W45 (r4.46 (3)): every variant in the source order and with the consumers'
 * and the solver's orders reversed, its total and each counter of at least 200 units per doubling of the source. A counter is the raw count of
 * one structure's steps, so a copy walked per field or a mark set made per copy shows in its own counter where the
 * total would hide it; a counter may carry its structure's log factor (a sort, a table of jumps: 2.33 at these sizes
 * where nothing else is charged to it), a product of two dimensions measures 3 and more. The full series to k = 1,024
 * is the step's evidence, outside CI.
 */
const COUNTER_DOUBLING = 2.35;

/** The families of `families` whose total or a counter of at least 200 units grows faster than linearly, either order. */
function steepCounters(families: readonly WorkFamily[]): string[] {
  const steep: string[] = [];
  for (const family of families)
    for (const reversed of [false, true]) {
      const small = analysed(family, 64, reversed).budget;
      const large = analysed(family, 128, reversed).budget;
      const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
      const name = `${family.name}${reversed ? " reversed" : ""}`;
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      if (doubling(small.total, large.total) > DOUBLING)
        steep.push(`${name}: ${doubling(small.total, large.total).toFixed(3)}`);
      for (const [counter, after] of large.counts)
        if (
          counter !== "syntaxNodes" &&
          after >= 200 &&
          doubling(small.counts.get(counter) ?? 0, after) > COUNTER_DOUBLING
        )
          steep.push(
            `${name} ${counter}: ${doubling(small.counts.get(counter) ?? 0, after).toFixed(3)}`,
          );
    }
  return steep;
}

test("every W34, W44 and W45 variant's work and each of its counters grow with the program in either order", () => {
  assert.deepEqual(steepCounters([...W34_VARIANTS, ...W44_VARIANTS, ...W45_VARIANTS]), []);
});

/**
 * Admission (TABLE §5, §10.3; the port plan's §3.3): its decisions, rejections, candidates and boundary checks, gated as
 * W34 is; A6's chain of dependent rejections, which takes a pass per link (§8's passes × stores, each pass charged), is
 * a gated known limit by the owner's decision (TABLE r4.49, option A): a regression check on the 64 → 128 step only,
 * at its measured doubling, not a bound at larger sizes; a change to admission's passes re-measures and proposes the
 * gate with its counts, never retunes it.
 */
test("every admission family's work and each of its counters grow with the program in either order", () => {
  assert.deepEqual(steepCounters(ADMISSION_FAMILIES), []);
  const steep: string[] = [];
  for (const family of ADMISSION_KNOWN_PRODUCTS)
    for (const reversed of [false, true]) {
      const small = analysed(family, 64, reversed).budget;
      const large = analysed(family, 128, reversed).budget;
      const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
      const doubling = (2 * (large.total / small.total)) / scale;
      if (doubling > family.measured)
        steep.push(`${family.name}${reversed ? " reversed" : ""}: ${doubling.toFixed(3)}`);
    }
  assert.deepEqual(steep, []);
});

/**
 * Product (c) of W34's class (`ADMISSION_INGRESS_PRESETS`): the solver's demands are S4's product, ungated here as on
 * `main`; admission's own counters, its checks and its index steps, grow with the program in either order (they grew
 * 3.23 and 2.65 per doubling while each literal's conflict discovery asked its own ingresses' contracts at every path).
 */
test("admission's work on literals of typed ingresses of one default grows with the program in either order", () => {
  const steep: string[] = [];
  for (const family of ADMISSION_INGRESS_PRESETS)
    for (const reversed of [false, true]) {
      const small = analysed(family, 64, reversed).budget;
      const large = analysed(family, 128, reversed).budget;
      const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
      for (const counter of ["checks", "indexSteps"] as const) {
        const doubling =
          (2 * ((large.counts.get(counter) ?? 0) / Math.max(1, small.counts.get(counter) ?? 0))) /
          scale;
        if (doubling > COUNTER_DOUBLING)
          steep.push(
            `${family.name}${reversed ? " reversed" : ""} ${counter}: ${doubling.toFixed(3)}`,
          );
      }
    }
  assert.deepEqual(steep, []);
});

/**
 * S6-CARRIERS §4.7 (`ADMISSION_SAME_SOURCES`): admission's own counters on same-source adds and choices grow with the
 * program in either order; each total's 64 → 128 step, the value side's inherited product included, is a regression
 * check at its measured doubling, not a bound at larger sizes.
 */
test("admission's work on same-source adds and choices grows with the program in either order", () => {
  const steep: string[] = [];
  for (const family of ADMISSION_SAME_SOURCES)
    for (const reversed of [false, true]) {
      const small = analysed(family, 64, reversed).budget;
      const large = analysed(family, 128, reversed).budget;
      const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      const name = `${family.name}${reversed ? " reversed" : ""}`;
      if (doubling(small.total, large.total) > family.measured)
        steep.push(`${name}: ${doubling(small.total, large.total).toFixed(3)}`);
      for (const counter of [
        "checks",
        "checksSkipped",
        "aliasSteps",
        "eligibility",
        "quietProofs",
        "c1Visits",
      ] as const) {
        const after = large.counts.get(counter) ?? 0;
        if (after >= 200 && doubling(small.counts.get(counter) ?? 0, after) > COUNTER_DOUBLING)
          steep.push(
            `${name} ${counter}: ${doubling(small.counts.get(counter) ?? 0, after).toFixed(3)}`,
          );
      }
    }
  assert.deepEqual(steep, []);
});

/**
 * Native resilience (TABLE §8): admission's walks over a literal of 150,000 elements beside a host value list them on
 * the heap, never as one call's arguments (review r3: a spread of the elements overflowed the native stack).
 */
test("a literal of 150,000 elements beside a host value is admitted within the native stack", () => {
  const source = `let xs: integer[] = [${Array.from({ length: 150_000 }, () => "1").join(",")}, hostValue]\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  assert.equal(analyseCore(request).outcome, "warning-runtime-check");
});

/**
 * Native resilience (TABLE §8, round 10 B5): an element read of a result that a chain of 2,048 functions returns, each
 * the next one's or a list, asks whether several elements meet there through every function's result: on the solver's
 * stack, never one native frame per function.
 */
test("an element read through a chain of 2,048 returned results is answered within the native stack", () => {
  const functions = Array.from(
    { length: 2_048 },
    (_, index) =>
      `function get${index} {\n  if flagHost { return [1] }\n  return get${(index + 1) % 2_048}()\n}`,
  );
  const source = `let flagHost = askBoolean "flag"\n${functions.join("\n")}\nlet xs = [get0(), get0()]\nrepeat xs[0][0] {}\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const forward = analyseCore(request).outcome;
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => analyseCore(request).outcome,
    ),
  );
  assert.deepEqual([forward, reversed], ["valid", "valid"]);
});

/**
 * A value's identity names its inputs by their own identities (TABLE §8, round 12 B4): a chain of 32 `otherwise`s, each
 * of the one before twice, is a source of 32 lines, never an identity of 2^32 characters.
 */
/**
 * A search the ledger does not see (round 13 B2, round 14 H1): over a literal of k records of distinct fields, the
 * analysis's `indexOf` searches inspect entries in proportion to k, never k² (each identity's first element is found in
 * one pass). The count wraps the built-in for this analysis only.
 */
test("a literal of 4,096 distinct records is searched in linear time", () => {
  const k = 4_096;
  const source = `${Array.from({ length: k }, (_, i) => `let a${i} = {f${i}: 1}`).join("\n")}\nlet xs = [${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")}]\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const original = Array.prototype.indexOf;
  let inspected = 0;
  Array.prototype.indexOf = function (this: unknown[], ...args: Parameters<typeof original>) {
    if (this.length >= k) inspected += this.length;
    return original.apply(this, args);
  };
  try {
    assert.equal(analyseCore(request).outcome, "valid");
  } finally {
    Array.prototype.indexOf = original;
  }
  assert.ok(inspected <= 64 * k, `${inspected} entries inspected`);
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

test("a chain of carriers over shared inputs is identified in linear space", () => {
  const levels = Array.from(
    { length: 32 },
    (_, index) => `let a${index + 1} = a${index} otherwise a${index}`,
  );
  const source = `let a0 = {n: 1}\n${levels.join("\n")}\nlet xs = [a32, a32]\nlet n: integer = xs[0].n\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  assert.equal(analyseCore(request).outcome, "valid");
});

/**
 * W34's two known products, gated known limits by the owner's decision (TABLE r4.45, PLAN §6b): a regression check on
 * the 64 → 128 growth step only, each held to its measured doubling in either order (3.37 and 2.53); not a bound at
 * larger sizes (128 → 256 grows 3.62 and 2.82), and no linearity is asserted for them.
 */
test("W34's two known products grow no faster than measured", () => {
  const steep: string[] = [];
  for (const family of W34_KNOWN_PRODUCTS)
    for (const reversed of [false, true]) {
      const small = analysed(family, 64, reversed).budget;
      const large = analysed(family, 128, reversed).budget;
      const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
      const doubling = (2 * (large.total / small.total)) / scale;
      if (doubling > family.measured)
        steep.push(`${family.name}${reversed ? " reversed" : ""}: ${doubling.toFixed(3)}`);
    }
  assert.deepEqual(steep, []);
});

test("the analysis stops above 256 levels of nested blocks, an `else if` one level", () => {
  const nested = (depth: number): string =>
    `${"if true {\n".repeat(depth)}say "deep"\n${"}\n".repeat(depth)}exit`;
  const chained = (length: number): string =>
    `let n = 1\n${Array.from({ length }, (_, i) => `${i === 0 ? "" : "else "}if n == ${i} { say "${i}" }`).join("\n")}\nexit`;
  const outcome = (source: string): string => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    return analyseCore(request).outcome;
  };
  assert.equal(outcome(nested(256)), "valid");
  assert.equal(outcome(nested(257)), "budget-error");
  assert.equal(outcome(chained(255)), "valid");
  assert.equal(outcome(chained(257)), "budget-error");
});

/**
 * S6-CARRIERS §4.1's member-answer oracle (the orchestrator's condition (a)), as a generated family: at every decided
 * path, each alias member's own answer equals its class representative's, each with its own guard applied, its items
 * compared whole (tags, certainty, reasons, context words, writers, leaves, marks). It runs over every work family at
 * small sizes and Astra's two M1 witnesses (a conditional store below the copied path before and between the copies)
 * in both orders, and over the fixture's records.
 */
test("every alias member answers as its class does at every decided path, in both orders (§4.1, condition (a))", (t) => {
  const differences: string[] = [];
  let compared = 0;
  const report = (difference: string | null): void => {
    compared += 1;
    if (difference !== null) differences.push(difference);
  };
  const run = (name: string, files: readonly SourceFile[], reversed: boolean): void => {
    const request = coreRequest(files);
    assert.ok(request !== null, `${name}: its files parse and resolve`);
    withMemberOracle(report, () =>
      reversed
        ? withConsumerOrder(
            (list) => [...list].reverse(),
            () => withSolverSeam({ reverseWorklist: true }, () => analyseCore(request)),
          )
        : analyseCore(request),
    );
  };
  const witnesses = ["before", "between"].map((at) => ({
    name: `M1, the conditional store ${at} the copies`,
    files: [
      {
        path: "main.tease",
        source: [
          "let raw = hostValue",
          "let root = {nested: {f0: [1, raw][1], f1: [1, raw][1]}}",
          "let box = {f0: null, f1: null}",
          ...(at === "before"
            ? ["if raw != null { root.nested.f0 = 1 }", "box = root.nested", "box = root.nested"]
            : ["box = root.nested", "if raw != null { root.nested.f0 = 1 }", "box = root.nested"]),
          "repeat box.f0 {}",
          "repeat box.f1 {}",
          "exit",
        ].join("\n"),
      },
    ],
  }));
  for (const reversed of [false, true]) {
    for (const family of [
      ...WORK_FAMILIES,
      ...W34_VARIANTS,
      ...W44_VARIANTS,
      ...W45_VARIANTS,
      ...ADMISSION_FAMILIES,
    ])
      for (const k of [2, 3, 5]) run(`${family.name} at ${k}`, family.program(k), reversed);
    for (const { name, files } of witnesses) run(name, files, reversed);
  }
  for (const record of [...readFixture(), ...readFixture("cells-rule-function.jsonl")])
    if (coreRequest(record.files) !== null) run(record.name, record.files, false);
  t.diagnostic(`${compared} member answers compared with their classes'`);
  assert.deepEqual(differences, []);
  assert.ok(compared > 1_000, `${compared} member answers compared`);
});

/**
 * S6-CARRIERS §4.4: a class's members are visited only where its side's quiet proof is not quiet, and each such visit
 * emits, so the visits are bounded by the output: per pass, at most the diagnostics, the checks and the decided paths.
 */
test("every family's member visits are bounded by its output and its decided paths (§4.4)", () => {
  const over: string[] = [];
  for (const family of [
    ...WORK_FAMILIES,
    ...W34_VARIANTS,
    ...W44_VARIANTS,
    ...W45_VARIANTS,
    ...ADMISSION_FAMILIES,
  ]) {
    const answers = analysed(family, 32);
    const counts = answers.budget.counts;
    const visits = counts.get("c1Visits") ?? 0;
    const bound =
      (1 + (counts.get("rejectPasses") ?? 0)) *
      (answers.diagnostics.length + answers.checks.length + answers.budget.facts.decidedPaths);
    if (visits > bound) over.push(`${family.name}: ${visits} visits, ${bound} the bound`);
  }
  assert.deepEqual(over, []);
});
