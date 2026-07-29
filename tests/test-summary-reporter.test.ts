import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const reporterPath = resolve(process.cwd(), "tools/test-summary-reporter.mjs");

function runFixture(source: string) {
  const directory = mkdtempSync(resolve(tmpdir(), "test-summary-reporter-"));
  const fixturePath = resolve(directory, "fixture.test.mjs");
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  writeFileSync(fixturePath, source);

  try {
    return spawnSync(
      process.execPath,
      ["--test", `--test-reporter=${reporterPath}`, fixturePath],
      {
        encoding: "utf8",
        env: environment,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("summary reporter prints one compact line on success", () => {
  const result = runFixture(`
    import test from "node:test";
    test("first passing test", () => {});
    test("second passing test", () => {});
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^tests 2 \| pass 2 \| fail 0 \| duration \d+ ms\n$/,
  );
  assert.doesNotMatch(result.stdout, /first passing test|second passing test/);
  assert.equal(result.stderr, "");
});

test("summary reporter prints failure details and totals", () => {
  const result = runFixture(`
    import assert from "node:assert/strict";
    import test from "node:test";
    test("passing test stays hidden", () => {});
    test("failing assertion", () => {
      assert.deepEqual({ actual: 1 }, { actual: 2 });
    });
  `);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL failing assertion/);
  assert.match(result.stdout, /AssertionError/);
  assert.match(result.stdout, /actual: 1/);
  assert.match(result.stdout, /actual: 2/);
  assert.match(
    result.stdout,
    /tests 2 \| pass 1 \| fail 1 \| duration \d+ ms\n$/,
  );
  assert.doesNotMatch(result.stdout, /passing test stays hidden/);
  assert.equal(result.stderr, "");
});

test("summary reporter suppresses expected TODO failure details", () => {
  const result = runFixture(`
    import test from "node:test";
    test("expected unfinished behavior", { todo: true }, () => {
      throw new Error("TODO_FAILURE_SHOULD_BE_HIDDEN");
    });
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^tests 1 \| pass 0 \| fail 0 \| todo 1 \| duration \d+ ms\n$/,
  );
  assert.doesNotMatch(
    result.stdout,
    /FAIL|expected unfinished behavior|TODO_FAILURE_SHOULD_BE_HIDDEN/,
  );
  assert.equal(result.stderr, "");
});
