import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NOT_PINS,
  PIN_SUITES,
  builtOf,
  pinFormsOf,
  refusalsOf,
  rePinsOf,
  suitesFor,
  testFiles,
} from "./pin-suites.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("a core change lists every pinning suite; another change lists none, a suite's own change itself", () => {
  assert.deepEqual(suitesFor(["src/type-inference/core/admission/literals.ts"]), PIN_SUITES);
  assert.deepEqual(suitesFor(["src/runtime/engine.ts", "docs/TESTING.md"]), []);
  assert.deepEqual(suitesFor(["src/type-inference/core-like.ts"]), []);
  assert.deepEqual(
    suitesFor(["tests/type-core-kept.test.ts"]).map((suite) => suite.file),
    ["tests/type-core-kept.test.ts"],
  );
  assert.equal(builtOf("tests/type-core-closure.test.ts"), "dist/tests/type-core-closure.test.js");
});

test("the list is kept true: each file a pin form finds is declared, each declared suite still holds its mark", () => {
  const declared = new Set([...PIN_SUITES, ...NOT_PINS].map((entry) => entry.file));
  const unlisted = testFiles(ROOT).filter(
    (file) => !declared.has(file) && pinFormsOf(readFileSync(join(ROOT, file), "utf8")).length > 0,
  );
  assert.deepEqual(
    unlisted.map(
      (file) =>
        `${file} holds a pin form (${pinFormsOf(readFileSync(join(ROOT, file), "utf8")).join(", ")}) but is in neither PIN_SUITES nor NOT_PINS (tools/repository-checks/pin-suites.mjs)`,
    ),
    [],
  );
  for (const { file, mark } of PIN_SUITES)
    assert.ok(
      readFileSync(join(ROOT, file), "utf8").includes(mark),
      `${file} no longer holds ${mark}`,
    );
  for (const { file } of NOT_PINS)
    assert.ok(
      pinFormsOf(readFileSync(join(ROOT, file), "utf8")).length > 0,
      `${file} holds no pin form: drop it from NOT_PINS`,
    );
});

test("the three pin forms are found by their text, and a pin written another way is not", () => {
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 22_962_573);"), ["total"]);
  assert.deepEqual(pinFormsOf("    [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],"), [
    "table",
  ]);
  assert.deepEqual(pinFormsOf('  decide: [\n    6,\n    "a stopped decision\'s path"'), ["listed"]);
  // (the named limits: another assertion, a short total, a nested table)
  assert.deepEqual(pinFormsOf("  assert.strictEqual(budget.total, 22_962_573);"), []);
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 573);"), []);
  assert.deepEqual(pinFormsOf("    [7995, 60],\n    [7081, 60],"), []);
});

// (one entry as the closure suite writes its rows: the ground comment, the name, the source, the totals)
const HEAD = [
  'test("outside", () => {', // 1
  "  const OUTSIDE = [", // 2
  "    [", // 3
  '      "an add",', // 4
  "      [684, 1020, 684, 852, 1071, 1198, 1002, 1121],", // 5
  "    ],", // 6
  "    // (18 units more at demand 64 since #1828)", // 7
  "    [", // 8
  '      "a list join",', // 9
  "      [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],", // 10
  "    ],", // 11
  "  ];", // 12
  "});", // 13
].join("\n");
const rePin = (comment) =>
  [
    "@@ -10 +10 @@",
    "-      [20044, 21252, 19818, 21009, 32902, 34371, 32052, 33430],",
    "+      [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],",
    ...(comment ? ["@@ -6,0 +7 @@", "+    // (18 units more at demand 64 since #1828)"] : []),
  ].join("\n");

test("a re-pin whose ground changed passes; one whose ground did not is refused, naming its line and the block", () => {
  assert.deepEqual(refusalsOf("t.test.ts", HEAD, rePin(true)), []);
  const [refusal, ...more] = refusalsOf("t.test.ts", HEAD, rePin(false));
  assert.deepEqual(more, []);
  assert.match(
    refusal,
    /^t\.test\.ts:10: re-pinned \(32920, 34389, 32070, 33448\) with no change to its ground/u,
  );
  assert.match(refusal, /lines 7–9 above it/u);
  assert.match(refusal, /N units more since #/u);
});

test("a re-pin's ground may be its test's header; a line whose text changed is no re-pin", () => {
  const headed = `/**\n * main's work, measured on abc (N units more since #1)\n */\n${HEAD}`;
  const shifted = rePin(false).replace("@@ -10 +10 @@", "@@ -13 +13 @@");
  assert.equal(refusalsOf("t.test.ts", headed, shifted).length, 1);
  const header = `${shifted}\n@@ -2 +2 @@\n- * main's work, measured on abc\n+ * main's work, measured on abc (N units more since #1)`;
  assert.deepEqual(refusalsOf("t.test.ts", headed, header), []);
  const renamed = '@@ -9 +9 @@\n-      "a join",\n+      "a list join",';
  assert.deepEqual(rePinsOf(renamed).rePins, []);
});
