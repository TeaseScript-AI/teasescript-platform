import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { READ_BY_TOOLS, compareTexts } from "./comment-only.mjs";
import { isolateGit } from "../fixture-git.mjs";

isolateGit();

const tool = fileURLToPath(new URL("./comment-only.mjs", import.meta.url));

// Each case: the file, its text at FROM and at TO, and the verdict with the start of its detail.
const CASES = [
  [
    "a block comment holding a line break after `return` is the statement's end",
    ["a.ts", "function f() {\n  return /*\n*/ 1;\n}\n", "function f() {\n  return 1;\n}\n"],
    [
      "differs in more",
      "the code parses differently, by a line break the grammar reads, at 2:3 (2:3 at FROM)",
    ],
  ],
  [
    "a block comment without a line break",
    ["a.ts", "function f() {\n  return /* one */ 1;\n}\n", "function f() {\n  return 1;\n}\n"],
    ["only comments", "comments deleted"],
  ],
  [
    "a comment deleted and the statement joined onto one line, where the grammar reads no line break",
    ["a.ts", "const a =\n  // Why.\n  f();\n", "const a = f();\n"],
    ["only comments", "comments deleted"],
  ],
  [
    "a line joined after the comment a tool reads above it, which widens the line it reaches",
    [
      "a.ts",
      "// oxlint-disable-next-line no-x -- EVIDENCE: e.\nf(a,\n  b);\n",
      "// oxlint-disable-next-line no-x -- EVIDENCE: e.\nf(a, b);\n",
    ],
    [
      "differs in more",
      "a line break before `b`, beside a comment a tool reads, removed at 2:6 (3:3 at FROM)",
    ],
  ],
  [
    "a line joined onto the line of a comment a tool reads at its end",
    [
      "a.ts",
      "f(\n  a); // oxlint-disable-line no-x -- EVIDENCE: e.\n",
      "f(a); // oxlint-disable-line no-x -- EVIDENCE: e.\n",
    ],
    ["differs in more", "the lines beside a comment a tool reads changed"],
  ],
  [
    "a comment deleted between two tokens that then read as one",
    ["a.ts", "const t = typeof/* x */x;\n", "const t = typeofx;\n"],
    ["differs in more", "`typeof` became `typeofx` at 1:11"],
  ],
  [
    "a type changed, which compiled JavaScript does not show",
    ["a.ts", "export const a: number = 1;\n", "export const a: 1 = 1;\n"],
    ["differs in more", "`number` became `1` at 1:17"],
  ],
  [
    "whitespace changed within a line",
    ["a.ts", "const a = [1, 2];\n", "const  a = [ 1,  2 ];\n"],
    ["only comments", "whitespace only"],
  ],
  [
    "a header, a doc comment and a line's end comment deleted",
    [
      "a.ts",
      "// The header.\nimport { b } from './b.ts';\n\n/** What `a` is for. */\nexport const a = b; // why\n",
      "import { b } from './b.ts';\n\nexport const a = b;\n",
    ],
    ["only comments", "comments deleted"],
  ],
  [
    "a comment rewritten",
    ["a.mjs", "// Old reason.\nexport const a = 1;\n", "// New reason.\nexport const a = 1;\n"],
    ["only comments", "comments added or rewritten"],
  ],
  [
    "a comment's text inside a template or a regular expression is code",
    [
      "a.mjs",
      "const t = `${t} // x`;\nconst r = /a\\/*b/;\n",
      "const t = `${t}`;\nconst r = /a\\/*b/;\n",
    ],
    ["differs in more", "`} // x`` became `}``"],
  ],
  [
    "a regular expression holding `/*`, with a comment deleted after it",
    ["a.mjs", "const r = /a\\/*b/; // c\n", "const r = /a\\/*b/;\n"],
    ["only comments", "comments deleted"],
  ],
  [
    "top-level `await` in a module reads a regular expression",
    ["a.mjs", "await /x*/g; // c\n", "await /x*/g;\n"],
    ["only comments", "comments deleted"],
  ],
  ["a syntax error", ["a.ts", "f(;\n", "f( ;\n"], ["not proven", "FROM does not parse: 1:3:"]],
  ["a kind of file without a parser", ["a.vue", "<!-- x -->\n", "\n"], ["not proven", "no parser"]],
];

