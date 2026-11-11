import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { withConsumerOrder } from "../../src/type-inference/core/consumers.js";
import { sharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";

const tool = resolve("tests/families/plans.mjs");

/**
 * Each tree's order of its modes' names (#2342): neither `HELD_MODES`' order, the oracle's `MODES`', nor alphabetical,
 * and no name at the same position in both, so that pairing by position fails every mode.
 */
const ORDERS = {
  base: ["reversed, unshared", "forward", "reversed", "forward, unshared"],
  head: ["forward, unshared", "reversed", "reversed, unshared", "forward"],
};

/**
 * A built tree's modules as the plans comparison loads them: a ledger whose allowance is 1,000 or a test's, and a compile
 * that charges it by its source: `over` 5,000 units (past 4 times the allowance), `slow` 300 after waiting 700 ms in
 * every run (its eight runs together past a 3 s safety net, each within it), `hang` 1 after waiting 6 s, any other 300;
 * the held family's stop search, one analysis at a test allowance of 10, 300 for `stopped` (30 times that allowance,
 * within 4 times its natural one) and 5,000 for `searched` (past 4 times its natural one), each at its one settled stop
 * 300; `settling` waits 1.8 s in the head's first compile and as the base's next search starts (each within a 3 s
 * net, together past it), `lost` 6 s as its search starts. (#1850: margins of over a second either way, which a loaded
 * worker keeps, where a 0.5 s net left 200 ms.) Each tree's four modes are named as `HELD_MODES`' are, in an order of its
 * own (`ORDERS`), and a compile's plan holds the name of the mode it ran in, so modes paired by position differ. For
 * every record form (R20): `exits` ends its worker; `over at demand <n>` charges 5,000 at that demand, and `overstop`
 * at its stop's allowance; an `apart…` source's plan on the head names its demand and allowance, so every pair differs;
 * the stop search throws for `throws`; the analysis charges 5,000 for `overanalysis` and nothing for
 * `apart-zero-questions`; the one stop of `apart-stop <n>` and `overstop <n>` is at the allowance `<n>`, of any
 * other at 10; and `lists`, `empty-base`, `empty-head` and `duplicates` have a stop list of each tree's own: at edge
 * allowances out of order, empty on one tree, and one allowance twice (#2340).
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
export function withTestDemandAllowance(demand, run) {
  globalThis.demand = demand;
  try {
    return run();
  } finally {
    globalThis.demand = undefined;
  }
}
`,
  "src/compiler.js": `import { ledger } from "./type-inference/core/budget.js";
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let settling = import.meta.url.includes("/head/");
let thrown = false;
export function compileProjectWithBackend(files) {
  const source = files[0].source;
  if (source === "settling" && settling) (settling = false), wait(1800);
  if (source === "slow") wait(700);
  if (source === "hang") wait(6000);
  if (source === "failing" && import.meta.url.includes("/base/")) throw new Error("fails");
  if (source === "exits") process.exit(3);
  // (a throw that waits for the compile and its record: the worker's event loop runs it only after both, #2426)
  if (source === "async-after" && !thrown) (thrown = true), setTimeout(() => { throw new Error("async after record"); });
  const over =
    source === "over" ||
    source === \`over at demand \${globalThis.demand}\` ||
    (source.startsWith("overstop") && ledger().allowance !== 1000);
  ledger().charge("frames", over ? 5000 : source === "hang" ? 1 : 300);
  const apart = import.meta.url.includes("/head/") && source.startsWith("apart")
    ? { demand: String(globalThis.demand), allowance: ledger().allowance }
    : {};
  return { plan: { instructions: [], mode: globalThis.heldMode, ...apart }, diagnostics: [] };
}
export const compileSourceWithBackend = (source) => compileProjectWithBackend([{ source }]);
`,
  "src/type-inference/core/backend.js": "export const CORE_BACKEND = {};\n",
  "src/type-inference/core/answers.js": `import { ledger } from "./budget.js";
class Answers {}
export function analyseCore(request) {
  if (request.source !== undefined && request.source !== "apart-zero-questions")
    ledger().charge("frames", request.source === "overanalysis" ? 5000 : 300);
  return new Answers();
}
`,
  "tests/helpers/type-core-analysis.js": `export const coreRequest = (files) => ({ source: files[0].source });\n`,
  "tests/helpers/type-core-held-host.js": `import { WorkLedger } from "../../src/type-inference/core/budget.js";
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const names = import.meta.url.includes("/head/") ? ${JSON.stringify(ORDERS.head)} : ${JSON.stringify(ORDERS.base)};
export const HELD_MODES = names.map((name) => ({
  name,
  run: (f) => {
    globalThis.heldMode = name;
    try {
      return f();
    } finally {
      globalThis.heldMode = undefined;
    }
  },
}));
export const heldFamily = () =>
  ["stopped", "searched", "settling", "lost"].map((name) => ({ name, source: name, slice: true }));
let settling = import.meta.url.includes("/base/");
export function heldStops(c, mode) {
  if (c.name === "settling" && settling) (settling = false), wait(1800);
  if (c.name === "lost") wait(6000);
  if (c.name === "throws") throw new Error("search failed");
  mode.run(() => new WorkLedger(10).charge("frames", c.name === "searched" ? 5000 : 300));
  const walk = (...allowances) => allowances.map((allowance) => ({ allowance, phase: "walk" }));
  const lists = {
    lists: [
      [
        { allowance: 0, phase: "walk" },
        { allowance: -1, phase: "walk" },
        { allowance: 0.5, phase: "read" },
        { allowance: NaN, phase: "walk" },
        { allowance: Infinity, phase: "removed" },
      ],
      [
        { allowance: Infinity, phase: "walk" },
        { allowance: 2, phase: "read" },
        { allowance: 10, phase: "added" },
      ],
    ],
    "empty-base": [[], walk(5)],
    "empty-head": [walk(5), []],
    duplicates: [walk(1, 1), walk(1)],
  }[c.name];
  if (lists !== undefined) return lists[import.meta.url.includes("/head/") ? 1 : 0];
  const [, at] = /^(?:apart-stop|overstop) (.+)$/.exec(c.name) ?? [];
  return [{ allowance: at === undefined ? 10 : Number(at), phase: "admission" }];
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
    run: { tree: "base", mode: "reversed, unshared", at: "natural" },
    work: 5000,
    allowance: 1000,
    differing: undefined,
  });
  // (slow, within its limit and each run within the safety net: compared, and equal; a run past the net with no units:
  // uncharged, no stall)
  for (const name of ["fine", "slow"]) assert.equal(outcome(name).differing, 0, name);
  // (each mode by its name, in the base's order, compared with the head's mode of that name: equal, #2342)
  const { modes } = area.records.find((record) => record.name === "cases.mjs/fine")!;
  assert.ok(Array.isArray(modes));
  assert.deepEqual(
    modes.map((entry: Record<string, unknown>) => ({ mode: entry.mode, same: entry.same })),
    ORDERS.base.map((mode) => ({ mode, same: true })),
  );
  assert.deepEqual(outcome("hang"), {
    stalled: undefined,
    uncharged: "safety net 3 s",
    run: { tree: "base", mode: "reversed, unshared", at: "natural" },
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
        run: { tree: "base", mode: "reversed, unshared", at: "stop search", analysis: 1 },
        work: 5000,
        allowance: 1000,
      },
      { name: "settling" },
      {
        name: "lost",
        uncharged: "safety net 3 s",
        run: { tree: "base", mode: "reversed, unshared", at: "stop search, between", analysis: 0 },
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

test("the plans comparison resumes a source by its name and key, so a recorded one does not stand for its namesake (#2254)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
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
      `export const cases = ${JSON.stringify([
        ["twin", "first"],
        ["twin", "second"],
      ])};\n`,
    );
  }
  const out = join(folder, "area.jsonl");
  const plans = () => {
    const ran = spawnSync(
      process.execPath,
      [tool, join(folder, "base"), join(folder, "head"), "area", "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, ran.stderr);
    const records = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line): Record<string, unknown> => JSON.parse(line));
    return { records, resumed: JSON.parse(ran.stdout.trim()).resumed };
  };
  const [first, second] = plans().records;
  assert.equal(first!.name, second!.name);
  assert.notEqual(first!.key, second!.key);
  // (the first recorded: the second still runs)
  writeFileSync(out, `${JSON.stringify(first)}\n`);
  const resumed = plans();
  assert.equal(resumed.resumed, 1);
  assert.deepEqual(resumed.records, [first, second]);
  // (a record without a key, from before keys: its source runs again)
  writeFileSync(out, `${JSON.stringify({ ...first, key: undefined })}\n`);
  const keyless = plans();
  assert.equal(keyless.resumed, 0);
  assert.deepEqual(keyless.records.slice(1), [first, second]);
});

/** Two stand-in trees under `folder`, each with `MODULES` and the area `area` of `cases`. */
function built(folder: string, cases: string[][]): void {
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
      `export const cases = ${JSON.stringify(cases)};\n`,
    );
  }
}

