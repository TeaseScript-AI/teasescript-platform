import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const tool = resolve("tests/families/plans.mjs");

/**
 * A built tree's modules as the plans comparison loads them: a ledger whose allowance is 1,000 or a test's, and a compile
 * that charges it by its source: `over` 5,000 units (past 4 times the allowance), `slow` 300 after waiting 700 ms in
 * every run (its eight runs together past a 3 s safety net, each within it), `hang` 1 after waiting 6 s, any other 300;
 * the held family's stop search, one analysis at a test allowance of 10, 300 for `stopped` (30 times that allowance,
 * within 4 times its natural one) and 5,000 for `searched` (past 4 times its natural one), each at its one settled stop
 * 300; `settling` waits 1.8 s in the head's first compile and as the base's next search starts (each within a 3 s
 * net, together past it), `lost` 6 s as its search starts. (#1850: margins of over a second either way, which a loaded
 * worker keeps, where a 0.5 s net left 200 ms.)
 */
const MODULES: Record<string, string> = {
  "src/type-inference/core/budget.js": `let test = null;
export class WorkLedger {
  constructor(allowance) {
    this.allowance = allowance;
  }
  charge() {}
}
export const ledger = () => new WorkLedger(test ?? 1000);
export function withTestAllowance(allowance, run) {
  test = allowance;
  try {
    return run();
  } finally {
    test = null;
  }
}
export const withTestDemandAllowance = (_, run) => run();
`,
  "src/compiler.js": `import { ledger } from "./type-inference/core/budget.js";
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let settling = import.meta.url.includes("/head/");
export function compileProjectWithBackend(files) {
  const source = files[0].source;
  if (source === "settling" && settling) (settling = false), wait(1800);
  if (source === "slow") wait(700);
  if (source === "hang") wait(6000);
  ledger().charge("frames", source === "over" ? 5000 : source === "hang" ? 1 : 300);
  return { plan: { instructions: [] }, diagnostics: [] };
}
export const compileSourceWithBackend = (source) => compileProjectWithBackend([{ source }]);
`,
  "src/type-inference/core/backend.js": "export const CORE_BACKEND = {};\n",
  "src/type-inference/core/answers.js": `import { ledger } from "./budget.js";
class Answers {}
export function analyseCore(request) {
  if (request.source !== undefined) ledger().charge("frames", 300);
  return new Answers();
}
`,
  "tests/helpers/type-core-analysis.js": `export const coreRequest = (files) => ({ source: files[0].source });\n`,
  "tests/helpers/type-core-held-host.js": `import { WorkLedger } from "../../src/type-inference/core/budget.js";
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const HELD_MODES = [0, 1, 2, 3].map(() => ({ run: (f) => f() }));
export const heldFamily = () =>
  ["stopped", "searched", "settling", "lost"].map((name) => ({ name, source: name, slice: true }));
let settling = import.meta.url.includes("/base/");
export function heldStops(c, mode) {
  if (c.name === "settling" && settling) (settling = false), wait(1800);
  if (c.name === "lost") wait(6000);
  mode.run(() => new WorkLedger(10).charge("frames", c.name === "searched" ? 5000 : 300));
  return [{ allowance: 10, phase: "admission" }];
}
`,
};

