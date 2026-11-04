import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { costlyTestFiles, costlyTestSeconds, otherTestSeconds } from "./costly-test-files.mjs";
import { shardFiles, shardOption } from "./test-shards.mjs";

// The suite's files: the costly ones and 298 others, as main had them when the seconds were measured (#1638).
const files = [
  ...costlyTestFiles,
  ...Array.from({ length: 298 }, (_, i) => `other-${String(i).padStart(3, "0")}.test.js`),
].reverse();
const seconds = (list) =>
  list.reduce((sum, file) => sum + (costlyTestSeconds[file] ?? otherTestSeconds), 0);

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

test("the shards' estimated seconds differ by no more than the costliest file", () => {
  for (const count of [2, 3]) {
    const loads = Array.from({ length: count }, (_, i) => seconds(shardFiles(files, i + 1, count)));
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

test("the filter's two shards run every compiled test file once between them, and refuse a shard beside files", (t) => {
  const filter = fileURLToPath(new URL("./test-output-filter.mjs", import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), "test-shards-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "dist", "tests"), { recursive: true });
  // (two costly files and three others, one a name no list holds)
  const names = [
    costlyTestFiles[0],
    costlyTestFiles[1],
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
    const result = run("--full-output", `--shard=${shard}`);
    assert.equal(result.status, 0, result.stderr);
    return [...result.stdout.matchAll(/ran (\S+\.test\.js)/g)].map((found) => found[1]);
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
