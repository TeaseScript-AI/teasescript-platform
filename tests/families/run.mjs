// node tests/families/run.mjs <area> <base> <head> [--sizes 4,8] [--allowances natural,16,256] [--shard i/N
//   [--split <costs file>]] [--units 4] [--timeout 1800] [--memory 2048] [--out differences.jsonl]
//   [--work <area>-<i>of<N>.work.jsonl] [--only <index>] [--items <file> | --items-from-env]
// node tests/families/run.mjs <area> <head> --baseline <folder> [options]
// node tests/families/run.mjs <area> <tree> --store <folder> [--shard i/N]
// Runs every generator of tests/families/<area>/ (or of the folder an absolute <area> names) against two built trees (a
// checkout with `dist/`, or `dist/` itself), in the four modes (source and reversed order, the sharing on and off), and
// compares what the sources publish (`publication`, part by part: a difference names the first part that differs,
// #1503) and, for a generator whose `checks` include "stops", which decisions stop and when (`stopSet`) at each demand
// allowance. A stops difference names each differing stop by its place, pass and ordinal: at each place the stops
// identical on both trees pair first and the rest in order, a pair `moved` and a surplus `added` or `removed`; which of
// the rest pair is that order, not a fact the oracle gives (`stopsApart`, #2355; never stored). Each tree's own oracle library (`dist/tests/helpers/type-core-oracles.js`) analyses its sources, in a
// child process: a run (a source's mode and check on one tree) whose charged units pass `--units` times its program's
// allowance (`units`, the same on every machine, #1647; a publication run's, also its oracle's units per cell for each
// cell its own questions returned, #1837), or a source that takes more than `--memory` MB of heap or ends
// the process (a fatal V8 error), is counted as stalled, with the reason, and the next source runs in a fresh process;
// where the base's run ended the process, the head's runs from that one on run alone in a fresh child, each recorded
// beside the stall as the head's own outcome (`afterBase`, #1837). A
// run that takes longer than `--timeout` seconds, the safety net, does work no ledger charges: it is counted apart
// (`uncharged`, named by its run, on stderr and in `--out`), never a stall, and the next source runs. A run
// that throws on either tree is an exception, never compared (#1439): printed to stderr with its source, mode and
// check, and kept with its stack in `--out`, as is a difference, also where the source stalls later. A publication
// whose oracle left nodes unanswered on either tree is judged as the README's contract says (`judged`: a difference
// where what both answered differs, else `unansweredAlike` or `unanswered`). With `--baseline`, the head alone runs,
// and each run is judged against the stored base result of the same source, mode and check (a source with each run it
// does not hold is kept in `--out` as `uncompared`, never agreement); `--store` runs one tree of a commit (sx-tree's,
// with `src/` and `.sha`) at the runner's defaults and stores one shard of each source's results, one JSON line each,
// in the baseline of its `src/` tree (`baselines.mjs`), whose area folder `--baseline` then reads, only where the area
// is complete under the rule status shares (`storedRuns`); it is refused as status refuses it otherwise (exit 1 or 2).
// A stored run holds its charged units and allowance (a plan 2 area's, #1647), a stall over the unit limit the run it
// cut. `--work` keeps a record of each source: each run's charged work (the units its analyses charge their work
// ledgers), allowance, milliseconds and peak heap on each tree (with `--baseline`, the stored base's units first), a
// stalled run's up to the stall, and what the source counted (#1564), which `stalls.mjs` reads; `--only` runs the
// sources of the area that a stall index lists; `--items` (or `--items-from-env`, an item pool's batch in `$SX_ITEMS`)
// the sources whose places its file lists (`items.mjs sources`, #1826), its `--work` record named `items <hash>` in
// place of a shard. `--split` (#2272) makes shard i/N the sources `split.mjs`'s `binsOf` gives shard i by the costs
// file's recorded seconds, in place of those whose index is i modulo N; its `--work` record names the file's sha256.
// A run whose peak heap passes `NEAR_CAP` of a source's process's heap limit is near the cap: counted
// (`nearCap`) and named in `--out`, advisory only (`run-contract.mjs`). Prints one JSON line per generator and a total:
// sources, unparsed, stalled, exceptions, unanswered, unansweredAlike, uncompared, uncharged, modes, runs, differences,
// and what each tree's build lacks of what the runner reads (`capabilities`).
// What a run's result is and how two compare is `run-results.mjs`; the child process each source runs in, and what
// it shares with this runner, is `run-child.mjs`. The command line, the children's supervision and each source's
// records stay here as one module: they share the runner's options, children and record writers.
import { fork, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginShard,
  comparedOf,
  DEFAULTS,
  endShard,
  identityOf,
  outside,
  OUTSIDE_RUNS,
  owned,
  pathOf,
  planned,
  planOf,
  readFrom,
  sourceFault,
  storedRuns,
} from "./baselines.mjs";
import { ledgerOf, oracles, OVER, OVER_EXIT } from "./run-child.mjs";
import { capabilitiesOf, isNearCap } from "./run-contract.mjs";
import { hash, judged, storable } from "./run-results.mjs";
import { generatorsOf, placeOf, sourceKey } from "./sources.mjs";
import { binsOf, costsHash, parseCosts } from "./split.mjs";

/**
 * The heap limit, in MB, V8 gives a Node process (`heapLimitWith`): V8's own figure, read in that process, so that
 * `NODE_OPTIONS` is read by Node itself, never by this runner. In this process's environment with
 * `--max-old-space-size=<memory>` given (`memory`), as each source's process is, or without (`alone`: what
 * `NODE_OPTIONS` alone gives); or without `NODE_OPTIONS` (`none`). Undefined where the probe failed or printed no
 * positive number.
 */
