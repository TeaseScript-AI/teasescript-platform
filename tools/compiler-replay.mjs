import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatorFolders, holdsGenerators } from "../tests/families/sources.mjs";

// A compiler pull request's replay of its base against its head, through the queue, in five steps:
//
//   node tools/compiler-replay.mjs submit <base> <head> --owner <owner> [--campaign <prefix>] [--baseline] [--dry]
//   node tools/compiler-replay.mjs collect <prefix> --owner <owner> [--results <folder>] [--json <file>]
//   node tools/compiler-replay.mjs rerun-stalls <prefix> <base> <head> --owner <owner> [--memory <MB>]
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
// set difference by what differs; and `<prefix>-aside`'s rows where `aside` ran. A shard whose job left no summary line
// is "not run", never equal. It prints a table and, with `--json`, writes the report.
//
// `rerun-stalls` reruns the areas' stalled sources on both trees in one queue job (`stalls.mjs --index`, then `stalls.mjs
// rerun`, at `--memory`, 12,288 MB unless given) as `<prefix>-rerun`.
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
// or fails to compare (listed); 2 on a usage error or input it cannot read; 3 for `collect` when a shard did not run.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHARDS = 16;
const CASES = path.join(homedir(), "work", "o4-m4-g3", "cases.json");
const USAGE =
  "usage: node tools/compiler-replay.mjs submit|collect|rerun-stalls|aside|plan-checks … (its header)";

class Usage extends Error {}

/** The positional arguments and `--name value` options of `argv`; `--dry` and `--baseline` are flags. */
function parse(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === "--dry" || argument === "--baseline") options[argument.slice(2)] = true;
    else if (argument.startsWith("--")) {
      if (i + 1 >= argv.length) throw new Usage(`${argument} needs a value`);
      options[argument.slice(2)] = argv[(i += 1)];
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

/** A campaign's jobs: each `{ name, out }`, its name from the queue's record (`meta.json`). */
function jobsOf(results, campaign) {
  const folder = path.join(results, campaign);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).map((id) => {
    const meta = path.join(folder, id, "meta.json");
    const name = existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")).name : id;
    return { name, out: path.join(folder, id, "out") };
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

/**
 * The report of a replay's campaigns under `results`. `expected` names the areas `submit` queued (this tree's, as
 * `areasOf` takes them): an area with no shard in the results is not run, never equal.
 */
export function report(prefix, results, expected = areasOf(ROOT).map((a) => a.name)) {
  const areas = new Map();
  const notRun = [];
  const work = [];
  const differences = [];
  for (const { name, out } of jobsOf(results, `${prefix}-areas`)) {
    const area = name.replace(/-\d+of\d+$/u, "");
    const summary = lines(path.join(out, `${area}.log`)).at(-1);
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
    if (summary?.area === undefined) {
      notRun.push(name);
      continue;
    }
    row.shards += 1;
    for (const key of Object.keys(row)) if (key !== "shards") row[key] += summary[key] ?? 0;
    if (existsSync(path.join(out, `${area}.work.jsonl`)))
      work.push(path.join(out, `${area}.work.jsonl`));
    for (const d of lines(path.join(out, `${area}.differences.jsonl`)))
      if (d.mode !== undefined) differences.push({ area, ...d, routeOnly: routeOnly(d) });
  }
  const set = { shards: 0, sources: 0, runs: 0, stalled: 0, uncharged: 0, differences: [] };
  for (const { name, out } of jobsOf(results, `${prefix}-set`)) {
    const summary = lines(path.join(out, "plans.log")).at(-1);
    if (summary?.set === undefined) {
      notRun.push(name);
      continue;
    }
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
  const r = report(prefix, results);
  const { status, reasons } = verdict(r);
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

function rerunStalls({ positional: [prefix, base, head], options }) {
  if (head === undefined || options.owner === undefined) throw new Usage(USAGE);
  const results = options.results ?? path.join(homedir(), "jobs", "results", options.owner);
  const work = jobsOf(results, `${prefix}-areas`).flatMap(({ out }) =>
    existsSync(out)
      ? readdirSync(out)
          .filter((f) => f.endsWith(".work.jsonl"))
          .map((f) => path.join(out, f))
      : [],
  );
  const index = path.join(mkdtempSync(path.join(tmpdir(), "compiler-replay-")), "index.json");
  spawnSync(
    process.execPath,
    [path.join(ROOT, "tests/families/stalls.mjs"), ...work, "--index", index],
    { encoding: "utf8" },
  );
  if (!existsSync(index) || JSON.parse(readFileSync(index, "utf8")).entries?.length === 0) {
    process.stdout.write("no stalled source\n");
    return 0;
  }
  const memory = options.memory ?? "12288";
  for (const id of queue([
    "submit",
    "--name",
    `${prefix}-rerun`,
    "--owner",
    options.owner,
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
    "--",
    "bash",
    "-c",
    `cd "$SX_TREE_head" && node tests/families/stalls.mjs rerun "$SX_IN/index.json" "$SX_TREE_base" "$SX_TREE_head" "$SX_OUT/rerun" --memory ${memory} > "$SX_OUT/rerun.log" 2>&1`,
  ]))
    process.stdout.write(`${id}\n`);
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
