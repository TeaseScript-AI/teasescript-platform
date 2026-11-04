import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  LandingTape,
  withLandingComparison,
  withLandingOps,
  type LandingOp,
} from "../src/type-inference/core/admission/landings.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { WorkLedger } from "../src/type-inference/core/budget.js";
import type { TapePoint } from "../src/type-inference/core/admission/model.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { MODES, inMode } from "./helpers/type-core-oracles.js";

// The landing reporter (#1428, #1547): a call's tape reports each path's first event in a range, and every
// `landedBelow` call returns, in order, what the walk without listings returns.

const GLOBALS = ["hostValue", "hostOther", "hostInit", "otherHost"];

/** The landing families' module (`tests/families/copies/1428-landing-reporter.mjs`), read where the tests run. */
async function families(): Promise<Record<string, (k: number) => string>> {
  const file = resolve(process.cwd(), "tests/families/copies/1428-landing-reporter.mjs");
  // EVIDENCE: the module exports `shapes`, each a size to one source's text (the families' module contract).
  return (
    (await import(pathToFileURL(file).href)) as { shapes: Record<string, (k: number) => string> }
  ).shapes;
}

/** Codex r3's crossed descendants (`seed` 1–40), which hold R3's clock boundary (Astra's design review). */
function crossed(seed: number): string {
  let state = seed;
  const next = (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const lines = [
    "let typed: integer | string = 1",
    "let v0 = {p: {f0: typed, f1: typed}, q: {g0: typed, g1: typed}}",
  ];
  for (let i = 1; i <= 8; i += 1) {
    const picks = Array.from({ length: 6 }, () => next(i));
    const variants = Array.from(
      { length: 3 },
      (_, j) => `{p: v${picks[2 * j]}.p, q: v${picks[2 * j + 1]}.q}`,
    );
    variants.splice(next(4), 0, `{p: {f${i + 1}: typed}, q: {g${i + 1}: typed}}`);
    lines.push(`let v${i} = [${variants.join(", ")}][0]`);
  }
  for (let i = 0; i < 4; i += 1) {
    const [a, b, c] = [next(9), next(9), next(9)];
    lines.push(`let x${i} = [{r: v${a}.p}, {r: v${b}.q}, {r: v${c}.p}][0]`);
  }
  lines.push('say "${x0.r} ${x1.r} ${x2.r} ${x3.r}"', "exit");
  return `${lines.join("\n")}\n`;
}

/** Each landing call's result beside the walk's, in the four modes; the calls compared. */
function compared(source: string): number {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null);
  let calls = 0;
  for (const mode of MODES)
    withLandingComparison(
      (place, prefix, listed, walked) => {
        calls += 1;
        assert.deepEqual(listed, walked, `place ${place} at ${prefix.join(".")}`);
      },
      () => inMode(mode, () => analyseCore(request)),
    );
  return calls;
}

test("a tape reports each path's first event in a range, in order, looking at its blocks only where one starts there", () => {
  // tapes of random brings and repeats (interleaved, runs, alternations); every pair of points against the events
  for (let seed = 1; seed <= 60; seed += 1) {
    let state = seed;
    const next = (n: number): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state % n;
    };
    const work = new WorkLedger(Number.MAX_SAFE_INTEGER);
    const tape = new LandingTape(work);
    const events: number[] = [];
    const points: TapePoint[] = [tape.point()];
    for (let step = 0; step < 40 + seed; step += 1) {
      if (tape.texts.length === 0 || next(3) === 0) {
        events.push(tape.bring([`f${tape.texts.length}`], `f${tape.texts.length}`));
      } else {
        // (a few paths, so repeats recur, alternate and run)
        const index = next(Math.min(tape.texts.length, 1 + (seed % 4)));
        tape.repeat(index);
        events.push(index);
      }
      points.push(tape.point());
    }
    for (let i = 0; i < points.length; i += 1)
      for (let j = i; j < points.length; j += 1) {
        const expected: number[] = [];
        for (const index of events.slice(i, j)) if (!expected.includes(index)) expected.push(index);
        assert.deepEqual(
          tape.reports(points[i]!, points[j]!),
          expected,
          `seed ${seed}, ${i}..${j}`,
        );
      }
  }
});

