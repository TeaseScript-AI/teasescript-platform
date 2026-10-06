/**
 * Explores packages headlessly: plays each package in the real runtime through every branch it can reach within a
 * budget, with a directed search toward conditions left one way, and reports crashes, line coverage by reach label, and
 * loops the player cannot leave. The search is described in `src/explorer-search.ts`.
 *
 * Usage: node tools/explore.ts [--budget-seconds N] [--max-states N] [--seed N] [--workers 1|2] <unit-dir>... --out <dir>
 *        node tools/explore.ts --replay <out>/<unit>.json (--crash N | --trap N | --way N | --error)
 *
 * Each unit folder is a package with `main.tease`, read as the Player reads it. The explorer writes `<out>/<unit>.json`
 * per unit and `<out>/summary.md` over the units of the run. Defaults: 60 seconds and 20000 states per unit, seed 1,
 * one worker; two workers explore two units at a time in separate processes.
 *
 * Every crash, trap, and way directed search reached has the input list from the start that reaches it (with the
 * seeded start, if any), and so does the first input whose runtime operation threw (an explorer or runtime problem,
 * not a script failure). `--replay` plays it again with the seed of the run, prints the transcript, and for a crash or
 * error exits 0 only when the same failure or error comes back. Each report also has a compact `catalog` block.
 * Needs the repository build (`npm run build:typescript` in the repository root).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";
import { loadRepositoryPackageScanner } from "../src/compile-check.ts";
import type { PlanDiagnostic } from "../src/explorer-analysis.ts";
import { explore, type ExploreResult } from "../src/explorer-search.ts";
import {
  EPOCH_MS,
  loadEngine,
  replay,
  type Engine,
  type ExplorerInput,
  type Setup,
  type StoredValue,
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
      way: { type: "string" },
      "no-summary": { type: "boolean", default: false },
    },
  });
  if (values.replay !== undefined) {
    process.exitCode = await replayCommand(values.replay, {
      crash: values.crash,
      trap: values.trap,
      way: values.way,
      error: values.error,
    });
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
        "       node tools/explore.ts --replay <out>/<unit>.json (--crash N | --trap N | --way N | --error)\n",
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
      const report = {
        ...header,
        catalog: catalogBlock(header, result),
        ...(result === null ? {} : withReplayCommands(result, file)),
      };
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
  /** Every diagnostic with its source offsets, for the constant conditions the compiler proves. */
  diagnostics: PlanDiagnostic[];
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
  const diagnostics = records(compiled.diagnostics).map((entry) => {
    const span = fields(entry.span);
    return {
      path: text(entry.path),
      start: count(fields(span.start).offset),
      end: count(fields(span.end).offset),
      code: text(entry.code),
      message: text(entry.message),
    };
  });
  return {
    sources: folder.sources,
    plan: isRecord(compiled.plan) ? compiled.plan : null,
    errors,
    diagnostics,
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
      diagnostics: unit.diagnostics,
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
    directed: {
      ...result.directed,
      ways: result.directed.ways.map((way, index) => ({ ...way, replay: command("way", index) })),
    },
    crashes: result.crashes.map((crash, index) => ({ ...crash, replay: command("crash", index) })),
    traps: result.traps.map((trap, index) => ({ ...trap, replay: command("trap", index) })),
  };
}

/**
 * The compact view of a unit that the importer catalog shows in its own column: coverage by play, the coverable lines
 * by reach label, crashes that play reaches (with the first) and how many more only seeded state reaches, traps,
 * completed paths, why the search stopped, and what was explored with what.
 */
function catalogBlock(header: ReportHeader, result: ExploreResult | null) {
  // A crash that only seeded state reaches may need state no player makes, such as a value of another type.
  const crashes = (result?.crashes ?? []).filter((crash) => !crash.seeded);
  const first = crashes[0];
  const traps = result?.traps ?? [];
  return {
    compiled: result !== null,
    coverage: result?.coverage.percent ?? null,
    reach: result?.coverage.reach ?? null,
    crashes: {
      count: crashes.length,
      seeded: (result?.crashes ?? []).filter((crash) => crash.seeded).length,
      first:
        first === undefined
          ? null
          : {
              code: first.code,
              path: first.path,
              line: first.line,
              column: first.column,
              endLine: first.endLine,
              endColumn: first.endColumn,
            },
    },
    traps: { count: traps.length, first: traps[0]?.locations[0] ?? null },
    completed: result?.endStates.completed ?? 0,
    stoppedBy: result?.search.stoppedBy ?? null,
    converter: header.converter,
    explorer: header.explorer,
    contentHash: header.contentHash,
  };
}

