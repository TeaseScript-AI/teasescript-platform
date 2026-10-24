import assert from "node:assert/strict";
import test from "node:test";

import { createXorShift32State, nextXorShift32 } from "../src/runtime/random/random.js";
import { solveDemands } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import {
  ingressStores,
  itemsSignature,
  writerKey,
  type Item,
} from "../src/type-inference/core/items.js";
import { withSolverSeam, type SolvedMember } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { itemScope } from "./helpers/type-core-items.js";
import { readFixture } from "./helpers/type-core-fixture.js";

/**
 * The determinism of the coarse core (ADR 0021 1.6; the port plan's S3 note §1): the answers depend on the program,
 * never on the order the analysis visits its consumers or discovers its demands. Every record of the expectation set
 * is analysed in four orders; every component of demands the set produces is solved again from each member as the
 * entry, in the canonical and the reverse order, and each member's answer compared by its items' signature and the
 * ingress stores its external items name.
 */

const requests = readFixture().map((record) => {
  const request = coreRequest(record.files);
  assert.ok(request !== null, `${record.name}: its files parse and resolve`);
  return { name: record.name, request };
});

/** A seeded shuffle, for a consumer order no source order gives. */
function shuffled(seed: number): <T>(list: readonly T[]) => T[] {
  return (list) => {
    const random = createXorShift32State(seed);
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = Math.floor(nextXorShift32(random) * (index + 1));
      [copy[index], copy[other]] = [copy[other]!, copy[index]!];
    }
    return copy;
  };
}

/** A record as a multiset: its outcome, its diagnostics and its checks, each in a canonical order. */
function canonical(record: ReturnType<typeof compactAnalysis>): string {
  return JSON.stringify({
    outcome: record.outcome,
    diagnostics: record.diagnostics.map((entry) => JSON.stringify(entry)).sort(),
    checks: record.checks.map((entry) => JSON.stringify(entry)).sort(),
  });
}

test("every record has one result in the source order, the reverse order and two seeded orders", () => {
  const orders: readonly [string, <T>(list: readonly T[]) => T[]][] = [
    ["reverse", (list) => [...list].reverse()],
    ["seed 1", shuffled(1)],
    ["seed 2", shuffled(2)],
  ];
  const differing: string[] = [];
  for (const { name, request } of requests) {
    const forward = canonical(compactAnalysis(request));
    for (const [order, visit] of orders)
      if (canonical(withConsumerOrder(visit, () => compactAnalysis(request))) !== forward)
        differing.push(`${name} (${order})`);
  }
  assert.deepEqual(differing, []);
});

/** A member's answer as the component test compares it: its items' signature and their ingress stores. */
function answer(items: readonly Item[]): string {
  const stores = items
    .map((item) =>
      item.ingress === undefined ? "" : ingressStores(item.ingress).map(writerKey).join(","),
    )
    .sort();
  return `${itemsSignature(items, itemScope())} ${stores.join(";")}`;
}

test("every component is solved alike from each member as the entry and in either order", () => {
  let components = 0;
  const differing: string[] = [];
  for (const { name, request } of requests) {
    const solved: (readonly SolvedMember[])[] = [];
    withSolverSeam({ onComponent: (members) => solved.push(members) }, () =>
      compactAnalysis(request),
    );
    for (const members of solved) {
      components += 1;
      const keys = members.map((member) => member.key);
      const expected = members.map((member) => answer(member.items));
      for (const entry of keys)
        for (const reverseWorklist of [false, true]) {
          const got = withSolverSeam({ reverseWorklist }, () =>
            solveDemands(request, [entry, ...keys]).slice(1),
          ).map(answer);
          keys.forEach((key, index) => {
            if (got[index] !== expected[index])
              differing.push(`${name}: ${key} from ${entry}${reverseWorklist ? " reversed" : ""}`);
          });
        }
    }
  }
  assert.ok(components > 0, "the set produces components");
  assert.deepEqual(differing, []);
});
