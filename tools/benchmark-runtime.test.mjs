// The runtime benchmark's own checks (#1693), on a stub runtime whose behaviour each test sets: every kind of change
// the benchmark exists to catch must fail it, a format revision alone must not, and CPU must never fail it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  UsageError,
  canonicalJson,
  formatBaseline,
  loadTape,
  main,
  sha256,
  stateDigest,
  summarizeCpu,
  TapeMismatch,
  checkedHostSession,
  prepareTape,
  tapeGuards,
  tapeHostCall,
  tapeRun,
} from "./benchmark-runtime.mjs";
import * as references from "../benchmarks/runtime/references.mjs";

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
export const calls = { created: 0, runOptions: [] };
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
    return { instructionsExecuted: step.instructions, events: step.events,
      ...(step.outcome ? { outcome: { kind: step.outcome } } : {}) };
  }
  stepToEvent() { return this.operate("step"); }
  run(...args) { calls.runOptions.push(args); return this.operate("run"); }
  observeTime() { return this.operate("observe"); }
  completeAction() { return this.operate("complete"); }
  view() { return { runnable: this.steps[this.index]?.status === "running" }; }
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
export const compileProject = (files) => compileSource(files[0].source);
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

function setUp(t, { mutations = {}, manifestExtra, cases = null, files = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-runtime-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "work.tease"), source);
  for (const [file, text] of Object.entries(files))
    fs.writeFileSync(path.join(directory, file), text);
  const written = manifest(manifestExtra);
  if (cases) written.cases = cases;
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(written));
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

// A host case: the first answer is refused and leaves the session waiting, so the second follows without a drive.
const hostScript = {
  steps: [
    {
      op: "step",
      instructions: 4,
      events: [say("ask")],
      status: "waiting",
      rng: { state: 1 },
      state: { a: 1 },
    },
    {
      op: "complete",
      instructions: 0,
      events: [],
      status: "waiting",
      rng: { state: 1 },
      state: { a: 1 },
      outcome: "invalidPayload",
    },
    {
      op: "complete",
      instructions: 0,
      events: [],
      status: "running",
      rng: { state: 1 },
      state: { a: 2 },
      outcome: "completed",
    },
    {
      op: "step",
      instructions: 3,
      events: [say("done")],
      status: "halted",
      rng: { state: 1 },
      state: { a: 3 },
    },
  ],
};
const answer = (text, unit) => ({
  kind: "completeAction",
  args: [{ actionId: 1, payload: { kind: "submittedText", submittedText: text } }],
  ...(unit ? { unit: true } : {}),
});
const hostSetUp = (t, { tape = [answer("x"), answer("1", true)], units = 1, mutations } = {}) =>
  withBaseline(t, {
    mutations,
    cases: [{ name: "host", file: "host.tease", tape: "host.json", units, unit: "answer" }],
    files: { "host.tease": JSON.stringify(hostScript), "host.json": JSON.stringify(tape) },
  });

test("a tape's calls are cuts with their outcomes, and a changed outcome or tape fails", async (t) => {
  const { directory, dists, run } = await hostSetUp(t, {
    mutations: { stale: { at: 1, set: { outcome: "staleAction" } } },
  });
  const entry = JSON.parse(fs.readFileSync(path.join(directory, "baseline.json"), "utf8")).cases
    .host;
  assert.deepEqual(
    entry.cuts.map((cut) => cut.outcome ?? cut.kind),
    ["step", "invalidPayload", "completed", "step"],
  );
  assert.equal(entry.tapeSha256, sha256(JSON.stringify([answer("x"), answer("1", true)])));
  const stale = await run("--count-only", "--dist", dists.stale);
  assert.equal(stale.status, 1);
  assert.match(stale.output, /host: cut 2 \(host\) outcome invalidPayload became staleAction/);
  fs.writeFileSync(
    path.join(directory, "host.json"),
    JSON.stringify([answer("y"), answer("1", true)]),
  );
  const changed = await run("--count-only", "--dist", dists.clean);
  assert.equal(changed.status, 1);
  assert.match(changed.output, /host: tape sha256 [0-9a-f]{64} became [0-9a-f]{64}/);
});

