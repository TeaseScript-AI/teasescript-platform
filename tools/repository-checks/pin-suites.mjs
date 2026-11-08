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
// `check-changed.mjs` reads them. A change to a test helper lists only the suites whose pins it holds (`in`), not every
// suite that imports it.
//
// Without options it prints the pinning suites the changes reach, one `dist/tests/…` line each, or `none`; exit 0.
// `--run` runs them through `tools/test-output-filter.mjs` (built tests are needed: `npm run build:typescript`); exit 1
// when one fails.
//
// `--check-grounds` reads each changed line inside a suite's pins (from a line its `pin` finds to where that line's
// brackets close, or in a hunk that removed such a line), its strings, templates and comments set apart by one scan of
// the file (`scanOf`). A line holding no
// number outside them is no pin. Any other must take one of the suite's declared `forms` (`ADMITTED`), whose numbers
// outside an `input` part are its expected values; a line in no declared form is refused, fail-closed, naming the fix:
// write the values as literals in a declared form, or declare the form here. An expected value inside a call
// (`Number(684)`) and a list or a call's argument split across lines are such refusals. A line whose expected values
// a removed line of the suite's base pins held is unchanged (an input, a word or the layout changed); any other is a
// new or re-pinned value and needs a changed comment line, where the "N units more or fewer since #…" ground is
// written: in the block above it (up to a blank line, a closing line or the test's start), or in its header, the
// comment above its test and at its start, or, for a pin outside a test, the comment above the line its declared
// `ground` finds. Exit 1 naming each refusal. It judges that the ground was touched, not whether it is true: the
// reviewer does. A listed-site count (`listed`) names its site by its reason, which the kept and key-ids tests require,
// and is not read; nor is a suite not yet committed, which has no base.
//
// The list is the authority. Its test (`pin-suites.test.mjs`) requires each `pin` and `ground` to find a line, each
// line of today's pins to take a declared form, and each pin to have a header (outside a test, at its `ground`); it
// moves each expected value and requires its refusal. It also finds three pin forms by their text (`PIN_FORMS`): an `assert.equal`
// of `.total` to a literal of four or more digits, a table of four or more such literals, and a `[count, "reason"]`
// record. A pin written another way (`strictEqual`, `deepEqual` of a short tuple or an object, a total under four
// digits, a helper's table, a nested table such as work-a's) is not found; that test is a net for a forgotten suite,
// and `NOT_PINS` declares the files it finds that pin no work. Exit 2 when the checks cannot run (no merge-base).

/** The core, whose every file can move a pin. */
const CORE = "src/type-inference/core/";

const N = String.raw`\d[\d_]*`;
const LIST = String.raw`\[${N}(?:, ${N})*\]`;
const form = (source) => new RegExp(`^${source}$`, "du");

/**
 * The forms a changed pin line may take, read on its code (each string `""` but a counter snapshot, each template `""`,
 * comments dropped): its numbers are expected values, but those in its `input` group.
 */
export const ADMITTED = {
  asserted: form(
    String.raw`assert\.(?:equal|deepEqual)\([\w$.]+, (?:${N}|${LIST})(?:, [\w$.]+(?:\([\w$.]*\))?)?\);`,
  ),
  tuple: form(String.raw`\["", (?<input>""|[\w$]+\(${N}\)), ${LIST}\],?`),
  row: form(`${LIST},?`),
  totals: form(String.raw`\{ total: ${N}, decisions: ${LIST}, default: ${LIST} \},?`),
  sizeKey: form(String.raw`(?<input>${N}): \[`),
  keyed: form(String.raw`[\w$]+: ${LIST},?`),
  counters: form(String.raw`"[A-Za-z]+ \d+(?: [A-Za-z]+ \d+)*",?`),
};

/**
 * Each suite that pins the core's exact work: its file, what it pins, the lines that open its pins (`pin`), the forms
 * its pin lines take (`forms`, of `ADMITTED`), and, when its pins are elsewhere, the file holding them (`in`); for a pin
 * outside a test, the line whose comment above is its ground (`ground`). `listed` marks a count of listed sites, whose
 * ground is its reason.
 */
