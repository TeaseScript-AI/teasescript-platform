/**
 * Explores packages headlessly: plays each package in the real runtime through every branch it can reach within a
 * budget, with a directed search toward conditions left one way, and reports crashes, line coverage by reach label, and
 * loops the player cannot leave. The search is described in `src/explorer-search.ts`.
 *
 * Usage: node tools/explore.ts [--budget-seconds N] [--max-states N] [--seed N] [--workers 1|2]
 *          [--corpus <dir> [--rounds N]] <unit-dir>... --out <dir>
 *        node tools/explore.ts --replay <out>/<unit>.json (--crash N | --trap N | --way N | --error)
 *
 * Each unit folder is a package with `main.tease`, read as the Player reads it. The explorer writes `<out>/<unit>.json`
 * per unit and `<out>/summary.md` over the units of the run. Defaults: 60 seconds and 20000 states per unit, seed 1,
 * one worker; two workers explore two units at a time in separate processes.
 *
 * With `--corpus`, a run starts where earlier runs ended: it replays `<dir>/<unit>.json` first and writes it back
 * minimized, with whether the run was exhausted; a unit exhausted with the same seed and `.tease` content is skipped.
 * `--rounds N` explores the units N times, with the budget doubled each round, and each round only the units not
 * exhausted yet.
 *
 * Every crash, trap, and way directed search reached has the path from the start that reaches it (with its earlier
 * sessions and start clock, if any), and so does the first input whose runtime operation threw (an explorer or
 * runtime problem, not a script failure). `--replay` plays it again with the seed of the run, prints the transcript, and for a crash or
 * error exits 0 only when the same failure or error comes back. The report of a unit that compiles also has a compact
 * `catalog` block for the importer catalog's Explorer column.
 * Needs the repository build (`npm run build:typescript` in the repository root).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";
import { loadRepositoryPackageScanner } from "../src/compile-check.ts";
import type { PlanDiagnostic } from "../src/explorer-analysis.ts";
import { explore, type CorpusEntry, type ExploreResult } from "../src/explorer-search.ts";
import {
  EPOCH_MS,
  loadEngine,
  replay,
  type Engine,
  type ExplorerInput,
  type SessionPath,
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
      corpus: { type: "string" },
      rounds: { type: "string", default: "1" },
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
  const rounds = Number(values.rounds);
  if (
    values.out === undefined ||
    positionals.length === 0 ||
    !(budgetSeconds > 0) ||
    !Number.isSafeInteger(maxStates) ||
    maxStates < 1 ||
    !Number.isSafeInteger(seed) ||
    (workers !== 1 && workers !== 2) ||
    !Number.isSafeInteger(rounds) ||
    rounds < 1 ||
    (rounds > 1 && values.corpus === undefined)
  ) {
    process.stderr.write(
      "Usage: node tools/explore.ts [--budget-seconds N] [--max-states N] [--seed N] [--workers 1|2]\n" +
        "         [--corpus <dir> [--rounds N]] <unit-dir>... --out <dir>\n" +
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
  const corpus = values.corpus === undefined ? null : path.resolve(values.corpus);
  if (corpus !== null) await mkdir(corpus, { recursive: true });
  let remaining = dirs;
  for (let round = 1; round <= rounds && remaining.length > 0; round += 1) {
    const budget = budgetSeconds * 2 ** (round - 1);
    if (rounds > 1)
      process.stderr.write(`Round ${round}: ${remaining.length} units, ${budget} s each\n`);
    process.exitCode =
      (await exploreUnits(
        remaining,
        { budgetSeconds: budget, maxStates, seed, corpus },
        out,
        workers,
      )) || process.exitCode;
    if (corpus === null) break;
    // A unit goes on while its corpus says it was not exhausted; one that did not compile has no corpus.
    const going = await Promise.all(
      remaining.map(
        async (dir) => (await readCorpus(corpusFile(corpus, dir)))?.exhausted === false,
      ),
    );
    remaining = remaining.filter((_, index) => going[index]);
  }
  if (!values["no-summary"]) {
    const reports = await Promise.all(
      names.map(async (name) => {
        const file = path.join(out, `${name}.json`);
        return fields(await readFile(file, "utf8").then(JSON.parse, () => ({ unit: name })));
      }),
    );
    await writeFile(path.join(out, "summary.md"), summary(reports, out));
    process.stderr.write(`Wrote ${path.join(out, "summary.md")}.\n`);
  }
}

interface RunSettings {
  budgetSeconds: number;
  maxStates: number;
  seed: number;
  /** The corpus folder, or null without one. */
  corpus: string | null;
}

