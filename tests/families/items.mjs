// node tests/families/items.mjs make <N> <prefix words...>   one item a shard: `<prefix> 0/N` to `<prefix> N-1/N`
// node tests/families/items.mjs check <items file>             every group's shards 0/N to N-1/N, each once
// node tests/families/items.mjs submit <items file> <sx-job submit options...> -- <command>
// The items of a central-queue pool over shards (`sx-job submit --items`): a replay's areas (`run.mjs --shard i/N`), a
// held matrix's sets, any runner whose shards are 0-based, as `run.mjs`'s are. An item is its group's words and one
// shard `i/N` last, written as the runners read it (no leading zeros, N at most 10,000); `check` refuses (exit 1) a list
// that is empty, holds an item of another form, or has a group whose shards are not exactly 0 to N-1 once with one N, so
// a 1-based list, which skips shard 0 (twice in #1652's campaigns), never reaches the queue. `make` checks what it
// prints; `submit` checks the whole list, then runs `sx-job submit` with the list as its one items option and the rest
// of its arguments, whose options must be ones that cannot change the items (`SUBMIT_OPTIONS`).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_SHARDS = 10_000;

/**
 * The `sx-job submit` options `submit` forwards, by full name, each with whether it takes a value: every one that
 * cannot change or multiply the item set (not `--items`, not `--shards`).
 */
const SUBMIT_OPTIONS = new Map([
  ["--name", true],
  ["--owner", true],
  ["--campaign", true],
  ["--priority", true],
  ["--for", true],
  ["--mem", true],
  ["--class", true],
  ["--timeout", true],
  ["--host", true],
  ["--node", true],
  ["--commit", true],
  ["--checkout", true],
  ["--patch", true],
  ["--in", true],
  ["--after", true],
  ["--in-result", true],
  ["--needs-baseline", true],
  ["--data", true],
  ["--alone", true],
  ["--write", true],
  ["--target", true],
  ["--big", false],
  ["--writable-trees", false],
  ["--sandbox", false],
  ["--dry", false],
]);
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
  // (the items the check accepted are exactly the items the queue receives: `submit` forwards only the queue options
  // that cannot change or multiply the item set (`SUBMIT_OPTIONS`), each by its full name, and refuses any other, as
  // `--items` in any spelling or `--shards`; the checked file goes as the one items option, its absolute path attached)
  const split = rest.indexOf("--");
  const [file, options, command] = [rest[0], rest.slice(1, split), rest.slice(split)];
  for (let index = 0; index < options.length; index += 1) {
    const [name, attached] = [options[index].split("=")[0], options[index].includes("=")];
    const takes = SUBMIT_OPTIONS.get(name);
    if (takes === undefined) {
      process.stderr.write(
        `items: submit forwards no '${name}' (it could change the checked items; the forwarded options are ` +
          `${[...SUBMIT_OPTIONS.keys()].join(" ")})\n`,
      );
      process.exit(2);
    }
    if (takes && !attached) index += 1;
  }
  checked(itemsOf(file));
  const submitted = spawnSync(
    "sx-job",
    ["submit", ...options, `--items=${resolve(file)}`, ...command],
    { stdio: "inherit" },
  );
  if (submitted.error !== undefined) {
    process.stderr.write(`items: sx-job submit could not run: ${submitted.error.message}\n`);
    process.exit(2);
  }
  process.exit(submitted.status ?? 1);
} else {
  process.stderr.write(usage);
  process.exit(2);
}
