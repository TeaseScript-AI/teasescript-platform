import assert from "node:assert/strict";
import test from "node:test";

import { createXorShift32State, nextXorShift32 } from "../../../src/runtime/random/random.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import type { CoreAnalysisRequest } from "../../../src/type-inference/core/program.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { readFixture } from "../../helpers/type-core/type-core-fixture.js";
import { narrowingPass } from "../../helpers/type-core/type-core-narrowing.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import {
  canonical,
  componentDifferences,
  layerRequest,
} from "../../helpers/type-core/type-core-solver-setup.js";

/*
 * The determinism of the coarse core (ADR 0021 1.6; the port plan's S3 note): the answers depend on the program,
 * never on the order the analysis visits its consumers or discovers its demands. Every record of the expectation set
 * is analysed in four orders; every component of demands the set produces is solved again from each member as the
 * entry, in the canonical and the reverse order, and each member's answer compared by its items' signature and the
 * ingress stores its external items name.
 */

/** The set's requests, one per exact input (its files in order), each with the names of the records that give it. */
const requests = (() => {
  const byInput = new Map<string, { names: string[]; request: CoreAnalysisRequest }>();
  for (const record of readFixture()) {
    const input = JSON.stringify(record.files);
    const known = byInput.get(input);
    if (known !== undefined) known.names.push(record.name);
    else {
      const request = coreRequest(record.files);
      assert.ok(request !== null, `${record.name}: its files parse and resolve`);
      byInput.set(input, { names: [record.name], request });
    }
  }
  return [...byInput.values()];
})();

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

test("every record has one result in the source order, the reverse order and two seeded orders", () => {
  const orders: readonly [string, <T>(list: readonly T[]) => T[]][] = [
    ["reverse", (list) => [...list].reverse()],
    ["seed 1", shuffled(1)],
    ["seed 2", shuffled(2)],
  ];
  const differing: string[] = [];
  for (const { names, request } of requests) {
    const forward = canonical(compactAnalysis(request));
    for (const [order, visit] of orders)
      if (canonical(withConsumerOrder(visit, () => compactAnalysis(request))) !== forward)
        differing.push(...names.map((name) => `${name} (${order})`));
  }
  assert.deepEqual(differing, []);
});

test("every component is solved alike from each member as the entry and in either order", () => {
  let components = 0;
  const differing: string[] = [];
  for (const { names, request } of requests) {
    const found = componentDifferences(names.join(", "), request);
    components += found.components;
    differing.push(...found.differing);
  }
  assert.ok(components > 0, "the set produces components");
  assert.deepEqual(differing, []);
});

/**
 * #1398 (Codex r6 on #1558): F10's copy of a range's elements composes its kind's declared elements beside the mark that
 * it may hold none in their one order where it is composed (`contractOfOp`), before any publication orders it again:
 * `[integer, empty]`, in the four modes.
 */
test("a range conversion's contract composes its elements in their one order (#1398)", () => {
  const request = layerRequest("let a = (1..5).toList()\nsay a[0]\nexit");
  for (const mode of MODES)
    inMode(mode, () => {
      const pass = narrowingPass(request);
      const conversion = [...pass.program.opOf.values()].find(
        (c) => c.kind === "operation" && c.contract.name === "toList",
      )!;
      const items = pass.solver.run(
        pass.contract.contractOfValueAt(conversion.result, ["element"]),
      );
      assert.deepEqual(
        items.map((item) => item.tag),
        ["integer", "empty"],
        JSON.stringify(mode),
      );
    });
});
