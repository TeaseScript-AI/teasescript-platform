import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatorFolders, holdsGenerators } from "../tests/families/sources.mjs";

// A compiler pull request's replay of its base against its head, through the queue, in these steps:
//
//   node tools/compiler-replay.mjs submit <base> <head> --owner <owner> [--campaign <prefix>] [--baseline] [--dry]
//   node tools/compiler-replay.mjs collect <prefix> --owner <owner> [--results <folder>] [--json <file>] [--replace <job>=<job>]...
//   node tools/compiler-replay.mjs rerun-shard <prefix> <base> <head> <job> --owner <owner> [--baseline] [--host <host>] [--dry]
//   node tools/compiler-replay.mjs rerun-stalls <prefix> <base> <head> --owner <owner> [--memory <MB>] [--host <host>]
//   node tools/compiler-replay.mjs aside <prefix> <base> <head> --owner <owner> --declare <file>
//   node tools/compiler-replay.mjs plan-checks <plan.json>...
//
// `submit` queues the set (`tests/families/plans.mjs corpus`, 16 shards, two trees) as `<prefix>-set` and every area
// (`tests/families/run.mjs`, 16 shards each) as `<prefix>-areas`: the areas are the folders of `tests/families` that hold
// a generator and the fixture folder `tools/corpus/fixture`, as `baselines.mjs` takes them, each passed by its folder;
// copies at `--memory 6144` on both trees. `--baseline` runs the areas against the base's stored runs
// (`--needs-baseline`, `~/work/baselines/<base's src tree>/<area>`, at the baseline's heap); the set always runs two
// trees. The prefix defaults to `replay-<head>`. It prints each job's id.
//
// `collect` reads the campaigns' results (`~/jobs/results/<owner>/<campaign>/<job>/out`, or `--results`): per area its
// shards, sources, runs, differences and what did not compare; the set's records; the stall verdicts of
// `tests/families/stalls.mjs` over the areas' work records, with `<prefix>-rerun`'s records where `rerun-stalls` ran;
// each area difference by its first differing part ("route only": the last part, both trees with as many parts); each
// set difference by what differs; and `<prefix>-aside`'s rows where `aside` ran. A shard is its job name, and of its
// attempts one is read: the one that left a summary line and whose queue record (`meta.json`) shows its runner's own
// ending (`ranOut`: exit 0 or 1, 3 as well for an area job, with the queue's outcome for that exit, no OOM kill, no
// timeout, no lost test file). Any other attempt is listed, with its host and outcome, as replaced and never read; a
// shard none of whose attempts stands is "not run", never equal. Several attempts that could stand are refused (exit 2)
// unless all but one are replaced: by a rerun's record (`rerun-shard`) or by `--replace <failed>=<rerun>`, which is
// refused when the jobs are not one shard's attempts or the rerun cannot stand. It prints a table and, with `--json`,
// writes the report.
//
// `rerun-shard` submits one shard again into its campaign, `submit`'s own submission with the shard written in, as the
// rerun of `<job>`: its `bash -c` script opens with `: replaces <job>;`, which `collect` reads from the rerun's record
// (`meta.json`'s `command`, kept verbatim), refusing one that names a job outside its shard. `<job>` may itself be a
// rerun; it is refused when `<job>` is not in the campaigns or ran another script or trees. `--host` pins the worker.
//
// `rerun-stalls` reruns the standing area attempts' stalled sources on both trees in one queue job (`stalls.mjs --index`,
// then `stalls.mjs rerun`, at `--memory`, 12,288 MB unless given) as `<prefix>-rerun`; `--host` pins the worker. A work
// record `stalls.mjs` refuses is a usage error, never "no stalled source".
//
// `aside` compiles each route-only area difference and each differing set source, in each mode, through the candidate
// route (`publishedRoute`) on both trees in one queue job as `<prefix>-aside`: a row agrees where the plan's JSON text
// (`jsonText`) is byte-equal and the route's text is equal once every pattern of the declaration file is removed. The
// declaration file is a JSON list of `{ "pattern": <regular expression source>, "reason": <why its text may differ> }`,
// passed as an argument and never read from elsewhere; the report prints each pattern with its reason. Each row also
// counts both plans' checks (`planChecks`).
//
// `plan-checks` prints each plan file's checks (`tests/helpers/plan-checks.ts`'s `planChecks`, from the built `dist/`).
//
// Exit status: 0 when the step did what it says and, for `collect`, every shard ran and nothing differs, stalls or
// stays uncompared, or what differs is only route text that `aside`'s rows set aside; 1 when something differs, stalls
// or fails to compare (listed); 2 on a usage error, a refused replacement or input it cannot read; 3 for `collect` when
// a shard did not run.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHARDS = 16;
const CASES = path.join(homedir(), "work", "o4-m4-g3", "cases.json");
const USAGE =
  "usage: node tools/compiler-replay.mjs submit|collect|rerun-shard|rerun-stalls|aside|plan-checks … (its header)";

