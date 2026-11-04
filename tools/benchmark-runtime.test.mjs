// The runtime benchmark's own checks (#1693), on a stub runtime whose behaviour each test sets: every kind of change
// the benchmark exists to catch must fail it, a format revision alone must not, and CPU must never fail it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  UsageError,
  formatBaseline,
  main,
  stateDigest,
  summarizeCpu,
} from "./benchmark-runtime.mjs";

// A stub `dist/`: a "source" is the JSON of its steps; `mutation` changes what the runtime does with them.
const stubRuntime = (mutation) => `const mutation = ${JSON.stringify(mutation)};
const steps = (plan) => {
  let list = structuredClone(plan.steps);
  if (mutation.at !== undefined) Object.assign(list[mutation.at], mutation.set);
  if (mutation.swapRng) {
    const [a, b] = mutation.swapRng;
    [list[a].rng, list[b].rng] = [list[b].rng, list[a].rng];
  }
  if (mutation.drop !== undefined) list.splice(mutation.drop, 1);
  if (mutation.append) list = [...list.slice(0, -1), mutation.append, list.at(-1)];
  return list;
};
export const calls = { created: 0 };
class Session {
  constructor(plan, index, dropped = null) {
    this.plan = plan;
    this.steps = steps(plan);
    if (mutation.differentFrom !== undefined && calls.created > mutation.differentFrom)
      this.steps[0].events = [{ kind: "notice" }];
    this.index = index;
    this.dropped = dropped;
  }
  operate(op) {
    const step = this.steps[++this.index];
    if (step?.op !== op) throw new Error("stub: no " + op + " at " + this.index);
    return { instructionsExecuted: step.instructions, events: step.events };
  }
  stepToEvent() { return this.operate("step"); }
  observeTime() { return this.operate("observe"); }
  exportSnapshot() {
    const step = this.steps[this.index] ?? { status: "running", rng: { state: 1 }, state: {} };
    const state = { ...step.state };
    if (this.dropped) delete state[this.dropped];
    return { format: "stub", version: mutation.version ?? 1, status: step.status, rng: step.rng,
      foregroundAction: step.status === "waiting" ? { deadlineMs: 1 } : null, ...state };
  }
  exportCheckpoint() { return { plan: this.plan, index: this.index }; }
}
export const compileSource = (source) => ({ plan: JSON.parse(source), diagnostics: [] });
export const createFreshRuntimeSession = (plan) => {
  calls.created++;
  return new Session(plan, -1);
};
export const deserializeRuntimeSession = (json) => {
  const { plan, index } = JSON.parse(json);
  return new Session(plan, index, mutation.restoreDrops ?? null);
};
`;

const say = (text) => ({ kind: "say", text });
const script = {
  steps: [
    {
      op: "step",
      instructions: 7,
      events: [say("first")],
      status: "running",
      rng: { state: 11 },
      state: { a: 1 },
    },
    {
      op: "step",
      instructions: 3,
      events: [],
      status: "waiting",
      rng: { state: 12 },
      state: { a: 2 },
    },
    {
      op: "observe",
      instructions: 1,
      events: [],
      status: "running",
      rng: { state: 12 },
      state: { a: 2 },
    },
    {
      op: "step",
      instructions: 5,
      events: [say("second")],
      status: "running",
      rng: { state: 13 },
      state: { a: 3 },
    },
    {
      op: "step",
      instructions: 2,
      events: [],
      status: "halted",
      rng: { state: 14 },
      state: { a: 4 },
    },
  ],
};
const source = `${JSON.stringify(script)}\n`;
const manifest = (extra = {}) => ({
  seed: 5,
  wallClockMs: 0,
  cases: [
    { name: "work", file: "work.tease", suite: true, units: 2, unit: "item", ...extra },
    { name: "probe", file: "work.tease", probe: true },
  ],
});

