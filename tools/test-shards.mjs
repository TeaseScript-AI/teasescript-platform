import {
  costlyTestFiles,
  costlyTestSeconds,
  otherTestSeconds,
  pretestSeconds,
  testFilesAtOnce,
} from "./costly-test-files.mjs";

const seconds = (file) => costlyTestSeconds[file] ?? otherTestSeconds;
const byCost = (a, b) => seconds(b) - seconds(a) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The seconds shard `index` of `count` spends before its tests: CI's last test job runs the pre-test checks first.
 *
 * Left out: the first test job's regression-cases step (`.github/workflows/ci.yml`, "Regression cases at the base
 * (reported)"). It runs on pull requests only, after that shard's tests, and ends at once unless a changed test file
 * declares a regression case. In 84 pull-request runs (2026-11-08) it took 0 or 1 seconds. Weighting the first shard by
 * 1 second moves one file and changes no shard's end. Count it as the pre-test checks are counted when CI's runs show
 * it taking longer.
 */
const startSeconds = (index, count) => (count > 1 && index === count ? pretestSeconds : 0);

/**
 * The compiled test files of shard `index` (1-based) of `count`, in the order the full suite runs them (the costly files
 * first, `costlyTestFiles`). Each shard runs `testFilesAtOnce` files at once, so the files go longest first, ties by
 * name, to the shard that has a file slot free soonest, the last shard's slots starting after the pre-test checks: the
 * shards then end close together (#1638: CI's test phase as parallel jobs). A file not in `costlyTestSeconds` counts
 * `otherTestSeconds`. Every file is in exactly one shard.
 */
export function shardFiles(files, index, count) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > count
  )
    throw new Error(`no shard ${index} of ${count}`);
  const slots = Array.from({ length: count }, (_, shard) =>
    Array(testFilesAtOnce).fill(startSeconds(shard + 1, count)),
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
    ...costlyTestFiles.filter((file) => mine.has(file)),
    ...[...files].sort().filter((file) => mine.has(file) && !costlyTestFiles.includes(file)),
  ];
}

/**
 * The estimated seconds until shard `index` of `count` ends, given its files: the pre-test checks it runs first, then
 * its files `testFilesAtOnce` at once in the order given, each starting when a slot frees.
 */
export function shardSeconds(files, index, count) {
  const slots = Array(testFilesAtOnce).fill(startSeconds(index, count));
  for (const file of files) slots[slots.indexOf(Math.min(...slots))] += seconds(file);
  return Math.max(...slots);
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
