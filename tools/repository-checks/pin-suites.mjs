import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The suites that pin the type core's exact work, the focused list a change needs, and the ground a re-pin needs:
//
//   node tools/repository-checks/pin-suites.mjs [--base <ref>] [--run] [--check-grounds]
//
// `PIN_SUITES` declares the suites: each one pins a whole-analysis count (a work total, a table of totals or of `main`'s
// recorded work as bounds, a count of listed copy or construction sites), so any change under `src/type-inference/core/`
// can move it, and the suite itself is listed when it changes. The changes are those since the merge-base of HEAD and
// `--base` (default `origin/main`), committed or not, untracked files included, as `check-changed.mjs` reads them.
//
// Without options it prints the pinning suites the changes reach, one `dist/tests/…` line each, or `none`; exit 0.
// `--run` runs them through `tools/test-output-filter.mjs` (built tests are needed: `npm run build:typescript`); exit 1
// when one fails. `--check-grounds` finds each re-pin in a listed suite (a changed line that differs from its base line
// only in its numbers) and requires a changed comment line in the block above it (up to a blank line, a closing line or
// the test's start) or in its test's header comment, where the "N units more or fewer since #…" ground is written; exit
// 1 naming each re-pin without one. It judges that the ground was touched, not whether it is true: the reviewer does.
// It reads work pins only: a listed-site count (`[count, "reason"]`) names its site by its reason, which the kept and
// key-ids tests require, and is not checked here.
//
// The list is the authority. Its test (`pin-suites.test.mjs`) finds three pin forms by their text: an `assert.equal` of
// `.total` to a literal of four or more digits, a table of four or more such literals, and a `[count, "reason"]` record.
// A pin written another way (`strictEqual`, `deepStrictEqual`, a total under four digits, a helper, a nested table such
// as work-a's) is not found; the test is a net for a forgotten suite, and `NOT_PINS` declares the files it finds that pin
// no work. Exit 2 when the checks cannot run (no merge-base).

/** The core, whose every file can move a pin. */
const CORE = "src/type-inference/core/";

/** Each suite that pins the core's exact work: its file, what it pins, and a text each still holds (its pin's mark). */
export const PIN_SUITES = [
  {
    file: "tests/type-core-closure.test.ts",
    pins: "work totals at two demands, four modes",
    mark: "const OUTSIDE",
  },
  {
    file: "tests/type-core-contract-capture.test.ts",
    pins: "one capture total",
    mark: "assert.equal(budget.total,",
  },
  {
    file: "tests/type-core-key-ids.test.ts",
    pins: "listed copy sites",
    mark: "const COPIES_LISTED",
  },
  { file: "tests/type-core-kept.test.ts", pins: "listed construction sites", mark: "const LISTED" },
  {
    file: "tests/type-core-work-a.test.ts",
    pins: "a store check's work per mode",
    mark: "assert.deepEqual(measured, [",
  },
  {
    file: "tests/type-core-work-c.test.ts",
    pins: "main's work per shape, as bounds",
    mark: "shared: {",
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

/** The pinning suites `paths` reach: all of them for a core file, else those changed themselves. */
export function suitesFor(paths) {
  const core = paths.some((path) => path.startsWith(CORE));
  return PIN_SUITES.filter((suite) => core || paths.includes(suite.file));
}

/** The built test a suite runs as. */
export function builtOf(file) {
  return `dist/${file.replace(/\.ts$/u, ".js")}`;
}

const NUMBER = /\d[\d_]*/gu;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/u;
const CLOSING = /^\s*[\]})]+[,;)]*\s*$/u;
const TEST_START = /^\s*test\(/u;

/** A line with its numbers replaced, so two lines that differ only in their numbers read alike. */
const shapeOf = (line) => line.replace(NUMBER, "#");

/**
 * The re-pins in one suite's change: from `git diff -U0` text, each added line whose base line in the same hunk differs
 * from it only in its numbers, and is no comment; with the head lines the hunks added.
 */
export function rePinsOf(diff) {
  const rePins = [];
  const added = new Set();
  let removed = [];
  let line = 0;
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk !== null) {
      line = Number(hunk[1]);
      removed = [];
      continue;
    }
    if (text.startsWith("---") || text.startsWith("+++")) continue;
    if (text.startsWith("-")) removed.push(text.slice(1));
    else if (text.startsWith("+")) {
      const head = text.slice(1);
      added.add(line);
      const base = removed.find((old) => old !== head && shapeOf(old) === shapeOf(head));
      if (base !== undefined && !COMMENT.test(head)) rePins.push({ line, base, head });
      line += 1;
    }
  }
  return { rePins, added };
}

/**
 * Where a re-pin's ground is written in the head text: the block above its line (up to a blank line, a closing line or
 * the test's start) and the test's header comment, each as a range of 1-based lines.
 */
export function groundsOf(lines, at) {
  let top = at - 1;
  while (top > 1) {
    const above = lines[top - 2];
    if (above.trim() === "" || CLOSING.test(above) || TEST_START.test(above)) break;
    top -= 1;
  }
  const above = { from: top, to: at - 1 };
  let start = at;
  while (start > 1 && !TEST_START.test(lines[start - 1])) start -= 1;
  let from = start;
  while (from > 1 && COMMENT.test(lines[from - 2])) from -= 1;
  const header = { from, to: start - 1 };
  return { above, header };
}

/** Whether a range holds a comment line the change added. */
const touched = (lines, range, added) => {
  for (let line = range.from; line <= range.to; line += 1)
    if (added.has(line) && COMMENT.test(lines[line - 1])) return true;
  return false;
};

/** The re-pins of one suite whose ground no comment line the change added is in, each as one refusal line. */
export function refusalsOf(file, headText, diff) {
  const lines = headText.split("\n");
  const { rePins, added } = rePinsOf(diff);
  const out = [];
  for (const { line, base, head } of rePins) {
    const { above, header } = groundsOf(lines, line);
    if (touched(lines, above, added) || touched(lines, header, added)) continue;
    const was = base.match(NUMBER) ?? [];
    const now = head.match(NUMBER) ?? [];
    const moved = now.filter((number, index) => number !== was[index]);
    const where =
      header.to >= header.from
        ? `lines ${above.from}–${above.to} above it, or its test's header (lines ${header.from}–${header.to})`
        : `lines ${above.from}–${above.to} above it`;
    out.push(
      `${file}:${line}: re-pinned (${moved.join(", ")}) with no change to its ground, in ${where}.\n` +
        `  Write there how many units more or fewer, and since which change ("N units more since #…").`,
    );
  }
  return out;
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
    const refusals = [];
    for (const { file } of PIN_SUITES) {
      if (!paths.includes(file) || !existsSync(join(root, file))) continue;
      const diff = git(root, "diff", "-U0", mergeBase, "--", file);
      refusals.push(...refusalsOf(file, readFileSync(join(root, file), "utf8"), diff));
    }
    for (const refusal of refusals) console.log(`pin-suites: ${refusal}`);
    if (refusals.length > 0) status = 1;
    else console.log("pin-suites: every re-pin's ground changed with it");
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
