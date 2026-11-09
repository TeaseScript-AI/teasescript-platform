import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NOT_PINS, PIN_SUITES, builtOf, pinFormsOf, suitesFor, testFiles } from "./pin-suites.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("a core change lists every pinning suite; another change lists none, a suite's own change or its pins' file itself", () => {
  assert.deepEqual(suitesFor(["src/type-inference/core/admission/literals/join.ts"]), PIN_SUITES);
  // (the published answers' digests move with the core too: #2074 passed the local check and failed CI on
  // one, #2086)
  assert.ok(
    suitesFor(["src/type-inference/core/values.ts"]).some(
      (suite) => suite.file === "tests/type-core/type-core-contract.test.ts",
    ),
  );
  assert.deepEqual(suitesFor(["src/runtime/engine.ts", "docs/TESTING.md"]), []);
  assert.deepEqual(suitesFor(["src/type-inference/core-like.ts"]), []);
  assert.deepEqual(
    suitesFor(["tests/type-core/type-core-kept.test.ts"]).map((suite) => suite.file),
    ["tests/type-core/type-core-kept.test.ts"],
  );
  assert.deepEqual(
    suitesFor(["tests/helpers/type-core/type-core-families.ts"]).map((suite) => suite.file),
    ["tests/type-core/type-core-work-b.test.ts"],
  );
  assert.equal(builtOf("tests/type-core/type-core-closure.test.ts"), "dist/tests/type-core/type-core-closure.test.js");
});

test("the list is kept true: each file a pin form finds is declared, and each suite's pin is found", () => {
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
    assert.ok(
      lines.some((line) => suite.pin.test(line)),
      `${suite.in ?? suite.file} holds no line ${suite.pin} finds (${suite.file})`,
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

test("the test files are the suite as the runner finds it: one folder down too, none in helpers/", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pin-suites-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["a.test.ts", "player/b.test.ts", "helpers/c.test.ts"]) {
    mkdirSync(join(root, "tests", file, ".."), { recursive: true });
    writeFileSync(join(root, "tests", file), "");
  }
  assert.deepEqual(testFiles(root), ["tests/a.test.ts", "tests/player/b.test.ts"]);
});

test("an option the tool does not take is refused, not ignored", () => {
  const tool = join(ROOT, "tools/repository-checks/pin-suites.mjs");
  for (const args of [["--check-grounds"], ["--base"], ["--run", "extra"]]) {
    const run = spawnSync(process.execPath, [tool, ...args], { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /use \[--base <ref>\] \[--run\]/u);
  }
});

test("a file moved out of the core lists every pinning suite (#2049)", { timeout: 30_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "pin-suites-"));
  const git = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  try {
    mkdirSync(join(directory, "tools/repository-checks"), { recursive: true });
    // (the tool, and the modules it reads the suite's test files through)
    for (const file of [
      "tools/repository-checks/pin-suites.mjs",
      "tools/test-shards.mjs",
      "tools/costly-test-files.mjs",
    ])
      copyFileSync(join(ROOT, file), join(directory, file));
    mkdirSync(join(directory, "src/type-inference/core"), { recursive: true });
    writeFileSync(
      join(directory, "src/type-inference/core/answers.ts"),
      "export const answers = 1;\n",
    );
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    git("mv", "src/type-inference/core/answers.ts", "src/type-inference/answers.ts");
    const run = spawnSync(
      process.execPath,
      ["tools/repository-checks/pin-suites.mjs", "--base", "HEAD"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      new RegExp(`1 core file changed .*; ${PIN_SUITES.length} pinning suites:`, "u"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
