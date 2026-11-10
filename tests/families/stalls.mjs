// node tests/families/stalls.mjs <replay record>... [--rerun <record>...] [--index <new file>]
// node tests/families/stalls.mjs rerun <index> <base> <head> <new folder> [--timeout 1800] [--memory 2048]
//   [--shard i/N | --items <file> | --items-from-env]
// A replay's comparison from its shards' records (`run.mjs --work`: what was compared, then one line per source with
// each run's charged work, allowance and milliseconds on each tree, a stored base's units, and what the source
// counted), with a verdict on each stalled source (`verdictOf`, its rule `RULE`: since #1647 from the records alone, a
// stall being a run over the unit limit, the same on every machine), and a rerun's records read in place of the
// replay's for the sources it ran (#1564: needed only where the base's units are not stored, a baseline before #1647,
// or for a record before it). A replay's `--out` file stands in for a shard recorded without `--work`: it gives the
// shard's stalls alone, each `unknown`, and no count of what agreed. One comparison is one configuration
// (`configuration`: the sources' sizes, the area's plan (the hash of every source's place in its order), the stop runs'
// allowances, the unit limit's multiple, each generator's checks, each tree's identity): an area's shards and every
// rerun record merged into it must share it (another is refused, exit 2, never closed), and the area is complete only
// with its shards 0/N to N-1/N, one N, of that plan, all shared out by index or all by one costs file (`run.mjs
// --split`, #2272; a shard of another split is refused, exit 2). A
// plan may list one source more than once: its repeats (one place, each run and counted by the runner, and each shard's
// lines checked against its total) are one source where they record the same counts, stall and runs, milliseconds apart
// (`repeats` counts the others), and are refused (exit 2, naming the place) where they differ, in a replay and in a
// rerun record alike (#1582). Rerun records are judgement attempts, read in the order given: a source's latest stands
// where it or an earlier one stalled, and two that ended must say the same (#1587); the replay's are never replaced.
// Prints the rule, one line per stalled source of the replay (with what its rerun did), per source whose runs agree
// but for some left unanswered alike on both trees (`unansweredAlike`, #1592: agreement named apart) and per source a
// run of which reached the safety net (`uncharged`, a defect, #1647), one per area and a total; exits 0 only where
// every area is complete, every source of it was compared and agrees or is unanswered alike, an unavailable one
// (stalled) or an uncharged one never counting as agreement, and no candidate stall is left, 1 otherwise, 2 on a record
// it cannot read or merge. `--index` writes the sources still unavailable, with their verdicts and records, and each
// area's configuration: the stall index, which `rerun` runs on both trees in one process, one source at a time, an area
// after another (by its name, once whatever paths its entries name), with that configuration (`run.mjs <area> <base>
// <head> --only <index>`), into a new folder of records, `<area>.work.jsonl` and `<area>.jsonl` (`--out`), to be read
// with `--rerun`; with `--shard i/N` (#1598) only its entries k with k mod N = i, into `<area>.<i>of<N>.work.jsonl` and
// `<area>.<i>of<N>.jsonl` beside that part of the index (`index.<i>of<N>.json`), so that N shards rerun it once; with
// `--items <file>` (or `--items-from-env`, the file the central queue's `$SX_ITEMS` names: an item pool's batch, #1612)
// only the entries whose numbers (0-based, in the index's order; `jq -r '.entries | keys[]' <index>` lists them) the
// batch gives, one per line, into `<area>.items-<hash>.work.jsonl` and `<area>.items-<hash>.jsonl` beside
// `index.items-<hash>.json` (`<hash>` the batch's), so that the queue sizes the jobs and the pool's batches rerun the
// index once; the index names the sources unanswered alike apart (`unansweredAlike`), which `rerun` does not run. Older
// `--work`/`--out` comparison records omit the answered parts, so this tool cannot reclassify their `unanswered` runs.
// A runner implementing #1592 must compare them again; `rerun` does this for indexed stalled sources, including their
// earlier unanswered runs. Completed sources' unanswered runs need a fresh comparison.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comparedOf } from "./baselines.mjs";
import { groupOf, REASON_GROUPS, UNKNOWN_REASON } from "./run-contract.mjs";
import { generatorFolders, generatorsOf, sourceKey } from "./sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** What `verdictOf` decides, stated in the summary and the index: the unit rule (#1647), then the earlier records' rule. */
export const RULE =
  "A run stalls where its charged units pass the unit limit (a multiple of its program's allowance, the same on every " +
  "machine); the wall clock is only a safety net, whose trigger is uncharged work, never a stall. A stalled source is a " +
  "candidate stall where the head alone stalled (over the unit limit on a run the base ended with its units recorded, " +
  "or for memory or a fatal error); inherited where the base stalled too, or alone; unknown where no units of the base " +
  "are recorded on that run (a baseline before #1647, a tree without a ledger), the base stalled at a time limit, or no " +
  "record says which tree stalled: rerun it on both trees. " +
  "A record without units (before #1647) is judged as before: " +
  "a stalled source is a candidate stall where the head alone stalled for a reason other than time (memory, a fatal " +
  "error), where on one run the head charged more work than the base charged in the whole run, or, a heuristic for " +
  "work no ledger charges, where the trees ran in one process and over the runs the head started it took more than " +
  "twice the time the base's rate of work gives the head's work, plus ten seconds (a loaded worker can stretch either " +
  "tree's time); a rerun that runs it to its end does not clear the last two. It is load where every run the head " +
  "started ended, the base's work recorded for each, none of these holds and the stall is a timeout or the base's " +
  "alone. Else it is unknown (a run of the head cut short of the base's work, which no record resolves, or no work of " +
  "the base recorded, as against a stored baseline): rerun it on both trees.";

