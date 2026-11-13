import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  costlyTestFiles,
  costlyTestSeconds,
  otherTestSeconds,
  pretestSeconds,
  testFilesAtOnce,
} from "./costly-test-files.mjs";

/** The measured weights `tools/test-runner/costly-test-files.mjs` holds; a test passes fixed ones to pin the rule apart from them. */
const MEASURED = {
  costlyTestFiles,
  costlyTestSeconds,
  otherTestSeconds,
  pretestSeconds,
  testFilesAtOnce,
};

const secondsOf = (weights) => (file) =>
  weights.costlyTestSeconds[file] ?? weights.otherTestSeconds;

/** The seconds shard `index` of `count` spends before its tests: CI's last test job runs the pre-test checks first. */
const startSeconds = (index, count, weights) =>
  count > 1 && index === count ? weights.pretestSeconds : 0;

/**
 * The compiled test files of shard `index` (1-based) of `count`, in the order the full suite runs them (the costly files
 * first, `costlyTestFiles`). Each shard runs `testFilesAtOnce` files at once, so the files go longest first, ties by
 * name, to the shard that has a file slot free soonest, the last shard's slots starting after the pre-test checks: the
 * shards then end close together (#1638: CI's test phase as parallel jobs). A file not in `costlyTestSeconds` counts
 * `otherTestSeconds`. Every file is in exactly one shard. `weights` defaults to the measured ones (`MEASURED`).
 */
export function shardFiles(files, index, count, weights = MEASURED) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > count
  )
    throw new Error(`no shard ${index} of ${count}`);
  const seconds = secondsOf(weights);
  const byCost = (a, b) => seconds(b) - seconds(a) || (a < b ? -1 : a > b ? 1 : 0);
  const slots = Array.from({ length: count }, (_, shard) =>
    Array(weights.testFilesAtOnce).fill(startSeconds(shard + 1, count, weights)),
  );
  const mine = new Set();
  for (const file of [...files].sort(byCost)) {
    let [shard, slot] = [0, 0];
    for (const [s, times] of slots.entries())
      for (const [t, time] of times.entries())
        if (time < slots[shard][slot]) [shard, slot] = [s, t];
    slots[shard][slot] += seconds(file);
    if (shard === index - 1) mine.add(file);
  }
  return [
    ...weights.costlyTestFiles.filter((file) => mine.has(file)),
    ...[...files]
      .sort()
      .filter((file) => mine.has(file) && !weights.costlyTestFiles.includes(file)),
  ];
}

/**
 * The estimated seconds until shard `index` of `count` ends, given its files: the pre-test checks it runs first, then
 * its files `testFilesAtOnce` at once in the order given, each starting when a slot frees.
 */
export function shardSeconds(files, index, count, weights = MEASURED) {
  const seconds = secondsOf(weights);
  const slots = Array(weights.testFilesAtOnce).fill(startSeconds(index, count, weights));
  for (const file of files) slots[slots.indexOf(Math.min(...slots))] += seconds(file);
  return Math.max(...slots);
}

/** The folders under `tests/` that hold no test files, so the suite reads none of them: a closed list. */
const NOT_TEST_FOLDERS = new Set(["fixtures", "helpers"]);

/** How many folders deep under `tests/` the suite reads test files: a folder, and one folder inside it. */
const SUITE_FOLDER_DEPTH = 2;

/**
 * Whether `name`, a path under `tests/` or `dist/tests/` with `/` between folders, is where the suite reads a test file
 * ending in `suffix`: at the top, or at most `SUITE_FOLDER_DEPTH` folders down in a folder other than `fixtures/` and
 * `helpers/` (`NOT_TEST_FOLDERS`), as `player/x.test.js` or `player/debug/x.test.js`. A file deeper is not one.
 */
export function isSuiteTestPath(name, suffix) {
  const parts = name.split("/");
  return (
    name.endsWith(suffix) &&
    parts.length <= SUITE_FOLDER_DEPTH + 1 &&
    (parts.length === 1 || !NOT_TEST_FOLDERS.has(parts[0]))
  );
}

/**
 * The suite's files under `folder` (`tests/` or `dist/tests/`) whose names end in `suffix`, by their path under it
 * (`isSuiteTestPath`); only regular files count, not links. A file at the top is named by its name alone, as the suite
 * named every file before it had folders, so the costly table's keys, the shard order and the kept seconds stay those
 * of a flat suite.
 */
export function suiteTestFiles(folder, suffix) {
  const files = [];
  const read = (under, depth) => {
    for (const entry of readdirSync(join(folder, under), { withFileTypes: true })) {
      const name = under === "" ? entry.name : `${under}/${entry.name}`;
      if (entry.isFile()) {
        if (isSuiteTestPath(name, suffix)) files.push(name);
      } else if (entry.isDirectory() && depth < SUITE_FOLDER_DEPTH) read(name, depth + 1);
    }
  };
  read("", 0);
  return files.sort();
}

/** A compiled test file's name, as `suiteTestFiles` gives it: its path under `dist/tests/`, with `/` between folders. */
export function suiteName(file) {
  return relative(resolve("dist/tests"), file).split(sep).join("/");
}

/** Whether a test file, by its path under `tests/` or `dist/tests/`, is a type-core one: its own name says so. */
export function isTypeCoreTestFile(name) {
  return name.split("/").at(-1).startsWith("type-core-");
}

/** `--shard=i/N`'s shard, or `null` for any other argument; a malformed one throws. */
export function shardOption(argument) {
  if (!argument.startsWith("--shard")) return null;
  const found = /^--shard=(\d+)\/(\d+)$/.exec(argument);
  const [index, count] = found === null ? [0, 0] : [Number(found[1]), Number(found[2])];
  if (count < 1 || index < 1 || index > count)
    throw new Error(`'${argument}' is not --shard=i/N with 1 <= i <= N`);
  return { index, count };
}
