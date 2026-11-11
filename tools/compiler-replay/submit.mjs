// `submit` queues the set (`tests/families/plans.mjs corpus`, 16 shards, two trees) as `<prefix>-set` and every area
// (`tests/families/run.mjs`) as `<prefix>-areas`: the areas are the folders of `tests/families` that hold a generator
// and the fixture folder `tools/corpus/fixture`, as `baselines.mjs` takes them, each passed by its folder; copies at
// `--memory 6144` on both trees. `--baseline` runs the areas against the base's stored runs (`--needs-baseline`,
// `~/work/baselines/<base's src tree>/<area>`, at the baseline's heap); the set always runs two trees. An area is
// shared out by its sources' recorded seconds (#2272, `tests/families/split.mjs`): from the `--work` records under
// `--costs` (a campaign's results folder) or else the base's baseline fill (`~/jobs/results/baseline/fill-<the base's
// src tree, 9 digits>`), a costs file is made and kept by its sha256 in `~/work/replay-costs/`; each area it holds runs
// `countOf`'s count of shards for `--target` seconds a shard (900 unless given) with `--split` by that file (`--in
// costs.json`). Every shard is queued in one `sx-job submit-batch`, the areas' shards longest first by `countOf`'s
// estimate, and each of the areas' shards asks one `--mem` (4 GB with `--baseline`, else 8 GB). Where the fill left no
// record, and for an area the costs do not hold, an area runs 16 shards by index, as it prints. The prefix defaults to
// `replay-<head>`; `--priority` sets every job's level (`sx-job submit --priority`). It prints each area's count of
// shards, the count of jobs before it queues them (`--dry` too) and each job's id.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  costsHash,
  costsOf,
  countOf,
  parseCosts,
  workRecordsIn,
} from "../../tests/families/split.mjs";
import {
  CASES,
  ROOT,
  SHARDS,
  USAGE,
  Usage,
  areasOf,
  git,
  inTemporaryFolder,
  queue,
  quoted,
} from "./common.mjs";

/** The seconds an area's shard is sized for where its sources' seconds are recorded (#2272). */
const TARGET = 900;

/**
 * The queue submissions `submit` makes, one a campaign's area or set, each the arguments after `sx-job submit` with
 * `--shards`. `split` (`splitOf`), where given, is the costs file and each area's `countOf` it holds: those areas run
 * that count of shards by the file. Every shard of the areas' campaign asks one `--mem`, so that the queue, which places
 * one owner's alike jobs in their submission order, never passes over the longest for asking more.
 */
export function submissions(base, head, { owner, prefix, baseline, baseSrc, split }) {
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
    const shards = split?.areas[name];
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
      String(shards?.count ?? SHARDS),
      ...(baseline ? ["--needs-baseline", base] : ["--commit", `base=${base}`]),
      ...(shards === undefined ? [] : ["--in", `costs.json=${split.file}`]),
      "--commit",
      `head=${head}`,
      "--mem",
      baseline ? "4G" : "8G",
      "--timeout",
      "5h",
      "--",
      "bash",
      "-c",
      `cd "$SX_TREE_head" && node tests/families/run.mjs "$SX_TREE_head/${folder}" ${trees} --shard {i}/{n}` +
        `${shards === undefined ? "" : ' --split "$SX_IN/costs.json"'}` +
        `${copies ? " --memory 6144" : ""} --work "$SX_OUT/${name}.work.jsonl" --out "$SX_OUT/${name}.differences.jsonl"` +
        ` > "$SX_OUT/${name}.log" 2>"$SX_OUT/${name}.err" < /dev/null; rc=$?; tail -1 "$SX_OUT/${name}.log"; exit $rc`,
    ];
  });
  return [set, ...areas];
}

/** Shard `i` of a submission with `--shards` (`submissions`): its own submission, `{i}` and `{n}` written in. */
export function shardOf(args, i) {
  const n = args[args.indexOf("--shards") + 1];
  return args
    .filter((_, k) => args[k] !== "--shards" && args[k - 1] !== "--shards")
    .map((a) => a.replaceAll("{i}", String(i)).replaceAll("{n}", n));
}

/**
 * `submit`'s batch: every shard of `all` (`submissions`) as its own submission, the areas' shards that `split` sizes
 * longest first by `countOf`'s estimate, then the others in `all`'s order. The estimate comes from the costs file, not
 * the shards the head fills, so a tie can order two shards the other way; the equality verdict never depends on order.
 */
