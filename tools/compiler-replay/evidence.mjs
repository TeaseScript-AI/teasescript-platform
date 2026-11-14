// The one evidence command for a type-checker change meant to keep behaviour (#2796): `evidence` queues it, and
// `evidence-report` reads it as one report.
//
//   node tools/compiler-replay.mjs evidence <base> <head> --owner <o> [--campaign <prefix>] [--areas <a,b,…>]
//     [--packages <folder>]... [--package-shards 16] [--timeout 3600] [--memory 6500] [--tests <file,…>] [--dry]
//   node tools/compiler-replay.mjs evidence-report <prefix> --owner <o> [--results <folder>] [--json <file>]
//
// `<base>` and `<head>` are any commits origin serves (another branch's head too, for a stacked change), resolved to
// their SHAs. `evidence` queues, as `submit` does, the set (`<prefix>-set`) and the areas (`<prefix>-areas`), only
// those `--areas` names ("set" and the areas `areasOf` finds; all by default); with each `--packages` folder, every
// package below it through the research route (`tests/families/packages.mjs`, `<prefix>-packages`, the folders as
// `--data`, each package bounded by `--timeout` seconds and `--memory` MB); and one checkout of the head
// (`<prefix>-checks`) that runs `check-changed` and `pin-suites --run` against the base and the `--tests` files. It
// writes what it queued to `~/work/replay-evidence/<prefix>.json`, which the report reads. It runs no mutants and no
// stop-position search: neither `--stops` nor `--demands`.
//
// `evidence-report` first says what the run covered and what it left out (areas not asked or not run; a part not run
// whole: a shard whose records fall short of the sources its summary counts, or an area whose difference, exception
// or unanswered records fall short of its sources' counts; the modes, the package folders with their packages' counts,
// the bound and how many packages reached it), then, per part (the set, each area, the packages):
//   - each tree's count of sources in seven classes (`classOf`, `sourceClass`): completed (the core analysed it in
//     every mode; a set or package record without each of the four held modes once, or an area source without each
//     run its generator's checks owe in each of the four area modes once, is uncompared), no analysis (compile errors,
//     parse or names, before the checker), refused at the syntax gate, refused at the limit, threw (the checker's own
//     outcome, by the error's class and the function and file it is thrown from, `throwPlace`), incomplete (what the
//     infrastructure did: stalled, killed, past the safety net, a run an oracle's bound left unanswered on either tree,
//     a runner's own exception) and uncompared (no record a class can be read from);
//   - the moves, by name: a source whose class differs between the trees, or whose outcome in one paired mode does
//     (`outcomeOf`: a throw at another place or in another mode, a refusal of another kind or at another limit, a stop
//     at another limit);
//   - the differences over sources completed on both trees, each with its first differing part (an area's charged
//     work among them);
//   - every source that threw alike on both trees (in each mode), by name, each time; what came before a throw is not
//     compared;
//   - for the packages, beside the completed count, how many of them had their research-route compile throw or refuse
//     alike in each mode (route result not compared: the analysis's parts alone are), then each by name and place; a
//     route outcome that differs in a mode is a move;
//   - the sources with no analysis on both trees, by name with their count, and the differences over them (the set's
//     and the packages' diagnostics and a plan where none may come out; an area's publication only, its runner
//     recording no diagnostics);
//   - the sources refused at the limit on both trees, by name;
//   - the heaviest share of the limit per tree, with every source above half of it, each as a share of the allowance
//     the code gives it and of the fixed limit (`FIXED_LIMIT`), and whose it is: generated (the set's and the areas')
//     or a creator's script (the packages');
//   - the checks, each step asked (`check-changed`, `pin-suites`, the `--tests` files) by its status.
// Exit 0 when every part asked ran whole, at least one part was asked, each completed something and nothing differs,
// moves, is incomplete or uncompared, and every check step asked ran and passed (a throw alike on both trees is listed,
// never a reason), the verdict saying where it covers the analysis's publication only; 3 when a part asked did not run
// whole; else 1; 2 on a usage error, as an `evidence` with nothing to compare.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { packagesOf } from "../../tests/families/packages.mjs";
import { throwPlace } from "../../tests/families/thrown.mjs";
import { ROOT, Usage, areasOf, git, inTemporaryFolder, queue, quoted } from "./common.mjs";
import { apartText, areaRecordForm, report, setDifference } from "./collect.mjs";
import { jobsOf, lines, shardsOf, shardsRead } from "./results.mjs";
import { splitOf, submissions, batchOf } from "./submit.mjs";

/** The work limit #2801 fixes for every script, beside which each share is also given. */
export const FIXED_LIMIT = 30_000_000;
/** The classes a source falls in on one tree, in the order the report prints them. */
export const CLASSES = [
  "completed",
  "unanalysed",
  "slice",
  "limit",
  "threw",
  "incomplete",
  "uncompared",
];
const CLASS_NAMES = {
  completed: "completed",
  unanalysed: "no analysis (compile errors before the checker)",
  slice: "refused at the syntax gate",
  limit: "refused at the limit",
  threw: "threw",
  incomplete: "incomplete",
  uncompared: "uncompared",
};
const DEFAULTS = { packageShards: 16, timeout: 3600, memory: 6500 };
const manifestPath = (prefix) => path.join(homedir(), "work", "replay-evidence", `${prefix}.json`);