export const PIN_SUITES = [
  {
    file: "tests/type-core-candidate.test.ts",
    pins: "an integer rule's total and checks",
    pin: /^\s*assert\.deepEqual\(units, \[/u,
    forms: ["asserted"],
  },
  {
    file: "tests/type-core-closure.test.ts",
    pins: "work totals at two demands, four modes",
    pin: /^const OUTSIDE\b/u,
    forms: ["tuple", "row"],
    ground: /^const frozen\b/u,
  },
  {
    file: "tests/type-core-contract-capture.test.ts",
    pins: "one capture total",
    pin: /^\s*assert\.equal\(budget\.total,/u,
    forms: ["asserted"],
  },
  {
    file: "tests/type-core-f18.test.ts",
    pins: "a literal default's total, decision and default work",
    pin: /^\s*\{ total: \d/u,
    forms: ["totals"],
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
    pin: /^const (?:LISTED|STORED)\b/u,
    listed: true,
  },
  {
    file: "tests/type-core-work-a.test.ts",
    pins: "a store check's work per mode",
    pin: /^\s*assert\.deepEqual\(measured, \[/u,
    forms: ["row"],
  },
  {
    file: "tests/type-core-work-b.test.ts",
    pins: "main's work per family, as bounds",
    pin: /^\s*main: \{\s*$/u,
    forms: ["row", "sizeKey"],
    in: "tests/helpers/type-core-families.ts",
    ground: /^\s*readonly main: /u,
  },
  {
    file: "tests/type-core-work-c.test.ts",
    pins: "main's work per shape, as bounds",
    pin: /^\s*(?:(?:shared|unshared): \{|setup: \[|"checks \d|\[\d{4,}(?:, \d{4,}){3}\])/u,
    forms: ["keyed", "counters", "row"],
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
const COUNTERS = /^"[A-Za-z]+ \d+(?: [A-Za-z]+ \d+)*"$/u;
const CLOSING = /^\s*[\]})]+[,;)]*\s*$/u;
const TEST_START = /^\s*test\(/u;
const TOP_CLOSING = /^[\]})]/u;
/** The characters after which a `/` opens a regular expression; a `!` after a value is TypeScript's, read as a value. */
const REGEX_AFTER = "(,=:[!&|?{};+-*%<>~^";

/**
 * Each line of `text` by one scan of its strings, templates, comments and regular expressions: its `code` (each string
 * `""` but a counter snapshot, each template `""` with its interpolations, each regular expression `/r/`, comments
 * dropped), the column each code character came from (`at`), whether its first token is a comment (`comment`), and
 * whether it starts outside every string, template and comment (`top`).
 */
export function scanOf(text) {
  const kept = scans.get(text);
  if (kept !== undefined) return kept;
  const lines = scanned(text);
  scans.set(text, lines);
  if (scans.size > 4) scans.delete(scans.keys().next().value);
  return lines;
}

/** The last few scans, since a check reads each base text once per suite and its test reads one base many times. */
const scans = new Map();

function scanned(text) {
  const lines = [];
  const interpolations = [];
  let state = "code";
  let depth = 0;
  let literal = "";
  let literalAt = 0;
  let previous = "";
  let line = { code: "", at: [], comment: null, top: true };
  let column = 0;
  // (a counter snapshot keeps each character's column; a placeholder takes its literal's)
  const emit = (code, at, spread = false) => {
    if (interpolations.length > 0) return;
    for (let offset = 0; offset < code.length; offset += 1) {
      line.code += code[offset];
      line.at.push(spread ? at + offset : at);
    }
  };
  for (let index = 0; index < text.length; index += 1, column += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\n") {
      if (state === "line") state = "code";
      lines.push({ ...line, comment: line.comment === true });
      const top = state === "code" && interpolations.length === 0;
      line = { code: "", at: [], comment: state === "block" ? true : top ? null : false, top };
      column = -1;
      continue;
    }
    if (state === "code") {
      if (char === "/" && (next === "/" || next === "*")) {
        if (line.comment === null) line.comment = true;
        state = next === "/" ? "line" : "block";
        index += 1;
        column += 1;
        continue;
      }
      if (line.comment === null && char.trim() !== "") line.comment = false;
      if (char === '"' || char === "'") {
        state = char;
        literal = char;
        literalAt = column;
      } else if (char === "`") {
        state = "template";
        emit('""', column);
      } else if (char === "/" && (previous === "" || REGEX_AFTER.includes(previous))) {
        state = "regex";
        emit("/r/", column);
      } else if (char === "}" && interpolations.length > 0 && depth - 1 === interpolations.at(-1)) {
        depth = interpolations.pop();
        state = "template";
      } else {
        if (char === "{") depth += 1;
        if (char === "}") depth -= 1;
        emit(char, column);
        if (char === "!" && /[\w$)\]]/u.test(previous)) previous = ")";
        else if (char.trim() !== "") previous = char;
      }
    } else if (state === '"' || state === "'") {
      if (char === "\\") {
        literal += char + next;
        index += 1;
        column += 1;
      } else {
        literal += char;
        if (char === state) {
          state = "code";
          if (COUNTERS.test(literal)) emit(literal, literalAt, true);
          else emit('""', literalAt);
          previous = '"';
        }
      }
    } else if (state === "template") {
      if (char === "\\") {
        index += 1;
        column += 1;
      } else if (char === "`") {
        state = "code";
        previous = "`";
      } else if (char === "$" && next === "{") {
        interpolations.push(depth);
        depth += 1;
        state = "code";
        index += 1;
        column += 1;
      }
    } else if (state === "regex" || state === "class") {
      if (char === "\\") {
        index += 1;
        column += 1;
      } else if (state === "regex" && char === "[") state = "class";
      else if (state === "class" && char === "]") state = "regex";
      else if (state === "regex" && char === "/") {
        state = "code";
        previous = "/";
      }
    } else if (state === "block" && char === "*" && next === "/") {
      state = "code";
      index += 1;
      column += 1;
    }
  }
  lines.push({ ...line, comment: line.comment === true });
  return lines;
}

/** The 1-based lines of each pin `pin` opens in a scan: from its line to where that line's brackets close. */
export function pinsOf(scan, raw, pin) {
  const pins = [];
  for (let at = 0; at < scan.length; at += 1) {
    if (!scan[at].top || !pin.test(raw[at])) continue;
    let depth = 0;
    let line = at;
    for (; line < scan.length; line += 1) {
      for (const char of scan[line].code)
        depth += "[{(".includes(char) ? 1 : "]})".includes(char) ? -1 : 0;
      if (depth <= 0) break;
    }
    pins.push({ from: at + 1, to: Math.min(line, scan.length - 1) + 1 });
  }
  return pins;
}

/**
 * A pin line's reading by the suite's forms: `null` when it holds no number outside its strings and comments, `{ form:
 * undefined }` when it takes no declared form, else its form and its expected values with their columns.
 */
export function readingOf(scanned, forms) {
  const code = scanned.code.trim();
  if (!/\d/u.test(code)) return null;
  const lead = scanned.code.length - scanned.code.trimStart().length;
  for (const name of forms) {
    const match = ADMITTED[name].exec(code);
    if (match === null) continue;
    const input = match.indices.groups?.input;
    const values = [];
    for (const number of code.matchAll(NUMBER)) {
      if (input !== undefined && number.index >= input[0] && number.index < input[1]) continue;
      const from = scanned.at[lead + number.index];
      values.push({ text: number[0], from, to: from + number[0].length });
    }
    return { form: name, values };
  }
  return { form: undefined, values: [] };
}

/** The hunks of a `git diff -U0`, each with the base lines it removed and the head lines it added. */
export function hunksOf(diff) {
  const hunks = [];
  let base = 0;
  let head = 0;
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk !== null) {
      [base, head] = [Number(hunk[1]), Number(hunk[2])];
      hunks.push({ removed: [], added: [] });
    } else if (text.startsWith("---") || text.startsWith("+++") || hunks.length === 0) continue;
    else if (text.startsWith("-")) hunks.at(-1).removed.push(base++);
    else if (text.startsWith("+")) hunks.at(-1).added.push(head++);
  }
  return hunks;
}

/** The comment lines directly above line `at` (1-based) in a scan, as a range. */
const commentAbove = (scan, at) => {
  let from = at;
  while (from > 1 && scan[from - 2].comment) from -= 1;
  return { from, to: at - 1 };
};

/**
 * Where a pin line's ground is written, each as a range of 1-based lines: the block above it (up to a blank line, a
 * closing line or the test's start), and its header: the comment above its test and at its start, or, outside a test,
 * the comment above the line `ground` finds.
 */
export function groundsOf(scan, raw, at, ground) {
  let top = at;
  while (top > 1) {
    const above = scan[top - 2];
    if (raw[top - 2].trim() === "" || CLOSING.test(above.code) || TEST_START.test(above.code))
      break;
    top -= 1;
  }
  const header = [];
  let start = at;
  while (
    start >= 1 &&
    !TEST_START.test(scan[start - 1].code) &&
    !(scan[start - 1].top && TOP_CLOSING.test(scan[start - 1].code))
  )
    start -= 1;
  if (start >= 1 && TEST_START.test(scan[start - 1].code)) {
    header.push(commentAbove(scan, start));
    let to = start;
    while (to < at - 1 && scan[to].comment) to += 1;
    header.push({ from: start + 1, to });
  } else if (ground !== undefined) {
    const anchor = raw.findIndex((text, index) => scan[index].top && ground.test(text)) + 1;
    if (anchor > 0) header.push(commentAbove(scan, anchor));
  }
  return {
    above: { from: top, to: at - 1 },
    header: header.filter((range) => range.to >= range.from),
  };
}

const linesText = ({ from, to }) => (from === to ? `line ${from}` : `lines ${from}–${to}`);

/**
 * The base side of a change: the base lines inside its pins (`inside`), and the expected values each removed one held,
 * as a multiset of their texts (`held`).
 */
function baseOf(baseText, hunks, suite) {
  const raw = baseText.split("\n");
  const scan = scanOf(baseText);
  const inside = new Set(pinsOf(scan, raw, suite.pin).flatMap(({ from, to }) => range(from, to)));
  const held = new Map();
  for (const line of hunks.flatMap((hunk) => hunk.removed)) {
    if (!inside.has(line)) continue;
    const reading = readingOf(scan[line - 1], suite.forms);
    if (reading?.form === undefined) continue;
    const key = reading.values.map((value) => value.text).join(",");
    held.set(key, (held.get(key) ?? 0) + 1);
  }
  return { inside, held };
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/**
 * The refusals of one file holding a suite's pins, from its base and head texts and their `git diff -U0`: each changed
 * pin line in no declared form, and each new or re-pinned value whose ground no comment line the change added is in.
 */
export function refusalsOf(file, baseText, headText, diff, suite) {
  const raw = headText.split("\n");
  const scan = scanOf(headText);
  const hunks = hunksOf(diff);
  const base = baseOf(baseText, hunks, suite);
  const held = base.held;
  const added = hunks.flatMap((hunk) => hunk.added);
  const changed = new Set(added);
  // (a line is read as a pin's when it is inside one at the head, or its hunk removed a line of one at the base: an
  // edit that leaves no line its `pin` finds is still read)
  const inside = new Set(pinsOf(scan, raw, suite.pin).flatMap(({ from, to }) => range(from, to)));
  for (const hunk of hunks)
    if (hunk.removed.some((line) => base.inside.has(line)))
      for (const line of hunk.added) inside.add(line);
  const touched = (range) => {
    for (let line = range.from; line <= range.to; line += 1)
      if (changed.has(line) && scan[line - 1].comment) return true;
    return false;
  };
  const out = [];
  const of = file === suite.file ? "" : ` (${suite.file})`;
  for (const line of added) {
    if (!inside.has(line)) continue;
    const reading = readingOf(scan[line - 1], suite.forms);
    if (reading === null) continue;
    if (reading.form === undefined) {
      out.push(
        `${file}:${line}: a changed pin line in none of its declared forms (${suite.forms.join(", ")})${of}.\n` +
          `  Write its expected values as literals in one of them, or declare its form in tools/repository-checks/pin-suites.mjs.`,
      );
      continue;
    }
    const key = reading.values.map((value) => value.text).join(",");
    if ((held.get(key) ?? 0) > 0) {
      held.set(key, held.get(key) - 1);
      continue;
    }
    const { above, header } = groundsOf(scan, raw, line, suite.ground);
    if ([above, ...header].some(touched)) continue;
    const where = [
      `directly above it${above.to >= above.from ? ` (${linesText(above)})` : ""}`,
      ...(header.length > 0 ? [`in its header (${header.map(linesText).join(", ")})`] : []),
    ].join(", or ");
    out.push(
      `${file}:${line}: re-pinned (${key.replaceAll(",", ", ")}) with no change to its ground${of}.\n` +
        `  Write ${where} how many units more or fewer, and since which change ("N units more since #…").`,
    );
  }
  return out;
}

/**
 * The refusals of every changed file holding a suite's work pins, given its head text (`read`), its base text
 * (`readBase`, empty for a new file) and its `git diff -U0` (`diffOf`).
 */
export function groundRefusals(paths, read, readBase, diffOf) {
  return PIN_SUITES.flatMap((suite) => {
    const file = suite.in ?? suite.file;
    return suite.listed || !paths.includes(file)
      ? []
      : refusalsOf(file, readBase(file), read(file), diffOf(file), suite);
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
      (file) => {
        const shown = spawnSync("git", ["show", `${mergeBase}:${file}`], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 1 << 28,
        });
        return shown.status === 0 ? shown.stdout : "";
      },
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
