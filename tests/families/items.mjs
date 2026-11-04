// node tests/families/items.mjs make <N> <prefix words...>   one item a shard: `<prefix> 0/N` to `<prefix> N-1/N`
// node tests/families/items.mjs check <items file>             every group's shards 0/N to N-1/N, each once
// node tests/families/items.mjs submit <items file> <sx-job submit options...> -- <command>
// The items of a central-queue pool over shards (`sx-job submit --items`): a replay's areas (`run.mjs --shard i/N`), a
// held matrix's sets, any runner whose shards are 0-based, as `run.mjs`'s are. An item is its group's words and one
// shard `i/N` last, written as the runners read it (no leading zeros, N at most 10,000); `check` refuses (exit 1) a list
// that is empty, holds an item of another form, or has a group whose shards are not exactly 0 to N-1 once with one N, so
// a 1-based list, which skips shard 0 (twice in #1652's campaigns), never reaches the queue. `make` checks what it
// prints; `submit` checks the whole list, then runs `sx-job submit --items <file>` with the rest of its arguments.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_SHARDS = 10_000;
const SHARD = /^(0|[1-9]\d*)\/([1-9]\d*)$/;

/** Each problem of a list of items, or none. */
function itemProblems(lines) {
  if (lines.length === 0) return ["the list holds no item"];
  const groups = new Map();
  const problems = [];
  for (const [index, line] of lines.entries()) {
    const words = line.trim().split(/\s+/);
    const found = SHARD.exec(words.at(-1) ?? "");
    const prefix = words.slice(0, -1);
    if (prefix.length === 0 || found === null || prefix.some((word) => /\d\/\d/.test(word))) {
      problems.push(`line ${index + 1}: '${line}' is no '<words> i/N' with one shard, last`);
      continue;
    }
    const [shard, count] = [Number(found[1]), Number(found[2])];
    if (count > MAX_SHARDS) {
      problems.push(`line ${index + 1}: ${count} shards, more than ${MAX_SHARDS}`);
      continue;
    }
    const name = prefix.join(" ");
    const group = groups.get(name) ?? { counts: new Set(), seen: new Map() };
    group.counts.add(count);
    group.seen.set(shard, (group.seen.get(shard) ?? 0) + 1);
    groups.set(name, group);
  }
  for (const [name, { counts, seen }] of groups) {
    if (counts.size !== 1) {
      problems.push(
        `${name}: shards of ${[...counts].sort((a, b) => a - b).join(" and ")} at once`,
      );
      continue;
    }
    const [count] = counts;
    for (let shard = 0; shard < count; shard += 1)
      if (!seen.has(shard)) problems.push(`${name}: shard ${shard}/${count} missing`);
    for (const [shard, times] of seen)
      if (shard >= count)
        problems.push(`${name}: shard ${shard}/${count} is none (shards are 0 to ${count - 1})`);
      else if (times > 1) problems.push(`${name}: shard ${shard}/${count} ${times} times`);
  }
  return problems;
}

/** The items of a file, blank lines left out. */
const itemsOf = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

/** Exits 1 with the problems of `lines`, if any. */
function checked(lines) {
  const problems = itemProblems(lines);
  if (problems.length === 0) return;
  process.stderr.write(problems.map((problem) => `items: ${problem}\n`).join(""));
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const usage =
  "usage: node tests/families/items.mjs make <N> <prefix words...> | check <items file> |\n" +
  "       submit <items file> <sx-job submit options...> -- <command>\n";
if (command === "make" && rest.length > 1 && SHARD.test(`0/${rest[0]}`)) {
  const count = Number(rest[0]);
  // (more shards than the bound are refused from the first item)
  const lines = Array.from(
    { length: count > MAX_SHARDS ? 1 : count },
    (_, shard) => `${rest.slice(1).join(" ")} ${shard}/${count}`,
  );
  checked(lines);
  process.stdout.write(lines.map((line) => `${line}\n`).join(""));
} else if (command === "check" && rest.length === 1) {
  const lines = itemsOf(rest[0]);
  checked(lines);
  process.stdout.write(`items: ${lines.length} items, every group's shards 0 to N-1 once\n`);
} else if (command === "submit" && rest.length > 1 && rest.includes("--")) {
  checked(itemsOf(rest[0]));
  const submitted = spawnSync("sx-job", ["submit", "--items", rest[0], ...rest.slice(1)], {
    stdio: "inherit",
  });
  if (submitted.error !== undefined) {
    process.stderr.write(`items: sx-job submit could not run: ${submitted.error.message}\n`);
    process.exit(2);
  }
  process.exit(submitted.status ?? 1);
} else {
  process.stderr.write(usage);
  process.exit(2);
}
