import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GROUNDS, readingOf, refusalsOf } from "./pin-grounds.mjs";
import { PIN_SUITES, addedLines } from "./pin-suites.mjs";

// The tests of `pin-grounds.mjs`. Their fixture, `pin-grounds.cases.json`, was generated, not written: its `cases` by
// `build-cases.py` from #2035's review evidence (each Codex round's diffs, and the builder's probe scripts rerun to
// record their texts), its `positions` from Codex r3's independent inventory; both scripts and their inputs are kept
// under `~/work/evidence/f17-builder/` on the LXC, and `python3 build-cases.py <checkout> <fixture>` regenerates it. The
// full 358-position mutation runs apart: `node --test tools/repository-checks/pin-grounds.full.test.mjs`.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const { positions, cases } = JSON.parse(
  readFileSync(new URL("./pin-grounds.cases.json", import.meta.url), "utf8"),
);

/** `text` with a `git diff -U0` applied: each removed line must be the text's. */
function apply(text, diff) {
  const lines = text.split("\n");
  const out = [];
  let cursor = 0;
  for (const hunk of diff.split(/^(?=@@ )/mu).filter((part) => part.startsWith("@@"))) {
    const [header, ...body] = hunk.replace(/\n$/u, "").split("\n");
    const [, from, count] = /^@@ -(\d+)(?:,(\d+))? /u.exec(header);
    const start = count === "0" ? Number(from) : Number(from) - 1;
    out.push(...lines.slice(cursor, start));
    cursor = start;
    for (const line of body)
      if (line.startsWith("-")) {
        assert.equal(lines[cursor], line.slice(1), `removed line ${cursor + 1}`);
        cursor += 1;
      } else if (line.startsWith("+")) out.push(line.slice(1));
  }
  out.push(...lines.slice(cursor));
  return out.join("\n");
}

/**
 * The suites and places whose values the check must read, written here apart from the readers: each place without the
 * name or index that tells its records apart (`"shared-reads".main[0][1]` is `main`).
 */
const roleOf = (place) => place.replace(/ ?"[^"]*"\.?|\[\d+\]/gu, "");
const PLANNED = [
  "tests/helpers/type-core-families.ts main",
  "tests/type-core-candidate.test.ts assert.deepEqual(units)",
  "tests/type-core-closure.test.ts OUTSIDE's totals",
  "tests/type-core-contract-capture.test.ts assert.equal(budget.total)",
  "tests/type-core-f18.test.ts assert.deepEqual({ total, decisions, default })",
  "tests/type-core-work-a.test.ts assert.deepEqual(measured)",
  "tests/type-core-work-c.test.ts the case's counters",
  "tests/type-core-work-c.test.ts assert.deepEqual(the four modes' totals)",
  ...["shared", "unshared"].flatMap((side) =>
    ["checks", "invSteps", "literalUnits", "small", "total"].map(
      (name) => `tests/type-core-work-c.test.ts ${side}.${name}`,
    ),
  ),
  "tests/type-core-work-c.test.ts setup",
].sort();

test("each pinning suite has its readers or is listed, and nothing else is read", () => {
  assert.deepEqual(
    Object.keys(GROUNDS).sort(),
    PIN_SUITES.map((suite) => suite.in ?? suite.file).sort(),
  );
});

test("every current pin is read in its declared place, with no refusal, and matches itself", () => {
  const places = new Set();
  for (const [file, { listed }] of Object.entries(GROUNDS)) {
    if (listed) continue;
    const reading = readingOf(file, read(file));
    assert.deepEqual(reading.refusals, [], file);
    for (const record of reading.records) places.add(`${file} ${roleOf(record.place)}`);
    assert.deepEqual(refusalsOf(file, read(file), read(file), []), [], file);
  }
  assert.deepEqual([...places].sort(), PLANNED);
});

/** The offset of a 1-based line's 0-based column, lines counted by `\n`. */
const offsetOf = (text, line, column) =>
  text
    .split("\n")
    .slice(0, line - 1)
    .reduce((sum, each) => sum + each.length + 1, 0) + column;

