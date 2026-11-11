import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { areasOf } from "./common.mjs";
import { batchOf, submissions } from "./submit.mjs";
import { ROOT, jobId, standInQueue, tool, write } from "./test-fixtures.mjs";

test("submit queues the set and every area in 16 shards, the fixture by its folder, copies at 6,144 MB", () => {
  const areas = areasOf(ROOT);
  assert.ok(areas.some((a) => a.name === "fixture" && a.folder === "tools/corpus/fixture"));
  assert.ok(areas.some((a) => a.name === "copies" && a.folder === "tests/families/copies"));
  const [set, ...rest] = submissions("b".repeat(40), "h".repeat(40), { owner: "o", prefix: "p" });
  assert.equal(set[set.indexOf("--campaign") + 1], "p-set");
  assert.match(
    set.at(-1),
    /plans\.mjs" "\$SX_TREE_base" "\$SX_TREE_head" corpus --shard \{i\}\/\{n\}/u,
  );
  assert.equal(rest.length, areas.length);
  for (const args of [set, ...rest]) assert.equal(args[args.indexOf("--shards") + 1], "16");
  const command = (name) => rest.find((args) => args[1] === `${name}-{i}of{n}`);
  assert.match(
    command("fixture").at(-1),
    /run\.mjs "\$SX_TREE_head\/tools\/corpus\/fixture" "\$SX_TREE_base"/u,
  );
  assert.match(command("copies").at(-1), / --memory 6144 /u);
  assert.equal(command("copies")[command("copies").indexOf("--mem") + 1], "8G");
  assert.doesNotMatch(command("joins").at(-1), /--memory/u);
  // (against the base's stored runs: the baseline's heap, the head tree alone)
  const stored = submissions("b".repeat(40), "h".repeat(40), {
    owner: "o",
    prefix: "p",
    baseline: true,
    baseSrc: "s",
  });
  const copies = stored.find((args) => args[1] === "copies-{i}of{n}");
  assert.equal(copies[copies.indexOf("--needs-baseline") + 1], "b".repeat(40));
  assert.match(copies.at(-1), /"\$SX_TREE_head" --baseline "\$HOME\/work\/baselines\/s\/copies"/u);
  assert.doesNotMatch(copies.at(-1), /--memory|SX_TREE_base/u);
});

