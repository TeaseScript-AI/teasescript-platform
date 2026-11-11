import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  areaRecordForm,
  areasOf,
  batchOf,
  declarations,
  ranOut,
  report,
  routeOnly,
  setAside,
  setDifference,
  shardSubmission,
  stallsSubmission,
  submissions,
  verdict,
} from "./compiler-replay.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tool = fileURLToPath(new URL("./compiler-replay.mjs", import.meta.url));

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

/**
 * A stand-in `sx-job` in `bin` that logs each call's arguments, a batch's lines and each `--in` file's text (read before
 * it answers, as `sx-job` snapshots them: a missing one fails the call), and prints an id a job.
 */
function standInQueue(bin, id = "11111111111111") {
  const log = join(bin, "calls.jsonl");
  writeFileSync(
    join(bin, "sx-job"),
    `#!/bin/sh
node -e 'const fs = require("fs"); const [log, ...args] = process.argv.slice(1);
const lines = args[0] === "submit-batch" ? fs.readFileSync(args[1], "utf8").trim().split("\\n") : [];
const inputs = Object.fromEntries(args.flatMap((arg, at) => args[at - 1] === "--in"
  ? [[arg.slice(0, arg.indexOf("=")), fs.readFileSync(arg.slice(arg.indexOf("=") + 1), "utf8")]] : []));
fs.appendFileSync(log, JSON.stringify({ args, lines, inputs }) + "\\n");
for (const _ of args[0] === "submit-batch" ? lines : [0]) console.log("${id}");' "${log}" "$@"
`,
  );
  chmodSync(join(bin, "sx-job"), 0o755);
  return () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
}

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

const write = (file, rows) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
};

/** A queue record that ran out: `done`, on desktop; `fields` override it. */
const ran = (name, fields = {}) => ({
  name,
  exit: 0,
  outcome: "done",
  oom: [],
  timed_out: false,
  lost_test_files: null,
  worker: "desktop",
  ...fields,
});
const killed = { exit: 143, outcome: "killed at its memory cap", oom: ["x"], worker: "truenas" };

/**
 * One attempt of an area shard `rings-<i>of16` in `root`'s `p-areas`, its job `id`: its record (`ran`'s, with `record`),
 * and unless `ran` is false its summary, with its differences and work records.
 */
function areaAttempt(
  root,
  id,
  i,
  { record = {}, ran: summary = true, differences = [], work } = {},
) {
  const folder = join(root, "p-areas", id);
  write(join(folder, "meta.json"), [ran(`rings-${i}of16`, record)]);
  const out = join(folder, "out");
  if (summary)
    write(join(out, "rings.log"), [
      { area: "rings", sources: 2, runs: 8, differences: differences.length },
    ]);
  write(join(out, "rings.differences.jsonl"), differences);
  if (work !== undefined) write(join(out, "rings.work.jsonl"), work);
}

/** A job id of the stand-in queue: `n`'s 14 hexadecimal digits after `tag`. */
const jobId = (tag, n) => `${tag}${n.toString(16).padStart(13, "0")}`;

/** A results folder of `prefix`'s campaigns: one area's and the set's 16 shards, each as `shard(i)` makes it. */
function results(prefix, shard) {
  const root = mkdtempSync(join(tmpdir(), "compiler-replay-results-"));
  for (let i = 0; i < 16; i += 1) {
    const { area = {}, set = {} } = shard(i);
    areaAttempt(root, jobId("a", i), i, area);
    const folder = join(root, `${prefix}-set`, jobId("b", i));
    write(join(folder, "meta.json"), [ran(`set-${i}of16`)]);
    const s = join(folder, "out");
    if (set.ran !== false)
      write(join(s, "plans.log"), [
        { set: "corpus", sources: 1, runs: 4, stalled: 0, uncharged: 0 },
      ]);
    write(join(s, "plans.jsonl"), set.records ?? []);
  }
  return root;
}

const same = { plan: "p", diagnostics: "d", error: null, trace: "t", questions: "q", units: 1 };
const mode = (index, head = same) => ({ mode: index, base: same, head, same: head === same });

