// The structure report as it is asked and as it writes: its command line and options, `--moved`, `--summary`, and the
// `node_modules` it links. What the report finds in a change is `structure-report.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { SUMMARY_KINDS } from "./structure-report.mjs";
import { history, lines, longFunction, tool, write } from "./structure-report-fixtures.mjs";

const USAGE =
  "usage: node tools/structure-report.mjs [ROOT…] [--top N] [--json FILE] [--compare FILE]\n" +
  "       node tools/structure-report.mjs [ROOT…] --diff BASE [--moved] [--json FILE] [--summary FILE]\n";
/** Command lines the report refuses, with its reason: each option that takes a value, missing or repeated. */
const REFUSED = [
  [["--top"], "--top takes a value"],
  [["--json"], "--json takes a value"],
  [["--compare"], "--compare takes a value"],
  [["--diff"], "--diff takes a value"],
  [["--summary"], "--summary takes a value"],
  [["--summary="], "--summary takes a value"],
  [["src", "--json"], "--json takes a value"],
  // the next argument is another option, still on the command line when it is read
  [["--json", "--compare", "earlier.json"], "--json takes a value"],
  [["--top", "--json", "out.json"], "--top takes a value"],
  [["--compare", "--diff", "HEAD"], "--compare takes a value"],
  [["--diff", "--top", "3"], "--diff takes a value"],
  [["--diff", "--moved"], "--diff takes a value"],
  // a second occurrence, without its value or with one
  [["--top", "2", "--top"], "--top takes a value"],
  [["--json", "first.json", "--json"], "--json takes a value"],
  [["--json", "first.json", "--json", "second.json"], "--json is given twice"],
  [["--compare", "a.json", "--compare", "b.json"], "--compare is given twice"],
  [["--diff", "HEAD", "--diff", "HEAD"], "--diff is given twice"],
  [["--summary", "a.md", "--summary", "b.md"], "--summary is given twice"],
  [["--moved", "--moved"], "--moved is given twice"],
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
      // holding a 3-line function at lines 3-5
      const big = longFunction("big", 400).replace(
        "  const v1 = 1;\n  const v2 = 2;\n  const v3 = 3;",
        "  function nested() {\n    return 1;\n  }",
      );
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
        /^ {2}suppressed \(moved\): function over 150 lines that the change writes into: src\/b\.ts:1 big \(400 lines\), 400 moved lines discounted, longest nested function: nested \(3 lines, line 3\)$/mu,
      );
      assert.doesNotMatch(moved, /^ {2}file gaining over 300 lines/mu);
      // one line edited inside the moved function still counts as written into it
      write(root, { "src/b.ts": `${big.replace("const v7 = 7;", "const v7 = 8;")}\n` });
      git("add", "-A");
      git("commit", "-q", "-m", "edit");
      const edited = report("--diff", base, "--moved");
      assert.match(
        edited,
        /^ {2}function over 150 lines that the change writes into: src\/b\.ts:1 big \(400 lines\), longest nested function: nested \(3 lines, line 3\)$/mu,
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
        // (`unread`: the --numstat stand-in's test runs it with --summary)
        [...new Set([...plain.kinds, ...moved.kinds, "unread"])].sort(),
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
      // --summary without its file stops the report
      const valueless = spawnSync(process.execPath, [tool, "--diff", quiet.base, "--summary"], {
        cwd: quiet.root,
        encoding: "utf8",
      });
      assert.equal(valueless.status, 2);
      assert.match(valueless.stderr, /^structure-report: --summary takes a value\nusage: /u);
      // a throw, here Git refusing a base it cannot name, writes its block (the error's first line, then Git's own),
      // and the report still fails with it
      const thrown = run({ root: quiet.root, base: "no-such-ref" });
      assert.equal(thrown.status, 1);
      const thrownBlock = blockOf(
        quiet,
        `--diff no-such-ref --json ${join(quiet.root, "change.json")}`,
        ["structure report failed: Command failed: git merge-base no-such-ref HEAD"],
        false,
      );
      assert.ok(thrown.block.startsWith(thrownBlock.slice(0, -"```\n".length)), thrown.block);
      assert.match(thrown.block, /\nfatal: [^\n]*no-such-ref\n```\n$/u);
      // a summary it cannot write (a folder) leaves the throw itself as the run's error
      const unwritable = spawnSync(
        process.execPath,
        [tool, "--diff", "no-such-ref", "--summary", quiet.root],
        { cwd: quiet.root, encoding: "utf8" },
      );
      assert.equal(unwritable.status, 1);
      assert.match(unwritable.stderr, /summary could not be written: EISDIR/u);
      assert.match(
        unwritable.stderr,
        /\nError: Command failed: git merge-base no-such-ref HEAD\n/u,
      );
      // --summary without --diff: its block says why
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

test("--moved reads no gitlink as a file: a submodule replaced by a regular file is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "structure-report-gitlink-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
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

test("without node_modules it links main's before it reports, and stops when there is none to link or it does not hold the lockfile", () => {
  const checkout = mkdtempSync(join(tmpdir(), "structure-report-modules-"));
  const run = (env, ...args) =>
    spawnSync(process.execPath, [join(checkout, "tools/structure-report.mjs"), ...args], {
      cwd: join(checkout, "work"),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  try {
    // a checkout of the tools, its lockfile, and no node_modules
    const repository = dirname(dirname(tool));
    cpSync(dirname(tool), join(checkout, "tools"), { recursive: true });
    cpSync(join(repository, "package-lock.json"), join(checkout, "package-lock.json"));
    const git = (...args) =>
      execFileSync("git", args, { cwd: join(checkout, "work"), encoding: "utf8" }).trim();
    mkdirSync(join(checkout, "work"));
    git("init", "-q");
    write(join(checkout, "work"), { "src/a.ts": "export const a = 1;\n" });
    git("add", "-A");
    git("commit", "-q", "-m", "base");

    // main's install, through the checkout TEASESCRIPT_MAIN names
    const linked = run({ TEASESCRIPT_MAIN: repository });
    assert.equal(linked.status, 0, linked.stderr);
    assert.equal(
      linked.stderr,
      `structure-report: linked node_modules from ${repository}/node_modules\n`,
    );
    assert.match(linked.stdout, /^1 code files under /u);
    assert.ok(lstatSync(join(checkout, "node_modules")).isSymbolicLink());

    // no node_modules to link: exit 2, also in the summary
    rmSync(join(checkout, "node_modules"));
    const empty = join(checkout, "empty");
    mkdirSync(empty);
    const summary = join(checkout, "summary.md");
    const none = run({ TEASESCRIPT_MAIN: empty }, "--diff", "HEAD", "--summary", summary);
    assert.equal(none.status, 2, none.stderr);
    assert.match(
      none.stderr,
      /^structure-report: no node_modules, and \S+ has no node_modules folder/u,
    );
    assert.match(
      readFileSync(summary, "utf8"),
      /structure report could not run: structure-report: no node_modules, and /u,
    );

    // an install whose record does not hold the checkout's lockfile
    writeFileSync(
      join(checkout, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/no-such-package": { version: "1.0.0" } },
      }),
    );
    const held = run({ TEASESCRIPT_MAIN: repository });
    assert.equal(held.status, 2, held.stderr);
    assert.match(
      held.stderr,
      /does not hold package-lock\.json: node_modules\/no-such-package 1\.0\.0 \(not installed\)/u,
    );
    assert.doesNotMatch(held.stdout, /code files under/u);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test(
  "--moved leaves out an `export` a moved function's first line gained, and still counts a real edit of that line (#2583)",
  { timeout: 60_000 },
  () => {
    const body = longFunction("big", 400).replace("export function big() {", "");
    const first = "function big(value: number) {";
    for (const [what, line, expected] of [
      [
        "export added",
        `export ${first}`,
        /^ {2}suppressed \(moved\): function over 150 lines that the change writes into: src\/b\.ts:1 big \(400 lines\), 399 moved lines discounted, 1 admitted$/mu,
      ],
      [
        "export added and the parameter renamed",
        "export function big(other: number) {",
        /^ {2}function over 150 lines that the change writes into: src\/b\.ts:1 big \(400 lines\)$/mu,
      ],
      // (a line only the whitespace form admits is a write: a blank line can be a template literal's content)
      [
        "export added and a blank line added",
        `export ${first}\n`,
        /^ {2}function over 150 lines that the change writes into: src\/b\.ts:1 big \(401 lines\)$/mu,
      ],
    ]) {
      const { root, base } = history(
        { "src/a.ts": `${first}${body}\nexport const small = big(1);\n` },
        {
          "src/a.ts": 'import { big } from "./b.js";\n\nexport const small = big(1);\n',
          "src/b.ts": `${line}${body}\n`,
        },
      );
      try {
        const moved = execFileSync(process.execPath, [tool, "--diff", base, "--moved"], {
          cwd: root,
          encoding: "utf8",
        });
        assert.match(moved, expected, `${what}:\n${moved}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
