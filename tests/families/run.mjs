// node tests/families/run.mjs <area> <base> <head> [--sizes 4,8] [--allowances natural,16,256] [--shard i/N]
//   [--timeout 180] [--memory 2048] [--out differences.jsonl] [--work <area>-<i>of<N>.work.jsonl] [--only <index>]
// node tests/families/run.mjs <area> <head> --baseline <folder> [options]
// node tests/families/run.mjs <area> <tree> --store <folder> [--shard i/N]
// Runs every generator of tests/families/<area>/ (or of the folder an absolute <area> names) against two built trees (a
// checkout with `dist/`, or `dist/` itself), in the four modes (source and reversed order, the sharing on and off), and
// compares what the sources publish (`publication`, part by part: a difference names the first part that differs,
// #1503) and, for a generator whose `checks` include "stops", which decisions stop and when (`stopSet`) at each demand
// allowance. Each tree's own oracle library (`dist/tests/helpers/type-core-oracles.js`) analyses its sources, in a
// child process: a source that takes longer than `--timeout` seconds, more than `--memory` MB of heap, or that ends the
// process (a fatal V8 error) is counted as stalled, with the reason, and the next source runs in a fresh process. A run
// that throws on either tree is an exception, never compared (#1439): printed to stderr with its source, mode and
// check, and kept with its stack in `--out`, as is a difference, also where the source stalls later. A publication whose
// oracle left nodes unanswered at its own budget stop (`publicationHashes`'s `unanswered`) on either tree is never
// compared either, and is counted apart (`unanswered`) and kept in `--out`. With `--baseline`, the head alone runs, and
// each run is judged against the stored base result of the same source, mode and check (a source with each run it
// does not hold is kept in `--out` as `uncompared`, never agreement); `--store` runs one tree of a commit (sx-tree's,
// with `src/` and `.sha`) at the runner's defaults and stores one shard of each source's results, one JSON line each, in
// the baseline of its `src/` tree (`baselines.mjs`), whose area folder `--baseline` then reads, only where the area is
// complete under the rule status shares (`storedRuns`); it is refused as status refuses it otherwise (exit 1 or 2).
// `--work` keeps a record of each source: each run's charged work (the units its analyses charge their work ledgers)
// and milliseconds on each tree, a stalled run's up to the stall, and what the source counted (#1564), which
// `stalls.mjs` reads; `--only` runs the sources of the area that a stall index lists.
// Prints one JSON line per generator and a total: sources, unparsed, stalled, exceptions, unanswered, uncompared, modes,
// runs, differences.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  beginShard,
  comparedOf,
  DEFAULTS,
  distOf,
  endShard,
  identityOf,
  outside,
  owned,
  pathOf,
  planned,
  planOf,
  readFrom,
  storedRuns,
} from "./baselines.mjs";
import { generatorsOf, placeOf, sourceKey } from "./sources.mjs";

/** A tree's oracle library, from its `dist/`. */
async function oracles(root) {
  const file = path.join(distOf(root), "tests", "helpers", "type-core-oracles.js");
  if (!existsSync(file)) throw new Error(`no oracle library at ${file}: build the tree first`);
  return import(pathToFileURL(file).href);
}

/** A tree's work ledger (`WorkLedger`, whose `charge` every unit of its analyses' work passes), or `null`. */
async function ledgerOf(root) {
  const file = path.join(distOf(root), "src", "type-inference", "core", "budget.js");
  if (!existsSync(file)) return null;
  const { WorkLedger } = await import(pathToFileURL(file).href);
  return typeof WorkLedger?.prototype?.charge === "function" ? WorkLedger : null;
}

/** With `--work`, the units charged between two writes of a run's progress record, and the record's length. */
const STEP = 65_536;
const RECORD = 512;

/** An oracle's result as text (the publication's own text as it is: encoding it again would double a large one). */
const textOf = (value) => (typeof value === "string" ? value : JSON.stringify(value));

/** An exception as text: its stack where it has one, whose first line is its message. */
const thrownText = (error) => String(error?.stack ?? error).slice(0, 2000);

/**
 * What `run` returns (`value`), or the exception it throws (`thrown`), which is never compared: identical exceptions on
 * both trees are not agreement (#1439).
 */
function attempt(run) {
  try {
    return { value: run() };
  } catch (error) {
    return { thrown: thrownText(error) };
  }
}

const hash = (text) => createHash("sha256").update(text).digest("hex");