test("submit hands every shard to the queue in one batch and prints the ids it returns", () => {
  const bin = mkdtempSync(join(tmpdir(), "compiler-replay-bin-"));
  const calls = standInQueue(bin);
  try {
    const run = spawnSync(
      process.execPath,
      [
        tool,
        "submit",
        "b".repeat(40),
        "h".repeat(40),
        "--owner",
        "o",
        "--campaign",
        "p",
        "--priority",
        "background",
      ],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    assert.equal(run.status, 0, run.stderr);
    const [batch, ...more] = calls();
    assert.ok(batch.lines.every((line) => line.startsWith("'--priority' 'background' ")));
    assert.deepEqual([batch.args[0], more.length], ["submit-batch", 0]);
    assert.equal(batch.lines.length, 16 * (1 + areasOf(ROOT).length));
    // (each line one shard's own submission, its index written in, shell-quoted)
    assert.match(batch.lines[0], /^'--priority' 'background' '--name' 'set-0of16' /u);
    assert.ok(batch.lines.every((line) => !line.includes("--shards") && !line.includes("{i}")));
    assert.equal(
      run.stdout.split("\n").filter((line) => line === "11111111111111").length,
      batch.lines.length,
    );
    // (the count of jobs, printed before the batch is queued)
    const printed = run.stdout.split("\n");
    const total = printed.indexOf(`jobs: ${batch.lines.length} in one batch`);
    assert.ok(total !== -1 && total < printed.indexOf("11111111111111"), run.stdout);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("submit runs each area it has costs for in their count of shards by the costs file, longest first, one --mem; the rest 16 by index (#2272)", () => {
  const split = {
    file: "/c/x.json",
    areas: {
      joins: { count: 3, seconds: [1500, 400, 400] },
      copies: { count: 2, seconds: [900, 900] },
    },
  };
  const all = submissions("b".repeat(40), "h".repeat(40), { owner: "o", prefix: "p", split });
  const named = (name) => all.find((args) => args[1] === `${name}-{i}of{n}`);
  for (const [name, count] of [
    ["copies", "2"],
    ["joins", "3"],
  ]) {
    const args = named(name);
    assert.equal(args[args.indexOf("--shards") + 1], count);
    assert.equal(args[args.indexOf("--in") + 1], "costs.json=/c/x.json");
    assert.match(args.at(-1), /--shard \{i\}\/\{n\} --split "\$SX_IN\/costs\.json"/u);
  }
  const rings = named("rings");
  assert.equal(rings[rings.indexOf("--shards") + 1], "16");
  assert.ok(!rings.includes("--in") && !rings.at(-1).includes("--split"), rings.at(-1));
  // (every area shard of a campaign asks one --mem, so the longest is never passed over for asking more)
  const mems = (campaign) =>
    new Set(all.filter((a) => a.includes(campaign)).map((a) => a[a.indexOf("--mem") + 1]));
  assert.deepEqual([...mems("p-areas")], ["8G"]);
  // (the batch: the sized areas' shards longest first, then the set and the other areas in submit's order)
  const names = batchOf(all, split).map((args) => args[1]);
  assert.deepEqual(names.slice(0, 7), [
    "joins-0of3",
    "copies-0of2",
    "copies-1of2",
    "joins-1of3",
    "joins-2of3",
    "set-0of16",
    "set-1of16",
  ]);
  assert.equal(names.length, new Set(names).size);
  assert.equal(names.length, 16 + 3 + 2 + 16 * (areasOf(ROOT).length - 2));
});

test("submit makes the costs file from the records, keeps it by its sha256, and says where it falls back to 16 by index (#2272)", () => {
  const home = mkdtempSync(join(tmpdir(), "compiler-replay-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = standInQueue(bin);
  const submit = (...more) =>
    spawnSync(
      process.execPath,
      [tool, "submit", "b".repeat(40), "h".repeat(40), "--owner", "o", "--campaign", "p", ...more],
      { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } },
    );
  try {
    const costs = join(home, "fill");
    write(join(costs, jobId("f", 0), "out", "rings.0of16.work.jsonl"), [
      { work: { area: "/t/tests/families/rings" } },
      { generator: "g.mjs", source: "s", key: "k", runs: [{ ms: [2_000_000] }] },
    ]);
    const sized = submit("--costs", costs, "--target", "600");
    assert.equal(sized.status, 0, sized.stderr);
    const [, file] = /^costs: (.+)$/mu.exec(sized.stdout) ?? [];
    const text = readFileSync(file, "utf8");
    assert.equal(
      file,
      join(home, "work", "replay-costs", `${createHash("sha256").update(text).digest("hex")}.json`),
    );
    assert.match(sized.stdout, /^rings: 1 shards by recorded seconds, the largest about 4000 s$/mu);
    assert.match(sized.stdout, /^joins: 16 shards by index \(no recorded seconds\)$/mu);
    const [{ lines }] = calls();
    const rings = lines.filter((line) => line.includes("'rings-0of1'"));
    assert.equal(rings.length, 1);
    assert.ok(rings[0].includes(`'--in' 'costs.json=${file}'`), rings[0]);
    // (no fill of a base this clone cannot name: today's 16 by index, said so; a --costs without records is refused)
    const fell = submit();
    assert.equal(fell.status, 0, fell.stderr);
    assert.match(
      fell.stdout,
      /^no recorded seconds \(this clone has no src\/ tree of b{40}\): 16 shards an area by index$/mu,
    );
    assert.equal(submit("--costs", join(home, "none")).status, 2);
    assert.equal(submit("--costs", costs, "--target", "0").status, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("submit orders the batch by the shards the recorded costs fill, not by an area's mean (#2272, review round 1)", () => {
  const home = mkdtempSync(join(tmpdir(), "compiler-replay-home-"));
  try {
    // (copies: 800 and 200 s a tree; joins: 600 and 600; two trees each: copies' shards 1,600 and 400 s, joins' 1,200)
    const record = (area, costs) =>
      write(join(home, "fill", jobId("f", area.length), "out", `${area}.0of1.work.jsonl`), [
        { work: { area: `/t/tests/families/${area}` } },
        ...costs.map((ms, k) => ({
          generator: "g.mjs",
          source: `s${k}`,
          key: "k",
          runs: [{ ms: [ms] }],
        })),
      ]);
    record("copies", [800_000, 200_000]);
    record("joins", [600_000, 600_000]);
    const run = spawnSync(
      process.execPath,
      [
        tool,
        "submit",
        "b".repeat(40),
        "h".repeat(40),
        "--owner",
        "o",
        "--costs",
        join(home, "fill"),
        "--dry",
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^copies: 2 shards by recorded seconds, the largest about 1600 s$/mu);
    const jobs = 16 + 2 + 2 + 16 * (areasOf(ROOT).length - 2);
    assert.match(run.stdout, new RegExp(`^jobs: ${jobs} in one batch\\n\\[`, "mu"));
    const names = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("["))
      .map((line) => JSON.parse(line))
      .map((args) => args[args.indexOf("--name") + 1]);
    assert.deepEqual(names.slice(0, 4), ["copies-0of2", "joins-0of2", "joins-1of2", "copies-1of2"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
