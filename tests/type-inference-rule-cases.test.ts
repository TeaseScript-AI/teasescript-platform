import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import { exportFacts } from "../src/type-inference/solver/export.js";
import { solve } from "../src/type-inference/solver/solve.js";
import { request } from "./helpers/type-inference-graph.js";

/**
 * The rule-derived cases (O4 stage 3a, work note §7, D2): for each decided rule (Q3.x, option B, the copy of a written
 * type, the two external findings) a source whose expected binding facts are written from the rule's text in
 * `owner-decisions.md`, not from the model's or the legacy's output. The solver's export must give exactly those
 * texts; a case without expectations must still solve. This is the check that agreement with the model is not taken
 * for correct semantics.
 */

const FIXTURE = new URL("../../tests/fixtures/type-inference/rule-cases.jsonl", import.meta.url);
const GLOBALS = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

interface RuleCase {
  readonly rule: string;
  readonly name: string;
  readonly source?: string;
  readonly files?: readonly { readonly path: string; readonly source: string }[];
  readonly expect: Readonly<Record<string, string>>;
  readonly why: string;
}

const cases: readonly RuleCase[] = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => {
    // EVIDENCE: fixture: the rule cases are written by the lead with these fields.
    const parsed = JSON.parse(line) as RuleCase;
    return parsed;
  });

test("every rule-derived case exports the facts the decided rule gives", () => {
  const relations = operationRelations();
  const failures: string[] = [];
  for (const c of cases) {
    const made = request(c.files ?? [{ path: "main.tease", source: c.source ?? "" }], GLOBALS, []);
    assert.notEqual(made, null, `${c.name} parses and resolves`);
    const facts = exportFacts(solve(collectGraph(made!), { relations, verify: true }));
    for (const [name, text] of Object.entries(c.expect)) {
      const found = facts.bindings.find((b) => b.name === name);
      if (found === undefined) failures.push(`${c.name} (${c.rule}): no binding ${name}`);
      else if (found.type !== text)
        failures.push(
          `${c.name} (${c.rule}): ${name} is ${found.type}, the rule gives ${text}: ${c.why}`,
        );
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.ok(cases.length >= 25, `rule cases: ${cases.length}`);
});
