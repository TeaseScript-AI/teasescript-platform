import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ranOut } from "./results.mjs";
import { report, verdict } from "./collect.mjs";
import { areaAttempt, jobId, killed, ran, results, tool } from "./test-fixtures.mjs";

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