for (const [title, [path, from, to], [verdict, detail]] of CASES) {
  test(`${title}: ${verdict}`, () => {
    const result = compareTexts(path, from, to);
    assert.equal(result.verdict, verdict, result.detail);
    assert.ok(result.detail.startsWith(detail), result.detail);
  });
}

// One comment for each entry of READ_BY_TOOLS, in the file it stands in, written above `export const a = 1;`.
const READ = {
  "a shebang": ["a.mjs", "#!/usr/bin/env node"],
  "a lint directive": ["a.ts", "// oxlint-disable-next-line no-x -- EVIDENCE: fixture: x."],
  "a TypeScript directive": ["a.ts", "// @ts-expect-error: the fixture is wrong on purpose."],
  "an `EVIDENCE:` reason": ["a.ts", "// EVIDENCE: validation: checked above."],
  "a `// pins` mark": ["a.ts", "// pins: the stop's message | line /x/"],
  "a doc comment with a tag, in JavaScript": ["a.mjs", "/** @type {number} */"],
  "a deprecation": ["a.ts", "/** @deprecated Use `b`. */"],
  "a build directive": ["a.ts", "/* @vite-ignore */"],
  "a formatter or coverage directive": ["a.ts", "// prettier-ignore"],
};

test("the samples name each comment a tool reads", () => {
  assert.deepEqual(Object.keys(READ).sort(), READ_BY_TOOLS.map(([name]) => name).sort());
});

for (const [name, [path, comment]] of Object.entries(READ)) {
  test(`${name}: deleting it, or a comment beside it, differs in more`, () => {
    const code = "export const a = 1;\n";
    const read = `${comment}\n${code}`;
    for (const [from, to] of [
      [read, code],
      [`${comment}\n// Why.\n${code}`, read],
    ]) {
      const result = compareTexts(path, from, to);
      assert.equal(result.verdict, "differs in more", `${JSON.stringify(from)}: ${result.detail}`);
      assert.ok(result.detail.includes(`(${name})`), result.detail);
    }
  });
}

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "comment-only-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    return git("rev-parse", "HEAD");
  };
  const run = (...args) =>
    spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
  return { root, git, write, commit, run };
}

test("the command prints one line per changed file and exits 0 only when each differs only in comments", (t) => {
  const fixture = gitFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const program = "export const value = 1;\n";
  fixture.write({
    "zeta.ts": `// Deleted.\n${program}`,
    "typed.ts": "export const a: number = 1;\n",
    "notes.md": "# Notes\n",
    "before.ts": "export const moved = 2;\n",
    "mode.mjs": program,
    "deleted.mjs": 'throw new Error("gone");\n',
  });
  const from = fixture.commit();
  fixture.write({
    "zeta.ts": program,
    "typed.ts": "export const a: 1 = 1;\n",
    "notes.md": "# Notes, changed\n",
    "added.ts": "export const added = 4;\n",
  });
  fixture.git("mv", "before.ts", "after.ts");
  fixture.git("rm", "-q", "deleted.mjs");
  chmodSync(join(fixture.root, "mode.mjs"), 0o755);
  const to = fixture.commit();

  const all = fixture.run(from, to);
  assert.equal(all.status, 1, all.stderr);
  assert.deepEqual(all.stdout.trimEnd().split("\n").sort(), [
    "differs in more: added.ts: added",
    "differs in more: after.ts: renamed from before.ts",
    "differs in more: deleted.mjs: deleted",
    "differs in more: mode.mjs: mode 100644 became 100755",
    "differs in more: typed.ts: `number` became `1` at 1:17 (1:17 at FROM)",
    "not proven: notes.md: no parser for this kind of file",
    "only comments: zeta.ts: comments deleted",
  ]);

  const filtered = fixture.run(from, to, "zeta.ts");
  assert.deepEqual(
    [filtered.status, filtered.stdout],
    [0, "only comments: zeta.ts: comments deleted\n"],
  );

  const nothing = fixture.run(from, to, "missing.ts");
  assert.equal(nothing.status, 2);
  assert.match(nothing.stderr, /no file differs/u);

  const unknown = fixture.run(from, "no-such-commit");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /is no commit/u);
});