function oneLine(header: ReportHeader, result: ExploreResult | null): string {
  if (result === null) return `does not compile (${header.compile.errors.length} errors)`;
  const { coverage, search, endStates, crashes, traps, directed } = result;
  return (
    `${coverage.percent}% of ${coverage.coverableLines} lines, ${search.states} states (${search.stoppedBy}), ` +
    `${crashes.length} crashes, ${traps.length} traps, ` +
    `${endStates.completed} completed / ${endStates.failed} failed / ${endStates.stuck} stuck / ${endStates.open} open, ` +
    `directed ${directed.reached.play} play + ${directed.reached.seeded} seeded of ${directed.targets}`
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
          `${text(crash.message)} (${count(crash.states)} states, ${records(crash.inputs).length} inputs` +
          `${crash.seeded === true ? ", needs seeded state" : ""}; \`${text(crash.replay)}\`)`,
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
    const reach = fields(coverage.reach);
    lines.push(
      `- Lines: ${count(reach.play)} play, ${count(reach.seeded)} seeded, ${count(reach.unreachable)} unreachable, ` +
        `${count(reach.unknown)} unknown`,
    );
    const directed = fields(report.directed);
    const reached = fields(directed.reached);
    const bySource = Object.entries(fields(directed.bySource))
      .filter(([, value]) => count(fields(value).targets) > 0)
      .map(
        ([kind, value]) =>
          `${kind} ${count(fields(value).reached)}/${count(fields(value).targets)}`,
      )
      .join(", ");
    lines.push(
      `- Directed search: ${count(reached.play)} play and ${count(reached.seeded)} seeded of ` +
        `${count(directed.targets)} ways left one way${bySource === "" ? "" : ` (${bySource})`}; ` +
        `${records(coverage.unvisitedBranches).length} still missed by play`,
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

/** A stored value read back from a report: a scalar or a runtime composite; undefined when malformed. */
function parseStored(value: unknown): StoredValue | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    isRecord(value)
    ? value
    : undefined;
}

/** A seeded start read back from a report: undefined for none (a play start), null when malformed. */
function parseSetup(value: unknown): Setup | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.storage)) return null;
  const storage: { key: string; value: StoredValue }[] = [];
  for (const entry of value.storage) {
    const stored = isRecord(entry) ? parseStored(entry.value) : undefined;
    if (!isRecord(entry) || typeof entry.key !== "string" || stored === undefined) return null;
    storage.push({ key: entry.key, value: stored });
  }
  return {
    storage,
    wallClockMs: typeof value.wallClockMs === "number" ? value.wallClockMs : EPOCH_MS,
  };
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
    case "form": {
      if (value.action !== "submit" && value.action !== "cancel") return null;
      if (value.fields === undefined) return { kind: "form", action: value.action };
      if (!isRecord(value.fields)) return null;
      const formFields: Record<string, number | string> = {};
      for (const [id, field] of Object.entries(value.fields)) {
        if (typeof field !== "number" && typeof field !== "string") return null;
        formFields[id] = field;
      }
      return { kind: "form", action: value.action, fields: formFields };
    }
    case "storage": {
      const stored = value.value === null ? null : parseStored(value.value);
      return typeof value.key === "string" && stored !== undefined
        ? { kind: "storage", key: value.key, value: stored }
        : null;
    }
    case "clock":
      return typeof value.wallClockMs === "number"
        ? { kind: "clock", wallClockMs: value.wallClockMs }
        : null;
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

/** Which repro of a report to replay: one crash, trap, or reached way by index, or the first operation that threw. */
interface ReplayChoice {
  crash: string | undefined;
  trap: string | undefined;
  way: string | undefined;
  error: boolean;
}

async function replayCommand(file: string, choice: ReplayChoice): Promise<number> {
  const { crash, trap, way, error } = choice;
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  const report = fields(value);
  const index = Number(crash ?? trap ?? way);
  const thrown = fields(report.search).engineErrors;
  const target =
    crash !== undefined
      ? records(report.crashes)[index]
      : trap !== undefined
        ? records(report.traps)[index]
        : way !== undefined
          ? records(fields(report.directed).ways)[index]
          : error && isRecord(fields(thrown).first)
            ? fields(fields(thrown).first)
            : undefined;
  if (
    [crash !== undefined, trap !== undefined, way !== undefined, error].filter(Boolean).length !==
      1 ||
    target === undefined
  ) {
    process.stderr.write(
      "Name one existing --crash N, --trap N, --way N, or --error of the report.\n",
    );
    return 2;
  }
  // A reached way keeps its repro apart; a crash or trap has its inputs and setup at the top.
  const repro = isRecord(target.repro) ? target.repro : target;
  const inputs = parseInputs(repro.inputs);
  const setup = parseSetup(repro.setup);
  if (
    inputs === null ||
    setup === null ||
    typeof report.seed !== "number" ||
    typeof report.dir !== "string"
  ) {
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
  if (setup !== undefined)
    process.stdout.write(
      `Seeded start: wall clock ${new Date(setup.wallClockMs).toISOString()}, storage ${JSON.stringify(setup.storage)}\n`,
    );
  const replayed = replay(engine, unit.plan, report.seed, inputs, setup);
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
    case "form":
      return input.action === "cancel"
        ? "cancel the form"
        : `submit the form${input.fields === undefined ? "" : ` with ${JSON.stringify(input.fields)}`}`;
    case "storage":
      return `(seeded) store ${JSON.stringify(input.value)} as ${JSON.stringify(input.key)}`;
    case "clock":
      return `(seeded) continue at ${new Date(input.wallClockMs).toISOString()}`;
    case "wait":
      return `wait until ${input.untilMs / 1000} s`;
    case "press":
      return `press permanent [${input.label}]`;
  }
}