function setUp(t, { mutations = {}, manifestExtra } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-runtime-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "work.tease"), source);
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest(manifestExtra)));
  const dists = {};
  for (const [name, mutation] of Object.entries({ clean: {}, ...mutations })) {
    dists[name] = path.join(directory, `dist-${name}`);
    fs.mkdirSync(path.join(dists[name], "src"), { recursive: true });
    fs.writeFileSync(path.join(dists[name], "src", "index.js"), stubRuntime(mutation));
  }
  const run = async (...argv) => {
    const lines = [];
    const status = await main(argv, { directory, log: (line) => lines.push(line) });
    return { status, output: lines.join("\n") };
  };
  return { directory, dists, run };
}

async function withBaseline(t, options) {
  const setup = setUp(t, options);
  assert.equal(
    (await setup.run("--count-only", "--update", "--dist", setup.dists.clean)).status,
    0,
  );
  return setup;
}

test("an unchanged runtime equals its baseline, and the baseline keeps one line per cut", async (t) => {
  const { directory, dists, run } = await withBaseline(t);
  const result = await run("--count-only", "--dist", dists.clean);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /2 cases equal to the baseline/);
  assert.match(result.output, /^work: 18 instructions, 9 per item, halted/m);
  const text = fs.readFileSync(path.join(directory, "baseline.json"), "utf8");
  assert.equal(text, formatBaseline(JSON.parse(text)));
  assert.equal(
    text.split("\n").filter((line) => line.includes('"stateDigest"')).length,
    2 * script.steps.length,
  );
});

const changes = [
  [
    "one instruction more",
    { at: 3, set: { instructions: 6 } },
    /work: cut 4 \(step\) instructions 16 became 17/,
  ],
  [
    "two RNG states swapped",
    { swapRng: [0, 1] },
    /work: cut 1 \(step\) rng \{"state":11\} became \{"state":12\}/,
  ],
  [
    "a changed event",
    { at: 3, set: { events: [say("other")] } },
    /work: cut 4 \(step\) eventsDigest/,
  ],
  [
    "a changed status",
    { at: 4, set: { status: "failed" } },
    /work: cut 5 \(step\) status halted became failed/,
  ],
  ["a changed binding", { at: 1, set: { state: { a: 9 } } }, /work: cut 2 \(step\) stateDigest/],
  ["a missing cut", { drop: 3 }, /work: 5 cuts became 4 \(cut 5 is gone\)/],
  [
    "an extra cut",
    {
      append: {
        op: "step",
        instructions: 0,
        events: [say("x")],
        status: "running",
        rng: { state: 14 },
        state: {},
      },
    },
    /work: 5 cuts became 6 \(cut 6 is new\)/,
  ],
];

for (const [name, mutation, expected] of changes)
  test(`${name} fails the count check until the baseline is updated`, async (t) => {
    const { dists, run } = await withBaseline(t, { mutations: { changed: mutation } });
    const result = await run("--count-only", "--dist", dists.changed);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, expected);
    assert.match(result.output, /--count-only --update/);
    assert.equal((await run("--count-only", "--update", "--dist", dists.changed)).status, 0);
    assert.equal((await run("--count-only", "--dist", dists.changed)).status, 0);
  });

test("a format revision alone does not move the state digest", async (t) => {
  const { dists, run } = await withBaseline(t, { mutations: { revised: { version: 2 } } });
  assert.equal((await run("--count-only", "--dist", dists.revised)).status, 0);
  assert.equal(
    stateDigest({ format: "a", version: 1, x: [1] }),
    stateDigest({ x: [1], version: 2, format: "b" }),
  );
  assert.notEqual(stateDigest({ x: [1] }), stateDigest({ x: [2] }));
});

test("a baseline case the manifest no longer has fails until --update removes it", async (t) => {
  const { directory, dists, run } = await withBaseline(t);
  const shorter = manifest();
  shorter.cases = shorter.cases.filter((entry) => entry.name !== "probe");
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(shorter));
  const result = await run("--count-only", "--dist", dists.clean);
  assert.equal(result.status, 1);
  assert.match(result.output, /probe: in the baseline but not in the manifest/);
  assert.equal((await run("--count-only", "--update", "--dist", dists.clean)).status, 0);
  assert.equal((await run("--count-only", "--dist", dists.clean)).status, 0);
});