test("the plans comparison refuses trees whose modes are not the same names once each, before any record (#2342)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  built(folder, [["fine", "fine"]]);
  // (each wrong table on either tree, the other tree's as built: a refusal must not depend on which tree is wrong)
  const held = (tree: string) => join(folder, tree, "dist", "tests/helpers/type-core-held-host.js");
  const original = readFileSync(held("base"), "utf8");
  let at = 0;
  /** A table of `names` in place of the tree's four modes, each mode named so (`null` unnamed). */
  const table = (names: (string | null)[]) =>
    `HELD_MODES.splice(0, 4, ...${JSON.stringify(names)}.map((name) => ({ name, run: (f) => f() })));`;
  const wrong = [
    table(["forward", "reversed", "forward, unshared", "sideways"]),
    table(["forward", "reversed", "forward, unshared"]),
    table(["forward", "reversed", "forward, unshared", "forward"]),
    table(["forward", "reversed", "forward, unshared", null]),
    // (a hole: a slot `map` and `some` skip, Codex round 1's case)
    "delete HELD_MODES[1];",
  ];
  for (const tree of ["head", "base"])
    for (const change of wrong) {
      for (const each of ["base", "head"]) writeFileSync(held(each), original);
      writeFileSync(held(tree), `${original}\n${change}\n`);
      at += 1;
      const out = join(folder, `refused-${at}.jsonl`);
      const ran = spawnSync(
        process.execPath,
        [tool, join(folder, "base"), join(folder, "head"), "area", "--out", out],
        { encoding: "utf8" },
      );
      const named = `${tree}: ${change}`;
      assert.equal(ran.status, 2, `${named}: ${ran.stderr}`);
      assert.match(ran.stderr, /held modes are not the same names once each/, named);
      assert.equal(existsSync(out), false, named);
    }
});