/**
 * A publication's parts, each by its hash, in the whole's order (#1503), and the nodes its oracle left unanswered
 * (`unanswered`): the tree's `publicationHashes`, which hashes each part as it is made and never holds the whole, as
 * this library writes it or as a library before `unanswered` did (its parts alone), or an older library's
 * `publication` split into the same parts, with the count its fifth element holds where it has one; `null` when the
 * files do not parse or resolve.
 */
function partHashes(oracle, files, mode, globals) {
  if (typeof oracle.publicationHashes === "function") {
    const hashes = oracle.publicationHashes(files, mode, globals);
    return Array.isArray(hashes) ? { parts: hashes, unanswered: 0 } : hashes;
  }
  const whole = oracle.publication(files, mode, globals);
  if (whole === null) return null;
  const [answers, record, occurrences, route, stopped] = JSON.parse(whole);
  return {
    parts: [answers, record, ...occurrences, route].map((part) => hash(JSON.stringify(part))),
    unanswered: stopped?.unanswered ?? 0,
  };
}

/**
 * A run's result by its hash (a publication's by its parts'), with a publication's part hashes (`parts`, each cut to 16
 * digits, which still place a difference and keep a stored run small) and unanswered nodes, and whether the files did
 * not parse.
 */
const digest = (value) => ({
  hash: hash(textOf(value?.parts ?? value)),
  parts: value?.parts?.map((part) => part.slice(0, 16)) ?? null,
  unanswered: value?.unanswered ?? 0,
  unparsed: value === null,
});

/** Where two publications' parts first differ: the part's index in the whole's order and each one's count of parts. */
function firstPart(was, is) {
  if (was === null || is === null) return {};
  let part = 0;
  while (part < was.length && part < is.length && was[part] === is[part]) part += 1;
  return { part, parts: [was.length, is.length] };
}

/**
 * A run's outcome from the base's result (`was`, run or stored; none where the baseline has none) and the head's
 * (`is`): an exception on either, never compared (#1439); nodes left unanswered on either; with no base, `uncompared`,
 * never agreement; else a difference, or nothing where they agree.
 */
function judged(was, is) {
  if (was?.thrown !== undefined || is.thrown !== undefined)
    return { thrown: { base: was?.thrown, head: is.thrown } };
  if (was?.value.unanswered > 0 || is.value.unanswered > 0)
    return { unanswered: { base: was?.value.unanswered, head: is.value.unanswered } };
  if (was === undefined) return { uncompared: true };
  if (was.value.hash === is.value.hash) return {};
  return {
    difference: {
      base: was.value.hash.slice(0, 16),
      head: is.value.hash.slice(0, 16),
      ...firstPart(was.value.parts, is.value.parts),
    },
  };
}

