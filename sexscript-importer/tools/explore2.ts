/**
 * Explorer V2 (concolic playtester) on unit folders: writes `<out>/<unit>.json` with the report fields of V1
 * (`tools/explore.ts`: the unit's content hash, the explorer, the budget, when it ran, coverage, crashes, traps, and the
 * catalog block) and V2's own search figures, and a playtest report for the script's creator next to it
 * (`<out>/<unit>.report.md`, see `tools/explore-report.ts`; `--no-report` leaves it out). V1 stays the default explorer;
 * see `src/explorer2/`.
 *
 * Usage: node tools/explore2.ts [--seed N] [--budget-seconds N] [--max-steps N] [--max-heap-mb N] [--no-report]
 *        <unit-dir>... --out <dir>
 *        node tools/explore2.ts --replay <out>/<unit>.json (--crash N | --trap N)
 * (`--max-heap-mb`: the heap in use at which the search stops, by default 60% of the heap limit, as for V1). A replay
 * plays a crash's or a trap's witness (its inputs, draw outcomes, and saved data) on the unit again and says how it
 * ended.
 *
 * Diagnostics on stderr, by environment variable: `SX_V2_DEBUG` (each play, unsolved and open targets, work and checks
 * per target), `SX_V2_CHECKS=<instruction>` (each check of that target), `SX_V2_KEYS=<regex>` (the values the saved
 * states hold for matching stored keys), `SX_V2_HEAP=<file>` (a heap snapshot at the end).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { isRecord } from "../src/ast.ts";
import { loadRepositoryPackageScanner } from "../src/compile-check.ts";
import { loadEngine } from "../src/explorer.ts";
import { DEFAULT_OPTIONS, explore2, type Explore2Result } from "../src/explorer2/search.ts";
import { loadRuntime2, Runner } from "../src/explorer2/runner.ts";
import { instructionFiles } from "../src/explorer-search.ts";
import { packageContentHash } from "./catalog.ts";
import { playtestReport } from "./explore-report.ts";

const SELF = fileURLToPath(import.meta.url);

/** The V8 flag that sets how much the heap grows after a collection. */
const HEAP_GROWING = "--heap-growing-percent";
// As V1 does: V8 lets its heap grow to up to four times what a collection keeps, so that the heap in use (which the heap
// cap reads) is mostly garbage; growing it by a fifth at a time keeps it close to what the run holds.
if (execFileSync(process.execPath, ["--v8-options"], { encoding: "utf8" }).includes(HEAP_GROWING))
  setFlagsFromString(`${HEAP_GROWING}=20`);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seed: { type: "string", default: "1" },
    "budget-seconds": { type: "string", default: "60" },
    "max-steps": { type: "string" },
    "max-heap-mb": { type: "string" },
    out: { type: "string" },
    "no-report": { type: "boolean", default: false },
    replay: { type: "string" },
    crash: { type: "string" },
    trap: { type: "string" },
  },
});
const USAGE =
  "usage: node tools/explore2.ts [--seed N] [--budget-seconds N] [--max-steps N] [--max-heap-mb N] [--no-report] <unit-dir>... --out <dir>\n" +
  "       node tools/explore2.ts --replay <out>/<unit>.json (--crash N | --trap N)\n";
