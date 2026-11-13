import assert from "node:assert/strict";

import { Admission } from "../../../../src/type-inference/core/admission.js";
import { drive } from "../../../../src/type-inference/core/inherited/inherited.js";
import { earliestDecider } from "../../../../src/type-inference/core/admission/scan.js";
import { analyseCore } from "../../../../src/type-inference/core/answers.js";
import { withEveryRecord } from "../../../../src/type-inference/core/solver.js";
import type { Definition } from "../../../../src/type-inference/core/definitions.js";
import { coreRequest } from "../../type-core-analysis.js";
import { inMode, type Mode } from "../../type-core-oracles.js";

// The written decider asked two ways on one admission (#1444): its summary, outside every decision, and the scan of its
// stops, as a decision asks it; `tests/type-core/written/type-core-written-decider.test.ts` and the #1901 queue job compare them.

/**
 * An answer by what a reader takes of it: the term's spelling, the site, the kinds, the join's facts, and whether the
 * copy reads its type at its own level (#1901).
 */
export type Answer =
  ReturnType<typeof earliestDecider> extends Generator<unknown, infer R> ? R : never;
export const shown = (answer: Answer): string =>
  answer === null
    ? "none"
    : JSON.stringify([
        answer.term === null ? null : JSON.stringify(answer.term),
        answer.site?.start ?? null,
        answer.tags ?? null,
        answer.joined ?? null,
        answer.joinedNull ?? null,
        answer.own ?? null,
      ]);

/** `value`'s decider at `path` asked as `literalElements` asks it: the summary, outside every decision. */
export type Asked = Parameters<typeof earliestDecider>[3];
export const routed = (admission: Admission, d: Definition, path: Asked): Answer =>
  drive(admission, earliestDecider(admission, d.value!, d.node, path, null));

/** The same question as a decision asks it: the scan of its stops. */
export const scanned = (admission: Admission, d: Definition, path: Asked): Answer => {
  admission.deciding += 1;
  try {
    return routed(admission, d, path);
  } finally {
    admission.deciding -= 1;
  }
};

/** Runs `inside` with each admission of the analysis of `source` as it checks literals' elements (rule 3). */
export function atElements(
  source: string,
  mode: Mode,
  inside: (admission: Admission) => void,
  everyRecord = false,
): void {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const original = Admission.prototype.literalElements;
  Admission.prototype.literalElements = function (this: Admission, ...args) {
    inside(this);
    return original.apply(this, args);
  };
  try {
    inMode(mode, () =>
      everyRecord ? withEveryRecord(() => analyseCore(request)) : analyseCore(request),
    );
  } finally {
    Admission.prototype.literalElements = original;
  }
}

/** The definitions whose value a decider may be asked of: the stores and the literals' cells. */
export const valued = (admission: Admission): Definition[] => {
  const { definitions } = admission.pass;
  return [...definitions.storeDefs, ...[...definitions.cellDefs.values()].flat()].filter(
    (d) => d.value !== undefined,
  );
};

/**
 * #1901: of each path of `source`'s layers (its list elements and its objects' properties, at most one past `depth`),
 * asked of every value a decider may be asked of, the copies the summary answers and each answer whose `own` differs
 * from the scan's, on each admission's first check of literals' elements.
 */
export function ownDisagreements(
  source: string,
  depth: number,
  mode: Mode,
): { readonly copies: number; readonly differ: readonly string[] } {
  const steps = ["element", ...new Set([...source.matchAll(/[{,]\s*(\w+):/g)].map((m) => m[1]!))];
  const paths: string[][] = [[]];
  for (const path of paths)
    if (path.length <= depth) for (const step of steps) paths.push([...path, step]);
  const differ: string[] = [];
  let copies = 0;
  const seen = new WeakSet<Admission>();
  atElements(source, mode, (admission) => {
    if (seen.has(admission)) return;
    seen.add(admission);
    for (const d of valued(admission))
      for (const path of paths) {
        const [summary, scan] = [routed(admission, d, path), scanned(admission, d, path)];
        if (summary?.own !== undefined) copies += 1;
        if (summary?.own !== scan?.own)
          differ.push(`${d.uid} ${path.join(".")}: ${shown(summary)} ≠ ${shown(scan)}\n${source}`);
      }
  });
  return { copies, differ };
}