test("the plans comparison hands no source to a worker before it has loaded and checked both trees' modes, so a slow or wrong start writes no record (#2342, final review B1)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  built(folder, [
    ["first", "first"],
    ["second", "second"],
  ]);
  const held = (tree: string) => join(folder, tree, "dist", "tests/helpers/type-core-held-host.js");
  const original = readFileSync(held("base"), "utf8");
  // (one source recorded by a run on good trees: the partly resumed start)
  const resumed = join(folder, "resumed.jsonl");
  const plans = (out: string, ...more: string[]) =>
    spawnSync(
      process.execPath,
      [tool, join(folder, "base"), join(folder, "head"), "area", "--out", out, ...more],
      { encoding: "utf8" },
    );
  assert.equal(plans(resumed, "--limit", "1").status, 0);
  const before = readFileSync(resumed, "utf8");
  assert.equal(before.trim().split("\n").length, 1);
  // (a hole in one tree's table behind an import that outlasts the safety net, on each tree; and good trees with a safety
  // net of 0 s, the review's second case)
  const delayed =
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);\ndelete HELD_MODES[1];";
  let at = 0;
  for (const [tree, change, timeout] of [
    ["head", delayed, "1"],
    ["base", delayed, "1"],
    ["base", "", "0"],
  ] as const) {
    for (const each of ["base", "head"]) writeFileSync(held(each), original);
    writeFileSync(held(tree), `${original}\n${change}\n`);
    for (const start of ["fresh", "resumed"]) {
      at += 1;
      const out = join(folder, `started-${at}.jsonl`);
      if (start === "resumed") writeFileSync(out, before);
      const ran = plans(out, "--timeout", timeout);
      const named = `${tree} ${start} --timeout ${timeout}`;
      assert.equal(ran.status, 2, `${named}: ${ran.stdout} ${ran.stderr}`);
      assert.match(ran.stderr, /the trees could not be compared/, named);
      assert.equal(
        existsSync(out) ? readFileSync(out, "utf8") : null,
        start === "resumed" ? before : null,
        named,
      );
    }
  }
});

/**
 * A `node --import` module for the runner's process (#2426, R29): the first worker's messages during its first source
 * are held until that worker's real error, delivered after it in their order, and then its exit follows. That is an
 * order Node allows (an error ahead of the messages the worker posted before it), selected so that the test is
 * deterministic; it does not prove every interleaving.
 */