/**
 * One run's class on one tree, the one place a limit is told from the rest: a ledger stopped at a limit (`stopped`) or
 * a candidate-route refusal a limit made (`outside: "limit"`) is refused at the limit; any other candidate-route refusal
 * is refused at the syntax gate; another error is the checker's own outcome, threw; a run the checker never saw
 * (`analysed: false`: compile errors, parse or names, before it) has no analysis; else, the core having analysed it
 * (`analysed: true`), completed. A run without `stopped` or `analysed` (a runner from before #2796) is uncompared. What
 * the infrastructure did (a stall, a kill, the safety net, a shard unread) is the record's, never a run's: incomplete.
 */
export function classOf({ error = null, stopped, outside = null, analysed }) {
  if (stopped === undefined) return "uncompared";
  if (stopped !== null || outside === "limit") return "limit";
  if (outside === "slice") return "slice";
  if (error !== null) return "threw";
  if (analysed === false) return "unanalysed";
  return analysed === true ? "completed" : "uncompared";
}

/** Where a run that threw threw (`throwPlace`'s text, as the runner recorded it). */
const throwOf = (run) => run.thrown ?? run.error;

/**
 * One run's outcome on one tree, what two trees' runs in the same mode are compared by before any source-level count:
 * its class (`classOf`) with, for a throw, its place and, for a ledger's stop, the limit it stopped at.
 */
const outcomeOf = (run) => {
  const c = classOf(run);
  if (c === "threw") return `threw ${throwOf(run)}`;
  return c === "limit" && run.stopped ? `${CLASS_NAMES.limit} (${run.stopped})` : CLASS_NAMES[c];
};

/** The first paired mode (`[mode, base outcome, head outcome]`) whose outcomes differ, as a move, or `null`. */
const modeMove = (pairs) => {
  const moved = pairs.find(([, base, head]) => base !== head);
  return moved === undefined ? null : `${moved[0]}: ${moved[1]} → ${moved[2]}`;
};

/** The held modes (`HELD_MODES`' names) a set or package record compares, each once, or it was not compared whole. */
const HELD_NAMES = ["forward", "reversed", "forward, unshared", "reversed, unshared"];
const heldWhole = (modes) =>
  modes.length === HELD_NAMES.length && HELD_NAMES.every((n) => modes.some((m) => m.mode === n));

/** The modes an area runs each check of a source in (`run-child.mjs`'s labels). */
const AREA_MODES = ["src-on", "src-off", "rev-on", "rev-off"];

/** The places a tree's runs threw at, sorted and joined, or `null` where none threw. */
const threwAt = (runs) => {
  const places = [...new Set(runs.filter((run) => classOf(run) === "threw").map(throwOf))].sort();
  return places.length === 0 ? null : places.join("; ");
};

/**
 * A source's class on one tree from its runs' classes: the first of incomplete, uncompared, threw, limit, slice, no
 * analysis, else completed (analysed in every mode).
 */
export function sourceClass(classes) {
  for (const which of ["incomplete", "uncompared", "threw", "limit", "slice", "unanalysed"])
    if (classes.includes(which)) return which;
  return classes.length === 0 ? "uncompared" : "completed";
}

/** A run's share of the limit on one tree: its charged units against its allowance and against `FIXED_LIMIT`. */
const shareOf = (units, allowance) =>
  Number.isInteger(units) && Number.isInteger(allowance) && allowance > 0
    ? { units, allowance, today: units / allowance, fixed: units / FIXED_LIMIT }
    : null;
const heavier = (a, b) => (b === null || (a !== null && a.today >= b.today) ? a : b);

/**
 * The set's sources from `plans.mjs` records: each `{ name, base, head, apart, share }`, `apart` the first mode's
 * difference (`setDifference`) where any mode differs.
 */
export function setSources(records) {
  return records.map((r) => {
    if (r.stalled !== undefined || r.uncharged !== undefined)
      return {
        name: r.name,
        base: "incomplete",
        head: "incomplete",
        apart: null,
        share: [null, null],
        threw: [null, null],
        planned: false,
      };
    const modes = r.modes ?? [];
    const side = (tree) =>
      heldWhole(modes) ? sourceClass(modes.map((m) => classOf(m[tree]))) : "uncompared";
    const threw = ["base", "head"].map((tree) => threwAt(modes.map((m) => m[tree])));
    const apart = modes.map((m) => setDifference(m)).find((what) => what !== null) ?? null;
    const move = modeMove(modes.map((m) => [m.mode, outcomeOf(m.base), outcomeOf(m.head)]));
    const share = ["base", "head"].map((tree) =>
      modes.reduce(
        (heaviest, m) => heavier(shareOf(m[tree].units, m[tree].allowance), heaviest),
        null,
      ),
    );
    // (whether a plan came out on either tree, which a source with no analysis must not give)
    const planned = modes.some((m) => m.base.plan != null || m.head.plan != null);
    return {
      name: r.name,
      base: side("base"),
      head: side("head"),
      apart,
      share,
      threw,
      planned,
      modeMove: move,
    };
  });
}

