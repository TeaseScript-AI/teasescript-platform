import assert from "node:assert/strict";
import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import type { CoreAnalysisRequest } from "../../../src/type-inference/core/program.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { coreRequest } from "../type-core-analysis.js";
import { type WorkFamily } from "./families/builders.js";

/**
 * The work of the coarse core (checkpoint 9 and its W rows) as a sampled regression oracle: every
 * family's charged work at k = 128 against k = 64, per doubling of the programs' syntax nodes, since a family's source
 * need not double exactly. Linear work doubles; a structure bounded by a product of two program dimensions about
 * quadruples. The `n log n` structures (a key's definitions sorted, its lifting table, its own events) give up
 * to 2.33 at these sizes where nothing else is charged: W26's k stores of one place in one block measure 2.12 here and
 * 2.08 at k = 1,024, while the products the reference model's calibration found measured 2.56 and more. Two sizes
 * calibrate on known products; they prove no bound: the full series to k = 1,024 is the step's evidence, outside CI.
 */
export const DOUBLING = 2.15;

/** A family's program at size k, prepared once for each of its analyses. */
export interface Sized {
  readonly name: string;
  readonly request: CoreAnalysisRequest;
}

export function sized(family: WorkFamily, k: number): Sized {
  const name = `${family.name} at ${k}`;
  const request = coreRequest(family.program(k));
  assert.ok(request !== null, `${name}: its files parse and resolve`);
  return { name, request };
}

/**
 * A fresh analysis of a family's program, in the source order or with the consumers' and the solver's orders reversed,
 * with the sharing of answers on or off (`withoutSharing`).
 */
export function analysed({ name, request }: Sized, reversed = false, unshared = false): Answers {
  const run = (): Answers =>
    reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, () => analyseCore(request)),
        )
      : analyseCore(request);
  const answers = unshared ? withoutSharing(run) : run();
  assert.equal(answers.budget.exhausted, null, `${name}: within the allowance`);
  return answers;
}

/**
 * A counter's bound per doubling of the source, for counters of at least 200 units: a counter may carry its structure's
 * log factor (a sort, a table of jumps: 2.33 at these sizes where nothing else is charged to it), a product of two
 * dimensions measures 3 and more.
 */
export const COUNTER_DOUBLING = 2.35;

/** A program's charged work, in total and by counter. */
export type Measured = Pick<Answers["budget"], "total" | "counts">;

/**
 * The families of `families` whose total or a counter of at least 200 units grows faster than linearly, either order;
 * `unshared`: with the sharing of answers off; `measure`: the work of another run than the analysis's.
 */
export function steepCounters(
  families: readonly WorkFamily[],
  unshared = false,
  measure: (at: Sized, reversed: boolean) => Measured = (at, reversed) =>
    analysed(at, reversed, unshared).budget,
  sizes: readonly [number, number] = [64, 128],
): string[] {
  const steep: string[] = [];
  for (const family of families) {
    const [at64, at128] = [sized(family, sizes[0]), sized(family, sizes[1])];
    for (const reversed of [false, true]) {
      const small = measure(at64, reversed);
      const large = measure(at128, reversed);
      // (an output-bound family per its output's growth; any other per its source's)
      const scale =
        family.output === undefined
          ? (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1)
          : family.output(sizes[1]) / family.output(sizes[0]);
      const name = `${family.name}${reversed ? " reversed" : ""}${unshared ? " unshared" : ""}${sizes[0] === 64 ? "" : ` ${sizes[0]} → ${sizes[1]}`}`;
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      // (where `main` grows faster on the family's shape, at or under `main`'s growth)
      const bound = Math.max(DOUBLING, family.main?.total ?? 0);
      const counterBound = (counter: string): number =>
        counter === "invSteps"
          ? Math.max(COUNTER_DOUBLING, family.main?.invSteps ?? 0)
          : COUNTER_DOUBLING;
      if (doubling(small.total, large.total) > bound)
        steep.push(`${name}: ${doubling(small.total, large.total).toFixed(3)}`);
      for (const [counter, after] of large.counts)
        if (
          counter !== "syntaxNodes" &&
          after >= 200 &&
          doubling(small.counts.get(counter) ?? 0, after) > counterBound(counter)
        )
          steep.push(
            `${name} ${counter}: ${doubling(small.counts.get(counter) ?? 0, after).toFixed(3)}`,
          );
    }
  }
  return steep;
}

export const many = (k: number, row: (index: number) => string, by = "\n"): string =>
  Array.from({ length: k }, (_, index) => row(index)).join(by);
