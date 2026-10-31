import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { certificate } from "../lib/certificate.mjs";
import { typeText } from "../lib/model.mjs";
import { generate } from "../families/s8-stores.mjs";
import { makePlan, validatePlan, configurations } from "../lib/plan.mjs";
import { ruleControl, ruleHolds } from "../lib/rules.mjs";
import { readJson } from "../lib/json.mjs";
import { scopeOf } from "../adapters/compiler.mjs";

/** The type `certificate` proves at a source's `hostValue` store, as text, or `null`. */
function proved(lines) {
  const source = [...lines, 'say "AFTER"', "exit", ""].join("\n");
  const start = source.lastIndexOf("hostValue");
  const type = certificate(source, { start, end: start + "hostValue".length });
  return type === null ? null : typeText(type);
}
const written = 'let origin: string[][] = [["a"]]';
// (each kind of certificate #1440 names, TABLE r4.200: what proves the destination's type and what does not)
const kinds = {
  "a written destination": [
    [[written, "origin = hostValue"], "string[][]"],
    [["let origin: integer?[] = [1]", "origin = hostValue"], "integer?[]"],
    [['let origin = [["a"]]', "origin = hostValue"], null],
    [["let origin: number[] = [1.5]", "origin = hostValue"], null],
  ],
  "a copy": [
    [[written, "let target = origin", "target = hostValue"], "string[][]"],
    [['let origin = [["a"]]', "let target = origin", "target = hostValue"], null],
    [['let target = [["a"]]', "target = hostValue"], null],
    [["let target = hostValue", "target = hostValue"], null],
  ],
  "a copy of a copy": [
    [
      [written, "let stage: string[][] = origin", "let target = stage", "target = hostValue"],
      "string[][]",
    ],
    [[written, "let stage = origin", "let target = stage", "target = hostValue"], null],
  ],
  "a property a copy decides": [
    [[written, "let box = {payload: origin}", "box.payload = hostValue"], "string[][]"],
    [
      [
        written,
        'let box = {outer: {payload: origin}, other: "ok"}',
        "box.outer.payload = hostValue",
      ],
      "string[][]",
    ],
    [['let box = {payload: [["a"]]}', "box.payload = hostValue"], null],
    [
      [written, "let stage = origin", "let box = {payload: stage}", "box.payload = hostValue"],
      null,
    ],
    [[written, "let box = {other: origin}", "box.payload = hostValue"], null],
    [[written, "let box = {payload: origin, payload: origin}", "box.payload = hostValue"], null],
    [[written, "let box = {payload: origin}", "box = hostValue"], null],
    [[written, "let box = [origin]", "box[0] = hostValue"], null],
  ],
};
for (const [kind, cases] of Object.entries(kinds))
  test(`the certificate of ${kind}, read from the source`, () => {
    assert.ok(cases.some(([, type]) => type !== null) && cases.some(([, type]) => type === null));
    for (const [lines, type] of cases) assert.equal(proved(lines), type, lines.join("; "));
  });

test("the family's written, copy and field carriers are certified, its chain and index ones are not", () => {
  for (const c of generate()) {
    const type = certificate(c.source, c.site);
    const expected = ["written", "copy", "field"].includes(c.dimensions.carrier);
    assert.equal(type === null ? null : typeText(type), expected ? typeText(c.type) : null, c.id);
  }
});

test("a plan names no rule by default and records the ones it names, its configurations unchanged", () => {
  const plain = makePlan("quick"),
    ruled = makePlan("quick", 1442, ["1440"]);
  assert.equal("rules" in plain, false);
  assert.deepEqual(ruled.rules, ["1440"]);
  assert.notEqual(ruled.planHash, plain.planHash);
  validatePlan(ruled);
  assert.deepEqual(
    configurations(ruled).map((x) => [x.id, x.rules]),
    configurations(plain).map((x) => [x.id, ["1440"]]),
  );
  assert.equal(
    configurations(plain).some((x) => "rules" in x),
    false,
  );
  for (const rules of [["1252"], ["1440", "1440"], ["toString"], "1440", [1440]])
    assert.throws(() => makePlan("quick", 1442, rules), /rule/);
  assert.throws(() => validatePlan({ ...plain, rules: [] }));
});

