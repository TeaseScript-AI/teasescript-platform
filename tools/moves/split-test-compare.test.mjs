import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit } from "../fixture-git.mjs";
import { compareSides, controlFailures, main } from "./split-test-compare.mjs";

isolateGit();

const TOOL = fileURLToPath(new URL("./split-test-compare.mjs", import.meta.url));

/** A compiled test file holding `tests` (title → true to pass, false to fail, "skip", "suite", "failing suite"; or pairs). */
const testFile = (tests) =>
  [
    'const test = require("node:test");',
    ...(Array.isArray(tests) ? tests : Object.entries(tests)).map(([title, state]) =>
      state === "suite" || state === "failing suite"
        ? `test.describe(${JSON.stringify(title)}, () => { ${state === "suite" ? "" : 'test.after(() => { throw new Error("no"); });'} });`
        : `test${state === "skip" ? ".skip" : ""}(${JSON.stringify(title)}, () => { ${state === false ? 'throw new Error("no");' : ""} });`,
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

test("a comparison that sees nothing makes the run's own controls fail: it cannot judge", (t) => {
  const { root } = trees(t, SPLIT);
  const args = [
    ...["base", "head", "out"].map((name) => join(root, name)),
    "--old",
    "tests/old.test.ts",
    "--new",
    "tests/split/one.test.ts",
    "tests/split/two.test.ts",
  ];
  const printed = [];
  assert.equal(
    main(args, (line) => printed.push(line)),
    0,
    printed.join("\n"),
  );
  const blind = () => ({ equal: true, lines: ["blind"] });
  assert.equal(
    main(args, (line) => printed.push(line), blind),
    2,
  );
  assert.match(printed.join("\n"), /^control: a dropped title compared equal$/mu);
});

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
  // (each file by its repository path, not the path of the machine that ran it)
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(root, "out/head-counts.json"), "utf8"))).sort(),
    ["dist/tests/split/one.test.js", "dist/tests/split/two.test.js"],
  );
  // (a discovery and controls that pass say so)
  assert.match(
    result.out,
    /^discovery: the base's suite holds each OLD file, the head's each NEW file/mu,
  );
  assert.match(
    result.out,
    /^control: a dropped title and a passed test counted as failed each compared unequal$/mu,
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
  assert.match(result.out, /^discovery: not run, no FILE under tests\/$/mu);
});

test("a test lost, added, failing or skipped is not equal, each by its own rule", (t) => {
  // (each case is caught by the one rule its line names: the titles, the classes, a failure)
  const both = (tests) => [
    { ...SPLIT, "split/two.test.js": testFile(tests) },
    { "old.test.js": testFile({ first: true, ...tests }) },
  ];
  const cases = {
    "missing at head: 0 second (1)": { ...SPLIT, "split/two.test.js": testFile({}) },
    "failed at head: exit 1; 1 failed, 0 cancelled": {
      ...SPLIT,
      "split/two.test.js": testFile({ second: false }),
    },
    // (a suite has a title and no count: only the titles see it)
    "added at head: 0 extra (1)": {
      ...SPLIT,
      "split/two.test.js": testFile({ second: true, extra: "suite" }),
    },
    "skipped differs: 0 -> 1": { ...SPLIT, "split/two.test.js": testFile({ second: "skip" }) },
    "failed at base: exit 1; 1 failed, 0 cancelled": both({ second: false }),
    // (a suite's hook that fails has no count and keeps its title: only the run's exit status sees it)
    "failed at head: exit 1; 0 failed, 0 cancelled": [
      { ...SPLIT, "split/two.test.js": testFile({ second: true, empty: "failing suite" }) },
      { "old.test.js": testFile({ first: true, second: true, empty: "suite" }) },
    ],
  };
  for (const [line, value] of Object.entries(cases)) {
    const [head, baseExtra] = Array.isArray(value) ? value : [value];
    const result = trees(t, head, baseExtra).run();
    assert.equal(result.status, 1, `${line}\n${result.out}${result.err}`);
    assert.ok(result.out.includes(line), `${line}\n${result.out}`);
  }
  // (a title repeated at the top, as many times on both sides, is no difference: #2546's runtime files share some)
  const repeated = trees(
    t,
    {
      ...SPLIT,
      "split/two.test.js": testFile([
        ["second", true],
        ["first", true],
      ]),
    },
    {
      "old.test.js": testFile([
        ["first", true],
        ["second", true],
        ["first", true],
      ]),
    },
  ).run();
  assert.equal(repeated.status, 0, repeated.out + repeated.err);
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
    exit: 0,
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
    exit: 0,
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

test("--moved refuses a list that misses a test file reaching a moved module, naming it, before any test runs (#2583)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "split-test-compare-reach-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = join(root, "tree");
  for (const [file, text] of Object.entries({
    "tests/helpers/moved.ts": "export const moved = 1;\n",
    "tests/a/direct.test.ts": 'import { moved } from "../helpers/moved.js";\n',
    "tools/reader.mjs":
      'import { readdirSync } from "node:fs";\nexport const all = () => readdirSync("tests", { recursive: true });\n',
    "tools/reader.test.mjs": 'import { all } from "./reader.mjs";\n',
  })) {
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    writeFileSync(join(tree, file), text);
  }
  const git = (...args) => execFileSync("git", args, { cwd: tree, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "c");
  const out = join(root, "out");
  const compare = (...args) =>
    spawnSync(process.execPath, [TOOL, tree, tree, out, "--moved", ...args], { encoding: "utf8" });
  const result = compare(
    "tests/helpers/moved.ts",
    "--old",
    "tests/a/direct.test.ts",
    "--new",
    "tests/a/direct.test.ts",
    "tools/reader.test.mjs",
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.split("\n"), [
    "reach: base 2, head 2 test files (reach.txt)",
    "reach: --old misses tools/reader.test.mjs",
    "verdict: a list misses a reaching test file",
    "",
  ]);
  assert.match(
    readFileSync(join(out, "reach.txt"), "utf8"),
    /^ {2}tools\/reader\.test\.mjs -> tools\/reader\.mjs -> tests\/helpers\/moved\.ts$/mu,
  );
  // (--old without --new, or a moved file neither tree tracks, cannot run)
  assert.equal(compare("tests/helpers/moved.ts", "--old", "tests/a/direct.test.ts").status, 2);
  const none = compare("tests/helpers/none.ts");
  assert.equal(none.status, 2);
  assert.match(none.stderr, /neither tree tracks the moved tests\/helpers\/none\.ts/u);
});