test("a tape must be used up exactly when the session ends, and each unit must complete", async (t) => {
  for (const [options, expected] of [
    [
      { tape: [answer("x"), answer("1", true), answer("2")] },
      /host: the session halted with 1 tape entries left/,
    ],
    [
      { tape: [answer("x")], units: 0 },
      /host: the tape is used up while the session waits at cut 2/,
    ],
    [
      { mutations: { settled: { at: 2, set: { outcome: "alreadySettled" } } } },
      /host: tape entry 2, a unit, gave alreadySettled, not completed/,
    ],
  ]) {
    const { dists, run } = setUp(t, {
      mutations: options.mutations,
      cases: [
        {
          name: "host",
          file: "host.tease",
          tape: "host.json",
          units: options.units ?? 1,
          unit: "answer",
        },
      ],
      files: {
        "host.tease": JSON.stringify(hostScript),
        "host.json": JSON.stringify(options.tape ?? [answer("x"), answer("1", true)]),
      },
    });
    const result = await run("--count-only", "--update", "--dist", dists.settled ?? dists.clean);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, expected);
    assert.match(result.output, /baseline not updated/);
  }
});

test("--cpu times nothing when a build breaks a tape or a statement", async (t) => {
  const { directory, dists, run } = setUp(t, {
    cases: [{ name: "host", file: "host.tease", tape: "host.json", units: 1, unit: "answer" }],
    files: {
      "host.tease": JSON.stringify(hostScript),
      "host.json": JSON.stringify([answer("x"), answer("1", true), answer("2")]),
    },
  });
  const out = path.join(directory, "cpu");
  const result = await run(
    "--cpu",
    "--base",
    dists.clean,
    "--candidate",
    dists.clean,
    "--out",
    out,
  );
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /host: the session halted with 1 tape entries left \(base\)/);
  assert.equal(fs.readFileSync(path.join(out, "samples.jsonl"), "utf8"), "");
});

test('budget: "product" drives run without a budget, and a stated failure must hold', async (t) => {
  const failing = {
    steps: [
      {
        op: "run",
        instructions: 10,
        events: [say("x")],
        status: "failed",
        rng: { state: 1 },
        state: { failure: { code: "TSR037" } },
      },
    ],
  };
  const budgetCase = (instructions) => ({
    name: "budget",
    file: "budget.tease",
    budget: "product",
    failure: { code: "TSR037", instructions },
  });
  const { directory, dists, run } = await withBaseline(t, {
    cases: [budgetCase(10)],
    files: { "budget.tease": JSON.stringify(failing) },
  });
  const stub = await import(pathToFileURL(path.join(dists.clean, "src", "index.js")).href);
  assert.ok(stub.calls.runOptions.length > 0);
  assert.ok(
    stub.calls.runOptions.every((args) => args.length === 0),
    "run gets no instruction budget",
  );
  const entry = JSON.parse(fs.readFileSync(path.join(directory, "baseline.json"), "utf8")).cases
    .budget;
  assert.deepEqual(
    entry.cuts.map((cut) => cut.kind),
    ["run"],
  );
  const written = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  written.cases = [budgetCase(11)];
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(written));
  const result = await run("--count-only", "--dist", dists.clean);
  assert.equal(result.status, 1);
  assert.match(
    result.output,
    /budget: ends with \{"code":"TSR037","instructions":10\}, the manifest states \{"code":"TSR037","instructions":11\}/,
  );
});

// A stub session for the receipt checks: each host method records what it received and gives an outcome that never
// depends on it, so only the receipt check can tell calls apart; its `n`th `completeAction` asks the media store
// `questions(n)`.
function receivingSession(questions = () => [], received = []) {
  let completions = 0;
  const answer =
    (method) =>
    (...args) => {
      received.push([method, ...args]);
      if (method === "completeAction")
        for (const { reference, kind } of questions(completions++))
          args[1]?.capturedMedia?.holds(reference, kind);
      return { events: [], instructionsExecuted: 0, outcome: { kind: "completed" } };
    };
  return {
    received,
    completeAction: answer("completeAction"),
    updateInteraction: answer("updateInteraction"),
    observeTime: answer("observeTime"),
    reportMediaLoad: answer("reportMediaLoad"),
    pressPermanentButton: answer("pressPermanentButton"),
    setDebugMode: answer("setDebugMode"),
    fork() {
      return receivingSession(questions, received);
    },
    me() {
      return this;
    },
  };
}