test("a tape's boundary cases: a repeat first in its range reports, a later one does not, an empty range nothing", () => {
  const tape = new LandingTape(new WorkLedger(Number.MAX_SAFE_INTEGER));
  const start = tape.point();
  tape.bring(["x"], "x");
  tape.bring(["y"], "y");
  const middle = tape.point();
  tape.repeat(0);
  const end = tape.point();
  assert.deepEqual(tape.reports(start, end), [0, 1]);
  assert.deepEqual(tape.reports(middle, end), [0]);
  assert.deepEqual(tape.reports(middle, middle), []);
  const runs = new LandingTape(new WorkLedger(Number.MAX_SAFE_INTEGER));
  runs.bring(["x"], "x");
  const second = runs.point();
  runs.repeat(0);
  assert.deepEqual(runs.reports(second, runs.point()), [0]);
});

test("a tape's query of one path repeated k times looks at O(log k) blocks", () => {
  for (const k of [64, 1024]) {
    const work = new WorkLedger(Number.MAX_SAFE_INTEGER);
    const tape = new LandingTape(work);
    tape.bring(["x"], "x");
    const from = tape.point();
    for (let i = 0; i < k; i += 1) tape.repeat(0);
    const made = work.total;
    assert.deepEqual(tape.reports(from, tape.point()), [0]);
    const looked = work.total - made;
    assert.ok(looked <= 4 * Math.log2(k + 1), `${looked} blocks for ${k} repeats`);
  }
});

test("every landing call returns the walk's paths in order: each family and Astra's clock witness, four modes", async () => {
  // (the sample CI runs; the families at 16 to 128 and Astra's 178 sources, the 40 crossed seeds among them, run on the
  // queue: the PR's evidence)
  const shapes = await families();
  let calls = 0;
  for (const name of Object.keys(shapes)) calls += compared(shapes[name]!(4));
  // (seed 2: a cover stamped at the next free order moves q.g0 and q.g1 behind p.f1, Astra's design review)
  calls += compared(crossed(2));
  assert.ok(calls > 200, `${calls} calls compared`);
});

test("each reporter operation is debited where it happens", async () => {
  const shapes = await families();
  const ops: LandingOp[] = ["report", "child", "select", "visit", "node", "lookup", "publish"];
  const seen = new Set<LandingOp>();
  for (const name of ["narrow-repeat-3", "skip-2", "diamond-2", "skip-cross-3"]) {
    const request = coreRequest([{ path: "main.tease", source: shapes[name]!(8) }], GLOBALS);
    assert.ok(request !== null);
    withLandingOps(
      (place, _prefix, counts) => {
        for (const op of ops) {
          assert.equal(counts.debited[op], counts.ops[op], `${name}: ${op} at place ${place}`);
          if (counts.ops[op] > 0) seen.add(op);
        }
      },
      () => analyseCore(request),
    );
  }
  assert.deepEqual([...seen].sort(), [...ops].sort());
});

test("a fixed-width chain's landings take its listings: linear, and at most half the walk's", async () => {
  const shapes = await families();
  for (const name of [
    "narrow-after-chain",
    "join-reach-copy-left",
    "narrow-repeat-1",
    "narrow-repeat-3",
  ]) {
    const units = (k: number): { listed: number; walked: number } => {
      const request = coreRequest([{ path: "main.tease", source: shapes[name]!(k) }], GLOBALS);
      assert.ok(request !== null);
      const sum = { listed: 0, walked: 0 };
      withLandingComparison(
        (_place, _prefix, _listed, _walked, call) => {
          sum.listed += call.listed;
          sum.walked += call.walked;
        },
        () => analyseCore(request),
      );
      return sum;
    };
    const [small, large] = [units(32), units(64)];
    assert.ok(large.listed <= 2.15 * small.listed, `${name}: ${small.listed} → ${large.listed}`);
    assert.ok(
      2 * large.listed <= large.walked,
      `${name}: ${large.listed} of the walk's ${large.walked}`,
    );
  }
});
