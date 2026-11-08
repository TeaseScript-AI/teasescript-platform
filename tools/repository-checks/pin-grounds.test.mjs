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
import { apply, cases, frozen, positions } from "./pin-grounds.fixture.mjs";
import { GROUNDS, readingOf, refusalsOf } from "./pin-grounds.mjs";
import { PIN_SUITES, addedLines } from "./pin-suites.mjs";

// The tests of `pin-grounds.mjs`, on the frozen suite texts of its fixture (`pin-grounds.fixture.mjs`), never on the
// live suites but where a test says so. The full mutation of every expected value runs apart:
// `node --test tools/repository-checks/pin-grounds.full.test.mjs`.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const live = (file) => readFileSync(join(ROOT, file), "utf8");
const read = frozen;
const POSITIONS = positions();

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
  "tests/type-core-work-c.test.ts assert.deepEqual([false, true].flatMap(…))",
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

test("every current pin, on the live suites, is read in its declared place, with no refusal, and matches itself", () => {
  const places = new Set();
  for (const [file, { listed }] of Object.entries(GROUNDS)) {
    if (listed) continue;
    const reading = readingOf(file, live(file));
    assert.deepEqual(reading.refusals, [], file);
    for (const record of reading.records) places.add(`${file} ${roleOf(record.place)}`);
    assert.deepEqual(refusalsOf(file, live(file), live(file), []), [], file);
  }
  assert.deepEqual([...places].sort(), PLANNED);
});

/** The offset of a 1-based line's 0-based column, lines counted by `\n`. */
const offsetOf = (text, line, column) =>
  text
    .split("\n")
    .slice(0, line - 1)
    .reduce((sum, each) => sum + each.length + 1, 0) + column;

test("each record's values are, in order, the expected values Codex r3 found in it, each in one record, from one parse a file", () => {
  const seen = new Set();
  for (const file of Object.keys(GROUNDS).filter((each) => !GROUNDS[each].listed)) {
    const offsets = POSITIONS.filter(([inFile]) => inFile === file).map((position) => [
      offsetOf(read(file), position[1], position[2]),
      position,
    ]);
    for (const record of readingOf(file, read(file)).records) {
      const inside = offsets.filter(
        ([offset]) => record.node.getStart() <= offset && offset < record.node.getEnd(),
      );
      for (const [, position] of inside) {
        const at = position.join(":");
        assert.ok(!seen.has(at), `${at} in two records`);
        seen.add(at);
      }
      // (a record's numbers, labels aside, in order: a sorted or deduplicated reading differs)
      const numbers = record.values
        .map((value) => value.replace(/^[a-z]+=/u, ""))
        .filter((value) => /^\d/u.test(value));
      assert.deepEqual(
        numbers,
        inside.map(([, [, , , text]]) => text.replaceAll("_", "")),
        `${file} ${record.place}`,
      );
    }
  }
  assert.equal(seen.size, POSITIONS.length);
});