class Usage extends Error {}

/**
 * The positional arguments and `--name value` options of `argv`; `--dry` and `--baseline` are flags, and each
 * `--replace <failed>=<rerun>` adds a pair to `options.replace`.
 */
function parse(argv) {
  const positional = [];
  const options = { replace: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === "--dry" || argument === "--baseline") options[argument.slice(2)] = true;
    else if (argument.startsWith("--")) {
      if (i + 1 >= argv.length) throw new Usage(`${argument} needs a value`);
      const value = argv[(i += 1)];
      if (argument !== "--replace") options[argument.slice(2)] = value;
      else if (/^[0-9a-f]{14}=[0-9a-f]{14}$/u.test(value)) options.replace.push(value.split("="));
      else throw new Usage(`--replace takes <failed job>=<rerun job>, not ${value}`);
    } else positional.push(argument);
  }
  return { positional, options };
}

/** The areas, as `baselines.mjs` takes them: each `{ name, folder }`, the folder relative to a tree's root. */
export function areasOf(root) {
  const fixture = path.join(root, "tools", "corpus", "fixture");
  return [
    ...generatorFolders(path.join(root, "tests", "families")),
    ...(holdsGenerators(fixture) ? [fixture] : []),
  ].map((folder) => ({ name: path.basename(folder), folder: path.relative(root, folder) }));
}

/** The queue submissions `submit` makes: each the arguments after `sx-job submit`. */
export function submissions(base, head, { owner, prefix, baseline, baseSrc }) {
  const set = [
    "--name",
    "set-{i}of{n}",
    "--owner",
    owner,
    "--campaign",
    `${prefix}-set`,
    "--shards",
    String(SHARDS),
    "--commit",
    `base=${base}`,
    "--commit",
    `head=${head}`,
    "--data",
    CASES,
    "--mem",
    "3G",
    "--timeout",
    "5h",
    "--",
    "bash",
    "-c",
    'export CASES_JSON=$HOME/work/o4-m4-g3/cases.json; node "$SX_TREE_head/tests/families/plans.mjs" ' +
      '"$SX_TREE_base" "$SX_TREE_head" corpus --shard {i}/{n} --out "$SX_OUT/plans.jsonl" > "$SX_OUT/plans.log" ' +
      '2>"$SX_OUT/plans.err" < /dev/null; rc=$?; tail -1 "$SX_OUT/plans.log"; exit $rc',
  ];
  const areas = areasOf(ROOT).map(({ name, folder }) => {
    const copies = name === "copies" && !baseline;
    const trees = baseline
      ? `"$SX_TREE_head" --baseline "$HOME/work/baselines/${baseSrc}/${name}"`
      : `"$SX_TREE_base" "$SX_TREE_head"`;
    return [
      "--name",
      `${name}-{i}of{n}`,
      "--owner",
      owner,
      "--campaign",
      `${prefix}-areas`,
      "--shards",
      String(SHARDS),
      ...(baseline ? ["--needs-baseline", base] : ["--commit", `base=${base}`]),
      "--commit",
      `head=${head}`,
      "--mem",
      copies ? "8G" : "4G",
      "--timeout",
      "5h",
      "--",
      "bash",
      "-c",
      `cd "$SX_TREE_head" && node tests/families/run.mjs "$SX_TREE_head/${folder}" ${trees} --shard {i}/{n}` +
        `${copies ? " --memory 6144" : ""} --work "$SX_OUT/${name}.work.jsonl" --out "$SX_OUT/${name}.differences.jsonl"` +
        ` > "$SX_OUT/${name}.log" 2>"$SX_OUT/${name}.err" < /dev/null; rc=$?; tail -1 "$SX_OUT/${name}.log"; exit $rc`,
    ];
  });
  return [set, ...areas];
}

/** `sx-job` with `args`: its job ids, or a usage error naming its output. */
function queue(args) {
  const run = spawnSync("sx-job", args, { encoding: "utf8" });
  if (run.status !== 0)
    throw new Usage(`sx-job ${args[0]} failed: ${run.stderr.trim() || run.stdout.trim()}`);
  return run.stdout.split("\n").filter((line) => /^[0-9a-f]{14}$/u.test(line.trim()));
}

