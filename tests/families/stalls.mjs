// node tests/families/stalls.mjs <replay record>... [--rerun <record>...] [--index <new file>]
// node tests/families/stalls.mjs rerun <index> <base> <head> <new folder> [--timeout 180] [--memory 2048]
// A replay's comparison from its shards' records (`run.mjs --work`: one line per source with each run's charged work and
// milliseconds on each tree and what the source counted), with a verdict on each stalled source (`verdictOf`, its rule
// `RULE`), and a rerun's records read in place of the replay's for the sources it ran (#1564). A replay's `--out` file
// stands in for a shard recorded without `--work`: it gives the shard's stalls alone, each `unknown`, and no count of what
// agreed. Prints the rule, one line per stalled source of the replay (with what its rerun did), one per area and a total;
// exits 0 only where every area's shards are all recorded, every source of them was compared and agrees, an unavailable
// one (stalled) never counting as agreement, and no candidate stall is left, 1 otherwise, 2 on a record it cannot read.
// `--index` writes the sources still unavailable, with their verdicts and records: the stall index, which `rerun` runs
// on both trees in one process, one source at a time, an area after another (`run.mjs <area> <base> <head> --only
// <index>`), into a new folder of records, `<area>.work.jsonl` and `<area>.jsonl` (`--out`), to be read with `--rerun`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceKey } from "./sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** What `verdictOf` decides, stated in the summary and the index. */
export const RULE =
  "A stalled source is a candidate stall where the head alone stalled for a reason other than time (memory, a fatal " +
  "error), where on one run the head charged more work than the base charged in the whole run, or where the trees ran " +
  "in one process and on one run the head took more than twice the time the base's rate of work gives the head's work, " +
  "plus a second, which a rerun that runs it to its end does not clear; it is load where the base's work is recorded " +
  "for every run the head started, none of these holds and the stall is a timeout or the base's alone; else it is " +
  "unknown (no work of the base recorded, as against a stored baseline): rerun it on both trees.";

/**
 * A stalled source's verdict from its normalized record (`entryOf`): `candidate`, `load` or `unknown` (`RULE`), and why,
 * naming the run that decides.
 */
export function verdictOf({ stalled = {}, runs, paired }) {
  const { base, head, source } = stalled;
  if (head !== undefined && head !== "timeout" && base === undefined)
    return { verdict: "candidate", why: `the head alone stalled: ${head}` };
  if (runs === undefined)
    return { verdict: "unknown", why: "no work recorded (a shard run without --work)" };
  let started = 0;
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
    const expected = was.work > 0 ? (is.work * was.ms) / was.work : was.ms;
    if (paired && is.ms > 2 * expected + 1000)
      return {
        verdict: "candidate",
        why: `on ${run} the head took ${is.ms} ms for ${is.work} units, the base ${was.ms} ms for ${was.work}`,
      };
  }
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
        : `on each of the ${started} runs it started the head charged no more work than the base` +
          (paired ? ", in at most twice the base's time for it" : "")),
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

const PROBLEMS = ["differences", "exceptions", "unanswered", "uncompared", "stalled"];
const COUNTED = ["runs", "unparsed", ...PROBLEMS];

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

/** What a source did, in one word. */
function outcomeOf({ counts, stalled }) {
  if (stalled !== undefined) return "stalled";
  const problem = PROBLEMS.find((key) => (counts?.[key] ?? 0) > 0);
  return problem === undefined ? "agreed" : problem;
}

