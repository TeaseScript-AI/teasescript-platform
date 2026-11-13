import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { addedLinesOfPatch } from "./structure-report.mjs";
import { history, lines, longFunction, tool, write } from "./structure-report-fixtures.mjs";

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

test("a patch cut inside a hunk, even after a newline, is not read as complete", () => {
  // the last deletion's line is gone, the newline before it kept: the empty string after it is the end, not a line
  const cut = "@@ -1 +1 @@\n-old\n+new\n@@ -3,2 +2,0 @@ keep\n-remove1\n";
  assert.throws(() => addedLinesOfPatch(cut), /a hunk ends before its counts/u);
  assert.deepEqual(addedLinesOfPatch(`${cut.slice(0, -1)}\n-remove2\n`), [1]);
});

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

test("a name that is not UTF-8 stops the report; a file whose hunks --numstat does not count is reported, and the report goes on", () => {
  const named = history(
    { "src/x.ts": "export const x = 1;\n" },
    { "src/x.ts": "export const x = 2;\n" },
  );
  const counted = history(
    { "src/a.ts": "export const x = 1;\n", "src/big.ts": "export const big = 0;\n" },
    { "src/a.ts": "export const x = 2;\n", "src/big.ts": `export const big = 0;\n${lines(301)}\n` },
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
    // a stand-in Git whose --numstat counts 99 lines for src/a.ts, whose hunks add one: that file, read first, is
    // reported as not measured, and src/big.ts after it, which Git counts as its hunks do, is still measured
    const bin = join(counted.root, "bin");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    write(counted.root, {
      "bin/git": `#!/bin/sh\ncase " $* " in *" --numstat "*) printf '99\\t0\\tsrc/a.ts\\000'; printf '301\\t0\\tsrc/big.ts\\000'; exit 0;; esac\nexec ${realGit} "$@"\n`,
    });
    execFileSync("chmod", ["+x", join(bin, "git")]);
    assert.deepEqual(
      changeOf(counted.root, counted.base, { ...process.env, PATH: `${bin}:${process.env.PATH}` }),
      [
        "file whose change the report could not read as Git wrote it, not measured: src/a.ts (its hunks add 1 lines, git diff --numstat counts 99)",
        "file gaining over 300 lines: +301 src/big.ts",
      ],
    );
    // with --summary too: the file not measured is in the report only, and the summary still lists the one measured
    const summary = join(counted.root, "summary.md");
    const summarized = spawnSync(
      process.execPath,
      [tool, "--diff", counted.base, "--summary", summary],
      {
        cwd: counted.root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(summarized.status, 0, summarized.stderr);
    const block = readFileSync(summary, "utf8");
    assert.match(block, /^src\/big\.ts \| 1 → \d+ \| gaining 301$/mu);
    assert.doesNotMatch(block, /src\/a\.ts/u);
  } finally {
    rmSync(named.root, { recursive: true, force: true });
    rmSync(counted.root, { recursive: true, force: true });
  }
});

/**
 * #2091's edge, in neutral text: a line of `[indent, id, length]` is `line<id> ` padded with `x` and cut to `length`.
 * The new side's lone `}` lines can match the old side's at zero context and not at another, because Git enables a
 * common-tail optimization at zero context only, and this common tail (27 lines) is over 1 KB.
 */
const fixtureLine = (spec) =>
  typeof spec === "string"
    ? spec
    : " ".repeat(spec[0]) + `line${spec[1]} `.padEnd(spec[2], "x").slice(0, spec[2]);
const EDGE_TAIL = [
  [8, 5, 73],
  [8, 6, 8],
  [8, 7, 5],
  "      });",
  "    }",
  [4, 8, 12],
  "  }",
  "",
  [2, 9, 109],
  [2, 10, 61],
  [4, 11, 32],
  [4, 12, 24],
  [4, 13, 55],
  [4, 14, 37],
  [4, 15, 65],
  [4, 16, 69],
  [6, 17, 26],
  [6, 18, 52],
  [6, 19, 33],
  [6, 20, 33],
  [6, 21, 49],
  [6, 22, 58],
  [4, 23, 2],
  [4, 24, 33],
  [4, 25, 50],
  "  }",
  "}",
];
const EDGE_OLD = [
  [6, 0, 74],
  [6, 1, 32],
  "    }",
  [4, 2, 61],
  [6, 3, 50],
  [4, 4, 59],
  "  }",
  "",
  ...EDGE_TAIL,
];
const EDGE_NEW = ["    }", "    }", "    }", "    }", ...EDGE_TAIL];
const edgeText = (specs) => `${specs.map(fixtureLine).join("\n")}\n`;

test("--diff counts a line Git places differently at another context as its own patch does (#2091)", () => {
  const { root, git, base } = history(
    { "src/edge.ts": edgeText(EDGE_OLD) },
    { "src/edge.ts": edgeText(EDGE_NEW) },
  );
  try {
    // the fixture holds the edge: Git's default context counts one line fewer than -U0 does
    const counts = (...context) =>
      git("diff", "--numstat", ...context, base, "HEAD")
        .split("\t")
        .slice(0, 2);
    assert.deepEqual(counts(), ["3", "7"]);
    assert.deepEqual(counts("-U0", "--inter-hunk-context=0"), ["4", "8"]);
    assert.deepEqual(changeOf(root, base), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      // a blank line outside every token is admitted; one inside a template literal is its content, so growth (#2619)
      const page = (inner) => `${body}\nexport const page = \`first line\n${inner}last line\n\`;\n`;
      assert.deepEqual(
        report({ "src/big.ts": page("") }, { "src/big.ts": `\n${page("")}` }, "--moved"),
        [
          "suppressed (moved): file over 1000 lines that the change adds to: src/big.ts (1005, was 1004), growth 0: 0 moved, 1 admitted, 0 removed (0 admitted)",
        ],
      );
      assert.deepEqual(
        report({ "src/big.ts": page("") }, { "src/big.ts": page("\n") }, "--moved"),
        ["file over 1000 lines that the change adds to: src/big.ts (1005, was 1004)"],
      );
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
