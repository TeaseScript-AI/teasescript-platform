// node tests/families/run.mjs <area> <base> <head> [--sizes 4,8] [--allowances natural,16,256] [--shard i/N]
//   [--out differences.jsonl]
// Runs every generator of tests/families/<area>/ against two built trees (a checkout with `dist/`, or `dist/` itself),
// in the four modes (source and reversed order, the sharing on and off), and compares what the sources publish
// (`publication`) and, for a generator whose `checks` include "stops", which decisions stop and when (`stopSet`) at each
// demand allowance. Each tree's own oracle library (`dist/tests/helpers/type-core-oracles.js`) analyses its sources.
// Prints one JSON line per generator and a total: sources, modes, runs, differences.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GLOBALS = ["hostValue", "hostOther", "hostInit"];

const [area, baseRoot, headRoot, ...rest] = process.argv.slice(2);
if (area === undefined || baseRoot === undefined || headRoot === undefined) {
  console.error("usage: node tests/families/run.mjs <area> <base> <head> [options]");
  process.exit(2);
}
const option = (name) => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? undefined : rest[index + 1];
};
const sizesOption = option("sizes")?.split(",").map(Number);
const allowances = (option("allowances") ?? "natural,16,256")
  .split(",")
  .map((text) => (text === "natural" ? null : Number(text)));
const [shard, shards] = (option("shard") ?? "0/1").split("/").map(Number);
const out = option("out");
if (out !== undefined) writeFileSync(out, "");

/** A tree's oracle library, from its `dist/`. */
async function oracles(root) {
  const dist = existsSync(path.join(root, "dist", "tests")) ? path.join(root, "dist") : root;
  const file = path.join(dist, "tests", "helpers", "type-core-oracles.js");
  if (!existsSync(file)) throw new Error(`no oracle library at ${file}: build the tree first`);
  return import(pathToFileURL(file).href);
}

const [base, head] = await Promise.all([oracles(baseRoot), oracles(headRoot)]);
const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), area);
const generators = readdirSync(folder)
  .filter((name) => name.endsWith(".mjs"))
  .sort();

/** A generator's sources: its fixed `cases`, or each of its `shapes` at each size. */
function sourcesOf(generator) {
  const files = (value) =>
    typeof value === "string" ? [{ path: "main.tease", source: value }] : value;
  if (generator.cases !== undefined)
    return generator.cases.map(([name, value]) => ({ name, files: files(value) }));
  return (sizesOption ?? generator.sizes ?? [4, 8]).flatMap((size) =>
    Object.entries(generator.shapes).map(([name, shape]) => ({
      name: `${name}@${size}`,
      files: files(shape(size)),
    })),
  );
}

/** What `run` returns, as text; an exception's message where it throws (both trees are held to the same). */
function attempt(run) {
  try {
    return JSON.stringify(run());
  } catch (error) {
    return `error: ${String(error).slice(0, 300)}`;
  }
}

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const total = { area, generators: 0, sources: 0, unparsed: 0, modes: 4, runs: 0, differences: 0 };
for (const name of generators) {
  const generator = await import(pathToFileURL(path.join(folder, name)).href);
  const checks = generator.checks ?? ["publication"];
  const row = { generator: name, sources: 0, unparsed: 0, runs: 0, differences: 0 };
  sourcesOf(generator).forEach((source, index) => {
    if (index % shards !== shard) return;
    row.sources += 1;
    let parsed = true;
    for (const mode of head.MODES) {
      const runs = [];
      if (checks.includes("publication"))
        runs.push(["publication", (oracle) => oracle.publication(source.files, mode, GLOBALS)]);
      if (checks.includes("stops"))
        for (const allowance of allowances)
          runs.push([
            `stops ${allowance ?? "natural"}`,
            (oracle) => oracle.stopSet(source.files, mode, GLOBALS, allowance),
          ]);
      for (const [check, run] of runs) {
        const [was, is] = [attempt(() => run(base)), attempt(() => run(head))];
        if (is === "null") parsed = false;
        row.runs += 1;
        if (was === is) continue;
        row.differences += 1;
        if (out !== undefined)
          appendFileSync(
            out,
            `${JSON.stringify({
              generator: name,
              source: source.name,
              mode: `${mode.reversed ? "rev" : "src"}-${mode.unshared ? "off" : "on"}`,
              check,
              base: hash(was),
              head: hash(is),
              files: source.files,
            })}\n`,
          );
      }
    }
    if (!parsed) row.unparsed += 1;
  });
  console.log(JSON.stringify(row));
  total.generators += 1;
  for (const key of ["sources", "unparsed", "runs", "differences"]) total[key] += row[key];
}
console.log(JSON.stringify({ ...total, node: process.version }));
process.exitCode = total.differences === 0 ? 0 : 1;
