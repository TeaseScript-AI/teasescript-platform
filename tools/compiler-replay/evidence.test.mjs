import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { areasOf } from "./common.mjs";
import {
  CLASSES,
  FIXED_LIMIT,
  areaShortfall,
  areaSources,
  classOf,
  evidenceReport,
  packageSources,
  partSummary,
  setSources,
  sourceClass,
} from "./evidence.mjs";
import { ROOT, jobId, ran, standInQueue, tool, write } from "./test-fixtures.mjs";

test("evidence: a run's class reads a limit only from a stop or a limit's refusal, a refusal by the route from another", () => {
  assert.equal(classOf({ stopped: null, analysed: true }), "completed");
  // (a run the checker never saw, compile errors before it, has no analysis: never completed)
  assert.equal(classOf({ stopped: null, analysed: false }), "unanalysed");
  assert.equal(classOf({ stopped: null }), "uncompared");
  assert.equal(classOf({ stopped: "work" }), "limit");
  assert.equal(classOf({ stopped: "read-depth" }), "limit");
  assert.equal(
    classOf({ stopped: null, error: "CandidateOutsideSlice: x", outside: "limit" }),
    "limit",
  );
  assert.equal(
    classOf({ stopped: null, error: "CandidateOutsideSlice: x", outside: "slice" }),
    "slice",
  );
  // (a throw is the checker's own outcome; only what the infrastructure did is incomplete)
  assert.equal(classOf({ stopped: null, error: "TypeError: x" }), "threw");
  // (a record from a runner before #2796 says no stop either way: never read as completed)
  assert.equal(classOf({ error: null }), "uncompared");
  // (a source: the worst of its runs, and no run at all is uncompared)
  assert.equal(sourceClass(["completed", "limit", "completed"]), "limit");
  assert.equal(sourceClass(["limit", "incomplete"]), "incomplete");
  assert.equal(sourceClass(["slice", "uncompared"]), "uncompared");
  assert.equal(sourceClass([]), "uncompared");
  assert.equal(sourceClass(["limit", "threw", "completed"]), "threw");
  assert.equal(sourceClass(["threw", "incomplete"]), "incomplete");
  assert.equal(sourceClass(["completed", "unanalysed"]), "unanalysed");
  assert.equal(sourceClass(["unanalysed", "slice"]), "slice");
  assert.deepEqual(CLASSES, [
    "completed",
    "unanalysed",
    "slice",
    "limit",
    "threw",
    "incomplete",
    "uncompared",
  ]);
});

const compile = (fields = {}) => ({
  plan: "p",
  diagnostics: "d",
  checks: 0,
  error: null,
  trace: "t",
  questions: "q",
  units: 300,
  allowance: 1000,
  stopped: null,
  outside: null,
  analysed: true,
  ...fields,
});
const setMode = (mode, base = compile(), head = base) => ({
  mode,
  base,
  head,
  same: JSON.stringify(base) === JSON.stringify(head),
});
const MODE_NAMES = ["forward", "reversed", "forward, unshared", "reversed, unshared"];
/** A compile that threw a `TypeError` at `at`, as `plans.mjs` records one. */
const threw = (at, message = "m") =>
  compile({
    error: `TypeError: ${message}`,
    plan: null,
    diagnostics: null,
    thrown: `TypeError at ${at}`,
  });
/** A compile whose errors before the checker gave the core no request, as `plans.mjs` records one. */
const unparsed = (fields = {}) =>
  compile({ plan: null, trace: "0/0/0", units: 0, allowance: 0, analysed: false, ...fields });

