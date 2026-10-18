import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { SolvedTypeFacts } from "../src/type-inference/backend.js";
import {
  describe,
  differential,
  mechanicalGroup,
  readLedger,
  recordKey,
  summarize,
  verdicts,
  type Verdict,
} from "./helpers/facts-differential.js";

/**
 * The facts differential of O4 stage 3a (work note §7, §10): every source of the accumulated case set is solved and
 * exported, its facts compared with the legacy's site by site, and every difference must be in the ledger with the
 * exact texts of both sides: accepted (a decided rule, a recorded design reading, a legacy bug now fixed) or deferred
 * to a group a later stage owes. A difference without a record, or one whose texts changed, fails; a changed fact at
 * an accepted, a deferred, a pinned and an arbitrary site is rejected (the mutation tests). The ledger itself must
 * point only at cases and sites that exist.
 */

const FIXTURE = new URL("../../tests/fixtures/type-inference/solver-cases.jsonl", import.meta.url);

interface SolverCase {
  readonly name: string;
  readonly source: string;
}

function readCases(): readonly SolverCase[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      // EVIDENCE: fixture: the solver cases are written by the reference model's run with these fields.
      const parsed = JSON.parse(line) as SolverCase;
      return parsed;
    });
}

const ledger = readLedger();

function allVerdicts(): {
  readonly verdicts: Verdict[];
  readonly seen: Set<string>;
  readonly compared: number;
} {
  const out: Verdict[] = [];
  const seen = new Set<string>();
  let compared = 0;
  for (const c of readCases()) {
    const result = differential(c.source);
    if (result === null) continue;
    compared += result.compared;
    for (const v of verdicts(ledger, c.name, result)) {
      seen.add(recordKey(c.name, v.difference));
      out.push(v);
    }
  }
  return { verdicts: out, seen, compared };
}

const sourceOf = (name: string): string => {
  const found = readCases().find((c) => c.name === name);
  assert.ok(found !== undefined, `the accumulated set has ${name}`);
  return found.source;
};

test("every difference on the accumulated cases is recorded in the ledger with its exact texts", () => {
  const { verdicts: all, compared } = allVerdicts();
  const failing = all.filter((v) => v.outcome === "unrecorded" || v.outcome === "changed");
  const report = [...summarize(all)].map(([key, count]) => `${count} ${key}`).join(", ");
  assert.ok(compared > 2000, `fact sites compared: ${compared}`);
  assert.deepEqual(
    failing.map((v) => `${v.outcome}: ${describe(v)}`),
    [],
    `differences outside the ledger (${report})`,
  );
  // the pins stand exactly at the sites of the mechanical groups (the facts a later stage computes), and a reviewed
  // record never at one of those: a binding of a straight-line source is always reviewed
  for (const v of all) {
    const mechanical = mechanicalGroup(v.straightLine, v.difference);
    if (v.record?.status === "deferred" && v.record.group in MECHANICAL)
      assert.equal(mechanical, v.record.group, describe(v));
    else assert.equal(mechanical, null, describe(v));
  }
});

const MECHANICAL: Record<string, true> = {
  "3b-values": true,
  "3c-functions": true,
  "3b-flow": true,
};

test("the ledger points only at cases and sites that exist, and every group it uses has a record", () => {
  const { seen } = allVerdicts();
  const stale = [...ledger.records.keys()].filter((key) => !seen.has(key));
  assert.deepEqual(stale, [], "records without a difference at their site");
  const groups = new Set(
    [...ledger.records.values()].flatMap((r) => (r.status === "deferred" ? [r.group] : [])),
  );
  assert.deepEqual(
    [...groups].filter((g) => !ledger.groups.has(g)),
    [],
    "deferred groups without a group record",
  );
  for (const record of ledger.records.values()) {
    assert.ok(
      record.status === "deferred" || record.reason.length > 0,
      `${recordKey(record.case, record)} has a reason`,
    );
    assert.ok(
      record.candidate !== null || record.legacy !== null,
      `${recordKey(record.case, record)} pins a text`,
    );
  }
});

const changeBinding =
  (name: string, text: string) =>
  (facts: SolvedTypeFacts): SolvedTypeFacts => ({
    ...facts,
    bindings: facts.bindings.map((b) => (b.name === name ? { ...b, type: text } : b)),
  });

const outcomes = (name: string, mutate?: (facts: SolvedTypeFacts) => SolvedTypeFacts) =>
  verdicts(ledger, name, differential(sourceOf(name), mutate)!)
    .filter((v) => v.difference.what === "binding")
    .map((v) => v.outcome);

test("a changed fact is rejected at an accepted site, a deferred site, a pinned value site and an arbitrary site", () => {
  // accepted: `held-later` (Q3.2a: `x = fromJson("1", default: 1)` holds x)
  assert.deepEqual(outcomes("held-later"), ["accepted"]);
  assert.deepEqual(outcomes("held-later", changeBinding("x", "string")), ["changed"]);
  assert.deepEqual(outcomes("held-later", changeBinding("x", "number")), ["changed"]);
  assert.deepEqual(
    outcomes("held-later", changeBinding("x", "integer")),
    [],
    "a fact equal to the legacy's is no difference",
  );
  // deferred with its final recorded: `copy-order` (the copy's value at its point, 3b)
  assert.deepEqual(outcomes("copy-order"), ["deferred"]);
  assert.deepEqual(outcomes("copy-order", changeBinding("b", "string")), ["changed"]);
  // a pinned value site: the expression facts of a straight-line source
  const pinned = differential(sourceOf("held-later"), (facts) => ({
    ...facts,
    values: facts.values.map((v, i) => (i === 0 ? { ...v, type: "never" } : v)),
  }))!;
  const values = verdicts(ledger, "held-later", pinned).filter(
    (v) => v.difference.what === "value",
  );
  assert.ok(values.some((v) => v.outcome === "changed" || v.outcome === "unrecorded"));
  // arbitrary: a source whose facts equal the legacy's has no record to hide behind
  assert.deepEqual(outcomes("widening", changeBinding("x", "string")), ["unrecorded"]);
});
