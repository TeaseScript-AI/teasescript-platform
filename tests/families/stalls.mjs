// node tests/families/stalls.mjs <replay record>... [--rerun <record>...] [--index <new file>]
// node tests/families/stalls.mjs rerun <index> <base> <head> <new folder> [--timeout 180] [--memory 2048]
// A replay's comparison from its shards' records (`run.mjs --work`: what was compared, then one line per source with
// each run's charged work and milliseconds on each tree and what the source counted), with a verdict on each stalled
// source (`verdictOf`, its rule `RULE`), and a rerun's records read in place of the replay's for the sources it ran
// (#1564). A replay's `--out` file stands in for a shard recorded without `--work`: it gives the shard's stalls alone,
// each `unknown`, and no count of what agreed. One comparison is one configuration (`configuration`: the sources'
// sizes, the area's plan (the hash of every source's place in its order), the stop runs' allowances, each generator's
// checks, each tree's identity): an area's shards and every rerun record merged into it must share it (another is
// refused, exit 2, never closed), and the area is complete only with its shards 0/N to N-1/N, one N, of that plan. A
// plan may list one source more than once: its repeats (one place, each run and counted by the runner, and each shard's
// lines checked against its total) are one source where they record the same counts, stall and runs, milliseconds apart
// (`repeats` counts the others), and are refused (exit 2, naming the place) where they differ, in a replay and in a
// rerun alike (#1582). Prints the rule, one line per stalled source of the replay (with what its rerun did), one per
// area and a total; exits 0 only where every area is complete, every source of it was compared and agrees, an
// unavailable one (stalled) never counting as agreement, and no candidate stall is left, 1 otherwise, 2 on a record it
// cannot read or merge. `--index` writes the sources still unavailable, with their verdicts and records, and each
// area's configuration: the stall index, which `rerun` runs on both trees in one process, one source at a time, an area
// after another, with that configuration (`run.mjs <area> <base> <head> --only <index>`), into a new folder of records,
// `<area>.work.jsonl` and `<area>.jsonl` (`--out`), to be read with `--rerun`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comparedOf } from "./baselines.mjs";
import { sourceKey } from "./sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** What `verdictOf` decides, stated in the summary and the index. */
export const RULE =
  "A stalled source is a candidate stall where the head alone stalled for a reason other than time (memory, a fatal " +
  "error), where on one run the head charged more work than the base charged in the whole run, or, a heuristic for " +
  "work no ledger charges, where the trees ran in one process and over the runs the head started it took more than " +
  "twice the time the base's rate of work gives the head's work, plus ten seconds (a loaded worker can stretch either " +
  "tree's time); a rerun that runs it to its end does not clear the last two. It is load where every run the head " +
  "started ended, the base's work recorded for each, none of these holds and the stall is a timeout or the base's " +
  "alone. Else it is unknown (a run of the head cut short of the base's work, which no record resolves, or no work of " +
  "the base recorded, as against a stored baseline): rerun it on both trees.";

/**
 * A stalled source's verdict from its normalized record (`entryOf`): `candidate`, `load` or `unknown` (`RULE`), and why,
 * naming the run that decides. Work is compared run by run, as each tree's work on a run does not depend on the load;
 * time over the runs the head started, as one run's time on a loaded worker can double at equal work.
 */