test("evidence: the set's sources by class on each tree, a class move apart from a difference, each tree's share of the limit", () => {
  const stopped = compile({ stopped: "work", units: 1001 });
  const sources = setSources([
    { name: "fine", modes: MODE_NAMES.map((m) => setMode(m)) },
    { name: "repaired", modes: MODE_NAMES.map((m) => setMode(m, stopped, compile())) },
    {
      name: "gate",
      modes: MODE_NAMES.map((m) =>
        setMode(m, compile({ error: "CandidateOutsideSlice: x", outside: "slice", plan: null })),
      ),
    },
    {
      name: "apart",
      modes: [
        setMode("forward", compile(), compile({ plan: "q" })),
        ...MODE_NAMES.slice(1).map((m) => setMode(m)),
      ],
    },
    { name: "stalled", stalled: "units", run: null },
    // (the same class and place, another message and other work before it: alike, never a difference)
    {
      name: "crashes",
      modes: MODE_NAMES.map((m) =>
        setMode(m, threw("f (a.js)", "before"), { ...threw("f (a.js)", "after"), trace: "u" }),
      ),
    },
    { name: "crashes now", modes: MODE_NAMES.map((m) => setMode(m, compile(), threw("f (a.js)"))) },
    {
      name: "crashes elsewhere",
      modes: MODE_NAMES.map((m) => setMode(m, threw("f (a.js)"), threw("g (b.js)"))),
    },
    // (the same place on each tree, in another mode: the class and the places alike, the outcome in a mode moved)
    {
      name: "crashes swapped",
      modes: MODE_NAMES.map((m, i) =>
        setMode(
          m,
          i === 0 ? threw("f (a.js)") : compile(),
          i === 1 ? threw("f (a.js)") : compile(),
        ),
      ),
    },
    // (a stop at another limit in the same mode)
    {
      name: "stops elsewhere",
      modes: MODE_NAMES.map((m) => setMode(m, stopped, compile({ stopped: "read-depth" }))),
    },
    // (a record without all four modes was not compared in every mode)
    { name: "three modes", modes: MODE_NAMES.slice(1).map((m) => setMode(m)) },
    { name: "one mode four times", modes: MODE_NAMES.map(() => setMode("forward")) },
    { name: "unparsed", modes: MODE_NAMES.map((m) => setMode(m, unparsed())) },
    {
      name: "unparsed apart",
      modes: MODE_NAMES.map((m) => setMode(m, unparsed(), unparsed({ diagnostics: "e" }))),
    },
    { name: "unparsed planned", modes: MODE_NAMES.map((m) => setMode(m, unparsed({ plan: "p" }))) },
    { name: "unparsed now", modes: MODE_NAMES.map((m) => setMode(m, compile(), unparsed())) },
  ]);
  const summary = partSummary(sources);
  assert.deepEqual(summary.counts.base, {
    completed: 4,
    unanalysed: 3,
    limit: 2,
    slice: 1,
    threw: 3,
    incomplete: 1,
    uncompared: 2,
  });
  assert.deepEqual(summary.counts.head, {
    completed: 3,
    unanalysed: 4,
    limit: 1,
    slice: 1,
    threw: 4,
    incomplete: 1,
    uncompared: 2,
  });
  // (the sources refused at the limit on both trees, by name; those refused by the route, counted)
  assert.deepEqual([summary.limitBoth, summary.sliceBoth], [["stops elsewhere"], 1]);
  // (a share carries its source's class on that tree)
  assert.deepEqual(
    summary.shares.map((share) => [share.heaviest.name, share.heaviest.class]),
    [
      ["repaired", "limit"],
      ["fine", "completed"],
    ],
  );
  // (a move is never one of the differences: a new throw is one, completed → threw; so is, within one class, another
  // outcome in a paired mode; the differences are over sources completed on both trees; a throw alike is listed apart)
  assert.deepEqual(summary.moved, [
    "repaired: refused at the limit → completed",
    "crashes now: completed → threw",
    "crashes elsewhere: forward: threw TypeError at f (a.js) → threw TypeError at g (b.js)",
    "crashes swapped: forward: threw TypeError at f (a.js) → completed",
    "stops elsewhere: forward: refused at the limit (work) → refused at the limit (read-depth)",
    "unparsed now: completed → no analysis (compile errors before the checker)",
  ]);
  assert.deepEqual(
    [summary.completed, summary.threwBoth, summary.differences],
    [2, 1, ["apart: plan"]],
  );
  assert.deepEqual(
    [summary.threwAlike, summary.apartElsewhere],
    [["crashes: TypeError at f (a.js)"], []],
  );
  // (no analysis on both trees: never among the completed, compared on its diagnostics and that no plan comes out)
  assert.deepEqual(
    [summary.unanalysed, summary.unanalysedDifferences],
    [
      ["unparsed", "unparsed apart", "unparsed planned"],
      ["unparsed apart: diagnostics only", "unparsed planned: a plan without analysis"],
    ],
  );
  // (the heaviest on the base is the stopped run, past its allowance and below the fixed limit)
  const [base] = summary.shares;
  assert.deepEqual(
    {
      name: base.heaviest.name,
      units: base.heaviest.units,
      today: base.heaviest.today,
      fixed: base.heaviest.fixed,
    },
    { name: "repaired", units: 1001, today: 1.001, fixed: 1001 / FIXED_LIMIT },
  );
});