/**
 * An area's sources from `run.mjs`'s `--work` records and `--out` differences: a source whose own counts hold a stall,
 * a safety net or a run unanswered (on one tree or alike) is incomplete, as is one whose runner threw outside its runs;
 * one uncompared so; a tree on which a run threw (`--out`'s exception records, each tree's stack read by `throwPlace`)
 * threw; else each tree's class from its runs' `stopped` and `unparsed` (no analysis: the oracle had no request; the
 * runner records no diagnostics, and an unparsed run publishes nothing). `apart` is the first difference's place
 * (`apartText`), else the first run whose trees charged other work.
 */
export function areaSources(work, differences) {
  // (the runs each source owes: each of its generator's checks, a stops check at each allowance, in every mode, as the
  // area's header names them; none known without it)
  const configuration = work.find((w) => w.work?.configuration !== undefined)?.work.configuration;
  const owed = (generator) => {
    const checks = configuration?.checks?.[generator];
    if (!Array.isArray(checks)) return null;
    const labels = checks.flatMap((check) =>
      check === "stops"
        ? (configuration.allowances ?? []).map((a) => `stops ${a ?? "natural"}`)
        : [check],
    );
    return labels.flatMap((check) => AREA_MODES.map((mode) => `${mode} ${check}`));
  };
  const apartOf = new Map();
  const thrownOf = new Map();
  // (each run's throw on each tree, by its mode and check: compared in its own run, never across runs)
  const runThrown = new Map();
  for (const d of differences) {
    const key = `${d.generator}\0${d.source}`;
    if (areaRecordForm(d) === "difference" && !apartOf.has(key))
      apartOf.set(key, `${d.mode}: ${apartText(d)}`);
    if (areaRecordForm(d) === "exception") {
      const at = thrownOf.get(key) ?? { runner: false, sides: [new Set(), new Set()] };
      thrownOf.set(key, at);
      if (d.thrown.runner !== undefined) at.runner = true;
      const places = ["base", "head"].map((tree) =>
        d.thrown[tree] === undefined ? null : throwPlace(d.thrown[tree]),
      );
      places.forEach((place, side) => {
        if (place !== null) at.sides[side].add(place);
      });
      runThrown.set(`${key}\0${d.mode}\0${d.check}`, places);
    }
  }
  return work
    .filter((w) => w.generator !== undefined && w.source !== undefined)
    .map((w) => {
      const name = `${w.generator} ${w.source}`;
      // (every run the source owes ran, each once: else it was not compared in every mode)
      const whole = ({ generator, runs = [] }) => {
        const labels = runs.map((run) => `${run.mode} ${run.check}`);
        const due = owed(generator);
        return (
          due !== null &&
          new Set(labels).size === labels.length &&
          labels.length === due.length &&
          due.every((label) => labels.includes(label))
        );
      };
      const worked = (w.runs ?? []).find(
        (run) => Array.isArray(run.work) && run.work[0] !== run.work[1],
      );
      const apart =
        apartOf.get(`${w.generator}\0${w.source}`) ??
        (worked === undefined
          ? null
          : `${worked.mode}: ${worked.check} charged work ${worked.work[0]}/${worked.work[1]}`);
      const counts = w.counts ?? {};
      const thrown = thrownOf.get(`${w.generator}\0${w.source}`);
      const both =
        ["stalled", "uncharged", "unanswered", "unansweredAlike"].some((key) => counts[key] > 0) ||
        // (a run left unanswered, alike or with other answered parts: a partial publication, never compared)
        (w.unanswered?.length ?? 0) > 0 ||
        thrown?.runner === true ||
        (counts.exceptions > 0 && thrown === undefined)
          ? "incomplete"
          : counts.uncompared > 0 || !whole(w)
            ? "uncompared"
            : null;
      const runs = w.runs ?? [];
      const threw = [0, 1].map((at) =>
        thrown === undefined || thrown.sides[at].size === 0
          ? null
          : [...thrown.sides[at]].sort().join("; "),
      );
      // (a run's outcome on one tree: its throw, else its stop and whether it had a request)
      const runOf = (run, at) => {
        const place = runThrown.get(`${w.generator}\0${w.source}\0${run.mode}\0${run.check}`)?.[at];
        return place != null
          ? { stopped: null, error: place, analysed: true }
          : {
              stopped: run.stopped?.[at],
              analysed: run.unparsed === undefined ? undefined : !run.unparsed[at],
            };
      };
      const side = (at) => both ?? sourceClass(runs.map((run) => classOf(runOf(run, at))));
      const move = modeMove(
        runs.map((run) => [
          `${run.mode} ${run.check}`,
          outcomeOf(runOf(run, 0)),
          outcomeOf(runOf(run, 1)),
        ]),
      );
      const share = [0, 1].map((at) =>
        runs.reduce(
          (heaviest, run) => heavier(shareOf(run.work?.[at], run.allowance?.[at]), heaviest),
          null,
        ),
      );
      return {
        name,
        base: side(0),
        head: side(1),
        apart,
        share,
        threw,
        planned: false,
        modeMove: both === null ? move : null,
      };
    });
}

