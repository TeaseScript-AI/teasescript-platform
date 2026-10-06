/**
 * Explores packages headlessly: plays each package in the real runtime through every branch it can reach within a
 * budget, and reports crashes, line coverage, and loops the player cannot leave. The search is described in
 * `src/explorer.ts`.
 *
 * Usage: node tools/explore.ts [--budget-seconds N] [--max-states N] [--seed N] [--workers 1|2] <unit-dir>... --out <dir>
 *        node tools/explore.ts --replay <out>/<unit>.json (--crash N | --trap N | --error)
 *
 * Each unit folder is a package with `main.tease`, read as the Player reads it. The explorer writes `<out>/<unit>.json`
 * per unit and `<out>/summary.md` over the units of the run. Defaults: 60 seconds and 20000 states per unit, seed 1,
 * one worker; two workers explore two units at a time in separate processes.
 *
 * Every crash and trap has the input list from the start that reaches it, and so does the first input whose runtime
 * operation threw (an explorer or runtime problem, not a script failure). `--replay` plays it again with the seed of
 * the run, prints the transcript, and for a crash or error exits 0 only when the same failure or error comes back.
 * Needs the repository build (`npm run build:typescript` in the repository root).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";
import { loadRepositoryPackageScanner } from "../src/compile-check.ts";
import {
  explore,
  loadEngine,
  replay,
  type Engine,
  type ExploreResult,
  type ExplorerInput,
} from "../src/explorer.ts";
import { packageContentHash } from "./catalog.ts";

const SELF = fileURLToPath(import.meta.url);

interface UnitReport extends Partial<ExploreResult> {
  unit: string;
  dir: string;
  contentHash: string;
  converter: string | null;
  explorer: string;
  seed: number;
  budgetSeconds: number;
  maxStates: number;
  exploredAt: string;
  compile: { ok: boolean; errors: string[] };
}

if (process.argv[1] === SELF) await main(process.argv.slice(2));

async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "budget-seconds": { type: "string", default: "60" },
      "max-states": { type: "string", default: "20000" },
      seed: { type: "string", default: "1" },
      workers: { type: "string", default: "1" },
      out: { type: "string" },
      replay: { type: "string" },
      crash: { type: "string" },
      trap: { type: "string" },
      error: { type: "boolean", default: false },
      "no-summary": { type: "boolean", default: false },
    },
  });
  if (values.replay !== undefined) {
    process.exitCode = await replayCommand(values.replay, values.crash, values.trap, values.error);
    return;
  }
  const budgetSeconds = Number(values["budget-seconds"]);
  const maxStates = Number(values["max-states"]);
  const seed = Number(values.seed);
  const workers = Number(values.workers);
  if (
    values.out === undefined ||
    positionals.length === 0 ||
    !(budgetSeconds > 0) ||
    !Number.isSafeInteger(maxStates) ||
    maxStates < 1 ||
    !Number.isSafeInteger(seed) ||
    (workers !== 1 && workers !== 2)
  ) {
    process.stderr.write(
      "Usage: node tools/explore.ts [--budget-seconds N] [--max-states N] [--seed N] [--workers 1|2] <unit-dir>... --out <dir>\n" +
        "       node tools/explore.ts --replay <out>/<unit>.json (--crash N | --trap N | --error)\n",
    );
    process.exit(2);
  }
  const out = path.resolve(values.out);
  const dirs = positionals.map((dir) => path.resolve(dir));
  const names = dirs.map((dir) => path.basename(dir));
  if (new Set(names).size !== names.length) {
    process.stderr.write("Two unit folders have the same name; their reports would collide.\n");
    process.exit(2);
  }
  await mkdir(out, { recursive: true });
  if (workers === 2 && dirs.length > 1) {
    const flags = ["--budget-seconds", String(budgetSeconds), "--max-states", String(maxStates)];
    flags.push("--seed", String(seed), "--out", out, "--no-summary");
    const groups = [dirs.filter((_, index) => index % 2 === 0), dirs.filter((_, index) => index % 2 === 1)];
    const codes = await Promise.all(
      groups.map(
        (group) =>
          new Promise<number>((resolve) =>
            spawn(process.execPath, [SELF, ...flags, ...group], { stdio: "inherit" }).on("close", (code) =>
              resolve(code ?? 1),
            ),
          ),
      ),
    );
    if (codes.some((code) => code !== 0)) process.exitCode = 1;
  } else {
    const engine = await loadEngine();
    const scan = await loadRepositoryPackageScanner();
    const explorer = explorerCommit();
    for (const dir of dirs) {
      const started = performance.now();
      process.stderr.write(`Exploring ${path.basename(dir)}...\n`);
      const report = await exploreUnit(engine, scan, dir, { budgetSeconds, maxStates, seed, explorer });
      const file = path.join(out, `${report.unit}.json`);
      await writeFile(file, `${JSON.stringify(withReplayCommands(report, file), null, 2)}\n`);
      process.stderr.write(`  ${oneLine(report)} (${Math.round((performance.now() - started) / 1000)} s)\n`);
    }
  }
  if (!values["no-summary"]) {
    const reports = await Promise.all(
      names.map(async (name) => JSON.parse(await readFile(path.join(out, `${name}.json`), "utf8")) as UnitReport),
    );
    await writeFile(path.join(out, "summary.md"), summary(reports, out));
    process.stderr.write(`Wrote ${path.join(out, "summary.md")}.\n`);
  }
}

type Scanner = Awaited<ReturnType<typeof loadRepositoryPackageScanner>>;

interface LoadedUnit {
  sources: { path: string; source: string }[];
  plan: Readonly<Record<string, unknown>> | null;
  errors: string[];
  contentHash: string;
}

async function loadUnit(engine: Engine, scan: Scanner, dir: string): Promise<LoadedUnit> {
  const folder = await scan(dir);
  const compiled = engine.compileProject(folder.sources, { builtins: [], images: folder.images });
  const result = isRecord(compiled) ? compiled : {};
  const errors = (Array.isArray(result.diagnostics) ? result.diagnostics : [])
    .filter((diagnostic) => isRecord(diagnostic) && diagnostic.severity === "error")
    .map((diagnostic) => {
      const entry = diagnostic as Record<string, unknown>;
      const span = isRecord(entry.span) && isRecord(entry.span.start) ? entry.span.start : {};
      const line = typeof span.line === "number" ? span.line + 1 : 0;
      return `${String(entry.path ?? "")}:${line} ${String(entry.code ?? "")} ${String(entry.message ?? "")}`;
    });
  return {
    sources: folder.sources,
    plan: isRecord(result.plan) ? result.plan : null,
    errors,
    contentHash: packageContentHash(folder.sources),
  };
}

async function exploreUnit(
  engine: Engine,
  scan: Scanner,
  dir: string,
  settings: { budgetSeconds: number; maxStates: number; seed: number; explorer: string },
): Promise<UnitReport> {
  const unit = await loadUnit(engine, scan, dir);
  const report: UnitReport = {
    unit: path.basename(dir),
    dir,
    contentHash: unit.contentHash,
    converter: await converterCommit(dir),
    explorer: settings.explorer,
    seed: settings.seed,
    budgetSeconds: settings.budgetSeconds,
    maxStates: settings.maxStates,
    exploredAt: new Date().toISOString(),
    compile: { ok: unit.plan !== null, errors: unit.errors.slice(0, 20) },
  };
  if (unit.plan === null) return report;
  return {
    ...report,
    ...explore(engine, unit.plan, {
      seed: settings.seed,
      budgetMs: settings.budgetSeconds * 1000,
      maxStates: settings.maxStates,
      sources: new Map(unit.sources.map((file) => [file.path, file.source])),
    }),
  };
}

/** The importer commit a unit was converted with, from its conversion record. */
async function converterCommit(dir: string): Promise<string | null> {
  try {
    const record: unknown = JSON.parse(await readFile(path.join(dir, ".conversion.json"), "utf8"));
    return isRecord(record) && typeof record.converter === "string" ? record.converter : null;
  } catch {
    return null;
  }
}