test("evidence: an area's sources by their own counts and each tree's stops, its first difference by its place", () => {
  const run = (stopped, work = [300, 300], unparsed = [false, false]) => ({
    mode: "src-on",
    check: "publication",
    work,
    allowance: [1000, 1000],
    stopped,
    unparsed,
  });
  // (a source's runs in each of the area's four modes)
  const four = (...given) =>
    ["src-on", "src-off", "rev-on", "rev-off"].map((mode) => ({ ...run(...given), mode }));
  const work = [
    // (the header names each generator's checks: a source owes each in every mode)
    { work: { area: "x", configuration: { checks: { g: ["publication"] }, allowances: [null] } } },
    { generator: "g", source: "fine", runs: four([null, null]), counts: { runs: 1 } },
    {
      generator: "g",
      source: "regressed",
      runs: four([null, "work"], [300, 1200]),
      counts: { runs: 1 },
    },
    { generator: "g", source: "stall", runs: [], counts: { stalled: 1 } },
    {
      generator: "g",
      source: "unparsed",
      runs: four([null, null], [0, 0], [true, true]),
      counts: { unparsed: 1 },
    },
    // (the head alone has no request: a class move, never no analysis on both)
    {
      generator: "g",
      source: "unparsed now",
      runs: four([null, null], [300, 0], [false, true]),
      counts: { unparsed: 1 },
    },
    // (both trees leave a question unanswered alike: a partial publication, never completed)
    { generator: "g", source: "partial", runs: four([null, null]), counts: { unansweredAlike: 1 } },
    // (the same publication for other charged work: a difference)
    { generator: "g", source: "heavier", runs: four([null, null], [1, 2]), counts: { runs: 1 } },
    {
      generator: "g",
      source: "old",
      runs: [{ mode: "src-on", check: "publication", work: [1, 1], allowance: [1000, 1000] }],
      counts: {},
    },
    { generator: "g", source: "apart", runs: four([null, null]), counts: { differences: 1 } },
    { generator: "g", source: "throws", runs: four([null, null]), counts: { exceptions: 1 } },
    { generator: "g", source: "runner", runs: [], counts: { exceptions: 1 } },
    // (the base throws in one mode, the head at the same place in another: each tree threw, a mode moved)
    { generator: "g", source: "swapped", runs: four([null, null]), counts: { exceptions: 2 } },
    // (both trees leave a run unanswered, their answered parts differing: a partial publication, never completed)
    {
      generator: "g",
      source: "partial apart",
      runs: four([null, null]),
      counts: { differences: 1 },
      unanswered: [
        { mode: "src-on", check: "publication", differs: true, by: { reason: "memory" } },
      ],
    },
    // (a source run in one mode only, and one run four times in the same mode: neither compared in every mode)
    { generator: "g", source: "one mode", runs: [run([null, null])], counts: { runs: 1 } },
    {
      generator: "g",
      source: "one mode four times",
      runs: [0, 1, 2, 3].map(() => run([null, null])),
      counts: { runs: 4 },
    },
    { area: "x", sources: 15 },
  ];
  const differences = [
    {
      generator: "g",
      source: "apart",
      mode: "rev-on",
      check: "publication",
      base: "a",
      head: "b",
      part: 1,
      parts: [3, 3],
    },
    // (an exception on the head alone, its stack as run-child.mjs keeps it; one outside the runs, the runner's)
    {
      generator: "g",
      source: "throws",
      mode: "src-on",
      check: "publication",
      thrown: { head: "TypeError: m\n    at walk (file:///t/head/dist/src/x.js:3:9)" },
    },
    { generator: "g", source: "runner", thrown: { runner: "Error: no MODES" } },
    ...[
      ["src-on", "base"],
      ["rev-on", "head"],
    ].map(([mode, tree]) => ({
      generator: "g",
      source: "swapped",
      mode,
      check: "publication",
      thrown: { [tree]: `TypeError: m\n    at walk (file:///t/${tree}/dist/src/x.js:3:9)` },
    })),
  ];
  const summary = partSummary(areaSources(work, differences));
  assert.deepEqual(summary.counts.base, {
    completed: 6,
    unanalysed: 1,
    limit: 0,
    slice: 0,
    threw: 1,
    incomplete: 4,
    uncompared: 3,
  });
  assert.deepEqual(summary.counts.head, {
    completed: 3,
    unanalysed: 2,
    limit: 1,
    slice: 0,
    threw: 2,
    incomplete: 4,
    uncompared: 3,
  });
  assert.deepEqual(summary.moved, [
    "g regressed: completed → refused at the limit",
    "g unparsed now: completed → no analysis (compile errors before the checker)",
    "g throws: completed → threw",
    "g swapped: src-on publication: threw TypeError at walk (src/x.js) → completed",
  ]);
  assert.deepEqual(summary.threwAlike, []);
  // (each record the counts say the runner wrote is read, or the area did not run whole)
  assert.deepEqual(areaShortfall(work, differences), ["1 of 2 differences records read"]);
  assert.deepEqual(areaShortfall(work, []), [
    "0 of 2 differences records read",
    "0 of 4 exceptions records read",
  ]);
  assert.deepEqual(summary.differences, [
    "g heavier: src-on: publication charged work 1/2",
    "g apart: rev-on: part 1 of 3/3",
  ]);
  assert.deepEqual(summary.unanalysed, ["g unparsed"]);
  assert.deepEqual(summary.shares[1].heaviest.name, "g regressed");
  assert.deepEqual(summary.shares[1].aboveHalf, []);
});

const packageRun = (fields = {}) => ({
  analysis: {
    error: null,
    answers: "a",
    diagnostics: "d",
    codes: {},
    checks: "c",
    counts: "n",
    checked: "k",
    trace: "t",
    questions: "q",
    units: 600,
    allowance: 1000,
    stopped: null,
    analysed: true,
    ...fields,
  },
  route: {
    plan: null,
    diagnostics: "d",
    codes: {},
    checked: null,
    facts: null,
    error: "CandidateOutsideSlice",
    outside: "slice",
    trace: "t",
    questions: "q",
    units: 1,
    allowance: 1000,
    stopped: null,
  },
});
const packageMode = (mode, base = packageRun(), head = base) => ({
  mode,
  base,
  head,
  same: JSON.stringify(base) === JSON.stringify(head),
});