function heapLimitWith(memory) {
  const withoutOptions = { ...process.env };
  delete withoutOptions.NODE_OPTIONS;
  const said =
    memory === "alone"
      ? spawnSync(
          process.execPath,
          ["-p", "Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 2 ** 20)"],
          { encoding: "utf8" },
        )
      : memory === "none"
        ? spawnSync(
            process.execPath,
            ["-p", "Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 2 ** 20)"],
            { encoding: "utf8", env: withoutOptions },
          )
        : spawnSync(
            process.execPath,
            [
              `--max-old-space-size=${memory}`,
              "-p",
              "Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 2 ** 20)",
            ],
            { encoding: "utf8" },
          );
  const printed = said.status === 0 ? said.stdout?.trim() : undefined;
  return /^[1-9]\d*$/.test(printed ?? "") ? Number(printed) : undefined;
}

// each option takes one value but a flag (`FLAGS`); the other arguments are the area and its trees
const FLAGS = new Set(["items-from-env"]);
const args = process.argv.slice(2);
const options = new Map();
const takes = (arg) => arg?.startsWith("--") && !FLAGS.has(arg.slice(2));
const [area, ...roots] = args.filter((arg, index) => {
  if (arg.startsWith("--")) options.set(arg.slice(2), FLAGS.has(arg.slice(2)) || args[index + 1]);
  return !arg.startsWith("--") && !takes(args[index - 1]);
});
const option = (name) => options.get(name);
/** A usage the runner refuses (exit 2), before any source runs. */
const refused = (problem) => {
  console.error(problem);
  process.exit(2);
};
// the base against the head, the head against a stored baseline (`--baseline`), or one tree's runs stored (`--store`,
// into a folder of baselines that lies in no baseline)
const baseline = option("baseline");
const store = option("store") === undefined ? undefined : outside(option("store"), [], refused);
const single = baseline !== undefined || store !== undefined;
if (area === undefined || roots.length !== (single ? 1 : 2) || (baseline && store))
  refused(
    "usage: node tests/families/run.mjs <area> <base> <head> [options]\n" +
      "       node tests/families/run.mjs <area> <head> --baseline <folder> [options]\n" +
      "       node tests/families/run.mjs <area> <tree> --store <folder> [--shard i/N]",
  );
const sizesOption = option("sizes")?.split(",").map(Number);
const allowances = (option("allowances") ?? DEFAULTS.allowances)
  .split(",")
  .map((text) => (text === "natural" ? null : Number(text)));
const [shard, shards] = (option("shard") ?? "0/1").split("/").map(Number);
// shards 0/N to N-1/N together hold the area's sources once (#1564: another index runs none)
if (!(
  Number.isInteger(shards) &&
  shards > 0 &&
  Number.isInteger(shard) &&
  shard >= 0 &&
  shard < shards
))
  refused(`--shard ${option("shard")} is no shard i/N with 0 <= i < N`);
// a baseline holds the runs of a commit's tree at the runner's defaults, so that every writer stores the same ones
if (store !== undefined) {
  const changed = ["sizes", "allowances", "units", "timeout", "memory"].filter((name) =>
    options.has(name),
  );
  const tree = roots[0];
  if (changed.length > 0)
    refused(`--store runs at the runner's defaults: drop --${changed.join(", --")}`);
  if (!existsSync(path.join(tree, "src")) || !existsSync(path.join(tree, ".sha")))
    refused(`${tree} is no built tree of a commit (sx-tree's, with src/ and .sha) to store`);
}
// a run stalls where its units pass `--units` times its allowance (`none`: never), the same on every machine; the wall
// clock is a safety net a run, whose trigger is uncharged work, not a stall (#1647, which superseded the agents' 180 s
// a source of 2026-10-30, #1512); 60 s in CI (GitHub Actions sets `CI`), whose runs are the runner's own tests
const units = option("units") === "none" ? null : Number(option("units") ?? DEFAULTS.units);
if (units !== null && !(Number.isInteger(units) && units > 0))
  refused(`--units ${option("units")} is no positive whole multiple of the allowance, or none`);
const seconds = Number(option("timeout") ?? DEFAULTS.timeout);
const timeout = seconds * 1000;
const memory = Number(option("memory") ?? DEFAULTS.memory);
// (each source's process gets `--memory` as its heap, whatever heap `NODE_OPTIONS` sets, as the central queue sets
// one on every job: the total names `memory`, and beside it the heap limit `NODE_OPTIONS` alone gives a Node process
// (`nodeOptions.heapLimit`), where `NODE_OPTIONS` changes the heap at all (its limit other than without it) and that
// limit differs from a source's process's, so the override is never silent. Each limit is V8's own, read by a probe
// process, so no form of `NODE_OPTIONS` is read by this runner; a probe that fails is said so (`probe: "failed"`), #1956)
// (a source's process's heap limit, V8's own figure, against which a run's peak is near the cap: `isNearCap`)
const heapLimit = heapLimitWith(memory);
const nodeOptions = (() => {
  if ((process.env.NODE_OPTIONS ?? "").trim() === "") return undefined;
  const [alone, none] = ["alone", "none"].map(heapLimitWith);
  if ([alone, none, heapLimit].includes(undefined)) return { probe: "failed" };
  return alone !== none && alone !== heapLimit ? { heapLimit: alone } : undefined;
})();
if (store !== undefined && options.has("only")) refused("--store stores whole shards: drop --only");
const itemized = options.has("items") || options.has("items-from-env");
if (itemized && (store !== undefined || options.has("shard") || options.has("only")))
  refused("--items runs the sources it lists: drop --store, --shard and --only");