test("the plans comparison stalls a run past its unit limit, not a slow one, and counts its safety net apart (#1647)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // (two trees, so that each loads its own ledger, as two builds do)
  for (const tree of ["base", "head"]) {
    for (const [file, text] of Object.entries(MODULES)) {
      mkdirSync(join(folder, tree, "dist", file, ".."), { recursive: true });
      writeFileSync(join(folder, tree, "dist", file), text);
    }
    writeFileSync(join(folder, tree, "package.json"), '{ "type": "module" }\n');
    mkdirSync(join(folder, tree, "tests", "families", "area"), { recursive: true });
    cpSync(resolve("tests/families/sources.mjs"), join(folder, tree, "tests/families/sources.mjs"));
    writeFileSync(
      join(folder, tree, "tests/families/area/cases.mjs"),
      `export const cases = ${JSON.stringify(["fine", "over", "slow", "hang"].map((s) => [s, s]))};\n`,
    );
  }
  const plans = (set: string, out: string, ...more: string[]) => {
    const ran = spawnSync(
      process.execPath,
      [
        tool,
        join(folder, "base"),
        join(folder, "head"),
        set,
        "--timeout",
        "3",
        "--out",
        out,
        ...more,
      ],
      { encoding: "utf8" },
    );
    const records = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line): Record<string, unknown> => JSON.parse(line));
    const summary: Record<string, unknown> = JSON.parse(ran.stdout.trim());
    return { ran, records, summary };
  };
  const area = plans("area", join(folder, "area.jsonl"));
  assert.equal(area.ran.status, 1, area.ran.stderr);
  const outcome = (name: string) => {
    const { stalled, uncharged, run, work, allowance, differing } = area.records.find(
      (record) => record.name === `cases.mjs/${name}`,
    )!;
    return { stalled, uncharged, run, work, allowance, differing };
  };
  // (past 4 times its allowance on the base's first run: a stall, by its units, named by its run)
  assert.deepEqual(outcome("over"), {
    stalled: "units",
    uncharged: undefined,
    run: { tree: "base", mode: 0, at: "natural" },
    work: 5000,
    allowance: 1000,
    differing: undefined,
  });
  // (slow, within its limit and each run within the safety net: compared, and equal; a run past the net with no units:
  // uncharged, no stall)
  for (const name of ["fine", "slow"]) assert.equal(outcome(name).differing, 0, name);
  assert.deepEqual(outcome("hang"), {
    stalled: undefined,
    uncharged: "safety net 3 s",
    run: { tree: "base", mode: 0, at: "natural" },
    work: undefined,
    allowance: undefined,
    differing: undefined,
  });
  const counted = ({ summary }: { summary: Record<string, unknown> }) => {
    const { sources, resumed, runs, differing, stalled, uncharged, units } = summary;
    return { sources, resumed, runs, differing, stalled, uncharged, units };
  };
  const recorded = { sources: 4, runs: 8, differing: 0, stalled: 1, uncharged: 1, units: 4 };
  assert.deepEqual(counted(area), { ...recorded, resumed: 0 });
  // (again with the same --out: nothing runs again, and the recorded stall and safety net still count)
  const again = plans("area", join(folder, "area.jsonl"));
  assert.equal(again.ran.status, 1, again.ran.stderr);
  assert.deepEqual(counted(again), { ...recorded, resumed: 4 });
  assert.equal(again.records.length, 4);
  // (at a test allowance of 10, 300 units are within 4 times the source's natural allowance, in the stop search and at
  // the stop; the search's own analysis past it is a stall, named by its run; the search's own work is a run of its
  // own for the safety net: after a slow compile it is no safety net reached, and lost, it is named)
  const held = plans("held", join(folder, "held.jsonl"), "--stops");
  assert.equal(held.ran.status, 1, held.ran.stderr);
  assert.deepEqual(
    held.records.map(({ name, stalled, uncharged, run, work, allowance }) => ({
      name,
      stalled,
      uncharged,
      run,
      work,
      allowance,
    })),
    [
      { name: "stopped" },
      {
        name: "searched",
        stalled: "units",
        run: { tree: "base", mode: 0, at: "stop search", analysis: 1 },
        work: 5000,
        allowance: 1000,
      },
      { name: "settling" },
      {
        name: "lost",
        uncharged: "safety net 3 s",
        run: { tree: "base", mode: 0, at: "stop search, between", analysis: 0 },
      },
    ].map((record) => ({
      stalled: undefined,
      uncharged: undefined,
      run: undefined,
      work: undefined,
      allowance: undefined,
      ...record,
    })),
  );
  assert.equal(held.summary.runs, 16);
});
