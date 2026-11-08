import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NOT_PINS,
  PIN_SUITES,
  builtOf,
  groundRefusals,
  pinFormsOf,
  refusalsOf,
  rePinsOf,
  suitesFor,
  testFiles,
} from "./pin-suites.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("a core change lists every pinning suite; another change lists none, a suite's own change or its pins' file itself", () => {
  assert.deepEqual(suitesFor(["src/type-inference/core/admission/literals.ts"]), PIN_SUITES);
  assert.deepEqual(suitesFor(["src/runtime/engine.ts", "docs/TESTING.md"]), []);
  assert.deepEqual(suitesFor(["src/type-inference/core-like.ts"]), []);
  assert.deepEqual(
    suitesFor(["tests/type-core-kept.test.ts"]).map((suite) => suite.file),
    ["tests/type-core-kept.test.ts"],
  );
  assert.deepEqual(
    suitesFor(["tests/helpers/type-core-families.ts"]).map((suite) => suite.file),
    ["tests/type-core-work-b.test.ts"],
  );
  assert.equal(builtOf("tests/type-core-closure.test.ts"), "dist/tests/type-core-closure.test.js");
});

test("the list is kept true: each file a pin form finds is declared, each declared suite's pin and ground still find a line", () => {
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
  for (const suite of PIN_SUITES) {
    const lines = readFileSync(join(ROOT, suite.in ?? suite.file), "utf8").split("\n");
    for (const found of [suite.pin, suite.ground].filter((regex) => regex !== undefined))
      assert.ok(
        lines.some((line) => found.test(line)),
        `${suite.in ?? suite.file} holds no line ${found} finds (${suite.file})`,
      );
  }
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

const suite = (name) =>
  PIN_SUITES.find((entry) => entry.file === `tests/type-core-${name}.test.ts`);

// (as the closure suite writes its table: a top-level block opened by its ground, each row a name, a source, the totals)
const HEAD = [
  "});", // 1
  "", // 2
  "/**", // 3
  " * every unit charged as on `main` at `abc`", // 4
  " */", // 5
  "const OUTSIDE: readonly (readonly [string, string, readonly number[]])[] = [", // 6
  "  [", // 7
  '    "an add",', // 8
  "    'let xs = [1]\\nsay xs\\nexit',", // 9
  "    [684, 1020, 684, 852, 1071, 1198, 1002, 1121],", // 10
  "  ],", // 11
  "  // (18 units more at demand 64 since #1828)", // 12
  "  [", // 13
  '    "a list join",', // 14
  "    [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],", // 15
  "  ],", // 16
  "];", // 17
  "const SIZES = [", // 18
  "  [16, 32],", // 19
  "];", // 20
].join("\n");
const rePin = (comment) =>
  [
    "@@ -15 +15 @@",
    "-    [20044, 21252, 19818, 21009, 32902, 34371, 32052, 33430],",
    "+    [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],",
    ...(comment ? ["@@ -11,0 +12 @@", "+  // (18 units more at demand 64 since #1828)"] : []),
  ].join("\n");

test("a re-pin whose ground changed passes; one whose ground did not is refused, naming its line and where to write", () => {
  assert.deepEqual(refusalsOf("t.test.ts", HEAD, rePin(true), suite("closure")), []);
  const [refusal, ...more] = refusalsOf("t.test.ts", HEAD, rePin(false), suite("closure"));
  assert.deepEqual(more, []);
  assert.match(
    refusal,
    /^t\.test\.ts:15: re-pinned \(32920, 34389, 32070, 33448\) with no change to its ground/u,
  );
  assert.match(refusal, /directly above it \(lines 12–14\), or in its header \(lines 3–5\)/u);
  assert.match(refusal, /N units more since #/u);
  const header = `${rePin(false)}\n@@ -4 +4 @@\n- * every unit charged as on \`main\` at \`old\`\n+ * every unit charged as on \`main\` at \`abc\``;
  assert.deepEqual(refusalsOf("t.test.ts", HEAD, header, suite("closure")), []);
});

test("a number changed in a pin's source or outside its pins, a renamed row and a listed count are no re-pins", () => {
  const source =
    "@@ -9 +9 @@\n-    'let xs = [2]\\nsay xs\\nexit',\n+    'let xs = [1]\\nsay xs\\nexit',";
  assert.deepEqual(refusalsOf("t.test.ts", HEAD, source, suite("closure")), []);
  const size = "@@ -19 +19 @@\n-  [16, 64],\n+  [16, 32],";
  assert.deepEqual(rePinsOf(size).rePins.length, 1);
  assert.deepEqual(refusalsOf("t.test.ts", HEAD, size, suite("closure")), []);
  const renamed = '@@ -14 +14 @@\n-    "a join",\n+    "a list join",';
  assert.deepEqual(rePinsOf(renamed).rePins, []);
  // (a listed-site count is named by its reason, so its file is not read for re-pins)
  const kept = "tests/type-core-kept.test.ts";
  const count = '@@ -2 +2 @@\n-  first: [1, "a reason"],\n+  first: [2, "a reason"],';
  const listed = ["const LISTED = {", '  first: [2, "a reason"],', "};"].join("\n");
  assert.deepEqual(refusalsOf(kept, listed, count, suite("kept")).length, 1);
  assert.deepEqual(
    groundRefusals(
      [kept],
      () => listed,
      () => count,
    ),
    [],
  );
});

test("a pin's ground may be its test's header or its start; a counter snapshot is a pin; a helper's table has its own ground", () => {
  const work = [
    "/**", // 1
    " * main's work, measured on abc", // 2
    " */", // 3
    'test("work", () => {', // 4
    "  // (the counters as main's)", // 5
    "  const cases = [", // 6
    '    ["a place", "let a = {n: 1}\\nexit", "checks 142 invSteps 105"],', // 7
    '    "checks 142 invSteps 105",', // 8
    "  ];", // 9
    "});", // 10
  ].join("\n");
  const snapshot = '@@ -8 +8 @@\n-    "checks 142 invSteps 103",\n+    "checks 142 invSteps 105",';
  const [refusal] = refusalsOf("t.test.ts", work, snapshot, suite("work-c"));
  assert.match(
    refusal,
    /:8: re-pinned \(105\).*directly above it \(lines 5–7\), or in its header \(lines 1–3, line 5\)/su,
  );
  for (const ground of [
    "@@ -2 +2 @@\n- * main's work, measured on old\n+ * main's work, measured on abc",
    "@@ -5 +5 @@\n-  // (old)\n+  // (the counters as main's)",
  ])
    assert.deepEqual(refusalsOf("t.test.ts", work, `${snapshot}\n${ground}`, suite("work-c")), []);
  const families = [
    "  /** main's work, measured on abc */", // 1
    "  readonly main: Readonly<Record<16 | 32, readonly number[][]>>;", // 2
    "}", // 3
    "", // 4
    "export const FAMILIES = [", // 5
    "  {", // 6
    "    main: {", // 7
    "      16: [", // 8
    "        [51209, 4782, 6799],", // 9
    "      ],", // 10
    "    },", // 11
    "  },", // 12
    "];", // 13
  ].join("\n");
  const row = "@@ -9 +9 @@\n-        [51208, 4782, 6799],\n+        [51209, 4782, 6799],";
  assert.match(refusalsOf("f.ts", families, row, suite("work-b"))[0], /in its header \(line 1\)/u);
  const ground =
    "@@ -1 +1 @@\n-  /** main's work, measured on old */\n+  /** main's work, measured on abc */";
  assert.deepEqual(refusalsOf("f.ts", families, `${row}\n${ground}`, suite("work-b")), []);
});

test("a call's argument in a pin is an input, and an unrelated top-level block's comment is no pin's header", () => {
  const table = [
    "/** a fixture count */", // 1
    "const COUNT = 1;", // 2
    "", // 3
    "/** every unit as on `main` at `abc` */", // 4
    "const frozen = 1;", // 5
    "const OUTSIDE = [", // 6
    '  ["the chain", chain(16), [11837, 12196, 11837, 12196]],', // 7
    "];", // 8
  ].join("\n");
  const at = (base, head) => `@@ -7 +7 @@\n-  ["the chain", ${base}],\n+  ["the chain", ${head}],`;
  const input = at(
    "chain(32), [11837, 12196, 11837, 12196]",
    "chain(16), [11837, 12196, 11837, 12196]",
  );
  assert.deepEqual(refusalsOf("t.test.ts", table, input, suite("closure")), []);
  const row = at(
    "chain(16), [11836, 12196, 11837, 12196]",
    "chain(16), [11837, 12196, 11837, 12196]",
  );
  const [refusal, ...more] = refusalsOf("t.test.ts", table, row, suite("closure"));
  assert.deepEqual(more, []);
  assert.match(refusal, /:7: re-pinned \(11837\).*in its header \(line 4\)/su);
  const unrelated = `${row}\n@@ -1 +1 @@\n-/** a count */\n+/** a fixture count */`;
  assert.equal(refusalsOf("t.test.ts", table, unrelated, suite("closure")).length, 1);
  const ground = `${row}\n@@ -4 +4 @@\n-/** every unit as on \`main\` at \`old\` */\n+/** every unit as on \`main\` at \`abc\` */`;
  assert.deepEqual(refusalsOf("t.test.ts", table, ground, suite("closure")), []);
});