test("rule 1440's control holds only where its store at its stop is checked against its whole type", () => {
  const control = ruleControl("1440");
  assert.equal(certificate(control.case.source, control.case.site) !== null, true);
  const row = (relation, phase, plannedType) => ({ scope: { relation, phase }, plannedType });
  assert.equal(ruleHolds("1440", row("at-or-below", "settled", "list<list<integer>>")), true);
  // (as on `bf9b655a9`, before #1440: the store at its stop has no check)
  assert.equal(ruleHolds("1440", row("at-or-below", "settled", "any")), false);
  assert.equal(ruleHolds("1440", row("strictly-above", "settled", "list<list<integer>>")), false);
  assert.equal(ruleHolds("1440", row("at-or-below", "unsettled", "list<list<integer>>")), false);
  assert.equal(ruleHolds("1440", { status: "ERROR" }), false);
});

test("a store at or below a stop is judged only under rule 1440, where certified and not inherited before admission settled", () => {
  const scope = (carrier, rules, { stop = [], settled = true } = {}) => {
    const c = generate().find(
      (x) =>
        x.dimensions.carrier === carrier &&
        x.dimensions.depth === 2 &&
        x.dimensions.nullable === "none",
    );
    // (a stand-in for the compiler's graph and decisions: the destination's place and one stopped decision there)
    const api = {
      CoreProgram: class {
        places = [
          {
            id: 7,
            label: c.destination.binding,
            kind: { kind: "binding", name: c.destination.binding },
          },
        ];
      },
      propertyStep: (name) => `.${name}`,
    };
    const answer = {
      budget: {
        decisions: [{ place: 7, path: stop, stopped: true }],
        exhausted: settled ? null : "program",
        settled,
      },
    };
    return scopeOf(api, null, answer, c, rules);
  };
  assert.deepEqual(Object.keys(scope("field", [])), [
    "relation",
    "phase",
    "reason",
    "stops",
    "target",
  ]);
  assert.equal(scope("field", []).reason, "exact-target-stop-1440");
  assert.equal(scope("field", ["1440"]).reason, null);
  assert.equal(scope("field", ["1440"]).certified, true);
  assert.equal(scope("written", ["1440"]).reason, null);
  assert.equal(scope("written", ["1440"], { settled: false }).reason, null);
  assert.equal(scope("chain", ["1440"]).reason, "exact-target-stop-1440");
  assert.equal(scope("chain", ["1440"]).certified, false);
  assert.equal(scope("field", ["1440"], { settled: false }).reason, "exact-target-stop-1440");
  assert.equal(scope("field", ["1440"], { settled: false }).certified, true);
  // (a stop below the store and an inferred destination before admission settled keep their reasons)
  const above = scope("field", ["1440"], { stop: [".payload", "element"] });
  assert.deepEqual(
    [above.relation, above.reason, "certified" in above],
    ["strictly-above", null, false],
  );
  assert.equal(
    scope("copy", ["1440"], { stop: ["element"], settled: false }).reason,
    "unsettled-inherited-domain-1252",
  );
});

test("the plan command records --rules and rejects an unknown one", () => {
  const pilot = fileURLToPath(new URL("../bin/pilot.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "family-rules-"));
  try {
    const out = join(dir, "plan.json");
    const ok = spawnSync(process.execPath, [pilot, "plan", "--rules", "1440", "--out", out], {
      encoding: "utf8",
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(readJson(out).rules, ["1440"]);
    const bad = spawnSync(process.execPath, [pilot, "plan", "--rules", "1252", "--out", out], {
      encoding: "utf8",
    });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Unknown or repeated rule/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
