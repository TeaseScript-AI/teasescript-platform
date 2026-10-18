import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import { exportFacts } from "../src/type-inference/solver/export.js";
import type { CellId } from "../src/type-inference/solver/cells.js";
import { solve, type Solution } from "../src/type-inference/solver/solve.js";
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
  /** The operation statuses the rule gives (`<family>.<name>@<site>:none|partial(i/n)`), when the rule is about validity. */
  readonly statuses?: readonly string[];
  /**
   * The bindings the rule puts in conflict, each with the families of the conflicting evidence in rank order, the
   * working one first (`{"x": ["string", "integer"]}`); a binding is in conflict when its cell or a part of its
   * structure is. Every other binding must be free of conflict, so a positive case asserts absence by omission.
   */
  readonly conflicts?: Readonly<Record<string, readonly string[]>>;
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

/**
 * The bindings in conflict, by name, with the families of the first conflicting cell found walking the binding's
 * structure (the cell itself, then a collection's element cells and an object's property cells), working first. This
 * is the evidence the exported text hides: a conflict exports its working kind, so a lost conflict flag would leave
 * every exported type unchanged.
 */
function conflictsOf(solution: Solution): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const place of solution.graph.places) {
    if (place.kind.kind !== "binding" || place.kind.declared === "host" || place.site === null)
      continue;
    const seen = new Set<string>();
    const walk = (group: readonly CellId[]): readonly string[] | null => {
      const key = group.join("+");
      if (seen.has(key)) return null;
      seen.add(key);
      const view = solution.viewOf(group);
      if (view.kind === "conflict") return view.families;
      for (const member of view.members) {
        if (member.kind === "collection") {
          const found = walk(member.element);
          if (found !== null) return found;
        } else if (member.kind === "object")
          for (const cells of member.props.values()) {
            const found = walk(cells);
            if (found !== null) return found;
          }
      }
      return null;
    };
    const families = walk([place.id]);
    if (families !== null) out[place.kind.name] = families;
  }
  return out;
}

test("every rule-derived case exports the facts the decided rule gives", () => {
  const relations = operationRelations();
  const failures: string[] = [];
  for (const c of cases) {
    const made = request(c.files ?? [{ path: "main.tease", source: c.source ?? "" }], GLOBALS, []);
    assert.notEqual(made, null, `${c.name} parses and resolves`);
    const solution = solve(collectGraph(made!), { relations, verify: true });
    const facts = exportFacts(solution);
    const conflicts = conflictsOf(solution);
    const expectedConflicts = JSON.stringify(c.conflicts ?? {});
    if (JSON.stringify(conflicts) !== expectedConflicts)
      failures.push(
        `${c.name} (${c.rule}): conflicts ${JSON.stringify(conflicts)}, the rule gives ${expectedConflicts}: ${c.why}`,
      );
    if (c.statuses !== undefined && solution.statuses.join(",") !== c.statuses.join(","))
      failures.push(
        `${c.name} (${c.rule}): statuses ${solution.statuses.join(",") || "(none)"}, the rule gives ${c.statuses.join(",") || "(none)"}: ${c.why}`,
      );
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
});