function submit({ positional: [base, head], options }) {
  if (head === undefined || options.owner === undefined) throw new Usage(USAGE);
  const prefix = options.campaign ?? `replay-${head.slice(0, 9)}`;
  const baseSrc = options.baseline ? git("rev-parse", `${base}:src`) : null;
  for (const args of submissions(base, head, {
    owner: options.owner,
    prefix,
    baseline: options.baseline,
    baseSrc,
  })) {
    const full = ["submit", ...args, ...(options.dry ? ["--dry"] : [])];
    if (options.dry) process.stdout.write(`${JSON.stringify(full)}\n`);
    else for (const id of queue(full)) process.stdout.write(`${id}\n`);
  }
  process.stdout.write(`campaigns: ${prefix}-set, ${prefix}-areas\n`);
}

const git = (...args) => {
  const run = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (run.status !== 0) throw new Usage(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout.trim();
};

/** Each JSON line of `file` (none where it is missing). */
const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
    : [];

/** A campaign's jobs in their ids' order: each `{ id, name, out, record }`, its name from its queue record (`meta.json`). */
function jobsOf(results, campaign) {
  const folder = path.join(results, campaign);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .sort()
    .map((id) => {
      const meta = path.join(folder, id, "meta.json");
      const record = existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")) : {};
      return { id, name: record.name ?? id, out: path.join(folder, id, "out"), record };
    });
}

/** A job's script, where its record keeps the command `submit` makes, `bash -c <script>`: else `null`. */
const scriptOf = ({ command: c }) =>
  Array.isArray(c) && c.length === 3 && c[0] === "bash" && c[1] === "-c" && typeof c[2] === "string"
    ? c[2]
    : null;

/** `rerun-shard`'s opening of a rerun's script, naming the job it replaces. */
const REPLACES = /^: replaces ([0-9a-f]{14}); /u;

/** The job a rerun's record says it replaces (`REPLACES`), or `null`. */
const replacesOf = (record) => REPLACES.exec(scriptOf(record) ?? "")?.[1] ?? null;

/**
 * The last JSON line of `file`, a runner's summary: `undefined` where there is none or it does not parse, as when the
 * attempt was killed while writing it.
 */
function lastLine(file) {
  if (!existsSync(file)) return undefined;
  const last = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .at(-1);
  try {
    return last === undefined ? undefined : JSON.parse(last);
  } catch {
    return undefined;
  }
}

/**
 * Whether a job's record shows its runner's own ending: one of the runner's `exits` (`run.mjs` 0, 1 or 3, `plans.mjs` 0
 * or 1), the queue's outcome for it ("done" or "exit <n>", not a stop), no OOM kill, no timeout, no lost test file.
 */
export const ranOut = (record, exits) =>
  exits.includes(record.exit) &&
  record.outcome === (record.exit === 0 ? "done" : `exit ${record.exit}`) &&
  (record.oom ?? []).length === 0 &&
  record.timed_out !== true &&
  (record.lost_test_files ?? null) === null;

/**
 * A campaign's shards, by job name: each `{ name, read, attempts }`, `read` the standing attempt's `{ out, summary }`
 * (`null`: not run) and each attempt `{ id, host, outcome, summary, stands }`. An attempt can stand when it left a summary (`summaryOf`) and ran out
 * (`ranOut`); of several, one stands when the others are replaced, by a rerun's record (`replacesOf`) or by `replace`
 * (`[failed, rerun]` pairs, `--replace`). A replacement outside its shard, or several attempts left standing, is refused.
 */
export function shardsOf(jobs, summaryOf, exits, replace = []) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const pairs = [
    ...jobs.flatMap((job) => {
      const replaced = replacesOf(job.record);
      return replaced === null ? [] : [[replaced, job.id, "its record"]];
    }),
    ...replace.filter(([, rerun]) => byId.has(rerun)).map(([a, b]) => [a, b, "--replace"]),
  ];
  for (const [replaced, rerun, by] of pairs)
    if (byId.get(replaced)?.name !== byId.get(rerun).name)
      throw new Usage(
        `${rerun} (${byId.get(rerun).name}) replaces ${replaced} by ${by}, which is not an attempt of its shard`,
      );
  const shards = new Map();
  for (const job of jobs) {
    const summary = summaryOf(job);
    const attempt = {
      id: job.id,
      host: job.record.worker ?? job.record.host ?? "unknown host",
      outcome: job.record.outcome ?? "no record",
      summary: summary !== undefined,
      stands: false,
      job,
      summaryLine: summary,
      can: summary !== undefined && ranOut(job.record, exits),
    };
    shards.set(job.name, [...(shards.get(job.name) ?? []), attempt]);
  }
  return [...shards].map(([name, attempts]) => {
    const can = attempts.filter((a) => a.can);
    for (const [, rerun, by] of pairs)
      if (by === "--replace" && attempts.some((a) => a.id === rerun && !a.can))
        throw new Usage(
          `--replace names ${rerun} (${name}), which left no summary or did not run out`,
        );
    const replaced = new Set(
      pairs.filter(([, rerun]) => can.some((a) => a.id === rerun)).map(([failed]) => failed),
    );
    const left = can.filter((a) => !replaced.has(a.id));
    if (left.length !== Math.min(can.length, 1))
      throw new Usage(
        `${name}: ${can.map((a) => a.id).join(", ")} ran out with a summary and ` +
          `${left.length === 0 ? "replace each other" : "more than one is left standing"}; --replace <job>=<job> names the one that stands`,
      );
    const stands = left[0];
    if (stands !== undefined) stands.stands = true;
    return {
      name,
      read: stands === undefined ? null : { out: stands.job.out, summary: stands.summaryLine },
      attempts: attempts.map(({ id, host, outcome, summary, stands: s }) => ({
        id,
        host,
        outcome,
        summary,
        stands: s,
      })),
    };
  });
}

