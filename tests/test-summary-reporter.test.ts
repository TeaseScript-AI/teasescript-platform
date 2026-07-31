import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const reporterPath = resolve(process.cwd(), "tools/test-summary-reporter.mjs");

function runFixtures(
  fixtures: Record<string, string>,
  options: { relativePaths?: boolean } = {},
) {
  const directory = mkdtempSync(resolve(tmpdir(), "test-summary-reporter-"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const fixturePaths = Object.entries(fixtures).map(([name, source]) => {
    const fixturePath = resolve(directory, name);
    writeFileSync(fixturePath, source);
    return fixturePath;
  });

  try {
    const testPaths = options.relativePaths
      ? fixturePaths.map((fixturePath) => relative(process.cwd(), fixturePath))
      : fixturePaths;
    return spawnSync(
      process.execPath,
      ["--test", `--test-reporter=${reporterPath}`, ...testPaths],
      {
        encoding: "utf8",
        env: environment,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runFixture(source: string) {
  return runFixtures({ "fixture.test.mjs": source });
}

function runSyntheticEvents(events: unknown[]) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    REPORTER_EVENTS: JSON.stringify(events),
  };
  delete environment.NODE_TEST_CONTEXT;

  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import reporter from ${JSON.stringify(pathToFileURL(reporterPath).href)};
        const events = JSON.parse(process.env.REPORTER_EVENTS);
        async function* source() {
          yield* events;
        }
        for await (const output of reporter(source())) {
          process.stdout.write(output);
        }
      `,
    ],
    {
      encoding: "utf8",
      env: environment,
    },
  );
}

test("summary reporter prints one compact line on success", () => {
  const result = runFixture(`
    import test from "node:test";
    test("first passing test", (t) => {
      t.diagnostic("SUCCESS_DIAGNOSTIC_SHOULD_BE_HIDDEN");
      process.stdout.write("SUCCESS_STDOUT_SHOULD_BE_HIDDEN\\n");
      process.stderr.write("SUCCESS_STDERR_SHOULD_BE_HIDDEN\\n");
    });
    test("second passing test", () => {});
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^tests 2 \| pass 2 \| fail 0 \| duration \d+ ms\n$/,
  );
  assert.doesNotMatch(
    result.stdout,
    /first passing test|second passing test|SUCCESS_(?:DIAGNOSTIC|STDOUT|STDERR)_SHOULD_BE_HIDDEN/,
  );
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

test("summary reporter retains diagnostics when a run fails", () => {
  const result = runFixture(`
    import assert from "node:assert/strict";
    import test from "node:test";
    test("diagnostic failure", (t) => {
      t.diagnostic("DIAGNOSTIC_SENTINEL");
      assert.equal(1, 2);
    });
  `);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL diagnostic failure/);
  assert.match(result.stdout, /DIAGNOSTIC.*fixture\.test\.mjs/);
  assert.match(result.stdout, /DIAGNOSTIC_SENTINEL/);
  assert.match(
    result.stdout,
    /tests 1 \| pass 0 \| fail 1 \| duration \d+ ms\n$/,
  );
  assert.doesNotMatch(result.stdout, /DIAGNOSTIC\ntests 1|DIAGNOSTIC\npass 0/);
  assert.equal(result.stderr, "");
});

test("summary reporter retains unfamiliar events when a run fails", () => {
  const result = runSyntheticEvents([
    {
      type: "test:future-error",
      data: { message: "FUTURE_ERROR_SENTINEL", code: 73 },
    },
    {
      type: "test:summary",
      data: {
        success: false,
        counts: {
          tests: 1,
          failed: 1,
          passed: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
        },
        duration_ms: 1,
      },
    },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /EVENT test:future-error/);
  assert.match(result.stdout, /FUTURE_ERROR_SENTINEL/);
  assert.match(result.stdout, /code: 73/);
  assert.match(
    result.stdout,
    /tests 1 \| pass 0 \| fail 1 \| duration 1 ms\n$/,
  );
  assert.equal(result.stderr, "");
});

test("summary reporter retains non-summary diagnostics without a file", () => {
  const result = runSyntheticEvents([
    {
      type: "test:diagnostic",
      data: { message: "fail useful context", level: "info" },
    },
    {
      type: "test:summary",
      data: {
        success: false,
        counts: {
          tests: 1,
          failed: 1,
          passed: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
        },
        duration_ms: 1,
      },
    },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DIAGNOSTIC\nfail useful context/);
  assert.match(
    result.stdout,
    /tests 1 \| pass 0 \| fail 1 \| duration 1 ms\n$/,
  );
  assert.equal(result.stderr, "");
});

test("summary reporter bounds retained failure context", () => {
  const result = runSyntheticEvents([
    {
      type: "test:stdout",
      data: {
        file: "/tmp/future.test.mjs",
        message: `${"X".repeat(40_000)}FUTURE_EVENT_TAIL`,
      },
    },
    {
      type: "test:summary",
      data: {
        success: false,
        counts: {
          tests: 1,
          failed: 1,
          passed: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
        },
        duration_ms: 1,
      },
    },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /retained context truncated/);
  assert.match(result.stdout, /FUTURE_EVENT_TAIL/);
  assert.ok(
    Buffer.byteLength(result.stdout, "utf8") < 17_000,
    `retained context exceeded bound: ${Buffer.byteLength(result.stdout, "utf8")} bytes`,
  );
  assert.match(
    result.stdout,
    /tests 1 \| pass 0 \| fail 1 \| duration 1 ms\n$/,
  );
  assert.equal(result.stderr, "");
});

test("summary reporter retains an stderr-free child exit code", () => {
  const result = runFixture(`
    process.exit(42);
  `);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL .*fixture\.test\.mjs/);
  assert.match(result.stdout, /child process exited with code 42/);
  assert.match(
    result.stdout,
    /tests 1 \| pass 0 \| fail 1 \| duration \d+ ms\n$/,
  );
  assert.equal(result.stderr, "");
});

test("summary reporter retains an stderr-free child signal", () => {
  const result = runFixture(`
    process.kill(process.pid, "SIGTERM");
  `);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL .*fixture\.test\.mjs/);
  assert.match(result.stdout, /child process terminated by signal SIGTERM/);
  assert.match(
    result.stdout,
    /tests 1 \| pass 0 \| fail 1 \| duration \d+ ms\n$/,
  );
  assert.equal(result.stderr, "");
});

test("summary reporter does not mistake a path-named test for a file wrapper", () => {
  const result = runFixture(`
    import test from "node:test";
    import { fileURLToPath } from "node:url";
    function bodyFailureStackSentinel() {
      throw new Error("test failed");
    }
    test(fileURLToPath(import.meta.url), () => {
      process.stdout.write("BODY_STDOUT_SENTINEL\\n");
      process.stderr.write("BODY_STDERR_SENTINEL\\n");
      bodyFailureStackSentinel();
    });
  `);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL .*fixture\.test\.mjs/);
  assert.match(result.stdout, /Error: test failed/);
  assert.match(result.stdout, /bodyFailureStackSentinel/);
  assert.match(result.stdout, /BODY_STDOUT_SENTINEL/);
  assert.match(result.stdout, /BODY_STDERR_SENTINEL/);
  assert.match(
    result.stdout,
    /tests 1 \| pass 0 \| fail 1 \| duration \d+ ms\n$/,
  );
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

test("summary reporter preserves file-load stderr for relative failed paths only", () => {
  const result = runFixtures({
    "passing.test.mjs": `
      import test from "node:test";
      process.stderr.write("SUCCESS_STDERR_SHOULD_BE_HIDDEN\\n");
      test("passing fixture name stays hidden", () => {});
    `,
    "failing.test.mjs": `
      process.stderr.write("FILE_LOAD_PREFIX\\n");
      throw new Error("TOP_LEVEL_SENTINEL");
    `,
  }, { relativePaths: true });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL .*failing\.test\.mjs/);
  assert.match(result.stdout, /FILE_LOAD_PREFIX/);
  assert.match(result.stdout, /Error: TOP_LEVEL_SENTINEL/);
  assert.match(
    result.stdout,
    /tests 2 \| pass 1 \| fail 1 \| duration \d+ ms\n$/,
  );
  assert.doesNotMatch(
    result.stdout,
    /SUCCESS_STDERR_SHOULD_BE_HIDDEN|passing fixture name stays hidden/,
  );
  assert.equal(result.stderr, "");
});

test("summary reporter bounds retained file-load stderr", () => {
  const result = runFixture(`
    process.stderr.write("A".repeat(40_000));
    throw new Error("TRUNCATED_TAIL_SENTINEL");
  `);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /stderr truncated: retained 16384 of \d+ bytes/);
  assert.match(result.stdout, /TRUNCATED_TAIL_SENTINEL/);
  assert.match(
    result.stdout,
    /tests 1 \| pass 0 \| fail 1 \| duration \d+ ms\n$/,
  );
  assert.ok(
    Buffer.byteLength(result.stdout, "utf8") < 18_500,
    `compact output exceeded bound: ${Buffer.byteLength(result.stdout, "utf8")} bytes`,
  );
  assert.equal(result.stderr, "");
});

test("summary reporter omits aggregate nested-suite failures", () => {
  const result = runFixture(`
    import assert from "node:assert/strict";
    import { describe, it } from "node:test";
    describe("outer suite", () => {
      describe("inner suite", () => {
        it("single failing leaf", () => assert.equal(1, 2));
      });
    });
  `);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.match(/^FAIL /gm)?.length, 1);
  assert.match(result.stdout, /FAIL single failing leaf/);
  assert.doesNotMatch(result.stdout, /FAIL outer suite|FAIL inner suite/);
  assert.match(
    result.stdout,
    /tests 1 \| pass 0 \| fail 1 \| duration \d+ ms\n$/,
  );
  assert.equal(result.stderr, "");
});
