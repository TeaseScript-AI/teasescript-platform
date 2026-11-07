// The differential harness's campaign runner (docs/TESTING.md "Differential harness"), after `npm run build`:
//   node tools/runtime-differential/run.mjs --seed S --count N [--from I] [--route legacy|core] [--shrink]
// runs generated programs (seed, index from I to I + N - 1) through this build against itself and writes one JSON line
// per program: seed, index, runtime seed, input and plan digests, the verdict, its first mismatch path, and with
// `--shrink` the reduced repro of a discrepancy and its signature.
//
// It runs in ordered phases: usage, load, run, output, decide. Terminal handlers, installed before anything that can
// fail, turn any failure in a phase, any output-stream error, any uncaught exception or unhandled rejection, and SIGPIPE
// into exit 2. The decision (`exit.mjs`: 0 identity, an unsupported route, or censored at the step limit; 1 a decided
// difference, a one-sided rejection included; 2 a harness failure or an unknown verdict) is made only once stdout has
// finished, and only then does the process exit with it. A summary of the verdicts, censored ones counted, goes to
// standard error.
// The accepted residual: a module in this process that calls `process.exit(1)` or sets `process.exitCode` itself
// bypasses the decision. The engine never does; a fatal abort exits 134.

import { parseArgs } from "node:util";

import { exitStatus, verdictCounts, wholeNumber } from "./exit.mjs";
import { generate } from "./generate.mjs";
import { shrink } from "./shrink.mjs";

/** Ends the process with 2, once, writing a fixed diagnostic if it can. */
function fail(what) {
  try {
    process.stderr.write(`runtime differential: ${what}\n`);
  } catch {
    // The diagnostic is best effort; the exit status decides.
  }
  process.exit(2);
}

const describe = (error) => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "an exception whose text cannot be read";
  }
};

process.on("uncaughtException", (error) => fail(`uncaught: ${describe(error)}`));
process.on("unhandledRejection", (error) => fail(`unhandled rejection: ${describe(error)}`));
process.on("SIGPIPE", () => fail("SIGPIPE"));
process.stdout.on("error", (error) => fail(`standard output: ${describe(error)}`));
process.stderr.on("error", () => process.exit(2));

/** The arguments, validated before anything else loads or runs. */
function usage(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      seed: { type: "string" },
      count: { type: "string", default: "1" },
      from: { type: "string", default: "0" },
      route: { type: "string", default: "legacy" },
      shrink: { type: "boolean", default: false },
    },
  });
  if (values.seed === undefined) throw new Error("--seed is required");
  if (!["legacy", "core"].includes(values.route)) throw new Error("--route is legacy or core");
  return {
    seed: wholeNumber(values.seed, "--seed", 0),
    first: wholeNumber(values.from, "--from", 0),
    count: wholeNumber(values.count, "--count", 1),
    route: values.route,
    shrink: values.shrink,
  };
}

/** The compiled harness, from this checkout's build (a test may point at another directory). */
async function load() {
  const directory = process.env.RUNTIME_DIFFERENTIAL_DIST;
  const dist = directory
    ? new URL(`file://${directory.replace(/\/?$/u, "/")}`)
    : new URL("../../dist/tests/helpers/", import.meta.url);
  const { differentialRun } = await import(new URL("runtime-differential.js", dist).href);
  const { canonicalDigest, renderPath } = await import(
    new URL("runtime-state-comparison.js", dist).href
  );
  return { differentialRun, canonicalDigest, renderPath };
}

const input = (program) => ({
  name: program.id,
  sources: program.sources,
  project: program.project === true,
  fresh: { seed: program.runtimeSeed, ...(program.globals ? { globals: program.globals } : {}) },
});

/** Runs the campaign: its reports, and the lines it will write. */
function run({ seed, first, count, route, shrink: shrinking }, harness) {
  const { differentialRun, canonicalDigest, renderPath } = harness;
  /** A verdict's signature: its kind, the route, and its first mismatch path with indices generalized. */
  const signature = (report) => {
    const verdict = report.verdict;
    const path =
      verdict.kind === "discrepancy"
        ? renderPath(verdict.mismatches[0]?.path ?? []).replace(/\[\d+\]/g, "[*]")
        : verdict.kind === "not-compared"
          ? verdict.because
          : "";
    return `${verdict.kind}:${report.route}:${path}`;
  };
  const reports = [];
  const lines = [];
  for (let index = first; index < first + count; index += 1) {
    const program = generate(seed, index);
    const report = differentialRun(input(program), { route });
    reports.push(report);
    const verdict = report.verdict;
    const line = {
      seed,
      index,
      id: program.id,
      family: program.family,
      runtimeSeed: program.runtimeSeed,
      input: canonicalDigest(program.sources),
      plan: report.plans.left,
      verdict: verdict.kind,
      ...(verdict.kind === "not-compared"
        ? { because: verdict.because, side: verdict.side, outcome: report.outcomes[verdict.side] }
        : {}),
      ...(verdict.kind === "discrepancy" || verdict.kind === "mapping-failure"
        ? { at: verdict.at }
        : {}),
      ...(verdict.kind === "discrepancy"
        ? { path: renderPath(verdict.mismatches[0]?.path ?? []) }
        : {}),
      signature: signature(report),
      steps: report.steps,
      tailSteps: report.tailSteps,
      cpuMs: report.cpuMs,
    };
    const differs = verdict.kind === "discrepancy" || verdict.kind === "mapping-failure";
    if (differs && shrinking && !program.project) {
      const wanted = line.signature;
      const reduced = shrink(program.sources[0].source, (source) => {
        const candidate = { ...program, sources: [{ path: "main.tease", source }] };
        return signature(differentialRun(input(candidate), { route })) === wanted;
      });
      line.reduced = { ...reduced, signature: wanted };
    }
    lines.push(`${JSON.stringify(line)}\n`);
  }
  return { reports, lines };
}

/** Writes `lines` with backpressure, each write's callback awaited, then ends stdout and awaits `finish`. */
async function output(lines) {
  const stdout = process.stdout;
  for (const line of lines)
    await new Promise((resolve, reject) => {
      stdout.write(line, (error) => (error ? reject(error) : resolve()));
    });
  await new Promise((resolve, reject) => {
    stdout.once("error", reject);
    stdout.end(resolve);
  });
}

async function main() {
  const options = usage(process.argv.slice(2));
  const harness = await load();
  const { reports, lines } = run(options, harness);
  await output(lines);
  process.stderr.write(`${JSON.stringify({ summary: verdictCounts(reports) })}\n`);
  return exitStatus(reports);
}

main().then(
  (status) => process.exit(status),
  (error) => fail(describe(error)),
);
