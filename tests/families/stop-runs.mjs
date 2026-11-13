// node tests/families/stop-runs.mjs <tree> <items.jsonl> [--shard i/N] --out <folder>
// A stop's runs against its unstopped compile's (#2080), on one built tree: for each item, the unit compiled unstopped
// and at the item's demand allowance in its mode, both plans run over host data (`stopRuns`, `hostValues`,
// `tests/helpers/type-core-stop-runs.ts`). It claims only what it demonstrates (#2142, under
// docs/DEVELOPMENT-WORKFLOW.md#review-convergence): positive escapes are the blockers, an unwitnessed cell is unresolved
// evidence (#2080's design round). `open` and `later` are shown escapes, `closed` means the two plans are equal, and
// every other difference is `unwitnessed`, never proof that no check is owed.
// An item is a line of JSON: a plans record's `{set, name, key?, mode, demand}` (`mode` a `HELD_MODES` name; a number, a
// record's from before #2342, is read as an index into this tree's `HELD_MODES`, which is right only where its order is
// the one at the commit that wrote the record; `set` as `plans.mjs` reads it: corpus with CASES_JSON, fixture, held, or
// an area of the tree's tests/families; `key` the unit's `sourceKey`, `units.mjs`) or a records row's `{files, globals, label, demand}` (`label` src-on, src-off, rev-on or
// rev-off, a `MODES` mode). A set's item names the units of its name and, given one, its key: units that differ under
// one name are never picked between (#2254), so such an item without a key is `ambiguous`. With `--shard i/N`, the
// items whose index k has k mod N = i. Writes `rows.jsonl` (the item without its files, the `key` of the unit run, and
// `stopRuns`' result; a missing unit's row marked `missing`, an ambiguous item's `ambiguous` with the keys it matches)
// and `summary.json` (the items, each kind's count, missing units, ambiguous items and exceptions) to `--out`. Exit 0
// when no item is `open` or `later`, none is missing or ambiguous and none threw, else 1 (`unwitnessed` is counted, not
// failed); 2 on a usage error or a bad `--shard`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { unitResolver } from "./units.mjs";

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
if (
  !Number.isInteger(shard) ||
  !Number.isInteger(shards) ||
  shards < 1 ||
  shard < 0 ||
  shard >= shards
) {
  process.stderr.write(`--shard ${option("--shard")} is no shard i/N with 0 <= i < N\n`);
  process.exit(2);
}
const dist = existsSync(path.join(root, "dist")) ? path.join(root, "dist") : root;
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { stopRuns } = await load("tests/helpers/type-core-stop-runs.js");
const { HELD_MODES } = await load("tests/helpers/type-core-held-host.js");
const { MODES, inMode } = await load("tests/helpers/type-core-oracles.js");

const items = readFileSync(itemsFile, "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line))
  .filter((_, at) => at % shards === shard);
const unitOf = unitResolver(root);
const modeOf = (item) => {
  if (item.label === undefined) {
    // (a name since #2342; a number, a record's from before it, as its index)
    const held =
      typeof item.mode === "string"
        ? HELD_MODES.find((mode) => mode.name === item.mode)
        : HELD_MODES[item.mode];
    if (held === undefined) throw new Error(`no held mode ${JSON.stringify(item.mode)}`);
    return (make) => held.run(make);
  }
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
  ambiguous: 0,
  exceptions: 0,
};
for (const item of items) {
  const row = { item: { ...item, files: undefined } };
  try {
    const { unit, keys } = await unitOf(item);
    if (keys !== undefined) {
      summary.ambiguous += 1;
      row.ambiguous = keys;
    } else if (unit === undefined) {
      summary.missing += 1;
      row.missing = true;
    } else {
      row.key = unit.key;
      Object.assign(row, stopRuns(unit.files, unit.globals, modeOf(item), item.demand));
      summary.kinds[row.kind] = (summary.kinds[row.kind] ?? 0) + 1;
    }
  } catch (error) {
    summary.exceptions += 1;
    row.exception = String(error?.stack ?? error).slice(0, 600);
  }
  appendFileSync(path.join(out, "rows.jsonl"), `${JSON.stringify(row)}\n`);
}
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary));
process.stdout.write(`${JSON.stringify(summary)}\n`);
// (a missing or ambiguous unit, an exception, or an escape a run showed: never a pass)
const failed =
  ["open", "later"].reduce((sum, kind) => sum + (summary.kinds[kind] ?? 0), 0) +
  summary.missing +
  summary.ambiguous +
  summary.exceptions;
process.exit(failed === 0 ? 0 : 1);
