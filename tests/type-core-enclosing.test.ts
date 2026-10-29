import assert from "node:assert/strict";
import test from "node:test";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import {
  allowancesOf,
  enclosingFamily,
  enclosingProblems,
  MODES,
  type EnclosingCase,
  type Relation,
} from "./helpers/type-core-enclosing.js";
import { collection, fits, name, type Form } from "./helpers/type-core-written.js";

const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});
const integers = (depth: number): Form =>
  depth === 0 ? name("integer") : collection("list", integers(depth - 1));

/** A witness as a case of the family: its store's value and destination, its form, the values it runs. */
function witness(
  source: string,
  value: string,
  binding: string,
  depth: number,
  values: readonly SerializableRuntimeValue[],
): EnclosingCase {
  const start = source.lastIndexOf(value);
  const form = integers(depth);
  return {
    name: source,
    source,
    into: { binding, path: [] },
    site: { start, end: start + value.length },
    form,
    written: !source.includes(`let ${binding} =`),
    values: values.map((each) => ({ value: each, fits: fits(form, each) })),
    host: value === "hostValue",
    slice: true,
  };
}

/**
 * #1416, the owner's witnesses through the candidate's compile and run (`enclosingProblems`): where a decision below a
 * store's own path stops, the store is checked against its destination's whole type, written or the one a copy
 * decides (A4), before the next effect, a value that fits playing on, in source order. In every order the oracle holds:
 * where a decision stopping in the restarted pass stops the analysis before admission settled (TABLE r4.183), a copy's
 * store is marked with its type undecided instead, as every store into an inferred place is (r4.100, #1252).
 */
test("a store above a stopped decision is checked against its destination's whole type (#1416)", () => {
  const nested = list(list("bad"));
  const witnesses: readonly (readonly [EnclosingCase, readonly number[]])[] = [
    [
      witness(
        'let xs: integer[][] = [[1]]\nsay "BEFORE"\nxs = [["bad"]]\nsay "AFTER"\nexit\n',
        '[["bad"]]',
        "xs",
        2,
        [nested],
      ),
      [64],
    ],
    [
      witness(
        'let seed: integer[] = [1]\nsay "BEFORE"\nseed = ["bad"]\nsay "AFTER"\nexit\n',
        '["bad"]',
        "seed",
        1,
        [list("bad")],
      ),
      [1, 32, 128],
    ],
    [
      witness(
        'let original: integer[][] = [[1]]\nlet target = original\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
        "hostValue",
        "target",
        2,
        [list(list(1)), nested, list("bad"), list(list(1), list(2, "bad")), "bad"],
      ),
      [64],
    ],
  ];
  for (const [c, allowances] of witnesses)
    for (const allowance of allowances)
      for (const mode of MODES) {
        const verdict = enclosingProblems(c, allowance, mode);
        const where = `${mode.name}, ${allowance}: ${c.source}`;
        assert.deepEqual(verdict.problems, [], where);
        if (mode === MODES[0])
          assert.deepEqual([verdict.relation, verdict.judged], ["above", "domain"], where);
      }
});

/**
 * #1416's family (`enclosingFamily`) at its anchors: each origin's host replacement trying every value of
 * `integer[][]`, and a forbidden nested leaf stored as a literal, a written one's declaration too; at the analysis an
 * argument, a dead call's argument and a return of `integer[][]`, and a written dict's and set's replacement (an add's
 * levels part only in the worker's reversed orders). Each at every allowance around the work of each decision of the
 * store's binding, in source order. Each origin reaches a stop below the store's own path, a sibling's alone included,
 * and no verdict has a problem: a forbidden value rejected before the next effect and a fitting one played, the whole
 * type planned or recorded, one owned mark at the store (an object a literal decides: its mark), none beside its
 * rejection.
 */
test("every store above a stopped decision keeps its check whole or its owned mark (#1416)", () => {
  const forbidden =
    /(literal|declaration) (\[\["bad"\]\]|\{items: \[\["bad"\]\]\}|\["bad"\]|dict\{a: \["bad"\]\}|set\[\["bad"\]\])$/u;
  const anchors = enclosingFamily(true).filter(
    (c) =>
      (c.host || forbidden.test(c.name)) &&
      (c.slice
        ? c.name.includes(", integer[][], ")
        : /^((dead )?argument|return), integer\[\]\[\], |^written collection, /u.test(c.name)),
  );
  const reached = new Map<string, Set<Relation | "sibling">>();
  for (const c of anchors) {
    const origin = c.name.slice(0, c.name.indexOf(","));
    const mode = MODES[0]!;
    const relations = reached.get(origin) ?? new Set();
    reached.set(origin, relations);
    for (const allowance of [null, ...allowancesOf(c, mode, true)]) {
      const verdict = enclosingProblems(c, allowance, mode);
      assert.deepEqual(verdict.problems, [], `${c.name} at ${allowance}`);
      relations.add(
        verdict.relation === "none" && verdict.stops.length > 0 ? "sibling" : verdict.relation,
      );
    }
  }
  assert.equal(reached.size, 11);
  for (const [origin, relations] of reached)
    assert.ok(relations.has("above"), `${origin} reaches no stop below its store`);
  assert.ok(reached.get("sibling property")!.has("sibling"));
});