export function verdictOf({ stalled = {}, runs, paired }) {
  const { base, head, source } = stalled;
  if (head !== undefined && head !== "timeout" && base === undefined)
    return { verdict: "candidate", why: `the head alone stalled: ${head}` };
  if (runs === undefined)
    return { verdict: "unknown", why: "no work recorded (a shard run without --work)" };
  const spent = { work: [0, 0], ms: [0, 0] };
  let started = 0;
  let cut;
  for (const { mode, check, base: was, head: is } of runs) {
    if (is === null) continue;
    started += 1;
    const run = `${mode} ${check}`;
    if (was === null || !was.done || was.work === null || is.work === null)
      return {
        verdict: "unknown",
        why: `no work of the ${is.work === null ? "head" : "base"} recorded on ${run}`,
      };
    if (is.work > was.work)
      return {
        verdict: "candidate",
        why: `on ${run} the head charged ${is.work} units${is.done ? "" : " before the stall"}, the base ${was.work}`,
      };
    if (!is.done) cut = `the head's ${run} was cut at ${is.work} of the base's ${was.work} units`;
    [was, is].forEach((tree, index) => {
      spent.work[index] += tree.work;
      spent.ms[index] += tree.ms;
    });
  }
  const [work, ms] = [spent.work, spent.ms];
  const expected = work[0] > 0 ? (work[1] * ms[0]) / work[0] : ms[0];
  if (paired && ms[1] > 2 * expected + 10_000)
    return {
      verdict: "candidate",
      why: `over its ${started} runs the head took ${ms[1]} ms for ${work[1]} units, the base ${ms[0]} ms for ${work[0]}`,
    };
  if (cut !== undefined) return { verdict: "unknown", why: cut };
  const reason = head ?? source;
  if (reason !== undefined && reason !== "timeout")
    return { verdict: "unknown", why: `the source stalled (${reason}) between its runs` };
  const alone =
    head === undefined && source === undefined ? `the base alone stalled (${base}); ` : "";
  return {
    verdict: "load",
    why:
      alone +
      (started === 0
        ? "the head started no run"
        : `${started === 1 ? "the one run" : `each of the ${started} runs`} the head started ended at no more work ` +
          "than the base's" +
          (paired ? ", in at most twice the base's time for it and ten seconds" : "")),
  };
}

/** A usage or record the tool refuses (exit 2). */
function refused(problem) {
  console.error(problem);
  process.exit(2);
}

/** An area's name: the folder the runner was given, without its path. */
const nameOf = (area) => path.basename(String(area));

/** A source's place in a replay: its area, generator, name and key. */
const placeOf = ({ area, generator, source, key }) =>
  JSON.stringify([nameOf(area), generator, source, key]);

/** The area of a generator (generator names are unique across the areas), for a record that does not say it. */
function areaOf(generator) {
  for (const entry of readdirSync(here, { withFileTypes: true }))
    if (entry.isDirectory() && existsSync(path.join(here, entry.name, generator)))
      return entry.name;
  return refused(`no area of ${here} holds the generator ${generator}`);
}

/**
 * A record's run as the verdict reads it: each tree's work, milliseconds and whether it ended (`base` and `head`, `null`
 * where the tree did not run it here), the base being the stored one, not recorded, where one tree ran.
 */
function runOf({ mode, check, work, ms, running }) {
  const tree = (index) =>
    ms[index] === null ? null : { work: work[index], ms: ms[index], done: running !== index };
  return work.length === 2
    ? { mode, check, base: tree(0), head: tree(1) }
    : { mode, check, base: null, head: tree(0) };
}

/**
 * A record's source as this tool reads it: its place, what it counted, its runs (`runOf`) and which tree stalled
 * (`base`, `head`, or `source` where neither is known).
 */
function entryOf(line, area, trees) {
  const runs = line.runs?.map(runOf);
  let { stalled } = line;
  if (typeof stalled === "string") {
    const running = line.runs?.at(-1)?.running;
    const tree = trees === 2 && running !== undefined ? ["base", "head"][running] : undefined;
    stalled = { [tree ?? (trees === 1 ? "head" : "source")]: stalled };
  } else if (stalled !== undefined)
    stalled = Object.fromEntries(Object.entries(stalled).filter(([, why]) => why !== undefined));
  return { ...line, area, stalled, runs, paired: trees === 2 };
}

const PROBLEMS = ["differences", "exceptions", "unanswered", "uncompared"];
const COUNTED = ["runs", "unparsed", ...PROBLEMS, "stalled"];

/**
 * A shard's sources from its record: a `--work` file (its first line what ran, its last the total, which the sources'
 * counts must add up to), or a `--out` file, whose stalled sources alone it gives.
 */
