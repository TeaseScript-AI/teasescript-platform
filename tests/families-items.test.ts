import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const items = (...args: string[]) =>
  spawnSync(process.execPath, ["tests/families/items.mjs", ...args], { encoding: "utf8" });

test("a pool's shard items are 0 to N-1 once in every group, and a 1-based list is refused before the queue (#1652)", (t) => {
  const made = items("make", "3", "area", "copies");
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout, "area copies 0/3\narea copies 1/3\narea copies 2/3\n");
  const folder = mkdtempSync(join(tmpdir(), "families-items-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const checked = (lines: readonly string[]) => {
    const file = join(folder, "items.txt");
    writeFileSync(file, `${lines.join("\n")}\n`);
    return items("check", file);
  };
  const whole = checked([made.stdout.trim(), "held 1/2", "held 0/2"].join("\n").split("\n"));
  assert.equal(whole.status, 0, whole.stderr);
  // (a 1-based list skips shard 0 and names one past the last; a repeat, a mixed N and a line without a shard)
  for (const [lines, problem] of [
    [
      ["area copies 1/3", "area copies 2/3", "area copies 3/3"],
      /shard 0\/3 missing[\s\S]*shard 3\/3 is none/,
    ],
    [["held 0/2", "held 1/2", "held 1/2"], /shard 1\/2 2 times/],
    [["held 0/2", "held 1/3"], /shards of 2 and 3 at once/],
    [["held"], /is no '<prefix> i\/N'/],
  ] as const) {
    const refused = checked(lines);
    assert.equal(refused.status, 1, lines.join(" | "));
    assert.match(refused.stderr, problem, lines.join(" | "));
  }
});