test("collect: every shard ran and nothing differs is equal; a shard with no summary is not run, never equal", () => {
  const equal = results("p", () => ({}));
  const missing = results("p", (i) => (i === 5 ? { area: { ran: false } } : {}));
  try {
    assert.deepEqual(verdict(report("p", equal, ["rings"])), { status: 0, reasons: [] });
    const { status, reasons } = verdict(report("p", missing, ["rings"]));
    assert.equal(status, 3);
    assert.deepEqual(reasons, ["not run: rings-5of16"]);
  } finally {
    rmSync(equal, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("collect: a route-only difference stands until aside agrees; an earlier part and a stall row are not route text", () => {
  const route = {
    generator: "g",
    source: "s",
    mode: "rev-on",
    check: "publication",
    // (both trees' hashes, as run.mjs writes a difference)
    base: "a",
    head: "b",
    part: 3,
    parts: [4, 4],
  };
  const earlier = { ...route, source: "t", part: 1 };
  const stall = { generator: "g", source: "u", stalled: "SIGKILL", at: { mode: "src-on" } };
  assert.ok(routeOnly(route) && !routeOnly(earlier) && !routeOnly({ ...route, parts: [4, 5] }));
  const root = results("p", (i) =>
    i === 0 ? { area: { differences: [route, earlier, stall] } } : {},
  );
  try {
    const r = report("p", root, ["rings"]);
    assert.deepEqual(
      r.differences.map((d) => [d.source, d.routeOnly]),
      [
        ["s", true],
        ["t", false],
      ],
    );
    assert.equal(verdict(r).status, 1);
    const agreed = {
      ...r,
      aside: [
        { source: "s", mode: "rev-on", planEqual: true, asideEqual: true },
        { source: "t", mode: "rev-on", planEqual: true, asideEqual: true },
      ],
    };
    // (route text set aside agrees; a difference before the route is never set aside)
    assert.deepEqual(verdict(agreed).reasons, ["rings g t rev-on: part 1 of 4/4"]);
    assert.equal(
      verdict({ ...agreed, differences: r.differences.filter((d) => d.routeOnly) }).status,
      0,
    );
    const apart = {
      ...agreed,
      differences: r.differences.filter((d) => d.routeOnly),
      aside: [{ ...agreed.aside[0], asideEqual: false }],
    };
    assert.equal(verdict(apart).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect: a set mode differing in its diagnostics alone stands until aside agrees; a plan or work apart never does", () => {
  assert.equal(setDifference(mode(0)), null);
  assert.equal(setDifference(mode(1, { ...same, diagnostics: "e" })), "diagnostics only");
  assert.equal(
    setDifference(mode(1, { ...same, diagnostics: "e", trace: "u" })),
    "diagnostics and work",
  );
  assert.equal(setDifference(mode(1, { ...same, plan: "x" })), "plan");
  assert.equal(setDifference(mode(1, { ...same, trace: "u" })), "work");
  const records = [
    { set: "corpus", name: "n", modes: [mode(0), mode(1, { ...same, diagnostics: "e" })] },
  ];
  const root = results("p", (i) => (i === 0 ? { set: { records } } : {}));
  try {
    const r = report("p", root, ["rings"]);
    assert.deepEqual(r.set.differences, [{ name: "n", mode: 1, what: "diagnostics only" }]);
    assert.equal(verdict(r).status, 1);
    // (the set's mode 1 is the reversed shared one, `HELD_MODES`' order)
    assert.equal(
      verdict({ ...r, aside: [{ source: "n", mode: "rev-on", planEqual: true, asideEqual: true }] })
        .status,
      0,
    );
    // (a mode named by `HELD_MODES`' name, #2342: "forward, unshared" is src-off, which a position in either table
    // (2 in HELD_MODES', 1 in the oracle's MODES') would not give as rev-on's or src-on's agreement)
    const named = {
      ...r,
      set: { ...r.set, differences: [{ ...r.set.differences[0], mode: "forward, unshared" }] },
    };
    const agreed = (label) => ({
      ...named,
      aside: [{ source: "n", mode: label, planEqual: true, asideEqual: true }],
    });
    assert.equal(verdict(agreed("src-off")).status, 0);
    for (const label of ["rev-on", "src-on", "rev-off"])
      assert.equal(verdict(agreed(label)).status, 1, label);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aside: a declared pattern sets aside its own text only, and a declaration without a reason is refused", () => {
  const declared = declarations(
    JSON.stringify([{ pattern: " \\d+ checks? runs? while it plays instead\\.", reason: "#2081" }]),
  );
  const [base, head] = [
    "Too large. 60 checks run while it plays instead. Most",
    "Too large. 1 check runs while it plays instead. Most",
  ];
  assert.equal(setAside(base, declared), setAside(head, declared));
  assert.notEqual(setAside(`${base} x`, declared), setAside(`${head} y`, declared));
  for (const text of ["[]", '[{"pattern": "a"}]', '[{"pattern": "a", "reason": " "}]', "{}"])
    assert.throws(() => declarations(text), /declaration/u, text);
  const file = join(mkdtempSync(join(tmpdir(), "compiler-replay-declare-")), "declare.json");
  try {
    writeFileSync(file, '[{"pattern": "a"}]');
    const run = spawnSync(
      process.execPath,
      [tool, "aside", "p", "b", "h", "--owner", "o", "--declare", file],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 2);
    assert.match(run.stderr, /each declaration has a `pattern` and a `reason`/u);
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
});

test("a step the tool does not have, or one missing its arguments, is a usage error", () => {
  for (const args of [[], ["replay"], ["submit", "b"], ["collect", "p"]]) {
    const run = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    assert.equal(run.status, 2, args.join(" "));
  }
});

test("collect: an area with no shard, a stall verdict stalls.mjs refuses, an uncompared stall and a plan apart are never equal", () => {
  const root = results("p", (i) =>
    i === 0 ? { area: { work: [{ work: { area: "rings", roots: [] } }] } } : {},
  );
  try {
    // (an area `submit` queued that left no shard at all: not run)
    assert.deepEqual(
      verdict(report("p", root, ["rings", "property"])).reasons.includes(
        "not run: property: no shard",
      ),
      true,
    );
    // (a record stalls.mjs refuses, as a rerun of another configuration: no verdict, never zero stalls)
    const r = report("p", root, ["rings"]);
    assert.notEqual(r.stalls.unread, null);
    assert.equal(verdict(r).status, 1);
    assert.match(verdict(r).reasons.join("\n"), /stalls: not judged/u);
    const judged = {
      ...r,
      stalls: { stalled: 2, candidate: 0, unknown: 0, unavailable: 2, unread: null },
    };
    assert.deepEqual(verdict(judged).reasons, ["stalls: 0 candidate, 0 unknown, 2 uncompared"]);
    const plan = {
      ...r,
      stalls: { ...judged.stalls, stalled: 0, unavailable: 0 },
      aside: [{ source: "s", mode: "rev-on", planEqual: false, asideEqual: true }],
    };
    assert.deepEqual(verdict(plan).reasons, ["aside s rev-on: plan ≠, text = aside"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aside's job compares each row's plan byte for byte and its route with the declared text set aside, on two built trees", () => {
  // (two stand-in built trees: the base's route says "60 checks", the head's "1 check"; the row `plan` differs in its plan)
  const trees = mkdtempSync(join(tmpdir(), "compiler-replay-trees-"));
  const tree = (name, count) => {
    const helpers = join(trees, name, "dist", "tests", "helpers");
    mkdirSync(helpers, { recursive: true });
    writeFileSync(
      join(helpers, "type-core-oracles.js"),
      `export const inMode = (mode, run) => run();\nexport const jsonText = (value) => JSON.stringify(value);\n` +
        `export const publishedRoute = (files) => ({ plan: { typeCheck: files[0].source === "plan" ? "${name}" : "t" }, ` +
        `text: "Too large. ${count} while it plays instead. Most" });\n`,
    );
    writeFileSync(
      join(helpers, "plan-checks.js"),
      "export const planChecks = (plan) => Object.keys(plan).length;\n",
    );
    return join(trees, name);
  };
  const [base, head] = [tree("base", "60 checks run"), tree("head", "1 check runs")];
  const rows = join(trees, "rows.jsonl");
  writeFileSync(
    rows,
    [
      { source: "text", mode: "rev-on", files: [{ path: "main.tease", source: "text" }] },
      { source: "plan", mode: "rev-off", files: [{ path: "main.tease", source: "plan" }] },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const declare = join(trees, "declare.json");
  writeFileSync(
    declare,
    JSON.stringify([{ pattern: " \\d+ checks? runs? while it plays instead\\.", reason: "#2081" }]),
  );
  const out = join(trees, "aside.jsonl");
  try {
    const run = spawnSync(process.execPath, [tool, "aside-run", base, head, rows, declare, out], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const written = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      written.map(({ source, planEqual, textEqual, asideEqual, checks }) => ({
        source,
        planEqual,
        textEqual,
        asideEqual,
        checks,
      })),
      [
        { source: "text", planEqual: true, textEqual: false, asideEqual: true, checks: [1, 1] },
        { source: "plan", planEqual: false, textEqual: false, asideEqual: true, checks: [1, 1] },
      ],
    );
  } finally {
    rmSync(trees, { recursive: true, force: true });
  }
});

test("a declaration file the tool cannot read or parse is a usage error, exit 2", () => {
  const folder = mkdtempSync(join(tmpdir(), "compiler-replay-declare-"));
  writeFileSync(join(folder, "bad.json"), "not json");
  try {
    for (const file of [join(folder, "missing.json"), join(folder, "bad.json")]) {
      const run = spawnSync(
        process.execPath,
        [tool, "aside", "p", "b", "h", "--owner", "o", "--declare", file],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 2, file);
      assert.match(run.stderr, /the declaration file/u);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("collect: an attempt stands only when its record shows its runner's own ending; a killed or stopped one with a summary does not", () => {
  assert.ok(ranOut(ran("n"), [0, 1]));
  // (a runner's own exit 1 or 3, as when something differs or the head alone crashed: it ran out)
  assert.ok(ranOut(ran("n", { exit: 1, outcome: "exit 1" }), [0, 1]));
  assert.ok(ranOut(ran("n", { exit: 3, outcome: "exit 3" }), [0, 1, 3]));
  assert.ok(!ranOut(ran("n", { exit: 3, outcome: "exit 3" }), [0, 1]));
  for (const fields of [
    killed,
    { exit: 0, outcome: "stopped by sx-job stop" },
    { exit: 124, outcome: "timed out", timed_out: true },
    { exit: 1, outcome: "exit 1", lost_test_files: ["f"] },
    { exit: 1, outcome: "exit 1", oom: ["x"] },
    { exit: undefined, outcome: undefined },
  ])
    assert.ok(!ranOut(ran("n", fields), [0, 1, 3]), JSON.stringify(fields));
  // (killed after it wrote its summary, alone: not run; with a rerun the rerun stands, the killed attempt replaced)
  const root = results("p", () => ({}));
  try {
    const rerun = jobId("c", 5);
    rmSync(join(root, "p-areas", jobId("a", 5)), { recursive: true });
    areaAttempt(root, jobId("a", 5), 5, { record: killed, differences: [{ mode: "src-on" }] });
    assert.deepEqual(verdict(report("p", root, ["rings"])).reasons, ["not run: rings-5of16"]);
    areaAttempt(root, rerun, 5, { record: { exit: 1, outcome: "exit 1" } });
    const r = report("p", root, ["rings"]);
    assert.deepEqual(verdict(r), { status: 0, reasons: [] });
    assert.deepEqual(r.attempts, [
      {
        shard: "rings-5of16",
        attempts: [
          {
            id: jobId("a", 5),
            host: "truenas",
            outcome: killed.outcome,
            summary: true,
            stands: false,
          },
          { id: rerun, host: "desktop", outcome: "exit 1", summary: true, stands: true },
        ],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect: a failed shard's rerun stands in its place, and the failed job's differences and work records are never read", () => {
  // (the failed attempt killed after it wrote a difference and a work record stalls.mjs refuses)
  const root = results("p", (i) =>
    i === 3
      ? {
          area: {
            record: killed,
            differences: [
              {
                generator: "g",
                source: "s",
                mode: "src-on",
                base: "a",
                head: "b",
                part: 1,
                parts: [2, 2],
              },
            ],
            work: [{ work: { area: "rings", roots: [] } }],
          },
        }
      : {},
  );
  try {
    assert.equal(verdict(report("p", root, ["rings"])).status, 3);
    areaAttempt(root, jobId("c", 3), 3, {
      record: { command: ["bash", "-c", `: replaces ${jobId("a", 3)}; run`] },
    });
    const r = report("p", root, ["rings"]);
    assert.deepEqual(verdict(r), { status: 0, reasons: [] });
    assert.equal(r.areas.rings.shards, 16);
    assert.deepEqual(r.differences, []);
    assert.equal(r.stalls.unread, null);
    assert.deepEqual(
      r.attempts[0].attempts.map((a) => [a.id, a.stands]),
      [
        [jobId("a", 3), false],
        [jobId("c", 3), true],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect: two attempts that both ran out are refused until one replaces the other, then read as one shard", () => {
  const root = results("p", () => ({}));
  const [first, second] = [jobId("a", 7), jobId("c", 7)];
  try {
    areaAttempt(root, second, 7);
    assert.throws(() => report("p", root, ["rings"]), /rings-7of16: .* --replace/u);
    const r = report("p", root, ["rings"], [[first, second]]);
    assert.equal(r.areas.rings.shards, 16);
    assert.equal(verdict(r).status, 0);
    // (through the command line: refused with exit 2, then read)
    const cli = (...extra) =>
      spawnSync(process.execPath, [tool, "collect", "p", "--results", root, ...extra], {
        encoding: "utf8",
      });
    assert.equal(cli().status, 2);
    const replaced = cli("--replace", `${first}=${second}`);
    assert.match(
      replaced.stdout,
      new RegExp(
        `rings-7of16: ${first} on desktop, done \\(replaced\\); ${second} on desktop, done \\(stands\\)`,
        "u",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect: a replacement outside the campaign, across shards or by a rerun that cannot stand is refused", () => {
  const root = results("p", () => ({}));
  const rerun = jobId("c", 2);
  try {
    areaAttempt(root, rerun, 2);
    for (const pair of [
      [jobId("a", 2), jobId("f", 2)],
      [jobId("f", 2), rerun],
      [jobId("a", 4), rerun],
      [jobId("b", 2), rerun],
    ])
      assert.throws(() => report("p", root, ["rings"], [pair]), /replace/u, pair.join("="));
    // (a rerun's record naming another shard's job)
    areaAttempt(root, rerun, 2, {
      record: { command: ["bash", "-c", `: replaces ${jobId("a", 4)}; run`] },
    });
    assert.throws(() => report("p", root, ["rings"]), /not an attempt of its shard/u);
    // (a rerun killed without its summary cannot stand for the shard)
    areaAttempt(root, rerun, 2, { record: killed, ran: false });
    assert.throws(
      () => report("p", root, ["rings"], [[jobId("a", 2), rerun]]),
      /cannot stand|did not run out/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("collect reads a replacement only from a `bash -c` script's opening, and a killed attempt's cut-off log is no summary", () => {
  const root = results("p", () => ({}));
  const [first, second] = [jobId("a", 6), jobId("c", 6)];
  try {
    // (the marker as Bash's `$0`, not the script: no replacement, so two attempts stand and are refused)
    areaAttempt(root, second, 6, {
      record: { command: ["bash", "-c", "run", `: replaces ${first}; `] },
    });
    assert.throws(() => report("p", root, ["rings"]), /rings-6of16: .* --replace/u);
    // (killed while writing its summary, with a clean rerun: the rerun stands)
    rmSync(join(root, "p-areas", second), { recursive: true });
    rmSync(join(root, "p-areas", first), { recursive: true });
    areaAttempt(root, first, 6, { record: killed, ran: false });
    writeFileSync(join(root, "p-areas", first, "out", "rings.log"), '{"generator":"g","sources":');
    areaAttempt(root, second, 6, {
      record: { command: ["bash", "-c", `: replaces ${first}; run`] },
    });
    const r = report("p", root, ["rings"]);
    assert.deepEqual(verdict(r), { status: 0, reasons: [] });
    assert.deepEqual(
      r.attempts[0].attempts.map((a) => [a.id, a.summary, a.stands]),
      [
        [first, false, false],
        [second, true, true],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("collect takes an area's count of shards from its jobs' names: all of one count stand, or it did not run (#2272)", () => {
  const areas = (counts) => {
    const root = results("p", () => ({}));
    rmSync(join(root, "p-areas"), { recursive: true, force: true });
    for (const [i, n] of counts.entries())
      if (n !== null) areaAttempt(root, jobId("a", i), i, { record: { name: `rings-${i}of${n}` } });
    return root;
  };
  const whole = areas([5, 5, 5, 5, 5]);
  const short = areas([5, 5, 5, null, 5]);
  const mixed = areas([5, 5, 16, 5, 5]);
  try {
    const r = report("p", whole, ["rings"]);
    assert.deepEqual(verdict(r), { status: 0, reasons: [] });
    assert.equal(r.counts.rings, "5");
    assert.deepEqual(verdict(report("p", short, ["rings"])).reasons, ["not run: rings: 4 of 5"]);
    assert.deepEqual(verdict(report("p", mixed, ["rings"])).reasons, [
      "not run: rings: shards named with 5 and 16 shards",
    ]);
  } finally {
    for (const root of [whole, short, mixed]) rmSync(root, { recursive: true, force: true });
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

/** A stand-in tree's oracle library: each source of `published.mjs` and `stopping.mjs` in one form `run.mjs` writes. */
const formsLibrary = (head) => `import { createHash } from "node:crypto";
export const MODES = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);
const hashed = (text) => createHash("sha256").update(text).digest("hex");
export function publicationHashes(files) {
  const source = files[0].source;
  if (source === "throws" || source === (${head} ? "throws on head" : "throws on base"))
    throw new TypeError("a stand-in exception");
  const answered = ${head} && source !== "left" ? '[1,"z"]' : '[1,"x"]';
  const unanswered = { left: ${head ? 1 : 2}, "left apart": 2 }[source] ?? 0;
  return { parts: ['"A"', '"R"', answered, '"T"'].map(hashed), unanswered };
}
export function stopSet(files) {
  if (${head} && files[0].source === "stops throw on head") throw new TypeError("a stand-in exception");
  return { stops: [[1, "r", "x", ${head ? 2 : 1}]], passes: 1, restarts: 0, outcome: "complete", exhausted: null,
    record: "same" };
}
`;

test("collect reads every area record form the real run.mjs writes, and a record of no known form differs, never equal (#2447)", () => {
  const directory = mkdtempSync(join(tmpdir(), "compiler-replay-forms-"));
  const root = results("p", () => ({}));
  try {
    const trees = [false, true].map((head) => {
      const tree = join(directory, head ? "head" : "base");
      write(join(tree, "package.json"), [{ type: "module" }]);
      mkdirSync(join(tree, "dist", "tests", "helpers"), { recursive: true });
      writeFileSync(
        join(tree, "dist", "tests", "helpers", "type-core-oracles.js"),
        formsLibrary(head),
      );
      return tree;
    });
    const area = join(directory, "rings");
    mkdirSync(area);
    // (a publication difference; an exception on both trees, on the base alone and on the head alone, and a stops
    // run's on the head alone; a run left unanswered whose answered parts agree, one whose answered parts differ; and a
    // stops run's difference, which has no parts)
    writeFileSync(
      join(area, "published.mjs"),
      `export const cases = ${JSON.stringify(
        ["throws", "left apart", "throws on head", "differs", "throws on base", "left"].map((s) => [
          s,
          s,
        ]),
      )};\n`,
    );
    writeFileSync(
      join(area, "stopping.mjs"),
      'export const cases = [["stops throw on head", "stops throw on head"], ["stops", "stops"]];\n' +
        'export const checks = ["stops"];\n',
    );
    // (shard 0 as the area job writes it: the runner's differences and its summary line)
    const out = join(root, "p-areas", jobId("a", 0), "out");
    const run = spawnSync(
      process.execPath,
      [join(ROOT, "tests/families/run.mjs"), area, ...trees, "--allowances", "natural"].concat([
        "--out",
        join(out, "rings.differences.jsonl"),
      ]),
      { encoding: "utf8" },
    );
    assert.equal(run.status, 1, run.stderr);
    writeFileSync(join(out, "rings.log"), run.stdout);
    const modes = ["src-on", "src-off", "rev-on", "rev-off"];
    const apart = (generator, source, text) =>
      modes.map((mode) => `rings ${generator} ${source} ${mode}: ${text}`);
    const expected = [
      "rings: 16 exceptions",
      "rings: 4 unanswered",
      ...apart("published.mjs", "left apart", "part 2 of 4/4"),
      ...apart("published.mjs", "differs", "part 2 of 4/4"),
      ...apart(
        "stopping.mjs",
        "stops",
        "stops natural apart; stops added 0; removed 0; moved 1: r:x (base pass 1 ordinal 1, head pass 1 ordinal 2)",
      ),
    ];
    const r = report("p", root, ["rings"]);
    assert.deepEqual(verdict(r), { status: 1, reasons: expected });
    assert.deepEqual(r.unread, []);
    // a record of no form the runner writes: unread, named, never dropped
    const odd = { generator: "g", source: "s", mode: "src-on", check: "publication", base: 1 };
    writeFileSync(join(out, "rings.differences.jsonl"), `${JSON.stringify(odd)}\n`, { flag: "a" });
    assert.deepEqual(verdict(report("p", root, ["rings"])).reasons, [
      ...expected,
      `rings (rings-0of16): a record of no form run.mjs writes: ${JSON.stringify(odd)}`,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stops difference is read only in a stops form run.mjs writes, any other is unread (#2355)", () => {
  const difference = {
    generator: "g",
    source: "s",
    mode: "src-on",
    check: "stops 16",
    base: "a",
    head: "b",
  };
  const stop = { label: "r", path: "x", base: [1, 2], head: null };
  const lists = (fields) => ({ added: [], removed: [], moved: [], ...fields });
  for (const stops of [
    { unavailable: "the base's run holds no stop list" },
    { listsEqual: true },
    lists({ removed: [stop] }),
    lists({ moved: [{ ...stop, head: [2, 2] }] }),
  ])
    assert.equal(areaRecordForm({ ...difference, stops }), "difference", JSON.stringify(stops));
  for (const stops of [
    null,
    [],
    { listsEqual: false },
    { unavailable: 1 },
    { unavailable: "x", listsEqual: true },
    { added: [], removed: [] },
    lists({ other: [] }),
    lists({ added: {} }),
    lists({ added: [{ ...stop, label: 1 }] }),
    lists({ added: [{ ...stop, path: undefined }] }),
    lists({ added: [{ ...stop, base: [1] }] }),
    lists({ added: [{ ...stop, base: [1, 2.5] }] }),
    lists({ added: [{ ...stop, base: null }] }),
    // (key sets compared by their names and count, never by a joined text)
    { "added moved removed": [] },
    { listsEqual: true, extra: 1 },
    lists({ added: [{ ...stop, extra: 1 }] }),
    lists({ added: [{ label: "r", path: "x", base: [1, 2] }] }),
  ])
    assert.equal(areaRecordForm({ ...difference, stops }), "unread", JSON.stringify(stops));
});

/**
 * A built tree whose oracle's source `over` charges five times its program's allowance, on every tree: a stall of the
 * real `run.mjs` that `stalls.mjs` indexes.
 */
function stallingTree(folder) {
  const core = join(folder, "dist", "src", "type-inference", "core");
  mkdirSync(core, { recursive: true });
  mkdirSync(join(folder, "dist", "tests", "helpers"), { recursive: true });
  writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
  writeFileSync(
    join(core, "budget.js"),
    "export class WorkLedger {\n  constructor(allowance) {\n    this.allowance = allowance;\n  }\n  charge() {}\n}\n",
  );
  writeFileSync(
    join(folder, "dist", "tests", "helpers", "type-core-oracles.js"),
    `import { WorkLedger } from "../../src/type-inference/core/budget.js";
export const MODES = [false, true].flatMap((reversed) => [false, true].map((unshared) => ({ reversed, unshared })));
export function publicationHashes(files) {
  new WorkLedger(1000).charge("frames", files[0].source === "over" ? 5000 : 10);
  return { parts: ["a", "b"], unanswered: 0 };
}
`,
  );
  return folder;
}

test("submit, rerun-stalls and aside each remove the temporary folder they made, also when they refuse or the queue does (#2433)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "compiler-replay-steps-"));
  try {
    // (the tool's TMPDIR, empty: what it leaves there is what it made)
    const temp = join(scratch, "tmp");
    const [bin, refusing] = [join(scratch, "bin"), join(scratch, "refusing")];
    for (const folder of [temp, bin, refusing]) mkdirSync(folder);
    const calls = standInQueue(bin);
    writeFileSync(join(refusing, "sx-job"), "#!/bin/sh\necho 'the queue refuses' >&2\nexit 1\n");
    chmodSync(join(refusing, "sx-job"), 0o755);
    const step = (queue, ...args) =>
      spawnSync(process.execPath, [tool, ...args], {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: temp, PATH: `${queue}:${process.env.PATH}` },
      });
    const left = () => readdirSync(temp);
    // (an area's one shard, as its job leaves it: the real runner's work records of a stall, or none)
    const results = (name, work) => {
      const root = join(scratch, name);
      const job = join(root, "p-areas", jobId("a", 0));
      write(join(job, "meta.json"), [ran("rings-0of1")]);
      const out = join(job, "out");
      write(join(out, "rings.log"), [{ area: "rings", sources: 2, runs: 8, differences: 0 }]);
      if (work !== undefined) {
        const area = join(scratch, "rings");
        mkdirSync(area, { recursive: true });
        writeFileSync(
          join(area, "g.mjs"),
          'export const cases = [["over", "over"], ["fine", "fine"]];\n',
        );
        const tree = stallingTree(join(scratch, "tree"));
        const run = spawnSync(
          process.execPath,
          [join(ROOT, "tests/families/run.mjs"), area, tree, tree, "--shard", "0/1"].concat([
            "--work",
            join(out, "rings.work.jsonl"),
          ]),
          { encoding: "utf8" },
        );
        assert.equal(run.status, 1, run.stderr);
      }
      return root;
    };
    const [none, stalled] = [results("none"), results("stalled", true)];
    const declare = join(scratch, "declare.json");
    writeFileSync(declare, '[{"pattern": "a", "reason": "a stand-in"}]');
    const submit = ["submit", "b".repeat(40), "h".repeat(40), "--owner", "o", "--campaign", "p"];
    const stalls = (root) => ["rerun-stalls", "p", "b", "h", "--owner", "o", "--results", root];
    const aside = ["aside", "p", "b", "h", "--owner", "o", "--declare", declare, "--results", none];
    for (const [what, queue, args, status, out] of [
      ["submit", bin, submit, 0, /campaigns: p-set, p-areas/u],
      ["submit, the queue refusing", refusing, submit, 2, /the queue refuses/u],
      ["rerun-stalls, no stall", bin, stalls(none), 0, /^no stalled source$/mu],
      ["rerun-stalls", bin, stalls(stalled), 0, /^11111111111111$/mu],
      ["rerun-stalls, the queue refusing", refusing, stalls(stalled), 2, /the queue refuses/u],
      ["aside", bin, aside, 0, /^11111111111111$/mu],
      ["aside, the queue refusing", refusing, aside, 2, /the queue refuses/u],
    ]) {
      const run = step(queue, ...args);
      assert.equal(run.status, status, `${what}: ${run.stderr}`);
      assert.match(run.stdout + run.stderr, out, what);
      assert.deepEqual(left(), [], what);
    }
    // (the queue read each step's file before the step removed it: the stall's index and aside's rows, as written)
    const read = Object.assign({}, ...calls().map(({ inputs }) => inputs));
    assert.equal(JSON.parse(read["index.json"]).entries.length, 1);
    assert.equal(read["rows.jsonl"], "\n");
    // (each step handed the queue a file in its own folder under the TMPDIR it was given)
    const given = calls().map(({ args }) =>
      args[0] === "submit-batch" ? args[1] : args.find((arg) => /^(index|rows)\.json/u.test(arg)),
    );
    assert.equal(given.length, 3);
    for (const file of given)
      assert.match(
        file,
        new RegExp(`^(index\\.json=|rows\\.jsonl=)?${temp}/compiler-replay-\\w{6}/`, "u"),
      );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
