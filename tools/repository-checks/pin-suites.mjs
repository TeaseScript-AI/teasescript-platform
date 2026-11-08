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
// can move it, and the suite itself is listed when it or the file holding its pins changes. The changes are those since
// the merge-base of HEAD and `--base` (default `origin/main`), committed or not, untracked files included, as
// `check-changed.mjs` reads them.
//
// Without options it prints the pinning suites the changes reach, one `dist/tests/…` line each, or `none`; exit 0.
// `--run` runs them through `tools/test-output-filter.mjs` (built tests are needed: `npm run build:typescript`); exit 1
// when one fails. `--check-grounds` finds each re-pin in a changed suite: a line inside one of its declared pins (from a
// line its `pin` finds to where that line's brackets close) that differs from its base line only in numbers outside its
// strings (a `"checks 142 …"` counter snapshot counts as numbers). It requires a changed comment line in the block above
// the re-pin (up to a blank line, a closing line or the test's start) or in its header comment (above its test and at
// its start; outside a test, the comment opening its top-level block, or the comment above the line its `ground` finds),
// where the "N units more or fewer since #…" ground is written; exit 1 naming each re-pin without one. It judges that the ground was touched,
// not whether it is true: the reviewer does. A pin whose words or layout changed with its numbers is no re-pin here.
// A listed-site count (`[count, "reason"]`) names its site by its reason, which the kept and key-ids tests require, and
// is not checked here.
//
// The list is the authority. Its test (`pin-suites.test.mjs`) requires each `pin` to find a line, and finds three pin
// forms by their text: an `assert.equal` of `.total` to a literal of four or more digits, a table of four or more such
// literals, and a `[count, "reason"]` record. A pin written another way (`strictEqual`, `deepEqual` of a short tuple or
// an object, a total under four digits, a helper's table, a nested table such as work-a's) is not found; the test is a
// net for a forgotten suite, and `NOT_PINS` declares the files it finds that pin no work. Exit 2 when the checks cannot
// run (no merge-base).

/** The core, whose every file can move a pin. */
const CORE = "src/type-inference/core/";

/**
 * Each suite that pins the core's exact work: its file, what it pins, the lines that open its pins (`pin`), and, when
 * its pins are elsewhere, the file holding them (`in`) and the line whose comment above is their ground (`ground`).
 * `listed` marks a count of listed sites, whose ground is its reason.
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
    listed: true,
  },
  {
    file: "tests/type-core-kept.test.ts",
    pins: "listed construction sites",
    pin: /^const LISTED\b/u,
    listed: true,
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
    ground: /^\s*readonly main: /u,
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

const NUMBER = /\d[\d_]*/gu;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/u;
const CLOSING = /^\s*[\]})]+[,;)]*\s*$/u;
const TEST_START = /^\s*test\(/u;
const TOP_CLOSING = /^[\]})]/u;
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/gu;
const COUNTERS = /^"[A-Za-z]+ \d+(?: [A-Za-z]+ \d+)*"$/u;

/** A line with its numbers replaced, so two lines that differ only in their numbers read alike. */
const shapeOf = (line) => line.replace(NUMBER, "#");

/** A line's code: each string emptied, but a counter snapshot, whose numbers are work. */
const codeOf = (line) => line.replace(STRING, (text) => (COUNTERS.test(text) ? text : '""'));

/**
 * The re-pin candidates in one file's change: from `git diff -U0` text, each added line whose base line in the same hunk
 * differs from it only in numbers outside its strings, and is no comment; with the head lines the hunks added.
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
      const base = removed.find(
        (old) => codeOf(old) !== codeOf(head) && shapeOf(old) === shapeOf(head),
      );
      if (base !== undefined && !COMMENT.test(head)) rePins.push({ line, base, head });
      line += 1;
    }
  }
  return { rePins, added };
}

/** The 1-based lines inside a pin: from each line `pin` finds to where that line's brackets close, strings aside. */
export function pinLinesOf(lines, pin) {
  const inside = new Set();
  for (let at = 0; at < lines.length; at += 1) {
    if (!pin.test(lines[at])) continue;
    let depth = 0;
    for (let line = at; line < lines.length; line += 1) {
      inside.add(line + 1);
      for (const char of codeOf(lines[line]))
        depth += "[{(".includes(char) ? 1 : "]})".includes(char) ? -1 : 0;
      if (depth <= 0) break;
    }
  }
  return inside;
}

