#!/usr/bin/env node
// node bin/prepost.mjs /existing/repo PRE POST /new/output [--profile quick|focused|deep] [--seed N]
//   [--case-timeout-ms N] [--library REF]
// One pre/post evaluation: builds PRE and POST (`prepare-build.mjs`, which gives a tree before #1427 the corpus runner's
// oracle library from REF of `--library`), plans the profile, runs it on both builds, compares them, and, where both
// trees hold the oracle library, runs the unextended corpus runner over the committed module (`tests/families/run.mjs
// property`). Writes report.json and report.md. Exits 0 when the family tells the builds apart (scoped failures on PRE,
// none on POST, every row of both run to a verdict), 1 when it does not, 2 when a step fails.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setKey, sourceKey } from "../../sources.mjs";
import { readJson, writeJson } from "../lib/json.mjs";

const bin = dirname(fileURLToPath(import.meta.url));
const families = resolve(bin, "../..");
const LIBRARY = "dist/tests/helpers/type-core-oracles.js";
const TIME = "/usr/bin/time";
const steps = [];

/**
 * A step's process: its exit, its output, its wall time and, where GNU time is installed, its CPU and peak RSS (the
 * largest process of the step, a waited-for child included). `watch`: a file whose first growth is timed.
 */
async function step(name, command, args, watch) {
  const timing = join(out, `.time-${steps.length}`);
  const timed = existsSync(TIME);
  const started = performance.now();
  let firstGrowthMs = null;
  const child = spawn(
    timed ? TIME : command,
    timed ? ["-f", "%e %U %S %M", "-o", timing, command, ...args] : args,
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-8000)));
  const poll =
    watch === undefined
      ? null
      : setInterval(() => {
          if (firstGrowthMs === null && existsSync(watch) && statSync(watch).size > 0)
            firstGrowthMs = performance.now() - started;
        }, 50);
  const code = await new Promise((done) => child.on("close", (exit) => done(exit)));
  clearInterval(poll);
  const record = { step: name, exit: code, wallMs: performance.now() - started };
  if (watch !== undefined) record.firstGrowthMs = firstGrowthMs;
  if (timed && existsSync(timing)) {
    const [, user, system, rss] = readFileSync(timing, "utf8").trim().split("\n").at(-1).split(" ");
    Object.assign(record, {
      cpuMs: (Number(user) + Number(system)) * 1000,
      peakRssKiB: Number(rss),
    });
  }
  steps.push(record);
  if (code !== 0 && code !== 1 && code !== 2) record.stderr = stderr;
  return { code, stdout, stderr, record };
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const [value] = args.splice(at, 2).slice(1);
  if (value === undefined) throw new Error(`--${name} needs a value`);
  return value;
};
const profile = option("profile", "focused");
const seed = option("seed", "1442");
const caseTimeout = option("case-timeout-ms", "15000");
const library = option("library", undefined);
const [repo, pre, post, outArg, ...extra] = args;
const out = outArg === undefined ? undefined : resolve(outArg);
try {
  if (!repo || !pre || !post || !out || extra.length > 0)
    throw new Error(
      "Usage: node bin/prepost.mjs /existing/repo PRE POST /new/output [--profile P] [--seed N] [--case-timeout-ms N] [--library REF]",
    );
  mkdirSync(out, { recursive: false });
  const node = process.execPath;
  const builds = {};
  for (const [side, ref] of [
    ["pre", pre],
    ["post", post],
  ]) {
    const built = await step(`prepare ${side}`, node, [
      join(bin, "prepare-build.mjs"),
      repo,
      ref,
      join(out, `${side}-build`),
      ...(library === undefined ? [] : ["--library", library]),
    ]);
    if (built.code !== 0) throw new Error(`prepare ${side} failed: ${built.stderr}`);
    builds[side] = JSON.parse(built.stdout.trim().split("\n").at(-1));
  }
  const planned = await step("plan", node, [
    join(bin, "pilot.mjs"),
    "plan",
    "--profile",
    profile,
    "--seed",
    seed,
    "--out",
    join(out, "plan.json"),
  ]);
  if (planned.code !== 0) throw new Error(`plan failed: ${planned.stderr}`);
  const plan = readJson(join(out, "plan.json"));
  const summaries = {};
  for (const side of ["pre", "post"]) {
    await step(`run ${side}`, node, [
      join(bin, "pilot.mjs"),
      "run",
      "--plan",
      join(out, "plan.json"),
      "--build",
      join(out, `${side}-build`),
      "--out",
      join(out, side),
      "--case-timeout-ms",
      caseTimeout,
    ]);
    if (!existsSync(join(out, side, "summary.json")))
      throw new Error(`run ${side} left no summary`);
    summaries[side] = readJson(join(out, side, "summary.json"));
  }
  const compared = await step("compare", node, [
    join(bin, "compare.mjs"),
    join(out, "pre", "results.jsonl"),
    join(out, "post", "results.jsonl"),
    join(out, "comparison.json"),
  ]);
  if (compared.code === 2) throw new Error(`compare failed: ${compared.stderr}`);
  const comparison = readJson(join(out, "comparison.json"));

  // the unextended runner over the committed module, where both trees can load an oracle library
  const committed = await import(join(families, "property", "s8-stores.mjs"));
  const planSources = setKey(
    new Set(
      plan.cases.map((c) =>
        sourceKey({ files: [{ path: "main.tease", source: c.source }], globals: c.globals }),
      ),
    ),
  );
  let runner;
  const missing = ["pre", "post"].filter(
    (side) => !existsSync(join(out, `${side}-build`, LIBRARY)),
  );
  if (missing.length > 0)
    runner = {
      status: "NOT_RUN",
      reason: `no oracle library in the ${missing.join(" and ")} tree (before #1427): pass --library REF`,
    };
  else {
    const differences = join(out, "runner-differences.jsonl");
    const ran = await step(
      "runner",
      node,
      [
        join(families, "run.mjs"),
        "property",
        join(out, "pre-build"),
        join(out, "post-build"),
        "--out",
        differences,
      ],
      differences,
    );
    const lines = ran.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
    runner = {
      status: ran.code === 0 || ran.code === 1 ? "RUN" : "ERROR",
      sameSources: planSources === committed.recorded.sha256,
      total: lines.at(-1) ?? null,
      firstDifferenceMs: ran.record.firstGrowthMs,
    };
  }

  const incomplete = (summary) =>
    summary.counts.ERROR +
    summary.counts.TIMEOUT +
    summary.counts.CANCELLED +
    summary.counts.NOT_RUN;
  const distinguished =
    summaries.pre.counts.FAIL > 0 &&
    summaries.post.counts.FAIL === 0 &&
    incomplete(summaries.pre) === 0 &&
    incomplete(summaries.post) === 0;
  const side = (summary) => ({
    verdict: summary.verdict,
    counts: summary.counts,
    executions: summary.actualRuntimeExecutions,
    assertions: summary.assertions,
    preflightMs: summary.preflightMs,
    adapterStartupsMs: summary.adapterStartupsMs,
    elapsedMs: summary.elapsedMs,
    firstFailureMs: summary.firstFailureMs,
  });
  const report = {
    schemaVersion: 1,
    family: plan.family,
    profile: plan.profile,
    seed: plan.seed,
    planHash: plan.planHash,
    node: process.versions.node,
    builds,
    pre: side(summaries.pre),
    post: side(summaries.post),
    comparison: {
      fixed: comparison.fixed.length,
      regressed: comparison.regressed.length,
      unchanged: comparison.unchangedCount,
      incomparable: comparison.incomparableCount,
    },
    distinguished,
    runner,
    steps,
  };
  writeJson(join(out, "report.json"), report);
  const counts = (summary) => Object.entries(summary.counts).map(([k, v]) => `${k} ${v}`);
  writeFileSync(
    join(out, "report.md"),
    [
      `# ${plan.family} pre/post: ${distinguished ? "told apart" : "not told apart"}`,
      "",
      `Pre ${builds.pre.commit ?? `tree ${builds.pre.tree}`}: ${summaries.pre.verdict}, ${counts(summaries.pre).join(", ")}`,
      `Post ${builds.post.commit ?? `tree ${builds.post.tree}`}: ${summaries.post.verdict}, ${counts(summaries.post).join(", ")}`,
      `Compared: ${report.comparison.fixed} fixed, ${report.comparison.regressed} regressed, ${report.comparison.unchanged} unchanged, ${report.comparison.incomparable} incomparable`,
      `Runner: ${runner.status}${runner.total ? `, ${runner.total.differences} differences, ${runner.total.stalled} stalled` : ""}${runner.reason ? ` (${runner.reason})` : ""}`,
      "",
      `Profile ${plan.profile}, seed ${plan.seed}, plan ${plan.planHash}, Node ${process.versions.node}.`,
      "Counts are configurations, not bugs; UNSUPPORTED and OUT_OF_SCOPE rows are incomplete coverage, never PASS.",
      "",
    ].join("\n"),
  );
  console.log(
    JSON.stringify({ distinguished, pre: report.pre.counts, post: report.post.counts, runner }),
  );
  process.exitCode = distinguished ? 0 : 1;
} catch (error) {
  console.error(error.stack);
  if (out !== undefined && existsSync(out)) writeJson(join(out, "steps.json"), steps);
  process.exitCode = 2;
}