const query = (reference) => ({ reference, kind: "file", result: true });
const entries = {
  completeAction: (n) => ({
    kind: "completeAction",
    args: [{ actionId: n, payload: { kind: "stored", references: [`r${n}`] } }],
    admissionQueries: [query(`r${n}`)],
  }),
  updateInteraction: (n) => ({
    kind: "updateInteraction",
    args: [{ actionId: n, update: { kind: "commit", fieldId: `f${n}` } }],
  }),
  observeTime: (n) => ({ kind: "observeTime", args: [n * 10, [{ mediaId: n }]] }),
  reportMediaLoad: (n) => ({
    kind: "reportMediaLoad",
    args: [n, { kind: "loaded", durationMs: n }],
  }),
  pressPermanentButton: (n) => ({ kind: "pressPermanentButton", args: [n] }),
};

/** This test's own dispatch of a host call to a session's method. */
function dispatch(session, call) {
  switch (call.kind) {
    case "completeAction":
      return session.completeAction(call.request, { capturedMedia: call.capturedMedia });
    case "updateInteraction":
      return session.updateInteraction(call.request);
    case "observeTime":
      return session.observeTime(call.nowMs, call.reports);
    case "reportMediaLoad":
      return session.reportMediaLoad(call.mediaId, call.report);
    case "pressPermanentButton":
      return session.pressPermanentButton(call.buttonId);
    case "setDebugMode":
      return session.setDebugMode(call.enabled);
  }
}

/**
 * Applies `tape` through one guarded stub session as the runner does, `change(call, index, entry)` giving the calls
 * made for each entry (none, one or two), and gives every problem.
 */
function receive(tape, { change = (call) => call, questions = () => [] } = {}) {
  const guards = tapeGuards(prepareTape(tape), "tape");
  const session = checkedHostSession(receivingSession(questions), guards.start(0));
  const interpreter = tapeRun(tape, "tape");
  const problems = [];
  for (let index = 0; index < tape.length; index++) {
    const entry = interpreter.next();
    for (const call of [change(interpreter.call(entry), index, entry)].flat())
      try {
        dispatch(session, call);
      } catch (error) {
        if (!(error instanceof TapeMismatch)) problems.push(String(error));
      }
  }
  return [...problems, ...guards.problems("halted")];
}

test("a guard checks each receipt's method and data arguments at entry, before the session runs it", () => {
  const tape = [
    entries.updateInteraction(1),
    entries.observeTime(2),
    entries.pressPermanentButton(3),
  ];
  const guards = tapeGuards(prepareTape(tape), "tape");
  const raw = receivingSession();
  const session = checkedHostSession(raw, guards.start(0));
  session.updateInteraction(tape[0].args[0], { debugTrace: "ignored" });
  session.observeTime(20, [{ mediaId: 2 }]);
  // r5's substitution: another method with an equal outcome is refused before the session receives it.
  assert.throws(
    () => session.updateInteraction({ actionId: 3, update: { kind: "select" } }),
    TapeMismatch,
  );
  assert.equal(raw.received.length, 2);
  assert.match(guards.problems("halted").join("\n"), /host call 3 is .*updateInteraction/);
  assert.match(guards.problems("halted").join("\n"), /the session halted with 1 tape entries left/);
  // Every other member is the session's own, bound to it.
  assert.equal(session.me(), raw);
});