/** The comment lines directly above line `at` (1-based), as a range. */
const commentAbove = (lines, at) => {
  let from = at;
  while (from > 1 && COMMENT.test(lines[from - 2])) from -= 1;
  return { from, to: at - 1 };
};

/**
 * Where a re-pin's ground is written in the head text, each as a range of 1-based lines: the block above its line (up to
 * a blank line, a closing line or the test's start), and its header: the comment above the line `ground` finds, else
 * the comment above its test and at its start, else (outside a test) the comment opening its top-level block.
 */
export function groundsOf(lines, at, ground) {
  let top = at;
  while (top > 1) {
    const above = lines[top - 2];
    if (above.trim() === "" || CLOSING.test(above) || TEST_START.test(above)) break;
    top -= 1;
  }
  const header = [];
  if (ground !== undefined) {
    const anchor = lines.findIndex((text) => ground.test(text)) + 1;
    if (anchor > 0) header.push(commentAbove(lines, anchor));
  } else {
    let start = at;
    while (start >= 1 && !TEST_START.test(lines[start - 1]) && !TOP_CLOSING.test(lines[start - 1]))
      start -= 1;
    const inTest = start >= 1 && TEST_START.test(lines[start - 1]);
    if (inTest) header.push(commentAbove(lines, start));
    // (in a test, the comment at its start; outside one, the comment that opens the top-level block holding the pin)
    let from = start + 1;
    while (!inTest && from < at && lines[from - 1].trim() === "") from += 1;
    let to = from - 1;
    while (to < at - 1 && COMMENT.test(lines[to])) to += 1;
    header.push({ from, to });
  }
  return {
    above: { from: top, to: at - 1 },
    header: header.filter((range) => range.to >= range.from),
  };
}

/** Whether a range holds a comment line the change added. */
const touched = (lines, range, added) => {
  for (let line = range.from; line <= range.to; line += 1)
    if (added.has(line) && COMMENT.test(lines[line - 1])) return true;
  return false;
};

const linesText = ({ from, to }) => (from === to ? `line ${from}` : `lines ${from}–${to}`);

/** The re-pins inside one file's pins whose ground no comment line the change added is in, each as one refusal. */
export function refusalsOf(file, headText, diff, { pin, ground }) {
  const lines = headText.split("\n");
  const inside = pinLinesOf(lines, pin);
  const { rePins, added } = rePinsOf(diff);
  const out = [];
  for (const { line, base, head } of rePins) {
    if (!inside.has(line)) continue;
    const { above, header } = groundsOf(lines, line, ground);
    if ([above, ...header].some((range) => touched(lines, range, added))) continue;
    const was = base.match(NUMBER) ?? [];
    const moved = (head.match(NUMBER) ?? []).filter((number, index) => number !== was[index]);
    const where = [
      `directly above it${above.to >= above.from ? ` (${linesText(above)})` : ""}`,
      ...(header.length > 0 ? [`in its header (${header.map(linesText).join(", ")})`] : []),
    ].join(", or ");
    out.push(
      `${file}:${line}: re-pinned (${moved.join(", ")}) with no change to its ground.\n` +
        `  Write ${where} how many units more or fewer, and since which change ("N units more since #…").`,
    );
  }
  return out;
}

/** The refusals of every changed file holding a suite's work pins, given its head text (`read`) and `git diff -U0`. */
export function groundRefusals(paths, read, diffOf) {
  return PIN_SUITES.flatMap((suite) => {
    const file = suite.in ?? suite.file;
    return suite.listed || !paths.includes(file)
      ? []
      : refusalsOf(file, read(file), diffOf(file), suite);
  });
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
    const refusals = groundRefusals(
      paths.filter((path) => existsSync(join(root, path))),
      (file) => readFileSync(join(root, file), "utf8"),
      (file) => git(root, "diff", "-U0", mergeBase, "--", file),
    );
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
