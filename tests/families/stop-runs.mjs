// node tests/families/stop-runs.mjs <tree> <items.jsonl> [--shard i/N] --out <folder>
// A stop's runs against its unstopped compile's (#2080), on one built tree: for each item, the unit compiled unstopped
// and at the item's demand allowance in its mode, both plans run over host data made from the unit's own property names
// (`stopRuns`, `tests/helpers/type-core-stop-oracle.ts`: the stop oracle's violating runs, fed `hostValues`). An item is
// a line of JSON: a plans record's `{set, name, mode, demand}` (`mode` a `HELD_MODES` index; `set` as `plans.mjs` reads
// it: corpus with CASES_JSON, fixture, held, or an area of the tree's tests/families) or a records row's
// `{files, globals, label, demand}` (`label` src-on, src-off, rev-on or rev-off, a `MODES` mode). With `--shard i/N`,
// the items whose index k has k mod N = i. Writes `rows.jsonl` (the item without its files, and `stopRuns`' result) and
// `summary.json` (the items, each kind's count, missing units and exceptions) to `--out`; exit 0 when no item is `open`
// or `later` and none threw, else 1.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { unitsOf } from "./sources.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const [root, itemsFile] = args;
const out = option("--out");
if (root === undefined || itemsFile === undefined || out === undefined) {
  process.stderr.write(
    "usage: node tests/families/stop-runs.mjs <tree> <items.jsonl> [--shard i/N] --out <folder>\n",
  );
  process.exit(2);
}
const [shard, shards] = (option("--shard") ?? "0/1").split("/").map(Number);
const dist = existsSync(path.join(root, "dist")) ? path.join(root, "dist") : root;
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { stopRuns } = await load("tests/helpers/type-core-stop-oracle.js");
const { HELD_MODES } = await load("tests/helpers/type-core-held-host.js");
const { MODES, inMode } = await load("tests/helpers/type-core-oracles.js");

const items = readFileSync(itemsFile, "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line))
  .filter((_, at) => at % shards === shard);
// (an area of the tree's tests/families by its name, as `plans.mjs` reads a set)
const setOf = (set) =>
  ["corpus", "fixture", "held"].includes(set) || set.includes("/")
    ? set
    : path.join(root, "tests", "families", set);
const units = new Map();
const unitOf = async (item) => {
  if (item.files !== undefined) return { files: item.files, globals: item.globals };
  if (!units.has(item.set))
    units.set(
      item.set,
      new Map((await unitsOf(setOf(item.set), root, root)).map((unit) => [unit.name, unit])),
    );
  return units.get(item.set).get(item.name);
};
const modeOf = (item) => {
  if (item.label === undefined) return (make) => HELD_MODES[item.mode].run(make);
  const mode = MODES.find(
    (m) => `${m.reversed ? "rev" : "src"}-${m.unshared ? "off" : "on"}` === item.label,
  );
  return (make) => inMode(mode, make);
};

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "rows.jsonl"), "");
const summary = {
  shard: `${shard}/${shards}`,
  items: items.length,
  kinds: {},
  missing: 0,
  exceptions: 0,
};
for (const item of items) {
  const unit = await unitOf(item);
  const row = { item: { ...item, files: undefined } };
  if (unit === undefined) {
    summary.missing += 1;
    continue;
  }
  try {
    Object.assign(row, stopRuns(unit.files, unit.globals, modeOf(item), item.demand));
    summary.kinds[row.kind] = (summary.kinds[row.kind] ?? 0) + 1;
  } catch (error) {
    summary.exceptions += 1;
    row.exception = String(error?.stack ?? error).slice(0, 600);
  }
  appendFileSync(path.join(out, "rows.jsonl"), `${JSON.stringify(row)}\n`);
}
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary));
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(
  (summary.kinds.open ?? 0) + (summary.kinds.later ?? 0) + summary.exceptions === 0 ? 0 : 1,
);