if (process.argv[2] === "--child") {
  // the child: each source's runs in the four modes on each tree (the base and the head, or one)
  const { roots, allowances, progress } = JSON.parse(process.argv[3]);
  const trees = await Promise.all(roots.map(oracles));
  const head = trees.at(-1);
  /**
   * `message` sent to the runner, once it is written: a send returns before that, and a process that ends with sends
   * still queued loses them.
   */
  const sent = (message) =>
    new Promise((resolve, reject) =>
      process.send(message, (error) => (error ? reject(error) : resolve())),
    );
  /**
   * With `--work` (#1564): the units the running tree's analyses charge (every `WorkLedger.charge`, finishing work
   * included), counted while it runs. Its progress record, the runner's file beside `--work`, holds the run going on: it
   * is written over as a tree starts a run, each `STEP` units and as the tree ends it, by a write that completes while an
   * analysis holds this process, so the runner reads the work a run had charged when it ended the process, less at most
   * `STEP` units. A tree with no ledger counts `null`.
   */
  const record = progress === undefined ? undefined : outside(progress, [], () => {});
  const ledgers = record === undefined ? [] : await Promise.all(roots.map(ledgerOf));
  let spent = 0;
  let next = Infinity;
  let running = null;
  const write = (fields) => {
    try {
      const text = JSON.stringify({ ...running, ...fields }).padEnd(RECORD);
      writeFileSync(pathOf(record, "outside"), text, { flag: "r+" });
    } catch {
      // (a record not written leaves the one before it)
    }
  };
  for (const ledger of new Set(ledgers.filter((found) => found !== null))) {
    const { charge } = ledger.prototype;
    ledger.prototype.charge = function (counter, units = 1) {
      spent += units;
      if (spent >= next) {
        next = spent + STEP;
        write({ work: spent });
      }
      return charge.call(this, counter, units);
    };
  }
  /**
   * Tree `tree`'s result of the source's run `index` (`run`), its units and milliseconds added to `used`, through one call
   * whether or not they are recorded, so that an exception's stack is the same.
   */
  const counted = (seq, index, tree, mode, check, run, used) => {
    const measured = ledgers[tree] !== undefined && ledgers[tree] !== null;
    if (record !== undefined) {
      const before = used.work.map((units, earlier) => [units, used.ms[earlier]]);
      running = { seq, run: index, tree, mode, check, since: Date.now(), before };
      spent = 0;
      next = measured ? STEP : Infinity;
      write({ work: measured ? 0 : null });
    }
    const started = performance.now();
    const result = attempt(() => digest(run(trees[tree])));
    const ms = Math.round(performance.now() - started);
    used.work.push(measured ? spent : null);
    used.ms.push(ms);
    if (record !== undefined) write({ work: measured ? spent : null, ms, done: true });
    next = Infinity;
    return result;
  };
  /**
   * One source's runs in the four modes on its trees, each run's outcome (`run`: a difference or an exception, or one
   * tree's result) sent as it ends and written before the next run starts, so that a later stall in the source keeps
   * it; with `--work`, each tree's units and milliseconds with it (`spent`).
   */
  const compared = async ({ files, checks, globals, seq }) => {
    let parsed = true;
    let index = 0;
    for (const mode of head.MODES) {
      const label = `${mode.reversed ? "rev" : "src"}-${mode.unshared ? "off" : "on"}`;
      const runs = [];
      if (checks.includes("publication"))
        runs.push(["publication", (oracle) => partHashes(oracle, files, mode, globals)]);
      if (checks.includes("stops"))
        for (const allowance of allowances)
          runs.push([
            `stops ${allowance ?? "natural"}`,
            (oracle) => oracle.stopSet(files, mode, globals, allowance),
          ]);
      for (const [check, run] of runs) {
        // compared by hash, so that the base's text is not held while the head runs
        const used = { work: [], ms: [] };
        const results = trees.map((_, tree) => counted(seq, index, tree, label, check, run, used));
        index += 1;
        const is = results.at(-1);
        if (is.value?.unparsed) parsed = false;
        // one tree's result goes to the runner, which compares it with the stored one or stores it
        const outcome = results.length === 2 ? judged(results[0], is) : { result: is };
        await sent({
          run: { mode: label, check, ...outcome },
          ...(record === undefined ? {} : { spent: used }),
        });
      }
    }
    return { parsed };
  };
  // an exception outside the runs (the runner's own, or a library without `MODES`) is the source's exception, not a
  // stall: the process that ends with it would say only its exit code
  process.on("message", async (message) => {
    let reply;
    try {
      reply = await compared(message);
    } catch (error) {
      reply = { thrown: { runner: thrownText(error) } };
    }
    process.send(reply);
  });
} else {
  // each option takes one value; the other arguments are the area and its trees
  const args = process.argv.slice(2);
  const options = new Map();
  const [area, ...roots] = args.filter((arg, index) => {
    if (arg.startsWith("--")) options.set(arg.slice(2), args[index + 1]);
    return !arg.startsWith("--") && !args[index - 1]?.startsWith("--");
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
    const changed = ["sizes", "allowances", "timeout", "memory"].filter((name) =>
      options.has(name),
    );
    const tree = roots[0];
    if (changed.length > 0)
      refused(`--store runs at the runner's defaults: drop --${changed.join(", --")}`);
    if (!existsSync(path.join(tree, "src")) || !existsSync(path.join(tree, ".sha")))
      refused(`${tree} is no built tree of a commit (sx-tree's, with src/ and .sha) to store`);
  }
  // 180 s by default, 60 s in CI (GitHub Actions sets `CI`), whose runs are the runner's own tests (owner, 2026-10-30)
  const seconds = Number(option("timeout") ?? DEFAULTS.timeout);
  const timeout = seconds * 1000;
  const memory = Number(option("memory") ?? DEFAULTS.memory);
  if (store !== undefined && options.has("only"))
    refused("--store stores whole shards: drop --only");
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
  const record = (line) => {
    if (out !== undefined) appendFileSync(pathOf(out, "outside"), `${JSON.stringify(line)}\n`);
  };
  const worked = (line) => {
    if (work !== undefined) appendFileSync(pathOf(work, "outside"), `${JSON.stringify(line)}\n`);
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

  let child = null;
  /** A child process, keeping the end of its error output: a fatal V8 error says there why the process ended. */
  const fresh = () => {
    const created = fork(
      fileURLToPath(import.meta.url),
      [
        "--child",
        JSON.stringify({
          roots,
          allowances,
          progress: progress === undefined ? undefined : pathOf(progress, "outside"),
        }),
      ],
      {
        execArgv: [`--max-old-space-size=${memory}`],
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
      child?.kill("SIGKILL");
      process.kill(process.pid, signal);
    });
  /**
   * With `--work`, the run a stalled source's child had going on, from its progress record where that is the source's
   * (`seq`) and its run after those that ended (`run`), else none: each tree's units and milliseconds so far, the tree
   * then running (`running`) counted to `at` (the clock's milliseconds).
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
    work[state.tree] = state.work;
    ms[state.tree] = state.done ? state.ms : Math.max(0, at - state.since);
    const { mode, check } = state;
    return { mode, check, work, ms, ...(state.done ? {} : { running: state.tree }) };
  };
  /**
   * One source's reply, or why it stalled (`timeout`, or how the process ended), with the runs that ended (`runs`). At
   * the deadline the process ends and the runs it had written are read before it closes: a source whose timeout
   * callback has run stalls, with them. With `--work`, each ended run's mode, check and each tree's units and
   * milliseconds (`spent`), and at a stall the run then going on (`cutOf`).
   */
  const analysed = (message) =>
    new Promise((resolve) => {
      // a child that ended between sources (its channel closed) is replaced, not given the next source
      if (child?.connected !== true) child = fresh();
      const current = child;
      const runs = [];
      const spent = [];
      let expired = false;
      let ended;
      const onMessage = (reply) => {
        if ("run" in reply) {
          runs.push(reply.run);
          const { mode, check } = reply.run;
          if (reply.spent !== undefined) spent.push({ mode, check, ...reply.spent });
        } else if (!expired) settle(reply);
      };
      const onError = (error) => settle({ stalled: String(error).slice(0, 200) });
      // after `close`, the process's error output is complete
      const onClose = (code, signal) => {
        const fatal = /FATAL ERROR: [^\n]*/.exec(current.errors)?.[0];
        settle({
          stalled: [signal ?? `exit ${code}`, fatal].filter(Boolean).join(": ").slice(0, 200),
        });
      };
      const settle = (result) => {
        clearTimeout(timer);
        current.off("message", onMessage).off("error", onError).off("close", onClose);
        if ("stalled" in result) {
          child = null;
          current.kill("SIGKILL");
        }
        const cut =
          "stalled" in result ? cutOf(message.seq, spent.length, ended ?? Date.now()) : undefined;
        if (cut !== undefined) spent.push(cut);
        resolve({ ...(expired ? { stalled: "timeout" } : result), runs, spent });
      };
      // (the process's `close` then settles the source, after the frames it had written)
      const timer = setTimeout(() => {
        expired = true;
        ended = Date.now();
        current.kill("SIGKILL");
      }, timeout);
      current.on("message", onMessage).on("error", onError).on("close", onClose);
      current.send(message);
    });

  const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), area);
  // each generator's sources in this shard, and with `--store` all of them (the area's PLAN)
  const every = await generatorsOf(folder, sizesOption);
  // with `--work` or `--only`, every source's place in the area's order, before a shard or `--only` selects any
  const places =
    work === undefined && !options.has("only")
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
  const generators = every.map(({ sources, ...generator }) => ({
    ...generator,
    sources: sources.filter(
      (source, index) =>
        index % shards === shard &&
        (only === undefined || only.has(placeOf(generator.name, source))),
    ),
  }));
  /**
   * The stored runs of this shard's sources (each its line), by their place, from the baseline area: read only through
   * the rule status shares (`storedRuns`), never its files directly; an area that does not verify whole is refused as
   * status refuses it (#1542, the owner's reviewer)
   */
  const stored = new Map();
  let storedIdentity;
  if (baseline !== undefined) {
    const runs = storedRuns(baseline);
    if (runs.refused !== undefined) {
      console.error(runs.refused);
      process.exit(runs.status);
    }
    storedIdentity = runs.identity;
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
    const plan = await planned(top.baseline, name, planOf(name, every, shards));
    if (plan.refused !== undefined) refused(plan.refused);
    storing = await beginShard(top.baseline, name, shard, shards, plan.plan, plan.places[shard]);
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
  /** What the stored tree and the head did (a stall's or an exception's text), where either did. */
  const either = (base, head) =>
    base === undefined && head === undefined ? undefined : { base, head };
  const counts = [
    "sources",
    "unparsed",
    "stalled",
    "exceptions",
    "unanswered",
    "uncompared",
    "runs",
    "differences",
  ];
  const zeros = () => Object.fromEntries(counts.map((key) => [key, 0]));
  const total = { area, generators: 0, ...zeros(), modes: 4 };
  // `--work`: what ran, then one line per source, then the total
  worked({
    work: {
      area,
      shard: `${shard}/${shards}`,
      roots,
      ...(baseline === undefined ? {} : { baseline }),
      ...(store === undefined ? {} : { store: option("store") }),
      ...(only === undefined ? {} : { only: option("only") }),
      timeout: seconds,
      memory,
      // what the comparison is (stalls.mjs merges only records of one): the sources' sizes, the area's plan (the hash of
      // every source's place in its order, whichever shard or index runs), the stop runs' allowances, each generator's
      // checks, and each tree as compared (`comparedOf`; a stored base as its baseline's MANIFEST names it, `stored`)
      configuration: {
        sizes: sizesOption ?? null,
        plan: hash(places.join("\n")),
        allowances,
        checks: Object.fromEntries(every.map(({ name, checks }) => [name, checks])),
        trees: [
          ...(baseline === undefined ? [] : [{ stored: storedIdentity }]),
          ...roots.map((root) => comparedOf(path.resolve(root))),
        ],
      },
    },
  });
  let sequence = 0;
  for (const { name, checks, sources } of generators) {
    const row = { generator: name, ...zeros() };
    for (const source of sources) {
      const before = { ...row };
      row.sources += 1;
      sequence += 1;
      const reply = await analysed({
        files: source.files,
        checks,
        globals: source.globals,
        seq: sequence,
      });
      const inputs = { files: source.files, globals: source.globals };
      const line = stored.get(placeOf(name, source));
      const kept = line === undefined ? undefined : JSON.parse(line);
      const results = {};
      const uncompared = [];
      // the runs that ended count, those of a source that stalls or throws after them included
      row.runs += reply.runs.length;
      for (const { result, ...run } of reply.runs) {
        // one tree's result, judged against the stored one, where there is one
        const id = `${run.mode} ${run.check}`;
        results[id] = result;
        const outcome = result === undefined ? run : { ...run, ...judged(kept?.runs[id], result) };
        const { thrown: exception, unanswered, difference, uncompared: alone, ...where } = outcome;
        if (exception !== undefined) {
          row.exceptions += 1;
          thrown({ generator: name, source: source.name, ...where, thrown: exception }, source);
        } else if (unanswered !== undefined) {
          row.unanswered += 1;
          record({ generator: name, source: source.name, ...where, unanswered, ...inputs });
        } else if (difference !== undefined) {
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
      const failed =
        baseline === undefined ? reply.thrown : either(kept?.thrown?.runner, reply.thrown?.runner);
      if (storing !== undefined) {
        const key = sourceKey(source);
        const entry = { generator: name, source: source.name, key, stalled, thrown: failed };
        storing.lines.push(`${JSON.stringify({ ...entry, runs: results })}\n`);
      }
      // (with a baseline, one tree may stall where the other threw)
      if (stalled !== undefined) {
        row.stalled += 1;
        record({ generator: name, source: source.name, stalled, ...inputs });
      }
      if (failed !== undefined) {
        row.exceptions += 1;
        thrown({ generator: name, source: source.name, thrown: failed }, source);
      } else if (stalled === undefined && !reply.parsed) row.unparsed += 1;
      // the source's record: each run's units and milliseconds on each tree, and what it counted
      if (work !== undefined)
        worked({
          generator: name,
          source: source.name,
          key: sourceKey(source),
          runs: reply.spent,
          counts: Object.fromEntries(
            counts
              .filter((key) => key !== "sources" && row[key] !== before[key])
              .map((key) => [key, row[key] - before[key]]),
          ),
          ...(stalled === undefined ? {} : { stalled }),
        });
    }
    console.log(JSON.stringify(row));
    total.generators += 1;
    for (const key of counts) total[key] += row[key];
  }
  child?.kill();
  if (progress !== undefined) rmSync(pathOf(progress, "outside"), { force: true });
  const ended = { ...total, timeout: seconds, node: process.version };
  if (storing !== undefined) {
    // the shard whole, its total last, with what made it
    const runner = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url)));
    const made = { ...ended, ...storing.made, runner: runner.digest("hex") };
    const published = await endShard(storing.claim, storing.lines, made);
    // (foreign contents or a retired baseline, found at publication: nothing is published)
    if (published.refused !== undefined) refused(published.refused);
    Object.assign(ended, { stored: storing.file, verified: published.verified });
  }
  worked({ total: ended });
  console.log(JSON.stringify(ended));
  process.exitCode =
    total.differences + total.stalled + total.exceptions + total.unanswered + total.uncompared === 0
      ? 0
      : 1;
}
