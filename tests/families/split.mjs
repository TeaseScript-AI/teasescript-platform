// An area's sources shared out among a replay's shards by their recorded seconds (#2272), for `run.mjs --split` and
// `tools/compiler-replay.mjs submit`:
//
// - `costsOf` makes a costs file from runners' `--work` records (a baseline fill's or a replay's): per area, each source
//   of `KEPT_MS` or more by its place, at its milliseconds a tree (the mean over the trees that ran it, summed over its
//   runs; the largest where a place is recorded twice), and `rest`, the count and mean milliseconds of the others. Its
//   text is a function of the records: whole milliseconds, keys sorted.
// - `binsOf` shares an area's places out among N shards: each at its recorded milliseconds, else the area's `rest` mean,
//   longest first (ties in the area's order) to the least-loaded shard (ties to the lowest index), the rule
//   `tools/test-shards.mjs` applies to CI's test files. Every place is in exactly one shard, and a source of more than
//   the area's total over N is alone in its shard: the loads never add up to more than the total, so some shard's load
//   is under that source's and the least-loaded shard is never the one that holds it.
// - `countOf` is the count of shards for a target of seconds a shard: one for each recorded source at or over the target,
//   and enough for the others' seconds at the target, at least one; with each shard's seconds as `binsOf`'s rule
//   fills it from the costs file: an estimate, not the shards the head fills.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** The milliseconds a source needs for the costs file to name it; the others count at their area's mean. */
export const KEPT_MS = 1000;

/** Each `--work` record of a queue campaign's results folder (`<job>/out/*.work.jsonl`), in their names' order. */
export function workRecordsIn(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .sort()
    .flatMap((job) => {
      const out = path.join(folder, job, "out");
      return existsSync(out)
        ? readdirSync(out)
            .filter((file) => file.endsWith(".work.jsonl"))
            .sort()
            .map((file) => path.join(out, file))
        : [];
    });
}

/** A source's milliseconds a tree in a `--work` line: each run's mean over the trees that ran it, summed. */
function msOf({ runs }) {
  let total = 0;
  for (const { ms } of runs ?? []) {
    const ran = (ms ?? []).filter((x) => typeof x === "number");
    if (ran.length > 0) total += ran.reduce((a, b) => a + b, 0) / ran.length;
  }
  return total;
}

/** The costs file's text from the `--work` records `files`, read whole; a file without a record's header is skipped. */
export function costsOf(files) {
  const areas = new Map();
  for (const file of files) {
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const ran = lines[0]?.work;
    if (ran === undefined) continue;
    const name = path.basename(ran.area);
    const sources = areas.get(name) ?? new Map();
    areas.set(name, sources);
    for (const line of lines)
      if (typeof line.generator === "string" && Array.isArray(line.runs)) {
        const place = JSON.stringify([line.generator, line.source, line.key]);
        sources.set(place, Math.max(sources.get(place) ?? 0, msOf(line)));
      }
  }
  const costs = {};
  for (const name of [...areas.keys()].sort()) {
    const kept = {};
    const others = [];
    for (const [place, ms] of [...areas.get(name)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      if (ms >= KEPT_MS) kept[place] = Math.round(ms);
      else others.push(ms);
    const mean = others.length === 0 ? 0 : others.reduce((a, b) => a + b, 0) / others.length;
    costs[name] = { rest: { count: others.length, ms: Math.round(mean) }, sources: kept };
  }
  return `${JSON.stringify({ version: 1, areas: costs })}\n`;
}

/** The costs file's text parsed and checked: each area's `rest` and `sources`; a malformed one throws. */
export function parseCosts(text) {
  const costs = JSON.parse(text);
  const whole = (n) => Number.isInteger(n) && n >= 0;
  if (costs?.version !== 1 || typeof costs.areas !== "object" || costs.areas === null)
    throw new Error("no costs file of version 1");
  for (const [name, area] of Object.entries(costs.areas))
    if (
      !whole(area?.rest?.count) ||
      !whole(area?.rest?.ms) ||
      typeof area.sources !== "object" ||
      area.sources === null ||
      !Object.values(area.sources).every(whole)
    )
      throw new Error(`the costs of ${name} are malformed`);
  return costs;
}

/** The sha256 of a costs file's text, which names it. */
export const costsHash = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Each cost of `costs` longest first (ties in their order) to the least-loaded of `n` shards (ties to the lowest index):
 * each one's shard, by its index, and each shard's load.
 */
function fill(costs, n) {
  const loads = Array(n).fill(0);
  const shards = Array(costs.length);
  const byCost = costs.map((cost, index) => ({ cost, index }));
  byCost.sort((a, b) => b.cost - a.cost || a.index - b.index);
  for (const { cost, index } of byCost) {
    let least = 0;
    for (let shard = 1; shard < n; shard += 1) if (loads[shard] < loads[least]) least = shard;
    loads[least] += cost;
    shards[index] = least;
  }
  return { shards, loads };
}

/** Each place of `places` (in the area's order; a repeat is one place) to its shard of `n` by `area`'s costs. */
export function binsOf(places, area, n) {
  const order = [...new Set(places)];
  const { shards } = fill(
    order.map((place) => area.sources[place] ?? area.rest.ms),
    n,
  );
  return new Map(order.map((place, index) => [place, shards[index]]));
}

/**
 * The count of shards of `area` for `target` seconds a shard on `trees` trees: its recorded sources at or over the
 * target one each, the rest at the target, at least one. It never passes the costs file's places of the area
 * (`sources` and `rest.count`), as each source under the target adds less than a shard. And each shard's seconds, by
 * its index, as `binsOf`'s rule fills the shards with the costs file's milliseconds (the recorded sources in its order,
 * the others at their mean). That is an estimate, not the shards the head fills: the head fills its own places in
 * their order, so a tie can order two shards the other way.
 */
export function countOf(area, target, trees) {
  const costs = [...Object.values(area.sources), ...Array(area.rest.count).fill(area.rest.ms)].map(
    (ms) => ms * trees,
  );
  // (counted in seconds, as the target is given; filled in the milliseconds `binsOf` fills)
  const seconds = costs.map((ms) => ms / 1000);
  const alone = seconds.filter((s) => s >= target).length;
  const rest = seconds.filter((s) => s < target).reduce((a, b) => a + b, 0);
  const count = Math.max(1, alone + Math.ceil(rest / target));
  return { count, seconds: fill(costs, count).loads.map((ms) => ms / 1000) };
}
