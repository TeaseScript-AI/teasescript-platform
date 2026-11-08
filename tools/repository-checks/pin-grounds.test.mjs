import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

/** The suites and places whose values the check must read, written here apart from the readers. */
const PLANNED = [
  "tests/helpers/type-core-families.ts main",
  "tests/type-core-candidate.test.ts assert.deepEqual(units)",
  "tests/type-core-closure.test.ts OUTSIDE's totals",
  "tests/type-core-contract-capture.test.ts assert.equal(budget.total)",
  "tests/type-core-f18.test.ts assert.deepEqual({ total, decisions, default })",
  "tests/type-core-work-a.test.ts assert.deepEqual(measured)",
  "tests/type-core-work-c.test.ts a case's counters",
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
    for (const record of reading.records) places.add(`${file} ${record.place}`);
    assert.deepEqual(refusalsOf(file, read(file), read(file), []), [], file);
  }
  assert.deepEqual([...places].sort(), PLANNED);
});

test("each expected value Codex r3 found, moved by one, is refused without its ground and passes with one", () => {
  for (const [file, line, column, text] of positions) {
    const lines = read(file).split("\n");
    const at = `${file}:${line}:${column + 1} ${text}`;
    assert.equal(lines[line - 1].slice(column, column + text.length), text, at);
    const moved = `${lines[line - 1].slice(0, column)}${Number(text.replaceAll("_", "")) + 1}${lines[line - 1].slice(column + text.length)}`;
    const head = [...lines.slice(0, line - 1), moved, ...lines.slice(line)].join("\n");
    const [refusal, ...more] = refusalsOf(file, read(file), head, [line]);
    assert.deepEqual(more, [], at);
    assert.match(refusal ?? "", new RegExp(`^${file}:\\d+: .*new or re-pinned`, "u"), at);
    // (the ground written directly above, once a line)
    if (
      positions.some(
        ([other, otherLine, otherColumn]) =>
          other === file && otherLine === line && otherColumn < column,
      )
    )
      continue;
    const indent = moved.slice(0, moved.length - moved.trimStart().length);
    const grounded = [
      ...lines.slice(0, line - 1),
      `${indent}// (1 unit more since #1)`,
      moved,
      ...lines.slice(line),
    ].join("\n");
    assert.deepEqual(refusalsOf(file, read(file), grounded, [line, line + 1]), [], at);
  }
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

test(
  "--check-grounds reads a changed pin file against the merge-base, and a new file not at all",
  { timeout: 30_000 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "pin-grounds-"));
    const git = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    const file = "tests/type-core-contract-capture.test.ts";
    try {
      for (const tool of ["pin-suites.mjs", "pin-grounds.mjs"]) {
        mkdirSync(join(directory, "tools/repository-checks"), { recursive: true });
        copyFileSync(
          join(ROOT, "tools/repository-checks", tool),
          join(directory, "tools/repository-checks", tool),
        );
      }
      mkdirSync(join(directory, "tests"));
      copyFileSync(join(ROOT, file), join(directory, file));
      symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"));
      writeFileSync(join(directory, ".gitignore"), "node_modules\n");
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
      const check = () =>
        spawnSync(
          process.execPath,
          ["tools/repository-checks/pin-suites.mjs", "--base", "HEAD", "--check-grounds"],
          { cwd: directory, encoding: "utf8" },
        );
      const moved = read(file).replace("22_962_573", "22_962_574");
      writeFileSync(join(directory, file), moved);
      const refused = check();
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(
        refused.stdout,
        /contract-capture\.test\.ts:\d+: .*new or re-pinned \(22962574\)/u,
      );
      assert.match(refused.stdout, /grounds: 1 changed pin file read in \d+\.\ds, 1 refusal/u);
      writeFileSync(
        join(directory, file),
        moved.replace(
          "  assert.equal(budget.total, 22_962_574);",
          "  // (1 unit more since #1)\n  assert.equal(budget.total, 22_962_574);",
        ),
      );
      assert.equal(check().status, 0);
      // (a suite file new since the merge-base has no base: it is listed, not read)
      const candidate = "tests/type-core-candidate.test.ts";
      copyFileSync(join(ROOT, candidate), join(directory, candidate));
      const fresh = check();
      assert.equal(fresh.status, 0, fresh.stdout);
      assert.match(fresh.stdout, /grounds: 1 changed pin file read/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

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
