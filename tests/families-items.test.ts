import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const items = (args: readonly string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, ["tests/families/items.mjs", ...args], { encoding: "utf8", env });

test("a pool's shard items are 0 to N-1 once in every group, and a 1-based list is refused before the queue (#1652)", (t) => {
  const made = items(["make", "3", "area", "copies"]);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout, "area copies 0/3\narea copies 1/3\narea copies 2/3\n");
  const folder = mkdtempSync(join(tmpdir(), "families-items-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const checked = (lines: readonly string[]) => {
    const file = join(folder, "items.txt");
    writeFileSync(file, `${lines.join("\n")}\n`);
    return items(["check", file]);
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
    [["held"], /is no '<words> i\/N'/],
    // (a shard where a runner reads none: a group word that is one, a leading zero, too many shards; an empty list)
    [["set 0/2 0/2", "set 0/2 1/2"], /is no '<words> i\/N'/],
    [["area copies 00/02", "area copies 01/02"], /is no '<words> i\/N'/],
    [["held 0/9007199254740992"], /more than 10000/],
    [[""], /holds no item/],
  ] as const) {
    const refused = checked(lines);
    assert.equal(refused.status, 1, lines.join(" | "));
    assert.match(refused.stderr, problem, lines.join(" | "));
  }
  assert.equal(items(["make", "2", "set", "0/2"]).status, 1);
  // `submit` checks the whole list, then hands it to `sx-job submit --items` (a stub here), and refuses a bad one first
  const bin = join(folder, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sx-job"), '#!/bin/sh\necho "sx-job $*"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
  const list = join(folder, "pool.txt");
  writeFileSync(list, made.stdout);
  const submitted = items(["submit", list, "--campaign", "T", "--", "bash", "-c", "true"], env);
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.equal(submitted.stdout, `sx-job submit --items ${list} --campaign T -- bash -c true\n`);
  writeFileSync(list, "area copies 1/3\narea copies 2/3\narea copies 3/3\n");
  const refused = items(["submit", list, "--campaign", "T", "--", "true"], env);
  assert.deepEqual([refused.status, refused.stdout], [1, ""]);
});