if (options.has("items") && options.has("items-from-env"))
  refused("--items and --items-from-env: give one");
// `--split`: a shard of the area shared out by recorded seconds (#2272); a baseline's PLAN binds its shards by index
let split;
if (options.has("split")) {
  if (store !== undefined || itemized || options.has("only") || !options.has("shard"))
    refused(
      "--split shares out a replay's --shard i/N: drop --store, --items and --only, give --shard",
    );
  try {
    const text = readFileSync(option("split"), "utf8");
    split = { hash: costsHash(text), costs: parseCosts(text) };
  } catch (error) {
    refused(`--split ${option("split")}: ${error.message}`);
  }
}
// the runner's own files (`--out`, and `--work`'s record of each source, #1564) lie outside every baseline: not in the
// folder it stores into or reads, nor in the folder of baselines of the baseline it reads, nor in any baseline (#1542
// r4, r5), all as the system resolves them; each is a new file, never the old one truncated, so that another link to
// the old one keeps what it holds
const kept = [
  ...(store === undefined ? [] : [pathOf(store, "outside")]),
  ...(baseline === undefined ? [] : readFrom(baseline)),
];
const out = option("out") === undefined ? undefined : outside(option("out"), kept, refused);
const work = option("work") === undefined ? undefined : outside(option("work"), kept, refused);
// (`--work`'s progress record, which each child writes over and this process reads at a stall, removed at the end)
const progress =
  work === undefined ? undefined : outside(`${option("work")}.progress`, kept, refused);
// the three name three files, as the system resolves them, before any is removed or made (#1564 r2)
const named = [out, work, progress]
  .filter((file) => file !== undefined)
  .map((file) => pathOf(file, "outside"));
if (new Set(named).size < named.length)
  refused(`--out, --work and its progress record (<work>.progress) name one file: ${named}`);
if (out !== undefined) {
  rmSync(pathOf(out, "outside"), { force: true });
  writeFileSync(pathOf(out, "outside"), "", { flag: "wx" });
}
if (work !== undefined) {
  rmSync(pathOf(work, "outside"), { force: true });
  writeFileSync(pathOf(work, "outside"), "", { flag: "wx" });
  rmSync(pathOf(progress, "outside"), { force: true });
  writeFileSync(pathOf(progress, "outside"), "", { flag: "wx" });
}
// (a line of a generator whose id is not its file's name, a renamed one's, names its file too: `file`, never stored)
let renamed = {};
const record = (line) => {
  if (out !== undefined)
    appendFileSync(pathOf(out, "outside"), `${JSON.stringify({ ...line, ...renamed })}\n`);
};
const worked = (line) => {
  if (work !== undefined)
    appendFileSync(
      pathOf(work, "outside"),
      `${JSON.stringify("generator" in line ? { ...line, ...renamed } : line)}\n`,
    );
};
/** An exception: on stderr with each message (its first line), in `--out` with each stack and the source. */
const thrown = (line, source) => {
  const messages = Object.entries(line.thrown).map(([where, text]) => [
    where,
    text?.split("\n", 1)[0],
  ]);
  console.error(JSON.stringify({ ...line, thrown: Object.fromEntries(messages) }));
  record({ ...line, files: source.files, globals: source.globals });
};
// fail before the first source when a tree has no library
await Promise.all(roots.map(oracles));

/** The child that runs both trees, and the one that runs the head alone after the base aborted (#1837). */
const slots = { both: { child: null, roots }, head: { child: null, roots: roots.slice(-1) } };
/**
 * A child process of `slot`'s trees, keeping the end of its error output: a fatal V8 error says there why the process
 * ended. Only the child of both trees writes the progress record (`--work`).
 */