test("a fork's guard starts where its parent stood and moves on its own; a placed guard starts at its cut", () => {
  const tape = [
    entries.pressPermanentButton(1),
    entries.pressPermanentButton(2),
    entries.pressPermanentButton(3),
  ];
  const guards = tapeGuards(prepareTape(tape), "tape");
  const parent = checkedHostSession(receivingSession(), guards.start(0));
  parent.pressPermanentButton(1);
  const fork = parent.fork();
  fork.pressPermanentButton(2);
  fork.pressPermanentButton(3);
  parent.pressPermanentButton(2);
  parent.pressPermanentButton(3);
  const pending = guards.start(null);
  const restored = checkedHostSession(receivingSession(), pending);
  pending.place(2);
  restored.pressPermanentButton(3);
  assert.deepEqual(guards.problems("halted"), []);
  // A restored session used before its place is known is refused.
  const unplaced = checkedHostSession(receivingSession(), guards.start(null));
  assert.throws(() => unplaced.pressPermanentButton(1), TapeMismatch);
});

// The readback family: every way a call can differ from its tape entry, at every position, for every method, must be
// a problem, though the stub session's outcome never tells the calls apart. The axes are declared once; a case's name
// is its axis values, and a coverage check derived from the names proves every axis value and valid pair is held.
const READBACK = {
  method: Object.keys(entries),
  mismatch: [
    "method",
    "untaped",
    "inserted",
    "argument",
    "omitted",
    "repeated",
    "question",
    "unasked",
    "surplus",
  ],
  position: ["first", "middle", "last"],
};
const mediaMismatches = new Set(["question", "unasked", "surplus"]);
const readbackCases = READBACK.method.flatMap((method) =>
  READBACK.mismatch.flatMap((mismatch) =>
    READBACK.position
      .filter(() => !mediaMismatches.has(mismatch) || method === "completeAction")
      .map((position) => ({
        method,
        mismatch,
        position,
        name: `${method}/${mismatch}/${position}`,
      })),
  ),
);

function readbackProblems({ method, mismatch, position }) {
  const tape = [1, 2, 3].map((n) => entries[method](n));
  const at = { first: 0, middle: 1, last: 2 }[position];
  const other = method === "pressPermanentButton" ? "updateInteraction" : "pressPermanentButton";
  const change = (call, index, entry) => {
    if (index !== at) return call;
    if (mismatch === "method") return tapeHostCall(entries[other](index + 1), call.capturedMedia);
    if (mismatch === "argument")
      return tapeHostCall(
        { ...entry, args: [{ changed: true }, ...entry.args.slice(1)] },
        call.capturedMedia,
      );
    if (mismatch === "untaped") return { kind: "setDebugMode", enabled: false };
    if (mismatch === "inserted") return [{ kind: "setDebugMode", enabled: false }, call];
    if (mismatch === "omitted") return [];
    if (mismatch === "repeated") return [call, call];
    return call;
  };
  // The stub asks what each entry recorded, but at the position of a media mismatch.
  const questions = (n) => {
    const recorded = tape[n]?.admissionQueries ?? [];
    if (n !== at) return recorded;
    if (mismatch === "question") return [query("other")];
    if (mismatch === "unasked") return [];
    if (mismatch === "surplus") return [...recorded, query("extra")];
    return recorded;
  };
  return receive(tape, { change, questions });
}

test("the readback family covers every axis value and every valid pair of its axes", () => {
  const named = readbackCases.map(({ name }) => {
    const [method, mismatch, position] = name.split("/");
    return { method, mismatch, position };
  });
  const pairs = (cases) =>
    new Set(
      cases.flatMap((item) =>
        ["method", "mismatch", "position"].flatMap((a, i, axes) =>
          axes.slice(i + 1).map((b) => `${a}=${item[a]}|${b}=${item[b]}`),
        ),
      ),
    );
  const valid = READBACK.method
    .flatMap((method) =>
      READBACK.mismatch.flatMap((mismatch) =>
        READBACK.position.map((position) => ({ method, mismatch, position })),
      ),
    )
    .filter(
      ({ method, mismatch }) => !mediaMismatches.has(mismatch) || method === "completeAction",
    );
  const covered = pairs(named);
  for (const pair of pairs(valid)) assert.ok(covered.has(pair), pair);
  for (const [axis, values] of Object.entries(READBACK))
    for (const value of values)
      assert.ok(
        named.some((item) => item[axis] === value),
        `${axis}=${value}`,
      );
});

