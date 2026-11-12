// The families runner's child process (`run.mjs` forks this module with `--child`): each source's runs in the four
// modes on each tree, each run's charged units and its stall over the unit limit; and what the runner shares with
// it, each tree's library and ledger and the stall's marker on stderr.
import { existsSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { distOf, outside, pathOf } from "./baselines.mjs";
import { limitOf, questionsOf } from "./run-contract.mjs";
import { digest, judged, partHashes } from "./run-results.mjs";

/** A tree's oracle library, from its `dist/`. */
export async function oracles(root) {
  const file = path.join(distOf(root), "tests", "helpers", "type-core-oracles.js");
  if (!existsSync(file)) throw new Error(`no oracle library at ${file}: build the tree first`);
  return import(pathToFileURL(file).href);
}

/** A tree's work ledger (`WorkLedger`, whose `charge` every unit of its analyses' work passes), or `null`. */
export async function ledgerOf(root) {
  const file = path.join(distOf(root), "src", "type-inference", "core", "budget.js");
  if (!existsSync(file)) return null;
  const { WorkLedger } = await import(pathToFileURL(file).href);
  return typeof WorkLedger?.prototype?.charge === "function" ? WorkLedger : null;
}

/** With `--work`, the units charged between two writes of a run's progress record, and the record's length. */
const STEP = 65_536;
const RECORD = 512;

/**
 * A run over the unit limit (#1647): the child writes the run, its units and its allowance on stderr after `OVER`, by
 * a synchronous write to its descriptor that it repeats while the pipe is full (`process.stderr` may still queue
 * earlier writes, which the exit drops), and ends with `OVER_EXIT`, which the runner reads as the run's stall.
 */
export const OVER = "families-runner over the unit limit: ";
export const OVER_EXIT = 86;

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

/** What a publication run's oracle reports of its own questions so far (`run-contract.mjs`), none for another run. */
const reportedBy = (oracle, check) => (check === "publication" ? questionsOf(oracle) : undefined);

if (process.argv[2] === "--child") {
  // the child: each source's runs in the four modes on each tree (the base and the head, or one)
  const { roots, allowances, progress, units } = JSON.parse(process.argv[3]);
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
   * Every charge of each tree's work ledger (`WorkLedger.charge`), counted while a tree runs a run (#1564): its units
   * (`spent`, the analysis's, its finishing work's and the lowering's) and the largest allowance of a ledger it charged
   * (`allowance`, its program's: max(30 M, 256 × nodes)). A run whose units pass `units` times that allowance (a
   * publication run's, plus its oracle's grant, `limitOf`) stalls, the same on every machine (#1647): at the charge that passes it, the child writes the run and its units on stderr
   * and ends (`OVER`). With `--work`, its progress record, the runner's file beside `--work`, holds the run going on: it
   * is written over as a tree starts a run, each `STEP` units and as the tree ends it, by a write that completes while an
   * analysis holds this process, so the runner reads the work a run had charged when it ended the process, less at most
   * `STEP` units (exactly, at a stall over the unit limit). A tree with no ledger counts `null` and has no unit limit.
   */
  const record = progress === undefined ? undefined : outside(progress, [], () => {});
  const ledgers = await Promise.all(roots.map(ledgerOf));
  const multiple = units ?? Infinity;
  let spent = 0;
  let allowance = null;
  let limit = Infinity;
  let next = Infinity;
  let running = null;
  // (a run's peak heap: its used heap sampled at each `STEP` units charged and as it ends)
  let peak = 0;
  let sampleAt = Infinity;
  const sample = () => {
    const used = process.memoryUsage().heapUsed;
    if (used > peak) peak = used;
  };
  const write = (fields) => {
    if (record === undefined) return;
    try {
      const text = JSON.stringify({ ...running, ...fields }).padEnd(RECORD);
      writeFileSync(pathOf(record, "outside"), text, { flag: "r+" });
    } catch {
      // (a record not written leaves the one before it)
    }
  };
  const over = (questions) => {
    write({ work: spent, allowance });
    const { run, tree, mode, check } = running;
    const marker = Buffer.from(
      `\n${OVER}${JSON.stringify({ run, tree, mode, check, work: spent, allowance, questions })}\n`,
    );
    for (let at = 0; at < marker.length;)
      try {
        at += writeSync(2, marker, at);
      } catch (error) {
        if (error.code !== "EAGAIN") throw error;
      }
    process.exit(OVER_EXIT);
  };
  for (const ledger of new Set(ledgers.filter((found) => found !== null))) {
    const { charge } = ledger.prototype;
    ledger.prototype.charge = function (counter, units = 1) {
      spent += units;
      if (spent >= sampleAt) {
        sampleAt = spent + STEP;
        sample();
      }
      if (Number.isInteger(this.allowance) && this.allowance > (allowance ?? 0)) {
        allowance = this.allowance;
        limit = multiple * allowance;
      }
      if (spent > limit) {
        // (past the plain limit, a publication's grant: what its oracle reports now, #1837)
        const questions = reportedBy(trees[running.tree], running.check);
        if (spent > limitOf(multiple, allowance, questions)) over(questions);
      }
      if (spent >= next) {
        next = spent + STEP;
        write({ work: spent, allowance });
      }
      return charge.call(this, counter, units);
    };
  }
  /**
   * Tree `tree`'s result of the source's run `index` (`run`), its units, allowance, milliseconds and peak heap (MiB)
   * added to `used`, through one call whether or not they are recorded, so that an exception's stack is the same.
   */
  const counted = (seq, index, tree, mode, check, run, used) => {
    const measured = ledgers[tree] !== null;
    const before = used.work.map((units, earlier) => [
      units,
      used.ms[earlier],
      used.allowance[earlier],
    ]);
    running = { seq, run: index, tree, mode, check, since: Date.now(), before };
    spent = 0;
    allowance = null;
    limit = Infinity;
    next = measured && record !== undefined ? STEP : Infinity;
    write({ work: measured ? 0 : null, allowance: null });
    peak = 0;
    sampleAt = STEP;
    const started = performance.now();
    const result = attempt(() => digest(run(trees[tree])));
    const ms = Math.round(performance.now() - started);
    sample();
    sampleAt = Infinity;
    // (in MiB, exact: a binary fraction, never rounded before it is judged near the cap)
    used.peak.push(peak / 2 ** 20);
    used.work.push(measured ? spent : null);
    used.allowance.push(measured ? allowance : null);
    used.ms.push(ms);
    // (what its oracle reported of its own questions, which its limit and its stored run hold, #1837)
    used.questions.push((measured ? reportedBy(trees[tree], check) : undefined) ?? null);
    write({
      work: measured ? spent : null,
      allowance: measured ? allowance : null,
      ms,
      done: true,
    });
    next = Infinity;
    limit = Infinity;
    return result;
  };
  /**
   * One source's runs in the four modes on its trees, each run's outcome (`run`: a difference or an exception, or one
   * tree's result) sent as it ends and written before the next run starts, so that a later stall in the source keeps
   * it, with each tree's units, allowance and milliseconds (`spent`); and each tree's start of a run (`start`), from
   * which the runner times it (its safety net, #1647).
   */
  const compared = async ({ files, checks, globals, seq, from = 0 }) => {
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
        // (a rerun after the base aborted starts at the run it cut, #1837)
        if (index < from) {
          index += 1;
          continue;
        }
        // compared by hash, so that the base's text is not held while the head runs
        const used = { work: [], allowance: [], ms: [], questions: [], peak: [] };
        const results = [];
        for (const tree of trees.keys()) {
          // (with the peaks of the trees that ended this run, so that a stall on a later tree keeps them)
          const peaks = used.peak.length === 0 ? {} : { peaks: [...used.peak] };
          await sent({ start: { run: index, tree, mode: label, check, ...peaks } });
          results.push(counted(seq, index, tree, label, check, run, used));
        }
        index += 1;
        const is = results.at(-1);
        if (is.value?.unparsed) parsed = false;
        // one tree's result goes to the runner, which compares it with the stored one or stores it
        const outcome = results.length === 2 ? judged(results[0], is, check) : { result: is };
        await sent({ run: { mode: label, check, ...outcome }, spent: used });
      }
    }
    return { parsed };
  };
  // an exception outside the runs (the runner's own, or a library without `MODES`) is the source's exception, not a
  // stall: the process that ends with it would say only its exit code
  const answer = async (message) => {
    let reply;
    try {
      reply = await compared(message);
    } catch (error) {
      reply = { thrown: { runner: thrownText(error) } };
    }
    process.send(reply);
  };
  // a reply that cannot be made (`thrownText` of a value without a string form) ends the process, as an unhandled
  // rejection would, with the error on stderr
  process.on("message", (message) => {
    answer(message).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
}