const fresh = (slot) => {
  const created = fork(
    fileURLToPath(new URL("./run-child.mjs", import.meta.url)),
    [
      "--child",
      JSON.stringify({
        roots: slot.roots,
        allowances,
        progress:
          progress === undefined || slot !== slots.both ? undefined : pathOf(progress, "outside"),
        units,
      }),
    ],
    {
      // (`--expose-gc`: the oracle's memory room collects where the heap in use passes its reserve, #1837, #2002)
      execArgv: [`--max-old-space-size=${memory}`, "--expose-gc"],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  created.errors = "";
  created.stderr.on("data", (chunk) => {
    created.errors = (created.errors + chunk).slice(-4000);
  });
  return created;
};
// a runner stopped by a signal stops its child first (it would go on analysing), then ends by that signal
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => {
    for (const { child } of Object.values(slots)) child?.kill("SIGKILL");
    process.kill(process.pid, signal);
  });
/**
 * With `--work`, the run a stalled source's child had going on, from its progress record where that is the source's
 * (`seq`) and its run after those that ended (`run`), else none: each tree's units, allowance and milliseconds so far,
 * the tree then running (`running`) counted to `at` (the clock's milliseconds).
 */
const cutOf = (seq, run, at) => {
  if (progress === undefined) return undefined;
  let state;
  try {
    state = JSON.parse(readFileSync(pathOf(progress, "outside"), "utf8"));
  } catch {
    return undefined;
  }
  if (state.seq !== seq || state.run !== run) return undefined;
  const work = roots.map((_, tree) => state.before[tree]?.[0] ?? null);
  const ms = roots.map((_, tree) => state.before[tree]?.[1] ?? null);
  const allowance = roots.map((_, tree) => state.before[tree]?.[2] ?? null);
  work[state.tree] = state.work;
  allowance[state.tree] = state.allowance ?? null;
  ms[state.tree] = state.done ? state.ms : Math.max(0, at - state.since);
  const { mode, check } = state;
  return { mode, check, work, allowance, ms, ...(state.done ? {} : { running: state.tree }) };
};
/** The run over the unit limit a child wrote on stderr before it ended (`OVER`), else undefined. */
const overOf = (errors) => {
  const at = errors.lastIndexOf(OVER);
  if (at === -1) return undefined;
  try {
    return JSON.parse(errors.slice(at + OVER.length).split("\n", 1)[0]);
  } catch {
    return undefined;
  }
};
/**
 * One source's reply, or why it stalled (`units`: a run over the unit limit, `over`; or how the process ended), with
 * the runs that ended (`runs`). Each tree's run has `timeout` from its start (the safety net, #1647): a run that
 * reaches it does work no ledger charges, and the source ends there, as `uncharged` (the run and tree then going on,
 * none between runs), never a stall. At the deadline the process ends and the runs it had written are read before it
 * closes. Each ended run's mode, check and each tree's units, allowance and milliseconds (`spent`), and with `--work`,
 * at a stall or the safety net, the run then going on (`cutOf`).
 */
const analysed = (message, slot = slots.both) =>
  new Promise((resolve) => {
    // a child that ended between sources (its channel closed) is replaced, not given the next source
    if (slot.child?.connected !== true) slot.child = fresh(slot);
    const current = slot.child;
    const runs = [];
    const spent = [];
    let going = null;
    let expired;
    let ended;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        expired = going ?? {};
        ended = Date.now();
        current.kill("SIGKILL");
      }, timeout);
    };
    const onMessage = (reply) => {
      if ("start" in reply) {
        going = reply.start;
        arm();
      } else if ("run" in reply) {
        going = null;
        arm();
        runs.push(reply.run);
        const { mode, check } = reply.run;
        spent.push({ mode, check, ...reply.spent });
      } else if (expired === undefined) settle(reply);
    };
    const onError = (error) => settle({ stalled: String(error).slice(0, 200) });
    // after `close`, the process's error output is complete
    const onClose = (code, signal) => {
      const over = code === OVER_EXIT ? overOf(current.errors) : undefined;
      const fatal = /FATAL ERROR: [^\n]*/.exec(current.errors)?.[0];
      settle(
        over !== undefined
          ? { stalled: "units", over }
          : { stalled: [signal ?? `exit ${code}`, fatal].filter(Boolean).join(": ").slice(0, 200) },
      );
    };
    const settle = (result) => {
      clearTimeout(timer);
      current.off("message", onMessage).off("error", onError).off("close", onClose);
      const cut = "stalled" in result || expired !== undefined;
      if (cut) {
        slot.child = null;
        current.kill("SIGKILL");
      }
      const record =
        cut && slot === slots.both
          ? cutOf(message.seq, spent.length, ended ?? Date.now())
          : undefined;
      if (record !== undefined) spent.push(record);
      resolve({
        ...(expired === undefined ? result : { uncharged: expired }),
        runs,
        spent,
        // (the run the stall cut, from its start message: its tree, mode and check)
        ...(cut && going !== null ? { cutAt: going } : {}),
      });
    };
    arm();
    current.on("message", onMessage).on("error", onError).on("close", onClose);
    current.send(message);
  });

/**
 * A head's result alone, as a record says it: an exception's first line; for a publication, unparsed, why it left
 * nodes unanswered, or answered; for a stop run, ended.
 */
const aloneOutcome = (check, result) =>
  result.thrown !== undefined
    ? { thrown: result.thrown.split("\n", 1)[0] }
    : check !== "publication"
      ? { ended: true }
      : result.value.unparsed
        ? { unparsed: true }
        : result.value.unanswered > 0
          ? { unanswered: result.value.unanswered, by: result.value.unansweredBy }
          : { answered: true };
/**
 * The head's runs of `message` from run `from` on, alone in a fresh child, ended after them (#1837): each run's mode,
 * check and outcome (`aloneOutcome`), then the run where the head's own child ended, if it did, with its stall or
 * its safety net (`uncharged`, counted as any uncharged run); and each run that threw, with its whole text, which is
 * reported as any exception (`thrown`).
 */
const aloneAfter = async (message, from) => {
  const alone = await analysed({ ...message, from }, slots.head);
  slots.head.child?.kill();
  slots.head.child = null;
  const where = (start) =>
    start?.mode === undefined ? {} : { mode: start.mode, check: start.check };
  return {
    after: [
      // (each with its peak heap, MiB, where the run ended)
      ...alone.runs.map(({ result, mode, check }, at) => ({
        mode,
        check,
        head: aloneOutcome(check, result),
        ...(alone.spent[at]?.peak === undefined ? {} : { peak: alone.spent[at].peak[0] }),
      })),
      ...(alone.uncharged === undefined
        ? []
        : [{ ...where(alone.uncharged), head: { uncharged: true } }]),
      ...(alone.stalled === undefined
        ? []
        : [{ ...where(alone.cutAt), head: { stalled: alone.stalled } }]),
    ],
    thrown: alone.runs
      .filter(({ result }) => result.thrown !== undefined)
      .map(({ result, mode, check }) => ({ mode, check, text: result.thrown })),
  };
};

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), area);
// each generator's sources in this shard, and with `--store` all of them (the area's PLAN)
let every;
try {
  every = await generatorsOf(folder, sizesOption);
} catch (error) {
  refused(error.message);
}
// with `--work` or `--only`, every source's place in the area's order, before a shard or `--only` selects any
const places =
  work === undefined && !options.has("only") && !itemized && split === undefined
    ? []
    : every.flatMap(({ name, sources }) => sources.map((source) => placeOf(name, source)));
