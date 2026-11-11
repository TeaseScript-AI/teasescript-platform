// `collect` reads the campaigns' results (`~/jobs/results/<owner>/<campaign>/<job>/out`, or `--results`): per area its
// shards, sources, runs, differences and what did not compare; the set's records; the stall verdicts of
// `tests/families/stalls.mjs` over the areas' work records, with `<prefix>-rerun`'s records where `rerun-stalls` ran;
// each area difference by its first differing part ("route only": the last part, both trees with as many parts), a
// stops run's by the stops `run.mjs` classified (`apartText`); an area record of no form `run.mjs` writes
// (`areaRecordForm`) as unread, which differs, never equal; each set difference by what differs; and `<prefix>-aside`'s
// rows where `aside` ran. A shard is its job name (`<area>-<i>of<N>`; an area ran when its shards 0 to N-1 of one N
// stand), and of its attempts one is read: the one that left a summary line and whose queue record (`meta.json`) shows
// its runner's own ending (`ranOut`: exit 0 or 1, 3 as well for an area job, with the queue's outcome for that exit, no
// OOM kill, no timeout, no lost test file). Any other attempt is listed, with its host and outcome, as replaced and
// never read; a shard none of whose attempts stands is "not run", never equal. Several attempts that could stand are
// refused (exit 2) unless all but one are replaced: by a rerun's record (`rerun-shard`) or by `--replace
// <failed>=<rerun>`, which is refused when the jobs are not one shard's attempts or the rerun cannot stand. It prints a
// table and, with `--json`, writes the report.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ROOT, SHARDS, USAGE, Usage, areasOf, labelOf } from "./common.mjs";
import { areaOf, countIn, jobsOf, lines, shardsRead } from "./results.mjs";

/** Whether an area difference is the candidate route's alone: the last part, with as many parts on both trees. */
export const routeOnly = (d) => d.parts?.[0] === d.parts?.[1] && d.part === d.parts?.[0] - 1;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `object`'s own keys are exactly `keys`, in any order. */
const keysAre = (object, keys) =>
  Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));

/** Whether `at` is one tree's `[pass, ordinal]` of a stop, or `null` where that tree has none. */
const stopAt = (at) =>
  at === null || (Array.isArray(at) && at.length === 2 && at.every(Number.isInteger));

/**
 * Whether `stops` is what `run.mjs` (`stopsApart`, #2355) writes on a stops difference: `{ unavailable }` text,
 * `{ listsEqual: true }`, or `added`, `removed` and `moved` lists of `{ label, path, base, head }`.
 */
function stopsForm(stops) {
  if (!isObject(stops)) return false;
  if (keysAre(stops, ["unavailable"])) return typeof stops.unavailable === "string";
  if (keysAre(stops, ["listsEqual"])) return stops.listsEqual === true;
  return (
    keysAre(stops, ["added", "removed", "moved"]) &&
    Object.values(stops).every(
      (list) =>
        Array.isArray(list) &&
        list.every(
          (stop) =>
            isObject(stop) &&
            keysAre(stop, ["label", "path", "base", "head"]) &&
            typeof stop.label === "string" &&
            typeof stop.path === "string" &&
            stopAt(stop.base) &&
            stopAt(stop.head) &&
            (stop.base !== null || stop.head !== null),
        ),
    )
  );
}

/**
 * The form of an area record that names a run (`mode`), out of those `tests/families/run.mjs` writes: `exception`
 * (`thrown`, from either tree or both) and `unanswered` (no `head` hash), which the area's summary counts, or
 * `difference` (both trees' hashes, `parts` where the run is a publication's, `stops` where it is a stops run's and
 * `stopsForm` holds); any other record is `unread`.
 */
export function areaRecordForm(d) {
  if (isObject(d.thrown)) return "exception";
  if (isObject(d.unanswered) && d.head === undefined) return "unanswered";
  if (
    typeof d.base === "string" &&
    typeof d.head === "string" &&
    (d.stops === undefined || stopsForm(d.stops))
  )
    return "difference";
  return "unread";
}

/** One tree's pass and ordinal of a stop, or `none`. */
const atText = (at) => (at === null ? "none" : `pass ${at[0]} ordinal ${at[1]}`);

