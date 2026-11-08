import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUNDS, refusalsOf } from "./pin-grounds.mjs";

// The suites that pin the type core's exact work, the focused list a change needs, and the ground a re-pin needs:
//
//   node tools/repository-checks/pin-suites.mjs [--base <ref>] [--run] [--check-grounds]
//
// `PIN_SUITES` declares the suites: each one pins a whole-analysis count (a work total, a table of totals or of `main`'s
// recorded work as bounds, a count of listed copy or construction sites), so any change under `src/type-inference/core/`
// can move it, and the suite itself is listed when it or the file holding its pins changes. The changes are those since
// the merge-base of HEAD and `--base` (default `origin/main`), committed or not, untracked files included, as
// `check-changed.mjs` reads them. A change to a test helper lists only the suites whose pins it holds (`in`), not every
// suite that imports it.
//
// Without options it prints the pinning suites the changes reach, one `dist/tests/…` line each, or `none`; exit 0.
// `--run` runs them through `tools/test-output-filter.mjs` (built tests are needed: `npm run build:typescript`); exit 1
// when one fails. `--check-grounds` reads each changed file holding a suite's pins, at the merge-base and at the head,
// by `pin-grounds.mjs`, whose header says what it refuses; exit 1 naming each refusal, with the time the reading took.
// A file new since the merge-base has no base and is not read. Exit 2 on another option, or when the changes cannot be
// read (no merge-base, a base file Git cannot show).
//
// The list is the authority. Its test (`pin-suites.test.mjs`) requires each suite's `pin` to find a line in the file
// holding its pins, and finds three pin forms by their text (`PIN_FORMS`): an `assert.equal` of `.total` to a literal of
// four or more digits, a table of four or more such literals, and a `[count, "reason"]` record. A pin written another
// way (`strictEqual`, `deepEqual` of a short tuple or an object, a total under four digits, a helper's table, a nested
// table such as work-a's) is not found; that test is a net for a forgotten suite, and `NOT_PINS` declares the files it
// finds that pin no work.

/** The core, whose every file can move a pin. */
const CORE = "src/type-inference/core/";

/**
 * Each suite that pins the core's exact work: its file, what it pins, a line its pins hold (`pin`), and, when its pins
 * are elsewhere, the file holding them (`in`).
 */
