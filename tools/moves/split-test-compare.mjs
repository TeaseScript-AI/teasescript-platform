// Whether test files moved or split keep their tests: the suite finds the new files and no longer the old ones, the
// same tests run, by title, and their results are the same. Run in one queue job with two built checkouts, the change's
// base and its head (any two):
//
//   node tools/moves/split-test-compare.mjs BASE_TREE HEAD_TREE OUT --old FILE… --new FILE…
//
// FILEs are test files as the repository names them. A file under `tests/` (`tests/type-core/x.test.ts`) runs as its
// compiled file under that tree's `dist/` (`dist/tests/type-core/x.test.js`); any other (`tools/x.test.mjs`) runs as it
// is. OUT is a folder (the job's `$SX_OUT`). A FILE may be on both sides (a split that keeps its file).
//
// 1. Discovery, when a FILE is under `tests/`, by this tool's rule (`suiteTestFiles` of `tools/test-shards.mjs`) over
//    each tree's `dist/tests/`: the base's suite holds each OLD file, the head's each NEW file and no OLD file that is
//    not also NEW, and the suite is otherwise the same on both sides. A difference ends the check (exit 1) before any
//    test runs.
// 2. Each side's files run under `node --test` in their tree with two reporters: `tools/test-file-counts.mjs` (the
//    results of each file in node:test's classes, which `test-output-filter.mjs` counts by; `base-counts.json`,
//    `head-counts.json`), and this file's default export, which writes each test's and suite's title and nesting, no
//    result (`base-titles.jsonl`, `head-titles.jsonl`). The counts say how the tests ended; the titles, which tests
//    they are: a test lost beside one added keeps the counts and changes the titles.
// 3. The comparison (`compare.txt`): equal when the titles are the same, each as many times on both sides (a title may
//    repeat, in different suites or files), the summed counts are the same in each class, and no test failed or was
//    cancelled and no file failed outside its tests, on either side.
// 4. Its own controls, run whenever it finds the two sides equal: the head with one title dropped, and with one
//    passed test counted as failed, must each compare unequal; if either compares equal, the comparison cannot judge.
//
// Exit status: 0 equal; 1 not (discovery, a difference, a failure); 2 cannot run (usage, a FILE that is no test file
// or that a tree lacks, no test reported, a control that passed).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { suiteTestFiles } from "../test-shards.mjs";

const USAGE =
  "usage: node tools/moves/split-test-compare.mjs BASE_TREE HEAD_TREE OUT --old FILE… --new FILE…";
const SELF = fileURLToPath(import.meta.url);
const COUNTS = fileURLToPath(new URL("../test-file-counts.mjs", import.meta.url));
const CLASSES = ["passed", "failed", "cancelled", "skipped", "todo"];

/** The titles reporter: one JSON line per finished test or suite, its nesting and title. */
export default async function* titles(source) {
  for await (const { type, data } of source)
    if ((type === "test:pass" || type === "test:fail") && data.entryFile !== undefined)
      yield `${JSON.stringify({ nesting: data.nesting, name: data.name })}\n`;
}

class CannotRun extends Error {}

/** Where a FILE runs in a tree: a test file under `tests/` compiled under `dist/`, any other as it is. */
function runPath(file) {
  if (/^tests\/.+\.test\.ts$/u.test(file)) return `dist/${file.replace(/\.ts$/u, ".js")}`;
  if (/\.test\.(?:m?js|cjs)$/u.test(file)) return file;
  throw new CannotRun(`${file} is no test file`);
}

/** Where the suite's discovery disagrees with the change: a list of sentences, empty when it agrees. */
export function discoveryProblems(baseSuite, headSuite, olds, news) {
  const problems = [];
  const [base, head, moved] = [new Set(baseSuite), new Set(headSuite), new Set([...olds, ...news])];
  for (const name of olds)
    if (!base.has(name)) problems.push(`the base's suite does not hold ${name}`);
  for (const name of olds)
    if (head.has(name) && !news.includes(name))
      problems.push(`the head's suite still holds ${name}`);
  for (const name of news)
    if (!head.has(name)) problems.push(`the head's suite does not hold ${name}`);
  for (const name of baseSuite)
    if (!moved.has(name) && !head.has(name)) problems.push(`the head's suite lost ${name}`);
  for (const name of headSuite)
    if (!moved.has(name) && !base.has(name)) problems.push(`the head's suite gained ${name}`);
  return problems;
}

/** A side's summed counts (`test-file-counts.mjs`'s object of files) and whether a file failed outside its tests. */
export function summed(counts) {
  const sum = Object.fromEntries(CLASSES.map((name) => [name, 0]));
  let fileFailed = false;
  for (const count of Object.values(counts)) {
    for (const name of CLASSES) sum[name] += count[name];
    fileFailed ||= count.fileFailed === true;
  }
  return { ...sum, fileFailed };
}

