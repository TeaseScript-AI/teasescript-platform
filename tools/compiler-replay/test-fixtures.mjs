// The stand-ins and results folders the tests of tools/compiler-replay/ share.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const tool = fileURLToPath(new URL("../compiler-replay.mjs", import.meta.url));

/**
 * A stand-in `sx-job` in `bin` that logs each call's arguments, a batch's lines and each `--in` file's text (read before
 * it answers, as `sx-job` snapshots them: a missing one fails the call), and prints an id a job.
 */
export function standInQueue(bin, id = "11111111111111") {
  const log = join(bin, "calls.jsonl");
  writeFileSync(
    join(bin, "sx-job"),
    `#!/bin/sh
node -e 'const fs = require("fs"); const [log, ...args] = process.argv.slice(1);
const lines = args[0] === "submit-batch" ? fs.readFileSync(args[1], "utf8").trim().split("\\n") : [];
const inputs = Object.fromEntries(args.flatMap((arg, at) => args[at - 1] === "--in"
  ? [[arg.slice(0, arg.indexOf("=")), fs.readFileSync(arg.slice(arg.indexOf("=") + 1), "utf8")]] : []));
fs.appendFileSync(log, JSON.stringify({ args, lines, inputs }) + "\\n");
for (const _ of args[0] === "submit-batch" ? lines : [0]) console.log("${id}");' "${log}" "$@"
`,
  );
  chmodSync(join(bin, "sx-job"), 0o755);
  return () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
}

export const write = (file, rows) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
};

/** A queue record that ran out: `done`, on desktop; `fields` override it. */
export const ran = (name, fields = {}) => ({
  name,
  exit: 0,
  outcome: "done",
  oom: [],
  timed_out: false,
  lost_test_files: null,
  worker: "desktop",
  ...fields,
});
export const killed = {
  exit: 143,
  outcome: "killed at its memory cap",
  oom: ["x"],
  worker: "truenas",
};

/**
 * One attempt of an area shard `rings-<i>of16` in `root`'s `p-areas`, its job `id`: its record (`ran`'s, with `record`),
 * and unless `ran` is false its summary, with its differences and work records.
 */
export function areaAttempt(
  root,
  id,
  i,
  { record = {}, ran: summary = true, differences = [], work } = {},
) {
  const folder = join(root, "p-areas", id);
  write(join(folder, "meta.json"), [ran(`rings-${i}of16`, record)]);
  const out = join(folder, "out");
  if (summary)
    write(join(out, "rings.log"), [
      { area: "rings", sources: 2, runs: 8, differences: differences.length },
    ]);
  write(join(out, "rings.differences.jsonl"), differences);
  if (work !== undefined) write(join(out, "rings.work.jsonl"), work);
}

/** A job id of the stand-in queue: `n`'s 14 hexadecimal digits after `tag`. */
export const jobId = (tag, n) => `${tag}${n.toString(16).padStart(13, "0")}`;

/** A results folder of `prefix`'s campaigns: one area's and the set's 16 shards, each as `shard(i)` makes it. */
export function results(prefix, shard) {
  const root = mkdtempSync(join(tmpdir(), "compiler-replay-results-"));
  for (let i = 0; i < 16; i += 1) {
    const { area = {}, set = {} } = shard(i);
    areaAttempt(root, jobId("a", i), i, area);
    const folder = join(root, `${prefix}-set`, jobId("b", i));
    write(join(folder, "meta.json"), [ran(`set-${i}of16`)]);
    const s = join(folder, "out");
    if (set.ran !== false)
      write(join(s, "plans.log"), [
        { set: "corpus", sources: 1, runs: 4, stalled: 0, uncharged: 0 },
      ]);
    write(join(s, "plans.jsonl"), set.records ?? []);
  }
  return root;
}

export const same = {
  plan: "p",
  diagnostics: "d",
  error: null,
  trace: "t",
  questions: "q",
  units: 1,
};
export const mode = (index, head = same) => ({
  mode: index,
  base: same,
  head,
  same: head === same,
});
