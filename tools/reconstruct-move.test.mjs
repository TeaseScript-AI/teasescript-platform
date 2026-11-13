import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit } from "./fixture-git.mjs";
import { main, reconstruct } from "./reconstruct-move.mjs";

isolateGit();

const TOOL = fileURLToPath(new URL("./reconstruct-move.mjs", import.meta.url));

/** The old file: imports, a header line, four declarations, one of them long enough to rewrap with `export`. */
const OLD = [
  'import { a } from "./a.js";',
  "import {",
  "  b,",
  '} from "./b.js";',
  "",
  "// The old file's header.",
  "",
  "export function first(): number {",
  "  return a;",
  "}",
  "",
  "function second(): number {",
  "  return b;",
  "}",
  "",
  "function third(walk: WalkerOfTheTree, value: PlaceOfTheValue, rest: readonly string[]): number {",
  "  return second() + 1;",
  "}",
  "",
  "const LAST = 3;",
  "",
].join("\n");

/** The split: `first`, the header and `LAST` stay; `second` and `third` leave, each gaining `export`, `third` rewrapped. */
const KEPT = [
  'import { a } from "./a.js";',
  'import { second, third } from "./part.js";',
  "",
  "// The old file's header.",
  "",
  "export function first(): number {",
  "  return a;",
  "}",
  "",
  "const LAST = 3;",
  "",
].join("\n");
const PART = [
  "// The part that left.",
  "",
  'import { b } from "./b.js";',
  "",
  "export function second(): number {",
  "  return b;",
  "}",
  "",
  "export function third(",
  "  walk: WalkerOfTheTree,",
  "  value: PlaceOfTheValue,",
  "  rest: readonly string[],",
  "): number {",
  "  return second() + 1;",
  "}",
  "",
].join("\n");

/**
 * Two lines that end OLD and the first NEW file of every fixture unless `controls` is false: a passing check runs its
 * controls on two adjacent lines OLD holds once each, which a fixture of a few lines may not have.
 */
const CONTROL_LINES = "\nconst controlOne = 1;\nconst controlTwo = 2;\n";