if (process.argv[2] === "rerun") {
  const [indexFile, base, head, folder, ...rest] = process.argv.slice(3);
  if (folder === undefined)
    refused(
      "usage: node tests/families/stalls.mjs rerun <index> <base> <head> <new folder> [options]",
    );
  const { entries } = JSON.parse(readFileSync(indexFile, "utf8"));
  try {
    mkdirSync(folder);
  } catch (error) {
    refused(`${folder}: ${error.message} (a new folder)`);
  }
  let status = 0;
  // one area after another, each source alone in the runner's child, both trees in one process
  for (const area of new Set(entries.map((entry) => entry.area))) {
    const name = nameOf(area);
    const { status: ended } = spawnSync(
      process.execPath,
      [
        path.join(here, "run.mjs"),
        area,
        base,
        head,
        "--only",
        indexFile,
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

// the replay's sources by their place, each area's shards, and the rerun's sources in place of the replay's
const replay = new Map();
const areas = new Map();
for (const shard of replayFiles.map(shardOf)) {
  if (shard.ran?.only !== undefined)
    refused(`${shard.file} records a rerun: give it after --rerun`);
  for (const entry of shard.entries) {
    const place = placeOf(entry);
    if (replay.has(place)) refused(`${shard.file} holds a source another record holds: ${place}`);
    replay.set(place, entry);
    if (!areas.has(nameOf(entry.area))) areas.set(nameOf(entry.area), { shards: new Map() });
  }
  if (shard.ran === undefined) continue;
  const area = nameOf(shard.ran.area);
  if (!areas.has(area)) areas.set(area, { shards: new Map() });
  const { shards } = areas.get(area);
  if (shards.has(shard.ran.shard)) refused(`${shard.file} records a shard another record holds`);
  shards.set(shard.ran.shard, shard.ran);
}
const rerun = new Map();
for (const shard of rerunFiles.map(shardOf)) {
  if (shard.ran === undefined) refused(`${shard.file} is no --work record, which a rerun writes`);
  for (const entry of shard.entries) {
    const place = placeOf(entry);
    if (!replay.has(place)) refused(`${shard.file} holds a source the replay does not: ${place}`);
    rerun.set(place, entry);
  }
}

console.log(JSON.stringify({ rule: RULE }));
const VERDICTS = ["load", "candidate", "unknown"];
const zeros = () =>
  Object.fromEntries(
    ["sources", "agreed", ...COUNTED, "unavailable", ...VERDICTS, "rerun"].map((key) => [key, 0]),
  );
const rows = new Map([...areas.keys()].sort().map((area) => [area, zeros()]));
const index = [];
for (const [place, was] of replay) {
  const is = rerun.get(place) ?? was;
  const row = rows.get(nameOf(was.area));
  // where it stalls, its verdict; where a rerun ran it to its end, a candidate's still, which agreement does not clear
  const judged = verdictOf(is);
  const verdict = is.stalled !== undefined || judged.verdict === "candidate" ? judged : undefined;
  if (was.stalled !== undefined) {
    const line = { area: nameOf(was.area), generator: was.generator, source: was.source };
    const rerunOf = is === was ? {} : { rerun: { outcome: outcomeOf(is), ...verdict } };
    console.log(JSON.stringify({ ...line, stalled: was.stalled, ...verdictOf(was), ...rerunOf }));
  }
  if (is !== was) row.rerun += 1;
  // (a source an `--out` file lists is a stall of a shard whose other sources are not listed)
  if (!is.listed) row.sources += 1;
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
  const { shards } = areas.get(area);
  const counts = [...shards.keys()].map((shard) => Number(shard.split("/")[1]));
  const complete = counts.length > 0 && counts.every((count) => count === shards.size);
  closed &&= complete;
  const recorded = counts.length > 0 ? `${shards.size}/${counts[0]}` : "stalls only";
  console.log(JSON.stringify({ area, shards: recorded, complete, ...row }));
  for (const key of Object.keys(total)) total[key] += row[key];
}
closed &&= total.sources > 0 && total.agreed === total.sources && total.candidate === 0;
console.log(JSON.stringify({ total: true, ...total, closed }));
if (indexFile !== undefined) {
  try {
    writeFileSync(indexFile, `${JSON.stringify({ rule: RULE, entries: index })}\n`, { flag: "wx" });
  } catch (error) {
    refused(`--index ${indexFile}: ${error.message} (a new file)`);
  }
}
process.exitCode = closed ? 0 : 1;