/** Explores units with one budget, in this process or in two; returns 1 when a process failed. */
async function exploreUnits(
  dirs: readonly string[],
  settings: RunSettings,
  out: string,
  workers: number,
): Promise<number> {
  const { budgetSeconds, maxStates, seed, corpus } = settings;
  if (workers === 2 && dirs.length > 1) {
    const flags = ["--budget-seconds", String(budgetSeconds), "--max-states", String(maxStates)];
    flags.push("--seed", String(seed), "--out", out, "--no-summary");
    if (corpus !== null) flags.push("--corpus", corpus);
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
    return codes.some((code) => code !== 0) ? 1 : 0;
  }
  const engine = await loadEngine();
  const scan = await loadRepositoryPackageScanner();
  const explorer = explorerCommit();
  for (const dir of dirs) {
    const started = performance.now();
    process.stderr.write(`Exploring ${path.basename(dir)}...\n`);
    const stored = corpus === null ? null : await readCorpus(corpusFile(corpus, dir));
    const explored = await exploreUnit(engine, scan, dir, { ...settings, explorer }, stored);
    if (explored === null) {
      process.stderr.write("  exhausted in an earlier run with this content and seed: skipped\n");
      continue;
    }
    const { header, result } = explored;
    const file = path.join(out, `${header.unit}.json`);
    // The report has the corpus counts and file; the entries are in that file only.
    let corpusReport: Record<string, unknown> | undefined;
    if (corpus !== null && result?.corpus != null) {
      const { entries, ...counts } = result.corpus;
      const written = corpusFile(corpus, dir);
      const exhausted = result.search.stoppedBy === "exhausted";
      const bytes = await writeCorpus(written, header, exhausted, entries);
      corpusReport = { ...counts, file: written, bytes, exhausted };
    }
    const report = {
      ...header,
      ...(result === null
        ? {}
        : {
            catalog: catalogBlock(result),
            ...withReplayCommands(result, file),
            corpus: corpusReport,
          }),
    };
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    const seconds = Math.round((performance.now() - started) / 1000);
    process.stderr.write(`  ${oneLine(header, result)} (${seconds} s)\n`);
  }
  return 0;
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

/** Explores one unit from its stored corpus, if any; null when that corpus says this content was exhausted. */
async function exploreUnit(
  engine: Engine,
  scan: Scanner,
  dir: string,
  settings: RunSettings & { explorer: string },
  stored: StoredCorpus | null,
): Promise<{ header: ReportHeader; result: ExploreResult | null } | null> {
  const unit = await loadUnit(engine, scan, dir);
  if (
    stored?.exhausted === true &&
    stored.contentHash === unit.contentHash &&
    stored.seed === settings.seed
  )
    return null;
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
      ...(settings.corpus === null ? {} : { corpus: stored?.entries ?? [] }),
    }),
  };
}

/**
 * A unit's corpus as stored in `<corpus>/<unit>.json`: the content and seed of the run that wrote it, whether that run
 * was exhausted, and the entries.
 */
interface StoredCorpus {
  contentHash: string;
  seed: number;
  exhausted: boolean;
  entries: CorpusEntry[];
}

function corpusFile(corpus: string, dir: string): string {
  return path.join(corpus, `${path.basename(dir)}.json`);
}

/**
 * Reads a corpus file, which is external data by then: null when there is none or it is no JSON (with a warning, and the
 * run starts without it); entries that do not parse are left out with a warning.
 */