function shardOf(file) {
  let lines;
  try {
    lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  } catch (error) {
    return refused(`${file}: ${error.message}`);
  }
  const ran = lines[0]?.work;
  if (ran === undefined)
    return {
      file,
      entries: lines
        .filter((line) => line.stalled !== undefined)
        .map((line) => ({
          ...entryOf(
            { ...line, key: sourceKey(line), runs: undefined },
            areaOf(line.generator),
            undefined,
          ),
          files: undefined,
          globals: undefined,
          counts: { stalled: 1 },
          listed: true,
        })),
    };
  if (ran.store !== undefined) refused(`${file} records a store, which compares nothing`);
  if (ran.configuration === undefined)
    refused(`${file} records no configuration of its comparison`);
  const total = lines.at(-1)?.total;
  if (total === undefined || lines.length < 2)
    refused(`${file} has no total: its shard did not end`);
  const entries = lines.slice(1, -1).map((line) => entryOf(line, ran.area, ran.roots.length));
  const sums = Object.fromEntries(
    COUNTED.map((key) => [key, entries.reduce((sum, { counts }) => sum + (counts[key] ?? 0), 0)]),
  );
  const differ = ["sources", ...COUNTED].filter(
    (key) => (key === "sources" ? entries.length : sums[key]) !== total[key],
  );
  if (differ.length > 0) refused(`${file}: its sources do not add up to its total (${differ})`);
  return { file, ran, entries };
}

/**
 * Whether a configuration's tree `expected` is the tree `actual` names (`comparedOf`'s): a stored base (`stored`) where
 * `actual` is that base or a tree of its MANIFEST's identity, any other where `actual` is the same.
 */
const sameTree = (expected, actual) =>
  expected.stored !== undefined
    ? JSON.stringify(expected.stored) === JSON.stringify(actual?.stored ?? actual?.identity)
    : JSON.stringify(expected) === JSON.stringify(actual);

/**
 * Where two configurations of a comparison differ (`run.mjs`'s `configuration`), by part: shards of one area in every
 * part, a rerun (`rerun`) in its trees as `sameTree` matches them against the replay's.
 */
const differing = (one, other, rerun = false) =>
  ["sizes", "plan", "allowances", "checks", "trees"].filter((part) =>
    part === "trees" && rerun
      ? one.trees.length !== other.trees.length ||
        one.trees.some((tree, index) => !sameTree(tree, other.trees[index]))
      : JSON.stringify(one[part]) !== JSON.stringify(other[part]),
  );

/**
 * What a source's record says apart from its milliseconds: its counts, its stall and each run's mode, check and each
 * tree's work and end. A plan's repeats of one source (one place, run and counted by the runner each time) must say the
 * same (#1582).
 */
const sayingOf = ({ counts, stalled, runs }) =>
  JSON.stringify([
    counts,
    stalled,
    runs?.map(({ mode, check, base, head }) => [
      mode,
      check,
      ...[base, head].map((tree) => tree && [tree.work, tree.done]),
    ]),
  ]);

/**
 * `entry` (of `file`) into `into`, a map by place: a repeat of a place it holds is that one source where it says the same
 * (`repeats` counted), and refused (exit 2) where it does not. Repeats that say the same may differ in their times only;
 * where the time clause judges one a candidate (`verdictOf`), its runs stand for the source, whatever their order.
 */
function merge(into, entry, file) {
  const place = placeOf(entry);
  const held = into.get(place);
  if (held === undefined) into.set(place, entry);
  else if (sayingOf(held) !== sayingOf(entry))
    refused(`${file} holds a source another record holds otherwise: ${place}`);
  else {
    held.repeats = (held.repeats ?? 0) + 1;
    if (verdictOf(entry).verdict === "candidate" && verdictOf(held).verdict !== "candidate")
      held.runs = entry.runs;
  }
}

/** What a source did, in one word. */
function outcomeOf({ counts, stalled }) {
  if (stalled !== undefined) return "stalled";
  return PROBLEMS.find((key) => (counts[key] ?? 0) > 0) ?? "agreed";
}