const engine = await loadEngine();
const runtime = await loadRuntime2();
const scan = await loadRepositoryPackageScanner();
if (values.replay !== undefined) {
  process.exitCode = await replay(values.replay, values.crash, values.trap);
} else {
  const maxHeapMb =
    values["max-heap-mb"] === undefined
      ? Math.floor((getHeapStatistics().heap_size_limit * 0.6) / 1024 ** 2)
      : Number(values["max-heap-mb"]);
  if (
    values.out === undefined ||
    positionals.length === 0 ||
    !(Number.isSafeInteger(maxHeapMb) && maxHeapMb >= 1)
  ) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const out = values.out;
  await mkdir(out, { recursive: true });
  const explorer = `v2 ${explorerCommit()}`;
  for (const dir of positionals) {
    const unit = path.basename(path.resolve(dir));
    const folder = await scan(dir);
    const compiled = engine.compileProject(folder.sources, { builtins: [], images: folder.images });
    const diagnostics = (Array.isArray(compiled.diagnostics) ? compiled.diagnostics : []).filter(
      isRecord,
    );
    const errors = diagnostics.filter((entry) => entry.severity === "error");
    const file = path.join(out, `${unit}.json`);
    const header = {
      unit,
      dir: path.resolve(dir),
      contentHash: packageContentHash(folder.sources),
      converter: await converterCommit(dir),
      explorer,
      seed: Number(values.seed),
      budgetSeconds: Number(values["budget-seconds"]),
      budgetOps: null,
      exploredAt: new Date().toISOString(),
    };
    const plan = compiled.plan;
    if (!isRecord(plan) || errors.length > 0) {
      process.stderr.write(`${unit}: does not compile\n`);
      // As V1 lists them: where, the code, and the message.
      const listed = errors.slice(0, 20).map((entry) => {
        const span = isRecord(entry.span) && isRecord(entry.span.start) ? entry.span.start : {};
        const line = typeof span.line === "number" ? span.line + 1 : 0;
        return `${String(entry.path ?? "")}:${line} ${String(entry.code ?? "")} ${String(entry.message ?? "")}`;
      });
      await write(out, unit, { ...header, compile: { ok: false, errors: listed } });
      continue;
    }
    const result = explore2(engine, runtime, plan, {
      ...DEFAULT_OPTIONS,
      seed: Number(values.seed),
      budgetMs: Number(values["budget-seconds"]) * 1000,
      maxHeapBytes: maxHeapMb * 1024 ** 2,
      ...(values["max-steps"] === undefined ? {} : { maxSteps: Number(values["max-steps"]) }),
      sources: new Map(
        folder.sources.map((source: { path: string; source: string }) => [
          source.path,
          source.source,
        ]),
      ),
      // With their source offsets, as V1 reads them for the conditions the compiler proves constant.
      diagnostics: diagnostics.map((entry) => {
        const span = isRecord(entry.span) ? entry.span : {};
        const offset = (end: unknown) =>
          isRecord(end) && typeof end.offset === "number" ? end.offset : 0;
        return {
          path: typeof entry.path === "string" ? entry.path : "",
          start: offset(span.start),
          end: offset(span.end),
          code: typeof entry.code === "string" ? entry.code : "",
          message: typeof entry.message === "string" ? entry.message : "",
        };
      }),
    });
    const search = result.search;
    process.stderr.write(
      `${unit}: ${result.coverage.percent}% of ${result.coverage.coverableLines} lines, ${search.stoppedBy} (${search.audit.result}), ` +
        `${search.plays} plays, ${search.checks} checks, ${search.solved} solved, unsolved ${JSON.stringify(search.unsolved)}, ` +
        `${result.crashes.length} crashes, ${search.operations} instructions, ${Math.round(search.elapsedMs / 1000)} s\n`,
    );
    // The report's path quoted for a shell (a unit's name may have spaces).
    const quoted = `'${file.replaceAll("'", "'\\''")}'`;
    const command = (flag: string, index: number) =>
      `node tools/explore2.ts --replay ${quoted} --${flag} ${index}`;
    const report = {
      ...header,
      compile: { ok: true },
      catalog: catalogBlock(result),
      ...result,
      crashes: result.crashes.map((crash, index) => ({
        ...crash,
        replay: command("crash", index),
      })),
      traps: result.traps.map((trap, index) => ({ ...trap, replay: command("trap", index) })),
    };
    await write(out, unit, report);
  }
}

/** A unit's report as written: its header and compilation, and for one that compiles, V2's result. */
type UnitReport = Readonly<Record<string, unknown>> & {
  readonly unit: string;
  readonly compile: { readonly ok: boolean; readonly errors?: readonly string[] };
};

/** Writes a unit's report, and its playtest report for the creator unless `--no-report` (also for one that does not
 * compile, so that no older one stays). */
async function write(out: string, unit: string, report: UnitReport): Promise<void> {
  const json = JSON.stringify(report);
  await writeFile(path.join(out, `${unit}.json`), `${json}\n`);
  if (values["no-report"] !== true)
    await writeFile(path.join(out, `${unit}.report.md`), playtestReport(JSON.parse(json)));
}

/**
 * The compact view the importer catalog shows in its Explorer column, as V1 writes it: coverage, crashes, traps, the
 * first of each, and the coverable lines by reach label.
 */
