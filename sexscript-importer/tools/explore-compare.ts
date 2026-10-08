/**
 * Compares the explorer reports of a candidate run with those of a base run, unit by unit, as a gate for a change to
 * the explorer: coverage by seed, how the search stopped, states per second, crashes and traps the base found and the
 * candidate did not, and the lines and condition ways each side visited that the other did not. A net coverage change
 * can hide a loss elsewhere, so it shows gained and lost lines apart, per seed, and the lines consistently lost or gained:
 * visited by one side in at least two thirds of the seeds and by the other in none, with the files and ranges they are
 * in and the search figures that help explain them.
 *
 * Usage: node tools/explore-compare.ts <base-dir> <candidate-dir> [--favourite <unit>]... [--no-lines]
 *
 * Each folder holds the reports of one run (`<unit>.json`, as `tools/explore.ts --out` writes them) or one subfolder per
 * seed (`s1/<unit>.json`, ...), matched by name. A unit fails the gate when the candidate's mean coverage is more than
 * 1 pp below the base's lowest, when a seed the base exhausted is not exhausted by the candidate with at least the same
 * coverage, or when a crash or trap the base found (code or kind and place) is missing from all the candidate's seeds.
 * A unit named with `--favourite` that has consistently lost lines is marked `EXPLAIN`: the losses need an explanation
 * before the change passes. Lines first-ever reached (by a candidate seed, by no base seed) are counted and listed, and a
 * last table compares, for the ways both sides missed, the closest any seed came to a measured part of each. Lines are counted as the explorer counts them, from compiling the unit's folder (its
 * `dir`), so the repository build is needed (`npm run build:typescript` in the repository root). Writes Markdown.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";
import { loadRepositoryPackageScanner } from "../src/compile-check.ts";
import { instructionFiles } from "../src/explorer-search.ts";
import { loadEngine, type Engine } from "../src/explorer.ts";

type Fields = Readonly<Record<string, unknown>>;

/** The parts of an explorer report the comparison reads. */
interface Run {
  readonly dir: string;
  readonly contentHash: string;
  readonly budgetOps: number | null;
  readonly percent: number;
  readonly stoppedBy: string;
  readonly states: number;
  readonly elapsedMs: number;
  readonly sessions: number;
  readonly timeSteps: number;
  readonly quitVisits: number;
  readonly open: number;
  readonly crashes: readonly string[];
  readonly traps: readonly string[];
  readonly hotspots: readonly { percent: number; location: string; kind: string }[];
  /** Per file, the line ranges play did not visit (`12` or `12-18`). */
  readonly unvisited: ReadonlyMap<string, readonly string[]>;
  /** Condition ways missed at a condition play reached, as `file:line:instruction:way`. */
  readonly missedWays: ReadonlySet<string>;
  /** For a missed way with a measured part, the closest a state came to it (`best` of the target report), by way. */
  readonly closest: ReadonlyMap<string, { needs: string; value: string; distance: number }>;
}

/** The runs of one side, by unit and seed folder (`""` for a folder of reports). */
type Side = Map<string, Map<string, Run>>;

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    allowNegative: true,
    options: {
      favourite: { type: "string", multiple: true, default: [] },
      lines: { type: "boolean", default: true },
    },
  });
  if (positionals.length !== 2) {
    process.stderr.write(
      "Usage: node tools/explore-compare.ts <base-dir> <candidate-dir> [--favourite <unit>]... [--no-lines]\n",
    );
    process.exit(2);
  }
  const [base, candidate] = await Promise.all(
    positionals.map((dir) => readSide(path.resolve(dir))),
  );
  const favourites = new Set(values.favourite);
  const out = gateTable(base!, candidate!);
  if (values.lines) out.push(...(await lineTable(base!, candidate!, favourites)));
  process.stdout.write(`${out.join("\n")}\n`);
}