/**
 * What an area's `--out` records fall short of: each kind its sources' counts say the runner wrote (a difference, an
 * exception, a run unanswered), as "<read> of <counted> <kind> records read".
 */
export function areaShortfall(work, outs) {
  const short = [];
  for (const [key, form] of [
    ["differences", "difference"],
    ["exceptions", "exception"],
    ["unanswered", "unanswered"],
  ]) {
    const counted = work.reduce((sum, w) => sum + (w.counts?.[key] ?? 0), 0);
    const read = outs.filter((d) => areaRecordForm(d) === form).length;
    if (read < counted) short.push(`${read} of ${counted} ${key} records read`);
  }
  return short;
}

/** The first part in which two trees' runs of a package differ: the analysis's before the route's, in this order. */
const PACKAGE_PARTS = {
  analysis: [
    "error",
    "answers",
    "diagnostics",
    "checks",
    "checked",
    "codes",
    "stopped",
    "counts",
    "trace",
    "questions",
  ],
  route: [
    "error",
    "outside",
    "plan",
    "diagnostics",
    "checked",
    "facts",
    "codes",
    "stopped",
    "trace",
    "questions",
  ],
};
function packageApart(m, runs = Object.keys(PACKAGE_PARTS)) {
  for (const run of runs)
    for (const key of PACKAGE_PARTS[run])
      if (JSON.stringify(m.base[run][key]) !== JSON.stringify(m.head[run][key]))
        return `${m.mode}: ${run} ${key}`;
  return `${m.mode}: apart`;
}

/**
 * One tree's research-route outcome in a mode: `completed`, or `threw <place>` or `refused <place>` (a
 * `CandidateOutsideSlice`, or a ledger's stop: `refused at <limit>`).
 */
function routeOutcome(route) {
  if (route.outside != null)
    return `refused ${route.outside === "limit" ? "at the limit" : "at the syntax gate"}${route.stopped == null ? "" : ` (${route.stopped})`} ${route.error}`;
  if (route.stopped != null) return `refused at the limit (${route.stopped})`;
  return route.error == null ? "completed" : `threw ${route.error}`;
}

/**
 * The packages from `packages.mjs` records: each tree's class is its analysis's (the core analysed it: completed);
 * `share` its analysis's too. Its research-route compile's outcome (`routeOutcome`) is compared beside it, mode by
 * mode: another in any mode is a move (`routeMove`); the same throw or refusal in every mode where the route did not
 * complete leaves the route's result not compared (`routeNotCompared`: `threw` or `refused`), and only the analysis's
 * parts are compared.
 */
export function packageSources(records) {
  return records.map((r) => {
    const name = r.root === 0 ? r.name : `${r.name} (folder ${r.root + 1})`;
    if (r.incomplete !== undefined)
      return {
        name,
        base: "incomplete",
        head: "incomplete",
        apart: null,
        share: [null, null],
        threw: [null, null],
        planned: false,
        bound: r.incomplete,
      };
    const modes = r.modes ?? [];
    const side = (tree) =>
      heldWhole(modes) ? sourceClass(modes.map((m) => classOf(m[tree].analysis))) : "uncompared";
    const threw = ["base", "head"].map((tree) => threwAt(modes.map((m) => m[tree].analysis)));
    const move = modeMove(
      modes.map((m) => [m.mode, outcomeOf(m.base.analysis), outcomeOf(m.head.analysis)]),
    );
    const routeMove = modeMove(
      modes.map((m) => [m.mode, routeOutcome(m.base.route), routeOutcome(m.head.route)]),
    );
    const notDone = [
      ...new Set(modes.map((m) => routeOutcome(m.base.route)).filter((o) => o !== "completed")),
    ].sort();
    const routeCompared = routeMove === null && notDone.length === 0;
    const runs = routeCompared ? ["analysis", "route"] : ["analysis"];
    // (a mode whose record differs only in the route's parts is not apart where the route's result is not compared)
    const apart = modes.find(
      (m) => !m.same && (routeCompared || packageApart(m, runs) !== `${m.mode}: apart`),
    );
    const share = ["base", "head"].map((tree) =>
      modes.reduce(
        (heaviest, m) =>
          heavier(shareOf(m[tree].analysis.units, m[tree].analysis.allowance), heaviest),
        null,
      ),
    );
    return {
      name,
      base: side("base"),
      head: side("head"),
      apart: apart === undefined ? null : packageApart(apart, runs),
      share,
      threw,
      planned: modes.some((m) => m.base.route.plan != null || m.head.route.plan != null),
      modeMove: move,
      routeMove: routeMove === null ? null : `route ${routeMove}`,
      routeNotCompared:
        routeMove !== null || routeCompared
          ? null
          : {
              kind: notDone.some((o) => o.startsWith("threw ")) ? "threw" : "refused",
              at: notDone.join("; "),
            },
    };
  });
}

