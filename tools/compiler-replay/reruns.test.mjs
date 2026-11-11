import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { areasOf } from "./common.mjs";
import { submissions } from "./submit.mjs";
import { shardSubmission, stallsSubmission } from "./reruns.mjs";
import { ROOT, areaAttempt, jobId, killed, ran, results, tool, write } from "./test-fixtures.mjs";

test("rerun-shard submits submit's own shard, its index written in and its record naming the job it replaces; --host pins it", () => {
  const all = submissions("b".repeat(40), "h".repeat(40), { owner: "o", prefix: "p" });
  const [area] = areasOf(ROOT);
  const args = shardSubmission(all, "p-areas", `${area.name}-5of16`, jobId("a", 5), "desktop");
  const template = all.find((a) => a[1] === `${area.name}-{i}of{n}`);
  const expanded = template.map((a) => a.replaceAll("{i}", "5").replaceAll("{n}", "16"));
  assert.deepEqual(
    args.slice(0, args.indexOf("--host")),
    expanded
      .slice(0, expanded.indexOf("--shards"))
      .concat(expanded.slice(expanded.indexOf("--shards") + 2, expanded.indexOf("--"))),
  );
  assert.deepEqual(args.slice(args.indexOf("--host"), args.indexOf("--") + 1), [
    "--host",
    "desktop",
    "--",
  ]);
  assert.equal(args.at(-1), `: replaces ${jobId("a", 5)}; ${expanded.at(-1)}`);
  assert.match(args.at(-1), /--shard 5\/16 /u);
  assert.throws(() => shardSubmission(all, "p-areas", "nowhere-5of16", jobId("a", 5)), /no shard/u);
  assert.throws(
    () => shardSubmission(all, "p-set", `${area.name}-5of16`, jobId("a", 5)),
    /no shard/u,
  );

  // (through the stand-in queue: refused unless the job ran this script on these trees)
  const root = mkdtempSync(join(tmpdir(), "compiler-replay-results-"));
  const bin = mkdtempSync(join(tmpdir(), "compiler-replay-bin-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(
    join(bin, "sx-job"),
    `#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' "${log}" "$@"\necho 22222222222222\n`,
  );
  chmodSync(join(bin, "sx-job"), 0o755);
  const commits = { base: "b".repeat(40), head: "h".repeat(40) };
  const job = (command) =>
    write(join(root, "p-areas", jobId("a", 5), "meta.json"), [
      ran(`${area.name}-5of16`, { ...killed, commits, command: ["bash", "-c", command] }),
    ]);
  const rerun = (head) =>
    spawnSync(
      process.execPath,
      [
        tool,
        "rerun-shard",
        "p",
        "b".repeat(9),
        head,
        jobId("a", 5),
        "--owner",
        "o",
        "--results",
        root,
        "--host",
        "laptop",
      ],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
  try {
    job(expanded.at(-1));
    assert.equal(rerun("x".repeat(40)).status, 2);
    const submitted = rerun("h".repeat(40));
    assert.equal(submitted.status, 0, submitted.stderr);
    assert.equal(submitted.stdout.trim(), "22222222222222");
    const [call] = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(call[call.indexOf("--host") + 1], "laptop");
    // (a prefix this clone cannot resolve goes as the recorded commit it names, never for the queue to read again)
    assert.equal(call[call.indexOf(`base=${"b".repeat(40)}`)], `base=${"b".repeat(40)}`);
    assert.equal(call.at(-1), `: replaces ${jobId("a", 5)}; ${expanded.at(-1)}`);
    job(expanded.at(-1).replace("--shard 5/16", "--shard 6/16"));
    assert.equal(rerun("h".repeat(40)).status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("rerun-stalls passes --host to the queue, and none without it", () => {
  const pinned = stallsSubmission("p", "b", "h", "/i.json", {
    owner: "o",
    memory: "12288",
    host: "desktop",
  });
  assert.deepEqual(pinned.slice(pinned.indexOf("--host"), pinned.indexOf("--") + 1), [
    "--host",
    "desktop",
    "--",
  ]);
  assert.ok(
    !stallsSubmission("p", "b", "h", "/i.json", { owner: "o", memory: "12288" }).includes("--host"),
  );
});

test("rerun-shard reruns a rerun and takes any name of the recorded commits; another command's shape is refused", () => {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const [area] = areasOf(ROOT);
  const [script] = submissions(commit, commit, { owner: "o", prefix: "p" })
    .filter((a) => a[1] === `${area.name}-{i}of{n}`)
    .map((a) => a.at(-1).replaceAll("{i}", "5").replaceAll("{n}", "16"));
  const root = mkdtempSync(join(tmpdir(), "compiler-replay-results-"));
  const job = (command) =>
    write(join(root, "p-areas", jobId("c", 5), "meta.json"), [
      ran(`${area.name}-5of16`, { ...killed, commits: { base: commit, head: commit }, command }),
    ]);
  const rerun = (ref) =>
    spawnSync(
      process.execPath,
      [
        tool,
        "rerun-shard",
        "p",
        ref,
        ref,
        jobId("c", 5),
        "--owner",
        "o",
        "--results",
        root,
        "--dry",
      ],
      { encoding: "utf8" },
    );
  try {
    // (a killed rerun `rerun-shard` made, named by `<sha>^0`: its rerun replaces it)
    job(["bash", "-c", `: replaces ${jobId("a", 5)}; ${script}`]);
    const again = rerun(`${commit}^0`);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).at(-2), `: replaces ${jobId("c", 5)}; ${script}`);
    // (a name is submitted as the commit it was checked as, never for the queue's clone to read again)
    const named = rerun("HEAD");
    assert.equal(named.status, 0, named.stderr);
    assert.ok(JSON.parse(named.stdout).includes(`head=${commit}`), named.stdout);
    assert.ok(JSON.parse(named.stdout).includes(`base=${commit}`), named.stdout);
    // (the script given beside another one that ran, as Bash's `$0`: refused)
    job(["bash", "-c", "exit 1", script]);
    assert.equal(rerun(commit).status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rerun-stalls reads the standing attempts' work records only, and a record stalls.mjs refuses is no index", () => {
  const unreadable = [{ work: { area: "rings", roots: [] } }];
  const root = results("p", (i) => (i === 3 ? { area: { record: killed, work: unreadable } } : {}));
  const stalls = () =>
    spawnSync(
      process.execPath,
      [tool, "rerun-stalls", "p", "b", "h", "--owner", "o", "--results", root],
      { encoding: "utf8" },
    );
  try {
    areaAttempt(root, jobId("c", 3), 3, {
      record: { command: ["bash", "-c", `: replaces ${jobId("a", 3)}; run`] },
    });
    const replaced = stalls();
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.equal(replaced.stdout, "no stalled source\n");
    areaAttempt(root, jobId("c", 3), 3, {
      record: { command: ["bash", "-c", `: replaces ${jobId("a", 3)}; run`] },
      work: unreadable,
    });
    const refused = stalls();
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /stalls\.mjs refused the work records/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rerun-shard reruns a split shard by the costs file its record names, refused where that file is not there (#2272)", () => {
  const home = mkdtempSync(join(tmpdir(), "compiler-replay-home-"));
  const root = join(home, "results");
  const text = '{"version":1,"areas":{}}\n';
  const hash = createHash("sha256").update(text).digest("hex");
  const file = join(home, "work", "replay-costs", `${hash}.json`);
  const commits = { base: "b".repeat(40), head: "h".repeat(40) };
  const [script] = submissions(commits.base, commits.head, {
    owner: "o",
    prefix: "p",
    split: { file, areas: { rings: { count: 5, seconds: [] } } },
  })
    .filter((args) => args[1] === "rings-{i}of{n}")
    .map((args) => args.at(-1).replaceAll("{i}", "3").replaceAll("{n}", "5"));
  write(join(root, "p-areas", jobId("a", 3), "meta.json"), [
    ran("rings-3of5", {
      ...killed,
      commits,
      inputs: { "costs.json": hash },
      command: ["bash", "-c", script],
    }),
  ]);
  const rerun = () =>
    spawnSync(
      process.execPath,
      [
        tool,
        "rerun-shard",
        "p",
        commits.base,
        commits.head,
        jobId("a", 3),
        "--owner",
        "o",
        "--results",
        root,
        "--dry",
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
  try {
    assert.match(script, /--shard 3\/5 --split /u);
    assert.equal(rerun().status, 2);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text.replace("{}", '{"rings":{}}'));
    assert.match(rerun().stderr, /was split by the costs file/u);
    writeFileSync(file, text);
    const again = rerun();
    assert.equal(again.status, 0, again.stderr);
    const args = JSON.parse(again.stdout);
    assert.equal(args[args.indexOf("--in") + 1], `costs.json=${file}`);
    assert.equal(args.at(-2), `: replaces ${jobId("a", 3)}; ${script}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
