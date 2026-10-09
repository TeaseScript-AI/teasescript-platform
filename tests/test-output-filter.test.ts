import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const filterPath = resolve(process.cwd(), "tools/test-output-filter.mjs");

/** Runs the filter on `fixtures`, or on the arguments `argumentsIn` gives for the fixtures' directory. */
function runFixtures(
  fixtures: Record<string, string>,
  fullOutput = false,
  argumentsIn?: (directory: string) => string[],
) {
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;

  const fixturePaths = Object.entries(fixtures).map(([name, source]) => {
    const fixturePath = resolve(directory, name);
    writeFileSync(fixturePath, source);
    return fixturePath;
  });

  try {
    return spawnSync(
      process.execPath,
      [
        filterPath,
        ...(fullOutput ? ["--full-output"] : []),
        ...(argumentsIn?.(directory) ?? fixturePaths),
      ],
      { encoding: "utf8", env: environment },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("filter removes passing test lines and preserves Node's full summary", () => {
  const result = runFixtures({
    "passing.test.mjs": `
      import test from "node:test";
      test("first passing test", () => {});
      test("second passing test", () => {});
    `,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /✔|first passing test|second passing test/);
  assert.match(result.stdout, /ℹ tests 2/);
  assert.match(result.stdout, /ℹ suites 0/);
  assert.match(result.stdout, /ℹ pass 2/);
  assert.match(result.stdout, /ℹ fail 0/);
  assert.match(result.stdout, /ℹ cancelled 0/);
  assert.match(result.stdout, /ℹ skipped 0/);
  assert.match(result.stdout, /ℹ todo 0/);
  assert.match(result.stdout, /ℹ duration_ms \d+(?:\.\d+)?/);
});

test("full-output mode preserves passing test lines", () => {
  const result = runFixtures(
    {
      "passing.test.mjs": `
      import test from "node:test";
      test("visible passing test", () => {});
    `,
    },
    true,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✔ visible passing test/);
});

test("filter preserves failures, stacks, the summary, and the exit code", () => {
  const result = runFixtures({
    "mixed.test.mjs": `
      import assert from "node:assert/strict";
      import test from "node:test";
      test("passing test stays hidden", () => {});
      test("failing test stays visible", () => assert.equal(1, 2));
    `,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, /✔|passing test stays hidden/);
  assert.match(result.stdout, /✖ failing test stays visible/);
  assert.match(result.stdout, /AssertionError/);
  assert.match(result.stdout, /^\s+at .*mixed\.test\.mjs:\d+:\d+/mu);
  assert.match(result.stdout, /ℹ tests 2/);
  assert.match(result.stdout, /ℹ pass 1/);
  assert.match(result.stdout, /ℹ fail 1/);
});

test("filter leaves skipped output and todo totals untouched", () => {
  const result = runFixtures({
    "pending.test.mjs": `
      import test from "node:test";
      test.skip("skipped test", () => {});
      test.todo("todo test");
    `,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped test/);
  assert.match(result.stdout, /ℹ skipped 1/);
  assert.match(result.stdout, /ℹ todo 1/);
});

test("filter refuses a path that matches no test file before Node runs any", () => {
  const fixtures = {
    "passing.test.mjs": `
      import test from "node:test";
      test("passing test", () => {});
    `,
  };
  const misspelled = runFixtures(fixtures, false, (directory) => [
    resolve(directory, "passing.test.mjs"),
    resolve(directory, "pasing.test.mjs"),
  ]);
  assert.equal(misspelled.status, 1, misspelled.stderr);
  assert.match(misspelled.stderr, /no test file matches '.*pasing\.test\.mjs'/);
  assert.doesNotMatch(misspelled.stdout, /ℹ tests/);

  // Node matches path arguments as globs, so a quoted pattern that matches runs its files.
  const pattern = runFixtures(fixtures, false, (directory) => [
    resolve(directory, "pass*.test.mjs"),
  ]);
  assert.equal(pattern.status, 0, pattern.stderr);
  assert.match(pattern.stdout, /ℹ pass 1/);

  // The value of a Node option given without `=` is not a path.
  const option = runFixtures(fixtures, false, (directory) => [
    "--test-name-pattern",
    "passing test",
    resolve(directory, "passing.test.mjs"),
  ]);
  assert.equal(option.status, 0, option.stderr);
  assert.match(option.stdout, /ℹ pass 1/);
});

test("filter refuses a pattern whose only matches are in a node_modules folder, which Node leaves out", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const source = `
    import test from "node:test";
    test("passing test", () => {});
  `;
  mkdirSync(resolve(directory, "node_modules"));
  mkdirSync(resolve(directory, "tests"));
  writeFileSync(resolve(directory, "node_modules/vendored.test.mjs"), source);
  writeFileSync(resolve(directory, "tests/own.test.mjs"), source);
  const filter = (pattern: string) =>
    spawnSync(process.execPath, [filterPath, pattern], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
  try {
    const vendored = filter("node_modules/*.test.mjs");
    assert.equal(vendored.status, 1, vendored.stderr);
    assert.match(vendored.stderr, /no test file matches 'node_modules\/\*\.test\.mjs'/);
    assert.doesNotMatch(vendored.stdout, /ℹ tests/);

    // A pattern that also matches a file outside node_modules runs that file, as Node does.
    const both = filter("*/*.test.mjs");
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /ℹ tests 1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