test("evidence: a package's class is its analysis's, its first difference by part in a fixed order, a bound reached incomplete", () => {
  const sources = packageSources([
    { name: "a", root: 0, files: 1, differing: 0, modes: MODE_NAMES.map((m) => packageMode(m)) },
    {
      name: "a",
      root: 1,
      files: 1,
      differing: 1,
      modes: [
        packageMode("forward", packageRun(), packageRun({ answers: "b", trace: "u" })),
        ...MODE_NAMES.slice(1).map((m) => packageMode(m)),
      ],
    },
    {
      name: "stops",
      root: 0,
      files: 1,
      differing: 0,
      modes: MODE_NAMES.map((m) => packageMode(m, packageRun({ stopped: "work", units: 1100 }))),
    },
    {
      name: "thrown",
      root: 0,
      files: 1,
      differing: 0,
      modes: MODE_NAMES.map((m) =>
        packageMode(m, packageRun({ error: "TypeError at f (src/a.js)" })),
      ),
    },
    {
      name: "unparsed",
      root: 0,
      files: 1,
      differing: 0,
      modes: MODE_NAMES.map((m) =>
        packageMode(m, {
          ...packageRun(),
          analysis: { analysed: false, error: null, stopped: null, units: 0, allowance: 0 },
        }),
      ),
    },
    // (the same mode four times: not compared in every mode)
    {
      name: "one mode four times",
      root: 0,
      files: 1,
      differing: 0,
      modes: MODE_NAMES.map(() => packageMode("forward")),
    },
    { name: "hang", root: 0, incomplete: "safety net 3600 s" },
  ]);
  const summary = partSummary(sources);
  // (a package whose files give no core request has no analysis, its compile compared, and is named)
  assert.deepEqual([summary.unanalysed, summary.unanalysedDifferences], [["unparsed"], []]);
  assert.deepEqual(summary.counts.base, {
    completed: 2,
    unanalysed: 1,
    limit: 1,
    slice: 0,
    threw: 1,
    incomplete: 1,
    uncompared: 1,
  });
  assert.deepEqual(summary.threwAlike, ["thrown: TypeError at f (src/a.js)"]);
  // (a package of the same name in another folder is named by its folder; the answers before the trace)
  assert.deepEqual(summary.differences, ["a (folder 2): forward: analysis answers"]);
  assert.deepEqual(
    summary.shares[0].aboveHalf.map((s) => s.name),
    ["a", "a (folder 2)", "thrown", "one mode four times"],
  );
  assert.equal(summary.shares[0].heaviest.name, "stops");
  assert.equal(sources.find((s) => s.name === "hang").bound, "safety net 3600 s");
  // (the completed packages' research routes refused alike: their route results are not compared)
  assert.deepEqual(summary.routeNotCompared, { threw: 0, refused: 2 });
});

test("evidence: a package's research route compared where it completed on both trees, else counted not compared where alike, a move where not", () => {
  const route = (fields) => ({ ...packageRun(), route: { ...packageRun().route, ...fields } });
  const done = route({ error: null, outside: null, plan: "p" });
  const thrownAt = (at) => route({ error: `TypeError at ${at}`, outside: null });
  const pkg = (name, base, head = base) => ({
    name,
    root: 0,
    files: 1,
    differing: 0,
    modes: MODE_NAMES.map((m) => packageMode(m, base, head)),
  });
  const sources = packageSources([
    pkg("compared", done, route({ error: null, outside: null, plan: "p", diagnostics: "e" })),
    // (alike: only the analysis's parts are compared, so other work before the throw is no difference)
    pkg("threw alike", thrownAt("g (src/b.js)"), {
      ...thrownAt("g (src/b.js)"),
      route: { ...thrownAt("g (src/b.js)").route, trace: "u" },
    }),
    pkg("refused alike", packageRun()),
    pkg("throws now", done, thrownAt("g (src/b.js)")),
    pkg("throws elsewhere", thrownAt("g (src/b.js)"), thrownAt("h (src/c.js)")),
    // (refused at the same place, at the gate on the base and at the limit on the head)
    pkg("refused otherwise", packageRun(), route({ outside: "limit" })),
    // (refused at the limit on both trees, a ledger stopping at another limit on the head)
    pkg(
      "refused at another limit",
      route({ outside: "limit", stopped: "work" }),
      route({ outside: "limit", stopped: "read-depth" }),
    ),
    // (the base's route throws in one mode, the head's at the same place in another)
    {
      name: "throws swapped",
      root: 0,
      files: 1,
      differing: 0,
      modes: MODE_NAMES.map((m, i) =>
        packageMode(
          m,
          i === 0 ? thrownAt("g (src/b.js)") : done,
          i === 1 ? thrownAt("g (src/b.js)") : done,
        ),
      ),
    },
    // (the base's analysis throws in one mode, the head's at the same place in another)
    {
      name: "analysis swapped",
      root: 0,
      files: 1,
      differing: 0,
      modes: MODE_NAMES.map((m, i) => {
        const at = { ...done, analysis: { ...done.analysis, error: "TypeError at f (src/a.js)" } };
        return packageMode(m, i === 0 ? at : done, i === 1 ? at : done);
      }),
    },
  ]);
  const summary = partSummary(sources);
  assert.equal(summary.completed, 8);
  assert.deepEqual(summary.differences, ["compared: forward: route diagnostics"]);
  assert.deepEqual(summary.routeNotCompared, { threw: 1, refused: 1 });
  assert.deepEqual(summary.routeNotComparedList, [
    "threw alike: threw TypeError at g (src/b.js)",
    "refused alike: refused outside its slice CandidateOutsideSlice",
  ]);
  // (a route outcome in a mode on one tree only, at another place or of another kind, is a move, listed with the class
  // moves; so is the analysis's outcome in a mode, the class alike)
  assert.deepEqual(summary.moved, [
    "throws now: route forward: completed → threw TypeError at g (src/b.js)",
    "throws elsewhere: route forward: threw TypeError at g (src/b.js) → threw TypeError at h (src/c.js)",
    "refused otherwise: route forward: refused outside its slice CandidateOutsideSlice → refused at the limit CandidateOutsideSlice",
    "refused at another limit: route forward: refused at the limit (work) CandidateOutsideSlice → refused at the limit (read-depth) CandidateOutsideSlice",
    "throws swapped: route forward: threw TypeError at g (src/b.js) → completed",
    "analysis swapped: forward: threw TypeError at f (src/a.js) → completed",
  ]);
});

