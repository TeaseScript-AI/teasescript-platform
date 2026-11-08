import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { frozen, moved, positions } from "./pin-grounds.fixture.mjs";
import { GROUNDS, refusalsOf } from "./pin-grounds.mjs";

// The full mutation of `pin-grounds.mjs`'s readers, apart from `test:verification` for its time: a change to the
// readers runs it (`node --test tools/repository-checks/pin-grounds.full.test.mjs`) and quotes its result.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("each expected value Codex r3 found, moved by one, is refused without its ground and passes with one", () => {
  const all = positions();
  assert.equal(all.length, 358);
  for (const position of all) {
    const [file, line, column] = position;
    const at = position.join(":");
    const head = moved(frozen(file), position);
    const [refusal, ...more] = refusalsOf(file, frozen(file), head, [line]);
    assert.deepEqual(more, [], at);
    assert.match(refusal ?? "", new RegExp(`^${file}:\\d+: .*new or re-pinned`, "u"), at);
    // (the ground written directly above, once a line)
    if (
      all.some(
        ([other, otherLine, otherColumn]) =>
          other === file && otherLine === line && otherColumn < column,
      )
    )
      continue;
    const lines = head.split("\n");
    const indent = lines[line - 1].slice(
      0,
      lines[line - 1].length - lines[line - 1].trimStart().length,
    );
    lines.splice(line - 1, 0, `${indent}// (1 unit more since #1)`);
    assert.deepEqual(refusalsOf(file, frozen(file), lines.join("\n"), [line, line + 1]), [], at);
  }
});

test(
  "a grounded re-pin of a live suite passes the check, and leaves pin-grounds.test.mjs green",
  { timeout: 120_000 },
  () => {
    const capture = "tests/type-core-contract-capture.test.ts";
    const pin = "  assert.equal(budget.total, 22_962_573);";
    const live = readFileSync(join(ROOT, capture), "utf8");
    assert.ok(live.includes(pin), "the live pin as this row expects it");
    const repinned = live.replace(
      pin,
      "  // (1 unit more since #1)\n  assert.equal(budget.total, 22_962_574);",
    );
    const line = repinned.split("\n").findIndex((text) => text.includes("22_962_574")) + 1;
    assert.deepEqual(refusalsOf(capture, live, repinned, [line - 1, line]), []);
    // (a copy of the tools and the live suites, the capture re-pinned there, its tool test run)
    const directory = mkdtempSync(join(tmpdir(), "pin-grounds-full-"));
    try {
      cpSync(join(ROOT, "tools/repository-checks"), join(directory, "tools/repository-checks"), {
        recursive: true,
      });
      // (the live suite files the tool test reads: those the check reads)
      for (const file of Object.keys(GROUNDS).filter((each) => !GROUNDS[each].listed))
        cpSync(join(ROOT, file), join(directory, file));
      symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"));
      writeFileSync(join(directory, capture), repinned);
      const run = spawnSync(
        process.execPath,
        ["--test", "tools/repository-checks/pin-grounds.test.mjs"],
        // (without the test runner's own context, which would make the inner run report to this one)
        { cwd: directory, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
      );
      assert.equal(run.status, 0, run.stdout.slice(-2000));
      assert.match(run.stdout, /^ℹ pass 9$/mu, run.stdout.slice(-2000));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
