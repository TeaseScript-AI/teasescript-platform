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

/** What identifies a unit's report, and its compilation; the report of a compiled unit adds an {@link ExploreResult}. */
interface ReportHeader {
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
    const groups = [
      dirs.filter((_, index) => index % 2 === 0),
      dirs.filter((_, index) => index % 2 === 1),
    ];
    const codes = await Promise.all(
      groups.map(
        (group) =>
          new Promise<number>((resolve) =>
            spawn(process.execPath, [SELF, ...flags, ...group], { stdio: "inherit" }).on(
              "close",
              (code) => resolve(code ?? 1),
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
      const settings = { budgetSeconds, maxStates, seed, explorer };
      const { header, result } = await exploreUnit(engine, scan, dir, settings);
      const file = path.join(out, `${header.unit}.json`);
      const report = { ...header, ...(result === null ? {} : withReplayCommands(result, file)) };
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
      const seconds = Math.round((performance.now() - started) / 1000);
      process.stderr.write(`  ${oneLine(header, result)} (${seconds} s)\n`);
    }
  }
  if (!values["no-summary"]) {
    const reports = await Promise.all(
      names.map(async (name) =>
        fields(JSON.parse(await readFile(path.join(out, `${name}.json`), "utf8"))),
      ),
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
  const compiled = engine.call("compileProject", folder.sources, {
    builtins: [],
    images: folder.images,
  });
  const errors = records(compiled.diagnostics)
    .filter((entry) => entry.severity === "error")
    .map((entry) => {
      const span = isRecord(entry.span) && isRecord(entry.span.start) ? entry.span.start : {};
      const line = typeof span.line === "number" ? span.line + 1 : 0;
      return `${String(entry.path ?? "")}:${line} ${String(entry.code ?? "")} ${String(entry.message ?? "")}`;
    });
  return {
    sources: folder.sources,
    plan: isRecord(compiled.plan) ? compiled.plan : null,
    errors,
    contentHash: packageContentHash(folder.sources),
  };
}

async function exploreUnit(
  engine: Engine,
  scan: Scanner,
  dir: string,
  settings: { budgetSeconds: number; maxStates: number; seed: number; explorer: string },
): Promise<{ header: ReportHeader; result: ExploreResult | null }> {
  const unit = await loadUnit(engine, scan, dir);
  const header: ReportHeader = {
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
  if (unit.plan === null) return { header, result: null };
  return {
    header,
    result: explore(engine, unit.plan, {
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
    return execFileSync(
      "git",
      ["-C", path.dirname(SELF), "describe", "--always", "--dirty", "--abbrev=8"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "unknown";
  }
}

/** The result with the command that replays each crash, trap, and runtime operation that threw. */
function withReplayCommands(result: ExploreResult, file: string) {
  const command = (flag: string, index?: number) =>
    `node tools/explore.ts --replay ${file} --${flag}${index === undefined ? "" : ` ${index}`}`;
  const { engineErrors } = result.search;
  return {
    ...result,
    search: {
      ...result.search,
      engineErrors: {
        ...engineErrors,
        first:
          engineErrors.first === null ? null : { ...engineErrors.first, replay: command("error") },
      },
    },
    crashes: result.crashes.map((crash, index) => ({ ...crash, replay: command("crash", index) })),
    traps: result.traps.map((trap, index) => ({ ...trap, replay: command("trap", index) })),
  };
}

function oneLine(header: ReportHeader, result: ExploreResult | null): string {
  if (result === null) return `does not compile (${header.compile.errors.length} errors)`;
  const { coverage, search, endStates, crashes, traps } = result;
  return (
    `${coverage.percent}% of ${coverage.coverableLines} lines, ${search.states} states (${search.stoppedBy}), ` +
    `${crashes.length} crashes, ${traps.length} traps, ` +
    `${endStates.completed} completed / ${endStates.failed} failed / ${endStates.stuck} stuck / ${endStates.open} open`
  );
}

/*
 * Readers of a report read back from its file, which is external data by then: a missing or malformed field reads as
 * empty, as `parsePlayCheck` reads Player checks. The input lists that drive a replay are validated strictly instead.
 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function fields(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function summary(reports: readonly Readonly<Record<string, unknown>>[], out: string): string {
  const first = fields(reports[0]);
  const lines = [
    "# Explorer summary",
    "",
    `Explorer \`${text(first.explorer)}\`, seed ${count(first.seed)}, budget ${count(first.budgetSeconds)} s and ` +
      `${count(first.maxStates)} states per unit. Reports: \`${out}/<unit>.json\`.`,
    "",
    "| Unit | Coverage | States | Stopped by | Crashes | Traps | Completed | Failed | Stuck | Open | Time |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const report of reports) {
    if (fields(report.compile).ok !== true) {
      lines.push(`| ${text(report.unit)} | does not compile | | | | | | | | | |`);
      continue;
    }
    const coverage = fields(report.coverage);
    const search = fields(report.search);
    const endStates = fields(report.endStates);
    lines.push(
      `| ${text(report.unit)} | ${count(coverage.percent)}% of ${count(coverage.coverableLines)} lines | ` +
        `${count(search.states)} | ${text(search.stoppedBy)} | ${records(report.crashes).length} | ` +
        `${records(report.traps).length} | ${count(endStates.completed)} | ${count(endStates.failed)} | ` +
        `${count(endStates.stuck)} | ${count(endStates.open)} | ${Math.round(count(search.elapsedMs) / 1000)} s |`,
    );
  }
  for (const report of reports) {
    lines.push("", `## ${text(report.unit)}`, "");
    const compile = fields(report.compile);
    if (compile.ok !== true) {
      lines.push(
        ...texts(compile.errors)
          .slice(0, 5)
          .map((error) => `- \`${error}\``),
      );
      continue;
    }
    for (const crash of records(report.crashes)) {
      lines.push(
        `- Crash \`${text(crash.code)}\` at \`${text(crash.path)}:${count(crash.line)}:${count(crash.column)}\`: ` +
          `${text(crash.message)} (${count(crash.states)} states, ${records(crash.inputs).length} inputs; ` +
          `\`${text(crash.replay)}\`)`,
      );
    }
    for (const trap of records(report.traps)) {
      const samples = texts(trap.sampleTexts)
        .slice(0, 2)
        .map((sample) => `"${sample}"`);
      const locations = texts(trap.locations)
        .slice(0, 3)
        .map((at) => `\`${at}\``)
        .join(", ");
      lines.push(
        `- Trap (${text(trap.kind)}) at ${locations || "no prompt"}: ${count(trap.states)} states, ` +
          `${count(trap.feederStates)} leading in; ${[...samples, ...texts(trap.samplePrompts).slice(0, 2)].join(" ")}`,
      );
    }
    const coverage = fields(report.coverage);
    const files = records(coverage.files)
      .filter((file) => count(file.percent) < 100)
      .sort((left, right) => count(left.percent) - count(right.percent))
      .slice(0, 5);
    if (files.length > 0) {
      lines.push(
        `- Least covered: ${files
          .map(
            (file) =>
              `\`${text(file.path)}\` ${count(file.percent)}% (${count(file.visitedLines)}/${count(file.coverableLines)})`,
          )
          .join(", ")}`,
      );
    }
    lines.push(
      `- Branches reached but left only one way: ${records(coverage.unvisitedBranches).length}`,
    );
    const engineErrors = fields(fields(report.search).engineErrors);
    const firstError = fields(engineErrors.first);
    if (count(engineErrors.count) > 0)
      lines.push(
        `- Runtime operations that threw: ${count(engineErrors.count)}, first: ${text(firstError.message)} ` +
          `(\`${text(firstError.replay)}\`)`,
      );
  }
  return `${lines.join("\n")}\n`;
}

/** An input list read back from a report, or null when an input is malformed. */
function parseInputs(value: unknown): ExplorerInput[] | null {
  if (!Array.isArray(value)) return null;
  const inputs: ExplorerInput[] = [];
  for (const item of value) {
    const input = parseInput(item);
    if (input === null) return null;
    inputs.push(input);
  }
  return inputs;
}

function parseInput(value: unknown): ExplorerInput | null {
  if (!isRecord(value)) return null;
  const label = text(value.label);
  switch (value.kind) {
    case "option":
      return typeof value.index === "number" ? { kind: "option", index: value.index, label } : null;
    case "button":
      if (value.afterMs === undefined) return { kind: "button", label };
      return typeof value.afterMs === "number"
        ? { kind: "button", label, afterMs: value.afterMs }
        : null;
    case "text":
      return typeof value.text === "string" ? { kind: "text", text: value.text } : null;
    case "image":
      return { kind: "image" };
    case "wait":
      return typeof value.untilMs === "number" ? { kind: "wait", untilMs: value.untilMs } : null;
    case "press":
      return typeof value.buttonId === "number"
        ? { kind: "press", buttonId: value.buttonId, label }
        : null;
    default:
      return null;
  }
}

async function replayCommand(
  file: string,
  crash: string | undefined,
  trap: string | undefined,
  error: boolean,
): Promise<number> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  const report = fields(value);
  const index = Number(crash ?? trap);
  const thrown = fields(report.search).engineErrors;
  const target =
    crash !== undefined
      ? records(report.crashes)[index]
      : trap !== undefined
        ? records(report.traps)[index]
        : error && isRecord(fields(thrown).first)
          ? fields(fields(thrown).first)
          : undefined;
  if (
    [crash !== undefined, trap !== undefined, error].filter(Boolean).length !== 1 ||
    target === undefined
  ) {
    process.stderr.write("Name one existing --crash N, --trap N, or --error of the report.\n");
    return 2;
  }
  const inputs = parseInputs(target.inputs);
  if (inputs === null || typeof report.seed !== "number" || typeof report.dir !== "string") {
    process.stderr.write(
      "The report has no valid seed, unit folder, or input list for this replay.\n",
    );
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
  const replayed = replay(engine, unit.plan, report.seed, inputs);
  const { steps, failure } = replayed;
  for (const step of steps) {
    if (step.input !== null) process.stdout.write(`> ${describeInput(step.input)}\n`);
    for (const said of step.texts) process.stdout.write(`  ${said}\n`);
    if (step.prompt !== "") process.stdout.write(`  ${step.prompt}\n`);
  }
  const status = steps.at(-1)?.status ?? "";
  process.stdout.write(
    `Final state: ${status}${failure === null ? "" : ` ${failure.code} at ${failure.path}:${failure.line}:${failure.column}: ${failure.message}`}\n`,
  );
  if (replayed.error !== null) process.stdout.write(`Runtime operation threw: ${replayed.error}\n`);
  if (error) {
    const reproduced = replayed.error === text(target.message);
    process.stdout.write(reproduced ? "Reproduced.\n" : "Not reproduced.\n");
    return reproduced ? 0 : 1;
  }
  if (crash === undefined) return 0;
  const reproduced =
    failure !== null &&
    failure.code === target.code &&
    failure.path === target.path &&
    failure.line === target.line &&
    failure.column === target.column;
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
