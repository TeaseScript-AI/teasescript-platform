import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";
import { suiteTestFiles } from "../test-shards.mjs";

// The suites that pin the type core's exact work or its published answers, and the focused list a change needs:
//
//   node tools/repository-checks/pin-suites.mjs [--base <ref>] [--run]
//
// Each `.ts` file that holds such pins says so in its first line, a mark (`readMarks`): `// pins: <what> | line
// /<regex>/` in a suite, or `// pins for <suite>, ...: <what> | line /<regex>/` in a file holding pins those suites run
// (`in`). Each suite pins a whole-analysis count (a work total, a table of totals or of `main`'s recorded work as
// bounds, a count of listed copy or construction sites) or a digest of what an analysis publishes, so any change under
// `src/type-inference/core/` can move it, and the suite itself is listed when it or a file holding its pins changes: a
// suite whose pins are in two files is named by a mark in each, and is listed once.
// The changes are those since the merge-base of HEAD and `--base` (default `origin/main`), committed or not, untracked
// files included, as `check-changed.mjs` reads them. A change to a test helper lists only the suites whose pins it holds
// (`in`), not every suite that imports it.
//
// Without options it prints the pinning suites the changes reach, one `dist/tests/…` line each, or `none`; exit 0.
// `--run` runs them through `tools/test-output-filter.mjs` (built tests are needed: `npm run build:typescript`); exit 1
// when one fails. Exit 2 on another option, when the changes cannot be read (no merge-base), or on a mark `readMarks`
// faults.
//
// The marks are the authority; each mark's regex must find a line of its file other than the mark, and every line it
// finds must hold a numeric or hex digest literal in its code (`valueLines`: a digit in a comment, a name, a literal
// type or another string is none, and a marked file that does not parse is a fault), so that a mark whose values are
// deleted finds nothing. Their test (`pin-suites.test.mjs`) finds four pin forms by their text (`PIN_FORMS`): an
// `assert.equal` of `.total` to a literal of four or more digits, a table of four or more such literals, a `[count,
// "reason"]` record, and, in the type core's tests only (`FORM_SCOPES`), a property set to a hex digest of 16 or more
// digits: a digest pin written in another test file is not found. A pin written another way (`strictEqual`, `deepEqual`
// of a short tuple or an object, a total under four digits, a helper's table, a nested table such as
// `work/type-core-work-store-checks`'s) is not found; that test is a net over every `.ts` file under `tests/`, helpers
// included, for a file holding pins with no
// mark, and `NOT_PINS` declares the files it finds that pin no work. A suite whose pins take a form the net lacks is
// protected by a list, not by the net: the test holds every `{file, in}` pair the marks name, so a mark lost, moved or
// redirected fails it. Under `tests/helpers/type-core/families/` it also requires every recorded bound to be a line a
// mark of that file finds, and claims a position, not a meaning: in the code of that folder, neither `main` nor
// `measured` occurs outside the admitted positions. Comments, JSDoc and marks included, are not code and are not read
// there: they cannot record or change a bound. The code is every node `forEachChild` reaches from a file's source;
// every identifier, private name, string and template without substitutions spelled so is classified by its role.
// Admitted are `main: <object literal>` and `measured: <numeric literal>` (the two records), a property signature, and
// the identifier `main` as a declared, imported or exported binding or as a callee (the program builder). Any other
// occurrence fails, naming its file, line and role, and so does every object spread and every computed name that is not
// a literal. Not claimed: a bound recorded under a third property name, a bound outside that folder, and a bound
// changed at run time by code that names neither property (a key built at run time, a write through an alias).

/** The core, whose every file can move a pin. */
const CORE = "src/type-inference/core/";

/**
 * A mark, the first line of a `.ts` file under `tests/` that holds pins: `// pins: <what> | line /<regex>/<flags>` in a
 * suite, or `// pins for <suite>, <suite>: <what> | line /<regex>/<flags>` in a file holding pins those suites run.
 */
