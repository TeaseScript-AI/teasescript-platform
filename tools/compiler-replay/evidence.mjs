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
// `evidence-report` first says what the run covered and what it left out (areas not asked or not run, the modes, the
// package folders with their packages' counts, the bound and how many packages reached it), then, per part (the set,
// each area, the packages), each tree's count of sources in six classes (`classOf`, `sourceClass`): completed, refused
// at the limit, refused at the syntax gate, threw (the checker's own outcome, by the error's class and the function and
// file it is thrown from, `throwPlace`), incomplete (what the infrastructure did: stalled, killed, past the safety net,
// a runner's own exception) and uncompared (no record a class can be read from); the sources whose class differs
// between the trees, by name; the differences over sources completed on both trees, each with its first differing
// part, and over those that threw on both, where the class or place of the throw differs; every source that threw
// alike on both trees, by name, each time; and the heaviest share of the limit per tree, with every source above half
// of it, each as a share of the allowance the code gives it and of the fixed limit (`FIXED_LIMIT`). Exit 0 when every
// part asked ran, each completed something and nothing differs, moves class, is incomplete or uncompared, and the
// checks passed (a throw alike on both trees is listed, never a reason); 3 when a part asked did not run; else 1; 2 on
// a usage error.
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
export const CLASSES = ["completed", "limit", "slice", "threw", "incomplete", "uncompared"];
const CLASS_NAMES = {
  completed: "completed",
  limit: "refused at the limit",
  slice: "refused at the syntax gate",
  threw: "threw",
  incomplete: "incomplete",
  uncompared: "uncompared",
};
const DEFAULTS = { packageShards: 16, timeout: 3600, memory: 6500 };
const manifestPath = (prefix) => path.join(homedir(), "work", "replay-evidence", `${prefix}.json`);

/**
 * One run's class on one tree, the one place a limit is told from the rest: a ledger stopped at a limit (`stopped`) or
 * a candidate-route refusal a limit made (`outside: "limit"`) is refused at the limit; any other candidate-route refusal
 * is refused at the syntax gate; another error is the checker's own outcome, threw; else completed. A run without
 * `stopped` (a runner from before #2796) is uncompared. What the infrastructure did (a stall, a kill, the safety net, a
 * shard unread) is the record's, never a run's: incomplete.
 */
export function classOf({ error = null, stopped, outside = null }) {
  if (stopped === undefined) return "uncompared";
  if (stopped !== null || outside === "limit") return "limit";
  if (outside === "slice") return "slice";
  return error === null ? "completed" : "threw";
}

/** Where a run that threw threw (`throwPlace`'s text, as the runner recorded it). */
const throwOf = (run) => run.thrown ?? run.error;

/** The places a tree's runs threw at, sorted and joined, or `null` where none threw. */
const threwAt = (runs) => {
  const places = [...new Set(runs.filter((run) => classOf(run) === "threw").map(throwOf))].sort();
  return places.length === 0 ? null : places.join("; ");
};

/**
 * A source's class on one tree from its runs' classes: the first of incomplete, uncompared, threw, limit, slice, else
 * completed.
 */
export function sourceClass(classes) {
  for (const which of ["incomplete", "uncompared", "threw", "limit", "slice"])
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
      };
    const modes = r.modes ?? [];
    const side = (tree) => sourceClass(modes.map((m) => classOf(m[tree])));
    const threw = ["base", "head"].map((tree) => threwAt(modes.map((m) => m[tree])));
    const apart = modes.map((m) => setDifference(m)).find((what) => what !== null) ?? null;
    const share = ["base", "head"].map((tree) =>
      modes.reduce(
        (heaviest, m) => heavier(shareOf(m[tree].units, m[tree].allowance), heaviest),
        null,
      ),
    );
    return { name: r.name, base: side("base"), head: side("head"), apart, share, threw };
  });
}

