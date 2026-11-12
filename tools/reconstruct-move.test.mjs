import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit } from "./fixture-git.mjs";

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

/** A repository whose one commit holds `src/big.ts` as OLD, with the split written over it; `run` runs the check. */
function repository(t, files = { "src/big.ts": KEPT, "src/part.ts": PART }) {
  const fixture = mkdtempSync(join(tmpdir(), "reconstruct-move-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: fixture, encoding: "utf8" }).trim();
  git("init", "-q");
  mkdirSync(join(fixture, "src"));
  writeFileSync(join(fixture, "src/big.ts"), OLD);
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
    /^old body lines: 11, taken: 10; runs: 5; export added: 1; residue: 1 old, 5 new; edits: 0$/mu,
  );
  assert.match(out, /^export added: src\/part\.ts:5 <- old 12$/mu);
  assert.match(out, /^residue rewrapped:\n {2}old 16: function third\(/mu);
});

test("each kind of change that is no move fails: a dropped, an edited, a repeated or a reordered line", (t) => {
  const cases = {
    dropped: { "src/big.ts": KEPT, "src/part.ts": replaced(PART, 6) },
    edited: { "src/big.ts": KEPT, "src/part.ts": replaced(PART, 6, "  return b + 1;") },
    repeated: { "src/big.ts": KEPT, "src/part.ts": `${PART}\nconst LAST = 3;\n` },
    reordered: {
      "src/big.ts": replaced(
        replaced(KEPT, 6, "const LAST = 3;"),
        10,
        "export function first(): number {",
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
  const declared = r.run("--edit", "src/part.ts:6=13");
  assert.equal(declared.status, 0, declared.out);
  assert.match(
    declared.out,
    /^edit: src\/part\.ts:6: {3}return b; \/\/ edited\n {2}read as old 13: {3}return b;$/mu,
  );
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