const ERROR_FIRST = `import { createRequire, syncBuiltinESMExports } from "node:module";
const threads = createRequire(import.meta.url)("node:worker_threads");
const Native = threads.Worker;
let made = 0;
threads.Worker = class extends Native {
  first = ++made === 1;
  sourced = false;
  failed = false;
  held = [];
  wrapped = new Map();
  postMessage(...args) {
    this.sourced = true;
    return super.postMessage(...args);
  }
  on(event, listener) {
    if (!this.first || (event !== "message" && event !== "error")) return super.on(event, listener);
    const wrapped = (...args) => {
      if (event === "message" && this.sourced && !this.failed) return void this.held.push([listener, args]);
      listener(...args);
      if (event === "error" && this.sourced) {
        this.failed = true;
        for (const [held, values] of this.held.splice(0)) if (this.wrapped.has(held)) held(...values);
      }
    };
    this.wrapped.set(listener, wrapped);
    return super.on(event, wrapped);
  }
  off(event, listener) {
    const wrapped = this.wrapped.get(listener);
    this.wrapped.delete(listener);
    return super.off(event, wrapped ?? listener);
  }
};
syncBuiltinESMExports();
`;

test("a worker's error delivered before the messages it posted first ends its source in one stall naming the run that threw, and the next source runs on a fresh worker (#2426)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  built(folder, [
    ["async-after", "async-after"],
    ["fine-next", "fine-next"],
  ]);
  for (const tree of ["base", "head"]) {
    const held = join(folder, tree, "dist", "tests/helpers/type-core-held-host.js");
    writeFileSync(
      held,
      readFileSync(held, "utf8").replace(
        '["stopped", "searched", "settling", "lost"]',
        '["throws", "stopped"]',
      ),
    );
  }
  const adapter = join(folder, "error-first.mjs");
  writeFileSync(adapter, ERROR_FIRST);
  const plans = (set: string, ...more: string[]) => {
    const out = join(folder, `${set}.jsonl`);
    const ran = spawnSync(
      process.execPath,
      [
        "--import",
        adapter,
        tool,
        join(folder, "base"),
        join(folder, "head"),
        set,
        "--out",
        out,
        ...more,
      ],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 1, ran.stderr);
    return readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line): Record<string, unknown> => JSON.parse(line));
  };
  // (error, its runs, exit: the stall names the run that threw, never none or an earlier one)
  const [threw, stopped] = plans("held", "--stops");
  assert.deepEqual(threw, {
    set: "held",
    name: "throws",
    key: threw!.key,
    stalled: "Error: search failed",
    run: { tree: "base", mode: ORDERS.base[0], at: "stop search, between", analysis: 0 },
  });
  assert.equal(stopped!.name, "stopped");
  assert.equal(stopped!.differing, 0);
  // (error, its runs and its record, exit: the record does not end the source, and the next source runs on a fresh
  // worker, not the one that failed)
  const [failed, next] = plans("area");
  assert.equal(failed!.stalled, "Error: async after record");
  assert.equal(failed!.modes, undefined);
  // (the throw runs once the compiles of every mode and the record are done: the last run is the head's last one)
  assert.deepEqual(failed!.run, { tree: "head", mode: ORDERS.base.at(-1), at: "natural" });
  assert.equal(next!.name, "cases.mjs/fine-next");
  assert.equal(next!.differing, 0);
  assert.equal(next!.stalled, undefined);
});

test("the plans comparison ends with exit 2 and writes no record where a worker posts a stray message during a source (#2342)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  built(folder, [
    ["first", "first"],
    ["second", "second"],
  ]);
  const held = join(folder, "head", "dist", "tests/helpers/type-core-held-host.js");
  const plans = (out: string, ...more: string[]) =>
    spawnSync(
      process.execPath,
      [tool, join(folder, "base"), join(folder, "head"), "area", "--out", out, ...more],
      { encoding: "utf8" },
    );
  const out = join(folder, "stray.jsonl");
  assert.equal(plans(out, "--limit", "1").status, 0);
  const before = readFileSync(out, "utf8");
  // (the head's first mode posts a message that is neither a run nor a record as it compiles the second source)
  writeFileSync(
    held,
    `${readFileSync(held, "utf8")}
import { parentPort as port } from "node:worker_threads";
const { run } = HELD_MODES[0];
HELD_MODES[0].run = (f) => (port.postMessage({ note: "stray" }), run(f));
`,
  );
  const ran = plans(out);
  assert.equal(ran.status, 2, `${ran.stdout} ${ran.stderr}`);
  assert.match(ran.stderr, /second: its worker posted no record but \{"note":"stray"\}/);
  assert.equal(readFileSync(out, "utf8"), before);
});