test("a changed source fails with both hashes", async (t) => {
  const { directory, dists, run } = await withBaseline(t);
  fs.writeFileSync(path.join(directory, "work.tease"), `${source}\n`);
  const result = await run("--count-only", "--dist", dists.clean);
  assert.equal(result.status, 1);
  assert.match(result.output, /work: source sha256 [0-9a-f]{64} became [0-9a-f]{64}/);
});

test("a text the manifest states holds whatever the baseline says, and blocks an update", async (t) => {
  const { directory, dists, run } = await withBaseline(t, {
    mutations: { changed: { at: 0, set: { events: [{ kind: "notice" }] } } },
    manifestExtra: { said: ["first", "second"] },
  });
  const before = fs.readFileSync(path.join(directory, "baseline.json"), "utf8");
  const result = await run("--count-only", "--update", "--dist", dists.changed);
  assert.equal(result.status, 1);
  assert.match(result.output, /work: says \["second"\], the manifest states \["first","second"\]/);
  assert.equal(fs.readFileSync(path.join(directory, "baseline.json"), "utf8"), before);
});

test("a probe restored from checkpoint JSON at every cut must export the same snapshot", async (t) => {
  const { dists, run } = await withBaseline(t, { mutations: { lossy: { restoreDrops: "a" } } });
  const result = await run("--count-only", "--update", "--dist", dists.lossy);
  assert.equal(result.status, 1);
  assert.match(result.output, /probe: the session restored at cut 1 exports another snapshot/);
  assert.match(result.output, /probe restored at every cut: cut 2 \(step\) stateDigest/);
  assert.doesNotMatch(result.output, /work: the session restored/);
});

