// The differential harness's campaign runner (docs/TESTING.md "Differential harness"), after `npm run build`:
//   node tools/runtime-differential/run.mjs --seed S --count N [--from I] [--route legacy|core] [--shrink]
// runs generated programs (seed, index from I to I + N - 1) through this build against itself and writes one JSON line
// per program: seed, index, runtime seed, input and plan digests, the verdict, its first mismatch path, and with
// `--shrink` the reduced repro of a discrepancy and its signature. It runs in ordered phases (usage, load, run, decide);
// any phase's failure exits 2, before or instead of a decision. The decision is `exit.mjs`'s: 0 identical,
// 1 differences, 2 a harness failure.

import { parseArgs } from "node:util";

import { exitStatus, wholeNumber } from "./exit.mjs";
import { generate } from "./generate.mjs";
import { shrink } from "./shrink.mjs";

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

/** Runs the campaign, writing one line per program; returns its reports. */
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
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
  return reports;
}

try {
  const options = usage(process.argv.slice(2));
  const harness = await load();
  process.exitCode = exitStatus(run(options, harness));
} catch (error) {
  process.stderr.write(`runtime differential: ${error?.message ?? error}\n`);
  process.exitCode = 2;
}