/**
 * A part's summary: each tree's counts by class; the moves, of class or, within one class, of a mode's outcome
 * (`modeMove`, `routeMove`); the differences over sources completed on both trees; the sources that threw alike in
 * every mode; those with no analysis on both trees and the differences over them; the packages whose route result is
 * not compared; the shares.
 */
export function partSummary(sources) {
  const counts = { base: {}, head: {} };
  for (const tree of ["base", "head"]) for (const c of CLASSES) counts[tree][c] = 0;
  const moved = [];
  const differences = [];
  const apartElsewhere = [];
  // (the sources that threw alike on both trees: the checker's outcome, listed every time, never a reason)
  const threwAlike = [];
  // (the sources the checker saw on neither tree, and what differs over them: never counted completed)
  const unanalysed = [];
  const unanalysedDifferences = [];
  // (the sources refused at the limit on both trees, by name)
  const limitBoth = sources
    .filter((s) => s.base === "limit" && s.head === "limit")
    .map((s) => s.name);
  // (of the packages completed on both trees, those whose research-route compile threw or refused alike: their
  // route's result is not compared, by kind, and listed by name and place)
  const routeNotCompared = { threw: 0, refused: 0 };
  const routeNotComparedList = [];
  let completed = 0;
  let threwBoth = 0;
  for (const s of sources) {
    counts.base[s.base] += 1;
    counts.head[s.head] += 1;
    if (s.routeMove != null) moved.push(`${s.name}: ${s.routeMove}`);
    if (s.base !== s.head) moved.push(`${s.name}: ${CLASS_NAMES[s.base]} → ${CLASS_NAMES[s.head]}`);
    // (the same class on each tree, another outcome in a mode: a throw at another place or in another mode, a refusal
    // of another kind, a stop at another limit)
    else if (s.modeMove != null) moved.push(`${s.name}: ${s.modeMove}`);
    else if (s.base === "completed") {
      completed += 1;
      if (s.routeNotCompared != null) {
        routeNotCompared[s.routeNotCompared.kind] += 1;
        routeNotComparedList.push(`${s.name}: ${s.routeNotCompared.at}`);
      }
      if (s.apart !== null) differences.push(`${s.name}: ${s.apart}`);
    } else if (s.base === "unanalysed") {
      unanalysed.push(s.name);
      if (s.apart !== null) unanalysedDifferences.push(`${s.name}: ${s.apart}`);
      else if (s.planned) unanalysedDifferences.push(`${s.name}: a plan without analysis`);
    } else {
      if (s.base === "threw") {
        threwBoth += 1;
        threwAlike.push(`${s.name}: ${s.threw[0]}`);
      }
      // (a throw alike is the same outcome: what came before it is a partial output, never compared, #2801)
      if (s.apart !== null && s.base !== "threw")
        apartElsewhere.push(`${s.name} (${CLASS_NAMES[s.base]} on both): ${s.apart}`);
    }
  }
  const shares = [0, 1].map((at) => {
    const ranked = sources
      .filter((s) => s.share[at] !== null)
      .map((s) => ({ name: s.name, ...s.share[at] }))
      .sort((a, b) => b.today - a.today);
    const heaviest = ranked[0] ?? null;
    return {
      heaviest,
      aboveHalf: ranked.filter((s) => s !== heaviest && (s.today > 0.5 || s.fixed > 0.5)),
    };
  });
  return {
    sources: sources.length,
    counts,
    completed,
    threwBoth,
    moved,
    differences,
    apartElsewhere,
    threwAlike,
    unanalysed,
    unanalysedDifferences,
    routeNotCompared,
    routeNotComparedList,
    limitBoth,
    shares,
  };
}

