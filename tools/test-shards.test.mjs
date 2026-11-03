import assert from "node:assert/strict";
import { test } from "node:test";
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
  for (const bad of ["--shard=0/2", "--shard=3/2", "--shard=1/0", "--shard=x/2", "--shard=1"])
    assert.throws(() => shardOption(bad), /--shard=i\/N/, bad);
});
