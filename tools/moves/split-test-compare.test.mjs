import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareSides, controlFailures } from "./split-test-compare.mjs";

const TOOL = fileURLToPath(new URL("./split-test-compare.mjs", import.meta.url));

/** A compiled test file holding `tests` (title → whether it passes). */
const testFile = (tests) =>
  [
    'const test = require("node:test");',
    ...Object.entries(tests).map(
      ([title, passes]) =>
        `test(${JSON.stringify(title)}, () => { ${passes ? "" : 'throw new Error("no");'} });`,
    ),
    "",
  ].join("\n");

/** The base (`old.test.js` and an unrelated file) and a head (`files`, under `dist/tests/`); `run` compares them. */
function trees(t, head, baseExtra = {}) {
  const root = mkdtempSync(join(tmpdir(), "split-test-compare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (tree, files) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) continue;
      mkdirSync(dirname(join(root, tree, "dist/tests", file)), { recursive: true });
      writeFileSync(join(root, tree, "dist/tests", file), text);
    }
  };
  const other = testFile({ unrelated: true });
  write("base", {
    "old.test.js": testFile({ first: true, second: true }),
    "other.test.js": other,
    ...baseExtra,
  });
  write("head", { "other.test.js": other, ...head });
  const run = (
    news = ["tests/split/one.test.ts", "tests/split/two.test.ts"],
    old = ["tests/old.test.ts"],
  ) => {
    const result = spawnSync(
      process.execPath,
      [
        TOOL,
        join(root, "base"),
        join(root, "head"),
        join(root, "out"),
        "--old",
        ...old,
        "--new",
        ...news,
      ],
      { encoding: "utf8" },
    );
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  return { root, run };
}

const SPLIT = {
  "split/one.test.js": testFile({ first: true }),
  "split/two.test.js": testFile({ second: true }),
};

test("a split whose files the suite finds, each test kept with its outcome, is equal", (t) => {
  const { root, run } = trees(t, SPLIT);
  const result = run();
  assert.equal(result.status, 0, result.out + result.err);
  assert.match(result.out, /^verdict: equal$/mu);
  assert.match(
    readFileSync(join(root, "out/compare.txt"), "utf8"),
    /^base: passed 2, failed 0, cancelled 0, skipped 0, todo 0; head: passed 2,/mu,
  );
  assert.equal(
    readFileSync(join(root, "out/head-titles.jsonl"), "utf8").trim().split("\n").length,
    2,
  );
  assert.equal(
    Object.keys(JSON.parse(readFileSync(join(root, "out/head-counts.json"), "utf8"))).length,
    2,
  );
});

test("any lists of test files: two moved into one, and a file outside tests/ run as it is", (t) => {
  const merged = trees(t, {
    "joined.test.js": testFile({ first: true, second: true, unrelated: true }),
    "other.test.js": null,
  });
  const together = merged.run(
    ["tests/joined.test.ts"],
    ["tests/old.test.ts", "tests/other.test.ts"],
  );
  assert.equal(together.status, 0, together.out + together.err);
  const tools = trees(t, SPLIT);
  const outside = (tree, text) => {
    mkdirSync(join(tools.root, tree, "tools"), { recursive: true });
    writeFileSync(join(tools.root, tree, "tools", "x.test.mjs"), text);
  };
  outside("base", 'import test from "node:test";\ntest("tool", () => {});\n');
  outside("head", 'import test from "node:test";\ntest("tool", () => {});\n');
  const result = tools.run(["tools/x.test.mjs"], ["tools/x.test.mjs"]);
  assert.equal(result.status, 0, result.out + result.err);
});

test("a test lost, failing, or named twice is not equal", (t) => {
  const cases = {
    "missing at head: 0 second (1)": { ...SPLIT, "split/two.test.js": testFile({}) },
    "failed at head: 1 failed, 0 cancelled": {
      ...SPLIT,
      "split/two.test.js": testFile({ second: false }),
    },
    "a top-level title 2 times at head: 0 first": {
      ...SPLIT,
      "split/two.test.js": testFile({ second: true, first: true }),
    },
  };
  for (const [line, head] of Object.entries(cases)) {
    const result = trees(t, head).run();
    assert.equal(result.status, 1, `${line}\n${result.out}${result.err}`);
    assert.ok(result.out.includes(line), `${line}\n${result.out}`);
  }
});

test("the suite's discovery must hold the new files and not the old one, and change nothing else", (t) => {
  const cases = {
    // (a file in a folder the suite does not read)
    "the head's suite does not hold helpers/two.test.js": [
      {
        "split/one.test.js": SPLIT["split/one.test.js"],
        "helpers/two.test.js": SPLIT["split/two.test.js"],
      },
      ["tests/split/one.test.ts", "tests/helpers/two.test.ts"],
    ],
    "the head's suite still holds old.test.js": [{ ...SPLIT, "old.test.js": testFile({}) }],
    "the head's suite gained extra.test.js": [
      { ...SPLIT, "extra.test.js": testFile({ extra: true }) },
    ],
    "the head's suite lost other.test.js": [{ ...SPLIT, "other.test.js": null }],
    // (an OLD file the suite does not read)
    "the base's suite does not hold helpers/old.test.js": [
      SPLIT,
      undefined,
      ["tests/helpers/old.test.ts"],
      { "helpers/old.test.js": testFile({ first: true, second: true }) },
    ],
  };
  for (const [line, [head, news, old, baseExtra]] of Object.entries(cases)) {
    const result = trees(t, head, baseExtra).run(news, old);
    assert.equal(result.status, 1, `${line}\n${result.out}${result.err}`);
    assert.ok(result.out.includes(`discovery: ${line}`), `${line}\n${result.out}`);
  }
});

test("the comparison's own controls find a dropped title and a passed test counted as failed, or it cannot judge", () => {
  const counts = { passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0, fileFailed: false };
  const side = {
    titles: [
      { nesting: 0, name: "first" },
      { nesting: 0, name: "second" },
    ],
    counts,
  };
  assert.deepEqual(controlFailures(side, side), []);
  assert.deepEqual(
    controlFailures(side, side, () => ({ equal: true, lines: [] })),
    ["a dropped title compared equal", "a passed test counted as failed compared equal"],
  );
  // (a title repeated inside two suites is no duplicate; one lost there is, though the counts are equal)
  const nested = {
    titles: [
      { nesting: 1, name: "case" },
      { nesting: 1, name: "case" },
    ],
    counts,
  };
  assert.equal(compareSides(nested, nested).equal, true);
  assert.equal(compareSides(nested, { ...nested, titles: nested.titles.slice(1) }).equal, false);
  const renamed = {
    ...side,
    titles: [
      { nesting: 0, name: "first" },
      { nesting: 0, name: "other" },
    ],
  };
  assert.equal(compareSides(side, renamed).equal, false);
});

test("usage, or a tree that is not built, cannot run", (t) => {
  const { root, run } = trees(t, SPLIT);
  assert.equal(spawnSync(process.execPath, [TOOL], { encoding: "utf8" }).status, 2);
  assert.equal(run(["tests/split/one.js"]).status, 2);
  assert.equal(run(undefined, ["tests/missing.test.ts"]).status, 2);
  rmSync(join(root, "head/dist"), { recursive: true });
  assert.equal(run().status, 2);
});