test("each expected value Codex r3 found is a value of exactly one record, read in memory from one parse a file", () => {
  for (const [file, line, column, text] of positions) {
    const at = `${file}:${line}:${column + 1} ${text}`;
    const offset = offsetOf(read(file), line, column);
    const holding = readingOf(file, read(file)).records.filter(
      ({ node }) => node.getStart() <= offset && offset < node.getEnd(),
    );
    assert.equal(holding.length, 1, at);
    const value = text.replaceAll("_", "");
    assert.ok(
      holding[0].values.some((each) => each === value || each.endsWith(`=${value}`)),
      at,
    );
  }
});

test("a value of each place, moved by one, is refused without its ground and passes with one (the full set: pin-grounds.full.test.mjs)", () => {
  const sampled = new Set();
  for (const [file, line, column, text] of positions) {
    const offset = offsetOf(read(file), line, column);
    const record = readingOf(file, read(file)).records.find(
      ({ node }) => node.getStart() <= offset && offset < node.getEnd(),
    );
    const role = `${file} ${roleOf(record.place)}`;
    if (sampled.has(role)) continue;
    sampled.add(role);
    const lines = read(file).split("\n");
    const moved = `${lines[line - 1].slice(0, column)}${Number(text.replaceAll("_", "")) + 1}${lines[line - 1].slice(column + text.length)}`;
    const head = [...lines.slice(0, line - 1), moved, ...lines.slice(line)].join("\n");
    assert.match(refusalsOf(file, read(file), head, [line]).join("\n"), /new or re-pinned/u, role);
    const indent = moved.slice(0, moved.length - moved.trimStart().length);
    const grounded = [
      ...lines.slice(0, line - 1),
      `${indent}// (1 unit more since #1)`,
      moved,
      ...lines.slice(line),
    ].join("\n");
    assert.deepEqual(refusalsOf(file, read(file), grounded, [line, line + 1]), [], role);
  }
  assert.deepEqual([...sampled].sort(), PLANNED);
});

test("the r3–r7 witnesses of the line-level check end as the syntax-tree design says", () => {
  const ended = { P: 0, E: 0, G: 0, U: 0 };
  for (const witness of cases) {
    const at = `${witness.instances[0].witness} (${witness.file})`;
    const main = read(witness.file);
    const refusals =
      witness.newFile || GROUNDS[witness.file].listed
        ? []
        : (() => {
            const base = witness.base === null ? main : apply(main, witness.base);
            return refusalsOf(
              witness.file,
              base,
              apply(base, witness.head),
              addedLines(witness.head),
            );
          })();
    const unread = refusals.filter((refusal) => !/new or re-pinned/u.test(refusal));
    if (witness.class === "P" || witness.class === "E") assert.deepEqual(refusals, [], at);
    if (witness.class === "G") {
      assert.ok(refusals.length > 0, at);
      assert.deepEqual(unread, [], at);
    }
    if (witness.class === "U") assert.ok(unread.length > 0, `${at}: ${refusals.join(" | ")}`);
    ended[witness.class] += witness.instances.length;
  }
  // (the 217 instances, by class, as the design round counted them)
  assert.deepEqual(ended, { P: 60, E: 3, G: 87, U: 67 });
});

test("a value outside a literal of its declared shape is refused, naming it and the fix", () => {
  const file = "tests/type-core-contract-capture.test.ts";
  for (const [expected, kind] of [
    ['Number("22962574")', /a call \(Number\)/u],
    ["reviewExpected", /a name \(reviewExpected\)/u],
    ["2 * 11_481_287", /arithmetic/u],
    ["`22962574`", /a template/u],
  ]) {
    const head = read(file).replace("budget.total, 22_962_573)", `budget.total, ${expected})`);
    const line =
      head.split("\n").findIndex((text) => text.includes(`budget.total, ${expected})`)) + 1;
    const [refusal, ...more] = refusalsOf(file, read(file), head, [line]);
    assert.deepEqual(more, [], expected);
    assert.match(refusal, kind, expected);
    assert.match(
      refusal,
      /Write the value as a literal in its declared shape, or declare the shape/u,
    );
  }
  const renamed = read(file).replace('test("the capture ends', 'test("a capture ends');
  assert.match(
    refusalsOf(file, read(file), renamed, []).join("\n"),
    /is not found\.\n {2}Restore it/u,
  );
});

