import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit } from "./fixture-git.mjs";

isolateGit();

// The scan reads fixture files only: the real file's spec is kept where its conditions change (#2488, the lead's R19).
const tool = fileURLToPath(new URL("./slice-conditions.mjs", import.meta.url));
const folders = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

const FILE = "src/type-inference/core/slice-syntax.ts";
const SOURCE = `function unwrapped(e) {
  let current = e;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}
function letNames(program) {
  return new Set(program.lets);
}
function describe(kind) {
  return kind;
}
export const DISPOSITIONS = {
  exitStatement: modelled(),
  identifier: {
    row: "modelled",
    visit: (node, { lets }) => (lets.has(node.name) || node.name === "x" ? walk([]) : refuse(node.span, "the name")),
  },
  loadExpression: {
    row: "modelled",
    visit: (node) => (unwrapped(node.key).kind === "nullLiteral" ? refuse(node.span, "load") : walk([])),
  },
};
export function outsideSyntax(files, globals) {
  const context = { lets: letNames(files[0]), globals };
  return describe(context);
}
`;

const COMPLETE = [
  {
    id: "loop",
    scope: "unwrapped",
    expression: 'current.kind === "parenthesizedExpression"',
    mutant: "false",
    expected: "kill",
    witness: "w",
  },
  {
    id: "lets",
    scope: "row identifier",
    expression: "lets.has(node.name)",
    mutant: "true",
    expected: "kill",
    witness: "w",
  },
  {
    id: "x",
    scope: "row identifier",
    expression: 'node.name === "x"',
    mutant: "false",
    expected: "restrict",
    witness: "w",
  },
  {
    id: "null",
    scope: "row loadExpression",
    expression: 'unwrapped(node.key).kind === "nullLiteral"',
    mutant: "false",
    expected: "kill",
    witness: "w",
  },
];