const MARK = /^\/\/ pins(?: for ([^:]+))?: (.+?) \| line \/(.+)\/([a-z]*)$/u;
/**
 * The lines of `text` (counted from 1) that hold a literal value in its code: a numeric literal, or a string literal
 * that is a hex digest of 16 or more digits. Digits in a comment, a name, a literal type or another string are no
 * value; `null` where `text` does not parse.
 */
function valueLines(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  if (source.parseDiagnostics.length > 0) return null;
  const lines = new Set();
  const visit = (node) => {
    if (ts.isLiteralTypeNode(node)) return;
    if (
      ts.isNumericLiteral(node) ||
      (ts.isStringLiteralLike(node) && /^[0-9a-f]{16,}$/u.test(node.text))
    )
      lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}
/** A line that begins a mark, wherever it stands. */
const MARK_START = /^\s*\/\/\s*pins\b/u;

/**
 * The pinning suites the marks of the `.ts` files under `root`'s `tests/` declare, one record per suite and marked file:
 * its `file`, what it pins (`pins`), a line its pins hold (`pin`) and, when the mark is in another file, that file
 * (`in`); in path order.
 * `faults` names each mark that does not parse, has a `g` or `y` flag, names no test file as its suite, finds no line of
 * its file but itself or a line holding no number or hex digest, or is not a file's first line. `files` are the `.ts`
 * files read.
 */
export function readMarks(root) {
  const tests = new Set(testFiles(root));
  const suites = [];
  const faults = [];
  const files = readdirSync(join(root, "tests"), { recursive: true })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `tests/${name.split(sep).join("/")}`)
    .sort();
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const lines = text.split(/\r?\n/u);
    for (const [at, line] of lines.entries())
      if (at > 0 && MARK_START.test(line))
        faults.push(`${file}:${at + 1}: a mark is a file's first line`);
    if (!MARK_START.test(lines[0])) continue;
    const found = MARK.exec(lines[0]);
    if (found === null) {
      faults.push(`${file}:1: no mark: use // pins[ for <suite>, ...]: <what> | line /<regex>/`);
      continue;
    }
    // (a `g` or `y` regex keeps where it last matched, so one test would change the next)
    if (/[gy]/u.test(found[4])) {
      faults.push(`${file}:1: the mark's line takes no g or y flag`);
      continue;
    }
    let pin;
    try {
      pin = new RegExp(found[3], found[4]);
    } catch (error) {
      faults.push(`${file}:1: the mark's line is no regex: ${error.message}`);
      continue;
    }
    // (a pin's line holds its value, so that a mark whose values are gone finds nothing: a declaration line would stay)
    const matched = lines.slice(1).flatMap((line, at) => (pin.test(line) ? [at + 2] : []));
    const values = matched.length === 0 ? new Set() : valueLines(text, file);
    if (values === null) {
      faults.push(`${file}:1: the file does not parse, so its values cannot be read`);
      continue;
    }
    const bare = matched.find((at) => !values.has(at));
    if (matched.length === 0 || bare !== undefined) {
      faults.push(
        matched.length === 0
          ? `${file}:1: no line of the file but the mark's own is a line ${pin} finds`
          : `${file}:1: ${pin} finds line ${bare}, which holds no numeric or hex digest literal`,
      );
      continue;
    }
    const named = found[1]?.split(",").map((suite) => suite.trim());
    for (const suite of named ?? [file]) {
      if (!tests.has(suite)) faults.push(`${file}:1: ${suite} is no test file`);
      else
        suites.push({
          file: suite,
          pins: found[2],
          pin,
          ...(named === undefined ? {} : { in: file }),
        });
    }
  }
  const key = (suite) => `${suite.file}\n${suite.in ?? ""}`;
  suites.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return { suites, faults, files };
}

/** The files the pin forms find that pin no work, each with what its numbers are. */
export const NOT_PINS = [
  { file: "tests/runtime/v1/async-timer-runtime.test.ts", is: "timer milliseconds" },
  {
    file: "tests/families-runner/families-baseline-fill.test.ts",
    is: "a runner's fixture timings",
  },
  { file: "tests/semantic/list-function-checks.test.ts", is: "random seeds" },
  { file: "tests/runtime/presentation/message-markup.test.ts", is: "character codes" },
  { file: "tests/runtime/engine/runtime-random.test.ts", is: "a generator's expected states" },
  { file: "tests/type-core/messages/type-core-messages-examples.test.ts", is: "random seeds" },
  { file: "tests/helpers/type-core/type-core-enclosing.ts", is: "sample values of a host global" },
];