/** Whether an area difference is the candidate route's alone: the last part, with as many parts on both trees. */
export const routeOnly = (d) => d.parts?.[0] === d.parts?.[1] && d.part === d.parts?.[0] - 1;

/** What differs in a set record's mode: `null` where nothing does. */
export function setDifference({ base: b, head: h, same }) {
  if (same) return null;
  if (b.plan !== h.plan || b.error !== h.error) return "plan";
  if (b.diagnostics !== h.diagnostics)
    return b.trace === h.trace && b.questions === h.questions
      ? "diagnostics only"
      : "diagnostics and work";
  return b.questions !== h.questions ? "questions" : "work";
}

/** The areas' and the set's shards of `prefix`'s campaigns under `results` (`shardsOf`), with `--replace`'s pairs. */
function shardsRead(prefix, results, replace = []) {
  const areaJobs = jobsOf(results, `${prefix}-areas`);
  const setJobs = jobsOf(results, `${prefix}-set`);
  for (const [failed, rerun] of replace)
    if (![...areaJobs, ...setJobs].some((job) => job.id === rerun))
      throw new Usage(
        `--replace ${failed}=${rerun}: ${rerun} is not a job of ${prefix}'s campaigns`,
      );
  const areaShards = shardsOf(
    areaJobs,
    ({ name, out }) => {
      const summary = lastLine(path.join(out, `${areaOf(name)}.log`));
      return summary?.area === undefined ? undefined : summary;
    },
    [0, 1, 3],
    replace,
  );
  const setShards = shardsOf(
    setJobs,
    ({ out }) => {
      const summary = lastLine(path.join(out, "plans.log"));
      return summary?.set === undefined ? undefined : summary;
    },
    [0, 1],
    replace,
  );
  return { areaShards, setShards };
}

/** An area job's area: its name without the shard. */
const areaOf = (name) => name.replace(/-\d+of\d+$/u, "");

/**
 * The report of a replay's campaigns under `results`. `expected` names the areas `submit` queued (this tree's, as
 * `areasOf` takes them): an area with no shard in the results is not run, never equal.
 */