async function readCorpus(file: string): Promise<StoredCorpus | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    process.stderr.write(
      `Warning: ${file} is not a corpus (${String(error)}); starting without it.\n`,
    );
    return null;
  }
  const stored = fields(value);
  const entries: CorpusEntry[] = [];
  const items: unknown[] = Array.isArray(stored.entries) ? stored.entries : [];
  for (const item of items) {
    const entry = parseCorpusEntry(item);
    if (entry !== null) entries.push(entry);
  }
  if (entries.length < items.length)
    process.stderr.write(
      `Warning: ${file}: ${items.length - entries.length} malformed entries left out.\n`,
    );
  return {
    contentHash: text(stored.contentHash),
    seed: count(stored.seed),
    exhausted: stored.exhausted === true,
    entries,
  };
}

function parseCorpusEntry(value: unknown): CorpusEntry | null {
  if (!isRecord(value) || typeof value.seed !== "number" || !Number.isSafeInteger(value.seed))
    return null;
  const { reason } = value;
  if (reason !== "coverage" && reason !== "crash" && reason !== "trap") return null;
  const inputs = parseInputs(value.inputs);
  const earlier = parseEarlier(value.earlier);
  if (inputs === null || earlier === null) return null;
  if (value.wallClockMs !== undefined && typeof value.wallClockMs !== "number") return null;
  return {
    seed: value.seed,
    reason,
    ...(earlier.length === 0 ? {} : { earlier }),
    ...(typeof value.wallClockMs === "number" ? { wallClockMs: value.wallClockMs } : {}),
    inputs,
  };
}

