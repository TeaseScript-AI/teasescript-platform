import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Prints the node:test totals of a GitHub Actions run, per job and step, read from its logs:
//
//   node tools/test-runner/ci-test-counts.mjs <run id>        (the logs from `gh run view <run id> --log`, in this repository)
//   node tools/test-runner/ci-test-counts.mjs --log <file>    (a log saved from that command)
//
// A log line is `<job>\t<step>\t<timestamp> <text>`. Each node:test summary is the run of `ℹ <name> <number>` lines
// that `ℹ tests` begins. A step's summaries are added up, and the count of summaries is named when there are
// several. The last line adds up every step. A run in progress has no logs yet. GitHub keeps a run's per-step logs only
// for about an hour after it ends (on 2026-11-08, runs that had ended 47 minutes earlier still had them, and those
// ended 62 minutes earlier no longer did); after that `gh run view --log` names every line's step "UNKNOWN STEP". Each
// step's output still begins with `##[group]Run <command>`, so such a step is named by the command it ran, and a line
// says why.
//
// Exit status: 0 when the logs hold a summary and none counts a failure, 1 otherwise, 2 when it cannot run (bad
// arguments, an unreadable file, or `gh` failing).

const COUNTED = ["tests", "pass", "fail", "skipped"];
const UNKNOWN = "UNKNOWN STEP";

/** Each step's summed `COUNTED` totals and number of summaries, in log order, from the text of a run's log. */
export function countsOf(log) {
  const steps = new Map();
  let current = null;
  // Per job, the command of the step its unnamed lines now come from.
  const commands = new Map();
  for (const line of log.split(/\r?\n/u)) {
    const [job, logged, rest] = line.split("\t", 3);
    if (rest === undefined) continue;
    let step = logged;
    if (logged === UNKNOWN) {
      const run = /^\S+Z ##\[group\]Run (.+)$/u.exec(rest);
      if (run !== null) commands.set(job, run[1]);
      if (commands.has(job)) step = `run: ${commands.get(job)}`;
    }
    const match = /^\S+Z ℹ (\w+) (\d+(?:\.\d+)?)$/u.exec(rest);
    if (match === null) continue;
    const [, name, value] = match;
    const key = `${job}\t${step}`;
    if (name === "tests") {
      if (!steps.has(key))
        steps.set(key, {
          job,
          step,
          byCommand: logged === UNKNOWN,
          summaries: 0,
          ...Object.fromEntries(COUNTED.map((n) => [n, 0])),
        });
      current = steps.get(key);
      current.summaries += 1;
    } else if (current?.job !== job || current.step !== step) current = null;
    if (current !== null && COUNTED.includes(name)) current[name] += Number(value);
  }
  return [...steps.values()];
}

/** The printed lines for `steps`, ending with their sum. */
function linesOf(steps, source) {
  const jobWidth = Math.max(0, ...steps.map(({ job }) => job.length));
  const stepWidth = Math.max(
    0,
    ...steps.map(({ step, summaries }) => label(step, summaries).length),
  );
  const totals = (counts) => COUNTED.map((name) => `${name} ${counts[name]}`).join("  ");
  const sum = Object.fromEntries(
    COUNTED.map((name) => [name, steps.reduce((total, step) => total + step[name], 0)]),
  );
  const summaries = steps.reduce((total, step) => total + step.summaries, 0);
  const jobs = new Set(steps.map(({ job }) => job)).size;
  return [
    ...(steps.some((step) => step.byCommand)
      ? [
          "ci-test-counts: GitHub no longer has this run's per-step logs (it keeps them for about an hour after a run" +
            " ends), so steps are named by the command they ran.",
        ]
      : []),
    ...steps.map(
      (step) =>
        `${step.job.padEnd(jobWidth)}  ${label(step.step, step.summaries).padEnd(stepWidth)}  ${totals(step)}`,
    ),
    `ci-test-counts: ${source}: ${summaries} summaries in ${steps.length} steps of ${jobs} jobs: ` +
      COUNTED.map((name) => `${name} ${sum[name]}`).join(", "),
  ];
}

function label(step, summaries) {
  return summaries > 1 ? `${step} (${summaries} summaries)` : step;
}

function cannotRun(message) {
  process.stderr.write(`ci-test-counts: ${message}\n`);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  let log;
  let source;
  if (argv.length === 2 && argv[0] === "--log") {
    if (!existsSync(argv[1])) cannotRun(`no file ${argv[1]}`);
    log = readFileSync(argv[1], "utf8");
    source = argv[1];
  } else if (argv.length === 1 && /^\d+$/u.test(argv[0])) {
    const result = spawnSync("gh", ["run", "view", argv[0], "--log"], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
    });
    if (result.error) cannotRun(`gh: ${result.error.message}`);
    if (result.status !== 0) cannotRun(`gh run view ${argv[0]} --log: ${result.stderr.trim()}`);
    log = result.stdout;
    source = `run ${argv[0]}`;
  } else cannotRun("usage: node tools/test-runner/ci-test-counts.mjs <run id> | --log <file>");

  const steps = countsOf(log);
  if (steps.length === 0) {
    process.stdout.write(`ci-test-counts: ${source}: no node:test summary in the logs\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${linesOf(steps, source).join("\n")}\n`);
  process.exitCode = steps.some(({ fail }) => fail > 0) ? 1 : 0;
}

if (import.meta.main) main();