export function report(prefix, results, expected = areasOf(ROOT).map((a) => a.name), replace = []) {
  const areas = new Map();
  const notRun = [];
  const work = [];
  const differences = [];
  const { areaShards, setShards } = shardsRead(prefix, results, replace);
  for (const { name, read } of areaShards) {
    const area = areaOf(name);
    const row = areas.get(area) ?? {
      shards: 0,
      sources: 0,
      runs: 0,
      differences: 0,
      stalled: 0,
      exceptions: 0,
      unparsed: 0,
      unanswered: 0,
      uncompared: 0,
      uncharged: 0,
    };
    areas.set(area, row);
    if (read === null) {
      notRun.push(name);
      continue;
    }
    const { out, summary } = read;
    row.shards += 1;
    for (const key of Object.keys(row)) if (key !== "shards") row[key] += summary[key] ?? 0;
    if (existsSync(path.join(out, `${area}.work.jsonl`)))
      work.push(path.join(out, `${area}.work.jsonl`));
    for (const d of lines(path.join(out, `${area}.differences.jsonl`)))
      if (d.mode !== undefined) differences.push({ area, ...d, routeOnly: routeOnly(d) });
  }
  const set = { shards: 0, sources: 0, runs: 0, stalled: 0, uncharged: 0, differences: [] };
  for (const { name, read } of setShards) {
    if (read === null) {
      notRun.push(name);
      continue;
    }
    const { out, summary } = read;
    set.shards += 1;
    for (const key of ["sources", "runs", "stalled", "uncharged"]) set[key] += summary[key] ?? 0;
    for (const r of lines(path.join(out, "plans.jsonl")))
      for (const m of r.modes ?? []) {
        const what = setDifference(m);
        if (what !== null) set.differences.push({ name: r.name, mode: m.mode, what });
      }
  }
  const reruns = jobsOf(results, `${prefix}-rerun`).flatMap(({ out }) =>
    existsSync(path.join(out, "rerun"))
      ? readdirSync(path.join(out, "rerun"))
          .filter((f) => f.endsWith(".work.jsonl"))
          .map((f) => path.join(out, "rerun", f))
      : [],
  );
  const stalls = { stalled: 0, candidate: 0, unknown: 0, unavailable: 0, unread: null };
  if (work.length > 0) {
    const run = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "tests/families/stalls.mjs"),
        ...work,
        ...(reruns.length > 0 ? ["--rerun", ...reruns] : []),
      ],
      { encoding: "utf8" },
    );
    const total = run.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l))
      .find((l) => l.total === true);
    // (`stalls.mjs` refuses records it cannot read or merge, a rerun of another configuration among them: no verdict)
    if (total === undefined || run.status === 2)
      stalls.unread = (run.stderr.trim() || run.stdout.trim()).split("\n").at(-1) ?? "no total";
    else
      for (const key of ["stalled", "candidate", "unknown", "unavailable"])
        stalls[key] = total[key] ?? 0;
  }
  const aside = jobsOf(results, `${prefix}-aside`).flatMap(({ out }) =>
    lines(path.join(out, "aside.jsonl")),
  );
  for (const name of expected) if (!areas.has(name)) notRun.push(`${name}: 0 of ${SHARDS}`);
  for (const [name, { shards }] of areas)
    if (shards < SHARDS && !notRun.some((job) => job.startsWith(`${name}-`)))
      notRun.push(`${name}: ${shards} of ${SHARDS}`);
  if (set.shards < SHARDS && !notRun.some((job) => job.startsWith("set-")))
    notRun.push(`set: ${set.shards} of ${SHARDS}`);
  return {
    prefix,
    areas: Object.fromEntries(areas),
    set,
    stalls,
    reruns: reruns.length,
    differences,
    aside,
    notRun,
    attempts: [...areaShards, ...setShards]
      .filter(({ attempts }) => attempts.length > 1 || !attempts[0].stands)
      .map(({ name, attempts }) => ({ shard: name, attempts })),
  };
}

/** The verdict of a report: 0, 1 or 3, with each reason it is not 0. */
export function verdict(r) {
  if (r.notRun.length > 0) return { status: 3, reasons: r.notRun.map((job) => `not run: ${job}`) };
  const reasons = [];
  for (const [name, a] of Object.entries(r.areas))
    for (const key of ["exceptions", "unanswered", "uncompared", "uncharged"])
      if (a[key] > 0) reasons.push(`${name}: ${a[key]} ${key}`);
  if (r.set.stalled + r.set.uncharged > 0)
    reasons.push(`set: ${r.set.stalled} stalled, ${r.set.uncharged} uncharged`);
  if (r.stalls.unread !== null) reasons.push(`stalls: not judged (${r.stalls.unread})`);
  if (r.stalls.candidate + r.stalls.unknown + r.stalls.unavailable > 0)
    reasons.push(
      `stalls: ${r.stalls.candidate} candidate, ${r.stalls.unknown} unknown, ${r.stalls.unavailable} uncompared`,
    );
  const agreed = new Set(
    r.aside.filter((a) => a.planEqual && a.asideEqual).map((a) => `${a.source} ${a.mode}`),
  );
  for (const d of r.differences)
    if (!(d.routeOnly && agreed.has(`${d.source} ${d.mode}`)))
      reasons.push(
        `${d.area} ${d.generator} ${d.source} ${d.mode}: part ${d.part} of ${d.parts.join("/")}`,
      );
  for (const d of r.set.differences)
    if (!(d.what === "diagnostics only" && agreed.has(`${d.name} ${MODES[d.mode]}`)))
      reasons.push(`set ${d.name} mode ${d.mode}: ${d.what}`);
  for (const a of r.aside)
    if (!a.planEqual || !a.asideEqual)
      reasons.push(
        `aside ${a.source} ${a.mode}: plan ${a.planEqual ? "=" : "≠"}, text ${a.asideEqual ? "=" : "≠"} aside`,
      );
  return { status: reasons.length > 0 ? 1 : 0, reasons };
}

