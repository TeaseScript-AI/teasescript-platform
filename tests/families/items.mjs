// node tests/families/items.mjs make <N> <prefix words...>   one item a shard: `<prefix> 0/N` to `<prefix> N-1/N`
// node tests/families/items.mjs check <items file>             every group's shards 0/N to N-1/N, each once
// The items of a central-queue pool over shards (`sx-job submit --items`): a replay's areas (`run.mjs --shard i/N`), a
// held matrix's sets, any runner whose shards are 0-based, as `run.mjs`'s are. A group is the words before an item's
// last, `i/N`; `check` refuses (exit 1) a group whose shards are not exactly 0 to N-1 once with one N, so a 1-based list,
// which skips shard 0 (twice in #1652's campaigns), never reaches the queue. `make` checks what it prints.
import { readFileSync } from "node:fs";

/** Each problem of a list of items, or none. */
function itemProblems(lines) {
  const groups = new Map();
  const problems = [];
  for (const [index, line] of lines.entries()) {
    const words = line.trim().split(/\s+/);
    const found = /^(\d+)\/(\d+)$/.exec(words.at(-1) ?? "");
    if (words.length < 2 || found === null) {
      problems.push(`line ${index + 1}: '${line}' is no '<prefix> i/N'`);
      continue;
    }
    const prefix = words.slice(0, -1).join(" ");
    const group = groups.get(prefix) ?? { counts: new Set(), shards: [] };
    group.counts.add(Number(found[2]));
    group.shards.push(Number(found[1]));
    groups.set(prefix, group);
  }
  for (const [prefix, { counts, shards }] of groups) {
    if (counts.size !== 1) {
      problems.push(
        `${prefix}: shards of ${[...counts].sort((a, b) => a - b).join(" and ")} at once`,
      );
      continue;
    }
    const [count] = counts;
    const seen = new Map();
    for (const shard of shards) seen.set(shard, (seen.get(shard) ?? 0) + 1);
    for (let shard = 0; shard < count; shard += 1)
      if (!seen.has(shard)) problems.push(`${prefix}: shard ${shard}/${count} missing`);
    for (const [shard, times] of seen) {
      if (shard >= count)
        problems.push(`${prefix}: shard ${shard}/${count} is none (shards are 0 to ${count - 1})`);
      else if (times > 1) problems.push(`${prefix}: shard ${shard}/${count} ${times} times`);
    }
  }
  return problems;
}

const [command, ...rest] = process.argv.slice(2);
const usage =
  "usage: node tests/families/items.mjs make <N> <prefix words...> | check <items file>\n";
let lines;
if (command === "make" && /^\d+$/.test(rest[0] ?? "") && Number(rest[0]) > 0 && rest.length > 1) {
  const count = Number(rest[0]);
  lines = Array.from(
    { length: count },
    (_, shard) => `${rest.slice(1).join(" ")} ${shard}/${count}`,
  );
} else if (command === "check" && rest.length === 1) {
  lines = readFileSync(rest[0], "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
} else {
  process.stderr.write(usage);
  process.exit(2);
}
const problems = itemProblems(lines);
if (problems.length > 0) {
  process.stderr.write(problems.map((problem) => `items: ${problem}\n`).join(""));
  process.exit(1);
}
if (command === "make") process.stdout.write(lines.map((line) => `${line}\n`).join(""));
else process.stdout.write(`items: ${lines.length} items, every group's shards 0 to N-1 once\n`);
