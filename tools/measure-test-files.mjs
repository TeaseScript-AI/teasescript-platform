import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "node:test";
import { filesAtOnce } from "./test-files-at-once.mjs";
import { shardFiles } from "./test-shards.mjs";

// Measures what `tools/costly-test-files.mjs` records: each compiled test file's seconds, from its process's start to its
// end, and the seconds of the checks CI's last test job runs before its tests (`npm run check:pretest`). `--write`
// rewrites `tools/costly-test-files.mjs`; `--raw FILE` keeps the measurement.
//
// `--from-ci RUN ...` (with `gh`) takes them from CI's own runs of the suite, the machines the shards balance: each test
// job keeps its files' seconds as an artifact for 7 days (`TEST_FILE_SECONDS`, `.github/workflows/ci.yml`), the jobs
// API gives the pre-test step's seconds, and each file counts its median over the runs, at least three since CI's
// runners vary. A run counts its last attempt (re-running a run removes its earlier attempts' artifacts).
//
// Without it, the build, the full suite in `npm test`'s order and concurrency, and then `check:pretest` (after the
// suite, with the new seconds written: `test:verification` refuses weights that miss a type-core file) run here, for a
// local look: in a built checkout, on four CPUs as CI's runners have (`taskset -c 0-3`), on a machine nothing else loads,
// with a Node compile cache as in CI, a fresh one unless `NODE_COMPILE_CACHE` names one. Such seconds do not predict
// CI's (#1719). A failed step or test leaves the module as it was.
const usage =
  "Usage: node tools/measure-test-files.mjs [--write] [--raw FILE] [--from-ci RUN ...]\n";
const argv = process.argv.slice(2);
const write = argv[0] === "--write";
if (write) argv.shift();
let raw = null;
if (argv[0] === "--raw" && argv.length >= 2)
  [raw] = argv
    .splice(0, 2)
    .slice(1)
    .map((p) => resolve(p));
const fromCi = argv[0] === "--from-ci" ? argv.slice(1) : null;
if (
  (fromCi === null && argv.length > 0) ||
  (fromCi !== null && new Set(fromCi).size !== fromCi.length) ||
  (fromCi !== null && fromCi.length < 3)
) {
  process.stderr.write(`${usage}(--from-ci takes three distinct runs or more)\n`);
  process.exit(1);
}

// The files listed by name: every type-core file, whose cost grows with the checker's tests, and any other of this many
// seconds or more. The rest count their mean.
const listedSeconds = 10;
const target = new URL("./costly-test-files.mjs", import.meta.url);
const fail = (lines) => {
  process.stderr.write(lines.map((line) => `measure-test-files: ${line}\n`).join(""));
  process.exit(1);
};

/** The seconds `command` takes, or null where it fails. */
function timed(command, args, env = {}) {
  const start = process.hrtime.bigint();
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) {
    process.stderr.write(`measure-test-files: '${[command, ...args].join(" ")}' failed\n`);
    return null;
  }
  return Number(process.hrtime.bigint() - start) / 1e9;
}

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** CI's runs: each run's files' seconds (every test job's artifact), its pre-test step's seconds and its commit. */
function ciRuns(ids) {
  return ids.map((runId) => {
    // (a run's last attempt: re-running a run removes the artifacts of its earlier attempts)
    const where = `repos/{owner}/{repo}/actions/runs/${runId}`;
    const { head_sha: commit, conclusion } = JSON.parse(gh("api", where));
    // (a run that did not pass may lack a test job that never started, whose files the other runs would then cover)
    if (conclusion !== "success") fail([`run ${runId} did not pass (${conclusion})`]);
    const jobs = JSON.parse(gh("api", `${where}/jobs`, "-q", ".jobs"));
    const step = jobs
      .flatMap((job) => job.steps ?? [])
      .find((found) => found.name === "Check source before the tests");
    if (step?.conclusion !== "success") fail([`run ${runId} has no passed pre-test step`]);
    const pretest = (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000;
    const folder = mkdtempSync(join(tmpdir(), "measure-test-files-ci-"));
    gh("run", "download", runId, "--pattern", "test-file-seconds-*", "--dir", folder);
    const kept = readdirSync(folder).map((name) =>
      JSON.parse(readFileSync(join(folder, name, "test-file-seconds.json"), "utf8")),
    );
    // (a test job is one with a step that runs a shard of the tests)
    const testJobs = jobs.filter((job) =>
      (job.steps ?? []).some((found) => found.name.startsWith("Build and run tests")),
    ).length;
    if (testJobs === 0 || kept.length !== testJobs)
      fail([`run ${runId} kept ${kept.length} test jobs' seconds, not ${testJobs}`]);
    const atOnce = new Set(kept.map((found) => found.filesAtOnce));
    if (atOnce.size !== 1)
      fail([`run ${runId}'s test jobs ran ${[...atOnce].join(" and ")} files at once`]);
    const seconds = Object.assign({}, ...kept.map((found) => found.seconds));
    return { run: runId, commit, pretest, filesAtOnce: [...atOnce][0], seconds };
  });
}

let measured;
if (fromCi !== null) {
  const runs = ciRuns(fromCi);
  // (the suite as the checkout has it: a file no run measured is refused, one the checkout lost is left out)
  const suite = readdirSync(new URL("../tests/", import.meta.url))
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => file.replace(/\.ts$/, ".js"));
  const unmeasured = suite.filter((file) =>
    runs.every((found) => found.seconds[file] === undefined),
  );
  if (unmeasured.length > 0) fail(unmeasured.map((file) => `no CI run measured ${file}`));
  const atOnce = new Set(runs.map((found) => found.filesAtOnce));
  if (atOnce.size !== 1) fail([`the runs ran ${[...atOnce].join(" and ")} files at once`]);
  measured = {
    source: `--from-ci ${runs.map((found) => found.run).join(" ")}`,
    from: `CI runs ${runs.map((found) => `${found.run} (${found.commit.slice(0, 9)})`).join(", ")}`,
    filesAtOnce: [...atOnce][0],
    pretestSeconds: median(runs.map((found) => found.pretest)),
    fileSeconds: Object.fromEntries(
      suite.map((file) => [file, median(runs.flatMap((found) => found.seconds[file] ?? []))]),
    ),
    runs,
  };
} else {
  process.env.NODE_COMPILE_CACHE ??= mkdtempSync(join(tmpdir(), "measure-test-files-cache-"));
  if (timed("npm", ["run", "build"], { BUILD_SOURCEMAPS: "0" }) === null) process.exit(1);
  const names = readdirSync("dist/tests").filter((file) => file.endsWith(".test.js"));
  const paths = shardFiles(names, 1, 1).map((file) => resolve("dist/tests", file));
  const fileSeconds = {};
  const testSeconds = {};
  const failed = [];
  const atOnce = filesAtOnce();
  for await (const event of run({ files: paths, concurrency: atOnce, isolation: "process" })) {
    if (event.data?.nesting !== 0 || event.data.file === undefined) continue;
    const file = event.data.file.slice(event.data.file.lastIndexOf("/") + 1);
    if (event.type === "test:fail") failed.push(`${file}: ${event.data.name}`);
    if (event.type !== "test:complete") continue;
    const seconds = event.data.details.duration_ms / 1000;
    // (a file's own entry is named by its path; its top-level tests by their names)
    if (event.data.name === event.data.file) fileSeconds[file] = seconds;
    else (testSeconds[file] ??= {})[event.data.name] = seconds;
  }
  const missing = names.filter((file) => fileSeconds[file] === undefined);
  if (failed.length > 0 || missing.length > 0)
    fail([
      ...failed.map((line) => `failed ${line}`),
      ...missing.map((file) => `no time for ${file}`),
    ]);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  measured = {
    source: "",
    from: `a local run at ${commit.slice(0, 9)}, Node ${process.version}, ${availableParallelism()} CPUs`,
    filesAtOnce: atOnce,
    pretestSeconds: null,
    fileSeconds,
    testSeconds,
  };
}