function catalogBlock(result: Explore2Result) {
  const crash = result.crashes[0];
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

/** Plays a crash's or a trap's witness from a report again; 0 when it ends as reported. */
async function replay(file: string, crash?: string, trap?: string): Promise<number> {
  const report: unknown = JSON.parse(await readFile(file, "utf8"));
  const list = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
  const index = Number(crash ?? trap);
  const witness = isRecord(report)
    ? list(crash !== undefined ? report.crashes : report.traps)[index]
    : undefined;
  if (
    !isRecord(report) ||
    typeof report.dir !== "string" ||
    (crash === undefined) === (trap === undefined) ||
    witness === undefined
  ) {
    process.stderr.write(USAGE);
    return 2;
  }
  const folder = await scan(report.dir);
  const plan = engine.compileProject(folder.sources, { builtins: [], images: folder.images }).plan;
  if (!isRecord(plan)) {
    process.stderr.write(`${report.dir}: does not compile\n`);
    return 1;
  }
  const inputs = list(witness.inputs);
  const played = new Runner(runtime, engine, plan, Number(report.seed ?? 1)).play(
    {
      // EVIDENCE: the explorer wrote these inputs, outcomes, and storage entries itself (see `Explore2Result`).
      inputs: inputs as never,
      draws: new Map(
        list(witness.draws).map((draw) => [
          Number(draw.occurrence),
          isRecord(draw.outcome) ? draw.outcome : {},
        ]),
      ),
      inherited: [],
      ...(Array.isArray(witness.storage)
        ? {
            storage: list(witness.storage).flatMap((entry) => {
              const value = entry.value;
              return typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean" ||
                isRecord(value)
                ? [{ key: String(entry.key), value }]
                : [];
            }),
          }
        : {}),
      ...(typeof witness.wallClockMs === "number" ? { wallClockMs: witness.wallClockMs } : {}),
    },
    {
      maxSteps: inputs.length,
      maxStepInstructions: DEFAULT_OPTIONS.maxStepInstructions,
      origins: false,
    },
  );
  const failure = played.failure;
  process.stdout.write(
    `${played.inputs.length} inputs, ended: ${played.end}` +
      (failure === null
        ? ""
        : `, ${failure.code} at ${failure.path}:${failure.line}: ${failure.message}`) +
      "\n",
  );
  // A crash fails as reported, where reported; a trap's play stops at the first place of its loop it reported.
  const files = instructionFiles(plan);
  const last = played.interactions.at(-1);
  const instruction = Array.isArray(plan.instructions)
    ? plan.instructions[last?.instruction ?? -1]
    : undefined;
  const line =
    isRecord(instruction) && isRecord(instruction.span) && typeof instruction.span.sl === "number"
      ? instruction.span.sl + 1
      : 0;
  const expected =
    crash !== undefined
      ? played.end === "failed" &&
        failure?.code === witness.code &&
        failure?.path === witness.path &&
        failure?.line === witness.line
      : (played.end === "waiting" || played.end === "steps") &&
        last !== undefined &&
        (Array.isArray(witness.locations) ? witness.locations : []).includes(
          `${files[last.instruction] ?? ""}:${line}`,
        );
  return expected ? 0 : 1;
}

/** The importer commit a unit was converted with, from its conversion record (as V1 reads it). */
async function converterCommit(dir: string): Promise<string | null> {
  try {
    const conversion: unknown = JSON.parse(
      await readFile(path.join(dir, ".conversion.json"), "utf8"),
    );
    return isRecord(conversion) && typeof conversion.converter === "string"
      ? conversion.converter
      : null;
  } catch {
    return null;
  }
}

/**
 * The explorer's commit: `SX_EXPLORER_COMMIT` when set, as for a copy of the sources without the repository; else what
 * `git describe` says of the sources here; else "unknown" (as V1 tells it).
 */
function explorerCommit(): string {
  const given = process.env.SX_EXPLORER_COMMIT;
  if (given !== undefined && given !== "") return given;
  try {
    return execFileSync(
      "git",
      ["-C", path.dirname(SELF), "describe", "--always", "--dirty", "--abbrev=8"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "unknown";
  }
}
