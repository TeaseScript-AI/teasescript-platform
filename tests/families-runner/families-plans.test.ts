import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** A plan or diagnostics digest as the runner writes one (sha256's first 32 hex digits), here of `label`. */
const digest = (label: string) => createHash("sha256").update(label).digest("hex").slice(0, 32);

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
 * `apart-zero-questions`; and the one stop of `apart-stop <n>` and `overstop <n>` is at the allowance `<n>`, of any
 * other at 10.
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
      stops?: { differ: { allowance: unknown }[] };
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
  assert.ok(records.some((r) => r.name === "cases.mjs/fine" && r.differing === 0));
  // (and the summary reads every line)
  const summary = spawnSync(process.execPath, [tool, "summary", ...files], { encoding: "utf8" });
  assert.equal(summary.stderr, "");
  assert.equal(summary.status, 0);
});

test("the plans summary prints a recorded mode as recorded and says once what a number is (#2342)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const side = (units: number) => ({
    plan: digest("p"),
    diagnostics: digest("d"),
    checks: 0,
    error: null,
    trace: `1/${units}/00`,
    questions: "1/00",
    units,
  });
  const mode = (name: unknown) => ({ mode: name, base: side(3), head: side(2), same: false });
  const file = join(folder, "records.jsonl");
  writeFileSync(
    file,
    [
      { set: "s", name: "old", runs: 2, differing: 2, modes: [mode(2), mode(1)] },
      { set: "s", name: "new", runs: 1, differing: 1, modes: [mode("forward, unshared")] },
    ]
      .map((record) => `${JSON.stringify(record)}\n`)
      .join(""),
  );
  const ran = spawnSync(process.execPath, [tool, "summary", file], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  const lines = ran.stdout.trim().split("\n").slice(1);
  assert.deepEqual(lines, [
    "mode <number>: a record from before #2342, the mode's index in HELD_MODES at the commit that wrote it",
    "s old mode 2: work 3 → 2",
    "s old mode 1: work 3 → 2",
    's new mode "forward, unshared": work 3 → 2',
  ]);
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

test("the plans summary names what differs in a demand row, gives it one class, and which tree's output the allowance stops (#2341)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const compile = (plan: string, diagnostics: string, more: Record<string, unknown> = {}) => ({
    plan: digest(plan),
    diagnostics: digest(diagnostics),
    checks: 1,
    error: null,
    trace: "1/5/00",
    questions: "1/00",
    units: 5,
    ...more,
  });
  // (in "reversed" the trees' unstopped compiles differ, so that a row read against the other tree's names the other
  // tree; in "forward, unshared" they agree, so that a row can differ in its questions or work alone)
  const apart = { base: compile("A", "d"), head: compile("B", "e") };
  const alike = { base: compile("P", "d"), head: compile("P", "d") };
  const modes = [
    {
      mode: "reversed",
      ...apart,
      same: false,
      demands: [
        // (the base's output at the allowance is the head's unstopped plan, not its own: the base's stop alone)
        {
          demand: 64,
          base: compile("B", "d", { questions: "2/00", trace: "1/4/00", units: 4 }),
          head: compile("B", "e", { questions: "3/00", trace: "1/6/00", units: 6 }),
        },
        {
          demand: 16,
          base: compile("X", "d", { trace: "1/4/00", units: 4 }),
          head: compile("Y", "e", { trace: "1/3/00", units: 3 }),
        },
      ],
    },
    {
      mode: "forward, unshared",
      ...alike,
      same: true,
      demands: [
        {
          demand: 32,
          base: compile("P", "d", { questions: "2/00" }),
          head: compile("P", "d", { questions: "3/00" }),
        },
        {
          demand: 8,
          base: compile("P", "d", { trace: "1/4/00", units: 4 }),
          head: compile("P", "d", { trace: "1/3/00", units: 3 }),
        },
      ],
    },
  ];
  const file = join(folder, "records.jsonl");
  writeFileSync(file, `${JSON.stringify({ set: "s", name: "n", runs: 6, differing: 5, modes })}\n`);
  const ran = spawnSync(process.execPath, [tool, "summary", file], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  const [countsLine, ...lines] = ran.stdout.trim().split("\n");
  const counts = JSON.parse(countsLine!);
  assert.deepEqual(
    ["demand", "demandPublication", "demandQuestions", "demandWork"].map((key) => counts[key]),
    [4, 2, 1, 1],
  );
  assert.deepEqual(
    ["Base", "Head", "Both", "Neither"].map((who) => counts[`demandStops${who}`]),
    [1, 0, 1, 2],
  );
  const own = "(against its own unstopped compile, base:";
  const checks = "checks 1/1 → 1/1 (unstopped/at the allowance)";
  assert.deepEqual(lines.slice(1), [
    `s n mode "reversed": at demand allowance 64 apart (publication): diagnostics, questions, work; stops base ` +
      `${own} plan, questions, work, head: questions, work); ${checks}, units 4 → 6`,
    `s n mode "reversed": at demand allowance 16 apart (publication): plan, diagnostics, work; stops both ` +
      `${own} plan, work, head: plan, work); ${checks}, units 4 → 3`,
    `s n mode "forward, unshared": at demand allowance 32 apart (questions): questions; stops neither ` +
      `${own} questions, head: questions); ${checks}, units 5 → 5`,
    `s n mode "forward, unshared": at demand allowance 8 apart (work): work; stops neither ` +
      `${own} work, head: work); ${checks}, units 4 → 3`,
  ]);
});