const sorted = Object.entries(measured.fileSeconds).sort(
  ([a, x], [b, y]) => y - x || (a < b ? -1 : 1),
);
const listed = sorted.filter(
  ([file, seconds]) => file.startsWith("type-core-") || seconds >= listedSeconds,
);
const others = sorted.filter((entry) => !listed.includes(entry));
const mean = others.reduce((sum, [, seconds]) => sum + seconds, 0) / Math.max(others.length, 1);
const moduleText = (
  pretest,
) => `// Generated by \`node tools/measure-test-files.mjs --write${measured.source ? ` ${measured.source}` : ""}\` from
// ${measured.from}; ${measured.filesAtOnce} files at once. Regenerate it from three CI runs or more when a test file's
// cost changes much; a new type-core test file needs an entry (\`tools/test-shards.test.mjs\` requires every one listed).
// The full suite starts the listed files first, costliest first, and CI's test jobs share the files out by these
// seconds (\`tools/test-shards.mjs\`).

/** Each compiled type-core test file's seconds, and every other's of ${listedSeconds} s or more, costliest first. */
export const costlyTestSeconds = {
${listed.map(([file, seconds]) => `  ${JSON.stringify(file)}: ${Math.max(1, Math.round(seconds))},`).join("\n")}
};

/** The seconds of every other test file in the same runs, their mean (${others.length} files). */
export const otherTestSeconds = ${mean.toFixed(1)};

/** The seconds of the checks CI's last test job runs before its tests (\`check:pretest\`). */
export const pretestSeconds = ${Math.round(pretest)};

/** The test files one CI test job runs at once: \`node --test\`'s default on CI's four CPUs. */
export const testFilesAtOnce = ${measured.filesAtOnce};

export const costlyTestFiles = Object.keys(costlyTestSeconds);
`;

// Every way out before the end, a signal or a failed write included, leaves the module as it was.
const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
const restore = () => {
  if (write && previous !== null) writeFileSync(target, previous);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => {
    restore();
    process.exit(1);
  });
try {
  if (measured.pretestSeconds === null) {
    // (the local path's pre-test checks, with the new seconds written beside the previous pre-test seconds)
    const before = Number(/pretestSeconds = (\d+)/.exec(previous ?? "")?.[1] ?? 0);
    if (write) writeFileSync(target, moduleText(before));
    measured.pretestSeconds = timed("npm", ["run", "check:pretest"]);
    if (measured.pretestSeconds === null) {
      restore();
      process.exit(1);
    }
  }
  if (raw !== null) writeFileSync(raw, `${JSON.stringify(measured, null, 1)}\n`);
  if (write) writeFileSync(target, moduleText(measured.pretestSeconds));
} catch (error) {
  restore();
  throw error;
}
process.stdout.write(
  `measure-test-files: ${sorted.length} files, ${sorted.reduce((sum, [, s]) => sum + s, 0).toFixed(0)} s summed, ` +
    `pre-test checks ${measured.pretestSeconds.toFixed(0)} s, ${measured.filesAtOnce} files at once, from ${measured.from}\n`,
);