/**
 * A stalled source's verdict from its normalized record (`entryOf`), by the unit rule (#1647) where a runner limiting
 * each run's units made it (`units`), else as before: `candidate`, `inherited`, `load` (before #1647 only) or `unknown`
 * (`RULE`), and why, naming the run that decides.
 */
export function verdictOf(entry) {
  return entry.units === undefined ? timeVerdictOf(entry) : unitVerdictOf(entry);
}

/**
 * The unit rule (#1647): a run's units are the same on every machine, so a stall is decided by which tree stalled and,
 * over the unit limit, by the base's units on the run the head's stall cut (`cut`), read from that run's own record:
 * the head alone stalled, over the limit on a run the base ended with its units recorded, or for memory or a fatal
 * error: a candidate; the base stalled too (but at a time limit, a record before #1647), or alone: inherited; else
 * unknown, rerun on both trees: no tree named, a base's time limit, or no units of the base recorded on the cut run (a
 * baseline before #1647, or a tree without a ledger).
 */
function unitVerdictOf({ stalled = {}, runs = [], units }) {
  const { base, head, source } = stalled;
  if (head === undefined && base === undefined)
    return {
      verdict: "unknown",
      why: `the source stalled (${source}), and no record names the tree`,
    };
  if (head === undefined)
    return { verdict: "inherited", why: `the base stalled (${base}), and the head did not` };
  if (base === "timeout")
    return {
      verdict: "unknown",
      why: `the head stalled (${head}), and the base at a time limit (a baseline before #1647)`,
    };
  if (base !== undefined)
    return { verdict: "inherited", why: `the base stalled too (${base}), the head (${head})` };
  if (head !== "units") return { verdict: "candidate", why: `the head alone stalled: ${head}` };
  const cut = runs.findLast(({ head: is }) => is !== null && !is.done);
  const run = cut === undefined ? "its cut run" : `${cut.mode} ${cut.check}`;
  const was = cut?.base;
  if (was === null || was === undefined || !was.done || !Number.isInteger(was.work))
    return {
      verdict: "unknown",
      why: `the head stalled over the unit limit on ${run}, and no units of the base are recorded on it (a baseline before #1647, or a tree without a ledger)`,
    };
  return {
    verdict: "candidate",
    why: `on ${run} the head charged ${cut.head.work} units, over ${units} × its allowance ${cut.head.allowance}; the base ${was.work} within it`,
  };
}

/**
 * The rule before #1647, for a record without units: `candidate`, `load` or `unknown`. Work is compared run by run, as
 * each tree's work on a run does not depend on the load; time over the runs the head started, as one run's time on a
 * loaded worker can double at equal work.
 */