test("what a reader cannot prove is refused: a file that does not parse, an owner twice, an unknown property or string, a ground outside the record's owner", () => {
  const refusals = (file, edit, added = []) =>
    refusalsOf(file, read(file), edit(read(file)), added);
  const capture = "tests/type-core-contract-capture.test.ts";
  assert.match(
    refusals(capture, (text) =>
      text.replace(
        "assert.equal(budget.total, 22_962_573);",
        "assert.equal(budget.total, 22_962_573;",
      ),
    ).join("\n"),
    /does not parse/u,
  );
  const title = 'test("the capture ends at the first store';
  assert.match(
    refusals(
      capture,
      (text) =>
        `${text}\n${text.slice(text.indexOf(title), text.indexOf("\n});\n", text.indexOf(title)) + 5)}`,
    ).join("\n"),
    /is found 2 times/u,
  );
  // (a re-pin whose only changed comment opens the file, outside its test)
  const moved = (text) => `// (1 unit more since #1)\n${text.replace("22_962_573", "22_962_574")}`;
  const line =
    moved(read(capture))
      .split("\n")
      .findIndex((text) => text.includes("22_962_574")) + 1;
  assert.match(refusals(capture, moved, [1, line]).join("\n"), /new or re-pinned \(22962574\)/u);
  const f18 = "tests/type-core-f18.test.ts";
  assert.match(
    refusals(f18, (text) =>
      text.replace(
        "{ total: 246, decisions: [15], default: [4] }",
        "{ total: 246, decisions: [15], default: [4], extra: 1 }",
      ),
    ).join("\n"),
    /holds a PropertyAssignment, not one of total, decisions, default|holds a .*not one of total/u,
  );
  // (two rows' totals swapped: each row's record is its own, by the row's name)
  const closure = "tests/type-core-closure.test.ts";
  const a = "[1539, 1617, 1539, 1617, 2424, 2149, 2289, 2149]";
  const b = "[4958, 5428, 4958, 5156, 7194, 6187, 7215, 5915]";
  const swapped = (text) => text.replace(a, "<A>").replace(b, a).replace("<A>", b);
  const swappedLines = swapped(read(closure))
    .split("\n")
    .flatMap((text, index) => (text.includes(a) || text.includes(b) ? [index + 1] : []));
  assert.equal(refusals(closure, swapped, swappedLines).length, 2);
  const workC = "tests/type-core-work-c.test.ts";
  assert.match(
    refusals(workC, (text) =>
      text.replace(
        '"checks 142 checksSkipped 3 defScan',
        '"checks 142 checksSkipped 3 (moved) defScan',
      ),
    ).join("\n"),
    /not one counter snapshot string/u,
  );
});

