// The K/F tapes' mechanism census and the browser and Pixel cover sets (the gate's tape plan §4–§5), from the report
// lines `record.mjs` wrote. Per mechanism (`tests/gate/inventory.ts`: an action kind shown, an event kind, a
// settlement, an accepted op), how many complete prefixes and how many incomplete tapes met it; the mechanisms no tape
// met (with the policy's reason where the table cannot meet it) and those met only in incomplete tapes, listed apart;
// the proposal rows that made accepted inputs; and each cohort: its fixed packages, then the K packages greedy passes
// add, complete prefixes first, then incomplete tapes as such, until every mechanism a Node tape met is covered. Run in
// a built tree:
//   node tools/player-gate/tapes/census.mjs --out DIR --always NAME,... --pixel-f NAME,... REPORT.jsonl...
// The browser cohort fixes F's compiling packages, --always and the gate's fixtures (family G); the Pixel cohort F's
// --pixel-f ones, --always and the fixtures.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    out: { type: "string" },
    always: { type: "string", default: "" },
    "pixel-f": { type: "string", default: "" },
  },
  allowPositionals: true,
});
const { MECHANISMS, POLICY_RESIDUALS } = await import(
  pathToFileURL(resolve("dist/tests/gate/inventory.js")).href
);
const lines = positionals.flatMap((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line)),
);
const names = (list) => list.split(",").filter(Boolean);

const mechanisms = Object.fromEntries(
  MECHANISMS.map((key) => [key, { completeTapes: 0, incompleteTapes: 0 }]),
);
const rows = {};
const outcomes = {};
for (const line of lines) {
  outcomes[line.outcome.kind] = (outcomes[line.outcome.kind] ?? 0) + 1;
  const side = line.complete ? "completeTapes" : "incompleteTapes";
  for (const key of line.inventory) {
    // A key outside `MECHANISMS` is a gap in the inventory's list, reported rather than dropped.
    mechanisms[key] ??= { completeTapes: 0, incompleteTapes: 0, unlisted: true };
    mechanisms[key][side] += 1;
  }
  for (const row of Object.keys(line.mechanisms)) {
    rows[row] ??= { completeTapes: 0, incompleteTapes: 0 };
    rows[row][side] += 1;
  }
}
const keys = Object.keys(mechanisms).sort();
// What no tape met, each with the policy's reason where the table cannot meet it (`POLICY_RESIDUALS`).
const absent = keys
  .filter((key) => mechanisms[key].completeTapes + mechanisms[key].incompleteTapes === 0)
  .map((key) => ({ mechanism: key, policy: POLICY_RESIDUALS[key] ?? null }));
const incompleteOnly = keys.filter(
  (key) => mechanisms[key].completeTapes === 0 && mechanisms[key].incompleteTapes > 0,
);

// A cohort's target is every mechanism and row any Node tape met. The fixed packages first, then K's complete prefixes
// greedily, each adding the most uncovered; then K's incomplete tapes for what only they met, chosen as incomplete
// differentials. `incompleteOnly` names what the cohort covers only through such a tape.
const metBy = (line) => [
  ...line.inventory,
  ...Object.keys(line.mechanisms).map((row) => `row ${row}`),
];
const wanted = new Set(lines.flatMap(metBy));
function cohort(fixed) {
  const chosen = [...fixed];
  const covered = new Set(chosen.filter((line) => line.complete).flatMap(metBy));
  const add = (complete) => {
    for (;;) {
      const best = lines
        .filter(
          (line) => line.family === "K" && line.complete === complete && !chosen.includes(line),
        )
        .map((line) => ({
          line,
          gain: metBy(line).filter((key) => wanted.has(key) && !covered.has(key)).length,
        }))
        .sort((a, b) => b.gain - a.gain || a.line.package.localeCompare(b.line.package))[0];
      if (best === undefined || best.gain === 0) return;
      chosen.push(best.line);
      for (const key of metBy(best.line)) covered.add(key);
    }
  };
  add(true);
  const byComplete = new Set(covered);
  for (const line of chosen) if (!line.complete) for (const key of metBy(line)) covered.add(key);
  add(false);
  return {
    packages: chosen.map((line) => ({
      family: line.family,
      package: line.package,
      fixed: fixed.includes(line),
      complete: line.complete,
      projectSha256: line.projectSha256,
      tapeSha256: line.tapeSha256,
    })),
    incompleteOnly: [...covered].filter((key) => !byComplete.has(key)).sort(),
    uncovered: [...wanted].filter((key) => !covered.has(key)).sort(),
  };
}
const pixelF = names(values["pixel-f"]);
for (const name of [...names(values.always), ...pixelF])
  if (!lines.some((line) => line.package === name))
    throw new Error(`no report line for the named package ${name}`);
const always = lines.filter((line) => names(values.always).includes(line.package));
const fixtures = lines.filter((line) => line.family === "G");
const census = {
  packages: lines.length,
  outcomes,
  mechanisms,
  absent,
  incompleteOnly,
  rows,
  cohorts: {
    browser: cohort([
      ...lines.filter((line) => line.family === "F" && line.preparation === "prepared"),
      ...always,
      ...fixtures,
    ]),
    pixel: cohort([
      ...lines.filter((line) => line.family === "F" && pixelF.includes(line.package)),
      ...always,
      ...fixtures,
    ]),
  },
  disagreements: lines
    .filter((line) => line.oracle !== "agrees" || line.workerReplay !== "agrees")
    .map((line) => ({
      family: line.family,
      package: line.package,
      oracle: line.oracle,
      workerReplay: line.workerReplay,
    })),
};
writeFileSync(join(values.out, "census.json"), JSON.stringify(census, null, 2));
console.log(
  JSON.stringify({
    packages: census.packages,
    outcomes,
    absent: absent.length,
    incompleteOnly: incompleteOnly.length,
    browser: census.cohorts.browser.packages.length,
    pixel: census.cohorts.pixel.packages.length,
    disagreements: census.disagreements.length,
  }),
);
