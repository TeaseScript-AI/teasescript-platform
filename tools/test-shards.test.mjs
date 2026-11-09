import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  costlyTestFiles,
  costlyTestSeconds,
  oracleSeconds,
  otherTestSeconds,
  pretestSeconds,
  testFilesAtOnce,
} from "./costly-test-files.mjs";
import { UNKNOWN_TO_COSTLY, unknownToCostly } from "./check-changed.mjs";
import { shardFiles, shardOption, shardSeconds, suiteTestFiles } from "./test-shards.mjs";

// The suite's files: the costly ones and 298 others.
const files = [
  ...costlyTestFiles,
  ...Array.from({ length: 298 }, (_, i) => `other-${String(i).padStart(3, "0")}.test.js`),
].reverse();

test("every test file is in exactly one shard, the costly ones first in each", () => {
  for (const count of [1, 2, 3, 4]) {
    const shards = Array.from({ length: count }, (_, i) => shardFiles(files, i + 1, count));
    assert.deepEqual(shards.flat().sort(), [...files].sort(), `${count} shards`);
    for (const shard of shards) {
      const costly = shard.filter((file) => costlyTestFiles.includes(file));
      assert.deepEqual(shard.slice(0, costly.length), costly, `${count} shards`);
    }
  }
  // (the order the files come in changes nothing)
  assert.deepEqual(shardFiles([...files].reverse(), 2, 3), shardFiles(files, 2, 3));
});

test("a type-core test file the table does not list runs, in exactly one shard, at the default seconds (#2088)", () => {
  const unlisted = "type-core-unlisted.test.js";
  assert.equal(costlyTestSeconds[unlisted], undefined);
  for (let count = 1; count <= 4; count += 1) {
    const holding = Array.from({ length: count }, (_, index) =>
      shardFiles([...files, unlisted], index + 1, count),
    ).filter((shard) => shard.includes(unlisted));
    assert.equal(holding.length, 1, `${count} shards`);
  }
  assert.equal(shardSeconds([unlisted], 1, 1), otherTestSeconds);
});