// `--only`: of this area, the sources a stall index lists (`stalls.mjs`), each of which the area must hold
let only;
if (options.has("only")) {
  let entries;
  try {
    ({ entries } = JSON.parse(readFileSync(option("only"), "utf8")));
  } catch (error) {
    refused(`--only ${option("only")}: ${error.message}`);
  }
  if (!Array.isArray(entries)) refused(`--only ${option("only")} is no stall index`);
  only = new Set(
    entries
      .filter((entry) => path.basename(String(entry.area)) === path.basename(folder))
      .map(({ generator, source, key }) => JSON.stringify([generator, source, key])),
  );
  const held = new Set(places);
  const missing = [...only].filter((place) => !held.has(place));
  if (missing.length > 0) refused(`--only names sources the area does not hold: ${missing}`);
}
// `--items <file>` (or `--items-from-env`, the file the central queue's `$SX_ITEMS` names: an item pool's batch,
// #1826): the sources whose places the file lists, one `placeOf` line each (`items.mjs sources`), each once and each
// a source of the area; its record names the batch (`items <hash>`), so a pool's records are its batches
let items;
if (itemized) {
  const file = options.has("items") ? option("items") : process.env.SX_ITEMS;
  if (typeof file !== "string" || file === "")
    refused("--items-from-env: $SX_ITEMS names no file of sources");
  let lines;
  try {
    lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
  } catch (error) {
    refused(`--items ${file}: ${error.message}`);
  }
  items = new Set();
  for (const line of lines) {
    let place;
    try {
      place = JSON.parse(line);
    } catch {
      place = undefined;
    }
    if (!Array.isArray(place) || place.length !== 3 || !place.every((x) => typeof x === "string"))
      refused(`--items: ${line} is no source's place ([generator, name, key])`);
    const text = JSON.stringify(place);
    if (items.has(text)) refused(`--items lists ${text} twice`);
    items.add(text);
  }
  if (items.size === 0) refused(`--items ${file} lists no source`);
  const held = new Set(places);
  const missing = [...items].filter((place) => !held.has(place));
  if (missing.length > 0) refused(`--items names sources the area does not hold: ${missing}`);
}
// `--split`: each place's shard by the area's costs, the area named by its folder as a costs file names it
const costs = split?.costs.areas[path.basename(folder)];
if (split !== undefined && costs === undefined)
  refused(`--split ${option("split")} holds no costs of ${path.basename(folder)}`);
const bins = costs === undefined ? undefined : binsOf(places, costs, shards);
const generators = every.map(({ sources, ...generator }) => ({
  ...generator,
  sources: sources.filter(
    (source, index) =>
      (bins === undefined
        ? index % shards === shard
        : bins.get(placeOf(generator.name, source)) === shard) &&
      (only === undefined || only.has(placeOf(generator.name, source))) &&
      (items === undefined || items.has(placeOf(generator.name, source))),
  ),
}));
/**
 * The stored runs of this shard's sources (each its line), by their place, from the baseline area: read only through
 * the rule status shares (`storedRuns`), never its files directly; an area that does not verify whole is refused as
 * status refuses it (#1542, the owner's reviewer)
 */
const stored = new Map();
let storedIdentity;
let storedUnits;
if (baseline !== undefined) {
  const runs = storedRuns(baseline);
  if (runs.refused !== undefined) {
    console.error(runs.refused);
    process.exit(runs.status);
  }
  storedIdentity = runs.identity;
  // (a plan 2 area stores each run's units at its PLAN's unit limit, which the head runs at; a plan 1 one none, #1647)
  storedUnits = runs.units;
  if (storedUnits !== null && storedUnits !== units)
    refused(
      `${baseline} is stored at ${storedUnits} times the allowance: run the head there (--units ${storedUnits})`,
    );
  const places = new Set(
    generators.flatMap(({ name, sources }) => sources.map((source) => placeOf(name, source))),
  );
  // (each source is in one shard only: a shard counts only with its planned sources)
  for (const line of runs.lines) {
    const { generator, source, key } = JSON.parse(line);
    const place = JSON.stringify([generator, source, key]);
    if (places.has(place)) stored.set(place, line);
  }
}
// `--store`: this shard of the area in the baseline of the tree's `src/` tree (`baselines.mjs`), which the tree must
// share (its oracle library, lockfile and Node) and whose PLAN the area's sources must have; a shard that verifies, or
// that a running writer stores, ends here
let storing;
if (store !== undefined) {
  const tree = path.resolve(roots[0]);
  const identity = identityOf(tree);
  if (identity.src === null) refused(`${tree}/src holds no file`);
  const commit = readFileSync(path.join(tree, ".sha"), "utf8").trim();
  const top = await owned(store, identity, `commit ${commit} ${tree}`);
  if (top.refused !== undefined) refused(top.refused);
  const name = path.basename(folder);
  const plan = await planned(top.baseline, name, planOf(name, every, shards), true);
  if (plan.refused !== undefined) refused(plan.refused);
  // (the area as every reader reads it, `areaRead`, which `planned` gives)
  storing = await beginShard(top.baseline, plan.area, shard);
  if (storing.refused !== undefined) refused(storing.refused);
  if (storing.skipped !== undefined) {
    const { file, skipped } = storing;
    console.log(JSON.stringify({ area, shard: `${shard}/${shards}`, stored: file, skipped }));
    process.exit(0);
  }
  // (the shard's lines, held until it is published whole: nothing is written into the baseline before)
  Object.assign(storing, {
    made: { shard: `${shard}/${shards}`, commit, tree, ...identity },
    lines: [],
  });
}
/** What the stored tree and the head did (a stall's, an exception's or an uncharged run's text), where either did. */
const either = (base, head) =>
  base === undefined && head === undefined ? undefined : { base, head };