/**
 * Where an area difference lies: a publication's first differing part; or a stops run's stops as `run.mjs` classified
 * them (#2355), each added, removed or moved stop by its place (`label:path`) and both trees' pass and ordinal, or why
 * they are unavailable; else its check apart.
 */
export function apartText(d) {
  if (Array.isArray(d.parts)) return `part ${d.part} of ${d.parts.join("/")}`;
  const { stops } = d;
  if (stops === undefined) return `${d.check} apart`;
  if (stops.unavailable !== undefined)
    return `${d.check} apart; which stops: unavailable (${stops.unavailable})`;
  if (stops.listsEqual)
    return `${d.check} apart; its stop lists equal, the stop set's other fields apart`;
  const kinds = ["added", "removed", "moved"].map((kind) => {
    const listed = stops[kind].map(
      ({ label, path, base, head }) =>
        `${label}:${path} (base ${atText(base)}, head ${atText(head)})`,
    );
    return `${kind} ${listed.length}${listed.length === 0 ? "" : `: ${listed.join(", ")}`}`;
  });
  return `${d.check} apart; stops ${kinds.join("; ")}`;
}

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
export function report(prefix, results, expected = areasOf(ROOT).map((a) => a.name), replace = []) {
  const areas = new Map();
  // (each area's counts of shards, as its jobs' names give them: one, or the area is not run whole)
  const counts = new Map();
  const notRun = [];
  const work = [];
  const differences = [];
  // (an area record of no form `areaRecordForm` knows: never read as no difference)
  const unread = [];
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
    counts.set(area, new Set([...(counts.get(area) ?? []), countIn(name)]));
    if (read === null) {
      notRun.push(name);
      continue;
    }
    const { out, summary } = read;
    row.shards += 1;
    for (const key of Object.keys(row)) if (key !== "shards") row[key] += summary[key] ?? 0;
    if (existsSync(path.join(out, `${area}.work.jsonl`)))
      work.push(path.join(out, `${area}.work.jsonl`));
    for (const d of lines(path.join(out, `${area}.differences.jsonl`))) {
      if (d.mode === undefined) continue;
      const form = areaRecordForm(d);
      if (form === "difference") differences.push({ area, ...d, routeOnly: routeOnly(d) });
      else if (form === "unread") unread.push({ area, job: name, record: d });
    }
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
  for (const name of expected) if (!areas.has(name)) notRun.push(`${name}: no shard`);
  for (const [name, { shards }] of areas) {
    const [count, ...more] = counts.get(name);
    if (more.length > 0 || count === null)
      notRun.push(`${name}: shards named with ${[...counts.get(name)].join(" and ")} shards`);
    else if (shards < count && !notRun.some((job) => job.startsWith(`${name}-`)))
      notRun.push(`${name}: ${shards} of ${count}`);
  }
  if (set.shards < SHARDS && !notRun.some((job) => job.startsWith("set-")))
    notRun.push(`set: ${set.shards} of ${SHARDS}`);
  return {
    prefix,
    areas: Object.fromEntries(areas),
    counts: Object.fromEntries([...counts].map(([name, of]) => [name, [...of].join("/")])),
    set,
    stalls,
    reruns: reruns.length,
    differences,
    unread,
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
      reasons.push(`${d.area} ${d.generator} ${d.source} ${d.mode}: ${apartText(d)}`);
  for (const { area, job, record } of r.unread)
    reasons.push(
      `${area} (${job}): a record of no form run.mjs writes: ${JSON.stringify(record).slice(0, 300)}`,
    );
  for (const d of r.set.differences)
    if (!(d.what === "diagnostics only" && agreed.has(`${d.name} ${labelOf(d.mode)}`)))
      reasons.push(`set ${d.name} mode ${d.mode}: ${d.what}`);
  for (const a of r.aside)
    if (!a.planEqual || !a.asideEqual)
      reasons.push(
        `aside ${a.source} ${a.mode}: plan ${a.planEqual ? "=" : "≠"}, text ${a.asideEqual ? "=" : "≠"} aside`,
      );
  return { status: reasons.length > 0 ? 1 : 0, reasons };
}

export function collect({ positional: [prefix], options }) {
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
      `${name.padEnd(10)} ${a.shards}/${r.counts[name]} shards ${a.sources} sources ${a.runs} runs ${a.differences} differences ${a.stalled} stalled\n`,
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