/** `evidence`: queue the run and record what it queued. */
export function evidence({ positional: [base, head], options }) {
  if (head === undefined || options.owner === undefined)
    throw new Usage("evidence <base> <head> --owner <o> (its header)");
  const commit = (ref) => git("rev-parse", "--verify", `${ref}^{commit}`);
  const [baseSha, headSha] = [commit(base), commit(head)];
  const prefix = options.campaign ?? `evidence-${headSha.slice(0, 9)}`;
  const all = ["set", ...areasOf(ROOT).map((a) => a.name)];
  const asked = options.areas === undefined ? all : options.areas.split(",").filter(Boolean);
  const unknown = asked.filter((name) => !all.includes(name));
  if (unknown.length > 0)
    throw new Usage(`--areas: no area ${unknown.join(", ")} (there are ${all.join(", ")})`);
  const folders = [options.packages ?? []].flat().map((folder) => path.resolve(folder));
  if (asked.length === 0 && folders.length === 0)
    throw new Usage("nothing to compare: --areas names no area and no --packages is given");
  for (const folder of folders)
    if (!existsSync(folder)) throw new Usage(`--packages ${folder}: no such folder`);
  const packageShards = Number(options["package-shards"] ?? DEFAULTS.packageShards);
  const timeout = Number(options.timeout ?? DEFAULTS.timeout);
  const memory = Number(options.memory ?? DEFAULTS.memory);
  if (![packageShards, timeout, memory].every((n) => Number.isInteger(n) && n > 0))
    throw new Usage("--package-shards, --timeout and --memory take positive whole numbers");
  const tests = (options.tests ?? "").split(",").filter(Boolean);
  const split = splitOf(baseSha, { costs: options.costs, target: 900 }, 2);
  const queued = submissions(baseSha, headSha, {
    owner: options.owner,
    prefix,
    baseline: false,
    split: split.fellBack === undefined ? split : undefined,
  }).filter((args) =>
    asked.includes(args[args.indexOf("--name") + 1].replace(/-\{i\}of\{n\}$/u, "")),
  );
  const jobs = batchOf(queued, split.fellBack === undefined ? split : undefined);
  if (folders.length > 0)
    for (let i = 0; i < packageShards; i += 1)
      jobs.push([
        "--name",
        `packages-${i}of${packageShards}`,
        "--owner",
        options.owner,
        "--campaign",
        `${prefix}-packages`,
        "--commit",
        `base=${baseSha}`,
        "--commit",
        `head=${headSha}`,
        ...folders.flatMap((folder) => ["--data", folder]),
        "--mem",
        `${Math.ceil(memory / 1024) + 2}G`,
        "--timeout",
        "12h",
        "--",
        "bash",
        "-c",
        `node "$SX_TREE_head/tests/families/packages.mjs" "$SX_TREE_base" "$SX_TREE_head" ` +
          `${folders.map((folder) => `--root ${quoted(folder)}`).join(" ")} --shard ${i}/${packageShards} ` +
          `--timeout ${timeout} --memory ${memory} --out "$SX_OUT/packages.jsonl" > "$SX_OUT/packages.log" ` +
          `2>"$SX_OUT/packages.err" < /dev/null; rc=$?; tail -1 "$SX_OUT/packages.log"; exit $rc`,
      ]);
  const steps = [
    ["check-changed", `node tools/check-changed.mjs --base ${baseSha}`],
    ["pin-suites", `node tools/repository-checks/pin-suites.mjs --base ${baseSha} --run`],
    ...(tests.length === 0
      ? []
      : [["tests", `node tools/test-output-filter.mjs ${tests.map(quoted).join(" ")}`]]),
  ];
  jobs.push([
    "--name",
    "checks",
    "--owner",
    options.owner,
    "--campaign",
    `${prefix}-checks`,
    "--checkout",
    headSha,
    "--mem",
    "12G",
    "--timeout",
    "3h",
    "--",
    "bash",
    "-c",
    `cd "$SX_CHECKOUT" || exit 90; ` +
      steps
        .map(
          ([name, command]) =>
            `${command} > "$SX_OUT/${name}.log" 2>&1 < /dev/null; rc=$?; ` +
            `echo '{"step":"${name}","status":'$rc'}' >> "$SX_OUT/checks.jsonl"; [ $rc -eq 0 ] || exit $rc`,
        )
        .join("; "),
  ]);
  const manifest = {
    prefix,
    base: baseSha,
    head: headSha,
    areas: { asked, left: all.filter((name) => !asked.includes(name)) },
    packages: folders.map((folder) => ({ folder, count: packagesOf([folder]).length })),
    packageShards,
    bound: { timeout, memory },
    tests,
  };
  process.stdout.write(
    `areas: ${asked.join(", ")}${manifest.areas.left.length === 0 ? "" : `; left out: ${manifest.areas.left.join(", ")}`}\n`,
  );
  process.stdout.write(
    `packages: ${manifest.packages.map((p) => `${p.folder} (${p.count})`).join(", ") || "none"}\n`,
  );
  process.stdout.write(`jobs: ${jobs.length}\n`);
  if (options.dry) {
    for (const args of jobs) process.stdout.write(`${JSON.stringify(["submit", ...args])}\n`);
    return 0;
  }
  mkdirSync(path.dirname(manifestPath(prefix)), { recursive: true });
  writeFileSync(manifestPath(prefix), `${JSON.stringify(manifest, null, 1)}\n`);
  inTemporaryFolder((folder) => {
    const file = path.join(folder, "batch.txt");
    writeFileSync(file, jobs.map((args) => `${args.map(quoted).join(" ")}\n`).join(""));
    for (const id of queue(["submit-batch", file])) process.stdout.write(`${id}\n`);
  });
  process.stdout.write(
    `campaigns: ${prefix}-{set,areas,packages,checks}; report: evidence-report ${prefix}\n`,
  );
  return 0;
}

