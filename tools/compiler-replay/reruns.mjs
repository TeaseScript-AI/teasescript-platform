// `rerun-shard` submits one shard again into its campaign, `submit`'s own submission with the shard written in, as the
// rerun of `<job>` (a split shard by the costs file its record names, from `~/work/replay-costs/`, refused where that
// is not there): its `bash -c` script opens with `: replaces <job>;`, which `collect` reads from the rerun's record
// (`meta.json`'s `command`, kept verbatim), refusing one that names a job outside its shard. `<job>` may itself be a
// rerun; it is refused when `<job>` is not in the campaigns or ran another script or trees. `<base>` and `<head>` go
// to the queue as full SHAs: what this clone resolves each to, else the job's recorded commit it is a hexadecimal
// prefix of. `--host` pins the worker.
//
// `rerun-stalls` reruns the standing area attempts' stalled sources on both trees in one queue job (`stalls.mjs --index`,
// then `stalls.mjs rerun`, at `--memory`, 12,288 MB unless given) as `<prefix>-rerun`; `--host` pins the worker. A work
// record `stalls.mjs` refuses is a usage error, never "no stalled source".
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { costsHash } from "../../tests/families/split.mjs";
import { ROOT, USAGE, Usage, git, inTemporaryFolder, queue } from "./common.mjs";
import { shardOf, submissions } from "./submit.mjs";
import { REPLACES, areaOf, countIn, jobsOf, scriptOf, shardsRead } from "./results.mjs";

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

export function rerunStalls({ positional: [prefix, base, head], options }) {
  if (head === undefined || options.owner === undefined) throw new Usage(USAGE);
  const results = options.results ?? path.join(homedir(), "jobs", "results", options.owner);
  // (the standing attempts' records only: a replaced job's are never read)
  const work = shardsRead(prefix, results, options.replace)
    .areaShards.filter(({ read }) => read !== null)
    .flatMap(({ name, read: { out } }) => {
      const file = path.join(out, `${areaOf(name)}.work.jsonl`);
      return existsSync(file) ? [file] : [];
    });
  // (`sx-job submit` copies `--in index.json` before it returns)
  return inTemporaryFolder((folder) => {
    const index = path.join(folder, "index.json");
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
  });
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
  if (args === undefined || args[args.indexOf("--shards") + 1] !== n)
    throw new Usage(`submit queues no shard ${name} in ${campaign}`);
  const shard = shardOf(args, Number(i));
  const end = shard.indexOf("--");
  return [
    ...shard.slice(0, end),
    ...(host === undefined ? [] : ["--host", host]),
    ...shard.slice(end, -1),
    `: replaces ${id}; ${shard.at(-1)}`,
  ];
}

export function rerunShard({ positional: [prefix, givenBase, givenHead, id], options }) {
  if (id === undefined || options.owner === undefined) throw new Usage(USAGE);
  const results = options.results ?? path.join(homedir(), "jobs", "results", options.owner);
  const job = ["areas", "set"]
    .flatMap((kind) => jobsOf(results, `${prefix}-${kind}`).map((j) => ({ ...j, kind })))
    .find((j) => j.id === id);
  if (job === undefined) throw new Usage(`${id} is not a job of ${prefix}-areas or ${prefix}-set`);
  // (each commit a full SHA, both compared and submitted, so the queue never reads a name again: the one this clone
  // resolves the name to, else the job's recorded commit the name is a prefix of, else the name, which then differs)
  const recorded = job.record.commits ?? {};
  const fullSha = (ref, tree) => {
    const run = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (run.status === 0) return run.stdout.trim();
    return /^[0-9a-f]+$/u.test(ref) && recorded[tree]?.startsWith(ref) ? recorded[tree] : ref;
  };
  const [base, head] = [fullSha(givenBase, "base"), fullSha(givenHead, "head")];
  // (a split shard by the costs file its record names, by the sha256 that names it, and its area's count of shards)
  const hash = job.record.inputs?.["costs.json"];
  let split;
  if (hash !== undefined) {
    const file = path.join(homedir(), "work", "replay-costs", `${hash}.json`);
    if (!existsSync(file) || costsHash(readFileSync(file, "utf8")) !== hash)
      throw new Usage(
        `${id} (${job.name}) was split by the costs file ${hash}, which ${file} is not`,
      );
    split = { file, areas: { [areaOf(job.name)]: { count: countIn(job.name), seconds: [] } } };
  }
  const args = shardSubmission(
    submissions(base, head, {
      owner: options.owner,
      prefix,
      baseline: options.baseline,
      baseSrc: options.baseline ? git("rev-parse", `${base}:src`) : null,
      split,
    }),
    `${prefix}-${job.kind}`,
    job.name,
    id,
    options.host,
  );
  // (the job it replaces, itself perhaps a rerun, ran this same script on these trees: else the rerun is of another
  // shard, trees or baseline)
  const script = args.at(-1).replace(REPLACES, "");
  const trees = { base, head };
  const commits = Object.entries(recorded);
  if (
    scriptOf(job.record)?.replace(REPLACES, "") !== script ||
    commits.length === 0 ||
    !commits.every(([tree, sha]) => sha === trees[tree])
  )
    throw new Usage(
      `${id} (${job.name}) ran another script or trees than submit's for this shard; check <base>, <head> and --baseline`,
    );
  const submit = ["submit", ...args, ...(options.dry ? ["--dry"] : [])];
  if (options.dry) process.stdout.write(`${JSON.stringify(submit)}\n`);
  else for (const rerun of queue(submit)) process.stdout.write(`${rerun}\n`);
  return 0;
}
