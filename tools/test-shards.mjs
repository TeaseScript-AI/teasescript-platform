import { costlyTestFiles, costlyTestSeconds, otherTestSeconds } from "./costly-test-files.mjs";

/**
 * The compiled test files of shard `index` (1-based) of `count`, in the order the full suite runs them (the costly files
 * first, `costlyTestFiles`): each file goes to the shard with the fewest estimated seconds so far, longest first, ties by
 * name, so the shards' times come out close (#1638: CI's test phase as parallel jobs). A file not in
 * `costlyTestSeconds` counts `otherTestSeconds`. Every file is in exactly one shard.
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
  const seconds = (file) => costlyTestSeconds[file] ?? otherTestSeconds;
  const loads = Array.from({ length: count }, () => 0);
  const mine = new Set();
  for (const file of [...files].sort(
    (a, b) => seconds(b) - seconds(a) || (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const shard = loads.indexOf(Math.min(...loads));
    loads[shard] += seconds(file);
    if (shard === index - 1) mine.add(file);
  }
  return [
    ...costlyTestFiles.filter((file) => mine.has(file)),
    ...[...files].sort().filter((file) => mine.has(file) && !costlyTestFiles.includes(file)),
  ];
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