test("Codex r1's ways past a declared position on #2051 are refused", () => {
  const capture = "tests/type-core-contract-capture.test.ts";
  const workCFile = "tests/type-core-work-c.test.ts";
  const pin = "  assert.equal(budget.total, 22_962_573);";
  const lineIn = (text, has) => text.split("\n").findIndex((line) => line.includes(has)) + 1;
  const check = (file, base, head) => {
    // (the lines that differ from the base's line of the same number: the edits here keep the lines' count, or add
    // lines whose followers differ anyway)
    const was = base.split("\n");
    const added = head
      .split("\n")
      .flatMap((line, index) => (was[index] === line ? [] : [index + 1]));
    return refusalsOf(file, base, head, added).join("\n");
  };

  // (1: a decoy in an uncalled function or a shadowing block keeps the old value; the live assertion is rebound)
  for (const decoy of [
    "  function uncalled() { assert.equal(budget.total, 22_962_573); }\n  assert.equal((budget.total), 22_962_574);",
    "  { const budget = { total: 22_962_573 }; assert.equal(budget.total, 22_962_573); }\n  const actualTotal = budget.total;\n  assert.equal(actualTotal, 22_962_574);",
  ])
    assert.match(
      check(capture, read(capture), read(capture).replace(pin, decoy)),
      /is not found|declared more than once/u,
      decoy,
    );
  // (1, a loop's shadowing decoy: the live assertion rebound, the old value kept in a loop of its own)
  const shadowed = read(capture).replace(
    pin,
    "  for (const once of [0]) { const budget = { total: 22_962_573 + once }; assert.equal(budget.total, 22_962_573); }\n  const actualTotal = budget.total;\n  assert.equal(actualTotal, 22_962_574);",
  );
  assert.match(
    check(capture, read(capture), shadowed),
    /budget is declared more than once in the test/u,
  );
  // (2: the cases table assigned after an uninitialized declaration, or reassigned after its first table)
  const reassigned = read(workCFile)
    .replace(
      "  const cases: readonly (readonly [string, string, readonly [string, string]])[] = [",
      "  let cases: readonly (readonly [string, string, readonly [string, string]])[] = [",
    )
    .replace(
      "  for (const [name, source, [shared, unshared]] of cases) {",
      "  cases = [];\n  for (const [name, source, [shared, unshared]] of cases) {",
    );
  assert.match(check(workCFile, read(workCFile), reassigned), /cases is not a const/u);
  const workC = workCFile;
  const assigned = read(workC)
    .replace(
      "  const cases: readonly (readonly [string, string, readonly [string, string]])[] = [",
      "  let cases: readonly (readonly [string, string, readonly [string, string]])[];\n  cases = [",
    )
    .replace('"checks 142 checksSkipped 3 defScan', '"checks 143 checksSkipped 3 defScan');
  assert.match(
    check(workC, read(workC), assigned),
    /cases is not a const with its table as its initializer/u,
  );
  // (3: a spread overriding a family's main; an inherited or a repeated key in f18's expected object)
  const families = "tests/helpers/type-core-families.ts";
  const spread = read(families).replace(
    "    outputBound: true,\n    main: {",
    "    outputBound: true,\n    ...({ main: { 16: [], 32: [] } } as Partial<OutputBoundFamily>),\n    main: {",
  );
  assert.match(
    check(families, read(families), spread),
    /a family holds a SpreadAssignment, not a plain property/u,
  );
  const f18 = "tests/type-core-f18.test.ts";
  const expected = "{ total: 246, decisions: [15], default: [4] }";
  for (const [changed, refused] of [
    [
      '{ total: 246, decisions: [15], default: [4], constructor: Number("247") }',
      /not one of total, decisions, default/u,
    ],
    ["{ total: 246, total: 247, decisions: [15], default: [4] }", /names total twice/u],
    // (4: a value moved from one field to another)
    ["{ total: 246, decisions: [], default: [15, 4] }", /new or re-pinned/u],
  ])
    assert.match(check(f18, read(f18), read(f18).replace(expected, changed)), refused, changed);
  // (5: an unchanged header comment holding a U+2028, which TypeScript counts as a line break and Git does not)
  const title = 'test("the capture ends at the first store';
  const base = read(capture).replace(title, `/* one two */\n${title}`);
  const head = base
    .replace(title, title.replace("test(", "test( "))
    .replace("22_962_573", "22_962_574");
  assert.match(
    check(capture, base, head),
    new RegExp(`:${lineIn(head, "22_962_574")}: .*new or re-pinned`, "u"),
  );
  // (6: a base whose pin the check cannot read, or that does not parse, with a grounded head)
  const grounded = read(capture).replace(
    pin,
    "  // (1 unit more since #1)\n  assert.equal(budget.total, 22_962_574);",
  );
  for (const unreadable of [
    read(capture).replace(pin, '  assert.equal(budget.total, Number("22962573"));'),
    read(capture).replace(pin, `${pin.slice(0, -2)};`),
  ])
    assert.match(
      check(capture, unreadable, grounded),
      /at the base, line \d+: .*\n {2}Its pins cannot be compared there/u,
    );
});

/** A temporary Git repository holding the two tools, `node_modules` and the suite files `files`, committed. */
function repository(files) {
  const directory = mkdtempSync(join(tmpdir(), "pin-grounds-"));
  const git = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  mkdirSync(join(directory, "tools/repository-checks"), { recursive: true });
  for (const tool of ["pin-suites.mjs", "pin-grounds.mjs"])
    copyFileSync(
      join(ROOT, "tools/repository-checks", tool),
      join(directory, "tools/repository-checks", tool),
    );
  mkdirSync(join(directory, "tests/moved"), { recursive: true });
  for (const file of files) copyFileSync(join(ROOT, file), join(directory, file));
  symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"));
  writeFileSync(join(directory, ".gitignore"), "node_modules\n");
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  return { directory, git };
}