test("every call that differs from its tape entry is a problem, and the tape applied as written is none", () => {
  for (const method of READBACK.method)
    assert.deepEqual(readbackProblems({ method, mismatch: "none", position: "first" }), [], method);
  const missed = readbackCases
    .filter((item) => readbackProblems(item).length === 0)
    .map(({ name }) => name);
  assert.deepEqual(missed, []);
});
test("malformed tapes, and a tape whose units differ from the manifest's, are usage errors", async (t) => {
  for (const tape of [
    {},
    [{ kind: "run", args: [] }],
    [{ kind: "completeAction", args: [], extra: 1 }],
    [{ kind: "completeAction", args: [], unit: false }],
    [{ kind: "observeTime", args: [1], admissionQueries: [] }],
  ])
    assert.throws(() => loadTape(JSON.stringify(tape), "tape"), UsageError, JSON.stringify(tape));
  const { dists, run } = setUp(t, {
    cases: [{ name: "host", file: "host.tease", tape: "host.json", units: 2, unit: "answer" }],
    files: {
      "host.tease": JSON.stringify(hostScript),
      "host.json": JSON.stringify([answer("1", true)]),
    },
  });
  await assert.rejects(
    run("--count-only", "--dist", dists.clean),
    /the tape marks 1 units, the manifest states 2/,
  );
});

// The #1797 workloads' statements against `benchmarks/runtime/references.mjs`, without any runtime: each text is
// computed from the fixture's own parameter and tape, and the cooperative Battleship's two counts agree.
test("every workload text the manifest states is its independent reference's", () => {
  const directory = fileURLToPath(new URL("../benchmarks/runtime/", import.meta.url));
  const read = (file) => fs.readFileSync(path.join(directory, file), "utf8");
  const cases = Object.fromEntries(
    JSON.parse(read("manifest.json")).cases.map((entry) => [entry.name, entry]),
  );
  const parameter = (file, name) =>
    Number(read(file).match(new RegExp(`^let ${name} = (\\d+)$`, "m"))[1]);
  const tape = (name) => JSON.parse(read(cases[name].tape));
  const stated = {
    "helper-input": references.helperInput(tape("helper-input")),
    "form-completion": references.formCompletion(tape("form-completion")),
    "storage-commit": references.storage(tape("storage-commit")),
    "storage-failed": references.storage(tape("storage-failed")),
    "file-store": references.fileStore(tape("file-store")),
    "transfer-project": references.transferProject(7),
    "collection-tail-10000": references.collectionTail(
      parameter("workloads/collection-tail-10000.tease", "size"),
    ),
  };
  for (const [name, said] of Object.entries(stated)) assert.deepEqual(cases[name].said, said, name);
  for (const name of ["text-tail-64k", "text-tail-300k"]) {
    const text = references.textTail(parameter(cases[name].file, "chunks"));
    assert.equal(cases[name].saidSha256, sha256(canonicalJson(text)), name);
    assert.equal(cases[name].units, [...text[1]].length, name);
  }
  assert.equal(
    cases["helper-input"].units,
    tape("helper-input").filter((call) => call.unit).length,
  );
  // The units of the cases without a tape: the items of the list, and the files the project entered.
  assert.equal(
    cases["collection-tail-10000"].units,
    parameter("workloads/collection-tail-10000.tease", "size"),
  );
  assert.equal(
    cases["transfer-project"].units,
    Number(stated["transfer-project"].at(-1).split(":")[1]),
  );
  const hub = read("workloads/transfer-project/hub.tease").match(/^if visits > (\d+) \{$/m);
  assert.equal(Number(hub[1]), 7, "transfer-project's reference takes the hub's last visit");
  const baseline = JSON.parse(read("baseline.json")).cases;
  for (const name of ["battleship-cooperative-150"]) {
    const [, placements, attempts] = baseline[name].said
      .at(-2)
      .match(/^placements:(\d+):attempts:(\d+)$/);
    assert.equal(Number(placements), parameter(cases[name].file, "nTries"), name);
    assert.equal(Number(placements), cases[name].units, name);
    assert.equal(
      baseline[name].cuts.filter((cut) => cut.kind === "observe").length,
      Math.floor(Number(attempts) / 1000),
      `${name}: one 10 ms rest per 1,000 placement attempts`,
    );
  }
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
