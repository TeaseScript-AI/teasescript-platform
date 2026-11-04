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
 * `leak` in the first mode in a worker that compiled before (a fresh one compiles it).
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
    `export const cases = ${JSON.stringify(["fine", "leak", "crash", "after"].map((s) => [s, s]))};\n`,
  );
  const out = join(folder, "shadow.jsonl");
  const ran = spawnSync(process.execPath, [tool, folder, "area", "--memory", "16", "--out", out], {
    encoding: "utf8",
  });
  assert.equal(ran.status, 1, ran.stderr);
  const records = readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((r) => r.name),
    ["fine", "leak", "crash", "after"].map((name) => `cases.mjs/${name}`),
  );
  const [fine, leak, crash, after] = records;
  for (const record of [fine, leak, after]) {
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
  // (the reused worker's crash, retried in a fresh one: the fresh one's result, the first failure named)
  assert.deepEqual(leak.rows[0].legacy.retried, {
    route: "legacy",
    mode: 0,
    phase: "analysis",
    failure: "heap",
    runsBeforeFailure: 4,
    heapMiB: 16,
  });
  // (a crash that repeats in the fresh worker: recorded once, as the fresh worker's; the core's run and every other
  // mode kept)
  const failure = {
    route: "legacy",
    mode: 2,
    phase: "analysis",
    failure: "heap",
    runsBeforeFailure: 0,
    heapMiB: 16,
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
  const summary = JSON.parse(ran.stdout.trim());
  assert.deepEqual(
    {
      runs: summary.runs,
      failed: summary.failed,
      retried: summary.retried,
      incomplete: summary.incomplete,
    },
    { runs: 32, failed: 1, retried: 2, incomplete: 1 },
  );
});