/** The comparison of two sides (each `{ titles, counts }`, counts summed): `{ equal, lines }`, `lines` the report. */
export function compareSides(base, head) {
  const tally = (titles) => {
    const keys = new Map();
    for (const { nesting, name } of titles) {
      const key = `${nesting} ${name}`;
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    return keys;
  };
  const [before, after] = [tally(base.titles), tally(head.titles)];
  const shown = (counts) => CLASSES.map((name) => `${name} ${counts[name]}`).join(", ");
  const lines = [`base: ${shown(base.counts)}; head: ${shown(head.counts)}`];
  for (const [key, n] of before)
    if ((after.get(key) ?? 0) < n)
      lines.push(`missing at head: ${key} (${n - (after.get(key) ?? 0)})`);
  for (const [key, n] of after)
    if ((before.get(key) ?? 0) < n)
      lines.push(`added at head: ${key} (${n - (before.get(key) ?? 0)})`);
  for (const name of CLASSES)
    if (base.counts[name] !== head.counts[name])
      lines.push(`${name} differs: ${base.counts[name]} -> ${head.counts[name]}`);
  for (const [side, { counts }] of [
    ["base", base],
    ["head", head],
  ])
    if (counts.failed > 0 || counts.cancelled > 0 || counts.fileFailed)
      lines.push(
        `failed at ${side}: ${counts.failed} failed, ${counts.cancelled} cancelled${counts.fileFailed ? ", a file failed" : ""}`,
      );
  return { equal: lines.length === 1, lines };
}

/** The controls of a comparison: `compare` must find a dropped title and a passed test counted as failed. */
export function controlFailures(base, head, compare = compareSides) {
  const failures = [];
  if (compare(base, { ...head, titles: head.titles.slice(1) }).equal)
    failures.push("a dropped title compared equal");
  const flipped = {
    ...head.counts,
    passed: head.counts.passed - 1,
    failed: head.counts.failed + 1,
  };
  if (compare(base, { ...head, counts: flipped }).equal)
    failures.push("a passed test counted as failed compared equal");
  return failures;
}

/** Runs `files` in `tree` with both reporters; returns the side's titles and summed counts. */
function run(tree, files, out, side) {
  const [countsFile, titlesFile] = [`${side}-counts.json`, `${side}-titles.jsonl`].map((name) =>
    path.join(out, name),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      `--test-reporter=${COUNTS}`,
      `--test-reporter-destination=${countsFile}`,
      `--test-reporter=${SELF}`,
      `--test-reporter-destination=${titlesFile}`,
      ...files,
    ],
    // (without the variable a surrounding `node --test` sets, by which a run reports to it and not to its own reporters)
    {
      cwd: tree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  writeFileSync(path.join(out, `${side}-stderr.txt`), result.stderr);
  if (!existsSync(countsFile) || !existsSync(titlesFile))
    throw new CannotRun(`the ${side}'s run reported nothing (${side}-stderr.txt)`);
  const counts = summed(JSON.parse(readFileSync(countsFile, "utf8")));
  const titles = readFileSync(titlesFile, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  if (titles.length === 0)
    throw new CannotRun(`the ${side}'s run reported no test (${side}-stderr.txt)`);
  return { titles, counts };
}

/** Runs the comparison with `argv` (`compare` the comparison, replaceable to test its controls); returns the status. */
export function main(argv, print = console.log, compare = compareSides) {
  try {
    const positional = [];
    const lists = { "--old": [], "--new": [] };
    for (let i = 0; i < argv.length; i += 1) {
      const list = lists[argv[i]];
      if (list !== undefined)
        while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) list.push(argv[++i]);
      else if (argv[i].startsWith("-")) throw new CannotRun(USAGE);
      else positional.push(argv[i]);
    }
    const [olds, news] = [lists["--old"], lists["--new"]];
    if (positional.length !== 3 || olds.length === 0 || news.length === 0)
      throw new CannotRun(USAGE);
    const [baseTree, headTree, out] = positional.map((p) => path.resolve(p));
    const [oldPaths, newPaths] = [olds.map(runPath), news.map(runPath)];
    for (const [tree, paths] of [
      [baseTree, oldPaths],
      [headTree, newPaths],
    ])
      for (const file of paths)
        if (!existsSync(path.join(tree, file))) throw new CannotRun(`${tree} has no ${file}`);
    mkdirSync(out, { recursive: true });
    const suiteNames = (paths) =>
      paths.filter((p) => p.startsWith("dist/tests/")).map((p) => p.slice("dist/tests/".length));
    const [baseSuite, headSuite] = [baseTree, headTree].map((tree) =>
      existsSync(path.join(tree, "dist", "tests"))
        ? suiteTestFiles(path.join(tree, "dist", "tests"), ".test.js")
        : [],
    );
    const [oldNames, newNames] = [suiteNames(oldPaths), suiteNames(newPaths)];
    const problems =
      oldNames.length + newNames.length === 0
        ? []
        : discoveryProblems(baseSuite, headSuite, oldNames, newNames);
    const report = problems.map((problem) => `discovery: ${problem}`);
    let status = problems.length > 0 ? 1 : 0;
    if (problems.length === 0) {
      const base = run(baseTree, oldPaths, out, "base");
      const head = run(headTree, newPaths, out, "head");
      const { equal, lines } = compare(base, head);
      // (the controls guard a verdict of equal: only there can a comparison that sees nothing pass)
      const controls = equal ? controlFailures(base, head, compare) : [];
      report.push(...lines, ...controls.map((failure) => `control: ${failure}`));
      status = controls.length > 0 ? 2 : equal ? 0 : 1;
    }
    report.push(`verdict: ${["equal", "not equal", "cannot judge"][status]}`);
    writeFileSync(path.join(out, "compare.txt"), `${report.join("\n")}\n`);
    for (const line of report) print(line);
    return status;
  } catch (error) {
    if (!(error instanceof CannotRun)) throw error;
    console.error(`split-test-compare: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && SELF === path.resolve(process.argv[1]))
  process.exitCode = main(process.argv.slice(2));