/** Writes a unit's corpus, one entry per line, through a temporary file; returns its size in bytes. */
async function writeCorpus(
  file: string,
  header: ReportHeader,
  exhausted: boolean,
  entries: readonly CorpusEntry[],
): Promise<number> {
  const { unit, contentHash, explorer, seed } = header;
  const head = JSON.stringify({
    unit,
    contentHash,
    explorer,
    seed,
    exhausted,
    writtenAt: new Date().toISOString(),
  });
  const body = `${head.slice(0, -1)},"entries":[\n${entries.map((entry) => JSON.stringify(entry)).join(",\n")}\n]}\n`;
  await writeFile(`${file}.tmp`, body);
  await rename(`${file}.tmp`, file);
  return Buffer.byteLength(body);
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
 * The compact view of an explored unit that the importer catalog shows in its Explorer column, in the shape the
 * catalog reads: coverage by play, crashes (also those on a path that set the clock), traps, the first of each (a play
 * crash when there is one), and the coverable lines by reach label. A unit that does not compile has no block; the
 * catalog reads the rest of the report.
 */
function catalogBlock(result: ExploreResult) {
  const crash = result.crashes.find((entry) => !entry.clock) ?? result.crashes[0];
  const location = result.traps.flatMap((trap) => trap.locations)[0];
  return {
    coveragePercent: result.coverage.percent,
    crashes: result.crashes.length,
    traps: result.traps.length,
    firstCrash:
      crash === undefined
        ? null
        : { code: crash.code, path: crash.path, line: crash.line, message: crash.message },
    firstTrap: location === undefined ? null : { location },
    reach: result.coverage.reach,
  };
}

function oneLine(header: ReportHeader, result: ExploreResult | null): string {
  if (result === null) return `does not compile (${header.compile.errors.length} errors)`;
  const { coverage, search, endStates, crashes, traps, directed, corpus } = result;
  const fromCorpus =
    corpus === null || corpus.loaded === 0
      ? ""
      : `${corpus.coverageAtStart.percent}% from ${corpus.replayed} of ${corpus.loaded} corpus entries ` +
        `(${corpus.stale} stale, ${corpus.replayMs} ms), then `;
  return (
    `${fromCorpus}${coverage.percent}% of ${coverage.coverableLines} lines, ${search.states} states (${search.stoppedBy}), ` +
    `${crashes.length} crashes, ${traps.length} traps, ` +
    `${endStates.completed} completed / ${endStates.failed} failed / ${endStates.stuck} stuck / ${endStates.open} open, ` +
    `directed ${directed.reached.play} play + ${directed.reached.clock} clock of ${directed.targets}, ` +
    `${search.sessions} sessions (longest chain ${directed.multiSession.longestChain})` +
    (corpus === null ? "" : `, ${corpus.written} corpus entries kept`)
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
    "| Unit | Coverage | From corpus | States | Stopped by | Crashes | Traps | Completed | Failed | Stuck | Open | Time |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const report of reports) {
    if (report.compile === undefined) {
      lines.push(
        `| ${text(report.unit)} | no report: exhausted in an earlier run | | | | | | | | | | |`,
      );
      continue;
    }
    if (fields(report.compile).ok !== true) {
      lines.push(`| ${text(report.unit)} | does not compile | | | | | | | | | | |`);
      continue;
    }
    const coverage = fields(report.coverage);
    const search = fields(report.search);
    const endStates = fields(report.endStates);
    const corpus = fields(report.corpus);
    const fromCorpus = isRecord(report.corpus)
      ? `${count(fields(corpus.coverageAtStart).percent)}% (${count(corpus.loaded)} entries, ` +
        `${count(corpus.stale)} stale; ${count(corpus.written)} kept)`
      : "";
    lines.push(
      `| ${text(report.unit)} | ${count(coverage.percent)}% of ${count(coverage.coverableLines)} lines | ${fromCorpus} | ` +
        `${count(search.states)} | ${text(search.stoppedBy)} | ${records(report.crashes).length} | ` +
        `${records(report.traps).length} | ${count(endStates.completed)} | ${count(endStates.failed)} | ` +
        `${count(endStates.stuck)} | ${count(endStates.open)} | ${Math.round(count(search.elapsedMs) / 1000)} s |`,
    );
  }
  for (const report of reports) {
    if (report.compile === undefined) continue;
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
          `${crash.clock === true ? ", with the clock set" : ""}${records(crash.earlier).length > 0 ? `, in session ${records(crash.earlier).length + 1}` : ""}; \`${text(crash.replay)}\`)`,
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
      `- Lines: ${count(reach.play)} play, ${count(reach.clock)} clock, ${count(reach.unreachable)} unreachable, ` +
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
      `- Directed search: ${count(reached.play)} play and ${count(reached.clock)} clock of ` +
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

/** The earlier sessions of a path read back from a report: none when absent, null when malformed. */
function parseEarlier(value: unknown): SessionPath[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const sessions: SessionPath[] = [];
  for (const entry of value) {
    const inputs = isRecord(entry) ? parseInputs(entry.inputs) : null;
    if (!isRecord(entry) || inputs === null) return null;
    if (entry.wallClockMs !== undefined && typeof entry.wallClockMs !== "number") return null;
    sessions.push(
      typeof entry.wallClockMs === "number"
        ? { inputs, wallClockMs: entry.wallClockMs }
        : { inputs },
    );
  }
  return sessions;
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
  // A reached way keeps its path apart; a crash or trap has its inputs, earlier sessions, and clock at the top.
  const repro = isRecord(target.repro) ? target.repro : target;
  const inputs = parseInputs(repro.inputs);
  const earlier = parseEarlier(repro.earlier);
  const wallClockMs = typeof repro.wallClockMs === "number" ? repro.wallClockMs : EPOCH_MS;
  if (
    inputs === null ||
    earlier === null ||
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
  earlier.forEach((session, index) =>
    process.stdout.write(
      `Session ${index + 1}: ${session.inputs.map(describeInput).join("; ") || "(no input)"}, then its storage starts the next\n`,
    ),
  );
  if (wallClockMs !== EPOCH_MS)
    process.stdout.write(`The last session starts at ${new Date(wallClockMs).toISOString()}\n`);
  const replayed = replay(engine, unit.plan, report.seed, inputs, { earlier, wallClockMs });
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
    case "clock":
      return `continue at ${new Date(input.wallClockMs).toISOString()}`;
    case "wait":
      return `wait until ${input.untilMs / 1000} s`;
    case "press":
      return `press permanent [${input.label}]`;
  }
}
