import assert from "node:assert/strict";
import test from "node:test";

import {
  INSPECTION,
  RULES,
  obligations,
  transferCoverage,
  type Inspection,
} from "../helpers/player/rewind-transfer-domain.js";

/*
 * The generator of the rewind transfer domain's obligations (`helpers/player/rewind-transfer-domain.ts`) and its coverage
 * check: the count at this declaration, and that a removed rule or an added inspection state changes what a test must
 * run, which the coverage check then reports.
 */

const counted = (transition: string) =>
  obligations().filter((each) => each.transition === transition).length;

test("the declared rules give one obligation per case, variant, state and failed guard", () => {
  const all = obligations();
  assert.equal(all.length, 72);
  assert.equal(new Set(all.map((each) => each.key)).size, all.length, "keys are unique");
  for (const each of all) assert.ok(each.source.length > 0, `${each.key} has a source`);
  assert.deepEqual(
    Object.fromEntries(RULES.map((rule) => [rule.transition, counted(rule.transition)])),
    {
      back: 13,
      forward: 6,
      return: 4,
      "adopt begun": 8,
      "adopt ended": 16,
      "close by debugOff": 5,
      "close by replacement": 4,
      "close by import": 8,
      "close by clear": 4,
      "close by disposal": 4,
    },
  );
});

test("Forward with no future and Clear while inspecting or adopting are refusals", () => {
  const expect = (transition: string, inspection: Inspection) =>
    obligations()
      .filter((each) => each.transition === transition && each.inspection === inspection)
      .map((each) => each.expect.kind);
  assert.deepEqual(expect("forward", "inspecting without a future"), ["refused"]);
  for (const inspection of [
    "inspecting with a future",
    "inspecting without a future",
    "adopting",
  ] as const)
    assert.deepEqual(expect("close by clear", inspection), ["refused"], inspection);
});

test("a test that runs exactly the obligations passes the coverage check, and one that runs fewer or more fails", () => {
  const all = obligations();
  const keys = all.map((each) => each.key);
  assert.deepEqual(transferCoverage(all, keys), { missing: [], unexpected: [] });
  assert.deepEqual(transferCoverage(all, keys.slice(1)).missing, [keys[0]]);
  assert.deepEqual(transferCoverage(all, [...keys, "invented"]).unexpected, ["invented"]);
});

test("a removed rule, or an added inspection state, changes the obligations and is caught", () => {
  const all = obligations();
  const keys = all.map((each) => each.key);
  // Without Forward's rule, its obligations are no longer required: a test that still runs them is told so.
  const lessened = obligations(RULES.filter((rule) => rule.transition !== "forward"));
  assert.equal(lessened.length, all.length - counted("forward"));
  assert.equal(transferCoverage(lessened, keys).unexpected.length, counted("forward"));
  // A new inspection state adds obligations that a test written for the old declaration misses.
  // EVIDENCE: fixture: a state outside the declared ones, which is the change this case checks the generator against.
  const paused = "inspecting, paused at a draw" as Inspection;
  const widened = obligations(RULES, [...INSPECTION, paused]);
  assert.ok(widened.length > all.length);
  const { missing } = transferCoverage(widened, keys);
  assert.equal(missing.length, widened.length - all.length);
  assert.ok(missing.every((key) => key.includes("inspecting, paused at a draw")));
});