function collect({ positional: [prefix], options }) {
  if (prefix === undefined || (options.owner === undefined && options.results === undefined))
    throw new Usage(USAGE);
  const results = options.results ?? path.join(homedir(), "jobs", "results", options.owner);
  const r = report(prefix, results, undefined, options.replace);
  const { status, reasons } = verdict(r);
  for (const { shard, attempts } of r.attempts)
    process.stdout.write(
      `${shard}: ${attempts
        .map(
          (a) =>
            `${a.id} on ${a.host}, ${a.outcome}${a.summary ? "" : ", no summary"} (${a.stands ? "stands" : "replaced"})`,
        )
        .join("; ")}\n`,
    );
  for (const [name, a] of Object.entries(r.areas))
    process.stdout.write(
      `${name.padEnd(10)} ${a.shards}/${SHARDS} shards ${a.sources} sources ${a.runs} runs ${a.differences} differences ${a.stalled} stalled\n`,
    );
  process.stdout.write(
    `${"set".padEnd(10)} ${r.set.shards}/${SHARDS} shards ${r.set.sources} sources ${r.set.runs} runs ${r.set.differences.length} differing modes\n`,
  );
  process.stdout.write(`stalls: ${JSON.stringify(r.stalls)}; aside rows: ${r.aside.length}\n`);
  for (const reason of reasons) process.stdout.write(`${reason}\n`);
  process.stdout.write(
    status === 0 ? "equal\n" : status === 3 ? "incomplete: shards not run\n" : "apart\n",
  );
  if (options.json !== undefined)
    writeFileSync(options.json, `${JSON.stringify({ ...r, status, reasons }, null, 1)}\n`);
  return status;
}

/** `rerun-stalls`' submission of the stall index `index`: the arguments after `sx-job submit`. */
export function stallsSubmission(prefix, base, head, index, { owner, memory, host }) {
  return [
    "--name",
    `${prefix}-rerun`,
    "--owner",
    owner,
    "--campaign",
    `${prefix}-rerun`,
    "--commit",
    `base=${base}`,
    "--commit",
    `head=${head}`,
    "--in",
    `index.json=${index}`,
    "--mem",
    `${Math.ceil(Number(memory) / 1024) + 2}G`,
    "--big",
    "--timeout",
    "3h",
    ...(host === undefined ? [] : ["--host", host]),
    "--",
    "bash",
    "-c",
    `cd "$SX_TREE_head" && node tests/families/stalls.mjs rerun "$SX_IN/index.json" "$SX_TREE_base" "$SX_TREE_head" "$SX_OUT/rerun" --memory ${memory} > "$SX_OUT/rerun.log" 2>&1`,
  ];
}

function rerunStalls({ positional: [prefix, base, head], options }) {
  if (head === undefined || options.owner === undefined) throw new Usage(USAGE);
  const results = options.results ?? path.join(homedir(), "jobs", "results", options.owner);
  // (the standing attempts' records only: a replaced job's are never read)
  const work = shardsRead(prefix, results, options.replace)
    .areaShards.filter(({ read }) => read !== null)
    .flatMap(({ name, read: { out } }) => {
      const file = path.join(out, `${areaOf(name)}.work.jsonl`);
      return existsSync(file) ? [file] : [];
    });
  const index = path.join(mkdtempSync(path.join(tmpdir(), "compiler-replay-")), "index.json");
  if (work.length > 0) {
    const run = spawnSync(
      process.execPath,
      [path.join(ROOT, "tests/families/stalls.mjs"), ...work, "--index", index],
      { encoding: "utf8" },
    );
    // (a record stalls.mjs refuses is no index, never "no stalled source")
    if (run.status !== 0 && run.status !== 1)
      throw new Usage(
        `stalls.mjs refused the work records: ${(run.stderr.trim() || run.stdout.trim()).split("\n").at(-1)}`,
      );
  }
  if (!existsSync(index) || JSON.parse(readFileSync(index, "utf8")).entries?.length === 0) {
    process.stdout.write("no stalled source\n");
    return 0;
  }
  for (const id of queue([
    "submit",
    ...stallsSubmission(prefix, base, head, index, {
      ...options,
      memory: options.memory ?? "12288",
    }),
  ]))
    process.stdout.write(`${id}\n`);
  return 0;
}

/**
 * `submit`'s submission of one shard (`<name>-<i>of<n>`, of `campaign`), the shard written in and its script opened with
 * `: replaces <id>;`, so that the rerun's record states the job it replaces; `--host` pins it.
 */