export function batchOf(all, split) {
  const shards = all.flatMap((args) => {
    const area = args[args.indexOf("--name") + 1].replace(/-\{i\}of\{n\}$/u, "");
    const n = Number(args[args.indexOf("--shards") + 1]);
    const isArea = args[args.indexOf("--campaign") + 1].endsWith("-areas");
    const seconds = isArea ? split?.areas[area]?.seconds : undefined;
    return Array.from({ length: n }, (_, i) => ({ args: shardOf(args, i), at: seconds?.[i] ?? 0 }));
  });
  return shards.sort((a, b) => b.at - a.at).map(({ args }) => args);
}

/**
 * `submit`'s split of the areas (`submissions`): the costs file made from the records under `--costs`, else under the
 * base's fill, kept by its sha256 in `~/work/replay-costs/`, and each area's `countOf` for `target` seconds on `trees`
 * trees; or `{ fellBack }`, why there is none, where the base's fill left no record.
 */
export function splitOf(base, { costs, target }, trees) {
  let folder = costs;
  if (folder === undefined) {
    const run = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${base}:src`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (run.status !== 0) return { fellBack: `this clone has no src/ tree of ${base}` };
    const fill = `fill-${run.stdout.trim().slice(0, 9)}`;
    folder = path.join(homedir(), "jobs", "results", "baseline", fill);
  }
  const files = workRecordsIn(folder);
  if (files.length === 0) {
    if (costs !== undefined) throw new Usage(`--costs ${costs} holds no job's work record`);
    return { fellBack: `no work record in ${folder}` };
  }
  const text = costsOf(files);
  const file = path.join(homedir(), "work", "replay-costs", `${costsHash(text)}.json`);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const areas = Object.entries(parseCosts(text).areas).map(([name, area]) => [
    name,
    countOf(area, target, trees),
  ]);
  return { file, areas: Object.fromEntries(areas) };
}

export function submit({ positional: [base, head], options }) {
  if (head === undefined || options.owner === undefined) throw new Usage(USAGE);
  const prefix = options.campaign ?? `replay-${head.slice(0, 9)}`;
  const baseSrc = options.baseline ? git("rev-parse", `${base}:src`) : null;
  const target = Number(options.target ?? TARGET);
  if (!(target > 0)) throw new Usage(`--target ${options.target} is no positive count of seconds`);
  const split = splitOf(base, { costs: options.costs, target }, options.baseline ? 1 : 2);
  if (split.fellBack !== undefined)
    process.stdout.write(
      `no recorded seconds (${split.fellBack}): ${SHARDS} shards an area by index\n`,
    );
  else process.stdout.write(`costs: ${split.file}\n`);
  for (const { name } of areasOf(ROOT)) {
    const sized = split.areas?.[name];
    process.stdout.write(
      sized === undefined
        ? `${name}: ${SHARDS} shards by index${split.fellBack === undefined ? " (no recorded seconds)" : ""}\n`
        : `${name}: ${sized.count} shards by recorded seconds, the largest about ${Math.round(Math.max(...sized.seconds))} s\n`,
    );
  }
  const sized = split.fellBack === undefined ? split : undefined;
  const all = submissions(base, head, {
    owner: options.owner,
    prefix,
    baseline: options.baseline,
    baseSrc,
    split: sized,
  });
  // (one batch, one process: the queue keeps its lines' order among one owner's jobs)
  const level = options.priority === undefined ? [] : ["--priority", options.priority];
  const shards = batchOf(all, sized).map((args) => [...level, ...args]);
  process.stdout.write(`jobs: ${shards.length} in one batch\n`);
  if (options.dry)
    for (const args of shards) process.stdout.write(`${JSON.stringify(["submit", ...args])}\n`);
  else
    // (`sx-job submit-batch` reads the file whole before it returns)
    inTemporaryFolder((folder) => {
      const file = path.join(folder, "batch.txt");
      writeFileSync(file, shards.map((args) => `${args.map(quoted).join(" ")}\n`).join(""));
      for (const id of queue(["submit-batch", file])) process.stdout.write(`${id}\n`);
    });
  process.stdout.write(`campaigns: ${prefix}-set, ${prefix}-areas\n`);
}
