// A replay campaign's jobs read from the queue's results, and which attempt of each shard stands. A shard is its job
// name (`<area>-<i>of<N>`), and of its attempts at most one is read: the one that left a summary line and whose queue
// record (`meta.json`) shows its runner's own ending (`ranOut`: exit 0 or 1, 3 as well for an area job, with the
// queue's outcome for that exit, no OOM kill, no timeout, no lost test file). Several attempts that could stand are
// refused (exit 2) unless all but one are replaced: by a rerun's record (`rerun-shard`) or by `--replace
// <failed>=<rerun>`. A replacement whose two jobs are not one shard's attempts is refused; a rerun that cannot stand
// replaces nothing, and is refused when `--replace` names it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Usage } from "./common.mjs";

/** Each JSON line of `file` (none where it is missing). */
export const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
    : [];

/** A campaign's jobs in their ids' order: each `{ id, name, out, record }`, its name from its queue record (`meta.json`). */
export function jobsOf(results, campaign) {
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
export const scriptOf = ({ command: c }) =>
  Array.isArray(c) && c.length === 3 && c[0] === "bash" && c[1] === "-c" && typeof c[2] === "string"
    ? c[2]
    : null;

/** `rerun-shard`'s opening of a rerun's script, naming the job it replaces. */
export const REPLACES = /^: replaces ([0-9a-f]{14}); /u;

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

/** The areas' and the set's shards of `prefix`'s campaigns under `results` (`shardsOf`), with `--replace`'s pairs. */
export function shardsRead(prefix, results, replace = []) {
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
export const areaOf = (name) => name.replace(/-\d+of\d+$/u, "");

/** A job's count of shards, from its name (`<area>-<i>of<N>`), or `null`. */
export const countIn = (name) => Number(/-\d+of(\d+)$/u.exec(name)?.[1] ?? NaN) || null;