export function shardSubmission(all, campaign, name, id, host) {
  const [, area, i, n] = /^(.+)-(\d+)of(\d+)$/u.exec(name) ?? [];
  const args = all.find(
    (a) =>
      a[a.indexOf("--campaign") + 1] === campaign &&
      a[a.indexOf("--name") + 1] === `${area}-{i}of{n}`,
  );
  if (args === undefined || Number(n) !== SHARDS)
    throw new Usage(`submit queues no shard ${name} in ${campaign}`);
  const shard = args
    .filter((_, k) => args[k] !== "--shards" && args[k - 1] !== "--shards")
    .map((a) => a.replaceAll("{i}", i).replaceAll("{n}", n));
  const end = shard.indexOf("--");
  return [
    ...shard.slice(0, end),
    ...(host === undefined ? [] : ["--host", host]),
    ...shard.slice(end, -1),
    `: replaces ${id}; ${shard.at(-1)}`,
  ];
}

function rerunShard({ positional: [prefix, base, head, id], options }) {
  if (id === undefined || options.owner === undefined) throw new Usage(USAGE);
  const results = options.results ?? path.join(homedir(), "jobs", "results", options.owner);
  const job = ["areas", "set"]
    .flatMap((kind) => jobsOf(results, `${prefix}-${kind}`).map((j) => ({ ...j, kind })))
    .find((j) => j.id === id);
  if (job === undefined) throw new Usage(`${id} is not a job of ${prefix}-areas or ${prefix}-set`);
  const args = shardSubmission(
    submissions(base, head, {
      owner: options.owner,
      prefix,
      baseline: options.baseline,
      baseSrc: options.baseline ? git("rev-parse", `${base}:src`) : null,
    }),
    `${prefix}-${job.kind}`,
    job.name,
    id,
    options.host,
  );
  // (the job it replaces, itself perhaps a rerun, ran this same script on these trees: else the rerun is of another
  // shard, trees or baseline; a commit this clone resolves is compared by its full SHA, any other by its prefix)
  const script = args.at(-1).replace(REPLACES, "");
  const full = (ref) => {
    const run = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return run.status === 0 ? run.stdout.trim() : ref;
  };
  const trees = { base: full(base), head: full(head) };
  const commits = Object.entries(job.record.commits ?? {});
  if (
    scriptOf(job.record)?.replace(REPLACES, "") !== script ||
    commits.length === 0 ||
    !commits.every(([tree, sha]) => sha.startsWith(trees[tree] ?? "-"))
  )
    throw new Usage(
      `${id} (${job.name}) ran another script or trees than submit's for this shard; check <base>, <head> and --baseline`,
    );
  const submit = ["submit", ...args, ...(options.dry ? ["--dry"] : [])];
  if (options.dry) process.stdout.write(`${JSON.stringify(submit)}\n`);
  else for (const rerun of queue(submit)) process.stdout.write(`${rerun}\n`);
  return 0;
}

/** The set's modes (`plans.mjs`'s index, `HELD_MODES`' order: shared first, forward then reversed), as the runner names them. */
const MODES = ["src-on", "rev-on", "src-off", "rev-off"];
const MODE_OF = {
  "src-on": { reversed: false, unshared: false },
  "src-off": { reversed: false, unshared: true },
  "rev-on": { reversed: true, unshared: false },
  "rev-off": { reversed: true, unshared: true },
};

/** A declaration file's patterns: each `{ pattern, reason }`, compiled; a malformed one is a usage error. */
export function declarations(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch (error) {
    throw new Usage(`the declaration file is no JSON: ${error.message}`);
  }
  if (!Array.isArray(list) || list.length === 0)
    throw new Usage("the declaration file is a non-empty JSON list");
  return list.map((entry) => {
    if (
      typeof entry?.pattern !== "string" ||
      typeof entry?.reason !== "string" ||
      entry.reason.trim() === ""
    )
      throw new Usage("each declaration has a `pattern` and a `reason`");
    return { ...entry, regex: new RegExp(entry.pattern, "gu") };
  });
}

/** The declaration file at `file`; one it cannot read or parse is a usage error. */
function declarationsOf(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Usage(`the declaration file cannot be read: ${error.message}`);
  }
  return declarations(text);
}

/** `text` with every declared pattern removed. */
export const setAside = (text, declared) =>
  declared.reduce((t, { regex }) => t.replace(regex, ""), text);