test("the plans summary refuses, naming file, line and fault, any line that is not a record the runner writes (#2341)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const compile = (more: Record<string, unknown> = {}) => ({
    plan: digest("p"),
    diagnostics: digest("d"),
    checks: 0,
    error: null,
    trace: "1/5/811c9dc5c2b2ae3d",
    questions: "1/a0",
    units: 5,
    ...more,
  });
  const valid = () => ({
    set: "s",
    name: "n",
    key: "c".repeat(64),
    runs: 2,
    differing: 1,
    modes: [
      {
        mode: "reversed",
        base: compile(),
        head: compile(),
        same: true,
        demands: [{ demand: 16, base: compile(), head: compile({ trace: "1/4/a0", units: 4 }) }],
      },
    ],
  });
  // (each row one fault, which only its own clause refuses; the valid record first, which must pass)
  // (a row whose fault is null passes)
  const rows: (readonly [
    string,
    (r: ReturnType<typeof valid>) => object | string,
    RegExp | null,
  ])[] = [
    ["a valid record", (r) => r, null],
    ["not JSON", () => "{not json", /no JSON/],
    ["a key that is no hash", (r) => ({ ...r, key: "k" }), /no sha256/],
    ["an unknown field", (r) => ({ ...r, extra: 1 }), /no source record/],
    ["runs as text", (r) => ({ ...r, runs: "2" }), /runs or differing/],
    ["no modes", (r) => ({ ...r, modes: [] }), /no modes/],
    ["a mode twice", (r) => ({ ...r, modes: [r.modes[0], r.modes[0]] }), /a mode twice/],
    [
      "a mode index past 3",
      (r) => ({ ...r, modes: [{ ...r.modes[0], mode: 4 }] }),
      /neither by a name/,
    ],
    [
      "questions false",
      (r) => ({ ...r, modes: [{ ...r.modes[0], base: compile({ questions: false }) }] }),
      /questions not n\/hash/,
    ],
    [
      "trace null",
      (r) => ({ ...r, modes: [{ ...r.modes[0], head: compile({ trace: null }) }] }),
      /trace not n\/units\/hash/,
    ],
    [
      "a part missing",
      (r) => ({ ...r, modes: [{ ...r.modes[0], head: { ...compile(), questions: undefined } }] }),
      /exactly its seven parts/,
    ],
    [
      "a plan neither a digest nor null",
      (r) => ({ ...r, modes: [{ ...r.modes[0], base: compile({ plan: 1 }) }] }),
      /neither a digest nor null/,
    ],
    // (each value format the runner writes, one malformed value a row: round 2's B1)
    ...(
      [
        ["a plan of no digest", { plan: "not-a-hash" }, /neither a digest nor null/],
        ["diagnostics of 33 digits", { diagnostics: "b".repeat(33) }, /neither a digest nor null/],
        ["a digest in capitals", { plan: "A".repeat(32) }, /neither a digest nor null/],
        ["an error that is no text", { error: 1 }, /error neither text nor null/],
        ["a trace hash of one word", { trace: "1/5/a" }, /trace not/],
        ["a trace hash of 17 digits", { trace: `1/5/${"a".repeat(17)}` }, /trace not/],
        ["a trace word with a leading zero", { trace: "1/5/00a" }, /trace not/],
        ["a trace count with a leading zero", { trace: "01/5/a0" }, /trace not/],
        ["a questions hash of one word", { questions: "1/a" }, /questions not/],
        ["a questions hash of 17 digits", { questions: `1/${"a".repeat(17)}` }, /questions not/],
        ["units apart from the trace's", { units: 6 }, /units not its trace's/],
      ] as const
    ).map(
      ([label, part, fault]) =>
        [
          label,
          (r: ReturnType<typeof valid>) => ({
            ...r,
            modes: [
              { ...r.modes[0], demands: [{ demand: 16, base: compile(), head: compile(part) }] },
            ],
          }),
          fault,
        ] as const,
    ),
    [
      "checks below zero",
      (r) => ({ ...r, modes: [{ ...r.modes[0], base: compile({ checks: -1 }) }] }),
      /checks or units/,
    ],
    [
      "same against the parts",
      (r) => ({ ...r, modes: [{ ...r.modes[0], same: false }] }),
      /same that is not/,
    ],
    [
      "a demand side null",
      (r) => ({
        ...r,
        modes: [{ ...r.modes[0], demands: [{ demand: 16, base: null, head: compile() }] }],
      }),
      /exactly its seven parts/,
    ],
    [
      "a demand kept though equal",
      (r) => ({
        ...r,
        modes: [{ ...r.modes[0], demands: [{ demand: 16, base: compile(), head: compile() }] }],
      }),
      /do not differ/,
    ],
    [
      "a demand as text",
      (r) => ({
        ...r,
        modes: [{ ...r.modes[0], demands: [{ ...r.modes[0]!.demands[0]!, demand: "16" }] }],
      }),
      /demand not one/,
    ],
    ["a stall with runs", (r) => ({ ...r, stalled: "units", run: null }), /also holds runs/],
    [
      "a stall's run of no tree",
      () => ({
        set: "s",
        name: "n",
        stalled: "units",
        run: { tree: "both", mode: "forward", at: "natural" },
      }),
      /run not one the runner names/,
    ],
    ...(
      [
        // (the runs a stall names, as every runner on main words them: null fault, the record passes)
        [{ at: "natural" }, null],
        [{ at: "demand 16" }, null],
        [{ at: "allowance 1027" }, null],
        [{ at: "analysis" }, null],
        [{ at: "stop search", analysis: 0 }, null],
        [{ at: "stop search, between", analysis: 3 }, null],
        [{ at: "somewhere" }, /run not one the runner names/],
        [{ at: "demand 016" }, /run not one the runner names/],
        [{ at: "natural", analysis: 1 }, /run not one the runner names/],
        [{ at: "stop search" }, /run not one the runner names/],
      ] as const
    ).map(
      ([run, fault]) =>
        [
          `a stall at ${JSON.stringify(run)}`,
          () => ({
            set: "s",
            name: "n",
            stalled: "units",
            run: { tree: "head", mode: "forward", ...run },
            work: 9,
            allowance: 2,
          }),
          fault,
        ] as const,
    ),
    [
      "a safety net reached",
      () => ({ set: "s", name: "n", uncharged: "safety net 1800 s", run: null }),
      null,
    ],
    [
      "a safety net worded otherwise",
      () => ({ set: "s", name: "n", uncharged: "timeout", run: null }),
      /does not word so/,
    ],
  ];
  for (const [at, [label, change, fault]] of rows.entries()) {
    const changed = change(valid());
    const file = join(folder, `row-${at}.jsonl`);
    writeFileSync(file, `${typeof changed === "string" ? changed : JSON.stringify(changed)}\n`);
    const ran = spawnSync(process.execPath, [tool, "summary", file], { encoding: "utf8" });
    if (fault === null) assert.equal(ran.status, 0, `${label}: ${ran.stderr}`);
    else {
      assert.equal(ran.status, 2, `${label}: ${ran.stdout}`);
      assert.match(ran.stderr, new RegExp(`row-${at}\\.jsonl:1: `), label);
      assert.match(ran.stderr, fault, label);
      assert.equal(ran.stdout, "", label);
    }
  }
});