/**
 * An area's sources from `run.mjs`'s `--work` records and `--out` differences: a source whose own counts hold a stall,
 * a safety net or an unanswered run is incomplete, as is one whose runner threw outside its runs; one unparsed is
 * refused at the syntax gate, one uncompared so; a tree on which a run threw (`--out`'s exception records, each tree's
 * stack read by `throwPlace`) threw; else each tree's class from its runs' `stopped`. `apart` is the first difference's
 * place (`apartText`).
 */
export function areaSources(work, differences) {
  const apartOf = new Map();
  const thrownOf = new Map();
  for (const d of differences) {
    const key = `${d.generator}\0${d.source}`;
    if (areaRecordForm(d) === "difference" && !apartOf.has(key))
      apartOf.set(key, `${d.mode}: ${apartText(d)}`);
    if (areaRecordForm(d) === "exception") {
      const at = thrownOf.get(key) ?? { runner: false, sides: [new Set(), new Set()] };
      thrownOf.set(key, at);
      if (d.thrown.runner !== undefined) at.runner = true;
      ["base", "head"].forEach((tree, side) => {
        if (d.thrown[tree] !== undefined) at.sides[side].add(throwPlace(d.thrown[tree]));
      });
    }
  }
  return work
    .filter((w) => w.generator !== undefined && w.source !== undefined)
    .map((w) => {
      const name = `${w.generator} ${w.source}`;
      const apart = apartOf.get(`${w.generator}\0${w.source}`) ?? null;
      const counts = w.counts ?? {};
      const thrown = thrownOf.get(`${w.generator}\0${w.source}`);
      const both =
        ["stalled", "uncharged", "unanswered"].some((key) => counts[key] > 0) ||
        thrown?.runner === true ||
        (counts.exceptions > 0 && thrown === undefined)
          ? "incomplete"
          : counts.unparsed > 0
            ? "slice"
            : counts.uncompared > 0
              ? "uncompared"
              : null;
      const runs = w.runs ?? [];
      const threw = [0, 1].map((at) =>
        thrown === undefined || thrown.sides[at].size === 0
          ? null
          : [...thrown.sides[at]].sort().join("; "),
      );
      const side = (at) =>
        both ??
        (threw[at] !== null
          ? "threw"
          : sourceClass(runs.map((run) => classOf({ stopped: run.stopped?.[at] }))));
      const share = [0, 1].map((at) =>
        runs.reduce(
          (heaviest, run) => heavier(shareOf(run.work?.[at], run.allowance?.[at]), heaviest),
          null,
        ),
      );
      return { name, base: side(0), head: side(1), apart, share, threw };
    });
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
function packageApart(m) {
  for (const [run, parts] of Object.entries(PACKAGE_PARTS))
    for (const key of parts)
      if (JSON.stringify(m.base[run][key]) !== JSON.stringify(m.head[run][key]))
        return `${m.mode}: ${run} ${key}`;
  return `${m.mode}: apart`;
}

/** The packages from `packages.mjs` records: each tree's class is its analysis's; `share` its analysis's too. */
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
        bound: r.incomplete,
      };
    const modes = r.modes ?? [];
    const side = (tree) => sourceClass(modes.map((m) => classOf(m[tree].analysis)));
    const threw = ["base", "head"].map((tree) => threwAt(modes.map((m) => m[tree].analysis)));
    const apart = modes.find((m) => !m.same);
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
      apart: apart === undefined ? null : packageApart(apart),
      share,
      threw,
    };
  });
}

/**
 * A part's summary: each tree's counts by class, the class moves, the differences over sources completed or thrown on
 * both trees (a throw of another class or place a difference), the sources that threw alike, the shares.
 */