test("every record form the runner writes, at its allowance edges, passes the summary's check (#2341)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // (`--demands` as `map(Number)` reads it, unchecked: zero, negative, fractional, and NaN and Infinity, which JSON
  // records as null)
  const demands = ["16", "0", "-1", "0.5", "NaN", "Infinity"];
  built(folder, [
    ...["fine", "apart", "over", "hang", "exits"].map((name) => [name, name]),
    ...demands.map((demand) => [`over at demand ${demand}`, `over at demand ${demand}`]),
  ]);
  // (the held family of every held form, a stop pair and a stall at each allowance a tree's `heldStops` may give; the
  // waits shortened to 2.5 s against a 1 s safety net)
  const edges = ["0", "-1", "0.5", "NaN", "Infinity"];
  const family = [
    "stopped",
    "searched",
    "overstop",
    "overanalysis",
    "throws",
    "lost",
    "lists",
    "empty-base",
    "empty-head",
    "duplicates",
    "failing",
    ...edges.flatMap((edge) => [`apart-stop ${edge}`, `overstop ${edge}`]),
  ];
  for (const tree of ["base", "head"]) {
    for (const [file, from, to] of [
      [
        "tests/helpers/type-core-held-host.js",
        '["stopped", "searched", "settling", "lost"]',
        JSON.stringify([...family, "apart-zero-questions"]),
      ],
      ["tests/helpers/type-core-held-host.js", "wait(6000)", "wait(2500)"],
      ["src/compiler.js", "wait(6000)", "wait(2500)"],
    ] as const) {
      const at = join(folder, tree, "dist", file);
      writeFileSync(at, readFileSync(at, "utf8").replace(from, to));
    }
  }
  const run = (set: string, ...more: string[]) => {
    const out = join(folder, `${set}.jsonl`);
    const ran = spawnSync(
      process.execPath,
      [
        tool,
        join(folder, "base"),
        join(folder, "head"),
        set,
        "--timeout",
        "1",
        "--out",
        out,
        ...more,
      ],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 1, ran.stderr);
    return out;
  };
  const files = [run("area", "--demands", demands.join(",")), run("held", "--stops")];
  /** A written record, as far as this test reads it. */
  type Written = {
    name: string;
    differing?: number;
    stalled?: string;
    uncharged?: string;
    run?: { at: string };
    modes?: {
      demands?: { demand: unknown }[];
      stops?: {
        differ?: { allowance: unknown }[];
        base?: { allowance: unknown }[];
        head?: { allowance: unknown }[];
        unavailable?: string;
      };
      questions?: { differ: { allowance: unknown }[] };
    }[];
  };
  const records = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line): Written => JSON.parse(line)),
  );
  // (every form is among them, so that one the writer stops writing fails here too)
  assert.deepEqual(
    records
      .flatMap((r) => (r.run === undefined ? [] : [`${r.stalled ?? r.uncharged} at ${r.run.at}`]))
      .sort(),
    [
      "Error: search failed at stop search, between",
      "safety net 1 s at natural",
      "safety net 1 s at stop search, between",
      "units at allowance 10",
      ...edges.map((edge) => `units at allowance ${edge}`),
      "units at analysis",
      ...demands.map((demand) => `units at demand ${demand}`),
      "units at natural",
      "units at stop search",
      "worker exit 3 at natural",
    ].sort(),
  );
  const modes = records.flatMap((r) => r.modes ?? []);
  const values = (allowances: unknown[]) =>
    [...new Set(allowances.map((allowance) => JSON.stringify(allowance)))].sort();
  assert.deepEqual(values(modes.flatMap((m) => (m.demands ?? []).map((d) => d.demand))), [
    "-1",
    "0",
    "0.5",
    "16",
    "null",
  ]);
  assert.deepEqual(values(modes.flatMap((m) => (m.stops?.differ ?? []).map((d) => d.allowance))), [
    "-1",
    "0",
    "0.5",
    "10",
    "null",
  ]);
  assert.ok(modes.some((m) => m.questions?.differ.some((d) => d.allowance === 0)));
  // (#2340: both trees' stop lists where the sets differ, at the edges, and a stop search that did not run)
  assert.deepEqual(
    values(
      modes.flatMap((m) =>
        [...(m.stops?.base ?? []), ...(m.stops?.head ?? [])].map((stop) => stop.allowance),
      ),
    ),
    ["-1", "0", "0.5", "1", "10", "2", "5", "null"],
  );
  assert.ok(modes.some((m) => m.stops?.unavailable !== undefined));
  assert.ok(records.some((r) => r.name === "cases.mjs/fine" && r.differing === 0));
  // (and the summary reads every line)
  const summary = spawnSync(process.execPath, [tool, "summary", ...files, "--list", "100000"], {
    encoding: "utf8",
  });
  assert.equal(summary.stderr, "");
  assert.equal(summary.status, 0);
  // (an empty list on either tree, and an allowance twice, each read in every mode: #2340's round 2)
  for (const [name, line] of [
    ["empty-base", 'stop phase "walk" added: base none (0), head 5 (1)'],
    ["empty-head", 'stop phase "walk" removed: base 5 (1), head none (0)'],
    ["duplicates", 'stop phase "walk" moved: base 1, 1 (2), head 1 (1)'],
  ])
    assert.equal(
      summary.stdout
        .split("\n")
        .filter((each) => each.startsWith(`held ${name} mode `) && each.endsWith(`: ${line}`))
        .length,
      4,
      name,
    );
});

