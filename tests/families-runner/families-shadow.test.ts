import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const tool = resolve("tests/families/shadow.mjs");

/**
 * A built tree's modules as the shadow comparison loads them. Each compile analyses its source with the route's backend
 * and plans `[source]`; the legacy analysis exhausts the heap for `crash` in the third mode (in any worker) and for
 * `leak` in the first mode in a worker that compiled before (a fresh one compiles it); for `idle` in the first
 * mode, the legacy route's worker throws 50 ms after its outcome, while the core's run waits 300 ms; for `late` in the first
 * mode, it throws 200 ms after its outcome, holding the next run's request unread; the core reads one decision of `outside` and leaves the slice there;
 * the legacy analysis of `abort` aborts its process in the first mode; the core's of `costly` charges 100 units against an
 * allowance of 10 there; `noisy` writes stderr text without a newline before its analysis, whose legacy route then
 * exhausts the heap there; `large` plans 1 MB and its legacy route throws right after its outcome; `block` (an area of
 * its own) writes the file `SHADOW_BLOCKING` names, then waits 10 s in its legacy analysis.
 */
const MODULES: Record<string, string> = {
  "src/type-inference/core/budget.js": "export class WorkLedger { charge() {} }\n",
  "src/type-inference/core/consumers.js":
    "export class Consumers {\n  check() {}\n  receive(again) {\n    return again();\n  }\n}\n",
  "src/type-inference/core/backend.js": `import { Consumers } from "./consumers.js";
import { WorkLedger } from "./budget.js";
export const CORE_BACKEND = {
  name: "core",
  analyze(request) {
    const mode = globalThis.shadowMode;
    if (request.files[0].source === "idle" && !mode.reversed && !mode.unshared)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    const consumers = new Consumers();
    consumers.check();
    consumers.receive(() => null);
    if (request.files[0].source === "costly" && !mode.reversed && !mode.unshared) {
      const ledger = new WorkLedger();
      ledger.allowance = 10;
      ledger.charge("steps", 100);
    }
    return { checked: { runtimeChecks: new Map(), formShapes: new Map(), storageTypes: [], coreChecks: null } };
  },
};
`,
  "src/type-inference/legacy-rounds.js": `import { writeFileSync } from "node:fs";
let compiled = 0;
const exhaust = () => {
  const held = [];
  for (;;) held.push(new Array(100000).fill(held.length));
};
export const LEGACY_BACKEND = {
  name: "legacy",
  analyze(request) {
    const { source } = request.files[0];
    const mode = globalThis.shadowMode;
    if (source === "crash" && mode.reversed && !mode.unshared) exhaust();
    if (source === "abort" && !mode.reversed && !mode.unshared) process.abort();
    if (source === "noisy" && !mode.reversed && !mode.unshared) exhaust();
    if (source === "large" && !mode.reversed && !mode.unshared)
      queueMicrotask(() => {
        throw new Error("large worker error");
      });
    if (source === "block") {
      writeFileSync(process.env.SHADOW_BLOCKING, "");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    }
    if (source === "leak" && !mode.reversed && !mode.unshared && compiled > 0) exhaust();
    if (source === "idle" && !mode.reversed && !mode.unshared)
      setTimeout(() => {
        throw new Error("idle worker error");
      }, 50);
    if (source === "late" && !mode.reversed && !mode.unshared)
      queueMicrotask(() => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        throw new Error("late worker error");
      });
    compiled += 1;
    return { checked: { runtimeChecks: new Map(), formShapes: new Map(), storageTypes: [], coreChecks: null } };
  },
};
`,
  "src/compiler.js": `import { writeSync } from "node:fs";
import { LEGACY_BACKEND } from "./type-inference/legacy-rounds.js";
export function compileProjectWithBackend(files, options, backend) {
  // (stderr text without a newline before the analysis begins)
  if (files[0].source === "noisy") writeSync(2, "a diagnostic without a newline");
  const program = { kind: "program", span: { start: { offset: 0 }, end: { offset: 1 } } };
  (backend ?? LEGACY_BACKEND).analyze({ files: [{ path: "main.tease", program, source: files[0].source }] });
  return { plan: { instructions: [files[0].source === "large" ? "x".repeat(1 << 20) : files[0].source] }, diagnostics: [] };
}
`,
  "tests/helpers/type-core-oracles.js": `import { compileProjectWithBackend } from "../../src/compiler.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
export const MODES = [false, true].flatMap((reversed) => [false, true].map((unshared) => ({ reversed, unshared })));
export function inMode(mode, run) {
  globalThis.shadowMode = mode;
  return run();
}
export const jsonText = (value) => JSON.stringify(value);
export function decisionRecords(files, globals, { mode, demand }) {
  const { plan, diagnostics } = inMode(mode, () => compileProjectWithBackend(files, { globals }, CORE_BACKEND));
  if (demand !== undefined)
    return { text: JSON.stringify({ plan, diagnostics }), ordinary: [[{ key: 1 }]], completion: [[{ key: demand }]] };
  if (files[0].source === "outside")
    return { text: JSON.stringify({ outside: "this construct" }), ordinary: [[{ key: 1 }]], completion: [] };
  return { text: JSON.stringify({ plan, diagnostics }), ordinary: [[]], completion: [] };
}
`,
};

