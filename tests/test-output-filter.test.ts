import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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

test("TEST_FULL_OUTPUT=1 gives full output, and the tests it runs do not inherit it", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  const environment: NodeJS.ProcessEnv = { ...process.env, TEST_FULL_OUTPUT: "1" };
  delete environment.NODE_TEST_CONTEXT;
  // (a test that runs the filter itself, as this file does, would otherwise get full output where it expects compact)
  const fixture = resolve(directory, "inherits.test.mjs");
  writeFileSync(
    fixture,
    `import assert from "node:assert/strict";
     import test from "node:test";
     test("visible passing test", () => assert.equal(process.env.TEST_FULL_OUTPUT, undefined));`,
  );
  try {
    const result = spawnSync(process.execPath, [filterPath, fixture], {
      encoding: "utf8",
      env: environment,
    });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /✔ visible passing test/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("compact output ends with each named file's counts, 0 passed for a file that ran no test", () => {
  const fixtures = {
    "counted.test.mjs": `
      import assert from "node:assert/strict";
      import test, { describe, it } from "node:test";
      describe("a family", () => {
        it("first row", () => {});
        it("second row", () => {});
      });
      test("failing test", () => assert.equal(1, 2));
      test("timed out test", { timeout: 10 }, () => new Promise(() => setTimeout(() => {}, 100)));
      test.skip("skipped test", () => {});
      test.todo("todo test");
    `,
    // suites alone, no test
    "suites.test.mjs": `
      import { describe } from "node:test";
      describe("an empty family", () => {});
    `,
    // its process ends before its test reports
    "silent.test.mjs": `
      import test from "node:test";
      test("never reported", () => process.exit(0));
    `,
  };
  const counted = /^ℹ \S*counted\.test\.mjs: 2 passed, 1 failed, 1 cancelled, 1 skipped, 1 todo$/mu;
  const silent = /^ℹ \S*silent\.test\.mjs: 0 passed$/mu;
  const suites = /^ℹ \S*suites\.test\.mjs: 0 passed$/mu;
  const compact = runFixtures(fixtures);
  assert.equal(compact.status, 1, compact.stderr);
  assert.doesNotMatch(compact.stdout, /first row|second row/);
  assert.match(compact.stdout, counted);
  assert.match(compact.stdout, silent);
  assert.match(compact.stdout, suites);
  // after Node's own output: the summary and the failures
  assert.match(compact.stdout, /failing test[\s\S]*\nℹ \S*counted\.test\.mjs: /u);
  // a name pattern that matches no test runs none
  const unmatched = runFixtures(fixtures, false, (directory) => [
    "--test-name-pattern=no such test",
    resolve(directory, "counted.test.mjs"),
  ]);
  assert.equal(unmatched.status, 0, unmatched.stderr);
  assert.match(unmatched.stdout, /^ℹ \S*counted\.test\.mjs: 0 passed$/mu);
  // full output names every test, and adds no counts
  const full = runFixtures(fixtures, true);
  assert.doesNotMatch(full.stdout, /^ℹ \S*\.test\.mjs: /mu);
});

// Ctrl+C reaches the filter's whole process group; a signal can also end the runner alone, which the filter then raises
// on itself. Either way the filter ends by that signal, prints no counts and leaves no folder of them.
for (const [target, signal] of [
  ["its process group", "SIGINT"],
  ["its runner alone", "SIGHUP"],
] as const)
  test(
    `${signal} to ${target} stops a run of named files by that signal and leaves no counts behind`,
    // (the runner's process id is read from Linux's /proc)
    {
      skip:
        process.platform !== "linux" && target === "its runner alone"
          ? "Linux only"
          : process.platform === "win32",
    },
    async () => {
      const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
      // the filter's own temporary folders, apart from everyone else's
      const temporary = resolve(directory, "tmp");
      mkdirSync(temporary);
      const environment: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temporary };
      delete environment.NODE_TEST_CONTEXT;
      const started = resolve(directory, "started");
      const fixture = resolve(directory, "running.test.mjs");
      writeFileSync(
        fixture,
        `import { writeFileSync } from "node:fs";
         import test from "node:test";
         test("running", () => {
           writeFileSync(${JSON.stringify(started)}, "");
           return new Promise(() => setInterval(() => {}, 1000));
         });`,
      );
      // In a process group of its own, which receives the signal as a terminal's group does.
      const filter = spawn(process.execPath, [filterPath, fixture], {
        cwd: directory,
        env: environment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      filter.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
      filter.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
      const closed = once(filter, "close");
      const group = filter.pid;
      assert.ok(group !== undefined);
      try {
        for (let wait = 0; wait < 500 && !existsSync(started); wait++) await delay(10);
        assert.ok(existsSync(started), output);
        assert.equal(
          readdirSync(temporary).filter((name) => name.startsWith("test-file-counts-")).length,
          1,
        );
        if (target === "its process group") process.kill(-group, signal);
        else {
          const runner = Number(
            readFileSync(`/proc/${group}/task/${group}/children`, "utf8").trim().split(" ")[0],
          );
          assert.ok(runner > 0, "the filter's runner");
          process.kill(runner, signal);
        }
        assert.deepEqual(await closed, [null, signal]);
        assert.doesNotMatch(output, /ℹ \S*running\.test\.mjs: /u);
        assert.deepEqual(readdirSync(temporary), []);
      } finally {
        // The fixture's test process outlives a signal to the runner alone: the group goes whatever ended.
        try {
          process.kill(-group, "SIGKILL");
        } catch {
          // The whole group has ended.
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

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

test("the full suite runs every file once, each in its own process, with the costly files first", async () => {
  // EVIDENCE: tools/costly-test-files.mjs exports `costlyTestFiles` as an array of file names, as the filter reads it.
  const { costlyTestFiles } = (await import(
    pathToFileURL(resolve(process.cwd(), "tools/costly-test-files.mjs")).href
  )) as { costlyTestFiles: string[] };
  const files = [...costlyTestFiles, "a.test.js", "z.test.js"];
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  mkdirSync(resolve(directory, "dist/tests"), { recursive: true });
  for (const file of files) {
    // (a costly file's name is its path under dist/tests/, in a folder for most)
    mkdirSync(dirname(resolve(directory, "dist/tests", file)), { recursive: true });
    // A file that ran in the process of another would find its mark.
    writeFileSync(
      resolve(directory, "dist/tests", file),
      `const assert = require("node:assert/strict");
       assert.equal(globalThis.testFile, undefined);
       globalThis.testFile = ${JSON.stringify(file)};
       require("node:test")(${JSON.stringify(file)}, () => {
         ${file === "z.test.js" ? 'assert.fail("deliberate failure");' : ""}
       });`,
    );
  }
  try {
    const result = spawnSync(process.execPath, [filterPath, "--full-output"], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });

    assert.equal(result.status, 1, result.stderr);
    // Node reports the files in the order the runner starts them, whichever ends first.
    const results = result.stdout.slice(0, result.stdout.indexOf("ℹ tests"));
    assert.deepEqual(
      [...results.matchAll(/^([✔✖] \S+) \(/gmu)].map((match) => match[1]),
      files.map((file) => `${file === "z.test.js" ? "✖" : "✔"} ${file}`),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the full suite fails on a file that reported no test of its own, and names it (#2154)", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  mkdirSync(resolve(directory, "dist/tests"), { recursive: true });
  // Each of these reports a test of its own: one named by its file's path, one a helper registers, one importing another
  // test file, whose results are the importer's only (#2155's round 1).
  const files: Record<string, string> = {
    "a.test.js": `require("node:test")("a", () => {});`,
    "named.test.js": `require("node:test")(__filename, () => {});`,
    "helper.js": `module.exports = () => require("node:test")("from a helper", () => {});`,
    "helped.test.js": `require("./helper.js")();`,
    "importer.test.js": `require("./imported.test.js"); require("node:test")("importer", () => {});`,
    "imported.test.js": `require("node:test")("imported", () => {});`,
    // (a test registered from a microtask: node:test reports it with its entry file but no source location)
    "deferred.test.js": `queueMicrotask(require("node:test").bind(null, "deferred", () => {}));`,
  };
  for (const [file, source] of Object.entries(files))
    writeFileSync(resolve(directory, "dist/tests", file), source);
  const run = () =>
    spawnSync(process.execPath, [filterPath, "--full-output"], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
  const named = "run-test-files: dist/tests/exit.test.js reported no test of its own";
  try {
    const alone = run();
    assert.equal(alone.status, 0, alone.stderr);
    assert.ok(!alone.stderr.includes("reported no test of its own"), alone.stderr);
    // (its process ends before its test reports: `node:test` passes it as its file entry alone)
    writeFileSync(
      resolve(directory, "dist/tests/exit.test.js"),
      `require("node:test")("never reported", () => process.exit(0));`,
    );
    const beside = run();
    assert.equal(beside.status, 1, beside.stderr);
    assert.ok(beside.stderr.includes(named), beside.stderr);
    assert.equal(beside.stderr.split("reported no test of its own").length, 2, beside.stderr);
    // (a file whose own process reports nothing is named though another file imports it and reports its test)
    writeFileSync(
      resolve(directory, "dist/tests/imported.test.js"),
      `if (require.main === module) process.exit(0); require("node:test")("imported", () => {});`,
    );
    const imported = run();
    assert.equal(imported.status, 1, imported.stderr);
    assert.ok(
      imported.stderr.includes(
        "run-test-files: dist/tests/imported.test.js reported no test of its own",
      ),
      imported.stderr,
    );
    assert.match(beside.stdout, /^✔ a \(/mu);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Ctrl+C stops the full suite without an error",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const started = resolve(directory, "started");
    mkdirSync(resolve(directory, "dist/tests"), { recursive: true });
    writeFileSync(
      resolve(directory, "dist/tests/running.test.js"),
      `require("node:test")("running", () => {
         require("node:fs").writeFileSync(${JSON.stringify(started)}, "");
         return new Promise(() => setInterval(() => {}, 1000));
       });`,
    );
    // In a process group of its own, which receives the signal as a terminal's group does.
    const filter = spawn(process.execPath, [filterPath], {
      cwd: directory,
      env: environment,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    filter.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const closed = once(filter, "close");
    const group = filter.pid;
    assert.ok(group !== undefined);
    try {
      for (let wait = 0; wait < 500 && !existsSync(started); wait++) await delay(10);
      assert.ok(existsSync(started), stderr);
      process.kill(-group, "SIGINT");
      // The close waits for the runner too, which writes to the same error output.
      assert.deepEqual(await closed, [null, "SIGINT"]);
      assert.doesNotMatch(stderr, /Error/);
    } finally {
      if (filter.exitCode === null && filter.signalCode === null) process.kill(-group, "SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "the full suite's runner stops without an error when its output has no reader before the signal",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const ended = resolve(directory, "ended");
    const file = resolve(directory, "ending.test.js");
    // Ctrl+C ends the filter and a file's process at once, and the runner can report that file before it handles the
    // signal itself. Here the file's process ends only after the runner's output has lost its reader, and no signal
    // comes at all.
    writeFileSync(
      file,
      `setInterval(() => require("node:fs").existsSync(${JSON.stringify(ended)}) && process.exit(1), 10);`,
    );
    const runner = spawn(
      process.execPath,
      [resolve(process.cwd(), "tools/run-test-files.mjs"), file],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    runner.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const closed = once(runner, "close", { signal: AbortSignal.timeout(30_000) });
    try {
      runner.stdout.destroy();
      writeFileSync(ended, "");
      assert.deepEqual(await closed, [1, null]);
      assert.doesNotMatch(stderr, /Error/);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

const pipedInput = /takes no standard input, so do not pipe into it/;

test("filter refuses data piped or redirected to its standard input", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const testFile = resolve(directory, "passing.test.mjs");
  writeFileSync(testFile, 'import test from "node:test";\ntest("passing test", () => {});\n');
  const log = resolve(directory, "log.txt");
  writeFileSync(log, "output of another command\n");
  const logFile = openSync(log, "r");
  try {
    const inputs: SpawnSyncOptions[] = [
      { input: "output of another command\n" },
      { stdio: [logFile, "pipe", "pipe"] },
    ];
    for (const input of inputs) {
      const result = spawnSync(process.execPath, [filterPath, testFile], {
        ...input,
        encoding: "utf8",
        env: environment,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, pipedInput);
      assert.doesNotMatch(result.stdout, /ℹ tests/);
    }
  } finally {
    closeSync(logFile);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pipe on standard input that stays open without data does not stop the filter", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const testFile = resolve(directory, "passing.test.mjs");
  writeFileSync(testFile, 'import test from "node:test";\ntest("passing test", () => {});\n');
  // The other tests give a pipe that ends at once, as a GitHub Actions step does. This one stays open, as from ssh.
  const filter = spawn(process.execPath, [filterPath, testFile], { env: environment });
  let stdout = "";
  filter.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  try {
    const closed = once(filter, "close", { signal: AbortSignal.timeout(30_000) });
    assert.deepEqual(await closed, [0, null]);
    assert.match(stdout, /ℹ pass 1/);
  } finally {
    if (filter.exitCode === null && filter.signalCode === null) filter.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "data that arrives on standard input during the full suite stops it",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const started = resolve(directory, "started");
    mkdirSync(resolve(directory, "dist/tests"), { recursive: true });
    writeFileSync(
      resolve(directory, "dist/tests/running.test.js"),
      `require("node:test")("running", () => {
         require("node:fs").writeFileSync(${JSON.stringify(started)}, String(process.pid));
         return new Promise(() => setInterval(() => {}, 1000));
       });`,
    );
    // In a process group of its own, so that a failure leaves nothing running.
    const filter = spawn(process.execPath, [filterPath], {
      cwd: directory,
      env: environment,
      detached: true,
    });
    const group = filter.pid;
    assert.ok(group !== undefined);
    let stdout = "";
    let stderr = "";
    filter.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    filter.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const closed = once(filter, "close", { signal: AbortSignal.timeout(30_000) });
    try {
      for (let wait = 0; wait < 500 && !existsSync(started); wait++) await delay(10);
      assert.ok(existsSync(started), stderr);
      filter.stdin.write("output of another command\n");
      assert.deepEqual(await closed, [1, null]);
      assert.match(stderr, pipedInput);
      assert.doesNotMatch(stdout, /ℹ tests/);

      // The test's process stops too.
      const pid = Number(readFileSync(started, "utf8"));
      const running = () => {
        try {
          return process.kill(pid, 0);
        } catch {
          return false;
        }
      };
      for (let wait = 0; wait < 500 && running(); wait++) await delay(10);
      assert.equal(running(), false);
    } finally {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // The whole group has ended.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