export const PIN_SUITES = [
  {
    file: "tests/type-core-candidate.test.ts",
    pins: "an integer rule's total and checks",
    pin: /^\s*assert\.deepEqual\(units, \[/u,
  },
  {
    file: "tests/type-core-closure.test.ts",
    pins: "work totals at two demands, four modes",
    pin: /^const OUTSIDE\b/u,
  },
  {
    file: "tests/type-core-contract-capture.test.ts",
    pins: "one capture total",
    pin: /^\s*assert\.equal\(budget\.total,/u,
  },
  {
    file: "tests/type-core-f18.test.ts",
    pins: "a literal default's total, decision and default work",
    pin: /^\s*\{ total: \d/u,
  },
  {
    file: "tests/type-core-key-ids.test.ts",
    pins: "listed copy sites",
    pin: /^const COPIES_LISTED\b/u,
  },
  {
    file: "tests/type-core-kept.test.ts",
    pins: "listed construction sites",
    pin: /^const (?:LISTED|STORED)\b/u,
  },
  {
    file: "tests/type-core-work-a.test.ts",
    pins: "a store check's work per mode",
    pin: /^\s*assert\.deepEqual\(measured, \[/u,
  },
  {
    file: "tests/type-core-work-b.test.ts",
    pins: "main's work per family, as bounds",
    pin: /^\s*main: \{\s*$/u,
    in: "tests/helpers/type-core-families.ts",
  },
  {
    file: "tests/type-core-work-c.test.ts",
    pins: "main's work per shape, as bounds",
    pin: /^\s*(?:(?:shared|unshared): \{|setup: \[|"checks \d|\[\d{4,}(?:, \d{4,}){3}\])/u,
  },
];

/** The files the pin forms find that pin no work, each with what its numbers are. */
export const NOT_PINS = [
  { file: "tests/async-timer-runtime.test.ts", is: "timer milliseconds" },
  { file: "tests/families-runner.test.ts", is: "a runner's fixture timings" },
  { file: "tests/list-functions.test.ts", is: "random seeds" },
  { file: "tests/message-markup.test.ts", is: "character codes" },
  { file: "tests/runtime-random.test.ts", is: "a generator's expected states" },
  { file: "tests/type-core-message-parity.test.ts", is: "random seeds" },
];

/** The three pin forms the list's test finds by their text. */
export const PIN_FORMS = {
  total: /assert\.equal\([^;\n]*\.total\b[^;\n]*,\s*\d[\d_]{3,}\s*\)/u,
  table: /\[\s*\d[\d_]{3,}(?:\s*,\s*\d[\d_]{3,}){3,}\s*,?\s*\]/u,
  listed: /^\s*(?:"[^"\n]+"|[\w$]+):\s*\[\s*\n?\s*\d+,\s*\n?\s*"/mu,
};

/** The pin forms `text` holds, by name. */
export function pinFormsOf(text) {
  return Object.keys(PIN_FORMS).filter((name) => PIN_FORMS[name].test(text));
}

/** The pinning suites `paths` reach: all of them for a core file, else those whose file or pins changed. */
export function suitesFor(paths) {
  const core = paths.some((path) => path.startsWith(CORE));
  return PIN_SUITES.filter(
    (suite) =>
      core || paths.includes(suite.file) || (suite.in !== undefined && paths.includes(suite.in)),
  );
}

/** The built test a suite runs as. */
export function builtOf(file) {
  return `dist/${file.replace(/\.ts$/u, ".js")}`;
}

/** The head lines a `git diff -U0` added. */
export function addedLines(diff) {
  const added = [];
  let line = 0;
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk !== null) line = Number(hunk[1]);
    else if (text.startsWith("+") && !text.startsWith("+++")) added.push(line++);
  }
  return added;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
}

/** The paths changed since the merge-base of HEAD and `ref`, committed or not, untracked included. */
function changedSince(root, mergeBase) {
  const tracked = git(root, "diff", "--name-only", mergeBase).split("\n");
  const untracked = git(root, "ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...untracked].filter((path) => path !== ""))];
}

function main(argv) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const at = argv.indexOf("--base");
  const ref = at >= 0 ? argv[at + 1] : "origin/main";
  const unknown = argv.filter(
    (arg, index) =>
      arg !== "--run" &&
      arg !== "--check-grounds" &&
      !(at >= 0 && (index === at || index === at + 1)),
  );
  if (unknown.length > 0 || (at >= 0 && ref === undefined)) {
    console.error(
      `pin-suites: unknown ${unknown.join(" ") || "--base without a ref"}: use [--base <ref>] [--run] [--check-grounds]`,
    );
    return 2;
  }
  let mergeBase;
  try {
    mergeBase = git(root, "merge-base", "HEAD", ref).trim();
  } catch {
    console.error(
      `pin-suites: no merge-base of HEAD and ${ref}: fetch it, or name one with --base`,
    );
    return 2;
  }
  const short = mergeBase.slice(0, 9);
  const paths = changedSince(root, mergeBase);
  const core = paths.filter((path) => path.startsWith(CORE)).length;
  const suites = suitesFor(paths);
  if (suites.length === 0)
    console.log(`pin-suites: no core file or pinning suite changed since ${ref} (${short}); none`);
  else {
    console.log(
      `pin-suites: ${core} core file${core === 1 ? "" : "s"} changed since ${ref} (${short}); ${suites.length} pinning suite${suites.length === 1 ? "" : "s"}:`,
    );
    const width = Math.max(...suites.map((suite) => builtOf(suite.file).length));
    for (const suite of suites)
      console.log(`  ${builtOf(suite.file).padEnd(width)}  ${suite.pins}`);
  }
  let status = 0;
  if (argv.includes("--check-grounds")) {
    const files = Object.keys(GROUNDS).filter(
      (file) => !GROUNDS[file].listed && paths.includes(file),
    );
    const start = performance.now();
    const refusals = [];
    let read = 0;
    for (const file of files) {
      const shown = spawnSync("git", ["cat-file", "-e", `${mergeBase}:${file}`], { cwd: root });
      if (shown.status !== 0) continue;
      if (!existsSync(join(root, file))) {
        refusals.push(
          `${file}: deleted, with its pins.\n  Restore it, or update its declaration in tools/repository-checks/pin-grounds.mjs.`,
        );
        continue;
      }
      read += 1;
      refusals.push(
        ...refusalsOf(
          file,
          git(root, "show", `${mergeBase}:${file}`),
          readFileSync(join(root, file), "utf8"),
          addedLines(git(root, "diff", "-U0", mergeBase, "--", file)),
        ),
      );
    }
    const seconds = ((performance.now() - start) / 1000).toFixed(1);
    for (const refusal of refusals) console.log(`pin-suites: ${refusal}`);
    console.log(
      `pin-suites: grounds: ${read} changed pin file${read === 1 ? "" : "s"} read in ${seconds}s, ${refusals.length} refusal${refusals.length === 1 ? "" : "s"}`,
    );
    if (refusals.length > 0) status = 1;
  }
  if (argv.includes("--run") && suites.length > 0) {
    const run = spawnSync(
      process.execPath,
      ["tools/test-output-filter.mjs", ...suites.map((suite) => builtOf(suite.file))],
      { cwd: root, stdio: "inherit" },
    );
    if (run.status !== 0) status = 1;
  }
  return status;
}

/** The test files under `tests/` (the list's test reads them). */
export function testFiles(root) {
  return readdirSync(join(root, "tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `tests/${name}`)
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
