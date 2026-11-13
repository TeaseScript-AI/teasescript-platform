// The whole frozen survey's count (#1072 step 1b, docs/TESTING.md, "Frozen retained state"): what every type-core test
// file wrote in a survey (`RETAINED_SURVEY=<folder>`, `tests/helpers/retained-instrument-preload.ts`), one JSON file per
// test process, read from the folders given and every folder below them (a gathered queue campaign included). It prints
// the files surveyed, the shapes refused and the writes to frozen data, then each refusal and frozen write by its
// count, and names each test file of `tests/type-core/` and `tests/type-core-stop/`, a folder down in either included
// (as the suite reads them, `suiteTestFiles`, from the working directory), that wrote no survey.
//
//   node tools/retained-survey.mjs FOLDER...
//
// Exit 0: every type-core test file surveyed, no refusal and no frozen write; 1: any of them missing or noted; 2: usage.
// Whether the tests passed is not in these files: the runs' own exits say it.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { suiteTestFiles } from "./test-runner/test-shards.mjs";

/** Each survey under `folder` and below it: a JSON object naming its `file` with its `noted` and `frozen` counts. */
function surveys(folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8"));
    if (
      typeof value?.file === "string" &&
      typeof value.noted === "object" &&
      typeof value.frozen === "object"
    )
      found.push(value);
  }
  return found;
}

/** The sum of the counts of `entries` by their key, over every survey. */
function add(total, entries) {
  for (const [key, count] of Object.entries(entries)) total.set(key, (total.get(key) ?? 0) + count);
}

const folders = process.argv.slice(2);
if (folders.length === 0 || folders.some((folder) => folder.startsWith("-"))) {
  process.stderr.write("usage: node tools/retained-survey.mjs FOLDER...\n");
  process.exit(2);
}
const files = new Set();
const noted = new Map();
const frozen = new Map();
for (const survey of folders.flatMap(surveys)) {
  files.add(survey.file.replace(/\.js$/u, ""));
  add(noted, survey.noted);
  add(frozen, survey.frozen);
}
const sum = (counts) => [...counts.values()].reduce((a, b) => a + b, 0);
const missing = suiteTestFiles("tests", ".test.ts")
  .filter((path) => /^type-core(-stop)?\//u.test(path))
  .map((path) => basename(path, ".ts"))
  .filter((name) => !files.has(name))
  .sort();
process.stdout.write(
  `retained survey: ${files.size} files, ${sum(noted)} refusals, ${sum(frozen)} frozen writes\n`,
);
for (const [title, counts] of [
  ["refused", noted],
  ["frozen write", frozen],
])
  for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]))
    process.stdout.write(`  ${title} ${count}x: ${key}\n`);
for (const name of missing) process.stdout.write(`  not surveyed: ${name}\n`);
process.exitCode = missing.length + noted.size + frozen.size > 0 ? 1 : 0;
