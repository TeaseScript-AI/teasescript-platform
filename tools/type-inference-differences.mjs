// The facts differential's report and pins (O4 stage 3a, work note §7). Runs on the built output:
//   node tools/type-inference-differences.mjs <dist> report   the grouped counts and every unrecorded difference
//   node tools/type-inference-differences.mjs <dist> pin      rewrite the deferred pins for the mechanical groups
// `pin` writes tests/fixtures/type-inference/deferred-differences.jsonl: one group record per mechanical group and one
// pinned row per difference of those groups, sorted; a difference outside them that has no reviewed record is
// printed and makes the exit status 1 (it needs a reviewed entry in accepted-differences.jsonl, or a repair).
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [dist, mode = "report"] = process.argv.slice(2);
if (dist === undefined || !["report", "pin"].includes(mode)) {
  console.error("usage: node tools/type-inference-differences.mjs <dist> report|pin");
  process.exit(2);
}
const helper = await import(
  pathToFileURL(resolve(dist, "tests/helpers/facts-differential.js")).href
);
const { differential, readLedger, verdicts, mechanicalGroup, summarize, describe, recordKey } =
  helper;

const FIXTURE = resolve("tests/fixtures/type-inference/solver-cases.jsonl");
const PINS = resolve("tests/fixtures/type-inference/deferred-differences.jsonl");
const GROUPS = [
  {
    group: "3b-values",
    reason:
      "expression facts are the solver's cell types at their sites; the legacy's are the types at the point",
    obligation: "PR 3b: the point domain (work note §4)",
  },
  {
    group: "3c-functions",
    reason: "function results are not solved in 3a",
    obligation: "PR 3c: functions (work note §5)",
  },
  {
    group: "3b-flow",
    reason:
      "a source with control flow, loops, handlers, storage, speakers or calls: its bindings wait for the point domain and the flow table",
    obligation: "PR 3b, 3c (work note §4, §5)",
  },
];

const cases = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));
const ledger = readLedger();
const all = [];
const pins = [];
for (const c of cases) {
  const result = differential(c.files ?? c.source);
  if (result === null) continue;
  for (const v of verdicts(ledger, c.name, result)) {
    const group = mechanicalGroup(result.straightLine, v.difference);
    if (
      mode === "pin" &&
      group !== null &&
      (v.outcome === "unrecorded" || v.outcome === "changed" || v.record?.group === group)
    ) {
      pins.push({
        case: c.name,
        what: v.difference.what,
        name: v.difference.name,
        site: `${v.difference.site.file}:${v.difference.site.start}:${v.difference.site.end}`,
        legacy: v.difference.legacy,
        candidate: v.difference.candidate,
        status: "deferred",
        group,
      });
      continue;
    }
    all.push(v);
  }
}
if (mode === "pin") {
  const start = (pin) => Number(pin.site.split(":")[1]);
  pins.sort((a, b) => (a.case < b.case ? -1 : a.case > b.case ? 1 : start(a) - start(b)));
  const lines = [...GROUPS, ...pins].map((row) => JSON.stringify(row));
  writeFileSync(PINS, `${lines.join("\n")}\n`);
  console.log(`pinned ${pins.length} differences of ${GROUPS.length} groups into ${PINS}`);
}
const counts = summarize(all);
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${count}\t${key}`);
const failing = all.filter((v) => v.outcome === "unrecorded" || v.outcome === "changed");
for (const v of failing)
  console.log(`${v.outcome}: ${describe(v)} (${recordKey(v.case, v.difference)})`);
process.exit(failing.length === 0 ? 0 : 1);
