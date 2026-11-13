// The solver tests' shared setup (tests/type-core/solver/): a record and a member's answer as compared, components
// solved again from each entry, and a layer's request.

import assert from "node:assert/strict";
import { solveDemands } from "../../../src/type-inference/core/answers.js";
import {
  ingressLeaves,
  itemsSignature,
  writerKey,
  type Item,
} from "../../../src/type-inference/core/items.js";
import type { CoreAnalysisRequest } from "../../../src/type-inference/core/program.js";
import { withSolverSeam, type SolvedMember } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../type-core-analysis.js";
import { itemScope } from "../type-core-items.js";

/** A record as a multiset: its outcome, its diagnostics and its checks, each in a canonical order. */
export function canonical(record: ReturnType<typeof compactAnalysis>): string {
  return JSON.stringify({
    outcome: record.outcome,
    diagnostics: record.diagnostics.map((entry) => JSON.stringify(entry)).sort(),
    checks: record.checks.map((entry) => JSON.stringify(entry)).sort(),
  });
}

/** A member's answer as the component test compares it: its items' signature and their ingress stores. */
export function answer(items: readonly Item[]): string {
  const stores = items
    .map((item) =>
      item.ingress === undefined ? "" : ingressLeaves(item.ingress).map(writerKey).join(","),
    )
    .sort();
  return `${itemsSignature(items, itemScope())} ${stores.join(";")}`;
}

/**
 * Solves every component an analysis of `request` produces again from each member and in either order: how many there
 * are, and the members answered otherwise.
 */
export function componentDifferences(
  name: string,
  request: CoreAnalysisRequest,
): {
  readonly components: number;
  readonly differing: readonly string[];
  /** The components holding a layer's summary (`protoLayer|`, #1466). */
  readonly layered: number;
} {
  const solved: {
    readonly members: readonly SolvedMember[];
    readonly replay: { readonly names: readonly string[]; readonly packet: unknown } | null;
  }[] = [];
  withSolverSeam({ onComponent: (members, replay) => solved.push({ members, replay }) }, () =>
    compactAnalysis(request),
  );
  const differing: string[] = [];
  let layered = 0;
  for (const { members, replay } of solved) {
    // (a cursor's name replayed through its component's packet, never by its ids: #1422 B1)
    const keys = replay?.names ?? members.map((member) => member.key);
    if (keys.some((key) => key.startsWith("protoLayer|"))) layered += 1;
    const expected = members.map((member) => answer(member.items));
    for (const entry of keys)
      for (const reverseWorklist of [false, true]) {
        const got = withSolverSeam({ reverseWorklist }, () =>
          solveDemands(request, [entry, ...keys], replay?.packet).slice(1),
        ).map(answer);
        keys.forEach((key, index) => {
          if (got[index] !== expected[index])
            differing.push(`${name}: ${key} from ${entry}${reverseWorklist ? " reversed" : ""}`);
        });
      }
  }
  return { components: solved.length, differing, layered };
}

export const layerRequest = (source: string): CoreAnalysisRequest => {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  return request;
};
