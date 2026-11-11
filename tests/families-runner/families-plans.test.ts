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
 * own (`ORDERS`), and a compile's plan holds the name of the mode it ran in, so modes paired by position differ.
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
  if (source === "failing" && import.meta.url.includes("/base/")) throw new Error("fails");
  ledger().charge("frames", source === "over" ? 5000 : source === "hang" ? 1 : 300);
  return { plan: { instructions: [], mode: globalThis.heldMode }, diagnostics: [] };
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

test("the plans comparison ends with exit 2 and writes no record where a worker posts a stray message during a source (#2342, R17)", (t) => {
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

test("the plans summary prints a recorded mode as recorded and says once what a number is (#2342)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const side = (units: number) => ({
    plan: "p",
    diagnostics: "d",
    checks: 0,
    error: null,
    trace: `1/${units}/0`,
    questions: "1/0",
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
    plan,
    diagnostics,
    checks: 1,
    error: null,
    trace: "1/5/0",
    questions: "1/0",
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
          base: compile("B", "d", { questions: "2/0", trace: "1/4/0", units: 4 }),
          head: compile("B", "e", { questions: "3/0", trace: "1/6/0", units: 6 }),
        },
        {
          demand: 16,
          base: compile("X", "d", { trace: "1/4/0", units: 4 }),
          head: compile("Y", "e", { trace: "1/3/0", units: 3 }),
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
          base: compile("P", "d", { questions: "2/0" }),
          head: compile("P", "d", { questions: "3/0" }),
        },
        {
          demand: 8,
          base: compile("P", "d", { trace: "1/4/0", units: 4 }),
          head: compile("P", "d", { trace: "1/3/0", units: 3 }),
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

test("the plans summary refuses, naming file, line and fault, any line that is not a record the runner writes (#2341, R13)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const compile = (more: Record<string, unknown> = {}) => ({
    plan: "p",
    diagnostics: "d",
    checks: 0,
    error: null,
    trace: "1/5/a",
    questions: "1/b",
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
        demands: [{ demand: 16, base: compile(), head: compile({ trace: "1/4/a", units: 4 }) }],
      },
    ],
  });
  const stopList = (stops: [string, number][]) =>
    stops.map(([phase, allowance]) => ({ allowance, phase }));
  const apartStops = {
    count: 2,
    sameSet: false,
    differ: [],
    base: stopList([
      ["walk", 1],
      ["walk", 2],
    ]),
    head: stopList([
      ["walk", 2],
      ["walk", 3],
    ]),
  };
  const withStops = (r: ReturnType<typeof valid>, stops: Record<string, unknown>) => ({
    ...r,
    modes: [{ ...r.modes[0], stops }],
  });
  // (each row one fault, which only its own clause refuses; the valid records first, which must pass, one with apart
  // stops)
  const rows: [string, (r: ReturnType<typeof valid>) => object | string, RegExp][] = [
    ["a valid record", (r) => r, /^$/],
    ["a valid record with apart stops", (r) => withStops(r, apartStops), /^$/],
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
      "a plan neither text nor null",
      (r) => ({ ...r, modes: [{ ...r.modes[0], base: compile({ plan: 1 }) }] }),
      /neither text nor null/,
    ],
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
      "a demand of zero",
      (r) => ({
        ...r,
        modes: [{ ...r.modes[0], demands: [{ ...r.modes[0]!.demands[0]!, demand: 0 }] }],
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
    // (#2340: the stops a held mode records, and the lists of both trees where its sets differ)
    [
      "stops unavailable without a reason",
      (r) => withStops(r, { unavailable: 1 }),
      /without its reason/,
    ],
    [
      "stops with an unknown field",
      (r) => withStops(r, { ...apartStops, extra: 1 }),
      /stops not one/,
    ],
    [
      "one tree's list alone",
      (r) => withStops(r, { ...apartStops, head: undefined }),
      /without the other's/,
    ],
    [
      "lists where the sets are the same",
      (r) => withStops(r, { ...apartStops, sameSet: true }),
      /the same on both trees/,
    ],
    [
      "a count not the base's",
      (r) => withStops(r, { ...apartStops, count: 9 }),
      /not the base's stops/,
    ],
    [
      "lists equal where the sets differ",
      (r) => withStops(r, { ...apartStops, head: apartStops.base }),
      /lists equal/,
    ],
    [
      "a stop with an extra field",
      (r) => withStops(r, { ...apartStops, head: [{ allowance: 1, phase: "walk", at: 0 }] }),
      /no \{allowance, phase\}/,
    ],
    [
      "a non-positive allowance",
      (r) => withStops(r, { ...apartStops, head: [{ allowance: 0, phase: "walk" }] }),
      /positive whole allowance/,
    ],
    [
      "allowances out of order",
      (r) =>
        withStops(r, {
          ...apartStops,
          head: stopList([
            ["walk", 2],
            ["walk", 1],
          ]),
        }),
      /consecutive and ascending/,
    ],
    [
      "an allowance twice",
      (r) =>
        withStops(r, {
          ...apartStops,
          head: stopList([
            ["walk", 1],
            ["walk", 1],
          ]),
        }),
      /consecutive and ascending/,
    ],
    [
      "a gap in a phase",
      (r) =>
        withStops(r, {
          ...apartStops,
          head: stopList([
            ["walk", 1],
            ["walk", 3],
          ]),
        }),
      /consecutive and ascending/,
    ],
    [
      "a phase in two blocks",
      (r) =>
        withStops(r, {
          ...apartStops,
          head: stopList([
            ["walk", 1],
            ["read", 5],
            ["walk", 2],
          ]),
        }),
      /two blocks/,
    ],
  ];
  for (const [at, [label, change, fault]] of rows.entries()) {
    const changed = change(valid());
    const file = join(folder, `row-${at}.jsonl`);
    writeFileSync(file, `${typeof changed === "string" ? changed : JSON.stringify(changed)}\n`);
    const ran = spawnSync(process.execPath, [tool, "summary", file], { encoding: "utf8" });
    if (fault.source === "^$") assert.equal(ran.status, 0, `${label}: ${ran.stderr}`);
    else {
      assert.equal(ran.status, 2, `${label}: ${ran.stdout}`);
      assert.match(ran.stderr, new RegExp(`row-${at}\\.jsonl:1: `), label);
      assert.match(ran.stderr, fault, label);
      assert.equal(ran.stdout, "", label);
    }
  }
});