function aside({ positional: [prefix, base, head], options }) {
  if (head === undefined || options.owner === undefined || options.declare === undefined)
    throw new Usage(USAGE);
  const declared = declarationsOf(options.declare);
  const r = report(
    prefix,
    options.results ?? path.join(homedir(), "jobs", "results", options.owner),
    undefined,
    options.replace,
  );
  const rows = [
    ...r.differences
      .filter((d) => d.routeOnly)
      .map(({ generator, source, mode, files, globals }) => ({
        generator,
        source,
        mode,
        files,
        globals,
      })),
    ...[...new Set(r.set.differences.map((d) => d.name))].map((name) => ({ set: name })),
  ];
  const folder = mkdtempSync(path.join(tmpdir(), "compiler-replay-"));
  writeFileSync(
    path.join(folder, "rows.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  for (const { pattern, reason } of declared)
    process.stdout.write(`set aside: /${pattern}/ (${reason})\n`);
  for (const id of queue([
    "submit",
    "--name",
    `${prefix}-aside`,
    "--owner",
    options.owner,
    "--campaign",
    `${prefix}-aside`,
    "--commit",
    `base=${base}`,
    "--commit",
    `head=${head}`,
    "--data",
    CASES,
    "--mem",
    "8G",
    "--timeout",
    "3h",
    "--in",
    `rows.jsonl=${path.join(folder, "rows.jsonl")}`,
    "--in",
    `declare.json=${options.declare}`,
    "--",
    "bash",
    "-c",
    'export CASES_JSON=$HOME/work/o4-m4-g3/cases.json; node "$SX_TREE_head/tools/compiler-replay.mjs" aside-run ' +
      '"$SX_TREE_base" "$SX_TREE_head" "$SX_IN/rows.jsonl" "$SX_IN/declare.json" "$SX_OUT/aside.jsonl"',
  ]))
    process.stdout.write(`${id}\n`);
  return 0;
}

/** On a queue worker: each row compiled on both built trees (`aside`'s job). */
async function asideRun({ positional: [base, head, rows, declare, out] }) {
  const declared = declarationsOf(declare);
  const load = async (tree) =>
    import(pathToFileURL(path.join(tree, "dist/tests/helpers/type-core-oracles.js")).href);
  const [b, h] = [await load(base), await load(head)];
  const { planChecks } = await import(
    pathToFileURL(path.join(head, "dist/tests/helpers/plan-checks.js")).href
  );
  const cases =
    process.env.CASES_JSON === undefined
      ? []
      : JSON.parse(readFileSync(process.env.CASES_JSON, "utf8"));
  const units = lines(rows).flatMap((row) =>
    row.set === undefined
      ? [row]
      : MODES.map((mode) => ({
          source: row.set,
          mode,
          files: cases.find((c) => c.name === row.set)?.files,
          globals: ["hostValue", "hostOther", "hostInit"],
        })),
  );
  const written = [];
  for (const u of units) {
    if (u.files === undefined) throw new Usage(`no files for ${u.source}`);
    const route = (o) =>
      o.inMode(MODE_OF[u.mode], () => o.publishedRoute(u.files, u.globals ?? ["hostValue"]));
    const [rb, rh] = [route(b), route(h)];
    const plan = (o, x) => (x.plan === "outside" ? "outside" : o.jsonText(x.plan));
    const [pb, ph] = [plan(b, rb), plan(h, rh)];
    if (pb === undefined || ph === undefined) throw new Usage(`no JSON text of ${u.source}'s plan`);
    const checks = (x) => (x.plan === "outside" || x.plan === null ? null : planChecks(x.plan));
    written.push(
      JSON.stringify({
        generator: u.generator,
        source: u.source,
        mode: u.mode,
        planEqual: pb === ph,
        textEqual: rb.text === rh.text,
        asideEqual: setAside(rb.text, declared) === setAside(rh.text, declared),
        checks: [checks(rb), checks(rh)],
      }),
    );
  }
  writeFileSync(out, written.join("\n") + "\n");
  return 0;
}

async function planChecksStep({ positional }) {
  const helper = path.join(ROOT, "dist/tests/helpers/plan-checks.js");
  if (!existsSync(helper))
    throw new Usage(`no built ${path.relative(ROOT, helper)}: build the tree first`);
  const { planChecks } = await import(pathToFileURL(helper).href);
  for (const file of positional)
    process.stdout.write(`${file}: ${planChecks(JSON.parse(readFileSync(file, "utf8")))}\n`);
  return 0;
}

const STEPS = {
  submit,
  collect,
  "rerun-shard": rerunShard,
  "rerun-stalls": rerunStalls,
  aside,
  "aside-run": asideRun,
  "plan-checks": planChecksStep,
};

if (import.meta.main) {
  try {
    const step = STEPS[process.argv[2]];
    if (step === undefined) throw new Usage(USAGE);
    process.exitCode = (await step(parse(process.argv.slice(3)))) ?? 0;
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    process.stderr.write(`compiler-replay: ${error.message}\n`);
    process.exitCode = 2;
  }
}
