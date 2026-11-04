import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const tool = resolve("tests/families/shadow.mjs");

/**
 * A built tree's modules as the shadow comparison loads them. Each compile analyses its source with the route's backend
 * and plans `[source]`; the legacy analysis exhausts the heap for `crash` in the third mode (in any worker) and for
 * `leak` in the first mode in a worker that compiled before (a fresh one compiles it); for `idle`, the legacy
 * route's worker throws just after each outcome is posted; the core reads one decision of `outside` and leaves the slice there.
 */
const MODULES: Record<string, string> = {
  "src/type-inference/core/budget.js": "export class WorkLedger { charge() {} }\n",
  "src/type-inference/core/consumers.js":
    "export class Consumers {\n  check() {}\n  receive(again) {\n    return again();\n  }\n}\n",
  "src/type-inference/core/backend.js": `import { Consumers } from "./consumers.js";
export const CORE_BACKEND = {
  name: "core",
  analyze() {
    const consumers = new Consumers();
    consumers.check();
    consumers.receive(() => null);
    return { checked: { runtimeChecks: new Map(), formShapes: new Map(), storageTypes: [], coreChecks: null } };
  },
};
`,
  "src/type-inference/legacy-rounds.js": `let compiled = 0;
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
    if (source === "leak" && !mode.reversed && !mode.unshared && compiled > 0) exhaust();
    if (source === "idle")
      queueMicrotask(() => {
        throw new Error("idle worker error");
      });
    compiled += 1;
    return { checked: { runtimeChecks: new Map(), formShapes: new Map(), storageTypes: [], coreChecks: null } };
  },
};
`,
  "src/compiler.js": `import { LEGACY_BACKEND } from "./type-inference/legacy-rounds.js";
export function compileProjectWithBackend(files, options, backend) {
  const program = { kind: "program", span: { start: { offset: 0 }, end: { offset: 1 } } };
  (backend ?? LEGACY_BACKEND).analyze({ files: [{ path: "main.tease", program, source: files[0].source }] });
  return { plan: { instructions: [files[0].source] }, diagnostics: [] };
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
export function decisionRecords(files, globals, { mode }) {
  const { plan, diagnostics } = inMode(mode, () => compileProjectWithBackend(files, { globals }, CORE_BACKEND));
  if (files[0].source === "outside")
    return { text: JSON.stringify({ outside: "this construct" }), ordinary: [[{ key: 1 }]], completion: [] };
  return { text: JSON.stringify({ plan, diagnostics }), ordinary: [[]], completion: [] };
}
`,
};

test("the shadow comparison keeps a crashed route's partial record, retries a reused worker's crash once, and goes on (#1704)", (t) => {
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
    `export const cases = ${JSON.stringify(["fine", "leak", "crash", "after", "outside", "idle"].map((s) => [s, s]))};\n`,
  );
  const out = join(folder, "shadow.jsonl");
  // (a heap flag in NODE_OPTIONS, as the queue sets one, overrides no worker's --memory)
  const decisions = join(folder, "decisions.jsonl");
  const shadow = () =>
    spawnSync(
      process.execPath,
      [tool, folder, "area", "--memory", "16", "--out", out, "--decisions", decisions],
      { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1024" } },
    );
  const ran = shadow();
  assert.equal(ran.status, 1, ran.stderr);
  const records = readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((r) => r.name),
    ["fine", "leak", "crash", "after", "outside", "idle"].map((name) => `cases.mjs/${name}`),
  );
  const [fine, leak, crash, after, outside, idle] = records;
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
  for (const record of [fine, leak, after, idle]) {
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
  // limit the worker measured (V8's, its 16 MB old generation with the other spaces), not NODE_OPTIONS' 1,024)
  const limit = leak.rows[0].legacy.retried.heapMiB;
  assert.ok(limit >= 16 && limit < 1024, String(limit));
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
  // (the worker that threw after each outcome was replaced each time, and its outcomes kept)
  const recorded = { runs: 48, failed: 1, retried: 2, incomplete: 1 };
  assert.deepEqual(counted(ran.stdout), { ...recorded, resumed: 0, replaced: 3 });
  // (again with the same --out: nothing runs again, and the recorded failure still counts)
  const again = shadow();
  assert.equal(again.status, 1, again.stderr);
  assert.deepEqual(counted(again.stdout), { ...recorded, resumed: 6, replaced: 0 });
  assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 6);
});