/** A Git checkout holding the fixture file and `spec`, and the scan's result there. */
function scanned(spec, ...args) {
  const root = mkdtempSync(path.join(tmpdir(), "slice-conditions-"));
  folders.push(root);
  mkdirSync(path.join(root, path.dirname(FILE)), { recursive: true });
  writeFileSync(path.join(root, FILE), SOURCE);
  writeFileSync(path.join(root, "spec.json"), JSON.stringify(spec));
  const result = spawnSync(process.execPath, [tool, "--spec", "spec.json", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { root, ...result };
}

test("a complete spec: the scope is the conditional rows and what they reach, with the walk's context", () => {
  const { status, stdout } = scanned(COMPLETE);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /^in scope: row identifier, row loadExpression, letNames, unwrapped$/mu);
  assert.match(stdout, /^outside: describe, outsideSyntax$/mu);
});

test("a token no entry covers fails the scan, named with its scope and line", () => {
  const { status, stdout } = scanned(COMPLETE.filter((entry) => entry.id !== "x"));
  assert.equal(status, 1);
  assert.match(stdout, /^uncovered: row identifier, line 16: node\.name === "x"$/mu);
});

test("an operand of `&&` or `||` that is no comparison is a token of its own", () => {
  const { status, stdout } = scanned(COMPLETE.filter((entry) => entry.id !== "lets"));
  assert.equal(status, 1);
  assert.match(stdout, /^uncovered: row identifier, line 16: lets\.has\(node\.name\)$/mu);
});

test("an entry whose expression its scope does not hold, or holds twice without an occurrence, is stale", () => {
  const stale = scanned([
    ...COMPLETE,
    { ...COMPLETE[1], id: "gone", expression: "lets.has(node.other)" },
  ]);
  assert.equal(stale.status, 1);
  assert.match(
    stale.stdout,
    /^stale: gone: 'lets\.has\(node\.other\)' is not in row identifier$/mu,
  );
  const twice = scanned([
    ...COMPLETE,
    { ...COMPLETE[0], id: "twice", scope: "unwrapped", expression: "current" },
  ]);
  assert.equal(twice.status, 1);
  assert.match(
    twice.stdout,
    /^stale: twice: 'current' occurs \d+ times in unwrapped; name its occurrence$/mu,
  );
});

test("each entry's patch applies to the file and replaces its expression with its mutant", () => {
  const { root, status, stdout } = scanned(COMPLETE, "--patches", "patches");
  assert.equal(status, 0, stdout);
  assert.deepEqual(readdirSync(path.join(root, "patches")).sort(), [
    "lets.patch",
    "loop.patch",
    "null.patch",
    "x.patch",
  ]);
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  const applied = git("apply", path.join(root, "patches", "lets.patch"));
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(
    readFileSync(path.join(root, FILE), "utf8"),
    /visit: \(node, \{ lets \}\) => \(true \|\| node\.name/u,
  );
});

/** A Git checkout holding `source` as the syntax table, and `git` run in it. */
function checkoutOf(source) {
  const root = mkdtempSync(path.join(tmpdir(), "slice-conditions-"));
  folders.push(root);
  mkdirSync(path.join(root, path.dirname(FILE)), { recursive: true });
  writeFileSync(path.join(root, FILE), source);
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  return { root, git };
}

const LAST = `export const DISPOSITIONS = {
  identifier: {
    row: "modelled",
    visit: (node) => (node.name === "x" ? walk([]) : refuse(node.span, "the name")),
  },
};
`;
const ONE_LINE = `export const DISPOSITIONS = { identifier: { row: "m", visit: (node) => (node.name === "x" ? walk([]) : refuse()) } };`;
const LAST_ENTRY = [
  {
    id: "x",
    scope: "row identifier",
    expression: 'node.name === "x"',
    mutant: "true",
    expected: "kill",
    witness: "w",
  },
];

test("a patch within three lines of the file's end applies, with and without a final newline, and on its last line (#2583)", () => {
  for (const [what, source] of [
    ["final newline", LAST],
    ["no final newline", LAST.slice(0, -1)],
    ["the condition on the last line, no final newline", ONE_LINE],
  ]) {
    const { root, git } = checkoutOf(source);
    writeFileSync(path.join(root, "spec.json"), JSON.stringify(LAST_ENTRY));
    const run = spawnSync(process.execPath, [tool, "--spec", "spec.json", "--patches", "p"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `${what}: ${run.stdout}${run.stderr}`);
    const applied = git("apply", path.join(root, "p", "x.patch"));
    assert.equal(applied.status, 0, `${what}: ${applied.stderr}`);
    assert.equal(
      readFileSync(path.join(root, FILE), "utf8"),
      source.replace('node.name === "x"', "true"),
      what,
    );
  }
});

test("a patch names the file by its repository path, whether --file is absolute or starts with ./, and one outside cannot run (#2583)", () => {
  const { root, git } = checkoutOf(LAST);
  writeFileSync(path.join(root, "spec.json"), JSON.stringify(LAST_ENTRY));
  for (const file of [path.join(root, FILE), `./${FILE}`]) {
    const run = spawnSync(
      process.execPath,
      [tool, "--file", file, "--spec", "spec.json", "--patches", "p"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(run.status, 0, `${file}: ${run.stdout}${run.stderr}`);
    const patch = readFileSync(path.join(root, "p", "x.patch"), "utf8");
    assert.ok(patch.startsWith(`diff --git a/${FILE} b/${FILE}\n`), patch);
    const checked = git("apply", "--check", path.join(root, "p", "x.patch"));
    assert.equal(checked.status, 0, `${file}: ${checked.stderr}`);
  }
  const outside = checkoutOf(LAST);
  const run = spawnSync(
    process.execPath,
    [tool, "--file", path.join(outside.root, FILE), "--spec", "spec.json", "--patches", "q"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(run.status, 2, run.stdout);
  assert.match(run.stderr, /is not under the current folder/u);
  assert.equal(readdirSync(root).includes("q"), false);
});