/** A results folder of campaign `p`: `set` shards (`setRecords(i)`), the packages' one shard and the checks' job. */
function evidenceResults({
  setRecords,
  packages = [],
  checks = [
    { step: "check-changed", status: 0 },
    { step: "pin-suites", status: 0 },
  ],
  setShards = 16,
}) {
  const root = mkdtempSync(join(tmpdir(), "compiler-replay-evidence-"));
  for (let i = 0; i < setShards; i += 1) {
    const folder = join(root, "p-set", jobId("b", i));
    write(join(folder, "meta.json"), [ran(`set-${i}of16`)]);
    write(join(folder, "out", "plans.log"), [
      { set: "corpus", sources: 1, runs: 4, stalled: 0, uncharged: 0 },
    ]);
    write(join(folder, "out", "plans.jsonl"), setRecords(i));
  }
  const pkg = join(root, "p-packages", jobId("c", 0));
  write(join(pkg, "meta.json"), [ran("packages-0of1")]);
  write(join(pkg, "out", "packages.log"), [
    { packages: "0/1", sources: packages.length, differing: 0, incomplete: 0 },
  ]);
  write(join(pkg, "out", "packages.jsonl"), packages);
  const check = join(root, "p-checks", jobId("d", 0));
  write(join(check, "meta.json"), [
    ran("checks", {
      exit: checks.every((s) => s.status === 0) ? 0 : 1,
      outcome: checks.every((s) => s.status === 0) ? "done" : "exit 1",
    }),
  ]);
  write(join(check, "out", "checks.jsonl"), checks);
  return root;
}
const manifest = (fields = {}) => ({
  prefix: "p",
  base: "b".repeat(40),
  head: "h".repeat(40),
  areas: { asked: ["set"], left: areasOf(ROOT).map((a) => a.name) },
  packages: [{ folder: "/k", count: 1 }],
  packageShards: 1,
  bound: { timeout: 3600, memory: 6500 },
  tests: [],
  ...fields,
});

