import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
      });
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
          ...NAMES.map(
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
