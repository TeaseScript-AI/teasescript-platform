import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, USAGE, Usage } from "./compiler-replay/common.mjs";
import { submit } from "./compiler-replay/submit.mjs";
import { collect } from "./compiler-replay/collect.mjs";
import { rerunShard, rerunStalls } from "./compiler-replay/reruns.mjs";
import { aside, asideRun } from "./compiler-replay/aside.mjs";

// A compiler pull request's replay of its base against its head, through the queue, in these steps:
//
//   node tools/compiler-replay.mjs submit <base> <head> --owner <owner> [--campaign <prefix>] [--baseline]
//     [--costs <results folder>] [--target <seconds>] [--priority <level>] [--dry]
//   node tools/compiler-replay.mjs collect <prefix> --owner <owner> [--results <folder>] [--json <file>] [--replace <job>=<job>]...
//   node tools/compiler-replay.mjs rerun-shard <prefix> <base> <head> <job> --owner <owner> [--baseline] [--host <host>] [--dry]
//   node tools/compiler-replay.mjs rerun-stalls <prefix> <base> <head> --owner <owner> [--memory <MB>] [--host <host>]
//   node tools/compiler-replay.mjs aside <prefix> <base> <head> --owner <owner> --declare <file>
//   node tools/compiler-replay.mjs plan-checks <plan.json>...
//
// Each step is its module's in `tools/compiler-replay/` (`submit.mjs`, `collect.mjs`, `reruns.mjs`, `aside.mjs`).
//
// `plan-checks` prints each plan file's checks (`tests/helpers/plan-checks.ts`'s `planChecks`, from the built `dist/`).
//
// Exit status: 0 when the step did what it says and, for `collect`, every shard ran and nothing differs, stalls or
// stays uncompared, or what differs is only route text that `aside`'s rows set aside; 1 when something differs, stalls
// or fails to compare (listed); 2 on a usage error, a refused replacement or input it cannot read; 3 for `collect` when
// a shard did not run.

/**
 * The positional arguments and `--name value` options of `argv`; `--dry` and `--baseline` are flags, and each
 * `--replace <failed>=<rerun>` adds a pair to `options.replace`.
 */
function parse(argv) {
  const positional = [];
  const options = { replace: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === "--dry" || argument === "--baseline") options[argument.slice(2)] = true;
    else if (argument.startsWith("--")) {
      if (i + 1 >= argv.length) throw new Usage(`${argument} needs a value`);
      const value = argv[(i += 1)];
      if (argument !== "--replace") options[argument.slice(2)] = value;
      else if (/^[0-9a-f]{14}=[0-9a-f]{14}$/u.test(value)) options.replace.push(value.split("="));
      else throw new Usage(`--replace takes <failed job>=<rerun job>, not ${value}`);
    } else positional.push(argument);
  }
  return { positional, options };
}

async function planChecksStep({ positional }) {
  const helper = path.join(ROOT, "dist/tests/helpers/plan-checks.js");
  if (!existsSync(helper))
    throw new Usage(`no built ${path.relative(ROOT, helper)}: build the tree first`);
  const { planChecks } = await import(pathToFileURL(helper).href);
  for (const file of positional)
    process.stdout.write(`${file}: ${planChecks(JSON.parse(readFileSync(file, "utf8")))}\n`);
  return 0;
}

const STEPS = {
  submit,
  collect,
  "rerun-shard": rerunShard,
  "rerun-stalls": rerunStalls,
  aside,
  "aside-run": asideRun,
  "plan-checks": planChecksStep,
};

if (import.meta.main) {
  try {
    const step = STEPS[process.argv[2]];
    if (step === undefined) throw new Usage(USAGE);
    process.exitCode = (await step(parse(process.argv.slice(3)))) ?? 0;
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    process.stderr.write(`compiler-replay: ${error.message}\n`);
    process.exitCode = 2;
  }
}