test("evidence-report: equal only where every part asked ran and completed something; a part not run, a class move or a failed check is not", () => {
  const fine = (i) => [
    {
      set: "corpus",
      name: `s${i}`,
      key: "k".repeat(64),
      runs: 4,
      differing: 0,
      modes: MODE_NAMES.map((m) => setMode(m)),
    },
  ];
  const pkg = {
    name: "a",
    root: 0,
    files: 1,
    differing: 0,
    modes: MODE_NAMES.map((m) => packageMode(m)),
  };
  const folders = [];
  const report = (options, m = manifest()) => {
    const root = evidenceResults(options);
    folders.push(root);
    return evidenceReport(m, root);
  };
  try {
    const equal = report({ setRecords: fine, packages: [pkg] });
    assert.deepEqual([equal.status, equal.reasons, equal.notRun], [0, [], []]);
    // (the package's route refused alike: the equal claim says it covers the analysis's publication only there)
    assert.equal(
      equal.verdict,
      "equal (for 1 package whose route result is not compared, over the analysis's publication only)",
    );
    assert.equal(equal.parts.set.completed, 16);
    // (an area left out is said so by the manifest, never "not run"; a shard missing is)
    const missing = report({ setRecords: fine, packages: [pkg], setShards: 15 });
    assert.deepEqual([missing.status, missing.notRun], [3, ["set: 15 of 16"]]);
    const fewer = report({ setRecords: fine, packages: [] });
    assert.deepEqual([fewer.status, fewer.notRun], [3, ["packages: 0 of 1 packages"]]);
    // (a shard whose records fall short of the sources its summary counts did not run whole)
    const lost = report({ setRecords: (i) => (i === 0 ? [] : fine(i)), packages: [pkg] });
    assert.deepEqual([lost.status, lost.notRun], [3, ["set: 15 of 16 sources read"]]);
    // (a part asked that holds nothing, as an empty package folder, completed nothing: never equal)
    const empty = report(
      { setRecords: fine, packages: [] },
      manifest({ packages: [{ folder: "/k", count: 0 }] }),
    );
    assert.deepEqual(
      [empty.status, empty.notRun, empty.reasons],
      [1, [], ["packages: nothing completed on both trees"]],
    );
    // (nothing completed is never equal, though nothing differs)
    // (a source that threw alike on both trees is equal, and listed; a new throw on the head is a class move)
    const crash = (i) =>
      i === 2
        ? [
            {
              ...fine(i)[0],
              modes: MODE_NAMES.map((m) =>
                setMode(m, threw("f (a.js)", "before"), threw("f (a.js)", "after")),
              ),
            },
          ]
        : fine(i);
    const alike = report({ setRecords: crash, packages: [pkg] });
    assert.deepEqual(
      [alike.status, alike.reasons, alike.parts.set.threwAlike],
      [0, [], ["s2: TypeError at f (a.js)"]],
    );
    // (a source with no analysis on both trees is never completed: counted and listed apart, equal where its diagnostics
    // agree and no plan comes out)
    const broken = (i) =>
      i === 3 ? [{ ...fine(i)[0], modes: MODE_NAMES.map((m) => setMode(m, unparsed())) }] : fine(i);
    const unanalysed = report({ setRecords: broken, packages: [pkg] });
    assert.deepEqual(
      [unanalysed.status, unanalysed.reasons, unanalysed.parts.set.completed],
      [0, [], 15],
    );
    assert.deepEqual(unanalysed.parts.set.unanalysed, ["s3"]);
    const fresh = (i) =>
      i === 2
        ? [
            {
              ...fine(i)[0],
              modes: MODE_NAMES.map((m) => setMode(m, compile(), threw("f (a.js)"))),
            },
          ]
        : fine(i);
    assert.deepEqual(report({ setRecords: fresh, packages: [pkg] }).reasons, [
      "set: moved: s2: completed → threw",
    ]);
    const gate = (i) => [
      {
        ...fine(i)[0],
        modes: MODE_NAMES.map((m) =>
          setMode(m, compile({ error: "CandidateOutsideSlice: x", outside: "slice" })),
        ),
      },
    ];
    assert.deepEqual(report({ setRecords: gate, packages: [pkg] }).reasons, [
      "set: nothing completed on both trees",
    ]);
    const moved = (i) =>
      i === 3
        ? [
            {
              ...fine(i)[0],
              modes: MODE_NAMES.map((m) => setMode(m, compile(), compile({ stopped: "work" }))),
            },
          ]
        : fine(i);
    const regression = report({ setRecords: moved, packages: [pkg] });
    assert.deepEqual(
      [regression.status, regression.reasons],
      [1, ["set: moved: s3: completed → refused at the limit"]],
    );
    // (a step that failed stops the job: the steps after it did not run, never passed)
    const failed = report({
      setRecords: fine,
      packages: [pkg],
      checks: [{ step: "check-changed", status: 1 }],
    });
    assert.deepEqual(
      [failed.status, failed.reasons],
      [1, ["checks: pin-suites not run", "checks: check-changed exited 1"]],
    );
    // (the --tests step asked and not run)
    const untested = report(
      { setRecords: fine, packages: [pkg] },
      manifest({ tests: ["dist/tests/a.test.js"] }),
    );
    assert.deepEqual([untested.status, untested.reasons], [1, ["checks: tests not run"]]);
    // (a run that compared nothing, no area and no package, is never equal)
    const none = report(
      { setRecords: fine, packages: [pkg] },
      manifest({ areas: { asked: [], left: [] }, packages: [] }),
    );
    assert.deepEqual(
      [none.status, none.reasons],
      [1, ["nothing compared: no area and no package"]],
    );
  } finally {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }
});