test("the plans summary says which tree added, removed or moved each stop, by its phase, and an unrecorded list is unavailable (#2340)", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "families-plans-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const side = {
    plan: "p",
    diagnostics: "d",
    checks: 0,
    error: null,
    trace: "1/1/a",
    questions: "1/b",
    units: 1,
  };
  /** A stop list as `heldStops` gives it: each phase's allowances ascending, the phases from the highest down. */
  const stopsOf = (phases: [string, number, number][]) =>
    phases.flatMap(([phase, low, high]) =>
      Array.from({ length: high - low + 1 }, (_, i) => ({ allowance: low + i, phase })),
    );
  // (phase names in neither alphabetical nor allowance order; a phase the base alone has, one the head alone has, one
  // shifted by 43, as #2064's analysis units moved, a record from before #2340 without lists, and phase blocks in
  // another order alone; a malformed list is refused, in the summary's table of faults)
  const walk: [string, number, number] = ["walk", 5, 7];
  const publication: [string, number, number] = ["publication", 1121, 1125];
  const extraction: [string, number, number] = ["extraction", 300, 301];
  const entries: [string, Record<string, unknown>][] = [
    ["removed", { base: stopsOf([publication, walk]), head: stopsOf([publication]) }],
    ["added", { base: stopsOf([publication]), head: stopsOf([publication, extraction]) }],
    [
      "moved",
      { base: stopsOf([publication, walk]), head: stopsOf([["publication", 1164, 1168], walk]) },
    ],
    ["unrecorded", {}],
    ["reordered", { base: stopsOf([publication, walk]), head: stopsOf([walk, publication]) }],
  ];
  const modes = entries.map(([mode, lists]) => ({
    mode,
    base: side,
    head: side,
    same: true,
    stops: {
      count: Array.isArray(lists.base) ? lists.base.length : 1,
      sameSet: false,
      differ: [],
      ...lists,
    },
  }));
  const failing = {
    mode: "failing",
    base: side,
    head: side,
    same: true,
    stops: { unavailable: "the base's unstopped compile failed: Error: no" },
  };
  const file = join(folder, "records.jsonl");
  const record = { set: "held", name: "c", runs: 6, differing: 5, modes: [...modes, failing] };
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  const ran = spawnSync(process.execPath, [tool, "summary", file, "--list", "100"], {
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, ran.stderr);
  const [countsLine, ...lines] = ran.stdout.trim().split("\n");
  const counts = JSON.parse(countsLine!);
  assert.deepEqual(
    ["stopSet", "stopsAdded", "stopsRemoved", "stopsMoved", "stopsUnavailable"].map(
      (key) => counts[key],
    ),
    [5, 1, 1, 1, 3],
  );
  const apart = (mode: string, count: number) =>
    `held c mode "${mode}": STOP SET apart (main ${count} stops)`;
  assert.deepEqual(lines, [
    apart("removed", 8),
    'held c mode "removed": stop phase "walk" removed: base 5..7 (3), head none (0)',
    apart("added", 5),
    'held c mode "added": stop phase "extraction" added: base none (0), head 300..301 (2)',
    apart("moved", 8),
    'held c mode "moved": stop phase "publication" moved: base 1121..1125 (5), head 1164..1168 (5)',
    apart("unrecorded", 1),
    'held c mode "unrecorded": which stops moved is unavailable (no stop lists recorded, a record from before #2340)',
    apart("reordered", 8),
    'held c mode "reordered": which stops moved is unavailable (the lists differ, no phase does)',
    'held c mode "failing": stop set unavailable (the base\'s unstopped compile failed: Error: no)',
  ]);
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
