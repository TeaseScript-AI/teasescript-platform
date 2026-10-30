import test from "node:test";
import assert from "node:assert/strict";
import { makeType, fits, witnesses, list, typeSignature, expectedPlanType } from "../lib/model.mjs";
import { generate, render } from "../families/s8-stores.mjs";
import { makePlan, validatePlan, configurations } from "../lib/plan.mjs";
import { hash } from "../lib/json.mjs";

for (const leaf of ["integer", "string", "boolean"])
  for (const nullable of ["none", "leaf", "root"])
    test(`model ${leaf}/${nullable}`, () => {
      const type = makeType({ leaf, nullable, depth: 2 }),
        values = witnesses(type);
      assert.ok(values.some((x) => x.allowed));
      assert.ok(values.some((x) => !x.allowed));
      assert.equal(fits(type, list([])), true);
      assert.equal(fits(type, list([list([])])), true);
      assert.equal(fits(type, null), nullable === "root");
      assert.equal(fits(type, list([list([null])])), nullable === "leaf");
      assert.equal(typeSignature(type), typeSignature(expectedPlanType(type)));
      for (const x of values) assert.equal(x.allowed, fits(type, x.value));
    });
test("generator has unique source identities, bounded types and true host site", () => {
  const cases = generate();
  assert.equal(cases.length, 90);
  assert.equal(new Set(cases.map((x) => x.sourceHash)).size, 90);
  for (const c of cases) {
    assert.equal(c.source.slice(c.site.start, c.site.end), "hostValue");
    assert.equal(c.sourceHash, hash(c.source));
    assert.deepEqual(render(c.dimensions), c);
  }
});
for (const profile of ["quick", "focused", "deep"])
  test(`deterministic ${profile}`, () => {
    const a = makePlan(profile, 42),
      b = makePlan(profile, 42);
    assert.deepEqual(a, b);
    validatePlan(a);
    assert.equal(a.cases.length, profile === "quick" ? 12 : 90);
    if (profile !== "quick") assert.equal(a.coverage.missing.length, 0);
  });
test("seed changes data without changing semantic axes", () => {
  const a = generate(3),
    b = generate(4);
  assert.deepEqual(
    a.map((x) => x.dimensions),
    b.map((x) => x.dimensions),
  );
  assert.notEqual(a[0].sourceHash, b[0].sourceHash);
});
test("shards are disjoint and exhaustive", () => {
  const plan = makePlan("quick"),
    all = configurations(plan),
    parts = [0, 1, 2].flatMap((index) => configurations(plan, { index, total: 3 }));
  assert.equal(new Set(parts.map((x) => x.id)).size, all.length);
  assert.deepEqual(parts.map((x) => x.id).sort(), all.map((x) => x.id).sort());
});
test("tampered expectation and rehashed plan are rejected", () => {
  const p = makePlan("quick");
  p.cases[0].inputs[0].allowed = false;
  const { planHash, ...body } = p;
  p.planHash = hash(body);
  assert.throws(() => validatePlan(p));
});
for (const profile of ["typo", ""])
  test(`reject unknown profile ${profile}`, () => assert.throws(() => makePlan(profile)));
for (const seed of [-1, 1.5, NaN, 2 ** 33])
  test(`reject invalid seed ${seed}`, () => assert.throws(() => makePlan("quick", seed)));
test("reject invalid shard", () =>
  assert.throws(() => configurations(makePlan(), { index: 2, total: 2 })));
test("independent integer predicate rejects decimals and unsafe integers", () => {
  assert.equal(fits({ kind: "integer" }, 1.5), false);
  assert.equal(fits({ kind: "integer" }, Number.MAX_SAFE_INTEGER + 1), false);
});
