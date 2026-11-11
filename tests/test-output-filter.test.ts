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

/**
 * Runs the filter on `fixtures`, or on the arguments `argumentsIn` gives for the fixtures' directory, with `variables`
 * added to its environment.
 */
function runFixtures(
  fixtures: Record<string, string>,
  fullOutput = false,
  argumentsIn?: (directory: string) => string[],
  variables: NodeJS.ProcessEnv = {},
) {
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  // the filter's own temporary folders, apart from everyone else's
  const temporary = resolve(directory, "tmp");
  mkdirSync(temporary);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    ...variables,
  };
  delete environment.NODE_TEST_CONTEXT;

  const fixturePaths = Object.entries(fixtures).map(([name, source]) => {
    const fixturePath = resolve(directory, name);
    writeFileSync(fixturePath, source);
    return fixturePath;
  });

  try {
    const result = spawnSync(
      process.execPath,
      [
        filterPath,
        ...(fullOutput ? ["--full-output"] : []),
        ...(argumentsIn?.(directory) ?? fixturePaths),
      ],
      { encoding: "utf8", env: environment },
    );
    return { ...result, leftover: readdirSync(temporary) };
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

test("compact output ends with each named file's counts, after Node's own output, and only in compact mode", () => {
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
  // (what each line counts is the next test's)
  const compact = runFixtures(fixtures);
  assert.equal(compact.status, 1, compact.stderr);
  assert.doesNotMatch(compact.stdout, /first row|second row/);
  assert.match(
    compact.stdout,
    /^ℹ \S*counted\.test\.mjs: 2 passed, 1 failed, 1 cancelled, 1 skipped, 1 todo$/mu,
  );
  // a run with a failing test removes the counts' folder
  assert.deepEqual(compact.leftover, []);
  // after Node's own output: the summary and the failures
  assert.match(compact.stdout, /failing test[\s\S]*\nℹ \S*counted\.test\.mjs: /u);
  // a file that ran no test fails the run, a suite alone included, and its line says so; NODE_OPTIONS without a
  // selection's name changes nothing
  for (const [name, variables] of [
    ["suites.test.mjs", {}],
    ["silent.test.mjs", {}],
    ["silent.test.mjs", { NODE_OPTIONS: "--title=label --no-warnings" }],
  ] as const) {
    const none = runFixtures(fixtures, false, (directory) => [resolve(directory, name)], variables);
    assert.equal(none.status, 1, `${name}: ${none.stdout}${none.stderr}`);
    assert.match(
      none.stdout,
      new RegExp(
        `^ℹ \\S*${name.replace(".", "\\.")}: 0 passed; it ran no test, which fails the run$`,
        "mu",
      ),
    );
  }
  // a selection that matches no test runs none, which its line says and the exit does not: a name or skip pattern, or
  // --test-only, in each spelling Node takes, or in NODE_OPTIONS
  for (const [selection, variables] of [
    [["--test-name-pattern=no such test"], {}],
    [["--test-skip-pattern", "."], {}],
    [["--test_name_pattern=nosuch"], {}],
    [["--test-skip_pattern", "."], {}],
    [["--test-only"], {}],
    [[], { NODE_OPTIONS: "--test-name-pattern=nosuch" }],
    // (anywhere in NODE_OPTIONS, quoted or not)
    [[], { NODE_OPTIONS: '"--test-name-pattern=no such test"' }],
  ] as const) {
    const unmatched = runFixtures(
      fixtures,
      false,
      (directory) => [...selection, resolve(directory, "counted.test.mjs")],
      variables,
    );
    assert.equal(
      unmatched.status,
      0,
      `${selection.join(" ")}: ${unmatched.stdout}${unmatched.stderr}`,
    );
    assert.match(
      unmatched.stdout,
      /^ℹ \S*counted\.test\.mjs: 0 passed; the selection matched no test in it$/mu,
      selection.join(" "),
    );
    // and so does one that passes
    assert.deepEqual(unmatched.leftover, []);
  }
  // full output names every test, and adds no counts
  const full = runFixtures(fixtures, true);
  assert.doesNotMatch(full.stdout, /^ℹ \S*\.test\.mjs: /mu);
});

/** `child`'s exit status, once it has closed. */
async function statusOf(child: ReturnType<typeof spawn>) {
  const [code] = (await once(child, "close")) as [number | null];
  return code;
}

test("wherever Node applies a selection given in NODE_OPTIONS, the filter reads one: Node itself decides each case", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  try {
    // One test, which leaves a marker file when it runs: a selection Node applied leaves none.
    const file = resolve(directory, "one.test.mjs");
    writeFileSync(
      file,
      'import test from "node:test"; import { writeFileSync } from "node:fs"; test("real", () => writeFileSync(process.env.MARKER, ""));\n',
    );
    // Each selection option with a quote pair, or a backslash inside quotes, put into its name at three places, the
    // whole option quoted, and a quote pair after it; after another option and one or two spaces. And round 3's three.
    const insert = [
      (option: string, at: number) => `${option.slice(0, at)}""${option.slice(at)}`,
      (option: string, at: number) =>
        `${option.slice(0, at)}"\\${option[at]}"${option.slice(at + 1)}`,
    ];
    const forms = ["--test-name-pattern=nosuch", "--test-skip-pattern=.", "--test-only"].flatMap(
      (option) => [
        ...[2, 7, 9].flatMap((at) => insert.map((put) => put(option, at))),
        `"${option}"`,
        `${option}""`,
      ],
    );
    const values = [
      ...forms.flatMap((form) => [`--no-warnings ${form}`, `--no-warnings  ${form}`]),
      '--test-"name"-pattern=missing',
      '"--test-na\\me-pattern=missing"',
      '--test-""only',
    ];
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const results = await Promise.all(
      values.map(async (value, n) => {
        const marker = resolve(directory, `ran-${n}`);
        const env = { ...environment, NODE_OPTIONS: value, MARKER: marker };
        const node = await statusOf(
          spawn(process.execPath, ["--test", "--test-reporter=dot", file], {
            env,
            stdio: "ignore",
          }),
        );
        const applied = node === 0 && !existsSync(marker);
        const filter = await statusOf(
          spawn(process.execPath, [filterPath, file], { env, stdio: "ignore" }),
        );
        return { value, applied, filter };
      }),
    );
    // (the family is not vacuous: Node applies most of these)
    assert.ok(
      results.filter(({ applied }) => applied).length >= values.length / 2,
      JSON.stringify(results),
    );
    for (const { value, applied, filter } of results)
      if (applied)
        assert.equal(
          filter,
          0,
          `NODE_OPTIONS=${value}: Node applied a selection, the filter failed the run`,
        );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * The counting family: files whose tests node:test classes differently (nested subtests, suites, skip and todo by option
 * and by call, a timeout, a cancelled child, a helper-registered test, a path with a space), and files that fail
 * outside their tests or run none. Each final review's probe file (#2357, round 7) as it wrote it, and the earlier
 * fixtures of this file's counts.
 */
const COUNTED_FAMILY: Readonly<Record<string, string>> = {
  "deep.test.mjs":
    "import test from 'node:test'; test('one', async t=>{await t.test('two',async t=>{await t.test('three',async t=>{await t.test('four',()=>{});});});});\n",
  "empty.test.mjs": "export const noTests=true;\n",
  "exit-code.test.mjs":
    "import test,{after} from 'node:test'; test('passed',()=>{}); after(()=>{process.exitCode=7;});\n",
  "failing.test.mjs":
    "import test from 'node:test';test('fail',()=>{throw Error('expected failure')});\n",
  "flags.test.mjs":
    "import test from 'node:test'; test('skip option',{skip:true},()=>{throw Error('never')}); test('skip call pass',t=>t.skip()); test('skip call fail',t=>{t.skip();throw Error('skip fail')}); test('todo option pass',{todo:true},()=>{}); test('todo option fail',{todo:true},()=>{throw Error('todo fail')}); test('todo call pass',t=>t.todo()); test('todo call fail',t=>{t.todo();throw Error('todo fail')}); test('false flags',{skip:false,todo:false},()=>{}); test('skip and todo',{skip:true,todo:true},()=>{});\n",
  "helper.mjs": "import test from 'node:test'; test('registered in helper',()=>{});\n",
  "imported.test.mjs": "import './helper.mjs';\n",
  "parent.test.mjs":
    "import test from 'node:test'; test('parent',t=>{t.test('cancelled child',()=>new Promise(r=>setTimeout(r,150)));throw Error('parent ends');});\n",
  "passing.test.mjs": "import test from 'node:test';test('pass',()=>{});\n",
  "shared-a.test.mjs": "import './helper.mjs'; import test from 'node:test'; test('a',()=>{});\n",
  "shared-b.test.mjs": "import './helper.mjs'; import test from 'node:test'; test('b',()=>{});\n",
  "space name.test.mjs": "import test from 'node:test';test('space',()=>{});\n",
  "suites.test.mjs":
    "import {describe,it} from 'node:test'; describe('outer',()=>{describe('inner',()=>{it('row1',()=>{});it('row2',()=>{});});describe('empty',()=>{});});\n",
  "throws.test.mjs": "throw Error('load failed');\n",
  "timeout.test.mjs":
    "import test from 'node:test'; test('timeout',{timeout:30},()=>new Promise(r=>setTimeout(r,150)));\n",
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
  "suites-alone.test.mjs": `import { describe } from "node:test"; describe("an empty family", () => {});`,
  // its process ends before its test reports
  "silent.test.mjs": `import test from "node:test"; test("never reported", () => process.exit(0));`,
};

/** A reporter that prints the file's own result, `passed` or `failed`, when node:test reports one. */
const OWN_RESULT_REPORTER = `export default async function* (source) {
  for await (const { type, data } of source)
    if ((type === "test:pass" || type === "test:fail") && data.entryFile === undefined && data.nesting === 0)
      yield type === "test:pass" ? "passed\\n" : "failed\\n";
}
`;

/** What `node --test` gives for `file` run alone: its spec totals, and the file's own result, if it reports one. */
async function nodeAlone(directory: string, file: string, reporter: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      `--test-reporter=${pathToFileURL(reporter).href}`,
      "--test-reporter-destination=stderr",
      file,
    ],
    { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  await once(child, "close");
  const total = (name: string) =>
    Number(new RegExp(`^ℹ ${name} (\\d+)$`, "mu").exec(stdout)?.[1] ?? NaN);
  return {
    tests: total("tests"),
    passed: total("pass"),
    failed: total("fail"),
    cancelled: total("cancelled"),
    skipped: total("skipped"),
    todo: total("todo"),
    own: /^(passed|failed)$/mu.exec(stderr)?.[1] ?? null,
  };
}

test("each file's line, with the file's own result, reconciles with node:test's totals for that file run alone", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "test-output-filter-"));
  try {
    for (const [name, source] of Object.entries(COUNTED_FAMILY))
      writeFileSync(resolve(directory, name), source);
    const reporter = resolve(directory, "own-result-reporter.mjs");
    writeFileSync(reporter, OWN_RESULT_REPORTER);
    const files = Object.keys(COUNTED_FAMILY).filter((name) => name.endsWith(".test.mjs"));
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const filtered = spawnSync(process.execPath, [filterPath, ...files], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
    const alone = await Promise.all(files.map((file) => nodeAlone(directory, file, reporter)));
    for (const [index, file] of files.entries()) {
      const node = alone[index]!;
      // the file's line by its name as written, then its counts
      const prefix = `ℹ ${file}: `;
      const lines = filtered.stdout.split("\n").filter((each) => each.startsWith(prefix));
      assert.equal(lines.length, 1, `${file}: one line\n${filtered.stdout}`);
      const line =
        /^(\d+) passed(?:, (\d+) failed)?(?:, (\d+) cancelled)?(?:, (\d+) skipped)?(?:, (\d+) todo)?(; the file failed outside any test)?(; it ran no test, which fails the run)?$/u.exec(
          lines[0]!.slice(prefix.length),
        );
      assert.ok(line, `${file}: its counts\n${lines[0]}`);
      const [passed, failed, cancelled, skipped, todo] = line
        .slice(1, 6)
        .map((count) => Number(count ?? 0));
      // (said exactly where the file ran no test and did not fail outside one)
      assert.equal(
        line[7] !== undefined,
        passed! + failed! + cancelled! + skipped! + todo! === 0 && line[6] === undefined,
        `${file}: ran no test\n${lines[0]}`,
      );
      const own = line[6] === undefined ? (node.own === "passed" ? "passed" : null) : "failed";
      assert.deepEqual(
        {
          tests: passed! + failed! + cancelled! + skipped! + todo! + (own === null ? 0 : 1),
          passed: passed! + (own === "passed" ? 1 : 0),
          failed: failed! + (own === "failed" ? 1 : 0),
          cancelled,
          skipped,
          todo,
          own,
        },
        node,
        file,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