test("a value of each place, moved by one, is refused without its ground and passes with one (the full set: pin-grounds.full.test.mjs)", () => {
  const sampled = new Set();
  for (const [file, line, column, text] of POSITIONS) {
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
    // (a listed suite and a new file are not read: their cases need no text)
    const refusals =
      witness.newFile || GROUNDS[witness.file].listed
        ? []
        : (() => {
            const main = read(witness.file);
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
  // (design-r6 refuses a second declared-form assertion: control-multiset-duplicate moved from G to U)
  assert.deepEqual(ended, { P: 60, E: 3, G: 86, U: 68 });
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
  // (two values swapped within a row: a row's values are read in order)
  const within = "[1539, 1617, 1539, 1617, 2424, 2149, 2289, 2149]";
  const swappedWithin = (text) =>
    text.replace(within, "[1617, 1539, 1539, 1617, 2424, 2149, 2289, 2149]");
  const withinLine =
    swappedWithin(read("tests/type-core-closure.test.ts"))
      .split("\n")
      .findIndex((text) => text.includes("[1617, 1539, 1539")) + 1;
  assert.equal(refusals("tests/type-core-closure.test.ts", swappedWithin, [withinLine]).length, 1);
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
      /is not found|declared more than once|not read as the pin/u,
      decoy,
    );
  // (1, a loop's shadowing decoy as the one declared-form assertion: its `budget` is not the test's)
  const shadowed = read(capture).replace(
    pin,
    "  for (const once of [0]) { const budget = { total: 22_962_573 + once }; assert.equal(budget.total, 22_962_573); }",
  );
  assert.match(
    check(capture, read(capture), shadowed),
    /budget is declared more than once in the test/u,
  );
  // (Opus r2: a declared-form assertion the reader does not take as the pin is refused, never dropped)
  const workCText = read(workCFile);
  for (const [file, base, head] of [
    [
      capture,
      read(capture),
      read(capture).replace(
        pin,
        `  if (budget.exhausted === null) {\n    assert.equal(budget.total, 22_962_574);\n    return;\n  }\n${pin}`,
      ),
    ],
    [
      capture,
      read(capture),
      read(capture).replace(
        pin,
        "  for (const _ of []) assert.equal(budget.total, 22_962_573);\n  if (budget.exhausted === null) assert.equal(budget.total, 22_962_574);",
      ),
    ],
    [
      workCFile,
      workCText,
      workCText
        .replace(
          "  assert.deepEqual(\n    [false, true].flatMap(",
          "  assert.deepEqual([3988, 3988, 4844, 4862], [3988, 3988, 4844, 4862]);\n  if (request !== null) assert.deepEqual(\n    [false, true].flatMap(",
        )
        .replace(
          "    [3988, 3988, 4844, 4862],\n  );\n});",
          "    [3988, 3988, 4844, 4863],\n  );\n});",
        ),
    ],
    [
      capture,
      read(capture),
      read(capture).replace(
        'test("the capture ends at the first store whose contract leaves the slice\'s depth", () => {',
        'test("the capture ends at the first store whose contract leaves the slice\'s depth", { skip: true }, () => {',
      ),
    ],
    [
      capture,
      read(capture),
      read(capture).replace(
        pin,
        "  for (const _ of [0]) {\n    enum budget { total = 22_962_573 }\n    assert.equal(budget.total, 22_962_573);\n  }\n  assert.equal((budget.total), 22_962_574);",
      ),
    ],
    [
      capture,
      read(capture).replace(pin, `${pin}\n  assert.equal(budget.total, 22_962_573, "again");`),
      read(capture).replace(
        pin,
        `${pin}\n  if (budget.exhausted === null) assert.equal(budget.total, 22_962_574, "again");`,
      ),
    ],
    [
      capture,
      read(capture),
      read(capture).replace(
        pin,
        "  for (const _ of []) assert.equal(budget.total, 22_962_573);\n  assert.equal((budget.total), 22_962_574);",
      ),
    ],
  ]) {
    assert.notEqual(head, base);
    assert.match(
      check(file, base, head),
      /not read as the pin|a second assert|takes options|declared more than once/u,
      head.slice(0, 0),
    );
  }
  // (each rule alone: a pin after a return, a pin whose `budget` an enum shadows, a pin written another way)
  for (const head of [
    read(capture).replace(pin, `  return;\n${pin}`),
    read(capture).replace(
      pin,
      `  for (const _ of [0]) {\n    enum budget { total = 22_962_573 }\n${pin}\n  }`,
    ),
    read(capture).replace(pin, "  assert.equal((budget.total), 22_962_573);"),
  ]) {
    assert.notEqual(head, read(capture));
    assert.match(
      check(capture, read(capture), head),
      /not read as the pin|declared more than once/u,
    );
  }
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
  for (const file of files) writeFileSync(join(directory, file), frozen(file));
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
          writeFileSync(join(directory, candidate), frozen(candidate));
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
      // (design-r6: a move whose owner is renamed is unpaired; an owner renamed in place is named as such)
      "moved, owner renamed": [
        1,
        /new since \w+, its owners whole in no base file, while the change deletes tests\/type-core-contract-capture\.test\.ts: unpaired/u,
        ({ directory, git }) => {
          moveTo(directory, git);
          retitle(directory, moved);
        },
      ],
      "owner renamed in place": [
        1,
        /is not found at the base: an owner renamed or new here/u,
        ({ directory }) => retitle(directory, capture),
      ],
      // (a test split out into a file of its own, the old file kept: compared with the file that held it)
      "split, unchanged": [
        0,
        /grounds: 1 changed pin file read in [\d.]+s, 0 refusals/u,
        ({ directory }) => splitOut(directory, false),
      ],
      "split, re-pinned": [
        1,
        /type-core-contract-capture-ends\.test\.ts:\d+: .*new or re-pinned \(22962574\)/u,
        ({ directory }) => splitOut(directory, true),
      ],
      // (the old path's blob gone: whether a base file holds its owners cannot be proved)
      "moved, the old blob unreadable": [
        2,
        /Git cannot read tests\/moved\/type-core-contract-capture\.test\.ts's owners at /u,
        ({ directory, git }) => {
          moveTo(directory, git);
          writeFileSync(join(directory, moved), repinned);
          const blob = git("rev-parse", `HEAD:${capture}`).stdout.trim();
          rmSync(join(directory, ".git/objects", blob.slice(0, 2), blob.slice(2)));
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
    const title = "the capture ends at the first store whose contract leaves the slice's depth";
    /** The capture test retitled in `file`, with its declaration, and re-pinned. */
    function retitle(directory, file) {
      writeFileSync(
        join(directory, file),
        repinned.replace(
          `test("${title}`,
          `test("a capture ends at the first store whose contract leaves the slice's depth`,
        ),
      );
      const path = join(directory, "tools/repository-checks/pin-grounds.mjs");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replaceAll(
          title,
          "a capture ends at the first store whose contract leaves the slice's depth",
        ),
      );
    }
    /** The capture test moved into a file of its own, the old file keeping the rest, its declaration moved with it. */
    function splitOut(directory, repin) {
      const split = "tests/type-core-contract-capture-ends.test.ts";
      const text = repin ? repinned : read(capture);
      const start = text.indexOf(`test("${title}`);
      const end = text.indexOf("\n});\n", start) + 5;
      const imports = text.slice(0, text.indexOf("\ntest(")) + "\n";
      writeFileSync(join(directory, split), imports + text.slice(start, end));
      writeFileSync(join(directory, capture), text.slice(0, start) + text.slice(end));
      for (const tool of ["pin-suites.mjs", "pin-grounds.mjs"]) {
        const path = join(directory, "tools/repository-checks", tool);
        writeFileSync(path, readFileSync(path, "utf8").replaceAll(`"${capture}"`, `"${split}"`));
      }
    }
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
