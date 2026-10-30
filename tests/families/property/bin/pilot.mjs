#!/usr/bin/env node
import { resolve } from "node:path";
import { readJson, writeJson, requireInteger } from "../lib/json.mjs";
import { makePlan } from "../lib/plan.mjs";
import { runCampaign } from "../lib/run.mjs";
import { exitCode } from "../lib/status.mjs";
const [command, ...argv] = process.argv.slice(2),
  options = {};
try {
  const allowed =
    command === "plan"
      ? ["profile", "seed", "out", "family"]
      : command === "run"
        ? [
            "plan",
            "build",
            "out",
            "allow-runtime-mismatch",
            "deadline-ms",
            "case-timeout-ms",
            "shard",
            "stop-after-failures",
          ]
        : [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !allowed.includes(name) || name in options)
      throw new Error(`Unknown/duplicate option ${argv[i]}`);
    if (name === "allow-runtime-mismatch") options[name] = true;
    else {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--"))
        throw new Error(`Missing value ${name}`);
      options[name] = argv[++i];
    }
  }
  if (command === "plan") {
    if (!options.out) throw new Error("--out is required");
    if (options.family && options.family !== "s8-stores")
      throw new Error(`Unknown family: ${options.family}`);
    const plan = makePlan(options.profile ?? "quick", Number(options.seed ?? 1442));
    writeJson(resolve(options.out), plan);
    console.log(
      JSON.stringify({
        planHash: plan.planHash,
        sources: plan.cases.length,
        configurations: plan.cases.length * plan.modes.length * plan.policies.length,
        coverage: plan.coverage,
      }),
    );
  } else if (command === "run") {
    for (const k of ["plan", "build", "out"])
      if (!options[k]) throw new Error(`--${k} is required`);
    let shard;
    if (options.shard) {
      const match = /^(\d+)\/(\d+)$/.exec(options.shard);
      if (!match) throw new Error("--shard is zero-based index/total");
      shard = { index: +match[1], total: +match[2] };
    }
    const integer = (name, fallback) =>
      options[name] === undefined ? fallback : requireInteger(Number(options[name]), name, 1);
    const summary = await runCampaign(
      readJson(options.plan),
      resolve(options.build),
      resolve(options.out),
      {
        shard,
        allowRuntimeMismatch: !!options["allow-runtime-mismatch"],
        deadlineMs: integer("deadline-ms", undefined),
        caseTimeoutMs: integer("case-timeout-ms", 15000),
        stopAfterFailures: integer("stop-after-failures", undefined),
      },
    );
    console.log(JSON.stringify(summary));
    process.exitCode = exitCode(summary);
  } else
    throw new Error(
      "Usage: node bin/pilot.mjs plan --out plan.json [--profile quick|focused|deep] [--seed N]\n       node bin/pilot.mjs run --plan plan.json --build /built/checkout --out /new/output [--allow-runtime-mismatch] [--shard 0/2]",
    );
} catch (error) {
  console.error(error.stack);
  process.exitCode = 2;
}