test("the suite is each test file at the top and one folder down, but none in fixtures/, helpers/ or deeper", (t) => {
  const root = mkdtempSync(join(tmpdir(), "suite-test-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [
    "a.test.js",
    "player/b.test.js",
    "player/helper.js",
    "player/deep/c.test.js",
    "helpers/d.test.js",
    "fixtures/e.test.js",
    "a.test.ts",
    "player/b.test.ts",
    "helpers/d.test.ts",
  ]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  assert.deepEqual(suiteTestFiles(root, ".test.js"), ["a.test.js", "player/b.test.js"]);
  assert.deepEqual(suiteTestFiles(root, ".test.ts"), ["a.test.ts", "player/b.test.ts"]);
  // (a type-core test file in a folder is one the costly table must list, as one at the top is)
  assert.deepEqual(
    unknownToCostly([
      "tests/type-core-new.test.ts",
      "tests/type-core/type-core-new.test.ts",
      "tests/type-core/deep/type-core-new.test.ts",
    ]),
    ["tests/type-core-new.test.ts", "tests/type-core/type-core-new.test.ts"],
  );
});

test("the shards' estimated ends, the first's with the oracle comparison, the last's with the pre-test checks, differ by no more than the costliest file", () => {
  assert.equal(shardSeconds([], 1, 2), oracleSeconds);
  assert.equal(shardSeconds([], 2, 2), pretestSeconds);
  assert.equal(shardSeconds([], 1, 1), 0, "one shard, as `npm test` runs locally, runs neither");
  for (const count of [2, 3]) {
    const loads = Array.from({ length: count }, (_, i) =>
      shardSeconds(shardFiles(files, i + 1, count), i + 1, count),
    );
    assert.ok(
      Math.max(...loads) - Math.min(...loads) <= Math.max(...Object.values(costlyTestSeconds)),
      `${count} shards: ${loads.map((load) => load.toFixed(0)).join(", ")}`,
    );
  }
  assert.deepEqual(shardFiles(files, 1, 1), [
    ...costlyTestFiles,
    ...files.filter((f) => !costlyTestFiles.includes(f)).sort(),
  ]);
});

test("each shard's fixed seconds are counted where they fall: shard 1 gets fewer files for its oracle comparison", () => {
  // Equal small files, so the shards' loads can come within one file of each other: shard 1's files then fill the
  // oracle comparison's seconds less than shard 2's fill its pre-test checks' seconds.
  const small = Array.from(
    { length: 300 },
    (_, i) => `small-${String(i).padStart(3, "0")}.test.js`,
  );
  const [first, second] = [shardFiles(small, 1, 2), shardFiles(small, 2, 2)];
  assert.ok(oracleSeconds > pretestSeconds);
  assert.ok(first.length < second.length, `${first.length} files against ${second.length}`);
  const [firstEnd, secondEnd] = [shardSeconds(first, 1, 2), shardSeconds(second, 2, 2)];
  assert.ok(
    Math.abs(firstEnd - secondEnd) <= otherTestSeconds,
    `${firstEnd} s against ${secondEnd} s`,
  );
  // Without the oracle seconds the files would split as before: shard 1 would take the extra ones.
  assert.ok(
    shardSeconds(first, 1, 2) - oracleSeconds < shardSeconds(second, 2, 2) - pretestSeconds,
  );
});

test("every file with seconds exists, costliest first; a type-core test file without them is named, not refused (#2088)", (t) => {
  const sources = suiteTestFiles(join(import.meta.dirname, "../tests"), ".test.ts");
  const suite = sources.map((file) => file.replace(/\.ts$/, ".js"));
  assert.ok(suite.some((file) => file.startsWith("type-core-")));
  // (a new type-core test file runs in full until the coordinator lands its entry from the merge's CI runs: the line
  // `check-changed` prints, here on every run until then)
  const unknown = unknownToCostly(sources.map((file) => `tests/${file}`));
  if (unknown.length > 0) t.diagnostic(`${unknown.join(", ")}: ${UNKNOWN_TO_COSTLY}`);
  assert.deepEqual(
    costlyTestFiles.filter((file) => !suite.includes(file)),
    [],
  );
  // (costliest first, the order the full suite starts them in)
  assert.deepEqual(
    costlyTestFiles,
    [...costlyTestFiles].sort((a, b) => costlyTestSeconds[b] - costlyTestSeconds[a]),
  );
});

test("--shard=i/N names shard i of N, and anything else malformed is refused", () => {
  assert.deepEqual(shardOption("--shard=2/3"), { index: 2, count: 3 });
  assert.equal(shardOption("dist/tests/a.test.js"), null);
  for (const bad of [
    "--shard=0/2",
    "--shard=3/2",
    "--shard=1/0",
    "--shard=x/2",
    "--shard=1",
    "--shard",
  ])
    assert.throws(() => shardOption(bad), /--shard=i\/N/, bad);
});

test("the filter's two shards run every compiled test file once between them, one in a folder too, keep each one's seconds by its path, and refuse a shard beside files", (t) => {
  const filter = fileURLToPath(new URL("./test-output-filter.mjs", import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), "test-shards-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "dist", "tests"), { recursive: true });
  // (one costly file more than a shard runs at once, and three others, one a name no list holds)
  const names = [
    ...costlyTestFiles.slice(0, testFilesAtOnce + 1),
    "a.test.js",
    "b.test.js",
    "unlisted-new.test.js",
    "player/c.test.js",
  ];
  mkdirSync(join(cwd, "dist", "tests", "player"));
  for (const name of names)
    writeFileSync(
      join(cwd, "dist", "tests", name),
      `import { test } from "node:test";\ntest(${JSON.stringify(`ran ${name}`)}, () => {});\n`,
    );
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const run = (...args) =>
    spawnSync(process.execPath, [filter, ...args], {
      cwd,
      encoding: "utf8",
      env: environment,
      input: "",
    });
  const ran = (shard) => {
    // (with TEST_FILE_SECONDS, as CI runs it: each file the shard ran has its seconds there)
    environment.TEST_FILE_SECONDS = join(cwd, `seconds-${shard.replace("/", "of")}.json`);
    const result = run("--full-output", `--shard=${shard}`);
    assert.equal(result.status, 0, result.stderr);
    const files = [...result.stdout.matchAll(/ran (\S+\.test\.js)/g)].map((found) => found[1]);
    const kept = JSON.parse(readFileSync(environment.TEST_FILE_SECONDS, "utf8"));
    assert.deepEqual(Object.keys(kept.seconds).sort(), [...files].sort());
    assert.ok(Object.values(kept.seconds).every((seconds) => seconds > 0));
    delete environment.TEST_FILE_SECONDS;
    return files;
  };
  const [first, second] = [ran("1/2"), ran("2/2")];
  assert.ok(first.length > 0 && second.length > 0, `${first} | ${second}`);
  assert.deepEqual([...first, ...second].sort(), [...names].sort());
  for (const args of [
    ["dist/tests/a.test.js", "--shard=1/2"],
    ["--shard=1/2", "dist/tests/a.test.js"],
    ["dist/tests/a.test.js", "--shard=0/2"],
  ]) {
    const refused = run(...args);
    assert.equal(refused.status, 1, args.join(" "));
    assert.match(refused.stderr, /--shard/, args.join(" "));
  }
});