/** The packages' and checks' shards of `prefix` under `results`, as `shardsOf` reads a campaign's attempts. */
function otherShards(prefix, results) {
  const last = (file) => lines(file).at(-1);
  return {
    packages: shardsOf(
      jobsOf(results, `${prefix}-packages`),
      ({ out }) => {
        const summary = last(path.join(out, "packages.log"));
        return summary?.packages === undefined ? undefined : summary;
      },
      [0, 1],
    ),
    checks: shardsOf(
      jobsOf(results, `${prefix}-checks`),
      ({ out }) => {
        const steps = lines(path.join(out, "checks.jsonl"));
        return steps.length === 0 ? undefined : { steps };
      },
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 90],
    ),
  };
}

/** The report of `manifest`'s run under `results`: coverage, each part's summary, the checks, and the verdict. */
export function evidenceReport(manifest, results) {
  const { prefix } = manifest;
  const replay = report(
    prefix,
    results,
    manifest.areas.asked.filter((name) => name !== "set"),
  );
  const notRun = replay.notRun.filter(
    (entry) => manifest.areas.asked.includes("set") || !entry.startsWith("set"),
  );
  const parts = {};
  const { setShards, areaShards } = shardsRead(prefix, results);
  // (each shard's records against the sources its summary says it ran: a record missing is never left out silently)
  const reconciled = (name, reads, records) => {
    const declared = reads.reduce((sum, read) => sum + (read.summary?.sources ?? 0), 0);
    if (records.length < declared)
      notRun.push(`${name}: ${records.length} of ${declared} sources read`);
    return records;
  };
  if (manifest.areas.asked.includes("set")) {
    const reads = setShards.filter((s) => s.read !== null).map((s) => s.read);
    parts.set = partSummary(
      setSources(
        reconciled(
          "set",
          reads,
          reads.flatMap((read) => lines(path.join(read.out, "plans.jsonl"))),
        ),
      ),
    );
  }
  for (const area of manifest.areas.asked.filter((name) => name !== "set")) {
    const reads = areaShards
      .filter((s) => s.name.startsWith(`${area}-`) && s.read !== null)
      .map((s) => s.read);
    const work = reads.flatMap((read) => lines(path.join(read.out, `${area}.work.jsonl`)));
    const outs = reads.flatMap((read) => lines(path.join(read.out, `${area}.differences.jsonl`)));
    const sources = areaSources(work, outs);
    reconciled(area, reads, sources);
    for (const short of areaShortfall(work, outs)) notRun.push(`${area}: ${short}`);
    parts[area] = partSummary(sources);
  }
  const { packages, checks } = otherShards(prefix, results);
  let reached = 0;
  if (manifest.packages.length > 0) {
    for (const s of packages) if (s.read === null) notRun.push(s.name);
    if (packages.length < manifest.packageShards)
      notRun.push(`packages: ${packages.length} of ${manifest.packageShards} shards`);
    const reads = packages.filter((s) => s.read !== null).map((s) => s.read);
    const records = reconciled(
      "packages",
      reads,
      reads.flatMap((read) => lines(path.join(read.out, "packages.jsonl"))),
    );
    const sources = packageSources(records);
    reached = sources.filter((s) => s.bound?.startsWith("safety net")).length;
    parts.packages = partSummary(sources);
    const expected = manifest.packages.reduce((sum, p) => sum + p.count, 0);
    if (records.length < expected && notRun.length === 0)
      notRun.push(`packages: ${records.length} of ${expected} packages`);
  }
  const ran = checks.find((s) => s.read !== null)?.read.summary.steps ?? null;
  if (ran === null) notRun.push("checks");
  const reasons = [];
  // (a run that compared nothing, no area and no package, is never equal)
  if (Object.keys(parts).length === 0) reasons.push("nothing compared: no area and no package");
  // (each step the checks job was asked to run, with its status: one missing did not pass)
  const asked = ["check-changed", "pin-suites", ...(manifest.tests.length > 0 ? ["tests"] : [])];
  if (ran !== null)
    for (const step of asked)
      if (!ran.some((s) => s.step === step)) reasons.push(`checks: ${step} not run`);
  for (const [name, p] of Object.entries(parts)) {
    // (a part asked that completed nothing, empty or not, is never equal)
    if (p.completed === 0) reasons.push(`${name}: nothing completed on both trees`);
    for (const c of ["incomplete", "uncompared"])
      if (p.counts.base[c] + p.counts.head[c] > 0)
        reasons.push(
          `${name}: ${p.counts.base[c]}/${p.counts.head[c]} ${CLASS_NAMES[c]} (base/head)`,
        );
    for (const m of p.moved) reasons.push(`${name}: moved: ${m}`);
    for (const d of p.differences) reasons.push(`${name}: ${d}`);
    for (const d of p.unanalysedDifferences) reasons.push(`${name}: no analysis: ${d}`);
    for (const d of p.apartElsewhere) reasons.push(`${name}: ${d}`);
  }
  for (const step of ran ?? [])
    if (step.status !== 0) reasons.push(`checks: ${step.step} exited ${step.status}`);
  const status = notRun.length > 0 ? 3 : reasons.length > 0 ? 1 : 0;
  const notCompared = Object.values(parts).reduce(
    (sum, p) => sum + p.routeNotCompared.threw + p.routeNotCompared.refused,
    0,
  );
  const verdict =
    status === 3
      ? "incomplete: not every part asked ran"
      : status === 1
        ? "apart"
        : notCompared === 0
          ? "equal"
          : `equal (for ${notCompared} ${notCompared === 1 ? "package" : "packages"} whose route result is not compared, over the analysis's publication only)`;
  return { manifest, notRun, parts, reached, checks: ran, reasons, status, verdict };
}

