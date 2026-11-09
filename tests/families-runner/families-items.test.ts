import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const tool = resolve("tests/families/items.mjs");
const items = (args: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd?: string) =>
  spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", env, cwd });

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
  assert.equal(submitted.stdout, `sx-job submit --campaign T --items=${list} -- bash -c true\n`);
  // the items the check accepted are exactly the items the queue receives (Codex r1-r3 on #1681): with every forwarded
  // option, one items option, the checked file, its three items; an option that could change or multiply them
  // (`--shards`, `--items` in any spelling) refused, naming it
  const counting = join(folder, "counting");
  mkdirSync(counting);
  writeFileSync(
    join(counting, "sx-job"),
    '#!/bin/sh\nn=0\nfor a in "$@"; do case "$a" in --items=*) n=$((n+1)); f=${a#--items=};; esac; done\n' +
      'echo "items options $n, items $(grep -c . "$f")"\n',
    { mode: 0o755 },
  );
  const countingEnv = { ...process.env, PATH: `${counting}:${process.env["PATH"] ?? ""}` };
  const listed = items(["submit", list, "--unlisted", "--", "true"], countingEnv);
  assert.equal(listed.status, 2);
  const forwarded =
    /the forwarded options are ([^)]*)\)/.exec(listed.stderr)?.[1]?.split(" ") ?? [];
  assert.ok(forwarded.includes("--campaign") && !forwarded.includes("--shards"), listed.stderr);
  for (const option of forwarded) {
    const received = items(["submit", list, `${option}=x`, "--", "true"], countingEnv);
    assert.equal(received.stdout, "items options 1, items 3\n", option);
  }
  const bad = join(folder, "bad.txt");
  writeFileSync(bad, "held 1/2\nheld 2/2\n");
  for (const option of [
    ["--shards", "2"],
    ["--items", bad],
    [`--items=${bad}`],
    ["--item", bad],
    ["--it", bad],
  ]) {
    const replaced = items(["submit", list, ...option, "--", "true"], env);
    assert.deepEqual([replaced.status, replaced.stdout], [2, ""], option.join(" "));
    assert.match(
      replaced.stderr,
      new RegExp(`forwards no '${option[0]!.split("=")[0]}'`),
      option.join(" "),
    );
  }
  const dashed = join(folder, "--pool.txt");
  writeFileSync(dashed, made.stdout);
  const named = items(["submit", "--pool.txt", "--", "true"], env, folder);
  assert.equal(named.stdout, `sx-job submit --items=${dashed} -- true\n`);
  writeFileSync(list, "area copies 1/3\narea copies 2/3\narea copies 3/3\n");
  const refused = items(["submit", list, "--campaign", "T", "--", "true"], env);
  assert.deepEqual([refused.status, refused.stdout], [1, ""]);
});