/** The four pin forms the marks' test finds by their text. */
export const PIN_FORMS = {
  total: /assert\.equal\([^;\n]*\.total\b[^;\n]*,\s*\d[\d_]{3,}\s*\)/u,
  table: /\[\s*\d[\d_]{3,}(?:\s*,\s*\d[\d_]{3,}){3,}\s*,?\s*\]/u,
  listed: /^\s*(?:"[^"\n]+"|[\w$]+):\s*\[\s*\n?\s*\d+,\s*\n?\s*"/mu,
  digest: /^\s*[\w$]+:\s*"[0-9a-f]{16,}"/mu,
};

/**
 * The files a form is looked for in, where it is not every file: a digest only in the type core's tests, under
 * `tests/type-core/` or named `type-core-…` (as they were before that folder), where a pin of the core's published
 * answers is written; elsewhere such a literal is a test vector or a stored hash.
 */
const FORM_SCOPES = {
  digest: (file) => file.startsWith("tests/type-core/") || /(?:^|\/)type-core-[^/]*$/u.test(file),
};

/** The pin forms `text`, the text of `file` (a path under the repository), holds, by name. */
export function pinFormsOf(text, file) {
  return Object.keys(PIN_FORMS).filter(
    (name) => (FORM_SCOPES[name]?.(file) ?? true) && PIN_FORMS[name].test(text),
  );
}

/**
 * The pinning suites of `suites` (`readMarks`) that `paths` reach: all of them for a core file, else those whose file
 * or pins changed. Each suite once, in path order, with the `pins` of the marks reached.
 */
export function suitesFor(suites, paths) {
  const core = paths.some((path) => path.startsWith(CORE));
  const reached = new Map();
  for (const suite of suites)
    if (core || paths.includes(suite.file) || (suite.in !== undefined && paths.includes(suite.in)))
      reached.set(suite.file, [...(reached.get(suite.file) ?? []), suite.pins]);
  return [...reached].map(([file, pins]) => ({ file, pins: pins.join("; ") }));
}

/** The built test a suite runs as. */
export function builtOf(file) {
  return `dist/${file.replace(/\.ts$/u, ".js")}`;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
}

/**
 * The paths changed since the merge-base of HEAD and `ref`, committed or not, untracked included; a moved file by both
 * its paths (`--no-renames`), so a file moved out of the core is a core change.
 */
function changedSince(root, mergeBase) {
  const tracked = git(root, "diff", "--name-only", "--no-renames", mergeBase).split("\n");
  const untracked = git(root, "ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...untracked].filter((path) => path !== ""))];
}

function main(argv) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const at = argv.indexOf("--base");
  const ref = at >= 0 ? argv[at + 1] : "origin/main";
  const unknown = argv.filter(
    (arg, index) => arg !== "--run" && !(at >= 0 && (index === at || index === at + 1)),
  );
  if (unknown.length > 0 || (at >= 0 && ref === undefined)) {
    console.error(
      `pin-suites: unknown ${unknown.join(" ") || "--base without a ref"}: use [--base <ref>] [--run]`,
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
  const marks = readMarks(root);
  if (marks.faults.length > 0) {
    console.error(`pin-suites: the marks cannot be read:\n  ${marks.faults.join("\n  ")}`);
    return 2;
  }
  const paths = changedSince(root, mergeBase);
  const core = paths.filter((path) => path.startsWith(CORE)).length;
  const suites = suitesFor(marks.suites, paths);
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

/** The test files under `tests/`, as the suite finds them (`suiteTestFiles`; the marks' test reads them). */
export function testFiles(root) {
  return suiteTestFiles(join(root, "tests"), ".test.ts").map((name) => `tests/${name}`);
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
