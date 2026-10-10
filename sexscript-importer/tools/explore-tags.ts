/**
 * Tags units by the problem classes the explorer meets, read from their compiled plans, so that a change aimed at a
 * class can be gated on the units of that class (plus a few controls) at a larger budget:
 *
 * - `clock-saves`: saves a value read from the clock, such as the time of a visit that a later session compares;
 * - `session-counters`: saves a stored key from its own load, such as a count of visits or of points;
 * - `random`: draws at random at many places ({@link RANDOM_SITES_PER_THOUSAND_LINES} or more per thousand lines);
 * - `typed-asks`: compares a typed answer with a constant;
 * - `large`: has {@link LARGE_LINES} or more coverable lines, so its sessions are long.
 *
 * Usage: node tools/explore-tags.ts <unit-dir>... [--class <tag>]
 *
 * Writes a Markdown table of the units and their tags, or with `--class`, the folders of the units with that tag, one
 * per line. Needs the repository build (`npm run build:typescript` in the repository root).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";
import { loadRepositoryPackageScanner } from "../src/compile-check.ts";
import { DataFlow, goalsFor } from "../src/explorer-analysis.ts";
import { instructionFiles } from "../src/explorer-search.ts";
import { loadEngine, type Data } from "../src/explorer.ts";
import { repositoryBuildUrl } from "../src/repository-build.ts";

/** Random draw sites per thousand coverable lines from which a unit counts as random. */
const RANDOM_SITES_PER_THOUSAND_LINES = 100;
/** Coverable lines from which a unit counts as large. */
const LARGE_LINES = 5000;
const TAGS = ["clock-saves", "session-counters", "random", "typed-asks", "large"] as const;
type Tag = (typeof TAGS)[number];

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { class: { type: "string" } },
  });
  if (positionals.length === 0 || (values.class !== undefined && !isTag(values.class))) {
    process.stderr.write(
      `Usage: node tools/explore-tags.ts <unit-dir>... [--class ${TAGS.join("|")}]\n`,
    );
    process.exit(2);
  }
  const engine = await loadEngine();
  // The runtime's own list of the places that draw at random.
  const runtime: unknown = await import(repositoryBuildUrl("src/index.js").href);
  const listRandomSites = isRecord(runtime) ? runtime.listRandomSites : undefined;
  if (typeof listRandomSites !== "function")
    throw new Error("The repository build does not export listRandomSites().");
  const scan = await loadRepositoryPackageScanner();
  const rows: { dir: string; tags: Tag[]; note: string }[] = [];
  for (const dir of positionals.map((folder) => path.resolve(folder))) {
    const folder = await scan(dir);
    const { plan } = engine.compileProject(folder.sources, { builtins: [], images: folder.images });
    if (!isRecord(plan)) {
      rows.push({ dir, tags: [], note: "does not compile" });
      continue;
    }
    const sites: unknown = listRandomSites(plan);
    const found = tagsOf(plan, Array.isArray(sites) ? sites.length : 0);
    rows.push({ dir, tags: found.tags, note: found.note });
  }
  const wanted = values.class;
  if (wanted !== undefined) {
    for (const row of rows)
      if (row.tags.some((tag) => tag === wanted)) process.stdout.write(`${row.dir}\n`);
    return;
  }
  const out = ["| Unit | Tags | Figures |", "| --- | --- | --- |"];
  for (const row of rows)
    out.push(`| ${path.basename(row.dir)} | ${row.tags.join(", ") || "-"} | ${row.note} |`);
  process.stdout.write(`${out.join("\n")}\n`);
}

function isTag(value: string): value is Tag {
  return TAGS.some((tag) => tag === value);
}

function list(value: unknown): Data[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** A stored key as the code writes it: its text, or a template with `*` for each computed part. */
function keyOf(expression: unknown): string | null {
  if (!isRecord(expression)) return null;
  if (expression.kind === "literal" && typeof expression.value === "string")
    return expression.value;
  if (expression.kind !== "template") return null;
  return list(expression.parts)
    .map((part) => (part.kind === "text" && typeof part.value === "string" ? part.value : "*"))
    .join("");
}

/** The tags of a plan, and the figures they come from. */
function tagsOf(plan: Data, randomSites: number): { tags: Tag[]; note: string } {
  const instructions = list(plan.instructions);
  const files = instructionFiles(plan);
  const flow = new DataFlow(plan, instructions);
  const clockSaves = new Set<string>();
  const counters = new Set<string>();
  let typedAsks = 0;
  const lines = new Set<string>();
  instructions.forEach((instruction, index) => {
    const span = isRecord(instruction.span) ? instruction.span : {};
    if (typeof span.sl === "number") lines.add(`${files[index]}:${span.sl}`);
    if (instruction.kind === "storageWrite") {
      const key = keyOf(instruction.key);
      if (key === null || instruction.value === null) return;
      const value = flow.flowOf(instruction.value);
      if (value.clock) clockSaves.add(key);
      // A save of a value that comes from the same key's load: the key counts across sessions.
      if ([...value.keys].some((read) => read.replaceAll("\u0000", "*") === key)) counters.add(key);
    }
    if (instruction.kind === "jumpIfFalse") {
      const condition = instruction.condition;
      if (
        [true, false].some((wanted) =>
          goalsFor(flow, condition, wanted).some((goal) => goal.source.kind === "ask"),
        )
      )
        typedAsks += 1;
    }
  });
  const tags: Tag[] = [];
  if (clockSaves.size > 0) tags.push("clock-saves");
  if (counters.size > 0) tags.push("session-counters");
  if (randomSites * 1000 >= RANDOM_SITES_PER_THOUSAND_LINES * lines.size) tags.push("random");
  if (typedAsks > 0) tags.push("typed-asks");
  if (lines.size >= LARGE_LINES) tags.push("large");
  return {
    tags,
    note:
      `${clockSaves.size} clock saves, ${counters.size} counted keys, ${randomSites} random sites, ` +
      `${typedAsks} typed-answer conditions, ${lines.size} lines`,
  };
}
