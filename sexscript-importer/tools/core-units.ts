/**
 * The coverage of the core test set: what the units of a units file exercise of everything a converted corpus
 * exercises. A unit's features come from its published output:
 *
 * - `rule`: each SX_ diagnostic code in `.conversion.log` or the report's diagnostic counts, info lines (converter
 *   rules applied) and TODOs alike;
 * - `count`: each report counter of a converter rule above zero, such as `paragraphs.says` or `askQuestions`;
 * - `uses`: each engine name (`showButton`, `askForm`, ...) and each token kind (`keywordWhile`, `rangeExclusive`, ...)
 *   of the generated `.tease` files, through the engine's lexer;
 * - `pending`, `compile`, `smoke`, `project`, `final`: pending capabilities, compiler diagnostic codes, smoke-run
 *   statuses and failure codes, and whether the project and the final package compile and how the final package runs.
 *
 * It prints what each listed unit alone adds within the set, the corpus features no listed unit has with the units that
 * have them, and with `--suggest N` the N units a greedy set cover would add next (most new features first, then the
 * smallest generated source).
 *
 * Usage: node tools/core-units.ts [--units-file core-units.txt] [--suggest N] <converted-root>
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TEASESCRIPT_PROTECTED_NAMES } from "../../src/protected-names.ts";
import { isRecord } from "../src/ast.ts";
import { repositoryBuildUrl } from "../src/repository-build.ts";
import { readUnitsFile } from "./convert-corpus.ts";

const CORE_UNITS = fileURLToPath(new URL("../core-units.txt", import.meta.url));

/** Report numbers that measure size rather than count a converter rule. */
const SIZES = new Set([
  "fileCount",
  "scriptBodyFileCount",
  "recognizedScriptFileCount",
  "loweredScriptFileCount",
  "dependencyClosedScriptFileCount",
  "compilerCleanScriptFileCount",
  "compilerCleanExceptPendingScriptFileCount",
  "migrationCleanFileCount",
  "sourceStatementNodes",
  "emittedIrStatements",
  "smokeRunReachedScriptFileCount",
]);

const ENGINE_NAMES: ReadonlySet<string> = new Set(TEASESCRIPT_PROTECTED_NAMES);

interface Unit {
  id: string;
  features: Set<string>;
  /** Bytes of generated TeaseScript, the tie-breaker of the greedy cover. */
  size: number;
}

const { values, positionals } = parseArgs({
  options: { "units-file": { type: "string" }, suggest: { type: "string" } },
  allowPositionals: true,
});
const suggest = Number(values.suggest ?? 0);
if (positionals.length !== 1 || !Number.isInteger(suggest) || suggest < 0) {
  process.stderr.write(
    "Usage: node tools/core-units.ts [--units-file core-units.txt] [--suggest N] <converted-root>\n",
  );
  process.exit(2);
}
const root = path.resolve(positionals[0]!);
const listed = await readUnitsFile(values["units-file"] ?? CORE_UNITS);
const lex = await loadLexer();
const units = new Map<string, Unit>();
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  const unit = await unitFeatures(entry.name, path.join(root, entry.name));
  if (unit !== null) units.set(unit.id, unit);
}
const missing = listed.filter((id) => !units.has(id));
if (missing.length > 0) {
  process.stderr.write(`Not in ${root}: ${missing.join(", ")}\n`);
  process.exit(1);
}

const holders = new Map<string, string[]>();
for (const { id, features } of units.values())
  for (const feature of features) holders.set(feature, [...(holders.get(feature) ?? []), id]);
const covered = new Set(listed.flatMap((id) => [...units.get(id)!.features]));
const lines: string[] = [
  `${listed.length} listed units cover ${covered.size} of ${holders.size} features of ${units.size} units.`,
  "",
  "## What each listed unit alone adds",
];
for (const id of listed) {
  const own = [...units.get(id)!.features].filter((feature) =>
    listed.every((other) => other === id || !units.get(other)!.features.has(feature)),
  );
  lines.push(`- ${id} (${own.length}): ${own.sort().join(", ") || "-"}`);
}
lines.push("", "## Features no listed unit has, by the units that have them");
const uncovered = [...holders].filter(([feature]) => !covered.has(feature));
uncovered.sort(([a, left], [b, right]) => left.length - right.length || a.localeCompare(b));
for (const [feature, ids] of uncovered)
  lines.push(`- ${feature}: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", ..." : ""}`);