/** Each tree this runner runs, by its part: the base and the head, the head against a stored base, a tree stored. */
const treeNames =
  baseline !== undefined ? ["head"] : roots.length === 2 ? ["base", "head"] : ["base"];
/** Whether a stall's reason (its text) is a crash: the process ended (a fatal V8 error, a signal), not the unit limit. */
const crashed = (stall) => typeof stall === "string" && stall !== "units";
// (what each tree's build lacks of what this runner reads, by its part: `capabilitiesOf`)
const capabilities = Object.fromEntries(
  await Promise.all(
    roots.map(async (root, at) => [
      treeNames[at],
      capabilitiesOf({ oracle: await oracles(root), ledger: await ledgerOf(root) }),
    ]),
  ),
);
/**
 * A head's run of a `--work` record (one tree's units, allowance, milliseconds and peak heap) with the stored base's
 * first: its units and allowance on that run where the stored line (`kept`) holds them (a plan 2 area's ended run, or
 * the run its stall over the unit limit cut), else none; its milliseconds and peak heap none, as neither is stored
 * (#1647).
 */
const besideStored = (
  { mode, check, work: [units], allowance: [allowance], ms: [ms], peak, running },
  kept,
) => {
  const id = `${mode} ${check}`;
  const was = kept?.runs[id] ?? (kept?.cut?.run === id ? kept.cut : undefined);
  return {
    mode,
    check,
    work: [was?.work ?? null, units],
    allowance: [was?.allowance ?? null, allowance],
    ms: [null, ms],
    ...(peak === undefined ? {} : { peak: [null, peak[0]] }),
    ...(running === undefined ? {} : { running: 1 }),
    // (the stored base's run cut over the unit limit: its units, not a run it ended, #1837)
    ...(kept?.runs[id] === undefined && was !== undefined ? { baseCut: true } : {}),
  };
};
const counts = [
  "sources",
  "unparsed",
  "stalled",
  "exceptions",
  "unanswered",
  "unansweredAlike",
  "uncompared",
  "uncharged",
  "runs",
  "differences",
];
const zeros = () => Object.fromEntries(counts.map((key) => [key, 0]));
const total = {
  area,
  generators: 0,
  ...zeros(),
  crashed: { base: 0, head: 0 },
  nearCap: { base: 0, head: 0 },
  modes: 4,
};
// (sources where the head crashed and the base did not: exit 3, #1837's F24)
let headOnly = 0;
// `--work`: what ran, then one line per source, then the total
worked({
  work: {
    area,
    shard:
      items === undefined
        ? `${shard}/${shards}`
        : `items ${createHash("sha256")
            .update([...items].sort().join("\n"))
            .digest("hex")
            .slice(0, 16)}`,
    // (a batch names the area's count of sources, so that its pool's batches together are known whole: `stalls.mjs`)
    ...(items === undefined ? {} : { places: new Set(places).size }),
    // (the costs file a split shard was shared out by, `--split`: an area's shards are whole under one, `stalls.mjs`)
    ...(split === undefined ? {} : { split: split.hash }),
    roots,
    ...(baseline === undefined ? {} : { baseline }),
    ...(store === undefined ? {} : { store: option("store") }),
    ...(only === undefined ? {} : { only: option("only") }),
    units,
    // (a stored base's unit multiple, null where its area stores no units: a plan 1 one, before #1647)
    ...(baseline === undefined ? {} : { stored: { units: storedUnits } }),
    timeout: seconds,
    memory,
    // (a source's process's heap limit, against which a run's peak is near the cap, and what each tree's build lacks)
    heapLimit: heapLimit ?? null,
    capabilities,
    // what the comparison is (stalls.mjs merges only records of one): the sources' sizes, the area's plan (the hash of
    // every source's place in its order, whichever shard or index runs), the stop runs' allowances, the unit limit's
    // multiple, each generator's checks, and each tree as compared (`comparedOf`; a stored base as its baseline's
    // MANIFEST names it, `stored`)
    configuration: {
      sizes: sizesOption ?? null,
      plan: hash(places.join("\n")),
      allowances,
      units,
      checks: Object.fromEntries(every.map(({ name, checks }) => [name, checks])),
      trees: [
        ...(baseline === undefined ? [] : [{ stored: storedIdentity }]),
        ...roots.map((root) => comparedOf(path.resolve(root))),
      ],
    },
  },
});
let sequence = 0;
for (const { name, file, checks, sources } of generators) {
  renamed = file === name ? {} : { file };
  const row = {
    generator: name,
    ...zeros(),
    crashed: { base: 0, head: 0 },
    nearCap: { base: 0, head: 0 },
  };
  for (const source of sources) {
    const before = { ...row };
    row.sources += 1;
    sequence += 1;
    const message = { files: source.files, checks, globals: source.globals, seq: sequence };
    const reply = await analysed(message);
    const inputs = { files: source.files, globals: source.globals };
    // a base whose run ended its process (a fatal V8 error or a signal, not the unit limit or the safety net) leaves
    // the head's runs from that one on unrun: they run alone in a fresh child, so that each is recorded as the
    // head's own outcome beside the base's stall, never lost with it (#1837)
    const rerun =
      roots.length === 2 &&
      reply.cutAt?.tree === 0 &&
      reply.stalled !== undefined &&
      reply.stalled !== "units"
        ? await aloneAfter(message, reply.runs.length)
        : undefined;
    const afterBase = rerun?.after;
    // (a head run that threw alone: an exception as any, on stderr and in `--out` with its stack)
    for (const { mode, check, text } of rerun?.thrown ?? []) {
      row.exceptions += 1;
      thrown({ generator: name, source: source.name, mode, check, thrown: { head: text } }, source);
    }
    const line = stored.get(placeOf(name, source));
    const kept = line === undefined ? undefined : JSON.parse(line);
    const results = {};
    const uncompared = [];
    const left = [];
    // the runs that ended count, those of a source that stalls or throws after them included
    row.runs += reply.runs.length;
    for (const [at, { result, ...run }] of reply.runs.entries()) {
      // one tree's result, judged against the stored one, where there is one; stored with its units and allowance
      const id = `${run.mode} ${run.check}`;
      const {
        work: [charged],
        allowance: [allowance],
        questions: [questions] = [],
      } = reply.spent[at];
      results[id] = {
        ...storable(result),
        work: charged,
        allowance,
        ...(questions === null || questions === undefined ? {} : { questions }),
      };
      const outcome =
        result === undefined ? run : { ...run, ...judged(kept?.runs[id], result, run.check) };
      const {
        thrown: exception,
        unanswered,
        unansweredAlike,
        by,
        difference,
        uncompared: alone,
        ...where
      } = outcome;
      // (a run left unanswered: why, on each tree, on the source's record, #1837's runner artefacts)
      // (a run left unanswered: and one whose answered parts differ, its `by` the difference's, named so, #1837)
      if (by !== undefined)
        left.push({ ...where, ...(unanswered === undefined ? { alike: true } : {}), by });
      else if (difference?.by !== undefined)
        left.push({ ...where, differs: true, by: difference.by });
      if (exception !== undefined) {
        row.exceptions += 1;
        thrown({ generator: name, source: source.name, ...where, thrown: exception }, source);
      } else if (unanswered !== undefined) {
        row.unanswered += 1;
        record({ generator: name, source: source.name, ...where, unanswered, by, ...inputs });
      } else if (unansweredAlike !== undefined) row.unansweredAlike += 1;
      else if (difference !== undefined) {
        row.differences += 1;
        record({ generator: name, source: source.name, ...where, ...difference, ...inputs });
      } else if (alone && baseline !== undefined) uncompared.push(id);
    }
    if (uncompared.length > 0) {
      row.uncompared += uncompared.length;
      record({ generator: name, source: source.name, uncompared, ...inputs });
    }
    // with a baseline, a source stalls or throws outside its runs where either tree did, as with both trees run
    const stalled = baseline === undefined ? reply.stalled : either(kept?.stalled, reply.stalled);
    // (the run this runner's stall cut: its tree, mode and check, #1965; none named where it came between runs)
    // (which tree this runner's stall was on: the one it was running, or its one tree, #1837's F24)
    const stalledTree =
      reply.stalled === undefined
        ? undefined
        : reply.cutAt !== undefined
          ? treeNames[reply.cutAt.tree]
          : treeNames.length === 1
            ? treeNames[0]
            : null;
    // (the stall's tree and the run it cut, each `null` where unknown: between runs, or a stored base's crash, #1965;
    // a stored base's stall over the unit limit names its cut run)
    const storedCut = kept?.cut?.run?.split(" ") ?? [];
    const at =
      reply.stalled !== undefined
        ? { tree: stalledTree, mode: reply.cutAt?.mode ?? null, check: reply.cutAt?.check ?? null }
        : kept?.stalled !== undefined && baseline !== undefined
          ? {
              tree: "base",
              mode: storedCut[0] ?? null,
              check: storedCut.length > 1 ? storedCut.slice(1).join(" ") : null,
            }
          : undefined;
    // (a crash on each tree: this runner's, the head's alone after the base's, a stored base's, #1837's F24)
    const crashes = {
      base:
        (crashed(reply.stalled) && stalledTree === "base") ||
        (baseline !== undefined && crashed(kept?.stalled)),
      head:
        (crashed(reply.stalled) && stalledTree === "head") ||
        (afterBase ?? []).some((ran) => crashed(ran.head.stalled)),
    };
    if (crashes.base) row.crashed.base += 1;
    if (crashes.head) row.crashed.head += 1;
    if (crashes.head && !crashes.base) headOnly += 1;
    // (each ended run whose peak heap on a tree is near its process's cap, a tree's that ended a run a stall then cut
    // on a later tree and the head's runs alone after the base's crash among them: advisory, counted a source a tree
    // and named in `--out`, never a stall or an exit status)
    const near = [
      ...reply.spent.flatMap(({ mode, check, peak = [] }) =>
        peak.map((mib, at) => ({ mode, check, tree: treeNames[at], peak: mib })),
      ),
      // (the trees that ended the run a stall cut, before the tree it was on)
      ...(reply.cutAt?.peaks ?? []).map((mib, at) => ({
        mode: reply.cutAt.mode,
        check: reply.cutAt.check,
        tree: treeNames[at],
        peak: mib,
      })),
      ...(afterBase ?? [])
        .filter(({ peak }) => peak !== undefined)
        .map(({ mode, check, peak }) => ({ mode, check, tree: "head", peak })),
    ].filter(({ peak }) => isNearCap(peak, heapLimit));
    for (const tree of ["base", "head"])
      if (near.some((run) => run.tree === tree)) row.nearCap[tree] += 1;
    if (near.length > 0)
      record({ generator: name, source: source.name, nearCap: near, heapLimit, ...inputs });
    const failed =
      baseline === undefined ? reply.thrown : either(kept?.thrown?.runner, reply.thrown?.runner);
    // a run that reached the safety net does work no ledger charges (#1647, #1424): named by its run (and tree), a
    // defect counted apart, never a stall
    const reached =
      reply.uncharged === undefined
        ? undefined
        : reply.uncharged.mode === undefined
          ? OUTSIDE_RUNS
          : `${reply.uncharged.mode} ${reply.uncharged.check}`;
    // (or the head's run alone after the base's abort, #1837)
    const alone = afterBase?.find((ran) => ran.head.uncharged === true);
    const uncharged =
      baseline !== undefined
        ? either(kept?.uncharged, reached)
        : reached === undefined && alone !== undefined
          ? { head: alone.mode === undefined ? OUTSIDE_RUNS : `${alone.mode} ${alone.check}` }
          : reached === undefined || roots.length === 1
            ? reached
            : { [["base", "head"][reply.uncharged.tree] ?? "source"]: reached };
    if (storing !== undefined) {
      const key = sourceKey(source);
      // (a stall over the unit limit with the run it cut: its certificate, the same on every machine)
      const { over } = reply;
      const cut =
        over === undefined
          ? undefined
          : {
              run: `${over.mode} ${over.check}`,
              work: over.work,
              allowance: over.allowance,
              ...(over.questions === undefined ? {} : { questions: over.questions }),
            };
      const entry = { generator: name, source: source.name, key, stalled, thrown: failed };
      const text = JSON.stringify({ ...entry, uncharged, cut, runs: results });
      // (each line checked by the rule every reader of a shard checks it by, before anything is published)
      const fault = sourceFault(JSON.parse(text), DEFAULTS.units);
      if (fault !== undefined) refused(`${name} ${source.name} would be stored as ${fault}`);
      storing.lines.push(`${text}\n`);
    }
    // (with a baseline, one tree may stall where the other threw)
    if (stalled !== undefined) {
      row.stalled += 1;
      record({
        generator: name,
        source: source.name,
        stalled,
        ...(at === undefined ? {} : { at }),
        ...(afterBase === undefined ? {} : { afterBase }),
        ...inputs,
      });
    }
    if (uncharged !== undefined) {
      row.uncharged += 1;
      console.error(JSON.stringify({ generator: name, source: source.name, uncharged }));
      record({ generator: name, source: source.name, uncharged, ...inputs });
    }
    if (failed !== undefined) {
      row.exceptions += 1;
      thrown({ generator: name, source: source.name, thrown: failed }, source);
    } else if (stalled === undefined && uncharged === undefined && !reply.parsed) row.unparsed += 1;
    // the source's record: each run's units, allowance and milliseconds on each tree (with a baseline, the stored
    // base's units and allowance first, its milliseconds none), and what it counted
    if (work !== undefined)
      worked({
        generator: name,
        source: source.name,
        key: sourceKey(source),
        runs:
          baseline === undefined ? reply.spent : reply.spent.map((ran) => besideStored(ran, kept)),
        counts: Object.fromEntries(
          counts
            .filter((key) => key !== "sources" && row[key] !== before[key])
            .map((key) => [key, row[key] - before[key]]),
        ),
        ...(stalled === undefined ? {} : { stalled }),
        ...(at === undefined ? {} : { at }),
        ...(crashes.base || crashes.head ? { crashed: crashes } : {}),
        ...(near.length === 0 ? {} : { nearCap: near }),
        ...(afterBase === undefined ? {} : { afterBase }),
        ...(uncharged === undefined ? {} : { uncharged }),
        ...(left.length === 0 ? {} : { unanswered: left }),
      });
  }
  console.log(JSON.stringify(row));
  total.generators += 1;
  for (const key of counts) total[key] += row[key];
  for (const tree of ["base", "head"]) {
    total.crashed[tree] += row.crashed[tree];
    total.nearCap[tree] += row.nearCap[tree];
  }
}
for (const { child } of Object.values(slots)) child?.kill();
if (progress !== undefined) rmSync(pathOf(progress, "outside"), { force: true });
const ended = {
  ...total,
  units,
  timeout: seconds,
  memory,
  heapLimit: heapLimit ?? null,
  ...(nodeOptions === undefined ? {} : { nodeOptions }),
  capabilities,
  node: process.version,
};
if (storing !== undefined) {
  // the shard whole, its total last, with what made it: never a peak, which is not the same on every machine, nor
  // what this runner read of the tree
  const runner = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url)));
  const { nearCap: _peaks, heapLimit: _limit, capabilities: _read, ...stored } = ended;
  const made = { ...stored, ...storing.made, runner: runner.digest("hex") };
  const published = await endShard(storing.claim, storing.lines, made);
  // (foreign contents or a retired baseline, found at publication: nothing is published)
  if (published.refused !== undefined) refused(published.refused);
  Object.assign(ended, { stored: storing.file, verified: published.verified });
}
worked({ total: ended });
console.log(JSON.stringify(ended));
// (3: the head crashed where the base did not, ahead of 1: anything else to read; 2 is a refused usage)
process.exitCode =
  headOnly > 0
    ? 3
    : total.differences +
          total.stalled +
          total.exceptions +
          total.unanswered +
          total.uncompared +
          total.uncharged ===
        0
      ? 0
      : 1;