export function partSummary(sources) {
  const counts = { base: {}, head: {} };
  for (const tree of ["base", "head"]) for (const c of CLASSES) counts[tree][c] = 0;
  const moved = [];
  const differences = [];
  const apartElsewhere = [];
  // (the sources that threw alike on both trees: the checker's outcome, listed every time, never a reason)
  const threwAlike = [];
  let completed = 0;
  let threwBoth = 0;
  for (const s of sources) {
    counts.base[s.base] += 1;
    counts.head[s.head] += 1;
    if (s.base !== s.head) moved.push(`${s.name}: ${CLASS_NAMES[s.base]} → ${CLASS_NAMES[s.head]}`);
    else if (s.base === "completed") {
      completed += 1;
      if (s.apart !== null) differences.push(`${s.name}: ${s.apart}`);
    } else if (s.base === "threw" && s.threw[0] !== s.threw[1]) {
      threwBoth += 1;
      differences.push(`${s.name}: threw ${s.threw[0]} on the base, ${s.threw[1]} on the head`);
    } else {
      if (s.base === "threw") {
        threwBoth += 1;
        threwAlike.push(`${s.name}: ${s.threw[0]}`);
      }
      if (s.apart !== null)
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
  if (manifest.areas.asked.includes("set"))
    parts.set = partSummary(
      setSources(
        setShards.flatMap(({ read }) =>
          read === null ? [] : lines(path.join(read.out, "plans.jsonl")),
        ),
      ),
    );
  for (const area of manifest.areas.asked.filter((name) => name !== "set")) {
    const reads = areaShards
      .filter((s) => s.name.startsWith(`${area}-`) && s.read !== null)
      .map((s) => s.read.out);
    parts[area] = partSummary(
      areaSources(
        reads.flatMap((out) => lines(path.join(out, `${area}.work.jsonl`))),
        reads.flatMap((out) => lines(path.join(out, `${area}.differences.jsonl`))),
      ),
    );
  }
  const { packages, checks } = otherShards(prefix, results);
  let reached = 0;
  if (manifest.packages.length > 0) {
    for (const s of packages) if (s.read === null) notRun.push(s.name);
    if (packages.length < manifest.packageShards)
      notRun.push(`packages: ${packages.length} of ${manifest.packageShards} shards`);
    const records = packages.flatMap(({ read }) =>
      read === null ? [] : lines(path.join(read.out, "packages.jsonl")),
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
  for (const [name, p] of Object.entries(parts)) {
    if (p.sources > 0 && p.completed === 0)
      reasons.push(`${name}: nothing completed on both trees`);
    for (const c of ["incomplete", "uncompared"])
      if (p.counts.base[c] + p.counts.head[c] > 0)
        reasons.push(
          `${name}: ${p.counts.base[c]}/${p.counts.head[c]} ${CLASS_NAMES[c]} (base/head)`,
        );
    for (const m of p.moved) reasons.push(`${name}: class moved: ${m}`);
    for (const d of p.differences) reasons.push(`${name}: ${d}`);
    for (const d of p.apartElsewhere) reasons.push(`${name}: ${d}`);
  }
  for (const step of ran ?? [])
    if (step.status !== 0) reasons.push(`checks: ${step.step} exited ${step.status}`);
  const status = notRun.length > 0 ? 3 : reasons.length > 0 ? 1 : 0;
  return { manifest, notRun, parts, reached, checks: ran, reasons, status };
}

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
      `${name}: ${p.differences.length} differences over ${p.completed} completed on both trees and ${p.threwBoth} that threw on both; ${p.moved.length} moved class`,
    );
    for (const t of p.threwAlike) out(`${name} threw alike on both trees: ${t}`);
    p.shares.forEach((share, at) => {
      const tree = at === 0 ? "base" : "head";
      if (share.heaviest !== null) out(`${name} ${tree} heaviest: ${shareText(share.heaviest)}`);
      for (const s of share.aboveHalf) out(`${name} ${tree} above half: ${shareText(s)}`);
    });
  }
  out(
    `checks: ${r.checks === null ? "not run" : r.checks.map((s) => `${s.step} ${s.status === 0 ? "passed" : `exited ${s.status}`}`).join(", ")}`,
  );
  for (const reason of r.reasons) out(reason);
  out(r.status === 0 ? "equal" : r.status === 3 ? "incomplete: not every part asked ran" : "apart");
  if (options.json !== undefined) writeFileSync(options.json, `${JSON.stringify(r, null, 1)}\n`);
  return r.status;
}
