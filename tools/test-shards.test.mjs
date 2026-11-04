import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  costlyTestFiles,
  costlyTestSeconds,
  otherTestSeconds,
  pretestSeconds,
  testFilesAtOnce,
} from "./costly-test-files.mjs";
import { shardFiles, shardOption, shardSeconds } from "./test-shards.mjs";

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

test("the shards' estimated ends, the last after the pre-test checks, differ by no more than the costliest file", () => {
  assert.equal(shardSeconds([], 1, 2), 0);
  assert.equal(shardSeconds([], 2, 2), pretestSeconds);
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

test("the costliest files fill shard 1's slots, and the next starts in shard 2 after the pre-test checks", () => {
  const costliest = costlyTestFiles.slice(0, testFilesAtOnce + 1);
  assert.ok(pretestSeconds < costlyTestSeconds[costliest[testFilesAtOnce - 1]]);
  assert.deepEqual(shardFiles(costliest, 1, 2), costliest.slice(0, testFilesAtOnce));
  assert.deepEqual(shardFiles(costliest, 2, 2), costliest.slice(testFilesAtOnce));
  // (small files take shard 1's free slots while shard 2 runs its pre-test checks)
  const small = Array.from({ length: 10 }, (_, i) => `small-${i}.test.js`);
  assert.ok(small.length * otherTestSeconds < pretestSeconds);
  assert.deepEqual(shardFiles([costliest[0], ...small], 2, 2), []);
});

test("every type-core test file has measured seconds, and every file with seconds exists", () => {
  const suite = readdirSync(new URL("../tests/", import.meta.url))
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => file.replace(/\.ts$/, ".js"));
  const typeCore = suite.filter((file) => file.startsWith("type-core-"));
  assert.ok(typeCore.length > 0);
  assert.deepEqual(
    typeCore.filter((file) => costlyTestSeconds[file] === undefined),
    [],
    "regenerate tools/costly-test-files.mjs (its header says how)",
  );
  assert.deepEqual(
    costlyTestFiles.filter((file) => !suite.includes(file)),
    [],
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

test("the filter's two shards run every compiled test file once between them, keep each one's seconds, and refuse a shard beside files", (t) => {
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
  ];
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
