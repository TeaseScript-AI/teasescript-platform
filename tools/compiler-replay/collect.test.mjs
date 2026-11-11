import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { areaRecordForm, report, routeOnly, setDifference, verdict } from "./collect.mjs";
import { ROOT, jobId, mode, results, same, write } from "./test-fixtures.mjs";

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