/** Beside a part's completed count: how many of them had the research route's result not compared, by kind. */
const notComparedText = ({ routeNotCompared: { threw, refused } }) =>
  threw + refused === 0
    ? ""
    : ` (of these ${threw + refused} route result not compared: ${threw} threw alike, ${refused} refused alike)`;

const percent = (x) => `${(100 * x).toFixed(1)} %`;
const shareText = (s) =>
  `${s.name}: ${s.units.toLocaleString("en")} units, ${percent(s.today)} of its ${s.allowance.toLocaleString("en")}, ${percent(s.fixed)} of the fixed ${FIXED_LIMIT.toLocaleString("en")}`;

/** `evidence-report`: print the report; with `--json`, write it. */
export function evidenceReportStep({ positional: [prefix], options }) {
  if (prefix === undefined || (options.owner === undefined && options.results === undefined))
    throw new Usage("evidence-report <prefix> --owner <o> (its header)");
  const file = options.manifest ?? manifestPath(prefix);
  if (!existsSync(file)) throw new Usage(`no record of what ${prefix} queued: ${file}`);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const results = options.results ?? path.join(homedir(), "jobs", "results", options.owner);
  const r = evidenceReport(manifest, results);
  const out = (text) => process.stdout.write(`${text}\n`);
  out(`base ${manifest.base}, head ${manifest.head}`);
  out(
    `covered: ${manifest.areas.asked.join(", ")}; the four held modes${manifest.packages.length === 0 ? "; no packages" : ""}`,
  );
  out(`left out: ${manifest.areas.left.length === 0 ? "no area" : manifest.areas.left.join(", ")}`);
  for (const p of manifest.packages) out(`packages: ${p.folder} (${p.count})`);
  if (manifest.packages.length > 0)
    out(
      `bound: ${manifest.bound.timeout} s and ${manifest.bound.memory} MB a package; ${r.reached} reached the time bound`,
    );
  for (const entry of r.notRun) out(`not run: ${entry}`);
  for (const [name, p] of Object.entries(r.parts)) {
    const row = (tree) => CLASSES.map((c) => `${p.counts[tree][c]} ${CLASS_NAMES[c]}`).join(", ");
    out(`${name}: ${p.sources} sources; base ${row("base")}; head ${row("head")}`);
    out(
      `${name}: ${p.differences.length} differences over ${p.completed} completed on both trees${notComparedText(p)}; ${p.threwBoth} threw alike; ${p.moved.length} moved`,
    );
    for (const t of p.threwAlike) out(`${name} threw alike on both trees: ${t}`);
    for (const t of p.routeNotComparedList) out(`${name} route result not compared: ${t}`);
    if (p.limitBoth.length > 0)
      out(
        `${name} refused at the limit on both trees (${p.limitBoth.length}): ${p.limitBoth.join(", ")}`,
      );
    if (p.unanalysed.length > 0) {
      out(
        `${name}: ${p.unanalysedDifferences.length} differences over ${p.unanalysed.length} with no analysis on both trees (${name === "set" || name === "packages" ? "their diagnostics, and no plan" : "their publication only: the area runner records no diagnostics"})`,
      );
      out(`${name} no analysis on both trees (${p.unanalysed.length}): ${p.unanalysed.join(", ")}`);
    }
    p.shares.forEach((share, at) => {
      const tree = at === 0 ? "base" : "head";
      // (whose a source is: the set's and the areas' are generated, the packages' creators' scripts)
      const origin = name === "packages" ? "creator's script" : "generated";
      if (share.heaviest !== null)
        out(`${name} ${tree} heaviest (${origin}): ${shareText(share.heaviest)}`);
      for (const s of share.aboveHalf)
        out(`${name} ${tree} above half (${origin}): ${shareText(s)}`);
    });
  }
  out(
    `checks: ${r.checks === null ? "not run" : r.checks.map((s) => `${s.step} ${s.status === 0 ? "passed" : `exited ${s.status}`}`).join(", ")}`,
  );
  for (const reason of r.reasons) out(reason);
  out(r.verdict);
  if (options.json !== undefined) writeFileSync(options.json, `${JSON.stringify(r, null, 1)}\n`);
  return r.status;
}