if (process.argv[2] === "rerun") {
  const [indexFile, base, head, folder, ...rest] = process.argv.slice(3);
  if (folder === undefined)
    refused(
      "usage: node tests/families/stalls.mjs rerun <index> <base> <head> <new folder> [options]",
    );
  const given = rest.filter(
    (arg) => arg.startsWith("--") && !["--timeout", "--memory"].includes(arg),
  );
  if (given.length > 0)
    refused(`a rerun compares as its replay did, its limits apart: drop ${given.join(", ")}`);
  const { configurations = {}, entries } = JSON.parse(readFileSync(indexFile, "utf8"));
  const areas = [...new Set(entries.map((entry) => entry.area))];
  // each area's configuration, whose trees must be these (a stored base's is its baseline's)
  for (const area of areas) {
    const configuration = configurations[nameOf(area)];
    if (configuration === undefined)
      refused(
        `${indexFile} holds no configuration of ${nameOf(area)}: rerun its replay's sources with run.mjs --only`,
      );
    const trees = [base, head].map((tree) => comparedOf(path.resolve(tree)));
    const other = [0, 1].filter((tree) => !sameTree(configuration.trees.at(tree - 2), trees[tree]));
    if (other.length > 0)
      refused(
        `${other.map((tree) => [base, head][tree])} is not the tree ${nameOf(area)}'s replay compared`,
      );
  }
  try {
    mkdirSync(folder);
  } catch (error) {
    refused(`${folder}: ${error.message} (a new folder)`);
  }
  let status = 0;
  // one area after another, each source alone in the runner's child, both trees in one process
  for (const area of areas) {
    const name = nameOf(area);
    const { sizes, allowances } = configurations[name];
    const { status: ended } = spawnSync(
      process.execPath,
      [
        path.join(here, "run.mjs"),
        area,
        base,
        head,
        "--only",
        indexFile,
        ...(sizes === null ? [] : ["--sizes", sizes.join(",")]),
        "--allowances",
        allowances.map((allowance) => allowance ?? "natural").join(","),
        "--work",
        path.join(folder, `${name}.work.jsonl`),
        "--out",
        path.join(folder, `${name}.jsonl`),
        ...rest,
      ],
      { stdio: "inherit" },
    );
    status = Math.max(status, ended ?? 2);
  }
  process.exit(status);
}

const args = process.argv.slice(2);
const replayFiles = [];
const rerunFiles = [];
let indexFile;
for (let index = 0, into = replayFiles; index < args.length; index += 1) {
  if (args[index] === "--rerun") into = rerunFiles;
  else if (args[index] === "--index") indexFile = args[(index += 1)];
  else into.push(args[index]);
}
if (replayFiles.length === 0 || (args.includes("--index") && indexFile === undefined))
  refused(
    "usage: node tests/families/stalls.mjs <replay record>... [--rerun <record>...] [--index <new file>]",
  );

// the replay's sources by their place; each area's shards (each "i/N") and its one configuration; and the rerun's
// sources, of records of that configuration, in place of the replay's
const replay = new Map();
const areas = new Map();
const areaNamed = (name) => {
  if (!areas.has(name)) areas.set(name, { shards: new Set(), configuration: undefined });
  return areas.get(name);
};
for (const shard of replayFiles.map(shardOf)) {
  if (shard.ran?.only !== undefined)
    refused(`${shard.file} records a rerun: give it after --rerun`);
  for (const entry of shard.entries) {
    merge(replay, entry, shard.file);
    areaNamed(nameOf(entry.area));
  }
  if (shard.ran === undefined) continue;
  const area = areaNamed(nameOf(shard.ran.area));
  const other = area.configuration && differing(area.configuration, shard.ran.configuration);
  if (other?.length > 0)
    refused(`${shard.file} compares otherwise than the area's other shards (${other})`);
  area.configuration = shard.ran.configuration;
  if (area.shards.has(shard.ran.shard))
    refused(`${shard.file} records a shard another record holds`);
  area.shards.add(shard.ran.shard);
}
const rerun = new Map();
for (const shard of rerunFiles.map(shardOf)) {
  if (shard.ran === undefined) refused(`${shard.file} is no --work record, which a rerun writes`);
  const { configuration } = areaNamed(nameOf(shard.ran.area));
  if (configuration === undefined)
    refused(
      `${shard.file} reruns ${nameOf(shard.ran.area)}, whose replay records no configuration`,
    );
  const other = differing(configuration, shard.ran.configuration, true);
  if (other.length > 0)
    refused(`${shard.file} compares otherwise than its replay (${other}): it is not merged`);
  for (const entry of shard.entries) {
    const place = placeOf(entry);
    if (!replay.has(place)) refused(`${shard.file} holds a source the replay does not: ${place}`);
    merge(rerun, entry, shard.file);
  }
}

