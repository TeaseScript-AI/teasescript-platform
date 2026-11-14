import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareTexts } from "./comment-only.mjs";
import { isolateGit } from "../fixture-git.mjs";

isolateGit();

const tool = fileURLToPath(new URL("./comment-only.mjs", import.meta.url));

const CASES = [
  [
    "a block comment holding a line break after `return` is the statement's end",
    ["a.ts", "function f() {\n  return /*\n*/ 1;\n}\n", "function f() {\n  return 1;\n}\n"],
    ["differs in more", "a line break before `1` removed at 2:10 (3:4 at FROM)"],
  ],
  [
    "a block comment without a line break",
    ["a.ts", "function f() {\n  return /* one */ 1;\n}\n", "function f() {\n  return 1;\n}\n"],
    ["only comments", "comments deleted"],
  ],
  [
    "a line joined where the grammar reads no line break still differs",
    ["a.ts", "const a =\n  // Why.\n  f();\n", "const a = f();\n"],
    ["differs in more", "a line break before `f` removed"],
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
    "a kept comment shortened by deleting words",
    ["a.mjs", "// do not remove\nexport const a = 1;\n", "// do remove\nexport const a = 1;\n"],
    ["only comments", "comments changed"],
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
  [
    "a directive reaching more lines than the next",
    [
      "a.ts",
      "/* c8 ignore next 3 */\nf();\n// Why.\ng();\n",
      "/* c8 ignore next 3 */\nf();\ng();\n",
    ],
    ["not proven", "FROM holds a directive that reaches more than the next line"],
  ],
  ["a syntax error", ["a.ts", "f(;\n", "f( ;\n"], ["not proven", "FROM does not parse: 1:3:"]],
  [
    "a script, which may hold HTML-like comments",
    ["a.cjs", "// x\nf();\n", "f();\n"],
    ["not proven", "no parser"],
  ],
];

for (const [title, [path, from, to], [verdict, detail]] of CASES) {
  test(`${title}: ${verdict}`, () => {
    const result = compareTexts(path, from, to);
    assert.equal(result.verdict, verdict, result.detail);
    assert.ok(result.detail.startsWith(detail), result.detail);
  });
}

test("a line break before an arrow's `=>` differs, as Node rejects it while TypeScript's parser does not", () => {
  const from = "// remove\nconst f = (x) => x;\n";
  const to = "const f = (x)\n=> x;\n";
  assert.doesNotThrow(() => new Function(from));
  assert.throws(() => new Function(to), SyntaxError);
  assert.equal(compareTexts("a.mjs", from, to).verdict, "differs in more");
});

test("a deeply nested expression is compared without exhausting the stack", () => {
  const sum = Array.from({ length: 8000 }, () => "a").join(" + ");
  const result = compareTexts(
    "a.ts",
    `// Why.\nexport const s = ${sum};\n`,
    `export const s = ${sum};\n`,
  );
  assert.deepEqual(result, { verdict: "only comments", detail: "comments deleted" });
});

const CONSUMERS = [
  ["TypeScript", "a.ts", "// @ts-expect-error: the fixture is wrong on purpose."],
  ["TypeScript", "a.ts", '/// <reference types="node" />'],
  ["TypeScript", "a.mjs", "/** @type {number} */"],
  ["TypeScript and type-aware lint", "a.ts", "/** @deprecated Use `b`. */"],
  ["oxlint", "a.ts", "// oxlint-disable-next-line no-x -- EVIDENCE: fixture: x."],
  ["ESLint", "a.ts", "/* global window */"],
  ["Prettier", "a.ts", "// prettier-ignore"],
  ["Knip", "a.ts", "/** @public */"],
  ["Knip", "a.ts", "/* @beta */"],
  ["Knip", "a.ts", "/** @alias other */"],
  ["Vite", "a.ts", "/* @vite-ignore */"],
  ["Rolldown", "a.ts", "/*#__PURE__*/"],
  ["Rolldown", "a.ts", "/*! The license. */"],
  ["source maps", "a.mjs", "//# sourceMappingURL=a.mjs.map"],
  ["Node", "a.mjs", "#!/usr/bin/env node"],
  ["the type-assertion lint", "a.ts", "// EVIDENCE: validation: checked above."],
  ["pin-suites", "a.ts", "// pins: the stop's message | line /x/"],
  ["the retained-state lint", "a.ts", "// #1072 R26: captures nothing"],
];

for (const [consumer, path, comment] of CONSUMERS) {
  test(`${consumer} reads \`${comment}\`: deleting it, or a comment beside it, differs in more`, () => {
    const code = "export const a = 1;\n";
    const read = `${comment}\n${code}`;
    for (const [from, to] of [
      [read, code],
      [`${comment}\n// Why.\n${code}`, read],
    ]) {
      const result = compareTexts(path, from, to);
      assert.equal(result.verdict, "differs in more", `${JSON.stringify(from)}: ${result.detail}`);
      assert.match(result.detail, /a comment a tool reads/u);
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
    "new\nline.ts": `// Deleted.\n${program}`,
    "-leading.ts": `// Deleted.\n${program}`,
    "typed.ts": "export const a: number = 1;\n",
    "template.mjs": "export const x = `first\nsecond`;\n",
    "notes.md": "# Notes\n",
    "before.ts": "export const moved = 2;\n",
    "mode.mjs": program,
    "deleted.mjs": 'throw new Error("gone");\n',
  });
  const from = fixture.commit();
  fixture.write({
    "zeta.ts": program,
    "new\nline.ts": program,
    "-leading.ts": program,
    "typed.ts": "export const a: 1 = 1;\n",
    "template.mjs": "export const x = `first\nthird`;\n",
    "notes.md": "# Notes, changed\n",
    "added.ts": "export const added = 4;\n",
  });
  fixture.git("mv", "before.ts", "after.ts");
  fixture.git("rm", "-q", "deleted.mjs");
  chmodSync(join(fixture.root, "mode.mjs"), 0o755);
  const to = fixture.commit();

  const all = fixture.run(from, to);
  assert.equal(all.status, 1, all.stderr);
  assert.deepEqual(
    all.stdout.trimEnd().split("\n").sort(),
    [
      'only comments: "new\\nline.ts": comments deleted',
      "differs in more: added.ts: added",
      "differs in more: after.ts: renamed from before.ts",
      "differs in more: deleted.mjs: deleted",
      "differs in more: mode.mjs: mode 100644 became 100755",
      "differs in more: template.mjs: ``first\\nsecond`` became ``first\\nthird`` at 1:18 (1:18 at FROM)",
      "differs in more: typed.ts: `number` became `1` at 1:17 (1:17 at FROM)",
      "not proven: notes.md: no parser for this kind of file",
      "only comments: -leading.ts: comments deleted",
      "only comments: zeta.ts: comments deleted",
    ].sort(),
  );

  const filtered = fixture.run(from, to, "-leading.ts", "zeta.ts");
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(filtered.stdout.trimEnd().split("\n").sort(), [
    "only comments: -leading.ts: comments deleted",
    "only comments: zeta.ts: comments deleted",
  ]);

  const nothing = fixture.run(from, to, "missing.ts");
  assert.equal(nothing.status, 2);
  assert.match(nothing.stderr, /no file differs/u);

  const unknown = fixture.run(from, "no-such-commit");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /is no commit/u);
});
