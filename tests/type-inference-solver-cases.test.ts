import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import { solve } from "../src/type-inference/solver/solve.js";
import { solutionSummary } from "./helpers/solver-text.js";
import { request } from "./helpers/type-inference-graph.js";

/**
 * The solver against the executable reference model (O4 stage 3a, work note §3): every case of the research folder's
 * `model/cases.jsonl` (Astra's design-review cases of rounds r2 to r7 and the lead's cases of the r7 repair), with
 * the interpretation the model reached under every permuted worklist order, is solved by the real solver, which
 * must reach the same interpretation of every binding and function result and the same operation statuses, and
 * must be at a fixpoint when it stops. The fixture is regenerated from the model's run (`model/solver-cases.jsonl`).
 */

const FIXTURE = new URL("../../tests/fixtures/type-inference/solver-cases.jsonl", import.meta.url);
const GLOBALS = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

interface SolverCase {
  readonly name: string;
  readonly source: string;
  readonly model: { readonly summary: string; readonly operations: string };
}

function readCases(): readonly SolverCase[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      // EVIDENCE: fixture: the solver cases are written by the reference model's run with these three fields.
      const parsed = JSON.parse(line) as SolverCase;
      return parsed;
    });
}

const cases = readCases();

test("the solver reaches the reference model's interpretation on every case", () => {
  const relations = operationRelations();
  const failures: string[] = [];
  for (const c of cases) {
    const made = request([{ path: "main.tease", source: c.source }], GLOBALS, []);
    assert.notEqual(made, null, `${c.name} parses and resolves`);
    const solution = solve(collectGraph(made!), { relations, verify: true });
    const summary = solutionSummary(solution);
    const statuses = solution.statuses.join(",");
    if (summary !== c.model.summary || statuses !== c.model.operations)
      failures.push(
        `${c.name}\n  solver: ${summary} | ${statuses}\n  model:  ${c.model.summary} | ${c.model.operations}`,
      );
  }
  assert.equal(
    failures.length,
    0,
    `${failures.length} of ${cases.length} cases differ:\n${failures.join("\n")}`,
  );
});