/** `pin-suites.mjs --base HEAD --check-grounds` in a repository: its exit status and output. */
const checkGrounds = (directory) =>
  new Promise((done) =>
    execFile(
      process.execPath,
      ["tools/repository-checks/pin-suites.mjs", "--base", "HEAD", "--check-grounds"],
      { cwd: directory, encoding: "utf8" },
      (error, stdout, stderr) => done({ status: error === null ? 0 : error.code, stdout, stderr }),
    ),
  );

test(
  "--check-grounds reads a changed pin file against the merge-base, a moved one against what it was, a new one not at all",
  { timeout: 60_000 },
  async () => {
    const capture = "tests/type-core-contract-capture.test.ts";
    const candidate = "tests/type-core-candidate.test.ts";
    const moved = "tests/moved/type-core-contract-capture.test.ts";
    const repinned = read(capture).replace("22_962_573", "22_962_574");
    const scenarios = {
      "re-pinned": [
        1,
        /contract-capture\.test\.ts:\d+: .*new or re-pinned \(22962574\)[^]*grounds: 1 changed pin file read in \d+\.\ds, 1 refusal/u,
        ({ directory }) => writeFileSync(join(directory, capture), repinned),
      ],
      grounded: [
        0,
        /grounds: 1 changed pin file read/u,
        ({ directory }) =>
          writeFileSync(
            join(directory, capture),
            repinned.replace(
              "  assert.equal(budget.total, 22_962_574);",
              "  // (1 unit more since #1)\n  assert.equal(budget.total, 22_962_574);",
            ),
          ),
      ],
      // (a suite file new since the merge-base has no base: listed, not read)
      "new file": [
        0,
        /grounds: 0 changed pin files read/u,
        ({ directory, git }) => {
          git("rm", "-q", candidate);
          git(
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            "without the candidate suite",
          );
          copyFileSync(join(ROOT, candidate), join(directory, candidate));
        },
      ],
      // (the file moved, its declarations with it: unchanged it passes, re-pinned it is refused)
      moved: [
        0,
        /grounds: 1 changed pin file read/u,
        ({ directory, git }) => moveTo(directory, git),
      ],
      "moved and re-pinned": [
        1,
        /moved\/type-core-contract-capture\.test\.ts:\d+: .*new or re-pinned \(22962574\)/u,
        ({ directory, git }) => {
          moveTo(directory, git);
          writeFileSync(join(directory, moved), repinned);
        },
      ],
      // (the file's blob gone from the object store, the file deleted: the tree still lists it, Git cannot show it)
      "unreadable base": [
        2,
        /Git cannot read tests\/type-core-contract-capture\.test\.ts at /u,
        ({ directory, git }) => {
          const blob = git("rev-parse", `HEAD:${capture}`).stdout.trim();
          rmSync(join(directory, ".git/objects", blob.slice(0, 2), blob.slice(2)));
          rmSync(join(directory, capture));
        },
      ],
    };
    function moveTo(directory, git) {
      git("mv", capture, moved);
      for (const tool of ["pin-suites.mjs", "pin-grounds.mjs"]) {
        const path = join(directory, "tools/repository-checks", tool);
        writeFileSync(path, readFileSync(path, "utf8").replaceAll(`"${capture}"`, `"${moved}"`));
      }
    }
    const repositories = Object.values(scenarios).map(() => repository([capture, candidate]));
    try {
      Object.values(scenarios).forEach(([, , edit], index) => edit(repositories[index]));
      const runs = await Promise.all(repositories.map(({ directory }) => checkGrounds(directory)));
      Object.entries(scenarios).forEach(([name, [status, output]], index) => {
        assert.equal(
          runs[index].status,
          status,
          `${name}: ${runs[index].stdout}${runs[index].stderr}`,
        );
        assert.match(runs[index].stdout + runs[index].stderr, output, name);
      });
    } finally {
      for (const { directory } of repositories) rmSync(directory, { recursive: true, force: true });
    }
  },
);
