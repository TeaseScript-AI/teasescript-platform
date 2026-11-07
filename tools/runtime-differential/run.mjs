// The differential harness's campaign runner (docs/TESTING.md "Differential harness"), after `npm run build`:
//   node tools/runtime-differential/run.mjs --seed S --count N [--from I] [--route legacy|core] [--shrink]
// runs generated programs (seed, index from I to I + N - 1) through this build against itself and writes one JSON line
// per program: seed, index, runtime seed, input and plan digests, the verdict, its first mismatch path, and with
// `--shrink` the reduced repro of a discrepancy and its signature.
//
// It runs in ordered phases: usage, load, run, output, decide. Terminal handlers, installed before anything that can
// fail, turn any failure in a phase, any output-stream error, any uncaught exception or unhandled rejection, and SIGPIPE
// into exit 2. The decision (`exit.mjs`: 0 identity, an unsupported route, or censored at the step limit; 1 a decided
// difference, a one-sided rejection included; 2 a harness failure or an unknown verdict) is final only once stdout and
// standard error (its verdict summary, censored pairs counted) have finished, and only through `process.exitCode`,
// which is 2 until then, so that a run that ends without deciding fails closed.
//
// The bar: the exit status covers the run, its decision and the delivery of both output streams. A signal or event
// raised after both streams have finished and the loop is idle is outside the bar: it cannot change delivered output.
// This joins the accepted residual of a module calling `process.exit`, setting `exitCode`, or raising a signal at its
// own process itself. A real broken pipe reaches the process as an `EPIPE` error on the stream, which the bar covers.
// The boundary cases are signals raised with `process.kill(process.pid, "SIGPIPE")`: as the summary finishes, at
// stderr's `prefinish`, and during the decision; Node may not deliver them before it exits. The engine does none of
// these; a fatal abort exits 134.

import { parseArgs } from "node:util";

// Until the decision, the exit status is 2: a run that ends without deciding, also one whose own modules fail to load
// (they are loaded below, after this), fails closed.
process.exitCode = 2;

// The CLI's own modules, loaded once the default and the handlers below are in place.
let exitStatus, verdictCounts, wholeNumber, generate, shrink;

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

/** The CLI's own modules: its decision, the generator and the shrinker. */
async function tools() {
  ({ exitStatus, verdictCounts, wholeNumber } = await import("./exit.mjs"));
  ({ generate } = await import("./generate.mjs"));
  ({ shrink } = await import("./shrink.mjs"));
}

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

/** Writes `lines` to `stream` with backpressure, each write's callback awaited, then ends it and awaits `finish`. */
async function output(stream, lines) {
  for (const line of lines)
    await new Promise((resolve, reject) => {
      stream.write(line, (error) => (error ? reject(error) : resolve()));
    });
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function main() {
  await tools();
  const options = usage(process.argv.slice(2));
  const harness = await load();
  const { reports, lines } = run(options, harness);
  await output(process.stdout, lines);
  await output(process.stderr, [`${JSON.stringify({ summary: verdictCounts(reports) })}\n`]);
  return exitStatus(reports);
}

// The decision is final only after both streams have finished, and only through `process.exitCode`: the process then
// ends on its own, so a failure still pending (a rejection, a stream error, a throw at exit) reaches the terminal
// handlers, which exit 2.
main().then(
  (status) => {
    process.exitCode = status;
  },
  (error) => fail(describe(error)),
);