console.log(JSON.stringify({ rule: RULE }));
const VERDICTS = ["load", "candidate", "unknown"];
const zeros = () =>
  Object.fromEntries(
    ["sources", "repeats", "agreed", ...COUNTED, "unavailable", ...VERDICTS, "rerun"].map((key) => [
      key,
      0,
    ]),
  );
const rows = new Map([...areas.keys()].sort().map((area) => [area, zeros()]));
const index = [];
for (const [place, was] of replay) {
  const is = rerun.get(place) ?? was;
  const row = rows.get(nameOf(was.area));
  // where it stalls, its verdict; where a rerun ran it to its end, a candidate's still, which agreement does not clear
  const judged = verdictOf(is);
  const verdict =
    is.stalled !== undefined || (is !== was && judged.verdict === "candidate") ? judged : undefined;
  if (was.stalled !== undefined) {
    const line = { area: nameOf(was.area), generator: was.generator, source: was.source };
    const rerunOf = is === was ? {} : { rerun: { outcome: outcomeOf(is), ...verdict } };
    console.log(JSON.stringify({ ...line, stalled: was.stalled, ...verdictOf(was), ...rerunOf }));
  }
  if (is !== was) row.rerun += 1;
  // (a source an `--out` file lists is a stall of a shard whose other sources are not listed)
  if (!is.listed) row.sources += 1;
  row.repeats += was.repeats ?? 0;
  for (const key of COUNTED) row[key] += is.counts[key] ?? 0;
  if (outcomeOf(is) === "agreed") row.agreed += 1;
  if (verdict !== undefined) row[verdict.verdict] += 1;
  if (is.stalled !== undefined) {
    row.unavailable += 1;
    const { area, generator, source, key, stalled, runs } = is;
    index.push({ area, generator, source, key, stalled, ...verdict, runs });
  }
}
const total = zeros();
let closed = true;
for (const [area, row] of rows) {
  // complete: shards 0/N to N-1/N of one N, each once (a shard's sources are those whose index is i modulo N)
  const { shards } = areas.get(area);
  const counts = new Set([...shards].map((shard) => shard.split("/")[1]));
  const [count] = counts;
  const missing =
    counts.size === 1
      ? Array.from({ length: Number(count) }, (_, index) => `${index}/${count}`).filter(
          (shard) => !shards.has(shard),
        )
      : [];
  const complete = counts.size === 1 && missing.length === 0 && shards.size === Number(count);
  closed &&= complete;
  const recorded =
    shards.size === 0
      ? "stalls only"
      : counts.size === 1
        ? `${shards.size}/${count}`
        : [...shards].sort();
  const gaps = missing.length > 0 ? { missing } : {};
  console.log(JSON.stringify({ area, shards: recorded, complete, ...gaps, ...row }));
  for (const key of Object.keys(total)) total[key] += row[key];
}
closed &&= total.sources > 0 && total.agreed === total.sources && total.candidate === 0;
console.log(JSON.stringify({ total: true, ...total, closed }));
if (indexFile !== undefined) {
  try {
    const configurations = Object.fromEntries(
      [...new Set(index.map((entry) => nameOf(entry.area)))]
        .filter((area) => areas.get(area).configuration !== undefined)
        .map((area) => [area, areas.get(area).configuration]),
    );
    const text = JSON.stringify({ rule: RULE, configurations, entries: index });
    writeFileSync(indexFile, `${text}\n`, { flag: "wx" });
  } catch (error) {
    refused(`--index ${indexFile}: ${error.message} (a new file)`);
  }
}
process.exitCode = closed ? 0 : 1;
