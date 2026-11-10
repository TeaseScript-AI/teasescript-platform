import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { addedLinesOfPatch, SUMMARY_KINDS } from "./structure-report.mjs";

const tool = fileURLToPath(new URL("./structure-report.mjs", import.meta.url));

/** `count` lines of code. */
const lines = (count, prefix = "export const x") =>
  Array.from({ length: count }, (_, i) => `${prefix}${i} = ${i};`).join("\n");
/** A file whose function `name` spans `count` lines. */
const longFunction = (name, count) =>
  `export function ${name}() {\n${Array.from({ length: count - 2 }, (_, i) => `  const v${i} = ${i};`).join("\n")}\n}`;

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

test(
  "--diff reports each signal the change adds to, crossing the line or already over, and nothing it leaves alone",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "structure-report-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const report = (...args) =>
      execFileSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      const folder = (dir, count) =>
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `${dir}/f${i}.ts`,
            `export const f${i} = ${i};`,
          ]),
        );
      write(root, {
        "src/over.ts": lines(1001),
        "src/under.ts": lines(999),
        // exactly 1000 lines, the last ended by a newline: not over 1000
        "src/exact.ts": `${lines(1000)}\n`,
        "src/quiet.ts": lines(1500),
        "src/functions.ts": `${longFunction("written", 160)}\n${longFunction("untouched", 160)}\n`,
        ...folder("src/wide", 21),
        ...folder("src/edge", 20),
        ...folder("src/target", 21),
        "src/moving.ts": lines(400),
        ...folder("tools", 13),
        "src/locks.ts": "export const locks = 1;",
        "src/item.ts": "export const item = 1;",
        "src/items.ts": "export const items = 1;",
      });
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      // the change
      write(root, {
        "src/over.ts": `${lines(1001)}\nexport const added = 1;`,
        "src/under.ts": `${lines(999)}\n${lines(5, "export const more")}`,
        "src/wide/new.ts": "export const n = 1;",
        "src/edge/new.ts": "export const n = 1;",
        "tools/new.ts": "export const n = 1;",
        "src/lock.ts": "export const lock = 1;",
        "src/fresh.ts": lines(301),
      });
      const functions = readFileSync(join(root, "src/functions.ts"), "utf8").replace(
        "const v5 = 5;",
        "const v5 = 55;",
      );
      writeFileSync(join(root, "src/functions.ts"), functions);
      writeFileSync(
        join(root, "src/exact.ts"),
        `${lines(1000).replace("x500 = 500", "x500 = 5000")}\n`,
      );
      // a move into a folder over 20: no file and no lines added
      renameSync(join(root, "src/moving.ts"), join(root, "src/target/moving.ts"));
      git("add", "-A");
      git("commit", "-q", "-m", "change");

      const out = report("--diff", base, "--json", join(root, "change.json"));
      assert.deepEqual(out.trim().split("\n"), [
        `structure signals this change adds to against ${base} (advisory; each asks for the seam or the reason there is none):`,
        "  file gaining over 300 lines: +301 src/fresh.ts",
        "  function over 150 lines that the change writes into: src/functions.ts:1 written (160 lines)",
        "  file over 1000 lines that the change adds to: src/over.ts (1002, was 1001)",
        "  file over 1000 lines that the change adds to: src/under.ts (1004, was 999)",
        "  folder over 20 files that the change adds to: src/edge/ (21, was 20)",
        "  folder over 20 files that the change adds to: src/wide/ (22, was 21)",
        "  top level over 12 files that the change adds to: tools/ (14, was 13)",
        "  names a letter apart: src/: lock  locks",
      ]);
      // --json holds the same lines, for a READY to quote
      const json = JSON.parse(readFileSync(join(root, "change.json"), "utf8"));
      assert.deepEqual(
        json.change.map(({ line }) => `  ${line}`),
        out.trim().split("\n").slice(1),
      );
      // a change that adds nothing says so in one line
      assert.equal(
        report("--diff", "HEAD").trim(),
        "structure signals this change adds to against HEAD: none",
      );
      // the whole tree's report counts each component's top level
      assert.match(report(), /^Top levels over 12 files: 1\n {2}14 {2}tools\/$/mu);
      // a ROOT selects what is read, never what is a top level: only the five components are, written either way
      assert.deepEqual(report("tools/", "--diff", base).trim().split("\n").slice(1), [
        "  top level over 12 files that the change adds to: tools/ (14, was 13)",
      ]);
      assert.deepEqual(report("src/wide", "--diff", base).trim().split("\n").slice(1), [
        "  folder over 20 files that the change adds to: src/wide/ (22, was 21)",
      ]);
      const selected = report("src/wide");
      assert.match(selected, /^Folders over 20 files: 1\n {2}22 {2}src\/wide\/$/mu);
      assert.match(selected, /^Top levels over 12 files: 0$/mu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "--diff reads the change as Git reports it, whatever the files are named and however the user's Git is configured",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "structure-report-names-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      // a configuration that changes what `git diff` prints: an external diff that prints nothing, a textconv driver
      // that doubles every line, no or other prefixes, relative paths and colour
      for (const [key, value] of [
        ["diff.external", "true"],
        ["diff.dup.textconv", "sed p"],
        ["diff.noprefix", "true"],
        ["diff.mnemonicPrefix", "true"],
        ["diff.relative", "true"],
        ["color.ui", "always"],
      ])
        git("config", key, value);
      const NAMES = [
        "src/space name.ts",
        "src/tab\tname.ts",
        'src/quote"name.ts',
        "src/new\nline.ts",
        "src/café.ts",
        "src/-dash.ts",
        "src/[bracket].ts",
        // a pathspec glob that would also match the next name
        "src/star*.ts",
        "src/starry.ts",
      ];
      write(root, {
        ".gitattributes": "*.ts diff=dup\n",
        ...Object.fromEntries(NAMES.map((name) => [name, lines(1001)])),
        "src/shrink.ts": lines(1003),
        "src/header.ts": `export const t = \`\nfirst\n\`;\n${longFunction("written", 160)}\n`,
        "outside/moving.ts": lines(400),
        "src/before-move.ts": lines(1001),
      });
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      write(root, {
        // one line more in each named file
        ...Object.fromEntries(
          NAMES.map((name) => [name, `${lines(1001)}\nexport const added = 1;`]),
        ),
        // one line fewer: a deletion-only hunk adds nothing
        "src/shrink.ts": lines(1003).replace("export const x500 = 500;\n", ""),
        // an added line that the patch shows as `+++ b/denominator.ts;`, and a line written in the function below it
        "src/header.ts": readFileSync(join(root, "src/header.ts"), "utf8")
          .replace("first", "++ b/denominator.ts;")
          .replace("const v5 = 5;", "const v5 = 55;"),
        // a move with one line more, to a name with two tabs after a letter that is not ASCII: `--numstat` writes a
        // move's two names as fields of their own
        "src/café\t\tname.ts": `${lines(1001)}\nexport const added = 1;`,
      });
      rmSync(join(root, "src/before-move.ts"));
      // a move from outside the roots into src/: no lines added
      renameSync(join(root, "outside/moving.ts"), join(root, "src/arrived.ts"));
      git("add", "-A");
      git("commit", "-q", "-m", "change");

      const result = spawnSync(
        process.execPath,
        [tool, "--diff", base, "--json", join(root, "change.json")],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const json = JSON.parse(readFileSync(join(root, "change.json"), "utf8"));
      const shown = (name) => (/[\t\n]/u.test(name) ? JSON.stringify(name) : name);
      assert.deepEqual(
        json.change.map(({ line }) => line).sort(),
        [
          "function over 150 lines that the change writes into: src/header.ts:4 written (160 lines)",
          ...[...NAMES, "src/café\t\tname.ts"].map(
            (name) =>
              `file over 1000 lines that the change adds to: ${shown(name)} (1002, was 1001)`,
          ),
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a hunk's added lines are its `+` lines, read inside the header's counts", () => {
  // two changed lines with two unchanged ones between them, as `diff.interHunkContext` makes one hunk of them
  assert.deepEqual(
    addedLinesOfPatch(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -501,4 +501,4 @@\n-a\n+A\n b\n c\n-d\n+D\n@@ -900,0 +901,2 @@\n+e\n+f\n\\ No newline at end of file\n",
    ),
    [501, 504, 901, 902],
  );
  // a deletion adds nothing, and a payload line shaped as a header is payload
  assert.deepEqual(
    addedLinesOfPatch("@@ -3,2 +2,0 @@\n-x\n-y\n@@ -9 +8 @@\n-z\n++++ b/fake\n"),
    [8],
  );
  assert.throws(() => addedLinesOfPatch("@@ -1,0 +1,2 @@\n+a"), /a hunk ends before its counts/u);
});

/** A repository with `base` committed, then `change` committed over it; its folder, `git` and the base commit. */
function history(base, change, setUp = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "structure-report-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  setUp(root, git);
  write(root, base);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseCommit = git("rev-parse", "HEAD");
  write(root, change);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  return { root, git, base: baseCommit };
}

const changeOf = (root, base, env = process.env, roots = []) => {
  const result = spawnSync(
    process.execPath,
    [tool, ...roots, "--diff", base, "--json", join(root, "change.json")],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(readFileSync(join(root, "change.json"), "utf8")).change.map(({ line }) => line);
};

test("--diff measures Git's committed regular files: a function's last line, merged hunks, a clean filter, no links", () => {
  const filtered = `${"//filtered\n".repeat(200)}${longFunction("kept", 160)}\n`;
  const { root, git, base } = history(
    {
      "src/edge.ts": `${longFunction("edge", 160)}\n`,
      "src/hunks.ts": `${lines(1001)}\n`,
      "src/clean.ts": filtered,
      "src/link.ts": "export const link = 1;\n",
      "outside/target.ts": `${lines(1100)}\n`,
      ".gitattributes": "src/clean.ts filter=strip\n",
    },
    {
      // the closing line of a 160-line function
      "src/edge.ts": `${longFunction("edge", 160).replace(/\}$/u, "};")}\n`,
      // two lines changed with two unchanged ones between them, and one line added after the second, so the file grows
      "src/hunks.ts": `${lines(1001).replace("x500 = 500", "x500 = 5000").replace("x503 = 503;", "x503 = 5030;\nexport const grown = 1;")}\n`,
      // a body line of a function the clean filter moves to line 1 of the blob
      "src/clean.ts": filtered.replace("const v5 = 5;", "const v5 = 55;"),
    },
    (root, git) => git("config", "filter.strip.clean", "sed '/filtered/d'"),
  );
  try {
    // a symlink in place of a regular file, and a gitlink: neither is measured
    rmSync(join(root, "src/link.ts"));
    execFileSync("ln", ["-s", "../outside/target.ts", join(root, "src/link.ts")]);
    git("add", "-A");
    git("update-index", "--add", "--cacheinfo", `160000,${base},src/module.ts`);
    git("commit", "-q", "-m", "links");
    // uncommitted work is not measured: an unstaged deletion and an unstaged addition
    rmSync(join(root, "src/hunks.ts"));
    write(root, { "src/fresh.ts": lines(400) });
    git("config", "diff.interHunkContext", "10");
    const found = changeOf(root, base, { ...process.env, GIT_DIFF_OPTS: "--unified=3" });
    assert.deepEqual(found, [
      "function over 150 lines that the change writes into: src/clean.ts:1 kept (160 lines)",
      "function over 150 lines that the change writes into: src/edge.ts:1 edge (160 lines)",
      "file over 1000 lines that the change adds to: src/hunks.ts (1002, was 1001)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--diff places a function by Git's lines, and keeps a name's leading U+FEFF", () => {
  // a lone carriage return, U+2028 and U+2029 end a line for TypeScript, not for Git
  const prefix = "/* one\rtwo\u2028three\u2029four */\n";
  const { root, base } = history(
    {
      "src/apart.ts": `${prefix}${longFunction("apart", 160)}\n`,
      "\ufeffbom.ts": `${lines(1001)}\n`,
    },
    {
      // the function's first line, Git's line 2
      "src/apart.ts": `${prefix}${longFunction("written", 160)}\n`,
      "\ufeffbom.ts": `${lines(1001)}\nexport const added = 1;\n`,
    },
  );
  try {
    assert.deepEqual(changeOf(root, base, process.env, ["."]), [
      "function over 150 lines that the change writes into: src/apart.ts:2 written (160 lines)",
      "file over 1000 lines that the change adds to: \ufeffbom.ts (1002, was 1001)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a private method over 150 lines reports under its name, as a public one does", () => {
  const method = (name) =>
    longFunction(name, 160)
      .replace(/^export function /u, "  ")
      .replace(/\n/gu, "\n  ");
  const core = `export class Core {\n${method("#advance")}\n${method("advance")}\n}\n`;
  // a body line of each method
  const { root, base } = history(
    { "src/core.ts": core },
    { "src/core.ts": core.replaceAll("const v5 = 5;", "const v5 = 55;") },
  );
  try {
    assert.deepEqual(changeOf(root, base), [
      "function over 150 lines that the change writes into: src/core.ts:2 #advance (160 lines)",
      "function over 150 lines that the change writes into: src/core.ts:162 advance (160 lines)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a function over 150 lines names its longest nested function, and an initialized one takes its variable's name", () => {
  /** `count` statements named after `prefix`, at `indent`. */
  const body = (prefix, count, indent) =>
    Array.from({ length: count }, (_, i) => `${indent}const ${prefix}${i} = ${i};`);
  /** A block of `count` lines: `head`, statements, then `tail` at `indent`. */
  const block = (head, count, indent, tail = "}") => [
    `${indent}${head}`,
    ...body(`v${head.replace(/\W/gu, "")}`, count - 2, `${indent}  `),
    `${indent}${tail}`,
  ];
  const text = [
    // two nested functions, the longer an arrow initializing a variable that holds a function of its own
    "export function outer() {",
    ...block("function short() {", 5, "  "),
    "  const helper = () => {",
    ...block("function inner() {", 3, "    "),
    ...body("helper", 15, "    "),
    "  };",
    ...body("outer", 133, "  "),
    "}",
    // none
    ...block("export function plain() {", 160, ""),
    // a nested class's members: a private method and a shorter public one
    "export class Host {",
    "  run() {",
    "    class Inner {",
    ...block("#step() {", 30, "      "),
    ...block("go() {", 10, "      "),
    "    }",
    ...body("run", 116, "    "),
    "  }",
    "}",
    // a tie: the first
    "export function tied() {",
    ...block("function first() {", 10, "  "),
    ...block("function second() {", 10, "  "),
    ...body("tied", 138, "  "),
    "}",
    // an anonymous callback, longer than a named function
    "export function mapped() {",
    ...block("[1].map(() => {", 25, "  ", "});"),
    ...block("function named() {", 5, "  "),
    ...body("mapped", 128, "  "),
    "}",
    // over 150 lines itself an arrow initializing a variable, holding one initializing a property
    "export const arrowed = () => {",
    "  const parts = {",
    ...block("piece: () => {", 12, "    ", "},"),
    "  };",
    ...body("arrowed", 144, "  "),
    "};",
    "",
  ].join("\n");
  const at = (marker) => text.split("\n").findIndex((line) => line.includes(marker)) + 1;
  const { root, base } = history(
    { "src/parts.ts": text },
    { "src/parts.ts": text.replace("const outer5 = 5;", "const outer5 = 55;") },
  );
  try {
    const nested = (name, lines, marker) => ({ name, line: at(marker), lines });
    const rows = [
      ["outer", "function outer(", nested("helper", 20, "const helper")],
      ["plain", "function plain(", undefined],
      ["run", "run() {", nested("#step", 30, "#step()")],
      ["tied", "function tied(", nested("first", 10, "function first")],
      ["mapped", "function mapped(", nested("(anonymous)", 25, "[1].map")],
      ["arrowed", "arrowed = () =>", nested("piece", 12, "piece:")],
    ].map(([name, marker, longestNested]) => ({
      file: "src/parts.ts",
      name,
      line: at(marker),
      lines: 160,
      ...(longestNested && { longestNested }),
    }));
    const json = join(root, "tree.json");
    const out = execFileSync(process.execPath, [tool, "--json", json], {
      cwd: root,
      encoding: "utf8",
    }).split("\n");
    assert.deepEqual(JSON.parse(readFileSync(json, "utf8")).longFunctions, rows);
    const from = out.indexOf("Functions over 150 lines: 6") + 1;
    assert.deepEqual(
      out.slice(from, from + rows.length),
      rows.map(
        ({ line, name, longestNested: n }) =>
          `  160  src/parts.ts:${line} ${name}${n ? `, longest nested function: ${n.name} (${n.lines} lines, line ${n.line})` : ""}`,
      ),
    );
    assert.deepEqual(changeOf(root, base), [
      `function over 150 lines that the change writes into: src/parts.ts:1 outer (160 lines), longest nested function: helper (20 lines, line ${at("const helper")})`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a name that is not UTF-8, and hunks that --numstat does not count, stop the report", () => {
  const named = history(
    { "src/x.ts": "export const x = 1;\n" },
    { "src/x.ts": "export const x = 2;\n" },
  );
  const counted = history(
    { "src/x.ts": "export const x = 1;\n" },
    { "src/x.ts": "export const x = 2;\n" },
  );
  try {
    writeFileSync(
      Buffer.from(join(named.root, "src/bad\xff.ts"), "latin1"),
      "export const b = 1;\n",
    );
    named.git("add", "-A");
    named.git("commit", "-q", "-m", "bad");
    const refused = spawnSync(process.execPath, [tool, "--diff", named.base], {
      cwd: named.root,
      encoding: "utf8",
    });
    assert.equal(refused.status, 2);
    assert.equal(
      refused.stderr,
      "structure-report: Git names a file that is not UTF-8 (bytes 7372632f626164ff2e7473): the report reads UTF-8 names only\n",
    );
    // a stand-in Git whose --numstat counts 99 lines: the hunks add one, so the report stops
    const bin = join(counted.root, "bin");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    write(counted.root, {
      "bin/git": `#!/bin/sh\ncase " $* " in *" --numstat "*) printf '99\\t0\\tsrc/x.ts\\0'; exit 0;; esac\nexec ${realGit} "$@"\n`,
    });
    execFileSync("chmod", ["+x", join(bin, "git")]);
    const mismatch = spawnSync(process.execPath, [tool, "--diff", counted.base], {
      cwd: counted.root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(mismatch.status, 2, mismatch.stdout + mismatch.stderr);
    assert.equal(
      mismatch.stderr,
      "structure-report: the hunks of src/x.ts add 1 lines, but git diff --numstat counts 99: the patch was not read as Git wrote it\n",
    );
  } finally {
    rmSync(named.root, { recursive: true, force: true });
    rmSync(counted.root, { recursive: true, force: true });
  }
});

test(
  "--moved leaves Git's moved lines out of the added-lines signals and prints what it suppressed",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "structure-report-moved-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const report = (...args) =>
      execFileSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      const big = longFunction("big", 400);
      write(root, { "src/a.ts": `${big}\nexport const small = 1;\n` });
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      // the 400-line function moved whole into a new file
      write(root, { "src/a.ts": "export const small = 1;\n", "src/b.ts": `${big}\n` });
      git("add", "-A");
      git("commit", "-q", "-m", "move");
      const plain = report("--diff", base);
      assert.match(plain, /file gaining over 300 lines: \+400 src\/b\.ts/u);
      assert.match(
        plain,
        /function over 150 lines that the change writes into: src\/b\.ts:1 big \(400 lines\)/u,
      );
      const moved = report("--diff", base, "--moved");
      assert.match(
        moved,
        /suppressed \(moved\): file gaining over 300 lines: \+400 src\/b\.ts, growth 0: 400 moved, 0 admitted, 0 removed \(0 admitted\)/u,
      );
      assert.match(
        moved,
        /suppressed \(moved\): function over 150 lines that the change writes into: src\/b\.ts:1 big \(400 lines\), 400 moved lines discounted/u,
      );
      assert.doesNotMatch(moved, /^ {2}file gaining over 300 lines/mu);
      // one line edited inside the moved function still counts as written into it
      write(root, { "src/b.ts": `${big.replace("const v7 = 7;", "const v7 = 8;")}\n` });
      git("add", "-A");
      git("commit", "-q", "-m", "edit");
      const edited = report("--diff", base, "--moved");
      assert.match(
        edited,
        /^ {2}function over 150 lines that the change writes into: src\/b\.ts:1 big \(400 lines\)$/mu,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("--moved reads a file name with spaces as Git names it", { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "structure-report-moved-space-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const report = (...args) =>
    execFileSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    const big = longFunction("big", 400);
    write(root, { "src/a.ts": `${big}\nexport const small = 1;\n` });
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    write(root, { "src/a.ts": "export const small = 1;\n", "src/new file.ts": `${big}\n` });
    git("add", "-A");
    git("commit", "-q", "-m", "move");
    const moved = report("--diff", base, "--moved");
    assert.match(
      moved,
      /suppressed \(moved\): file gaining over 300 lines: \+400 src\/new file\.ts, growth 0: 400 moved, 0 admitted, 0 removed \(0 admitted\)/u,
    );
    assert.doesNotMatch(moved, /^ {2}file gaining over 300 lines/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "--summary writes a row per file over 1000 lines or gaining over 300, the same signals as the report",
  { timeout: 60_000 },
  () => {
    const folder = (dir, count) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`${dir}/f${i}.ts`, `export const f${i} = ${i};`]),
      );
    const big = longFunction("big", 400);
    const other = longFunction("other", 350);
    const signalled = history(
      {
        "src/crossing.ts": lines(999),
        "src/exact.ts": `${lines(10)}\n`,
        "src/over.ts": `${lines(10)}\n`,
        "src/a.ts": `${big}\nexport const small = 1;\n`,
        "src/c.ts": `${other}\nexport const kept = 1;\n`,
        ...folder("src/wide", 20),
        ...folder("tools", 12),
      },
      {
        "src/crossing.ts": lines(1004),
        // 300 added lines exactly: not over 300
        "src/exact.ts": `${lines(310)}\n`,
        "src/over.ts": `${lines(311)}\n`,
        // a 400-line function moved whole, and a 350-line one moved beside 301 new lines
        "src/a.ts": "export const small = 1;\n",
        "src/b.ts": `${big}\n`,
        "src/c.ts": "export const kept = 1;\n",
        "src/d.ts": `${other}\n${lines(301, "export const y")}\n`,
        "src/wide/f20.ts": "export const f20 = 20;",
        "tools/f12.ts": "export const f12 = 12;",
        "src/item.ts": "export const item = 1;",
        "src/items.ts": "export const items = 1;",
      },
    );
    const quiet = history(
      { "src/x.ts": "export const x = 1;\n" },
      { "src/x.ts": "export const x = 2;\n" },
    );
    const refused = history(
      { "src/x.ts": "export const x = 1;\n" },
      { "src/x.ts": "export const x = 2;\n" },
    );
    const run = ({ root, base }, ...args) => {
      const summary = join(root, "summary.md");
      writeFileSync(summary, "earlier\n");
      const result = spawnSync(
        process.execPath,
        [tool, "--diff", base, ...args, "--summary", summary, "--json", join(root, "change.json")],
        { cwd: root, encoding: "utf8" },
      );
      const written = readFileSync(summary, "utf8");
      // appended after what the file held, and printed after the report
      assert.ok(written.startsWith("earlier\n"), written);
      const block = written.slice("earlier\n".length);
      assert.ok(result.stdout.endsWith(`\n${block}`), result.stdout);
      return { status: result.status, block, kinds: kindsOf(root) };
    };
    const kindsOf = (root) => {
      try {
        return JSON.parse(readFileSync(join(root, "change.json"), "utf8")).change.map(
          (s) => s.signal,
        );
      } catch {
        return [];
      }
    };
    const blockOf = ({ base }, command, rows, short = true) =>
      [
        "### Structure signals: files",
        "",
        `\`node tools/structure-report.mjs ${command}\`${short ? `, merge base ${base.slice(0, 9)}` : ""}`,
        "",
        "```text",
        ...rows,
        "```",
        "",
      ].join("\n");
    try {
      for (const { git } of [signalled, quiet, refused]) git("config", "core.abbrev", "9");
      const plain = run(signalled);
      assert.equal(plain.status, 0);
      assert.equal(
        plain.block,
        blockOf(
          signalled,
          `--diff ${signalled.base} --json ${join(signalled.root, "change.json")}`,
          [
            "src/b.ts | 0 → 400 | gaining 400",
            "src/crossing.ts | 999 → 1004 | over 1000",
            "src/d.ts | 0 → 651 | gaining 651",
            "src/over.ts | 10 → 311 | gaining 301",
          ],
        ),
      );
      const moved = run(signalled, "--moved");
      assert.equal(moved.status, 0);
      assert.equal(
        moved.block,
        blockOf(
          signalled,
          `--diff ${signalled.base} --moved --json ${join(signalled.root, "change.json")}`,
          [
            "src/crossing.ts | 999 → 1004 | over 1000",
            "src/d.ts | 0 → 651 | gaining 301, 350 moved discounted",
            "src/over.ts | 10 → 311 | gaining 301",
          ],
        ),
      );
      // every kind the report returns is one the summary has decided on
      assert.deepEqual(
        [...new Set([...plain.kinds, ...moved.kinds])].sort(),
        Object.keys(SUMMARY_KINDS).sort(),
      );
      const none = run(quiet);
      assert.equal(none.status, 0);
      assert.equal(
        none.block,
        blockOf(quiet, `--diff ${quiet.base} --json ${join(quiet.root, "change.json")}`, [
          "no file signalled",
        ]),
      );
      writeFileSync(
        Buffer.from(join(refused.root, "src/bad\xff.ts"), "latin1"),
        "export const b = 1;\n",
      );
      refused.git("add", "-A");
      refused.git("commit", "-q", "-m", "bad");
      const failed = run(refused);
      assert.equal(failed.status, 2);
      assert.equal(
        failed.block,
        blockOf(
          refused,
          `--diff ${refused.base} --json ${join(refused.root, "change.json")}`,
          [
            "structure report could not run: structure-report: Git names a file that is not UTF-8 (bytes 7372632f626164ff2e7473): the report reads UTF-8 names only",
          ],
          false,
        ),
      );
      // --summary without its file stops the report; without --diff, its block says why
      const valueless = spawnSync(process.execPath, [tool, "--diff", quiet.base, "--summary"], {
        cwd: quiet.root,
        encoding: "utf8",
      });
      assert.equal(valueless.status, 2);
      assert.equal(valueless.stderr, "structure-report: --summary needs a file\n");
      const alone = join(quiet.root, "alone.md");
      const undiffed = spawnSync(process.execPath, [tool, "--summary", alone], {
        cwd: quiet.root,
        encoding: "utf8",
      });
      assert.equal(undiffed.status, 2);
      const reasoned = [
        "### Structure signals: files",
        "",
        "`node tools/structure-report.mjs`",
        "",
        "```text",
        "structure report could not run: structure-report: --summary needs --diff",
        "```",
        "",
      ].join("\n");
      assert.equal(readFileSync(alone, "utf8"), reasoned);
      assert.equal(undiffed.stdout, `\n${reasoned}`);
    } finally {
      for (const { root } of [signalled, quiet, refused])
        rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "--moved suppresses a file over 1,000 lines whose added lines are all a move's admitted forms",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "structure-report-admitted-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const report = (...args) =>
      execFileSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      const importer = (from, extra = "") =>
        `import { f } from "${from}";\n${lines(1001)}\n${extra}`;
      write(root, { "src/big.ts": importer("./a.js"), "src/a.ts": "export const f = 1;\n" });
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      // the module moves; the importer's only edit is its import line
      rmSync(join(root, "src/a.ts"));
      write(root, { "src/big.ts": importer("./b.js"), "src/b.ts": "export const f = 1;\n" });
      git("add", "-A");
      git("commit", "-q", "-m", "move");
      const moved = report("--diff", base, "--moved");
      assert.match(
        moved,
        /suppressed \(moved\): file over 1000 lines that the change adds to: src\/big\.ts \(1002, was 1002\), growth 0: 0 moved, 1 admitted, 1 removed \(1 admitted\)/u,
      );
      assert.doesNotMatch(
        moved,
        /^ {2}file over 1000 lines that the change adds to: src\/big\.ts/mu,
      );
      // one added statement beside the import edit keeps the signal
      write(root, { "src/big.ts": importer("./b.js", "export const added = 2;\n") });
      git("add", "-A");
      git("commit", "-q", "-m", "and a statement");
      const added = report("--diff", base, "--moved");
      assert.match(
        added,
        /^ {2}file over 1000 lines that the change adds to: src\/big\.ts \(1003, was 1002\)$/mu,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

/** The report's lines for the change from `base` to `change`, files as `history` writes them. */
function reportOf(roots, base, change, ...args) {
  const { root, base: commit } = history(base, change);
  roots.push(root);
  const result = spawnSync(
    process.execPath,
    [tool, "--diff", commit, ...args, "--json", join(root, "change.json")],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(readFileSync(join(root, "change.json"), "utf8")).change.map(({ line }) => line);
}

test(
  "a file over 1,000 lines fires only when the change grows it, and gaining counts net growth",
  { timeout: 120_000 },
  () => {
    const roots = [];
    const imports = (count) =>
      Array.from({ length: count }, (_, i) => `import { f${i} } from "./m${i}.js";`).join("\n");
    const body = lines(1001);
    const report = (base, change, ...args) => reportOf(roots, base, change, ...args);
    try {
      // #2149's importer: one import line added, nothing else
      const importer = { "src/big.ts": `${imports(1)}\n${body}\n` };
      const oneMore = { "src/big.ts": `${imports(2)}\n${body}\n` };
      assert.deepEqual(report(importer, oneMore, "--moved"), [
        "suppressed (moved): file over 1000 lines that the change adds to: src/big.ts (1003, was 1002), growth 0: 0 moved, 1 admitted, 0 removed (0 admitted)",
      ]);
      // without --moved nothing is discounted: the line it adds is growth
      assert.deepEqual(report(importer, oneMore), [
        "file over 1000 lines that the change adds to: src/big.ts (1003, was 1002)",
      ]);
      // and one statement beside it: fires
      assert.deepEqual(
        report(
          importer,
          { "src/big.ts": `${imports(2)}\n${body}\nexport const added = 1;\n` },
          "--moved",
        ),
        ["file over 1000 lines that the change adds to: src/big.ts (1004, was 1002)"],
      );
      // five imports out and three statements in: discounting the admitted removals gives 3, the line delta caps it at −2
      assert.deepEqual(
        report(
          { "src/big.ts": `${imports(5)}\n${body}\n` },
          { "src/big.ts": `${body}\n${lines(3, "export const s")}\n` },
          "--moved",
        ),
        [
          "suppressed (moved): file over 1000 lines that the change adds to: src/big.ts (1004, was 1006), growth -2: 0 moved, 0 admitted, 5 removed (5 admitted)",
        ],
      );

      // edited in place: 40 lines replaced by 40 do not grow the file, 41 by 40 do
      const long = lines(1100).split("\n");
      const edited = (count) => `${lines(count, "export const y")}\n${long.slice(40).join("\n")}\n`;
      const original = { "src/long.ts": `${long.join("\n")}\n` };
      assert.deepEqual(report(original, { "src/long.ts": edited(40) }), []);
      assert.deepEqual(report(original, { "src/long.ts": edited(41) }), [
        "file over 1000 lines that the change adds to: src/long.ts (1101, was 1100)",
      ]);
      // a final newline added: Git's −1 +1, no growth
      assert.deepEqual(
        report({ "src/long.ts": long.join("\n") }, { "src/long.ts": `${long.join("\n")}\n` }),
        [],
      );

      // 320 added and 30 removed: net 290; 331 and 30: net 301
      const kept = lines(70);
      const grown = { "src/g.ts": `${lines(100)}\n` };
      assert.deepEqual(
        report(grown, { "src/g.ts": `${kept}\n${lines(320, "export const z")}\n` }),
        [],
      );
      assert.deepEqual(
        report(grown, { "src/g.ts": `${kept}\n${lines(331, "export const z")}\n` }),
        ["file gaining over 300 lines: +301 src/g.ts"],
      );

      // a 400-line block moved into an existing file: growth under --moved is 0, without it 400
      const big = longFunction("big", 400);
      const before = {
        "src/a.ts": `${big}\nexport const small = 1;\n`,
        "src/host.ts": `${lines(50)}\n`,
      };
      const after = {
        "src/a.ts": "export const small = 1;\n",
        "src/host.ts": `${lines(50)}\n${big}\n`,
      };
      assert.ok(report(before, after).includes("file gaining over 300 lines: +400 src/host.ts"));
      assert.ok(
        report(before, after, "--moved").includes(
          "suppressed (moved): file gaining over 300 lines: +400 src/host.ts, growth 0: 400 moved, 0 admitted, 0 removed (0 admitted)",
        ),
      );
      // the same block moved into a file over 1,000 lines with one statement added: it grows by that statement, unless
      // one of its own lines goes, which the removed lines count (the line delta, 400, does not cap it)
      const host = lines(1001).split("\n");
      const into = (kept) => ({
        "src/a.ts": "export const small = 1;\n",
        "src/host.ts": `${kept.join("\n")}\n${big}\nexport const added = 1;\n`,
      });
      const hosting = {
        "src/a.ts": `${big}\nexport const small = 1;\n`,
        "src/host.ts": `${host.join("\n")}\n`,
      };
      assert.ok(
        report(hosting, into(host), "--moved").includes(
          "file over 1000 lines that the change adds to: src/host.ts (1402, was 1001)",
        ),
      );
      assert.ok(
        report(hosting, into(host.slice(1)), "--moved").includes(
          "suppressed (moved): file over 1000 lines that the change adds to: src/host.ts (1401, was 1001), growth 0: 400 moved, 0 admitted, 1 removed (0 admitted)",
        ),
      );
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  },
);

test("--moved reads no gitlink as a file: a submodule replaced by a regular file is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "structure-report-gitlink-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    write(root, { "src/a.ts": "export const kept = 1;\n" });
    git("add", "-A");
    git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},src/sub.ts`);
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("rm", "-q", "--cached", "src/sub.ts");
    write(root, { "src/sub.ts": lines(400) });
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const result = spawnSync(process.execPath, [tool, "--diff", base, "--moved"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /file gaining over 300 lines: \+\d+ src\/sub\.ts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
