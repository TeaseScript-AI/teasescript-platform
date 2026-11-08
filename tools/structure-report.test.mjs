import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
