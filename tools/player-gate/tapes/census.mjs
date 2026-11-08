// The K/F tapes' mechanism census and the browser and Pixel cover sets (the gate's tape plan §4–§5), from the report
// lines `record.mjs` wrote: per op and per row (the table row and value that proposed an accepted input), how many
// complete prefixes and how many incomplete tapes accepted it, and which ops were only declined; then the smallest
// greedy set of complete-prefix tapes covering every op and row met, always with the named packages.
//   node tools/player-gate/tapes/census.mjs --out DIR [--always NAME,...] REPORT.jsonl...
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: { out: { type: "string" }, always: { type: "string", default: "" } },
  allowPositionals: true,
});
const lines = positionals.flatMap((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line)),
);
const census = {
  ops: {},
  rows: {},
  declinedOnly: [],
  outcomes: {},
  packages: lines.length,
  disagreements: [],
};
const add = (table, key, complete) => {
  table[key] ??= { completeTapes: 0, incompleteTapes: 0 };
  table[key][complete ? "completeTapes" : "incompleteTapes"] += 1;
};
for (const line of lines) {
  census.outcomes[line.outcome.kind] = (census.outcomes[line.outcome.kind] ?? 0) + 1;
  for (const op of Object.keys(line.accepted)) add(census.ops, op, line.complete);
  for (const row of Object.keys(line.mechanisms)) add(census.rows, row, line.complete);
  if (line.oracle !== null || line.workerReplay !== null) census.disagreements.push(line.package);
}
const declinedOps = new Set(
  lines.flatMap((line) => Object.keys(line.declined).map((key) => key.split(":")[0])),
);
census.declinedOnly = [...declinedOps].filter((op) => !(op in census.ops)).sort();

// The cover set: the named packages, then complete prefixes greedily, each adding the most uncovered ops and rows.
const always = values.always.split(",").filter(Boolean);
const mechanismsOf = (line) => [
  ...Object.keys(line.accepted).map((op) => `op ${op}`),
  ...Object.keys(line.mechanisms).map((row) => `row ${row}`),
];
const wanted = new Set(lines.filter((line) => line.complete).flatMap(mechanismsOf));
const chosen = lines.filter((line) => always.includes(line.package));
const covered = new Set(chosen.flatMap(mechanismsOf));
for (;;) {
  const best = lines
    .filter((line) => line.complete && !chosen.includes(line))
    .map((line) => ({
      line,
      gain: mechanismsOf(line).filter(
        (mechanism) => wanted.has(mechanism) && !covered.has(mechanism),
      ).length,
    }))
    .sort((a, b) => b.gain - a.gain || a.line.package.localeCompare(b.line.package))[0];
  if (best === undefined || best.gain === 0) break;
  chosen.push(best.line);
  for (const mechanism of mechanismsOf(best.line)) covered.add(mechanism);
}
census.cover = chosen.map((line) => ({
  family: line.family,
  package: line.package,
  projectSha256: line.projectSha256,
  tapeSha256: line.tapeSha256,
}));
census.uncovered = [...wanted].filter((mechanism) => !covered.has(mechanism)).sort();
writeFileSync(join(values.out, "census.json"), JSON.stringify(census, null, 2));
console.log(
  JSON.stringify({
    packages: census.packages,
    outcomes: census.outcomes,
    ops: Object.keys(census.ops).length,
    rows: Object.keys(census.rows).length,
    declinedOnly: census.declinedOnly,
    cover: census.cover.length,
    uncovered: census.uncovered.length,
    disagreements: census.disagreements.length,
  }),
);