test("the shadow comparison keeps a crashed route's partial record, retries a reused worker's crash once, and goes on (#1704)", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-shadow-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(MODULES)) {
    mkdirSync(join(folder, "dist", file, ".."), { recursive: true });
    writeFileSync(join(folder, "dist", file), text);
  }
  writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
  mkdirSync(join(folder, "tests", "families", "area"), { recursive: true });
  cpSync(resolve("tests/families/sources.mjs"), join(folder, "tests/families/sources.mjs"));
  writeFileSync(
    join(folder, "tests/families/area/cases.mjs"),
    `export const cases = ${JSON.stringify(["fine", "leak", "crash", "after", "outside", "idle", "late", "abort", "costly", "noisy", "large"].map((s) => [s, s]))};\n`,
  );
  const out = join(folder, "shadow.jsonl");
  const decisions = join(folder, "decisions.jsonl");
  const shadow = (nodeOptions?: string, to = out, decided = decisions) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    return spawnSync(
      process.execPath,
      [tool, folder, "area", "--memory", "16", "--out", to, "--decisions", decided],
      { encoding: "utf8", env },
    );
  };
  const ran = shadow();
  assert.equal(ran.status, 1, ran.stderr);
  const recordsOf = (file: string) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const records = recordsOf(out);
  // (a caller's NODE_OPTIONS reaches no route, as the queue's heap flag would: a large heap and the semi-space flag,
  // which alone moved a route's limit while routes inherited it (#2329), give the same records, each heap failure at
  // --memory's limit)
  const optioned = shadow(
    "--max-old-space-size=4096 --max-semi-space-size=64",
    join(folder, "optioned.jsonl"),
    join(folder, "optioned-decisions.jsonl"),
  );
  assert.equal(optioned.status, 1, optioned.stderr);
  assert.deepEqual(recordsOf(join(folder, "optioned.jsonl")), records);
  assert.deepEqual(
    records.map((r) => r.name),
    [
      "fine",
      "leak",
      "crash",
      "after",
      "outside",
      "idle",
      "late",
      "abort",
      "costly",
      "noisy",
      "large",
    ].map((name) => `cases.mjs/${name}`),
  );
  const [fine, leak, crash, after, outside, idle, late, abort, costly, noisy, large] = records;
  // (stderr text without a newline before a mark leaves the mark readable: the heap failure is still in analysis)
  assert.deepEqual(
    noisy.failed.map((f: Record<string, unknown>) => [f.route, f.mode, f.failure, f.phase]),
    [["legacy", 0, "heap", "analysis"]],
  );
  // (a large outcome sent just before an error ends the process is kept: the parent replaces the process after it)
  assert.equal(large.incomplete, undefined);
  assert.equal(large.rows[0].legacy.outcome, "plan");
  // (a run past the unit limit: its process ends at once, the units it had charged and the allowance recorded)
  assert.deepEqual(
    costly.failed.map((f: Record<string, unknown>) => [
      f.route,
      f.mode,
      f.failure,
      f.units,
      f.allowance,
    ]),
    [["core", 0, "units", 100, 10]],
  );
  // (a route's process that ends itself (here `process.abort()` in the legacy analysis) ends that run only, recorded
  // with how it ended; the source's other runs and the next sources go on (#1738: a worker thread's abort ended the
  // whole runner, cutting a gate shard short))
  assert.equal(abort.incomplete, true);
  assert.deepEqual(
    abort.failed.map((f: { failure: string; phase: string }) => [f.failure, f.phase]),
    [["worker exit SIGABRT", "analysis"]],
  );
  assert.deepEqual(
    abort.rows.map((row: { legacy: { outcome: string }; core: { outcome: string } }) => [
      row.legacy.outcome,
      row.core.outcome,
    ]),
    [
      ["failed", "plan"],
      ["plan", "plan"],
      ["plan", "plan"],
      ["plan", "plan"],
    ],
  );
  // (outside the slice: the core's decisions kept with its outcome, as compare.mjs kept them, and no delta)
  for (const row of outside.rows) {
    assert.equal(row.legacy.outcome, "plan");
    assert.deepEqual(
      [row.core.outcome, row.core.outside, row.core.decisionCounts, row.delta],
      ["outside", "this construct", { ordinary: [1], completion: [] }, undefined],
    );
  }
  const kept = readFileSync(decisions, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((line) => line.key === outside.key);
  assert.deepEqual(
    kept.decisions.map((d: { ordinary: unknown }) => d.ordinary),
    [0, 1, 2, 3].map(() => [[{ key: 1 }]]),
  );
  for (const record of [fine, leak, after, idle, late]) {
    assert.equal(record.incomplete, undefined, record.name);
    assert.equal(record.rows.length, 4);
    for (const row of record.rows) {
      for (const route of ["legacy", "core"]) assert.equal(row[route].outcome, "plan", record.name);
      assert.deepEqual(row.delta, {
        diagnosticIdentity: false,
        diagnosticText: false,
        checks: false,
        plan: false,
      });
    }
  }
  // (the reused worker's crash, retried in a fresh one: the fresh one's result, the first failure named, with the heap
  // limit the worker measured, V8's: its 16 MB old generation and the other spaces)
  const limit = leak.rows[0].legacy.retried.heapMiB;
  // (the heap limit is --memory's, not Node's default)
  assert.ok(limit > 16 && limit < 256, String(limit));
  assert.deepEqual(leak.rows[0].legacy.retried, {
    route: "legacy",
    mode: 0,
    phase: "analysis",
    failure: "heap",
    runsBeforeFailure: 4,
    heapMiB: limit,
  });
  // (a crash that repeats in the fresh worker: recorded once, as the fresh worker's; the core's run and every other
  // mode kept)
  const failure = {
    route: "legacy",
    mode: 2,
    phase: "analysis",
    failure: "heap",
    runsBeforeFailure: 0,
    heapMiB: limit,
  };
  assert.equal(crash.incomplete, true);
  assert.deepEqual(crash.failed, [failure]);
  assert.equal(crash.reason, "legacy mode 2: heap in analysis");
  assert.deepEqual(
    crash.rows.map((row: { legacy: { outcome: string }; core: { outcome: string } }) => [
      row.legacy.outcome,
      row.core.outcome,
    ]),
    [
      ["plan", "plan"],
      ["plan", "plan"],
      ["failed", "plan"],
      ["plan", "plan"],
    ],
  );
  assert.equal(crash.rows[2].delta, undefined);
  assert.equal(crash.rows[2].legacy.retried.runsBeforeFailure, 6);
  const counted = (stdout: string) => {
    const { resumed, runs, failed, retried, replaced, incomplete } = JSON.parse(stdout.trim());
    return { resumed, runs, failed, retried, replaced, incomplete };
  };
  // (each worker that threw after its outcome, between runs or as the next run waited, was replaced, its outcome kept)
  const recorded = { runs: 88, failed: 4, retried: 3, incomplete: 4 };
  assert.deepEqual(counted(ran.stdout), { ...recorded, resumed: 0, replaced: 3 });
  // (again with the same --out: nothing runs again, and the recorded failure still counts)
  const again = shadow();
  assert.equal(again.status, 1, again.stderr);
  assert.deepEqual(counted(again.stdout), { ...recorded, resumed: 11, replaced: 0 });
  assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 11);

  // (--manifest: the sources these options owe, the keys shadow-classify.mjs's --expect reads)
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const manifest = spawnSync(process.execPath, [tool, folder, "area", "--manifest"], {
    encoding: "utf8",
    env,
  });
  assert.equal(manifest.status, 0, manifest.stderr);
  assert.deepEqual(
    manifest.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    records.map((r) => ({ key: r.key, name: r.name })),
  );
  // (the classifier reads these records: the crash's mode is the legacy route's heap in its analysis with the core
  // finished; 'this construct' is an exclusion text no taxonomy version lists, so its four pairs fail the run)
  const C = await import(pathToFileURL(resolve("tests/families/shadow-classify.mjs")).href);
  const classified = C.classifyRecords(
    records.map((record) => ({ record, bytes: 0, where: record.name })),
    new Set(records.map((r) => r.key)),
  );
  assert.deepEqual(
    classified.perPair
      .filter((p: { class: string }) => p.class !== "agree")
      .map((p: { name: string; class: string }) => [p.name, p.class]),
    [
      ["cases.mjs/crash", "failed/legacy-heap"],
      ["cases.mjs/abort", "failed/other"],
      ["cases.mjs/costly", "failed/other"],
      ["cases.mjs/noisy", "failed/legacy-heap"],
    ],
  );
  assert.deepEqual(
    classified.problems.map((p: { problem: string; name: string }) => [p.problem, p.name]),
    [0, 1, 2, 3].map(() => ["unclassified", "cases.mjs/outside"]),
  );

  // (--demands 16: the core alone at that demand allowance in the four modes, for the gate's completion control)
  const only = join(folder, "only.json");
  writeFileSync(only, JSON.stringify(["cases.mjs/fine"]));
  const controlled = join(folder, "control.jsonl");
  const withControl = (...extra: string[]) =>
    spawnSync(
      process.execPath,
      [tool, folder, "area", "--memory", "16", "--only", only, "--out", controlled, ...extra],
      { encoding: "utf8", env },
    );
  assert.equal(withControl("--demands", "0").status, 2);
  const ran16 = withControl("--demands", "16");
  assert.equal(ran16.status, 0, ran16.stderr);
  assert.equal(JSON.parse(ran16.stdout.trim()).runs, 12);
  const [fineControlled] = readFileSync(controlled, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    fineControlled.demands.map(
      (d: {
        demand: number;
        rows: Array<{ mode: unknown; core: { outcome: string; decisionCounts: unknown } }>;
      }) => ({
        demand: d.demand,
        rows: d.rows.map((row) => [row.mode, row.core.outcome, row.core.decisionCounts]),
      }),
    ),
    [
      {
        demand: 16,
        rows: [0, 1, 2, 3].map((m) => [
          { reversed: m >= 2, unshared: m % 2 === 1 },
          "plan",
          { ordinary: [1], completion: [1] },
        ]),
      },
    ],
  );
  // (the classifier counts the control's completions; the gate's coverage row also needs the natural runs' ordinary
  // decisions, which this fake source has none of)
  const { coverage } = C.classifyRecords([{ record: fineControlled, bytes: 0, where: "control" }]);
  assert.deepEqual([coverage.controlRuns, coverage.controlCompletionRuns], [4, 4]);

  // (the runner killed while a route's process blocks in its compile: that process ends too, its own thread watching
  // the parent, since a blocked event loop never hears the parent go)
  mkdirSync(join(folder, "tests", "families", "blocked"), { recursive: true });
  writeFileSync(
    join(folder, "tests/families/blocked/cases.mjs"),
    'export const cases = [["block", "block"]];\n',
  );
  const blocking = join(folder, "blocking");
  const runner = spawn(process.execPath, [tool, folder, "blocked", "--memory", "16"], {
    env: { ...env, SHADOW_BLOCKING: blocking },
    stdio: "ignore",
  });
  const childrenOf = (pid: number) =>
    readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .filter((name) => {
        try {
          return (
            readFileSync(`/proc/${name}/stat`, "utf8").split(") ")[1]?.split(" ")[1] === String(pid)
          );
        } catch {
          return false;
        }
      })
      .map(Number);
  // (inside the blocking compile, which marks its start: a fixed wait would let a slow load meet an idle route, which
  // ends on the parent's disconnect without its watcher, #1854; 30 s is only a safety net)
  for (let tries = 0; tries < 600 && !existsSync(blocking); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(blocking), "a route's process entered the blocking compile");
  const routes = childrenOf(runner.pid!);
  assert.ok(routes.length > 0, "the runner started a route's process");
  runner.kill("SIGKILL");
  // (a process that ended, reaped or not yet)
  const alive = (pid: number) => {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
    } catch {
      return false;
    }
  };
  for (let tries = 0; tries < 40 && routes.some(alive); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(routes.filter(alive), []);
});