test("each held mode's name says the settings its run sets, and the oracle's mode of those settings is found by them, not by position (#2342)", () => {
  /** Whether `enter` throws for an order already active: a seam the mode set. */
  const active = (enter: () => void) => {
    try {
      enter();
      return false;
    } catch {
      return true;
    }
  };
  /** The settings a run is in, as observed inside it. */
  const observed = () => {
    const consumers = active(() =>
      withConsumerOrder(
        (list) => [...list],
        () => 0,
      ),
    );
    const solver = active(() => withSolverSeam({}, () => 0));
    assert.equal(consumers, solver, "the consumers' and the solver's orders reversed together");
    return { reversed: consumers, unshared: !sharing() };
  };
  const named = (name: string) => ({
    reversed: name.startsWith("reversed"),
    unshared: name.endsWith(", unshared"),
  });
  assert.deepEqual(HELD_MODES.map((mode) => mode.name).sort(), [
    "forward",
    "forward, unshared",
    "reversed",
    "reversed, unshared",
  ]);
  const positions: [number, number][] = [];
  for (const [at, mode] of HELD_MODES.entries()) {
    const settings = mode.run(observed);
    assert.deepEqual(settings, named(mode.name), mode.name);
    const oracle = MODES.findIndex(
      (each) => each.reversed === settings.reversed && each.unshared === settings.unshared,
    );
    assert.deepEqual(inMode(MODES[oracle]!, observed), settings, mode.name);
    positions.push([at, oracle]);
  }
  // (the two tables order the modes differently: a ledger that reads one's position by the other misattributes)
  assert.ok(
    positions.some(([held, oracle]) => held !== oracle),
    JSON.stringify(positions),
  );
});

test("the plans comparison keeps both trees' stops where they differ, and says a held case's stop search did not run (#2340)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  built(folder, [["fine", "fine"]]);
  // (one held case whose stops move by tree, and one whose base compile fails)
  for (const tree of ["base", "head"])
    writeFileSync(
      join(folder, tree, "dist", "tests/helpers/type-core-held-host.js"),
      `export const HELD_MODES = ${JSON.stringify(ORDERS.base)}.map((name) => ({ name, run: (f) => f() }));
export const heldFamily = () => ["moving", "failing"].map((name) => ({ name, source: name, slice: true }));
export const heldStops = () => [{ allowance: ${tree === "head" ? 12 : 10}, phase: "walk" }];
`,
    );
  const out = join(folder, "held.jsonl");
  const ran = spawnSync(
    process.execPath,
    [tool, join(folder, "base"), join(folder, "head"), "held", "--stops", "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(ran.status, 1, ran.stderr);
  const records = readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((line): Record<string, unknown> => JSON.parse(line));
  const stopsOf = (name: string) => {
    const { modes } = records.find((record) => record.name === name)!;
    assert.ok(Array.isArray(modes));
    return modes.map((entry: Record<string, unknown>) => entry.stops);
  };
  assert.deepEqual(
    stopsOf("moving"),
    ORDERS.base.map(() => ({
      count: 1,
      sameSet: false,
      differ: [],
      base: [{ allowance: 10, phase: "walk" }],
      head: [{ allowance: 12, phase: "walk" }],
    })),
  );
  assert.deepEqual(
    stopsOf("failing"),
    ORDERS.base.map(() => ({ unavailable: "the base's unstopped compile failed: Error: fails" })),
  );
});
