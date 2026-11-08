import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { addedLinesOfPatch } from "./structure-report.mjs";

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
      // two lines changed with two unchanged ones between them
      "src/hunks.ts": `${lines(1001).replace("x500 = 500", "x500 = 5000").replace("x503 = 503", "x503 = 5030")}\n`,
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
      "file over 1000 lines that the change adds to: src/hunks.ts (1001, was 1001)",
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

test("a name that is not UTF-8 stops the report; a file whose hunks --numstat does not count is reported, and the report goes on", () => {
  const named = history(
    { "src/x.ts": "export const x = 1;\n" },
    { "src/x.ts": "export const x = 2;\n" },
  );
  const counted = history(
    { "src/x.ts": "export const x = 1;\n", "src/big.ts": "export const big = 0;\n" },
    { "src/x.ts": "export const x = 2;\n", "src/big.ts": `export const big = 0;\n${lines(301)}\n` },
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
    // a stand-in Git whose --numstat counts 99 lines for src/x.ts, whose hunks add one: that file is reported as not
    // measured, and src/big.ts, which Git counts as its hunks do, is still measured
    const bin = join(counted.root, "bin");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    write(counted.root, {
      "bin/git": `#!/bin/sh\ncase " $* " in *" --numstat "*) printf '301\\t0\\tsrc/big.ts\\000'; printf '99\\t0\\tsrc/x.ts\\000'; exit 0;; esac\nexec ${realGit} "$@"\n`,
    });
    execFileSync("chmod", ["+x", join(bin, "git")]);
    assert.deepEqual(
      changeOf(counted.root, counted.base, { ...process.env, PATH: `${bin}:${process.env.PATH}` }),
      [
        "file gaining over 300 lines: +301 src/big.ts",
        "file whose change the report could not read as Git wrote it, not measured: src/x.ts (its hunks add 1 lines, git diff --numstat counts 99)",
      ],
    );
  } finally {
    rmSync(named.root, { recursive: true, force: true });
    rmSync(counted.root, { recursive: true, force: true });
  }
});

const USAGE =
  "usage: node tools/structure-report.mjs [ROOT…] [--top N] [--json FILE] [--compare FILE]\n" +
  "       node tools/structure-report.mjs [ROOT…] --diff BASE [--json FILE]\n";
/** Command lines the report refuses, with its reason: each option that takes a value, missing or repeated. */
const REFUSED = [
  [["--top"], "--top takes a value"],
  [["--json"], "--json takes a value"],
  [["--compare"], "--compare takes a value"],
  [["--diff"], "--diff takes a value"],
  [["src", "--json"], "--json takes a value"],
  // the next argument is another option, still on the command line when it is read
  [["--json", "--compare", "earlier.json"], "--json takes a value"],
  [["--top", "--json", "out.json"], "--top takes a value"],
  [["--compare", "--diff", "HEAD"], "--compare takes a value"],
  [["--diff", "--top", "3"], "--diff takes a value"],
  // a second occurrence, without its value or with one
  [["--top", "2", "--top"], "--top takes a value"],
  [["--json", "first.json", "--json"], "--json takes a value"],
  [["--json", "first.json", "--json", "second.json"], "--json is given twice"],
  [["--compare", "a.json", "--compare", "b.json"], "--compare is given twice"],
  [["--diff", "HEAD", "--diff", "HEAD"], "--diff is given twice"],
  [["--top", "2", "--top", "3"], "--top is given twice"],
  [["--json=first.json", "--json", "second.json"], "--json is given twice"],
  // --top's value is a whole number (#2090)
  [["--top", "abc"], "--top takes a whole number, not abc"],
  [["--top", "1.5"], "--top takes a whole number, not 1.5"],
  [["--top=abc"], "--top takes a whole number, not abc"],
  [["--top", "-1"], "--top takes a value"],
  // after `=`, the value is what follows it, and there must be one (#2090)
  [["--json="], "--json takes a value"],
  [["--diff="], "--diff takes a value"],
  // an argument that starts with `-` and is no option is refused by name, not read as a root (#2090)
  [["--jsn", "out.json"], "unknown option --jsn"],
  [["src", "--jsn=out.json"], "unknown option --jsn"],
  [["-j", "out.json"], "unknown option -j"],
  [["--"], "unknown option --"],
];

test("an option without its value, or given twice, stops the report with the usage, and writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "structure-report-"));
  try {
    for (const [args, refusal] of REFUSED) {
      const result = spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 2, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
      assert.equal(result.stderr, `structure-report: ${refusal}\n${USAGE}`, args.join(" "));
      assert.deepEqual(readdirSync(root), [], `${args.join(" ")}: nothing is written`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("in a repository, a refused command line stops with the usage and writes nothing", () => {
  const { root, git, base } = history(
    { "src/sample.ts": "export const x = 1;\n" },
    { "src/sample.ts": "export const x = 2;\n" },
  );
  try {
    for (const [args, refusal] of [
      // the argument after --json is an option, whose own value follows: neither becomes the destination
      [["--json", "--top", "3", "src/sample.ts"], "--json takes a value"],
      [["--json", "--compare", "earlier.json"], "--json takes a value"],
      [["--diff", "--json", "out.json", base], "--diff takes a value"],
      [["--json", "first.json", "--json", "second.json", "--diff", base], "--json is given twice"],
      [["--diff", base, "--diff"], "--diff takes a value"],
    ]) {
      const result = spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 2, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
      assert.equal(result.stderr, `structure-report: ${refusal}\n${USAGE}`, args.join(" "));
      assert.equal(
        git("status", "--porcelain", "--untracked-files=all"),
        "",
        `${args.join(" ")}: nothing is written`,
      );
    }
    assert.equal(readFileSync(join(root, "src/sample.ts"), "utf8"), "export const x = 2;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an option's value after `=` reads as the next argument does, and a root that starts with `-` is written ./-name", () => {
  const { root, base } = history(
    { "src/x.ts": "export const x = 1;\n", "-odd/y.ts": "export const y = 1;\n" },
    {
      "src/x.ts": `export const x = 1;\n${lines(301)}\n`,
      "-odd/y.ts": `export const y = 1;\n${lines(301)}\n`,
    },
  );
  try {
    const report = (...args) => {
      const result = spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, args.join(" ") + result.stdout + result.stderr);
      return result.stdout;
    };
    assert.equal(
      report("src", "--top=1", "--json=one.json"),
      report("src", "--top", "1", "--json", "two.json"),
    );
    assert.equal(
      readFileSync(join(root, "one.json"), "utf8"),
      readFileSync(join(root, "two.json"), "utf8"),
    );
    assert.equal(report(`--diff=${base}`), report("--diff", base));
    assert.match(
      report("./-odd", "--diff", base),
      /file gaining over 300 lines: \+301 -odd\/y\.ts/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * #2091's edge, in neutral text: a line of `[indent, id, length]` is `line<id> ` padded with `x` and cut to `length`.
 * The new side's lone `}` lines can match the old side's at one context and not at another, because Git trims the
 * common tail (27 lines, over 1 KB) to the context before it diffs.
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
