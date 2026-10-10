/**
 * Explores packages headlessly: plays each package in the real runtime through every branch it can reach within a
 * budget, with a directed search toward conditions left one way, and reports crashes, line coverage by reach label, and
 * loops the player cannot leave. The search is described in `src/explorer-search.ts`.
 *
 * Usage: node tools/explore.ts [--budget-seconds N] [--budget-ops N] [--max-states N] [--store-mb N] [--seed N]
 *          [--workers 1|2] [--until-stalled]
 *          [--corpus <dir> [--rounds N]] [--[no-]cells] [--[no-]later] [--[no-]compared-answers]
 *          [--[no-]realign] [--[no-]progress-leads] [--[no-]conjunctive] [--[no-]guidance]
 *          [--[no-]random-choices] [--[no-]quit-anywhere] [--[no-]depth-phases] [--[no-]effect-ranking]
 *          [--[no-]follow-chains] [--[no-]stored-leads] [--[no-]large-answers] [--[no-]session-seeds] [--no-report]
 *          <unit-dir>... --out <dir>
 *        node tools/explore.ts --replay <out>/<unit>.json (--crash N | --trap N | --way N | --error)
 *
 * Each unit folder is a package with `main.tease`, read as the Player reads it. The explorer writes `<out>/<unit>.json`
 * per unit, with a playtest report for the script's creator next to it (`<out>/<unit>.report.md`, see
 * `tools/explore-report.ts`; `--no-report` leaves it out), and `<out>/summary.md` over the units of the run. Defaults: 60 seconds and 20000 states per unit, seed 1,
 * one worker; two workers explore two units at a time in separate processes. `--budget-ops N` is a work budget instead:
 * N runtime operations per unit, which makes a run's length and result deterministic unless `--budget-seconds` is also
 * given. `--until-stalled` runs each unit until it is done or stalled instead (see `ExploreOptions.untilStalled`), with
 * no state limit and a time cap of two hours unless `--max-states` or `--budget-seconds` is given; the report's
 * `search.audit` says how it ended: `complete`, `stalled`, `spiral`, or `capped`.
 *
 * Cell ranking, forward time (time goes forward as play), progress leads (progress toward a compared constant keeps its
 * lead), compared answers (typed asks are also answered with what the code compares the answer with), realignment
 * (replays go on past inputs that no longer fit, and a condition after `else` aims at its chain too), and conjunctive
 * steering (a way that needs all parts of its condition is steered to by their summed distance), and random choices
 * (the explorer also chooses other outcomes of random draws) are on by default (`--no-cells`, `--no-later`,
 * `--no-progress-leads`, `--no-compared-answers`, `--no-realign`, `--no-conjunctive`, `--no-random-choices` switch them
 * off). `--guidance` leads states toward the largest region of code not reached yet, `--depth-phases` lets play work
 * go to session numbers by their gain per operation, `--stored-leads` lets play go on with a lead from the state that
 * stored a value a condition needs, `--session-seeds` gives each later session a random seed of its own, and
 * `--large-answers` also answers typed numbers with 1,000,000, to
 * probe a script's ranges (see `src/explorer-search.ts` and the README).
 *
 * With `--corpus`, a run starts where earlier runs ended: it replays `<dir>/<unit>.json` first and writes it back
 * minimized, with whether the run was exhausted; a unit exhausted with the same seed and `.tease` content is skipped.
 * `--rounds N` explores the units N times, with the budgets doubled each round, and each round only the units not
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
import { setFlagsFromString } from "node:v8";
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
  type RandomChoice,
  type SessionPath,
} from "../src/explorer.ts";
import { packageContentHash } from "./catalog.ts";
import { playtestReport } from "./explore-report.ts";

const SELF = fileURLToPath(import.meta.url);
/** The V8 flag that sets how much the heap grows after a collection. */
const HEAP_GROWING = "--heap-growing-percent";
/** Until stalled, the default time cap per unit. */
const UNTIL_STALLED_CAP_SECONDS = 2 * 60 * 60;
/** Missed ways the summary lists per unit, by the code behind them. */
const WORKING_TOWARD_ROWS = 8;
/** Session numbers shown one by one; the later ones are shown together. */
const SESSION_ROWS = 10;
/** A chain's result, in words. */
const CHAIN_RESULTS: Readonly<Record<string, string>> = {
  reached: "reached",
  holds: "storage holds the value, the way not reached",
  queued: "still going at the end",
  limit: "stopped at the session limit",
  stopped: "stopped, no route came closer",
};

/** The search strategies a corpus records, in one order. */
const STRATEGIES = [
  "cells",
  "later",
  "comparedAnswers",
  "realign",
  "progressLeads",
  "conjunctive",
  "guidance",
  "randomChoices",
  "quitAnywhere",
  "depthPhases",
  "effectRanking",
  "followChains",
  "storedLeads",
  "largeAnswers",
  "sessionSeeds",
] as const;