test("--cpu reports interleaved samples and never fails on CPU", async (t) => {
  const { directory, dists, run } = setUp(t, { mutations: { same: {} } });
  const out = path.join(directory, "cpu");
  const result = await run(
    "--cpu",
    "--base",
    dists.clean,
    "--candidate",
    dists.same,
    "--out",
    out,
    "--rounds",
    "3",
    "--warmups",
    "1",
    "--batch",
    "2",
  );
  assert.equal(result.status, 0, result.output);
  const samples = fs
    .readFileSync(path.join(out, "samples.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(samples.length, 4 * 2, "the probe is not timed; four rounds of two builds");
  assert.deepEqual(
    samples.map((sample) => sample.build),
    ["base", "candidate", "candidate", "base", "base", "candidate", "candidate", "base"],
  );
  assert.ok(samples.every((sample) => sample.instructions === 36 && sample.executions === 2));
  const summary = JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8"));
  assert.equal(summary.cases.work.builds.candidate.instructionsPerUnit, 9);
  assert.equal(summary.cases.work.pairedSpeed.n, 3);
});

test("--cpu times nothing when the candidate differs from the base at a cut", async (t) => {
  const { directory, dists, run } = setUp(t, {
    mutations: { changed: { at: 1, set: { rng: { state: 99 } } } },
  });
  const out = path.join(directory, "cpu");
  const result = await run(
    "--cpu",
    "--base",
    dists.clean,
    "--candidate",
    dists.changed,
    "--out",
    out,
  );
  assert.equal(result.status, 1);
  assert.match(result.output, /work \(candidate against base\): cut 2 \(step\) rng/);
  assert.equal(fs.readFileSync(path.join(out, "samples.jsonl"), "utf8"), "");
  assert.equal(fs.existsSync(path.join(out, "summary.json")), false);
  const stub = await import(pathToFileURL(path.join(dists.changed, "src", "index.js")).href);
  assert.equal(
    stub.calls.created,
    1,
    "the candidate ran once, untimed, before the difference stopped it",
  );
});

test("a failed --cpu run leaves no earlier summary in its output folder", async (t) => {
  const { directory, dists, run } = setUp(t, {
    mutations: { changed: { at: 1, set: { rng: { state: 99 } } } },
  });
  const out = path.join(directory, "cpu");
  const quick = ["--out", out, "--rounds", "1", "--warmups", "0", "--batch", "1"];
  assert.equal(
    (await run("--cpu", "--base", dists.clean, "--candidate", dists.clean, ...quick)).status,
    0,
  );
  assert.equal(fs.existsSync(path.join(out, "summary.json")), true);
  assert.equal(
    (await run("--cpu", "--base", dists.clean, "--candidate", dists.changed, ...quick)).status,
    1,
  );
  assert.equal(fs.existsSync(path.join(out, "summary.json")), false);
});

test("--cpu accepts a candidate whose instruction counts differ", async (t) => {
  const { directory, dists, run } = setUp(t, {
    mutations: { fewer: { at: 0, set: { instructions: 1 } } },
  });
  const result = await run(
    "--cpu",
    "--base",
    dists.clean,
    "--candidate",
    dists.fewer,
    "--out",
    path.join(directory, "cpu"),
    "--rounds",
    "1",
    "--warmups",
    "0",
    "--batch",
    "1",
  );
  assert.equal(result.status, 0, result.output);
});

test("--cpu checks every timed run against its build's untimed record", async (t) => {
  const { directory, dists, run } = setUp(t, { mutations: { later: { differentFrom: 1 } } });
  const out = path.join(directory, "cpu");
  const result = await run(
    "--cpu",
    "--base",
    dists.clean,
    "--candidate",
    dists.later,
    "--out",
    out,
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /work \(candidate, timed round -3\): cut 1 \(step\) eventsDigest/);
  assert.equal(fs.existsSync(path.join(out, "summary.json")), false);
});

test("the CPU summary pairs matching rounds and takes the suite's geometric mean of their medians", () => {
  const row = (name, build, round, cpuUs, suite = true) => ({
    name,
    build,
    round,
    cpuUs,
    executions: 2,
    instructions: 200,
    units: 4,
    suite,
  });
  const summary = summarizeCpu(
    [
      row("a", "base", -1, 1000),
      row("a", "candidate", -1, 1),
      row("a", "base", 0, 400),
      row("a", "candidate", 0, 200),
      row("a", "base", 1, 300),
      row("a", "candidate", 1, 300),
      row("a", "base", 2, 900),
      row("a", "candidate", 2, 200),
      row("b", "base", 0, 800),
      row("b", "candidate", 0, 100),
      row("c", "base", 0, 100),
      row("c", "candidate", 0, 900, false),
    ].map((sample) => (sample.name === "c" ? { ...sample, suite: false } : sample)),
  );
  assert.deepEqual(summary.cases.a.pairedSpeed, { median: 2, min: 1, max: 4.5, n: 3 });
  assert.deepEqual(summary.cases.a.builds.base.cpuUsPerExecution, {
    median: 200,
    min: 150,
    max: 450,
    n: 3,
  });
  assert.equal(summary.cases.a.builds.base.cpuUsPerUnit.median, 50);
  assert.equal(summary.cases.a.builds.base.cpuNsPerInstruction.median, 2000);
  assert.equal(summary.suiteCases, 2);
  assert.ok(Math.abs(summary.suiteGeometricMeanOfPairedMedians - 4) < 1e-12);
});

test("malformed arguments are usage errors", async (t) => {
  const { dists, run } = setUp(t);
  for (const argv of [
    [],
    ["--count-only", "--cpu"],
    ["--count-only", "--wrong"],
    ["--cpu", "--base", dists.clean],
    ["--count-only", "--cases", "nothing"],
    ["--count-only", "--dist"],
    ["--cpu", "--rounds", "x"],
  ])
    await assert.rejects(run(...argv), UsageError, JSON.stringify(argv));
});