/** A repository whose one commit holds `src/big.ts` as OLD, with the split written over it; `run` runs the check. */
function repository(
  t,
  files = { "src/big.ts": KEPT, "src/part.ts": PART },
  old = OLD,
  { controls = true } = {},
) {
  if (controls) {
    const ended = (text) => `${text}${text.endsWith("\n") ? "" : "\n"}${CONTROL_LINES}`;
    old = ended(old);
    const [first] = Object.keys(files);
    files = { ...files, [first]: ended(files[first]) };
  }
  const fixture = mkdtempSync(join(tmpdir(), "reconstruct-move-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: fixture, encoding: "utf8" }).trim();
  git("init", "-q");
  mkdirSync(join(fixture, "src"));
  writeFileSync(join(fixture, "src/big.ts"), old);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    writeFileSync(join(fixture, file), text);
  }
  const run = (...extra) => {
    const result = spawnSync(
      process.execPath,
      [TOOL, base, "src/big.ts", ...Object.keys(files), ...extra],
      { cwd: fixture, encoding: "utf8" },
    );
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  return { base, run, fixture };
}

/** `text` with its line `at` (1-based) replaced by `lines`. */
const replaced = (text, at, ...lines) => {
  const all = text.split("\n");
  all.splice(at - 1, 1, ...lines);
  return all.join("\n");
};

test("a split that keeps the old file is proven: every line once, `export` added and a rewrap listed", (t) => {
  const { status, out } = repository(t).run();
  assert.equal(status, 0, out);
  assert.match(
    out,
    /^old body lines: 13, taken: 12; runs: 6; export added: 1; residue: 1 old, 5 new; edits: 0$/mu,
  );
  assert.match(out, /^export added: src\/part\.ts:5 <- old 12$/mu);
  assert.match(out, /^residue rewrapped:\n {2}old 16: function third\(/mu);
});

test("each kind of change that is no move fails: a dropped, an edited, a repeated or a reordered line", (t) => {
  const cases = {
    dropped: { "src/big.ts": KEPT, "src/part.ts": replaced(PART, 6) },
    edited: { "src/big.ts": KEPT, "src/part.ts": replaced(PART, 6, "  return b + 1;") },
    repeated: { "src/big.ts": KEPT, "src/part.ts": `${PART}\nconst LAST = 3;\n` },
    // (valid source, `LAST` now before `first`)
    reordered: {
      "src/big.ts": KEPT.replace("\nconst LAST = 3;\n", "\n").replace(
        "export function first",
        "const LAST = 3;\n\nexport function first",
      ),
      "src/part.ts": PART,
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    const { status, out } = repository(t, files).run();
    assert.equal(status, 1, `${name}\n${out}`);
    assert.match(out, /^failure: /mu, name);
  }
});

test("a residue is admitted only as a rewrap of a declaration that gained `export`", (t) => {
  // (`async` added: the group no longer equals the old line)
  const added = repository(t, {
    "src/big.ts": KEPT,
    "src/part.ts": replaced(PART, 9, "export async function third("),
  }).run();
  assert.equal(added.status, 1, added.out);
  assert.match(added.out, /^residue not a rewrap:$/mu);
  // (a break that can end a statement: after `return`, where a semicolon is inserted)
  const unsafe = repository(t, {
    "src/big.ts": KEPT,
    "src/part.ts": [
      'import { b } from "./b.js";',
      "",
      "export function second(): number {",
      "  return b;",
      "}",
      "",
      // (equal to old 16 and 17 as rewrapped, but broken after `return`: only the break rejects it)
      "export function third(walk: WalkerOfTheTree, value: PlaceOfTheValue, rest: readonly string[]): number { return",
      "  second() + 1;",
      "}",
      "",
    ].join("\n"),
  }).run();
  assert.equal(unsafe.status, 1, unsafe.out);
  assert.match(unsafe.out, /^residue not a rewrap:$/mu);
  // (rewrapped without `export`: Prettier had no reason to)
  const plain = repository(t, {
    "src/big.ts": KEPT.replace("import { second, third }", "import { second }"),
    "src/part.ts": PART.replace("export function third(", "function third("),
  }).run();
  assert.equal(plain.status, 1, plain.out);
});

test("--edit declares one changed line and prints both; an edit that names no line cannot run", (t) => {
  const files = { "src/big.ts": KEPT, "src/part.ts": replaced(PART, 6, "  return b; // edited") };
  const r = repository(t, files);
  for (const spelling of ["src/part.ts:6=13", "src/part.ts:6-6=src/big.ts:13-13"]) {
    const declared = r.run("--edit", spelling);
    assert.equal(declared.status, 0, declared.out);
    assert.match(
      declared.out,
      /^edit: src\/part\.ts:6-6=13-13\n {2}old 13: {3}return b;\n {2}new src\/part\.ts:6: {3}return b; \/\/ edited$/mu,
    );
  }
  assert.equal(r.run().status, 1);
  assert.equal(r.run("--edit", "src/part.ts:99=13").status, 2);
  assert.equal(r.run("--edit", "src/other.ts:6=13").status, 2);
  assert.equal(r.run("--edit", "src/part.ts:six").status, 2);
});

test("usage, an unknown option, an unknown commit or a missing file cannot run", (t) => {
  const r = repository(t);
  const run = (...args) =>
    spawnSync(process.execPath, [TOOL, ...args], { cwd: r.fixture, encoding: "utf8" }).status;
  assert.equal(run(), 2);
  assert.equal(run(r.base, "src/big.ts"), 2);
  assert.equal(run("--help"), 2);
  assert.equal(run("0000000000000000000000000000000000000000", "src/big.ts", "src/big.ts"), 2);
  assert.equal(run(r.base, "src/big.ts", "src/missing.ts"), 2);
});

/** A declaration a later line reads, long enough that `export` makes Prettier break it. */
const OBJECT = [
  'const first = { value: "a b", other: 1, more: "long enough to wrap the line once export is added" };',
  "",
  "const second = first.value;",
  "",
].join("\n");
const wrapped = (value) =>
  [
    "export const first = {",
    `  value: ${value},`,
    "  other: 1,",
    '  more: "long enough to wrap the line once export is added",',
    "};",
  ].join("\n");

test("a rewrap keeps each literal's text and the old order; `export` goes only on a declaration at the margin (#2534 r1)", (t) => {
  const run = (text, old = OBJECT) => repository(t, { "src/big.ts": text }, old).run();
  assert.equal(run(`${wrapped('"a b"')}\n\nconst second = first.value;\n`).status, 0);
  // (a string's spaces, or a comma inside it, are its text, not layout)
  assert.equal(run(`${wrapped('"ab"')}\n\nconst second = first.value;\n`).status, 1);
  const comma = OBJECT.replace('"a b"', '"a,)"');
  assert.equal(run(`${wrapped('"a,)"')}\n\nconst second = first.value;\n`, comma).status, 0);
  assert.equal(run(`${wrapped('"a)"')}\n\nconst second = first.value;\n`, comma).status, 1);
  // (a rewrap holding a regular expression or a template literal is refused, its text unread by the token scan)
  const regex = OBJECT.replace('"a b"', "/a b/u");
  assert.equal(run(`${wrapped("/a b/u")}\n\nconst second = first.value;\n`, regex).status, 1);
  const template = OBJECT.replace('"a b"', "`a b`");
  assert.equal(run(`${wrapped("`a b`")}\n\nconst second = first.value;\n`, template).status, 1);
  // (the rewrapped declaration after the line that reads it: out of the old order)
  const after = run(`const second = first.value;\n\n${wrapped('"a b"')}\n`);
  assert.equal(after.status, 1);
  assert.match(after.out, /^failure: src\/big\.ts:3: out of the old file's order/mu);
  // (`export` before a line that is no declaration, where the result still parses: a block becomes an export list)
  assert.equal(run("const a = 1;\nexport { a };\n", "const a = 1;\n{ a };\n").status, 1);
  // (a generator is a declaration too)
  assert.equal(
    run(
      "export function* gen(): Generator<number> {\n  yield 1;\n}\n",
      "function* gen(): Generator<number> {\n  yield 1;\n}\n",
    ).status,
    0,
  );
});

test("the header is the parsed imports: a trailing comment ends one, code after one is body, other line ends cannot run (#2534 r1)", (t) => {
  const old =
    'import { value } from "./values.js"; // shared fixture\n\nconst result = value + 1;\n';
  const run = (text) => repository(t, { "src/big.ts": text }, old).run();
  const same = run(old);
  assert.equal(same.status, 0, same.out);
  assert.match(same.out, /^old body lines: 3, taken: 3;/mu);
  assert.equal(run(old.replace("value + 1", "value + 999")).status, 1);
  assert.equal(run('import { value } from "./values.js"; const result = value + 1;\n').status, 1);
  // (code after an import on its line, every old line kept: only the header rule fails it)
  assert.equal(run(old.replace("// shared fixture", "const added = 2;")).status, 1);
  // (a header line outside the listed forms is body: a shebang, a block comment before or between imports)
  const stable = "const stable = 1;\n";
  const header = (text) => repository(t, { "src/big.ts": text }, stable).run().status;
  assert.equal(header('import "./setup.js";\nexport const stable = 1;\n'), 0);
  assert.equal(header('#!/usr/bin/env node\nimport "./setup.js";\nexport const stable = 1;\n'), 1);
  assert.equal(header('/* added */\nimport "./setup.js";\nexport const stable = 1;\n'), 1);
  assert.equal(
    header('import "./setup.js";\n/* added */\nimport "./more.js";\nexport const stable = 1;\n'),
    1,
  );
  assert.equal(run(old.replaceAll("\n", "\r\n")).status, 2);
  assert.equal(run(`// header\u2028const hidden = 1;\n${old}`).status, 2);
});

test("a line break inside a token is its content: a blank line in a template or a comment is compared, and a token's lines stay together (#2534 final)", (t) => {
  const run = (old, files) => repository(t, files, old).run();
  const template = "const text = `alpha\n\nbeta`;\n";
  // (unchanged, `export` added: passes; the blank line inside the literal is a line like any other)
  assert.equal(run(template, { "src/big.ts": `export ${template}` }).status, 0);
  // (a blank line dropped from, or added to, the literal: its value changes)
  assert.equal(run(template, { "src/big.ts": "export const text = `alpha\nbeta`;\n" }).status, 1);
  assert.equal(
    run("const text = `alpha\nbeta`;\n", { "src/big.ts": "const text = `alpha\n\nbeta`;\n" })
      .status,
    1,
  );
  // (the same in a block comment)
  const comment = "/* first\n\nsecond */\nconst value = 1;\n";
  assert.equal(run(comment, { "src/big.ts": "/* first\nsecond */\nconst value = 1;\n" }).status, 1);
  // (and in a comment after a statement on its line)
  const trailing = "const value = 1; /* first\n\nsecond */\nconst other = 2;\n";
  assert.equal(
    run(trailing, { "src/big.ts": "const value = 1; /* first\nsecond */\nconst other = 2;\n" })
      .status,
    1,
  );
  // (a literal's middle line in another file: each file keeps OLD's order, but the literal is cut)
  const three = "const text = `one\ntwo\nthree`;\n";
  assert.equal(
    run(three, { "src/big.ts": "const text = `one\nthree`;\n", "src/part.ts": "two\n" }).status,
    1,
  );
  // (a line inside a literal that reads like a declaration takes no `export`)
  const inner = "const text = `head\nconst inner = 1;\n`;\n";
  assert.equal(
    run(inner, { "src/big.ts": "const text = `head\nexport const inner = 1;\n`;\n" }).status,
    1,
  );
});

test("in a rewrap a comma is dropped only as a trailing comma, never an elision, comments not counted (#2534 final)", (t) => {
  const old = (array) =>
    `const veryLongDescriptiveDeclarationName = { firstValue: ${array}, secondValue: "123456789012345" };\n`;
  const wrapped = (array) =>
    [
      "export const veryLongDescriptiveDeclarationName = {",
      `  firstValue: ${array},`,
      '  secondValue: "123456789012345",',
      "};",
      "",
    ].join("\n");
  const run = (before, after) =>
    repository(t, { "src/big.ts": wrapped(after) }, old(before)).run().status;
  assert.equal(run("[]", "[]"), 0);
  // (an elision is content, bare or after a comment: a comment is no element)
  assert.equal(run("[]", "[,]"), 1);
  assert.equal(run("[/* placeholder */]", "[/* placeholder */,]"), 1);
  assert.equal(run("[, /* hole */]", "[, /* hole */,]"), 1);
  // (a trailing comma after an element is layout, with or without a comment before it)
  assert.equal(run("[1]", "[1,]"), 0);
  assert.equal(run("[1 /* one */]", "[1 /* one */,]"), 0);
});

test("a file that does not parse cannot run (#2534 final)", (t) => {
  const r = repository(t, { "src/big.ts": "const text = `open;\n" }, "const value = 1;\n");
  assert.equal(r.run().status, 2);
});

/** `OBJECT`'s first declaration with a template literal: a rewrap the token scan refuses. */
const TEMPLATE = OBJECT.replace('"a b"', "`a b`");
const TEMPLATE_SPLIT = `${wrapped("`a b`")}\n\nconst second = first.value;\n`;

test("a range --edit declares a rewrap whose line count changes: one unit, both sides printed whole (#2547)", (t) => {
  const r = repository(t, { "src/big.ts": TEMPLATE_SPLIT }, TEMPLATE);
  assert.equal(r.run().status, 1);
  const declared = r.run("--edit", "src/big.ts:1-5=src/big.ts:1-1");
  assert.equal(declared.status, 0, declared.out);
  assert.match(
    declared.out,
    /^old body lines: 4, taken: 4; runs: 2; export added: 0; residue: 0 old, 0 new; edits: 1$/mu,
  );
  assert.match(
    declared.out,
    /^edit: src\/big\.ts:1-5=1-1\n {2}old 1: const first = \{ value: `a b`, .*\n {2}new src\/big\.ts:1: export const first = \{\n(?: {2}new src\/big\.ts:[2-4]: .*\n){3} {2}new src\/big\.ts:5: \};$/mu,
  );
});

test("a range --edit that overlaps another, names no body line or another OLD cannot run (#2547)", (t) => {
  const r = repository(t, { "src/big.ts": TEMPLATE_SPLIT, "src/part.ts": PART }, TEMPLATE);
  const status = (...edits) => r.run(...edits.flatMap((edit) => ["--edit", edit])).status;
  assert.equal(status("src/big.ts:1-5=1", "src/big.ts:5=3"), 2);
  assert.equal(status("src/big.ts:1-5=1", "src/big.ts:7=1"), 2);
  assert.equal(status("src/big.ts:1-99=1"), 2);
  assert.equal(status("src/big.ts:1-5=1-99"), 2);
  assert.equal(status("src/big.ts:5-1=1"), 2);
  assert.equal(status("src/big.ts:1-5=1-0"), 2);
  assert.equal(status("src/big.ts:0-5=1"), 2);
  // (a NEW file's header line, the `//` line above its imports)
  assert.equal(status("src/part.ts:1-3=3"), 2);
  assert.equal(status("src/big.ts:1-5=src/other.ts:1"), 2);
});

test("a declared edit is one unit: no run takes its lines, and it keeps OLD's order and a token's lines together (#2547)", (t) => {
  // (new line 2 is declared part of the edit that takes old 3, so old 2 is left, though new line 2 equals it)
  const same = "a();\nb();\nc();\n";
  const declared = repository(t, { "src/big.ts": same }, same).run("--edit", "src/big.ts:2-3=3");
  assert.equal(declared.status, 1, declared.out);
  assert.match(declared.out, /^failure: old 2: not taken: b\(\);$/mu);
  const after = repository(
    t,
    { "src/big.ts": `const second = first.value;\n\n${wrapped("`a b`")}\n` },
    TEMPLATE,
  ).run("--edit", "src/big.ts:3-7=1");
  assert.equal(after.status, 1, after.out);
  assert.match(after.out, /^failure: src\/big\.ts:3: out of the old file's order/mu);
  // (a literal's middle line edited alone, between the lines that follow it on both sides: admitted, printed)
  const r = repository(
    t,
    { "src/big.ts": "const text = `one\nTWO\nthree`;\n" },
    "const text = `one\ntwo\nthree`;\n",
  );
  assert.equal(r.run().status, 1);
  const middle = r.run("--edit", "src/big.ts:2=2");
  assert.equal(middle.status, 0, middle.out);
  assert.match(middle.out, /^old body lines: 5, taken: 5; runs: 3;/mu);
  // (the literal's middle line in another file, its last line edited: every line taken, each file in OLD's order, but
  // the literal is cut on both sides)
  const cut = repository(
    t,
    { "src/big.ts": "const text = `one\nTHREE`;\n", "src/part.ts": "two;\n" },
    "const text = `one\ntwo;\nthree`;\n",
  ).run("--edit", "src/big.ts:2=3");
  assert.equal(cut.status, 1, cut.out);
  assert.match(cut.out, /^failure: old 3: a token's line taken apart/mu);
  assert.match(cut.out, /^failure: src\/big\.ts:2: a token's line placed apart/mu);
});

/** An old file that opens with a pin mark before its imports (#2545). */
const MARKED = [
  "// pins: the second value | line /^const second/u",
  'import { a } from "./a.js";',
  "",
  "const first = a;",
  "",
  "const second = 2;",
  "",
].join("\n");
const MARKED_KEPT = 'import { a } from "./a.js";\n\nconst first = a;\n';
const part = (...header) => [...header, "", "const second = 2;", ""].join("\n");

test("OLD's leading `//` lines are header, each carried unchanged first in one NEW file (#2545)", (t) => {
  const run = (files) => repository(t, files, MARKED).run();
  const carried = run({
    "src/big.ts": MARKED_KEPT,
    "src/part.ts": part(MARKED.split("\n")[0], "// The part."),
  });
  assert.equal(carried.status, 0, carried.out);
  assert.match(carried.out, /^old body lines: 4, taken: 4;/mu);
  assert.match(carried.out, /^header carried: src\/part\.ts:1 <- old 1$/mu);
  // (kept in the old file itself, the part with only its own line)
  const kept = run({
    "src/big.ts": `${MARKED.split("\n")[0]}\n${MARKED_KEPT}`,
    "src/part.ts": part("// The part."),
  });
  assert.equal(kept.status, 0, kept.out);
  assert.match(kept.out, /^header carried: src\/big\.ts:1 <- old 1$/mu);
  // (dropped, changed, after the file's own line, or carried twice)
  const dropped = run({ "src/big.ts": MARKED_KEPT, "src/part.ts": part("// The part.") });
  assert.equal(dropped.status, 1, dropped.out);
  assert.match(dropped.out, /^failure: old 1: header line not carried: \/\/ pins: /mu);
  const changed = MARKED.split("\n")[0].replace("second", "other");
  assert.equal(run({ "src/big.ts": MARKED_KEPT, "src/part.ts": part(changed) }).status, 1);
  const after = run({
    "src/big.ts": MARKED_KEPT,
    "src/part.ts": part("// The part.", MARKED.split("\n")[0]),
  });
  assert.equal(after.status, 1, after.out);
  assert.match(after.out, /^failure: src\/part\.ts:2: an old header line among the file's own/mu);
  const twice = run({
    "src/big.ts": `${MARKED.split("\n")[0]}\n${MARKED_KEPT}`,
    "src/part.ts": part(MARKED.split("\n")[0]),
  });
  assert.equal(twice.status, 1, twice.out);
  assert.match(twice.out, /^failure: src\/part\.ts:1: an old header line among the file's own/mu);
});

test("the runs around a declared edit keep their place in OLD, where a repeated line could take another (#2548 r1)", (t) => {
  // (the kept file first: the lone `}` after the edit is the edited function's, not the moved one's)
  const functions = (last) =>
    ["first", "moved", "last"]
      .map(
        (name) => `function ${name}() {\n  console.log("${name === "last" ? last : name}");\n}\n`,
      )
      .join("\n");
  const kept = functions("last").replace(/function moved[^}]*\}\n\n/u, "");
  const after = repository(
    t,
    {
      "src/big.ts": kept.replace('"last"', '"last changed"'),
      "src/part.ts": 'function moved() {\n  console.log("moved");\n}\n',
    },
    functions("last"),
  ).run("--edit", "src/big.ts:6=10");
  assert.equal(after.status, 0, after.out);
  // (the run before the edit: of two equal lines, the one the edit's OLD lines follow)
  const before = repository(
    t,
    {
      "src/big.ts": "const x = 1;\nsecond(); // edited\n",
      "src/part.ts": "const x = 1;\nfirst();\n",
    },
    "const x = 1;\nfirst();\n\nconst x = 1;\nsecond();\n",
  ).run("--edit", "src/big.ts:2=5");
  assert.equal(before.status, 0, before.out);
});

test("a late import is header on both sides: a split of a file with an import after its first statement is proven (#2556)", (t) => {
  // (the shape `type-core-oracles.test.ts` had before its split: imports, a declaration, one more import, the tests)
  const old = [
    'import { a } from "./a.js";',
    "",
    "const LIMIT = 3;",
    'import { b } from "./b.js";',
    "",
    'test("first", () => {',
    "  assert(a < LIMIT);",
    "});",
    "",
    'test("second", () => {',
    "  assert(b > LIMIT);",
    "});",
    "",
  ].join("\n");
  const files = {
    "src/setup.ts": "export const LIMIT = 3;\n",
    "src/one.ts": [
      'import { a } from "./a.js";',
      'import { LIMIT } from "./setup.js";',
      "",
      'test("first", () => {',
      "  assert(a < LIMIT);",
      "});",
      "",
    ].join("\n"),
    // (late imports of the new file's own, one of them new: header too)
    "src/two.ts": [
      'test("second", () => {',
      "  assert(b > LIMIT);",
      "});",
      'import { b } from "./b.js";',
      'import { LIMIT } from "./setup.js";',
      "",
    ].join("\n"),
  };
  const r = repository(t, files, old);
  const proven = r.run();
  assert.equal(proven.status, 0, proven.out);
  assert.match(proven.out, /^old body lines: 9, taken: 9; runs: 4; export added: 1;/mu);
  // (an edit cannot take an import line of the header, on either side)
  const oldSide = r.run("--edit", "src/two.ts:1=4");
  assert.equal(oldSide.status, 2);
  assert.match(oldSide.err, /holds OLD's import line 4$/mu);
  const newSide = r.run("--edit", "src/two.ts:5=6");
  assert.equal(newSide.status, 2);
  assert.match(newSide.err, /holds the import line src\/two\.ts:5$/mu);
  // (an import that does not end its line is no header line: compared, it is no old line)
  const shared = repository(
    t,
    { ...files, "src/two.ts": files["src/two.ts"].replace('"./b.js";', '"./b.js"; const c = 1;') },
    old,
  ).run();
  assert.equal(shared.status, 1, shared.out);
  // (nor is one that does not start at the left margin)
  const indented = repository(
    t,
    { ...files, "src/two.ts": files["src/two.ts"].replace("import { b }", "  import { b }") },
    old,
  ).run();
  assert.equal(indented.status, 1, indented.out);
});

test("a line OLD holds that another line took is reported with the lines that took it (#2564)", (t) => {
  const repeated = repository(t, {
    "src/big.ts": KEPT,
    "src/part.ts": `${PART}\nconst LAST = 3;\n`,
  }).run();
  assert.equal(repeated.status, 1, repeated.out);
  assert.match(
    repeated.out,
    /^failure: src\/part\.ts:17: an old line, not matched here \(old 20 by src\/big\.ts:10\): const LAST = 3;$/mu,
  );
  const added = repository(t, {
    "src/big.ts": KEPT,
    "src/part.ts": `${PART}\nconst NEW = 4;\n`,
  }).run();
  assert.match(added.out, /^failure: src\/part\.ts:17: not an old line: const NEW = 4;$/mu);
});

test("a move that passes runs its own controls: a dropped, a duplicated and a swapped line must each fail (#2564)", (t) => {
  const r = repository(t);
  const passed = r.run();
  assert.equal(passed.status, 0, passed.out);
  for (const name of ["dropped", "duplicated", "swapped"])
    assert.match(passed.out, new RegExp(`^control: ${name} src/big\\.ts:6, failed$`, "mu"));
  // (a check that sees nothing passes its controls too: it cannot judge)
  const printed = [];
  const blind = (...args) => ({ ...reconstruct(...args), failures: [] });
  const status = main(
    [r.base, "src/big.ts", "src/big.ts", "src/part.ts"],
    r.fixture,
    (line) => printed.push(line),
    blind,
  );
  assert.equal(status, 2, printed.join("\n"));
  assert.match(
    printed.join("\n"),
    /^control: dropped src\/big\.ts:6, passed: the check cannot judge$/mu,
  );
  // (an edit below the control's line moves with it)
  const numbers = "const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\n";
  // (no control lines: the edit is the file's last line, so one that did not move would name no line)
  const edited = repository(t, { "src/big.ts": numbers.replace("4;", "5;") }, numbers, {
    controls: false,
  }).run("--edit", "src/big.ts:4=4");
  assert.equal(edited.status, 0, edited.out);
  assert.match(edited.out, /^control: dropped src\/big\.ts:1, failed$/mu);
  // (a layout blank is no control line, though OLD holds it once: a swap with it changes nothing the check reads)
  const blank = repository(
    t,
    {
      "src/a.ts": "export const SWEEP = 1;\n\n",
      "src/b.ts": 'import { SWEEP } from "./a.js";\n\nexport function f() {\n  return SWEEP;\n}\n',
    },
    "export const SWEEP = 1;\n\nexport function f() {\n  return SWEEP;\n}\n",
    { controls: false },
  ).run();
  assert.equal(blank.status, 0, blank.out);
  assert.match(blank.out, /^control: swapped src\/b\.ts:3, failed$/mu);
  // (nor is a line of a late import: no run holds one)
  const imports =
    'import {\n  pre,\n} from "./pre.js";\nf();\nf();\nimport {\n  x,\n  y,\n} from "./x.js";\n';
  const late = repository(t, { "src/big.ts": imports }, imports, { controls: false }).run();
  assert.equal(late.status, 2, late.out);
  assert.match(late.out, /^control: none built/mu);
  // (a move of repeated lines only builds no control)
  const repeated = repository(t, { "src/big.ts": "f();\nf();\n" }, "f();\nf();\n", {
    controls: false,
  }).run();
  assert.equal(repeated.status, 2, repeated.out);
  assert.match(repeated.out, /^control: none built/mu);
});