function fields(value: unknown): Fields {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Fields[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A report read back, or null for a unit that did not compile or a file that is no report. */
function parseRun(value: unknown): Run | null {
  const report = fields(value);
  const coverage = fields(report.coverage);
  const search = fields(report.search);
  if (typeof coverage.percent !== "number" || typeof report.dir !== "string") return null;
  const time = fields(search.time);
  return {
    dir: report.dir,
    contentHash: text(report.contentHash),
    budgetOps: typeof report.budgetOps === "number" ? report.budgetOps : null,
    percent: coverage.percent,
    stoppedBy: text(search.stoppedBy),
    states: count(search.states),
    elapsedMs: count(search.elapsedMs),
    sessions: count(search.sessions),
    timeSteps: count(time.steps) + count(time.sessions),
    quitVisits: count(search.quitVisits),
    open: count(fields(report.endStates).open),
    crashes: records(report.crashes).map(
      (crash) =>
        `${text(crash.code)}@${text(crash.path)}:${count(crash.line)}:${count(crash.column)}`,
    ),
    traps: records(report.traps).map(
      (trap) =>
        `${text(trap.kind)}@${(Array.isArray(trap.locations) ? trap.locations.map(text) : []).sort().join("|")}`,
    ),
    hotspots: records(search.expansionsByPrompt).map((spot) => ({
      percent: count(spot.percent),
      location: text(spot.location),
      kind: text(spot.kind),
    })),
    unvisited: new Map(
      records(coverage.files).map((file) => [
        text(file.path),
        records(file.unvisited).map((range) => text(range.lines)),
      ]),
    ),
    missedWays: new Set(
      records(coverage.unvisitedBranches).map(
        (branch) =>
          `${text(branch.path)}:${count(branch.line)}:${count(branch.instruction)}:${text(branch.missed)}`,
      ),
    ),
    closest: new Map(
      records(coverage.unvisitedBranches)
        .filter((branch) => isRecord(branch.best))
        .map((branch) => {
          const best = fields(branch.best);
          return [
            `${text(branch.path)}:${count(branch.line)}:${text(branch.missed)}`,
            {
              needs: text(best.needs),
              value:
                typeof best.value === "number"
                  ? String(Number(best.value.toPrecision(6)))
                  : String(best.value),
              distance: count(best.distance),
            },
          ];
        }),
    ),
  };
}

/** The reports of a folder: its own, or those of each subfolder as one seed. */
async function readSide(dir: string): Promise<Side> {
  const side: Side = new Map();
  const add = async (folder: string, seed: string) => {
    for (const name of (await readdir(folder)).filter((file) => file.endsWith(".json")).sort()) {
      const run = parseRun(JSON.parse(await readFile(path.join(folder, name), "utf8")));
      if (run === null) continue;
      const unit = name.slice(0, -".json".length);
      const seeds = side.get(unit) ?? new Map<string, Run>();
      side.set(unit, seeds.set(seed, run));
    }
  };
  const entries = await readdir(dir, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (folders.length === 0) await add(dir, "");
  else for (const folder of folders.sort()) await add(path.join(dir, folder), folder);
  return side;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function fixed(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "-";
}

/** The seeds both sides ran a unit with, in order, with the two runs. */
function pairs(
  base: Side,
  candidate: Side,
  unit: string,
): { seed: string; base: Run; candidate: Run }[] {
  const left = base.get(unit) ?? new Map<string, Run>();
  const right = candidate.get(unit) ?? new Map<string, Run>();
  return [...left.keys()]
    .filter((seed) => right.has(seed))
    .sort()
    .map((seed) => ({ seed, base: left.get(seed)!, candidate: right.get(seed)! }));
}

function units(base: Side, candidate: Side): string[] {
  return [...new Set([...base.keys(), ...candidate.keys()])].sort();
}

/** The gate table: coverage by seed, stops, states per second, and what fails a unit. */
function gateTable(base: Side, candidate: Side): string[] {
  const out = [
    "| Unit | Ops | Base % by seed | Candidate % by seed | Δ mean pp | Stopped | States/s | Gate |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const notes: string[] = [];
  let failing = 0;
  for (const unit of units(base, candidate)) {
    const runs = pairs(base, candidate, unit);
    if (runs.length === 0) {
      out.push(`| ${unit} | not run by both sides | | | | | | |`);
      continue;
    }
    const b = runs.map((run) => run.base.percent);
    const c = runs.map((run) => run.candidate.percent);
    const fails: string[] = [];
    if (mean(c) < Math.min(...b) - 1)
      fails.push(`mean ${fixed(mean(c))} < base lowest ${fixed(Math.min(...b))} - 1`);
    for (const run of runs)
      if (
        run.base.stoppedBy === "exhausted" &&
        (run.candidate.stoppedBy !== "exhausted" || run.candidate.percent < run.base.percent)
      )
        fails.push(
          `${run.seed || "run"}: base exhausted at ${run.base.percent}%, candidate ${run.candidate.stoppedBy} at ${run.candidate.percent}%`,
        );
    const found = (side: "base" | "candidate", kind: "crashes" | "traps") =>
      new Set(runs.flatMap((run) => run[side][kind]));
    for (const kind of ["crashes", "traps"] as const) {
      const lost = [...found("base", kind)].filter(
        (signature) => !found("candidate", kind).has(signature),
      );
      const added = [...found("candidate", kind)].filter(
        (signature) => !found("base", kind).has(signature),
      );
      if (lost.length > 0) fails.push(`lost ${kind} ${lost.join(", ")}`);
      if (added.length > 0) notes.push(`${unit}: new ${kind} ${added.join(", ")}`);
    }
    const rate = (side: "base" | "candidate") =>
      mean(runs.map((run) => run[side].states / Math.max(1, run[side].elapsedMs / 1000)));
    const stops = (side: "base" | "candidate") =>
      [...new Set(runs.map((run) => run[side].stoppedBy))].join("/");
    if (fails.length > 0) failing += 1;
    out.push(
      `| ${unit} | ${runs[0]!.base.budgetOps ?? "-"} | ${b.map(fixed).join(" ")} | ${c.map(fixed).join(" ")} | ` +
        `${fixed(mean(c) - mean(b))} | ${stops("base")} → ${stops("candidate")} | ${fixed(rate("base"))} → ` +
        `${fixed(rate("candidate"))} | ${fails.length > 0 ? `FAIL: ${fails.join("; ")}` : "pass"} |`,
    );
    for (const side of ["base", "candidate"] as const)
      notes.push(
        `${unit} ${side} ${runs[0]!.seed || "run"} hotspots: ${runs[0]![side].hotspots
          .slice(0, 3)
          .map((spot) => `${spot.percent}% ${spot.location} (${spot.kind})`)
          .join(", ")}`,
      );
  }
  return [...out, "", `${failing} unit(s) failing.`, ...notes.map((note) => `- ${note}`)];
}

/** The coverable lines of a unit by file: the lines its plan's instructions start on, as the explorer counts them. */
async function coverableLines(
  engine: Engine,
  scan: Awaited<ReturnType<typeof loadRepositoryPackageScanner>>,
  dir: string,
): Promise<Map<string, Set<number>>> {
  const folder = await scan(dir);
  const { plan } = engine.compileProject(folder.sources, { builtins: [], images: folder.images });
  const lines = new Map<string, Set<number>>();
  if (!isRecord(plan)) return lines;
  const files = instructionFiles(plan);
  records(plan.instructions).forEach((instruction, index) => {
    const span = fields(instruction.span);
    if (typeof span.sl !== "number") return;
    const file = files[index]!;
    const known = lines.get(file) ?? new Set<number>();
    lines.set(file, known.add(span.sl + 1));
  });
  return lines;
}

/** A run's visited lines as `file:line`: the coverable lines in none of its unvisited ranges. */
function visitedLines(run: Run, lines: ReadonlyMap<string, ReadonlySet<number>>): Set<string> {
  const visited = new Set<string>();
  for (const [file, all] of lines) {
    const missed = new Set<number>();
    for (const range of run.unvisited.get(file) ?? []) {
      const [from = 0, to = from] = range.split("-").map(Number);
      for (let line = from; line <= to; line += 1) missed.add(line);
    }
    for (const line of all) if (!missed.has(line)) visited.add(`${file}:${line}`);
  }
  return visited;
}

/** `file:line` keys as ranges of consecutive coverable lines per file, the files and ranges with most lines first. */
function rangesOf(
  keys: readonly string[],
  lines: ReadonlyMap<string, ReadonlySet<number>>,
): { file: string; count: number; ranges: string[] }[] {
  const byFile = new Map<string, number[]>();
  for (const key of keys) {
    const at = key.lastIndexOf(":");
    const file = key.slice(0, at);
    byFile.set(file, [...(byFile.get(file) ?? []), Number(key.slice(at + 1))]);
  }
  return [...byFile]
    .map(([file, found]) => {
      const order = [...(lines.get(file) ?? [])].sort((left, right) => left - right);
      const position = new Map(order.map((line, index) => [line, index]));
      const ranges: { from: number; to: number; count: number }[] = [];
      for (const line of found.sort((left, right) => left - right)) {
        const last = ranges.at(-1);
        if (last !== undefined && position.get(line) === position.get(last.to)! + 1) {
          last.to = line;
          last.count += 1;
        } else ranges.push({ from: line, to: line, count: 1 });
      }
      return {
        file,
        count: found.length,
        ranges: ranges
          .sort((left, right) => right.count - left.count)
          .map((range) =>
            range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`,
          ),
      };
    })
    .sort((left, right) => right.count - left.count);
}

/** The table of gained and lost lines and ways, and per unit the seeds' figures and the consistently lost ranges. */
async function lineTable(
  base: Side,
  candidate: Side,
  favourites: ReadonlySet<string>,
): Promise<string[]> {
  const engine = await loadEngine();
  const scan = await loadRepositoryPackageScanner();
  const out = [
    "",
    "## Gained and lost lines",
    "",
    "Per seed means. Consistently: visited by one side in at least two thirds of the seeds and by the other in none.",
    "First-ever: visited by a candidate seed and by no base seed. `EXPLAIN`: a favourite unit with consistently lost lines.",
    "",
    "| Unit | Net Δ pp | Gained lines | Lost lines | Ways +/− | Consistently lost | Consistently gained | First-ever | Top consistently lost | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const details: string[] = [];
  for (const unit of units(base, candidate)) {
    const runs = pairs(base, candidate, unit);
    if (runs.length === 0) continue;
    if (runs.some((run) => run.base.contentHash !== run.candidate.contentHash)) {
      out.push(`| ${unit} | the unit's files differ between the sides | | | | | | | | |`);
      continue;
    }
    const lines = await coverableLines(engine, scan, runs[0]!.base.dir);
    const seen = new Map<string, [number, number]>();
    const gained: number[] = [];
    const lost: number[] = [];
    const ways: [number, number][] = [];
    const seeds: string[] = [];
    for (const run of runs) {
      const visitedBase = visitedLines(run.base, lines);
      const visitedCandidate = visitedLines(run.candidate, lines);
      for (const key of visitedBase) (seen.get(key) ?? seen.set(key, [0, 0]).get(key)!)[0] += 1;
      for (const key of visitedCandidate)
        (seen.get(key) ?? seen.set(key, [0, 0]).get(key)!)[1] += 1;
      const up = [...visitedCandidate].filter((key) => !visitedBase.has(key)).length;
      const down = [...visitedBase].filter((key) => !visitedCandidate.has(key)).length;
      // A way one side missed at a condition the other reached without missing that way.
      const lineOf = (way: string) => way.split(":").slice(0, 2).join(":");
      const waysUp = [...run.base.missedWays].filter(
        (way) => !run.candidate.missedWays.has(way) && visitedCandidate.has(lineOf(way)),
      ).length;
      const waysDown = [...run.candidate.missedWays].filter(
        (way) => !run.base.missedWays.has(way) && visitedBase.has(lineOf(way)),
      ).length;
      gained.push(up);
      lost.push(down);
      ways.push([waysUp, waysDown]);
      seeds.push(
        `${run.seed || "run"} +${up} −${down} lines (net ${up - down}), ways +${waysUp} −${waysDown}`,
      );
    }
    const need = Math.max(1, Math.ceil((runs.length * 2) / 3));
    const consistentlyLost = [...seen]
      .filter(([, [b, c]]) => b >= need && c === 0)
      .map(([key]) => key);
    const consistentlyGained = [...seen]
      .filter(([, [b, c]]) => c >= need && b === 0)
      .map(([key]) => key);
    const firstEver = [...seen].filter(([, [b, c]]) => c >= 1 && b === 0).map(([key]) => key);
    const lostRanges = rangesOf(consistentlyLost, lines);
    const firstRanges = rangesOf(firstEver, lines);
    const describe = (count: number, ranges: number) =>
      lostRanges
        .slice(0, count)
        .map((file) => `${file.file} ${file.count} (${file.ranges.slice(0, ranges).join(", ")})`)
        .join("; ");
    const delta =
      mean(runs.map((run) => run.candidate.percent)) - mean(runs.map((run) => run.base.percent));
    out.push(
      `| ${unit} | ${fixed(delta)} | ${fixed(mean(gained))} | ${fixed(mean(lost))} | ` +
        `+${fixed(mean(ways.map((way) => way[0])))} −${fixed(mean(ways.map((way) => way[1])))} | ` +
        `${consistentlyLost.length} | ${consistentlyGained.length} | ${firstEver.length} | ${describe(2, 2)} | ` +
        `${favourites.has(unit) && consistentlyLost.length > 0 ? "EXPLAIN" : ""} |`,
    );
    const figure = (label: string, of: (run: Run) => number) =>
      `${label} ${fixed(mean(runs.map((run) => of(run.base))))} → ${fixed(mean(runs.map((run) => of(run.candidate))))}`;
    const top = (run: Run) =>
      `${run.hotspots[0]?.percent ?? 0}% ${run.hotspots[0]?.location ?? ""}`;
    details.push(
      `- ${unit}: ${seeds.join("; ")}. Figures: ${[
        figure("states", (run) => run.states),
        figure("sessions", (run) => run.sessions),
        figure("time steps", (run) => run.timeSteps),
        figure("quit visits", (run) => run.quitVisits),
        figure("traps", (run) => run.traps.length),
        figure("open", (run) => run.open),
      ].join(", ")}; top hotspot ${top(runs[0]!.base)} → ${top(runs[0]!.candidate)}` +
        (lostRanges.length > 0 ? `. Consistently lost: ${describe(4, 4)}` : "") +
        (firstRanges.length > 0
          ? `. First-ever: ${firstRanges
              .slice(0, 4)
              .map((file) => `${file.file} ${file.count} (${file.ranges.slice(0, 4).join(", ")})`)
              .join("; ")}`
          : ""),
    );
  }
  return [...out, "", ...details, ...progressTable(base, candidate)];
}

/**
 * Progress toward ways both sides missed: for each way with a measured part (the target report's `best`), the closest
 * any seed of a side came, compared. A step can bring a deep way much closer without reaching a new line.
 */
function progressTable(base: Side, candidate: Side): string[] {
  const out = [
    "",
    "## Progress toward missed ways",
    "",
    "The closest any seed came to each way both sides missed with a measured part; closer is progress without a new line.",
    "",
    "| Unit | Ways measured | Closer | Further | Top closer | Top further |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const closestOf = (runs: readonly Run[]) => {
    const found = new Map<string, { needs: string; value: string; distance: number }>();
    for (const run of runs)
      for (const [way, closest] of run.closest) {
        const known = found.get(way);
        if (known === undefined || closest.distance < known.distance) found.set(way, closest);
      }
    return found;
  };
  for (const unit of units(base, candidate)) {
    const runs = pairs(base, candidate, unit);
    if (runs.length === 0) continue;
    const before = closestOf(runs.map((run) => run.base));
    const after = closestOf(runs.map((run) => run.candidate));
    const both = [...before.keys()].filter((way) => after.has(way));
    if (both.length === 0) continue;
    const changes = both.map((way) => ({
      way,
      base: before.get(way)!,
      candidate: after.get(way)!,
    }));
    const closer = changes
      .filter((change) => change.candidate.distance < change.base.distance)
      .sort(
        (left, right) =>
          right.base.distance -
          right.candidate.distance -
          (left.base.distance - left.candidate.distance),
      );
    const further = changes
      .filter((change) => change.candidate.distance > change.base.distance)
      .sort(
        (left, right) =>
          right.candidate.distance -
          right.base.distance -
          (left.candidate.distance - left.base.distance),
      );
    const example = (change: (typeof changes)[number]) =>
      `\`${change.way.split(":").slice(0, 2).join(":")}\` needs \`${change.base.needs}\`: ${change.base.value} → ${change.candidate.value}`;
    out.push(
      `| ${unit} | ${both.length} | ${closer.length} | ${further.length} | ${closer.slice(0, 2).map(example).join("; ")} | ` +
        `${further.slice(0, 2).map(example).join("; ")} |`,
    );
  }
  return out;
}