if (suggest > 0) {
  lines.push("", "## Greedy additions");
  for (let count = 0; count < suggest; count += 1) {
    let best: { unit: Unit; added: string[] } | null = null;
    for (const unit of units.values()) {
      if (listed.includes(unit.id)) continue;
      const added = [...unit.features].filter((feature) => !covered.has(feature));
      if (
        best === null ||
        added.length > best.added.length ||
        (added.length === best.added.length && unit.size < best.unit.size)
      )
        best = { unit, added };
    }
    if (best === null || best.added.length === 0) break;
    listed.push(best.unit.id);
    for (const feature of best.added) covered.add(feature);
    lines.push(`- ${best.unit.id} (${best.added.length}): ${best.added.sort().join(", ")}`);
  }
}
process.stdout.write(`${lines.join("\n")}\n`);

/** The features of one published unit, or null for a folder without a report. */
async function unitFeatures(id: string, folder: string): Promise<Unit | null> {
  const text = await readFile(path.join(folder, ".report.json"), "utf8").catch(() => null);
  if (text === null) return null;
  const report: unknown = JSON.parse(text);
  if (!isRecord(report)) return null;
  const features = new Set<string>();
  const log = await readFile(path.join(folder, ".conversion.log"), "utf8").catch(() => "");
  for (const [, code] of log.matchAll(/^\w+ (SX_[A-Z0-9_]+) /gmu)) features.add(`rule ${code}`);
  // The report lowers the sources again, also helper sources the log does not name, and `--report-only` leaves the log.
  for (const key of ["diagnosticsByCode", "rootDiagnosticsByCode"])
    for (const [code, count] of Object.entries(isRecord(report[key]) ? report[key] : {}))
      if (typeof count === "number" && count > 0) features.add(`rule ${code}`);
  for (const [key, value] of Object.entries(report)) {
    if (typeof value === "number" && value > 0 && !SIZES.has(key)) features.add(`count ${key}`);
    // Keyed counts (by code, message, or status) and the final package have features of their own below.
    if (isRecord(value) && !/(?:ByCode|ByMessage|Counts|Package)$/u.test(key))
      for (const [name, count] of Object.entries(value))
        if (typeof count === "number" && count > 0) features.add(`count ${key}.${name}`);
  }
  for (const key of ["pendingCapabilityFileCounts", "blockingPendingCapabilityFileCounts"])
    for (const name of Object.keys(isRecord(report[key]) ? report[key] : {}))
      features.add(`pending ${key.startsWith("blocking") ? "blocking " : ""}${name}`);
  for (const message of Object.keys(
    isRecord(report.compilerDiagnosticsByMessage) ? report.compilerDiagnosticsByMessage : {},
  ))
    features.add(`compile ${message.split(" ")[0]}`);
  for (const status of Object.keys(
    isRecord(report.smokeRunStatusCounts) ? report.smokeRunStatusCounts : {},
  ))
    features.add(`smoke ${status}`);
  for (const message of Object.keys(
    isRecord(report.smokeRunFailuresByMessage) ? report.smokeRunFailuresByMessage : {},
  ))
    features.add(`smoke failure ${/^(?:isolated )?\S+/u.exec(message)![0]}`);
  features.add(`project ${report.projectCompiles === true ? "compiles" : "does not compile"}`);
  const final = isRecord(report.finalPackage) ? report.finalPackage : null;
  if (final !== null) {
    features.add(`final ${final.compiles === true ? "compiles" : "does not compile"}`);
    if (Array.isArray(final.problems) && final.problems.length > 0) features.add("final problems");
    for (const message of Object.keys(isRecord(final.errorsByMessage) ? final.errorsByMessage : {}))
      features.add(`final error ${message.split(" ")[0]}`);
    const run = isRecord(final.run) ? final.run : null;
    if (run !== null) {
      features.add(`final run ${String(run.status)}`);
      if (isRecord(run.failure)) features.add(`final run failure ${String(run.failure.code)}`);
    }
  }
  let size = 0;
  for (const file of await readdir(folder, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tease") || file.startsWith(".")) continue;
    const source = await readFile(path.join(folder, file), "utf8");
    size += source.length;
    for (const token of lex(source)) {
      if (token.kind !== "identifier") features.add(`uses ${token.kind}`);
      else if (ENGINE_NAMES.has(token.lexeme)) features.add(`uses ${token.lexeme}`);
    }
  }
  return { id, features, size };
}

/** The engine's lexer from the repository build: the kind and text of each token of a source. */
async function loadLexer(): Promise<(source: string) => Array<{ kind: string; lexeme: string }>> {
  const module: unknown = await import(repositoryBuildUrl("src/index.js").href);
  const lexer = isRecord(module) ? module.lex : undefined;
  if (typeof lexer !== "function") throw new Error("Repository build does not export lex().");
  return (source) => {
    const result: unknown = lexer(source);
    const tokens = isRecord(result) && Array.isArray(result.tokens) ? result.tokens : [];
    return tokens
      .filter(isRecord)
      .map((token) => ({ kind: String(token.kind), lexeme: String(token.lexeme) }));
  };
}