function explorerCommit(): string {
  try {
    return execFileSync("git", ["-C", path.dirname(SELF), "describe", "--always", "--dirty", "--abbrev=8"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function withReplayCommands(report: UnitReport, file: string): UnitReport {
  const command = (flag: string, index?: number) =>
    `node tools/explore.ts --replay ${file} --${flag}${index === undefined ? "" : ` ${index}`}`;
  const error = report.search?.engineErrors.first;
  return {
    ...report,
    ...(report.search === undefined || error == null
      ? {}
      : {
          search: {
            ...report.search,
            engineErrors: {
              ...report.search.engineErrors,
              first: Object.assign({}, error, { replay: command("error") }),
            },
          },
        }),
    ...(report.crashes === undefined
      ? {}
      : { crashes: report.crashes.map((crash, index) => ({ ...crash, replay: command("crash", index) })) }),
    ...(report.traps === undefined
      ? {}
      : { traps: report.traps.map((trap, index) => ({ ...trap, replay: command("trap", index) })) }),
  };
}

function oneLine(report: UnitReport): string {
  if (!report.compile.ok) return `does not compile (${report.compile.errors.length} errors)`;
  const { coverage, search, endStates, crashes, traps } = report as Required<UnitReport>;
  return (
    `${coverage.percent}% of ${coverage.coverableLines} lines, ${search.states} states (${search.stoppedBy}), ` +
    `${crashes.length} crashes, ${traps.length} traps, ` +
    `${endStates.completed} completed / ${endStates.failed} failed / ${endStates.stuck} stuck / ${endStates.open} open`
  );
}

function summary(reports: readonly UnitReport[], out: string): string {
  const first = reports[0]!;
  const lines = [
    "# Explorer summary",
    "",
    `Explorer \`${first.explorer}\`, seed ${first.seed}, budget ${first.budgetSeconds} s and ${first.maxStates} states per unit. ` +
      `Reports: \`${out}/<unit>.json\`.`,
    "",
    "| Unit | Coverage | States | Stopped by | Crashes | Traps | Completed | Failed | Stuck | Open | Time |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const report of reports) {
    if (!report.compile.ok) {
      lines.push(`| ${report.unit} | does not compile | | | | | | | | | |`);
      continue;
    }
    const { coverage, search, endStates, crashes, traps } = report as Required<UnitReport>;
    lines.push(
      `| ${report.unit} | ${coverage.percent}% of ${coverage.coverableLines} lines | ${search.states} | ${search.stoppedBy} | ` +
        `${crashes.length} | ${traps.length} | ${endStates.completed} | ${endStates.failed} | ${endStates.stuck} | ` +
        `${endStates.open} | ${Math.round(search.elapsedMs / 1000)} s |`,
    );
  }
  for (const report of reports) {
    lines.push("", `## ${report.unit}`, "");
    if (!report.compile.ok) {
      lines.push(...report.compile.errors.slice(0, 5).map((error) => `- \`${error}\``));
      continue;
    }
    const { coverage, crashes, traps } = report as Required<UnitReport>;
    for (const crash of crashes as (ExploreResult["crashes"][number] & { replay?: string })[]) {
      lines.push(
        `- Crash \`${crash.code}\` at \`${crash.path}:${crash.line}:${crash.column}\`: ${crash.message} ` +
          `(${crash.states} states, ${crash.inputs.length} inputs; \`${crash.replay ?? ""}\`)`,
      );
    }
    for (const trap of traps as (ExploreResult["traps"][number] & { replay?: string })[]) {
      const texts = trap.sampleTexts.slice(0, 2).map((text) => `"${text}"`);
      lines.push(
        `- Trap (${trap.kind}) at ${trap.locations.slice(0, 3).map((at) => `\`${at}\``).join(", ") || "no prompt"}: ` +
          `${trap.states} states, ${trap.feederStates} leading in; ${[...texts, ...trap.samplePrompts.slice(0, 2)].join(" ")}`,
      );
    }
    const files = [...coverage.files]
      .filter((file) => file.percent < 100)
      .sort((left, right) => left.percent - right.percent)
      .slice(0, 5);
    if (files.length > 0) {
      lines.push(
        `- Least covered: ${files
          .map((file) => `\`${file.path}\` ${file.percent}% (${file.visitedLines}/${file.coverableLines})`)
          .join(", ")}`,
      );
    }
    lines.push(`- Branches reached but left only one way: ${coverage.unvisitedBranches.length}`);
    const { engineErrors } = (report as Required<UnitReport>).search;
    const first = engineErrors.first as { message: string; replay?: string } | null;
    if (engineErrors.count > 0 && first !== null)
      lines.push(`- Runtime operations that threw: ${engineErrors.count}, first: ${first.message} (\`${first.replay ?? ""}\`)`);
  }
  return `${lines.join("\n")}\n`;
}

async function replayCommand(
  file: string,
  crash: string | undefined,
  trap: string | undefined,
  error: boolean,
): Promise<number> {
  const report = JSON.parse(await readFile(file, "utf8")) as UnitReport;
  const index = Number(crash ?? trap);
  const target =
    crash !== undefined
      ? report.crashes?.[index]
      : trap !== undefined
        ? report.traps?.[index]
        : error
          ? report.search?.engineErrors.first
          : undefined;
  if ([crash !== undefined, trap !== undefined, error].filter(Boolean).length !== 1 || target == null) {
    process.stderr.write("Name one existing --crash N, --trap N, or --error of the report.\n");
    return 2;
  }
  const engine = await loadEngine();
  const unit = await loadUnit(engine, await loadRepositoryPackageScanner(), report.dir);
  if (unit.plan === null) {
    process.stderr.write(`${report.dir} does not compile now.\n`);
    return 1;
  }
  if (unit.contentHash !== report.contentHash)
    process.stderr.write("Warning: the package's .tease files changed since the report.\n");
  const replayed = replay(engine, unit.plan, report.seed, target.inputs);
  const { steps, failure } = replayed;
  for (const step of steps) {
    if (step.input !== null) process.stdout.write(`> ${describeInput(step.input)}\n`);
    for (const text of step.texts) process.stdout.write(`  ${text}\n`);
    if (step.prompt !== "") process.stdout.write(`  ${step.prompt}\n`);
  }
  const last = steps.at(-1)!;
  process.stdout.write(
    `Final state: ${last.status}${failure === null ? "" : ` ${failure.code} at ${failure.path}:${failure.line}:${failure.column}: ${failure.message}`}\n`,
  );
  if (replayed.error !== null) process.stdout.write(`Runtime operation threw: ${replayed.error}\n`);
  if (error) {
    const reproduced = replayed.error === report.search!.engineErrors.first!.message;
    process.stdout.write(reproduced ? "Reproduced.\n" : "Not reproduced.\n");
    return reproduced ? 0 : 1;
  }
  if (crash === undefined) return 0;
  const expected = report.crashes![index]!;
  const reproduced =
    failure !== null &&
    failure.code === expected.code &&
    failure.path === expected.path &&
    failure.line === expected.line &&
    failure.column === expected.column;
  process.stdout.write(reproduced ? "Reproduced.\n" : "Not reproduced.\n");
  return reproduced ? 0 : 1;
}

function describeInput(input: ExplorerInput): string {
  switch (input.kind) {
    case "option":
      return `choose ${input.index}: ${input.label}`;
    case "button":
      return `press [${input.label}]${input.afterMs === undefined ? "" : ` after ${input.afterMs / 1000} s`}`;
    case "text":
      return `type ${JSON.stringify(input.text)}`;
    case "image":
      return "give an image";
    case "wait":
      return `wait until ${input.untilMs / 1000} s`;
    case "press":
      return `press permanent [${input.label}]`;
  }
}