test("evidence queues only the areas asked, each package folder as data, and the checks against the base; it records what it queued", () => {
  const bin = mkdtempSync(join(tmpdir(), "compiler-replay-bin-"));
  const home = mkdtempSync(join(tmpdir(), "compiler-replay-home-"));
  const calls = standInQueue(bin);
  const folder = join(home, "work", "k packages");
  for (const name of ["one", "two words"]) mkdirSync(join(folder, name), { recursive: true });
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home };
  try {
    const refused = spawnSync(
      process.execPath,
      [tool, "evidence", head, head, "--owner", "o", "--areas", "set,nowhere"],
      { encoding: "utf8", env },
    );
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--areas: no area nowhere/);
    // (no area and no package: nothing to compare, refused)
    const empty = spawnSync(
      process.execPath,
      [tool, "evidence", head, head, "--owner", "o", "--areas", "", "--dry"],
      { encoding: "utf8", env },
    );
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /nothing to compare/);
    const run = spawnSync(
      process.execPath,
      [
        tool,
        "evidence",
        "HEAD",
        head,
        "--owner",
        "o",
        "--campaign",
        "p",
        "--areas",
        "copies",
        "--packages",
        folder,
        "--package-shards",
        "2",
        "--tests",
        "dist/a.test.js",
      ],
      { encoding: "utf8", env },
    );
    assert.equal(run.status, 0, run.stderr);
    const [batch] = calls();
    const names = batch.lines.map((line) => /'--name' '([^']+)'/.exec(line)[1]);
    assert.ok(
      names.every((name) => /^(copies-\d+of\d+|packages-[01]of2|checks)$/.test(name)),
      names.join(" "),
    );
    assert.ok(
      names.includes("checks") &&
        names.includes("packages-1of2") &&
        !names.some((n) => n.startsWith("set")),
    );
    const pack = batch.lines.find((line) => line.includes("'packages-0of2'"));
    assert.ok(
      pack.includes(`'--data' '${folder}'`) && pack.includes("--timeout 3600 --memory 6500"),
      pack,
    );
    const checks = batch.lines.find((line) => line.includes("'checks'"));
    assert.ok(
      checks.includes(`--checkout' '${head}'`) &&
        checks.includes(`check-changed.mjs --base ${head}`) &&
        checks.includes("dist/a.test.js"),
      checks,
    );
    const recorded = JSON.parse(
      readFileSync(join(home, "work", "replay-evidence", "p.json"), "utf8"),
    );
    assert.deepEqual(
      [recorded.base, recorded.areas.asked, recorded.areas.left.includes("set"), recorded.packages],
      [head, ["copies"], true, [{ folder, count: 2 }]],
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("evidence: in each record form, any two outcomes of one paired mode are a move where they differ and the same outcome where they agree", () => {
  // (each outcome a run of that form can hold, the other three modes completed)
  const forms = {
    set: {
      outcomes: {
        completed: compile(),
        unanalysed: unparsed(),
        slice: compile({ error: "CandidateOutsideSlice: x", outside: "slice", plan: null }),
        "limit refusal": compile({
          error: "CandidateOutsideSlice: x",
          outside: "limit",
          plan: null,
        }),
        "limit work": compile({ stopped: "work" }),
        "limit depth": compile({ stopped: "read-depth" }),
        "threw f": threw("f (a.js)"),
        "threw g": threw("g (b.js)"),
      },
      summary: (b, h) =>
        partSummary(
          setSources([
            {
              name: "s",
              modes: MODE_NAMES.map((m, i) => (i === 0 ? setMode(m, b, h) : setMode(m))),
            },
          ]),
        ),
    },
    analysis: {
      outcomes: {
        completed: packageRun(),
        unanalysed: {
          ...packageRun(),
          analysis: { analysed: false, error: null, stopped: null, units: 0, allowance: 0 },
        },
        "limit work": packageRun({ stopped: "work" }),
        "limit depth": packageRun({ stopped: "read-depth" }),
        "threw f": packageRun({ error: "TypeError at f (src/a.js)" }),
        "threw g": packageRun({ error: "TypeError at g (src/b.js)" }),
      },
      summary: (b, h) =>
        partSummary(
          packageSources([
            {
              name: "s",
              root: 0,
              files: 1,
              differing: 0,
              modes: MODE_NAMES.map((m, i) => (i === 0 ? packageMode(m, b, h) : packageMode(m))),
            },
          ]),
        ),
    },
    route: {
      outcomes: Object.fromEntries(
        [
          ["completed", { error: null, outside: null }],
          ["slice", { error: "CandidateOutsideSlice", outside: "slice" }],
          ["limit refusal", { error: "CandidateOutsideSlice", outside: "limit" }],
          [
            "limit work refusal",
            { error: "CandidateOutsideSlice", outside: "limit", stopped: "work" },
          ],
          ["limit work", { error: null, outside: null, stopped: "work" }],
          ["threw f", { error: "TypeError at f (src/a.js)", outside: null }],
          ["threw g", { error: "TypeError at g (src/b.js)", outside: null }],
        ].map(([name, fields]) => [
          name,
          { ...packageRun(), route: { ...packageRun().route, ...fields } },
        ]),
      ),
      summary: (b, h) => {
        const done = {
          ...packageRun(),
          route: { ...packageRun().route, error: null, outside: null },
        };
        return partSummary(
          packageSources([
            {
              name: "s",
              root: 0,
              files: 1,
              differing: 0,
              modes: MODE_NAMES.map((m, i) =>
                i === 0 ? packageMode(m, b, h) : packageMode(m, done),
              ),
            },
          ]),
        );
      },
    },
    area: {
      outcomes: {
        completed: { stopped: null },
        unanalysed: { stopped: null, unparsed: true },
        "limit work": { stopped: "work" },
        "limit depth": { stopped: "read-depth" },
        "threw f": { stopped: null, thrown: "f" },
        "threw g": { stopped: null, thrown: "g" },
      },
      summary: (b, h) => {
        const runs = ["src-on", "src-off", "rev-on", "rev-off"].map((mode, i) => ({
          mode,
          check: "publication",
          work: [300, 300],
          allowance: [1000, 1000],
          stopped: i === 0 ? [b.stopped, h.stopped] : [null, null],
          unparsed: i === 0 ? [b.unparsed === true, h.unparsed === true] : [false, false],
        }));
        const thrown = Object.fromEntries(
          [
            ["base", b],
            ["head", h],
          ]
            .filter(([, o]) => o.thrown !== undefined)
            .map(([tree, o]) => [
              tree,
              `TypeError: m\n    at ${o.thrown} (file:///t/${tree}/dist/src/x.js:3:9)`,
            ]),
        );
        const exceptions = Object.keys(thrown).length;
        return partSummary(
          areaSources(
            [
              {
                work: {
                  area: "x",
                  configuration: { checks: { g: ["publication"] }, allowances: [null] },
                },
              },
              {
                generator: "g",
                source: "s",
                runs,
                counts: exceptions > 0 ? { exceptions: 1 } : {},
              },
            ],
            exceptions > 0
              ? [{ generator: "g", source: "s", mode: "src-on", check: "publication", thrown }]
              : [],
          ),
        );
      },
    },
  };
  for (const [form, { outcomes, summary }] of Object.entries(forms))
    for (const [b, base] of Object.entries(outcomes))
      for (const [h, head] of Object.entries(outcomes)) {
        const s = summary(base, head);
        const at = `${form}: ${b} against ${h}`;
        if (b === h) {
          assert.deepEqual([s.moved, s.differences], [[], []], at);
          // (the route's form: the analysis completed in every case, its route result compared or counted apart)
          assert.equal(s.completed, form === "route" || b === "completed" ? 1 : 0, at);
        } else {
          assert.equal(s.moved.length, 1, at);
          assert.equal(s.completed, form === "route" ? 1 : 0, at);
        }
      }
});

test("evidence: in each record form, a source not run once in each mode it owes is uncompared, never completed", () => {
  const AREA = ["src-on", "src-off", "rev-on", "rev-off"];
  // (the mode lists a record can hold: whole, one missing, one twice in a mode's place, one foreign)
  const lists = (names) => ({
    whole: names,
    missing: names.slice(1),
    repeated: [names[0], ...names.slice(0, -1)],
    foreign: [...names.slice(0, -1), "sideways"],
  });
  const area = (labels, checks = ["publication"]) =>
    areaSources(
      [
        { work: { area: "x", configuration: { checks: { g: checks }, allowances: [null, 64] } } },
        {
          generator: "g",
          source: "s",
          runs: labels.map(([mode, check]) => ({
            mode,
            check,
            work: [1, 1],
            allowance: [1000, 1000],
            stopped: [null, null],
            unparsed: [false, false],
          })),
          counts: {},
        },
      ],
      [],
    )[0];
  for (const [kind, names] of Object.entries(lists(MODE_NAMES))) {
    const expected = kind === "whole" ? "completed" : "uncompared";
    const set = setSources([{ name: "s", modes: names.map((m) => setMode(m)) }])[0];
    const pkg = packageSources([
      { name: "s", root: 0, files: 1, differing: 0, modes: names.map((m) => packageMode(m)) },
    ])[0];
    assert.deepEqual([set.base, set.head, pkg.base, pkg.head], Array(4).fill(expected), kind);
  }
  for (const [kind, modes] of Object.entries(lists(AREA))) {
    const s = area(modes.map((mode) => [mode, "publication"]));
    assert.deepEqual(
      [s.base, s.head],
      Array(2).fill(kind === "whole" ? "completed" : "uncompared"),
      kind,
    );
  }
  // (a stops check owes a run at each allowance in each mode; a check the header does not name is not owed)
  const stops = AREA.flatMap((mode) => [
    [mode, "publication"],
    [mode, "stops natural"],
    [mode, "stops 64"],
  ]);
  assert.equal(area(stops, ["publication", "stops"]).base, "completed");
  assert.equal(
    area(
      stops.filter(([, check]) => check !== "stops 64"),
      ["publication", "stops"],
    ).base,
    "uncompared",
  );
  assert.equal(area(stops, ["publication"]).base, "uncompared");
  // (a header that names no checks for the generator owes nothing knowable: uncompared)
  assert.equal(
    area(
      AREA.map((mode) => [mode, "publication"]),
      null,
    ).base,
    "uncompared",
  );
});
