// node tests/families/items.mjs make <N> <prefix words...>   one item a shard: `<prefix> 0/N` to `<prefix> N-1/N`
// node tests/families/items.mjs check <items file> [--area <area>] every group's shards 0/N to N-1/N, each once
// node tests/families/items.mjs sources <area> [--sizes 4,8]     one item a source: its place, in the area's order
// node tests/families/items.mjs submit <items file> <sx-job submit options...> -- <command>
// The items of a central-queue pool over shards (`sx-job submit --items`): a replay's areas (`run.mjs --shard i/N`), a
// held matrix's sets, any runner whose shards are 0-based, as `run.mjs`'s are. An item is its group's words and one
// shard `i/N` last, written as the runners read it (no leading zeros, N at most 10,000); `check` refuses (exit 1) a list
// that is empty, holds an item of another form, or has a group whose shards are not exactly 0 to N-1 once with one N, so
// a 1-based list, which skips shard 0 (twice in #1652's campaigns), never reaches the queue. `make` checks what it
// prints; `submit` checks the whole list, then runs `sx-job submit` with the list as its one items option and the rest
// of its arguments, whose options must be ones that cannot change the items (`SUBMIT_OPTIONS`). A list of sources
// (`sources`, #1826: a replay's `run.mjs --items`, which the queue batches by their time, not by shard) is one source's
// place a line (`placeOf`'s `[generator, name, key]`), each once; `check --area` also asks it to hold every source of
// the area and no other.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatorsOf, placeOf } from "./sources.mjs";

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

/** Whether a line is a source's place, `[generator, name, key]`. */
function isPlace(line) {
  try {
    const place = JSON.parse(line);
    return Array.isArray(place) && place.length === 3 && place.every((x) => typeof x === "string");
  } catch {
    return false;
  }
}

/** Each problem of a list of sources' places (each once; with `area`'s places, exactly those), or none. */
function sourceProblems(lines, area) {
  const problems = [];
  const seen = new Set();
  for (const [index, line] of lines.entries()) {
    if (!isPlace(line)) {
      problems.push(`line ${index + 1}: '${line}' is no source's place ([generator, name, key])`);
      continue;
    }
    const place = JSON.stringify(JSON.parse(line));
    if (seen.has(place)) problems.push(`line ${index + 1}: ${place} twice`);
    seen.add(place);
  }
  if (area !== undefined) {
    const held = new Set(area);
    for (const place of held) if (!seen.has(place)) problems.push(`${place} missing`);
    for (const place of seen)
      if (!held.has(place)) problems.push(`${place} is no source of the area`);
  }
  return problems;
}

/** Each problem of a list of items (shards, or sources' places with `area`'s), or none. */
function itemProblems(lines, area) {
  if (lines.length === 0) return ["the list holds no item"];
  if (lines[0].trim().startsWith("[")) return sourceProblems(lines, area);
  if (area !== undefined) return ["--area checks a list of sources, not of shards"];
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

/** Every source's place of an area (a folder of tests/families/, or an absolute one), in its order, a repeat again. */
async function placesOf(area, sizes) {
  const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), area);
  return (await generatorsOf(folder, sizes)).flatMap(({ name, sources }) =>
    sources.map((source) => placeOf(name, source)),
  );
}

/** Exits 1 with the problems of `lines`, if any. */
function checked(lines, area) {
  const problems = itemProblems(lines, area);
  if (problems.length === 0) return;
  process.stderr.write(problems.map((problem) => `items: ${problem}\n`).join(""));
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const usage =
  "usage: node tests/families/items.mjs make <N> <prefix words...> | check <items file> [--area <area>] |\n" +
  "       sources <area> [--sizes 4,8] | submit <items file> <sx-job submit options...> -- <command>\n";
if (command === "make" && rest.length > 1 && SHARD.test(`0/${rest[0]}`)) {
  const count = Number(rest[0]);
  // (more shards than the bound are refused from the first item)
  const lines = Array.from(
    { length: count > MAX_SHARDS ? 1 : count },
    (_, shard) => `${rest.slice(1).join(" ")} ${shard}/${count}`,
  );
  checked(lines);
  process.stdout.write(lines.map((line) => `${line}\n`).join(""));
} else if (
  command === "check" &&
  (rest.length === 1 || (rest.length === 3 && rest[1] === "--area"))
) {
  const lines = itemsOf(rest[0]);
  checked(lines, rest.length === 3 ? await placesOf(rest[2]) : undefined);
  process.stdout.write(
    lines[0].trim().startsWith("[")
      ? `items: ${lines.length} sources, each once${rest.length === 3 ? ", the area's every source" : ""}\n`
      : `items: ${lines.length} items, every group's shards 0 to N-1 once\n`,
  );
} else if (
  command === "sources" &&
  (rest.length === 1 || (rest.length === 3 && rest[1] === "--sizes"))
) {
  const sizes = rest.length === 3 ? rest[2].split(",").map(Number) : undefined;
  // (a repeated source, one whose text does not depend on its size, is one place, which `run.mjs --items` runs each time)
  const lines = [...new Set(await placesOf(rest[0], sizes))];
  checked(lines);
  process.stdout.write(lines.map((line) => `${line}\n`).join(""));
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