/** Strategies as one text, each on or off: one a corpus does not record (from before it existed) was off. */
function strategiesKey(strategies: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(STRATEGIES.map((name) => [name, strategies[name] === true])),
  );
}

/** What identifies a unit's report, and its compilation; the report of a compiled unit adds an {@link ExploreResult}. */
interface ReportHeader {
  unit: string;
  dir: string;
  contentHash: string;
  converter: string | null;
  explorer: string;
  seed: number;
  /** The time budget, or null with only a work budget. */
  budgetSeconds: number | null;
  /** The work budget in runtime operations, or null without one. */
  budgetOps: number | null;
  maxStates: number;
  /** The search strategies of the run, each on or off, and whether it ran until it stalled. */
  strategies: Record<string, boolean>;
  untilStalled: boolean;
  exploredAt: string;
  compile: { ok: boolean; errors: string[] };
}

if (process.argv[1] === SELF) await main(process.argv.slice(2));

async function main(args: string[]): Promise<void> {
  // V8 lets its heap grow to up to four times what a collection keeps, and a long run keeps much: there, unused heap
  // was a third of the process's memory. Growing it by a fifth at a time keeps memory close to what the run holds. The
  // flag is V8's own: set only where this Node has it.
  if (execFileSync(process.execPath, ["--v8-options"], { encoding: "utf8" }).includes(HEAP_GROWING))
    setFlagsFromString(`${HEAP_GROWING}=20`);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    allowNegative: true,
    options: {
      "budget-seconds": { type: "string" },
      "budget-ops": { type: "string" },
      "max-states": { type: "string" },
      "store-mb": { type: "string" },
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
      // `--no-summary`, as `allowNegative` reads it.
      summary: { type: "boolean", default: true },
      report: { type: "boolean", default: true },
      cells: { type: "boolean", default: true },
      later: { type: "boolean", default: true },
      "compared-answers": { type: "boolean", default: true },
      realign: { type: "boolean", default: true },
      "progress-leads": { type: "boolean", default: true },
      conjunctive: { type: "boolean", default: true },
      guidance: { type: "boolean", default: false },
      "random-choices": { type: "boolean", default: true },
      "quit-anywhere": { type: "boolean", default: false },
      "depth-phases": { type: "boolean", default: false },
      "effect-ranking": { type: "boolean", default: false },
      "follow-chains": { type: "boolean", default: false },
      "stored-leads": { type: "boolean", default: false },
      "large-answers": { type: "boolean", default: false },
      "session-seeds": { type: "boolean", default: false },
      "until-stalled": { type: "boolean", default: false },
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
  const untilStalled = values["until-stalled"];
  const budgetOps = values["budget-ops"] === undefined ? null : Number(values["budget-ops"]);
  // Without a work budget the time budget is 60 s by default; with one, only a time budget given applies. Until stalled,
  // the time budget is a cap of two hours by default.
  const budgetSeconds =
    values["budget-seconds"] === undefined
      ? untilStalled
        ? UNTIL_STALLED_CAP_SECONDS
        : budgetOps === null
          ? 60
          : null
      : Number(values["budget-seconds"]);
  const maxStates =
    values["max-states"] === undefined
      ? untilStalled
        ? Number.MAX_SAFE_INTEGER
        : 20000
      : Number(values["max-states"]);
  const storeMb = values["store-mb"] === undefined ? null : Number(values["store-mb"]);
  const seed = Number(values.seed);
  const workers = Number(values.workers);
  const rounds = Number(values.rounds);
  if (
    values.out === undefined ||
    positionals.length === 0 ||
    (budgetSeconds !== null && !(budgetSeconds > 0)) ||
    (budgetOps !== null &&
      // Each round doubles it, and the last round's budget must still be a safe integer.
      (!Number.isSafeInteger(budgetOps) ||
        budgetOps < 1 ||
        !Number.isSafeInteger(budgetOps * 2 ** (rounds - 1)))) ||
    !Number.isSafeInteger(maxStates) ||
    maxStates < 1 ||
    (storeMb !== null && !(Number.isSafeInteger(storeMb) && storeMb >= 1)) ||
    !Number.isSafeInteger(seed) ||
    (workers !== 1 && workers !== 2) ||
    !Number.isSafeInteger(rounds) ||
    rounds < 1 ||
    (rounds > 1 && (values.corpus === undefined || untilStalled))
  ) {
    process.stderr.write(
      "Usage: node tools/explore.ts [--budget-seconds N] [--budget-ops N] [--max-states N] [--store-mb N] [--seed N]\n" +
        "         [--workers 1|2] [--until-stalled]\n" +
        "         [--corpus <dir> [--rounds N]] [--[no-]cells] [--[no-]later] [--[no-]compared-answers]\n" +
        "         [--[no-]realign] [--[no-]progress-leads] [--[no-]conjunctive] [--[no-]guidance]\n" +
        "         [--[no-]random-choices] [--[no-]quit-anywhere] [--[no-]depth-phases] [--[no-]effect-ranking]\n" +
        "         [--[no-]follow-chains] [--[no-]stored-leads] [--[no-]large-answers] [--[no-]session-seeds] [--no-report]\n" +
        "         <unit-dir>... --out <dir>\n" +
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
    const factor = 2 ** (round - 1);
    const budgets = {
      budgetSeconds: budgetSeconds === null ? null : budgetSeconds * factor,
      budgetOps: budgetOps === null ? null : budgetOps * factor,
    };
    if (rounds > 1)
      process.stderr.write(
        `Round ${round}: ${remaining.length} units, ${describeBudget(budgets)} each\n`,
      );
    process.exitCode =
      (await exploreUnits(
        remaining,
        {
          ...budgets,
          maxStates,
          untilStalled,
          storeMb,
          seed,
          corpus,
          report: values.report,
          strategies: {
            cells: values.cells,
            later: values.later,
            comparedAnswers: values["compared-answers"],
            realign: values.realign,
            progressLeads: values["progress-leads"],
            conjunctive: values.conjunctive,
            guidance: values.guidance,
            randomChoices: values["random-choices"],
            quitAnywhere: values["quit-anywhere"],
            depthPhases: values["depth-phases"],
            effectRanking: values["effect-ranking"],
            followChains: values["follow-chains"],
            storedLeads: values["stored-leads"],
            largeAnswers: values["large-answers"],
            sessionSeeds: values["session-seeds"],
          },
        },
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
  if (values.summary) {
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
  budgetSeconds: number | null;
  budgetOps: number | null;
  maxStates: number;
  /** Run until done or stalled, the budgets only caps. */
  untilStalled: boolean;
  /** The snapshot store's limit in MiB, or null for the default. */
  storeMb: number | null;
  seed: number;
  /** The corpus folder, or null without one. */
  corpus: string | null;
  /** Whether to write the creator's playtest report next to each unit's report. */
  report: boolean;
  /** The search strategies that can be switched off (see `ExploreOptions`). */
  strategies: {
    cells: boolean;
    later: boolean;
    comparedAnswers: boolean;
    realign: boolean;
    progressLeads: boolean;
    conjunctive: boolean;
    guidance: boolean;
    randomChoices: boolean;
    quitAnywhere: boolean;
    depthPhases: boolean;
    effectRanking: boolean;
    followChains: boolean;
    storedLeads: boolean;
    largeAnswers: boolean;
    sessionSeeds: boolean;
  };
}

/** Explores units with one budget, in this process or in two; returns 1 when a process failed. */
async function exploreUnits(
  dirs: readonly string[],
  settings: RunSettings,
  out: string,
  workers: number,
): Promise<number> {
  const {
    budgetSeconds,
    budgetOps,
    maxStates,
    untilStalled,
    storeMb,
    seed,
    corpus,
    report: playtest,
    strategies,
  } = settings;
  if (workers === 2 && dirs.length > 1) {
    const flags = [
      "--max-states",
      String(maxStates),
      "--seed",
      String(seed),
      "--out",
      out,
      "--no-summary",
    ];
    if (budgetSeconds !== null) flags.push("--budget-seconds", String(budgetSeconds));
    if (budgetOps !== null) flags.push("--budget-ops", String(budgetOps));
    if (storeMb !== null) flags.push("--store-mb", String(storeMb));
    if (untilStalled) flags.push("--until-stalled");
    if (corpus !== null) flags.push("--corpus", corpus);
    if (!playtest) flags.push("--no-report");
    for (const [name, on] of Object.entries(strategies)) {
      const flag = name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
      flags.push(on ? `--${flag}` : `--no-${flag}`);
    }
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
      const bytes = await writeCorpus(written, header, exhausted, settings.strategies, entries);
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
    const json = JSON.stringify(report, null, 2);
    await writeFile(file, `${json}\n`);
    if (playtest)
      await writeFile(path.join(out, `${header.unit}.report.md`), playtestReport(JSON.parse(json)));
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
  const compiled = engine.compileProject(folder.sources, { builtins: [], images: folder.images });
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
    stored.seed === settings.seed &&
    stored.strategies === strategiesKey(settings.strategies)
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
    budgetOps: settings.budgetOps,
    maxStates: settings.maxStates,
    strategies: Object.fromEntries(
      STRATEGIES.map((name) => [name, settings.strategies[name] === true]),
    ),
    untilStalled: settings.untilStalled,
    exploredAt: new Date().toISOString(),
    compile: { ok: unit.plan !== null, errors: unit.errors.slice(0, 20) },
  };
  if (unit.plan === null) return { header, result: null };
  return {
    header,
    result: explore(engine, unit.plan, {
      seed: settings.seed,
      budgetMs: settings.budgetSeconds === null ? Infinity : settings.budgetSeconds * 1000,
      ...(settings.budgetOps === null ? {} : { budgetOps: settings.budgetOps }),
      maxStates: settings.maxStates,
      ...(settings.untilStalled ? { untilStalled: true } : {}),
      ...(settings.storeMb === null ? {} : { storeBytes: settings.storeMb * 1024 ** 2 }),
      sources: new Map(unit.sources.map((file) => [file.path, file.source])),
      diagnostics: unit.diagnostics,
      ...(settings.corpus === null ? {} : { corpus: stored?.entries ?? [] }),
      ...settings.strategies,
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
  /** The search strategies of the run that wrote it, as JSON: an exhausted search with others may not be exhausted. */
  strategies: string;
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
    // A corpus from before strategies were recorded had them all off.
    strategies: strategiesKey(isRecord(stored.strategies) ? stored.strategies : {}),
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
  strategies: RunSettings["strategies"],
  entries: readonly CorpusEntry[],
): Promise<number> {
  const { unit, contentHash, explorer, seed } = header;
  const head = JSON.stringify({
    unit,
    contentHash,
    explorer,
    seed,
    exhausted,
    strategies,
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

/**
 * The explorer's commit: `SX_EXPLORER_COMMIT` when set, as for a copy of the sources without the repository; else what
 * `git describe` says of the sources here; else "unknown".
 */
function explorerCommit(): string {
  const given = process.env.SX_EXPLORER_COMMIT;
  if (given !== undefined && given !== "") return given;
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
  // A crash of play first, then one only play with chosen random outcomes reached, then a clock one.
  const crash =
    result.crashes.find((entry) => !entry.clock && entry.chosen !== true) ??
    result.crashes.find((entry) => !entry.clock) ??
    result.crashes[0];
  const location = result.traps.flatMap((trap) => trap.locations)[0];
  return {
    coveragePercent: result.coverage.percent,
    crashes: result.crashes.length,
    traps: result.traps.length,
    firstCrash:
      crash === undefined
        ? null
        : {
            code: crash.code,
            path: crash.path,
            line: crash.line,
            message: crash.message,
            ...(crash.chosen === true ? { chosen: true } : {}),
          },
    firstTrap: location === undefined ? null : { location },
    reach: result.coverage.reach,
  };
}

function oneLine(header: ReportHeader, result: ExploreResult | null): string {
  if (result === null) return `does not compile (${header.compile.errors.length} errors)`;
  const { coverage, search, endStates, crashes, traps, directed, corpus } = result;
  const top = search.expansionsByPrompt[0];
  const fromCorpus =
    corpus === null || corpus.loaded === 0
      ? ""
      : `${corpus.coverageAtStart.percent}% from ${corpus.replayed} of ${corpus.loaded} corpus entries ` +
        `(${corpus.stale} stale, ${corpus.replayMs} ms), then `;
  return (
    `${fromCorpus}${coverage.percent}% of ${coverage.coverableLines} lines, ${search.states} states (${search.stoppedBy}), ` +
    `${crashes.length} crashes` +
    (crashes.some((crash) => crash.chosen === true)
      ? ` (${crashes.filter((crash) => crash.chosen === true).length} only with chosen random outcomes)`
      : "") +
    `, ${traps.length} traps, ` +
    `${endStates.completed} completed / ${endStates.failed} failed / ${endStates.stuck} stuck / ${endStates.open} open, ` +
    `directed ${directed.reached.play} play + ${directed.reached.clock} clock` +
    (directed.reached.chosen === undefined ? "" : ` + ${directed.reached.chosen} chosen`) +
    ` of ${directed.targets}, ` +
    `${search.sessions} sessions (longest chain ${directed.multiSession.longestChain})` +
    (corpus === null ? "" : `, ${corpus.written} corpus entries kept`) +
    `, ${search.operations} operations, ${Math.round(search.cpuMs / 1000)} s CPU` +
    (top === undefined ? "" : `, ${top.percent}% of expansions at ${top.location} (${top.kind})`)
  );
}

/** A run's budgets in words. */
function describeBudget(budgets: {
  budgetSeconds: number | null;
  budgetOps: number | null;
}): string {
  const parts = [
    ...(budgets.budgetSeconds === null ? [] : [`${budgets.budgetSeconds} s`]),
    ...(budgets.budgetOps === null ? [] : [`${budgets.budgetOps} operations`]),
  ];
  return parts.join(" or ");
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

function number(value: unknown): number | null {
  return typeof value === "number" ? value : null;
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
    `Explorer \`${text(first.explorer)}\`, seed ${count(first.seed)}, at most ${count(first.maxStates)} states per ` +
      `unit; each unit's budget is in its row, as rounds double it. Reports: \`${out}/<unit>.json\`.`,
    "",
    // Depth phases are opt-in; say so, and why, when a run went without them.
    ...(reports.some((report) => isRecord(fields(report.search).phases))
      ? []
      : [
          "Depth phases are off (opt-in, `--depth-phases`): on the 13-unit gate they gained where a first session " +
            "levels off early (DisciplineClinic +4.5 points) but cost units whose first session still gains, such as " +
            "jewell's trap loops, as the second session opens on an early lull. See the README.",
          "",
        ]),
    "| Unit | Budget | Coverage | From corpus | States | Stopped by | Crashes | Traps | Completed | Failed | Stuck | " +
      "Open | Operations | Time | CPU | Most expansions at |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const report of reports) {
    if (report.compile === undefined) {
      lines.push(
        `| ${text(report.unit)} | | no report: skipped as exhausted earlier, or its process failed | | | | | | | | | | | | | |`,
      );
      continue;
    }
    const budget = describeBudget({
      budgetSeconds: number(report.budgetSeconds),
      budgetOps: number(report.budgetOps),
    });
    if (fields(report.compile).ok !== true) {
      lines.push(
        `| ${text(report.unit)} | ${budget} | does not compile | | | | | | | | | | | | | |`,
      );
      continue;
    }
    const coverage = fields(report.coverage);
    const search = fields(report.search);
    const endStates = fields(report.endStates);
    const corpus = fields(report.corpus);
    const top = records(search.expansionsByPrompt)[0];
    const fromCorpus = isRecord(report.corpus)
      ? `${count(fields(corpus.coverageAtStart).percent)}% (${count(corpus.replayed)} of ` +
        `${count(corpus.loaded)} entries replayed, ${count(corpus.stale)} stale; ${count(corpus.written)} kept)`
      : "";
    // A report from before these measurements has none of them.
    const measured = (value: unknown, scale = 1, unit = "") => {
      const found = number(value);
      return found === null ? "" : `${Math.round(found / scale)}${unit}`;
    };
    lines.push(
      `| ${text(report.unit)} | ${budget} | ${count(coverage.percent)}% of ${count(coverage.coverableLines)} lines | ` +
        `${fromCorpus} | ` +
        `${count(search.states)} | ${text(search.stoppedBy)} | ${records(report.crashes).length} | ` +
        `${records(report.traps).length} | ${count(endStates.completed)} | ${count(endStates.failed)} | ` +
        `${count(endStates.stuck)} | ${count(endStates.open)} | ${measured(search.operations)} | ` +
        `${measured(search.elapsedMs, 1000, " s")} | ${measured(search.cpuMs, 1000, " s")} | ` +
        `${top === undefined ? "" : `${count(top.percent)}% ${text(top.location)}${typeof top.kind === "string" ? ` (${top.kind})` : ""}`} |`,
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
          `${crash.clock === true ? ", with the clock set" : ""}` +
          `${crash.chosen === true ? ", only with chosen random outcomes" : ""}${records(crash.earlier).length > 0 ? `, in session ${records(crash.earlier).length + 1}` : ""}; \`${text(crash.replay)}\`)`,
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
      `- Lines: ${count(reach.play)} play, ` +
        (reach.chosen === undefined ? "" : `${count(reach.chosen)} play (chosen random), `) +
        `${count(reach.clock)} clock, ${count(reach.unreachable)} unreachable, ${count(reach.unknown)} unknown`,
    );
    // What a player reaches only with a particular run of luck, apart from what play reaches anyway.
    if (reach.chosen !== undefined)
      lines.push(
        `- Only with chosen random outcomes: ${count(reach.chosen)} lines, ` +
          `${count(fields(fields(report.directed).reached).chosen)} ways, ` +
          `${records(report.crashes).filter((crash) => crash.chosen === true).length} crashes`,
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
      `- Directed search: ${count(reached.play)} play` +
        (reached.chosen === undefined ? "" : `, ${count(reached.chosen)} play (chosen random),`) +
        ` and ${count(reached.clock)} clock of ` +
        `${count(directed.targets)} ways left one way${bySource === "" ? "" : ` (${bySource})`}; ` +
        `${records(coverage.unvisitedBranches).length} still missed by play`,
    );
    const audit = fields(fields(report.search).audit);
    if (typeof audit.result === "string") {
      const progress = fields(audit.progress);
      const spiral = fields(audit.spiral);
      lines.push(
        `- Until stalled: ${audit.result}` +
          (typeof spiral.location === "string"
            ? ` at \`${spiral.location}\` (${count(spiral.share)}% of the expansions since the last progress)`
            : "") +
          `; last progress after ${count(audit.lastProgressAt)} operations, window ${count(audit.window)}; ` +
          `progress: ${count(progress.code)} new code, ${count(progress.ways)} new ways, ${count(progress.closer)} closer ` +
          `(and ${count(progress.cells)} new cells, which do not hold a run up)`,
      );
    }
    lines.push(
      ...sessionDepths(fields(fields(report.search).bySession), fields(coverage.bySession)),
      ...depthPhases(fields(fields(report.search).phases)),
    );
    lines.push(...workingToward(records(coverage.unvisitedBranches)));
    lines.push(
      ...sessionChains([
        ...records(coverage.unvisitedBranches),
        ...records(fields(report.directed).ways),
      ]),
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

/**
 * What each session number added: its sessions, its share of the operations, the lines and ways it reached first, its
 * marginal gain (lines first reached in the last quarter of its operations, per 1,000 of them), and its states that came
 * closer to what a missed way needs; then the lines only a first session ran and those it never ran, as observed.
 */
function sessionDepths(
  bySession: Readonly<Record<string, unknown>>,
  lines: Readonly<Record<string, unknown>>,
): string[] {
  const column = (name: string): number[] =>
    Array.isArray(bySession[name]) ? bySession[name].map(count) : [];
  const operations = column("operations");
  if (operations.length < 2) return [];
  const [started, completed, first, lastQuarter, ways, closer] = [
    "started",
    "completed",
    "linesFirst",
    "linesFirstLastQuarter",
    "waysFirst",
    "closer",
  ].map(column);
  const total = operations.reduce((sum, value) => sum + value, 0);
  const sum = (values: number[] | undefined, from: number, to: number) =>
    (values ?? []).slice(from, to).reduce((all, value) => all + value, 0);
  const row = (label: string, from: number, to: number): string => {
    const work = sum(operations, from, to);
    const gain = sum(lastQuarter, from, to);
    return (
      `  - ${label}: ${sum(started, from, to)} started, ${sum(completed, from, to)} completed, ` +
      `${work} operations (${total === 0 ? 0 : Math.round((work / total) * 100)}%); ` +
      `${sum(first, from, to)} lines first, ${gain} of them in its last quarter ` +
      `(${work === 0 ? 0 : Number(((gain / (work / 4)) * 1000).toPrecision(3))} per 1,000 operations); ` +
      `${sum(ways, from, to)} ways first, ${sum(closer, from, to)} closer`
    );
  };
  const rows = operations
    .slice(0, SESSION_ROWS)
    .map((_, index) => row(`Session ${index + 1}`, index, index + 1));
  if (operations.length > SESSION_ROWS)
    rows.push(row(`Sessions ${SESSION_ROWS + 1}+`, SESSION_ROWS, operations.length));
  const least = Array.isArray(lines.least) ? lines.least.map(count) : [];
  const later = least
    .map((lineCount, index) => ({ session: index + 1, lineCount }))
    .filter(({ session, lineCount }) => session > 1 && lineCount > 0);
  const files = records(lines.files)
    .filter((file) => count(file.notFirst) > 0)
    .sort((left, right) => count(right.notFirst) - count(left.notFirst))
    .slice(0, 5);
  return [
    "- By session number (1 is a new player's first session):",
    ...rows,
    `  - Lines only a first session ran: ${count(lines.onlyFirst)}; lines no first session ran: ` +
      `${sum(
        later.map(({ lineCount }) => lineCount),
        0,
        later.length,
      )}` +
      (later.length === 0
        ? ""
        : ` (by the smallest session number that ran them: ${later.map(({ session, lineCount }) => `${session}: ${lineCount}`).join(", ")})`) +
      (files.length === 0
        ? ""
        : `; most in ${files.map((file) => `\`${text(file.path)}\` ${count(file.notFirst)}`).join(", ")}`),
  ];
}

/**
 * With depth phases: when each session number opened, and its share of the play work and the lines and condition ways it
 * reached first.
 */
function depthPhases(phases: Readonly<Record<string, unknown>>): string[] {
  if (!Array.isArray(phases.openedAt)) return [];
  const work = Array.isArray(phases.playOperations) ? phases.playOperations.map(count) : [];
  const gain = Array.isArray(phases.playGain) ? phases.playGain.map(count) : [];
  const total = work.reduce((sum, value) => sum + value, 0);
  const opened = phases.openedAt
    .map((at, index) => ({ at, session: index + 1 }))
    .filter(({ at, session }) => typeof at === "number" && session > 1)
    .slice(0, SESSION_ROWS - 1);
  return [
    `- Depth phases: ${opened.length === 0 ? "only session 1 opened" : opened.map(({ at, session }) => `session ${session} opened after ${count(at)} operations`).join(", ")}; ` +
      `play work by session ${work
        .slice(0, SESSION_ROWS)
        .map(
          (value, index) =>
            `${index + 1}: ${total === 0 ? 0 : Math.round((value / total) * 100)}% (${gain[index] ?? 0} new)`,
        )
        .join(
          ", ",
        )}; exploration turns ${total === 0 ? 0 : Math.round((count(phases.explorationOperations) / total) * 100)}%`,
  ];
}

/**
 * The session chains toward stored values with the most sessions: their result, the route each repeats (its progress
 * per operation), the other routes it replayed, and its last switch between routes, with why.
 */
function sessionChains(ways: readonly Readonly<Record<string, unknown>>[]): string[] {
  const chains = ways
    .flatMap((way) =>
      records(way.chains).map((chain) => ({ chain, at: `${text(way.path)}:${count(way.line)}` })),
    )
    .sort((left, right) => count(right.chain.sessions) - count(left.chain.sessions))
    .slice(0, WORKING_TOWARD_ROWS);
  if (chains.length === 0) return [];
  return [
    "- Session chains (the most sessions first):",
    ...chains.map(({ chain, at }) => {
      const route = fields(chain.route);
      const others = records(chain.routes).filter((other) => text(other.at) !== text(route.at));
      const last = records(chain.switches).at(-1);
      return (
        `  - \`${at}\` \`${text(chain.key)}\`: ${CHAIN_RESULTS[text(chain.result)] ?? text(chain.result)} after ` +
        `${count(chain.sessions)} sessions, closest ${text(chain.closest)}; ` +
        (chain.route === null || chain.route === undefined
          ? "no session from a storage that has the key brought it closer"
          : `route ${routeText(route)}`) +
        (others.length === 0
          ? ""
          : `; also replayed: ${others.map((other) => routeText(other)).join("; ")}`) +
        (last === undefined
          ? ""
          : `; last switch at session ${count(last.sessions)}: ${text(last.reason)}`)
      );
    }),
  ];
}

/** A chain's route: where it goes, its inputs, and its progress per operation over its replays. */
function routeText(route: Readonly<Record<string, unknown>>): string {
  const replays = count(route.sessions);
  return (
    `${text(route.at)} (${count(route.inputs)} inputs, ` +
    `${count(route.progressPer1000Operations)} progress per 1,000 operations` +
    (replays === 0
      ? " in the session it comes from)"
      : ` over ${replays} replays, ${count(route.failures)} no closer)`)
  );
}

/** Ways still missed, those with the most code behind them first: what each needs, and why play did not get there. */
function workingToward(branches: readonly Readonly<Record<string, unknown>>[]): string[] {
  const shown = branches
    .filter((branch) => count(branch.behindLines) > 0)
    .sort((left, right) => count(right.behindLines) - count(left.behindLines))
    .slice(0, WORKING_TOWARD_ROWS);
  if (shown.length === 0) return [];
  return [
    "- Working toward (the missed ways with the most code behind them):",
    ...shown.map((branch) => {
      const written = text(fields(branch.condition).text) || "?";
      // A switch case's condition reads as its pattern.
      const condition = branch.case === true ? `case ${written}` : written;
      const needs =
        branch.missed === "true" || branch.missed === "enter" ? condition : `not (${condition})`;
      const best = fields(branch.best);
      const parts = records(branch.parts);
      const dependsOn = texts(branch.dependsOn);
      const value = (closest: Readonly<Record<string, unknown>>) =>
        typeof closest.value === "number" ? count(closest.value) : String(closest.value);
      const subject = text(best.needs)
        .split(" ")
        .slice(0, text(best.needs).startsWith("stored ") ? 2 : 1)
        .join(" ");
      const closest =
        branch.best === undefined
          ? ""
          : `${best.trend === "improving" ? "still improving" : "no progress"}: the closest ` +
            `${best.atOperations === undefined ? "storage" : "state"} had \`${subject}\` = ${value(best)} in session ` +
            `${count(best.session)}` +
            `${best.atOperations === undefined || best.trend === "improving" ? "" : `, no closer after ${count(best.atOperations)} operations`}` +
            ` (needs \`${text(best.needs)}\`)`;
      // The other parts: met in some state (not necessarily together), or not measured.
      const listed = (status: string) =>
        parts
          .filter((part) => part.status === status && text(part.needs) !== text(best.needs))
          .map(
            (part) =>
              `\`${text(part.needs)}\`${part.of === "earlier condition" ? " (earlier condition)" : ""}` +
              (status === "met" ? ` (${value(fields(part.closest))})` : ""),
          );
      const others = [
        ...(listed("met").length > 0 ? [`met in some state: ${listed("met").join(", ")}`] : []),
        ...(listed("unmet").length > 0 ? [`also unmet: ${listed("unmet").join(", ")}`] : []),
        ...(listed("unmeasured").length > 0
          ? [`not measured: ${listed("unmeasured").join(", ")}`]
          : []),
      ].join("; ");
      const why =
        branch.reach === "unreachable"
          ? `unreachable: ${text(branch.reason)}`
          : branch.reach === "clock"
            ? "reached only at another wall clock time"
            : closest !== ""
              ? `${closest}${others === "" ? "" : `; ${others}`}`
              : branch.reason !== undefined
                ? `no progress: ${text(branch.reason)}${others === "" ? "" : `; ${others}`}`
                : others !== ""
                  ? `no progress; ${others}`
                  : dependsOn.length > 0
                    ? `no progress; depends on ${dependsOn.join(", ")}`
                    : "no progress; what it depends on is not traced";
      return `  - \`${text(branch.path)}:${count(branch.line)}\` needs \`${needs}\` (${count(branch.behindLines)} lines behind): ${why}`;
    }),
  ];
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
  const input = parseInputKind(value);
  if (input === null || !isRecord(value) || value.random === undefined) return input;
  // The random outcomes the explorer chose during the input, one per draw; the runtime checks each outcome against its
  // draw, and an input whose outcomes are not all taken does not fit.
  if (!Array.isArray(value.random) || value.random.length === 0) return null;
  const random: RandomChoice[] = [];
  for (const choice of value.random) {
    if (
      !isRecord(choice) ||
      !Number.isSafeInteger(choice.drawId) ||
      random.some((known) => known.drawId === choice.drawId) ||
      typeof choice.site !== "string" ||
      !isRecord(choice.outcome) ||
      typeof choice.outcome.kind !== "string"
    )
      return null;
    random.push({ drawId: Number(choice.drawId), site: choice.site, outcome: choice.outcome });
  }
  return { ...input, random };
}

function parseInputKind(value: unknown): ExplorerInput | null {
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
    case "later":
      // Time only goes forward between the inputs of a path.
      return typeof value.afterMs === "number" &&
        Number.isSafeInteger(value.afterMs) &&
        value.afterMs > 0
        ? { kind: "later", afterMs: value.afterMs }
        : null;
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
  const replayed = replay(engine, unit.plan, report.seed, inputs, {
    earlier,
    wallClockMs,
    sessionSeeds: isRecord(report.strategies) && report.strategies.sessionSeeds === true,
  });
  // An earlier session that waits after its last input is one the player quit there; the narration stops where a
  // runtime operation threw.
  earlier.slice(0, replayed.earlier.length + 1).forEach((session, index) => {
    const status = replayed.earlier[index];
    const end =
      status === undefined
        ? "a runtime operation threw"
        : status === "halted"
          ? "it ends; its storage starts the next"
          : status === "waiting"
            ? `the player quits after input ${session.inputs.length}; its storage starts the next`
            : `it ends ${status}; its storage starts the next`;
    process.stdout.write(
      `Session ${index + 1}${session.wallClockMs === undefined ? "" : ` at ${new Date(session.wallClockMs).toISOString()}`}: ` +
        `${session.inputs.map(describeInput).join("; ") || "(no input)"}, then ${end}\n`,
    );
  });
  if (wallClockMs !== EPOCH_MS)
    process.stdout.write(`The last session starts at ${new Date(wallClockMs).toISOString()}\n`);
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
    // A state the runtime refused to restore: the path reaches it without a throw, and restoring it throws.
    let thrown = replayed.error;
    if (thrown === null) {
      try {
        engine.createRuntimeSession(unit.plan, replayed.snapshot);
      } catch (refused) {
        thrown = String(refused);
        process.stdout.write(`Restoring the state reached threw: ${thrown}\n`);
      }
    }
    const reproduced = thrown === text(target.message);
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

/** A time gap in words: whole days from two days on, else hours, else seconds. */
function describeGap(milliseconds: number): string {
  const hours = milliseconds / 3_600_000;
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return hours >= 1 ? `${hours} h` : `${milliseconds / 1000} s`;
}

function describeInput(input: ExplorerInput): string {
  const chosen = (input.random ?? []).map(
    (choice) => `${choice.site} ${JSON.stringify(choice.outcome)}`,
  );
  return chosen.length === 0
    ? describeInputKind(input)
    : `${describeInputKind(input)} (random chosen: ${chosen.join(", ")})`;
}

function describeInputKind(input: ExplorerInput): string {
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
    case "later":
      return `continue ${describeGap(input.afterMs)} later`;
  }
}
