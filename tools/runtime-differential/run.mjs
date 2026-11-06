// The differential harness's campaign runner (docs/TESTING.md "Differential harness"), after `npm run build`:
//   node tools/runtime-differential/run.mjs --seed S --count N [--from I] [--route legacy|core] [--shrink]
// runs generated programs (seed, index from I to I + N - 1) through this build against itself and writes one JSON line
// per program: seed, index, runtime seed, input and plan digests, the verdict, its first mismatch path, and with
// `--shrink` the reduced repro of a discrepancy and its signature. The arguments are validated before anything runs;
// the exit status is `exit.mjs`'s one decision: 0 identical, 1 differences, 2 a usage or harness failure.

import { parseArgs } from "node:util";

import { exitStatus, wholeNumber } from "./exit.mjs";
import { generate } from "./generate.mjs";
import { shrink } from "./shrink.mjs";

const dist = new URL("../../dist/tests/helpers/", import.meta.url);
const { differentialRun } = await import(new URL("runtime-differential.js", dist).href);
const { canonicalDigest, renderPath } = await import(
  new URL("runtime-state-comparison.js", dist).href
);

let options;
let seed;
let first;
let count;
try {
  ({ values: options } = parseArgs({
    options: {
      seed: { type: "string" },
      count: { type: "string", default: "1" },
      from: { type: "string", default: "0" },
      route: { type: "string", default: "legacy" },
      shrink: { type: "boolean", default: false },
    },
  }));
  if (options.seed === undefined) throw new Error("--seed is required");
  if (!["legacy", "core"].includes(options.route)) throw new Error("--route is legacy or core");
  seed = wholeNumber(options.seed, "--seed", 0);
  first = wholeNumber(options.from, "--from", 0);
  count = wholeNumber(options.count, "--count", 1);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const route = options.route;

const input = (program) => ({
  name: program.id,
  sources: program.sources,
  project: program.project === true,
  fresh: { seed: program.runtimeSeed, ...(program.globals ? { globals: program.globals } : {}) },
});

/** A verdict's signature: its kind, the route, and its first mismatch path with indices generalized. */
function signature(report) {
  const verdict = report.verdict;
  const path =
    verdict.kind === "discrepancy"
      ? renderPath(verdict.mismatches[0]?.path ?? []).replace(/\[\d+\]/g, "[*]")
      : verdict.kind === "not-compared"
        ? verdict.because
        : "";
  return `${verdict.kind}:${report.route}:${path}`;
}

const reports = [];
try {
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
      ...(verdict.kind === "not-compared" ? { because: verdict.because, side: verdict.side } : {}),
      ...(verdict.kind === "not-compared" ? { outcome: report.outcomes[verdict.side] } : {}),
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
    if (verdict.kind === "discrepancy" || verdict.kind === "mapping-failure") {
      if (options.shrink && !program.project) {
        const wanted = line.signature;
        const reduced = shrink(program.sources[0].source, (source) => {
          const candidate = { ...program, sources: [{ path: "main.tease", source }] };
          return signature(differentialRun(input(candidate), { route })) === wanted;
        });
        line.reduced = { ...reduced, signature: wanted };
      }
    }
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(2);
}
process.exitCode = exitStatus(reports);