function timeVerdictOf({ stalled = {}, runs, paired }) {
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

/**
 * The area of a generator's file, its path in its area (`group/name.mjs` in an area of groups; file names are unique
 * across the areas), for a record that does not say it: a renamed or grouped generator's record names its file beside its
 * id (`file`), any other's file is its id. `undefined` where no area holds that file, as for a record made before its
 * generator was renamed or moved into a group, whose area its id gives (`idAreas`).
 */
function areaOf(file) {
  for (const entry of readdirSync(here, { withFileTypes: true }))
    if (entry.isDirectory() && existsSync(path.join(here, entry.name, file))) return entry.name;
  return undefined;
}

/**
 * Each generator id's areas, for a record whose file a later rename or move into a group left behind (it names its id,
 * which the generator keeps): every area's generators by id (`generatorsOf`). An id is unique within its area only, so
 * an id two areas hold names no area.
 */
async function idAreas() {
  const ids = new Map();
  for (const folder of generatorFolders(here))
    for (const { name } of await generatorsOf(folder))
      ids.set(name, [...(ids.get(name) ?? []), path.basename(folder)]);
  return ids;
}

/**
 * A record's run as the verdict reads it: each tree's work, allowance, milliseconds and whether it ended (`base` and
 * `head`, `null` where the tree did not run it here), the base being the stored one where one tree ran: not recorded
 * before #1647, its stored units since (`ms` none).
 */
function runOf({ mode, check, work, allowance = [], ms, running, baseCut }) {
  const tree = (index) =>
    ms[index] === null && (index === 1 || work[index] === null)
      ? null
      : {
          work: work[index],
          allowance: allowance[index] ?? null,
          ms: ms[index],
          // (a stored base's run cut over the unit limit is no run it ended)
          done: running !== index && !(index === 0 && baseCut === true),
        };
  return work.length === 2
    ? { mode, check, base: tree(0), head: tree(1) }
    : { mode, check, base: null, head: tree(0) };
}

/**
 * A record's source as this tool reads it: its place, what it counted, its runs (`runOf`) and which tree stalled
 * (`base`, `head`, or `source` where neither is known).
 */
function entryOf(line, area, trees, ran) {
  const runs = line.runs?.map(runOf);
  let { stalled } = line;
  if (typeof stalled === "string") {
    // (the tree its record names, #1965; else the tree a progress record had running)
    const running = line.runs?.at(-1)?.running;
    const tree =
      line.at?.tree ??
      (trees === 2 && running !== undefined ? ["base", "head"][running] : undefined);
    stalled = { [tree ?? (trees === 1 ? "head" : "source")]: stalled };
  } else if (stalled !== undefined)
    stalled = Object.fromEntries(Object.entries(stalled).filter(([, why]) => why !== undefined));
  // (#1647: the unit multiple of the runner that made the record)
  const units = ran?.units === undefined ? {} : { units: ran.units };
  return { ...line, area, stalled, runs, paired: trees === 2, ...units };
}

const PROBLEMS = ["differences", "exceptions", "unanswered", "uncompared", "uncharged"];
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
      // (its sources that stalled or reached the safety net, #1647, each counted so)
      entries: lines
        .filter((line) => line.stalled !== undefined || line.uncharged !== undefined)
        .map((line) => ({
          ...entryOf(
            { ...line, key: sourceKey(line), runs: undefined },
            areaOf(line.file ?? line.generator),
            undefined,
          ),
          files: undefined,
          globals: undefined,
          counts: { [line.stalled === undefined ? "uncharged" : "stalled"]: 1 },
          listed: true,
        })),
    };
  if (ran.store !== undefined) refused(`${file} records a store, which compares nothing`);
  if (ran.configuration === undefined)
    refused(`${file} records no configuration of its comparison`);
  const total = lines.at(-1)?.total;
  if (total === undefined || lines.length < 2)
    refused(`${file} has no total: its shard did not end`);
  const entries = lines.slice(1, -1).map((line) => entryOf(line, ran.area, ran.roots.length, ran));
  const sums = Object.fromEntries(
    [...COUNTED, "unansweredAlike"].map((key) => [
      key,
      entries.reduce((sum, { counts }) => sum + (counts[key] ?? 0), 0),
    ]),
  );
  // (a runner before #1592 counts no run unanswered alike, one before #1647 none uncharged, and their totals have none)
  const expected = { unansweredAlike: 0, uncharged: 0, ...total };
  const differ = ["sources", ...COUNTED, "unansweredAlike"].filter(
    (key) => (key === "sources" ? entries.length : sums[key]) !== expected[key],
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
 * part, a rerun (`rerun`) in its trees as `sameTree` matches them against the replay's, and in its unit limit only
 * where the replay names one: a replay recorded before #1647 names none, and its rerun by a runner since adds it.
 */
const differing = (one, other, rerun = false) =>
  ["sizes", "plan", "allowances", "units", "checks", "trees"].filter((part) =>
    part === "trees" && rerun
      ? one.trees.length !== other.trees.length ||
        one.trees.some((tree, index) => !sameTree(tree, other.trees[index]))
      : part === "units" && rerun && one.units === undefined
        ? false
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
 * Why a record's runs were left unanswered (#1837), the same whatever its order, or `null` for a record of a runner
 * before it, which names none: a record that names them and one that names none say the same, two that name them do
 * only where they name the same.
 */
const reasonsOf = ({ unanswered }) =>
  unanswered === undefined
    ? null
    : JSON.stringify(
        unanswered
          .map(({ mode, check, alike, by }) => [
            mode,
            check,
            alike === true,
            by?.base ?? null,
            by?.head ?? null,
          ])
          .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
      );
const sayTheSame = (held, entry) =>
  sayingOf(held) === sayingOf(entry) &&
  (reasonsOf(held) === null || reasonsOf(entry) === null || reasonsOf(held) === reasonsOf(entry));

/**
 * `entry` (of `file`) into `into`, a map by place: a repeat of a place it holds is that one source where it says the same
 * (`repeats` counted), and refused (exit 2) where it does not. Repeats that say the same may differ in their times only;
 * where the time clause judges one a candidate (`verdictOf`), its runs stand for the source, whatever their order.
 */
function merge(into, entry, file) {
  const place = placeOf(entry);
  const held = into.get(place);
  if (held === undefined) into.set(place, entry);
  else if (!sayTheSame(held, entry))
    refused(`${file} holds a source another record holds otherwise: ${place}`);
  else {
    // (a record that names why its runs were left unanswered, beside one that names none: the one that names them)
    if (held.unanswered === undefined && entry.unanswered !== undefined)
      held.unanswered = entry.unanswered;
    held.repeats = (held.repeats ?? 0) + 1;
    if (verdictOf(entry).verdict === "candidate" && verdictOf(held).verdict !== "candidate")
      held.runs = entry.runs;
  }
}

/**
 * A rerun record's sources (`within`, a plan's repeats merged in it) into `into` (#1587): the rerun records are judgement
 * attempts, taken in the order given, and a source's latest stands where it or the one it follows stalled (a longer limit
 * may run what an earlier round could not); two that ended merge as repeats, refused where they say otherwise.
 */
function mergeRerun(into, within, file) {
  for (const [place, entry] of within) {
    const held = into.get(place);
    if (held === undefined || held.stalled !== undefined || entry.stalled !== undefined)
      into.set(place, entry);
    else merge(into, entry, file);
  }
}

/**
 * What a source did, in one word: `unansweredAlike` where its runs agree but for some that both trees left unanswered
 * alike (#1592), agreement named apart.
 */
function outcomeOf({ counts, stalled }) {
  if (stalled !== undefined) return "stalled";
  return (
    PROBLEMS.find((key) => (counts[key] ?? 0) > 0) ??
    ((counts.unansweredAlike ?? 0) > 0 ? "unansweredAlike" : "agreed")
  );
}

if (process.argv[2] === "rerun") {
  const [indexFile, base, head, folder, ...options] = process.argv.slice(3);
  if (folder === undefined)
    refused(
      "usage: node tests/families/stalls.mjs rerun <index> <base> <head> <new folder> [options]",
    );
  // `--shard i/N` (#1598): the index's entries in their order, entry k to shard k mod N, so that shards 0/N to N-1/N
  // together rerun it once; `--items <file>` or `--items-from-env` (the file `$SX_ITEMS` names, an item pool's batch in
  // the central queue, #1612, #1644): the entries the file names by number, one per line
  const at = options.indexOf("--shard");
  const sharding = at === -1 ? "0/1" : (options[at + 1] ?? "");
  let rest = at === -1 ? options : options.toSpliced(at, 2);
  let itemsFile;
  const from = rest.indexOf("--items");
  if (from !== -1) {
    itemsFile = rest[from + 1];
    if (itemsFile === undefined) refused("--items names a file of entry numbers, one per line");
    rest = rest.toSpliced(from, 2);
  }
  if (rest.includes("--items-from-env")) {
    if (itemsFile !== undefined)
      refused("--items and --items-from-env each name the items file: give one");
    itemsFile = process.env.SX_ITEMS;
    if (!itemsFile)
      refused("--items-from-env, and $SX_ITEMS (the path of the items file) is not set");
    rest = rest.filter((arg) => arg !== "--items-from-env");
  }
  let items;
  if (itemsFile !== undefined)
    try {
      items = readFileSync(itemsFile, "utf8");
    } catch (error) {
      refused(`the items file ${itemsFile}: ${error.message}`);
    }
  if (items !== undefined && at !== -1)
    refused("--shard and --items each choose the entries: give one");
  const given = rest.filter(
    (arg) => arg.startsWith("--") && !["--timeout", "--memory"].includes(arg),
  );
  if (given.length > 0)
    refused(`a rerun compares as its replay did, its limits apart: drop ${given.join(", ")}`);
  const [shard, shards] = /^\d+\/\d+$/.test(sharding) ? sharding.split("/").map(Number) : [];
  if (!(shards > 0 && shard < shards))
    refused(`--shard ${sharding} is no shard i/N with 0 <= i < N`);
  const index = JSON.parse(readFileSync(indexFile, "utf8"));
  const { configurations = {}, entries } = index;
  // (`--items`: each a number of an entry of the index, once, checked before any folder is made)
  let chosen;
  if (items !== undefined) {
    const numbers = items.split("\n").filter((line) => line.trim() !== "");
    chosen = numbers.map((line) => (/^\d+$/.test(line.trim()) ? Number(line.trim()) : NaN));
    const wrong = numbers.filter((_, at) => !(chosen[at] < entries.length));
    if (wrong.length > 0)
      refused(
        `--items names no entry of ${indexFile} (${entries.length} entries): ${wrong.slice(0, 5).join(", ")}`,
      );
    if (new Set(chosen).size !== chosen.length) refused("--items names an entry twice");
    if (chosen.length === 0) refused("--items names no entry");
  }
  // the index's areas by name, which keys their configurations, `run.mjs --only`'s choice and the records, each at the
  // first path its entries give: an area whose entries name several paths (a replay sharded across workers) is rerun by
  // one runner, so that each entry runs once
  const areas = new Map();
  for (const { area } of entries) if (!areas.has(nameOf(area))) areas.set(nameOf(area), area);
  // each area's configuration, whose trees must be these (a stored base's is its baseline's)
  for (const name of areas.keys()) {
    const configuration = configurations[name];
    if (configuration === undefined)
      refused(
        `${indexFile} holds no configuration of ${name}: rerun its replay's sources with run.mjs --only`,
      );
    const trees = [base, head].map((tree) => comparedOf(path.resolve(tree)));
    const other = [0, 1].filter((tree) => !sameTree(configuration.trees.at(tree - 2), trees[tree]));
    if (other.length > 0)
      refused(
        `${other.map((tree) => [base, head][tree])} is not the tree ${name}'s replay compared`,
      );
  }
  try {
    mkdirSync(folder);
  } catch (error) {
    refused(`${folder}: ${error.message} (a new folder)`);
  }
  // the shard's part of the index: the index itself where it is the only shard, else its entries of this shard, written
  // beside the shard's records as the index they rerun
  let only = indexFile;
  let part = "";
  let mine = entries;
  if (chosen !== undefined) {
    mine = [...chosen].sort((a, b) => a - b).map((number) => entries[number]);
    part = `.items-${createHash("sha256").update(chosen.join("\n")).digest("hex").slice(0, 16)}`;
  } else if (shards > 1) {
    mine = entries.filter((_, entry) => entry % shards === shard);
    part = `.${shard}of${shards}`;
  }
  if (part !== "") {
    only = path.join(folder, `index${part}.json`);
    writeFileSync(only, `${JSON.stringify({ ...index, entries: mine })}\n`, { flag: "wx" });
  }
  let status = 0;
  // one area after another, each source alone in the runner's child, both trees in one process; nothing for an area
  // the shard has no entry of
  for (const name of new Set(mine.map((entry) => nameOf(entry.area)))) {
    const area = areas.get(name);
    const { sizes, allowances, units } = configurations[name];
    const { status: ended } = spawnSync(
      process.execPath,
      [
        path.join(here, "run.mjs"),
        area,
        base,
        head,
        "--only",
        only,
        ...(sizes === null ? [] : ["--sizes", sizes.join(",")]),
        "--allowances",
        allowances.map((allowance) => allowance ?? "natural").join(","),
        // (a replay before #1647 names no unit limit: the runner's)
        ...(units === undefined ? [] : ["--units", String(units ?? "none")]),
        "--work",
        path.join(folder, `${name}${part}.work.jsonl`),
        "--out",
        path.join(folder, `${name}${part}.jsonl`),
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
  if (!areas.has(name))
    areas.set(name, {
      shards: new Set(),
      places: new Set(),
      configuration: undefined,
      split: undefined,
    });
  return areas.get(name);
};
const replayShards = replayFiles.map(shardOf);
// (an `--out` record's generators that its files no longer name, found by their ids)
const unplaced = replayShards.flatMap(({ entries }) =>
  entries.filter((entry) => entry.area === undefined),
);
if (unplaced.length > 0) {
  const ids = await idAreas();
  for (const entry of unplaced) {
    const held = ids.get(entry.generator) ?? [];
    if (held.length !== 1)
      refused(
        held.length === 0
          ? `no area of ${here} holds the generator ${entry.file ?? entry.generator}`
          : `the generator ${entry.generator} is an id in ${held.join(" and ")}: its record names no area`,
      );
    entry.area = held[0];
  }
}

for (const shard of replayShards) {
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
  // (shards shared out otherwise than each other, by index or by another costs file, may hold a source twice or never)
  const split = shard.ran.split ?? "no costs file";
  if (area.split !== undefined && area.split !== split)
    refused(
      `${shard.file} shares out its area otherwise than its other shards (split: ${split}, theirs: ${area.split})`,
    );
  area.split = split;
  area.shards.add(shard.ran.shard);
  if (shard.ran.places !== undefined) area.places.add(shard.ran.places);
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
  const within = new Map();
  for (const entry of shard.entries) {
    // (the transition rule, #1647: a rerun merged into a replay recorded before #1647, whose configuration names no
    // unit limit, is judged by that replay's rule, the rerun's added unit limit ignored for the verdict)
    if (configuration.units === undefined) delete entry.units;
    const place = placeOf(entry);
    if (!replay.has(place)) refused(`${shard.file} holds a source the replay does not: ${place}`);
    merge(within, entry, shard.file);
  }
  mergeRerun(rerun, within, shard.file);
}

console.log(JSON.stringify({ rule: RULE }));
const VERDICTS = ["load", "candidate", "inherited", "unknown"];
const zeros = () =>
  Object.fromEntries(
    [
      "sources",
      "repeats",
      "agreed",
      "unansweredAlike",
      ...COUNTED,
      "unavailable",
      ...VERDICTS,
      "rerun",
    ].map((key) => [key, 0]),
  );
const rows = new Map([...areas.keys()].sort().map((area) => [area, zeros()]));
const index = [];
const alike = [];
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
    const at = was.at === undefined ? {} : { at: was.at };
    console.log(
      JSON.stringify({ ...line, stalled: was.stalled, ...at, ...verdictOf(was), ...rerunOf }),
    );
  }
  if (is !== was) row.rerun += 1;
  // (a source an `--out` file lists is a stall of a shard whose other sources are not listed)
  if (!is.listed) row.sources += 1;
  row.repeats += was.repeats ?? 0;
  for (const key of COUNTED) row[key] += is.counts[key] ?? 0;
  const outcome = outcomeOf(is);
  if (outcome === "agreed" || outcome === "unansweredAlike") row[outcome] += 1;
  // (a source left unanswered alike is named, with its count of such runs)
  if (outcome === "unansweredAlike") {
    const { area, generator, source, key, counts } = is;
    const named = { generator, source, unansweredAlike: counts.unansweredAlike };
    console.log(JSON.stringify({ area: nameOf(area), ...named }));
    alike.push({ area, ...named, key });
  }
  // (a run that reached the safety net is a defect, uncharged work, named with its run: #1647)
  if (is.uncharged !== undefined) {
    const { area, generator, source, uncharged } = is;
    const defect = "uncharged work: a run reached the safety net";
    console.log(JSON.stringify({ area: nameOf(area), generator, source, uncharged, defect }));
  }
  if (verdict !== undefined) row[verdict.verdict] += 1;
  if (is.stalled !== undefined) {
    row.unavailable += 1;
    const { area, generator, source, key, stalled, at, runs } = is;
    // (with the tree and run the stall names, #1965)
    index.push({
      area,
      generator,
      source,
      key,
      stalled,
      ...(at === undefined ? {} : { at }),
      ...verdict,
      runs,
    });
  }
}
const total = zeros();
let closed = true;
for (const [area, row] of rows) {
  // complete: shards 0/N to N-1/N of one N, each once, of one split (a shard's sources are those whose index is i modulo
  // N, or `binsOf`'s shard i of one costs file); or an
  // item pool's batches alone (`items <hash>`, #1826), each naming the area's count of sources, which they hold
  const { shards, places } = areas.get(area);
  const batches = [...shards].filter((shard) => shard.startsWith("items "));
  const counts = new Set([...shards].map((shard) => shard.split("/")[1]));
  const [count] = counts;
  const missing =
    batches.length === 0 && counts.size === 1
      ? Array.from({ length: Number(count) }, (_, index) => `${index}/${count}`).filter(
          (shard) => !shards.has(shard),
        )
      : [];
  const [held] = places;
  const complete =
    batches.length > 0
      ? batches.length === shards.size && places.size === 1 && row.sources === held
      : counts.size === 1 && missing.length === 0 && shards.size === Number(count);
  closed &&= complete;
  const recorded =
    shards.size === 0
      ? "stalls only"
      : batches.length > 0
        ? `${batches.length} batches, ${row.sources} of ${places.size === 1 ? held : [...places].join(" or ")} sources`
        : counts.size === 1
          ? `${shards.size}/${count}`
          : [...shards].sort();
  const gaps = missing.length > 0 ? { missing } : {};
  console.log(JSON.stringify({ area, shards: recorded, complete, ...gaps, ...row }));
  for (const key of Object.keys(total)) total[key] += row[key];
}
// the runner artefacts (#1837): each run a tree's oracle left unanswered, by why (`run.mjs`'s `unansweredBy`:
// `questions`, `memory`, `read-depth`, `stopped`, else `unknown`; its witness the node, or the binding, left) or left alike, with its runs, sources and first witness; they stay apart from
// agreement as before, so that no round classifies them again
const GROUPS = [...REASON_GROUPS, "unansweredAlike"];
const ISSUES = { "unanswered: questions": "#1941" };
const artefacts = new Map(
  GROUPS.map((group) => [group, { runs: 0, sources: new Set(), witness: null }]),
);
for (const [place, was] of replay) {
  const is = rerun.get(place) ?? was;
  // (a run whose answered parts differ is a difference, counted as one; only its growth leaves it out)
  for (const left of (is.unanswered ?? []).filter(({ differs }) => differs !== true)) {
    const reasons = [left.by?.base, left.by?.head]
      .filter((by) => by != null)
      .map((by) => by.reason);
    const groups = left.alike
      ? ["unansweredAlike"]
      : [...new Set(reasons.length === 0 ? [UNKNOWN_REASON] : reasons)].map((reason) =>
          groupOf(GROUPS.includes(groupOf(reason)) ? reason : UNKNOWN_REASON),
        );
    for (const group of groups) {
      const row = artefacts.get(group);
      row.runs += 1;
      row.sources.add(place);
      // (the node of a tree whose reason is the group's: the head's where both are, an unknown one's null)
      const tree = [left.by?.head, left.by?.base].find(
        (by) =>
          by != null &&
          (group === "unansweredAlike" ||
            group === groupOf(GROUPS.includes(groupOf(by.reason)) ? by.reason : UNKNOWN_REASON)),
      );
      const witness = {
        area: nameOf(is.area),
        generator: is.generator,
        source: is.source,
        mode: left.mode,
        check: left.check,
        node: tree?.node ?? null,
        ...(tree?.binding === undefined ? {} : { binding: tree.binding }),
      };
      const text = (w) => `${w.area} ${w.generator}/${w.source} ${w.mode} ${w.check}`;
      if (row.witness === null || text(witness) < text(row.witness)) row.witness = witness;
    }
  }
}
const artefactRows = GROUPS.map((group) => {
  const { runs, sources, witness } = artefacts.get(group);
  return {
    group,
    runs,
    sources: sources.size,
    witness,
    ...(ISSUES[group] ? { issue: ISSUES[group] } : {}),
  };
});
if (artefactRows.some((row) => row.runs > 0))
  console.log(JSON.stringify({ artefacts: artefactRows }));
// near the cap, advisory: each run whose peak heap on a tree passed `NEAR_CAP` of its process's heap limit (`run.mjs`'s
// `nearCap`), with its runs, sources and first witness; never a stall, as a sampled peak is not the same on every machine
const near = { runs: 0, sources: new Set(), witness: null };
for (const [place, was] of replay) {
  const is = rerun.get(place) ?? was;
  for (const run of is.nearCap ?? []) {
    near.runs += 1;
    near.sources.add(place);
    const witness = {
      area: nameOf(is.area),
      generator: is.generator,
      source: is.source,
      mode: run.mode,
      check: run.check,
      tree: run.tree,
      peak: run.peak,
    };
    const text = (w) => `${w.area} ${w.generator}/${w.source} ${w.mode} ${w.check} ${w.tree}`;
    if (near.witness === null || text(witness) < text(near.witness)) near.witness = witness;
  }
}
if (near.runs > 0)
  console.log(
    JSON.stringify({
      nearCap: { runs: near.runs, sources: near.sources.size, witness: near.witness },
    }),
  );
// the growth bar (#1837's F22), advisory: per area, each series of a shape's sizes in one mode and check, the head's
// units over the base's at each size, flagged where a doubling of the size raises that ratio by 1 % or more. A run left
// unanswered, cut by a stall or at the safety net on either tree, or run by the head alone after the base's stall, ends
// at a stop, not at its program's work: it is left out, and its series is named as the residual.
const growth = new Map();
for (const [place, was] of replay) {
  const is = rerun.get(place) ?? was;
  const sized = /^(.*)@(\d+)$/.exec(is.source);
  if (sized === null) continue;
  const [, shape, size] = sized;
  const area = nameOf(is.area);
  if (!growth.has(area))
    growth.set(area, { series: new Map(), residual: new Set(), unmeasured: new Set() });
  const { series, residual, unmeasured } = growth.get(area);
  const stopped = new Set([
    ...(is.unanswered ?? []).map(({ mode, check }) => `${mode} ${check}`),
    ...(is.afterBase ?? [])
      .filter(({ mode }) => mode !== undefined)
      .map(({ mode, check }) => `${mode} ${check}`),
    ...Object.values(
      typeof is.uncharged === "object" ? (is.uncharged ?? {}) : { at: is.uncharged },
    ),
  ]);
  for (const run of is.runs ?? []) {
    const name = `${is.generator} ${shape} ${run.mode} ${run.check}`;
    const ended = run.base?.done && run.head?.done;
    if (stopped.has(`${run.mode} ${run.check}`) || !ended) {
      residual.add(name);
      continue;
    }
    // (a tree without a work ledger records no units: its series named apart, unmeasured)
    if (!(run.base.work > 0 && run.head.work > 0)) {
      unmeasured.add(name);
      continue;
    }
    if (!series.has(name)) series.set(name, new Map());
    series.get(name).set(Number(size), run.head.work / run.base.work);
  }
  for (const { mode, check } of is.afterBase ?? [])
    if (mode !== undefined) residual.add(`${is.generator} ${shape} ${mode} ${check}`);
}
for (const [area, { series, residual, unmeasured }] of [...growth].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const measured = [];
  for (const [name, ratios] of series) {
    const sizes = [...ratios.keys()].sort((a, b) => a - b);
    const steps = sizes
      .slice(1)
      .map((size, index) => [sizes[index], size])
      .filter(([smaller, size]) => size === 2 * smaller)
      .map(([smaller, size]) => ratios.get(size) / ratios.get(smaller) - 1);
    if (steps.length > 0)
      measured.push({ series: name, sizes, ratios: sizes.map((size) => ratios.get(size)), steps });
  }
  const flagged = measured
    .filter(({ steps }) => steps.some((step) => step >= 0.01))
    .sort((a, b) => Math.max(...b.steps) - Math.max(...a.steps));
  console.log(
    JSON.stringify({
      growth: area,
      measured: measured.length,
      flagged: flagged.length,
      worst: flagged.slice(0, 5),
      residual: { series: residual.size, named: [...residual].sort() },
      unmeasured: { series: unmeasured.size, named: [...unmeasured].sort() },
    }),
  );
}
closed &&=
  total.sources > 0 &&
  total.agreed + total.unansweredAlike === total.sources &&
  total.candidate === 0;
console.log(JSON.stringify({ total: true, ...total, closed }));
if (indexFile !== undefined) {
  try {
    const configurations = Object.fromEntries(
      [...new Set(index.map((entry) => nameOf(entry.area)))]
        .filter((area) => areas.get(area).configuration !== undefined)
        .map((area) => [area, areas.get(area).configuration]),
    );
    const text = JSON.stringify({
      rule: RULE,
      configurations,
      entries: index,
      unansweredAlike: alike,
      artefacts: artefactRows,
    });
    writeFileSync(indexFile, `${text}\n`, { flag: "wx" });
  } catch (error) {
    refused(`--index ${indexFile}: ${error.message} (a new file)`);
  }
}
process.exitCode = closed ? 0 : 1;
