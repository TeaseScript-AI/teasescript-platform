import assert from "node:assert/strict";
import test from "node:test";

import type { TypePlan } from "../src/plan/model.js";
import { Closure, LeftSlice, Unlisted } from "../src/type-inference/core/admission/closure.js";
import type { ReceivingResult } from "../src/type-inference/core/admission/receiving.js";
import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import {
  WorkLedger,
  withTestAllowance,
  withTestDemandAllowance,
} from "../src/type-inference/core/budget.js";
import { propertyStep } from "../src/type-inference/core/program.js";
import { completedCore, coreRequest } from "./helpers/type-core-analysis.js";
import {
  completionAllowances,
  completionRun,
  completionStopProblems,
} from "./helpers/type-core-completion.js";
import { HELD_MODES } from "./helpers/type-core-held-host.js";
import {
  bisectedIntervals,
  settledIntervals,
  stopCensus,
  type StopRecord,
} from "./helpers/type-core-intervals.js";
import { decisionRecords, inMode, MODES } from "./helpers/type-core-oracles.js";

/*
 * The receiving closure (#1526 phase C steps 1–5, TABLE r4.308; Sol's round 2 §1 and §5): a settled pass that started
 * with frozen keys registers every receiving obligation apart from the diagnostics and completes them in a completion
 * pass without those keys, each decision made where a proof first reads it and each property listing a cell the
 * frontier schedules, taken whole by a search that reaches it. Outside the candidate slice, by its syntax or its depth,
 * no completion runs and the analysis is main's: Astra's C-R1 chain of function results, the function result, an
 * argument, an `add` and a list join are outside its syntax, so the gate's witnesses are the in-slice families (copy
 * chains, shared, wide, ring, mutual) at one doubling; the full series is the PR's evidence, outside CI.
 */

const GLOBALS = ["hostValue", "hostOther"];

/** A list of lists of whole numbers: what each witness's store receives. */
const NESTED: TypePlan = { kind: "list", element: { kind: "list", element: { kind: "integer" } } };

/** As `tests/helpers/type-core-work.ts`'s: linear work doubles; a product of two dimensions about quadruples. */
const DOUBLING = 2.15;

const lines = (k: number, line: (i: number) => string): string =>
  Array.from({ length: k }, (_, i) => line(i)).join("\n");

/** Astra's C-R1 chain: k functions, each returning the preceding one's result through a defaulted parameter. */
function chain(k: number): string {
  return [
    "let a0 = {f: [[1]]}",
    lines(
      k,
      (i) => `function f${i + 1}(x=null) {\n  x=${i === 0 ? "a0" : `f${i}()`}\n  return x\n}`,
    ),
    `let out = f${k}()`,
    "out.f = hostValue",
  ].join("\n");
}

const ending = '\nsay "AFTER"\nexit\n';

/** #1606's shared family: a copy chain of `a`, its last copy copied k times, each copy's `f` given host data. */
const shared = (k: number, root = "a", c = "c", d = "d"): string =>
  `let ${root} = {f: [[1]]}\n${lines(k, (i) => `let ${c}${i} = ${i === 0 ? root : `${c}${i - 1}`}`)}\n${lines(k, (i) => `let ${d}${i} = ${c}${k - 1}\n${d}${i}.f = hostValue`)}`;

/** #1606's wide family: one object of k properties, each given host data. */
const wide = (k: number): string =>
  `let a = {${Array.from({ length: k }, (_, i) => `f${i}: [[${i}]]`).join(", ")}}\n${lines(k, (i) => `a.f${i} = hostValue`)}`;

/** #1606's mutual family: k pairs of mutual copies, the first one's `f` given host data. */
const mutual = (k: number): string =>
  `${lines(k, (i) => `let a${i} = {f: [[1]]}\nlet b${i} = a${i}\na${i} = b${i}`)}\na0.f = hostValue`;

function analyse(source: string, mode: (typeof HELD_MODES)[number], demand = 64): Answers {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  return mode.run(() => withTestDemandAllowance(demand, () => completedCore(request)));
}

/** Whether a slot's site lies within the statement `store` of `source`. */
function within(source: string, store: string, site: { start: number; end: number }): boolean {
  const start = source.indexOf(store);
  return start <= site.start && site.end <= start + store.length;
}

/**
 * The complete-extent result of the obligation whose site lies within the statement `store`, at `path`: the
 * completion's where one ran (a pass that started with frozen keys), else phase B's capture's.
 */
function resultAt(
  answers: Answers,
  source: string,
  store: string,
  path: readonly string[],
): ReceivingResult | undefined {
  const at = (site: { start: number; end: number }, of: readonly string[]): boolean =>
    within(source, store, site) && of.join(".") === path.join(".");
  if (answers.budget.closure === null)
    return answers.contracts.find((c) => at(c.site, c.path))?.result;
  return (
    answers.receiving.find(
      ({ obligation }) =>
        obligation.extent === "complete" && at(obligation.slot.site, obligation.path),
    )?.result ?? undefined
  );
}

const F = [propertyStep("f")];

/** A ring of k copies (#1606's stress family): each listing on it reaches the next, the last the first. */
const ring = (k: number): string =>
  `${lines(k, (i) => `let a${i} = {f: [[1]]}`)}\n${lines(k, (i) => `a${i} = a${(i + 1) % k}`)}\na0.f = hostValue`;

test("an in-slice family whose decisions froze is completed where it freezes, its work linear with every obligation", () => {
  // (each family in every mode where a decision of it freezes at demand 64: the shared and wide families forward, the
  // ring forward with the sharing, the mutual one reversed; the ring's frontier lists and extracts again)
  const families: readonly (readonly [string, (k: number) => string])[] = [
    ["shared", (k) => shared(k)],
    ["wide", wide],
    ["ring", ring],
    ["mutual", mutual],
  ];
  for (const [name, family] of families) {
    let completed = 0;
    for (const mode of HELD_MODES) {
      const sizes = [16, 32].map((k) => analyse(family(k) + ending, mode));
      if (sizes.some((answers) => answers.budget.closure === null)) continue;
      completed += 1;
      const at = `${name}, ${mode.name}`;
      const measured = sizes.map((answers) => {
        // (every obligation of the seed completes: none left without a result)
        assert.deepEqual(
          answers.receiving.filter((r) => r.result === null || r.result.state !== "complete"),
          [],
          at,
        );
        const { counts } = answers.budget.closure!;
        // (each listing listed at most twice: once deferring the keys another listing finds, once taking them; nothing
        // left waiting, no transaction)
        assert.ok(counts.listings <= 2 * counts.cells, `${at}: ${counts.listings} listing runs`);
        assert.equal(counts.unchanged, 0, at);
        assert.equal(counts.transactions, 0, at);
        return {
          counts,
          total: answers.budget.total,
          nodes: answers.budget.counts.get("syntaxNodes")!,
        };
      });
      const [small, large] = [measured[0]!, measured[1]!];
      const scale = large.nodes / small.nodes;
      const grows = (a: number, b: number): number => (2 * (b / Math.max(1, a))) / scale;
      assert.ok(grows(small.total, large.total) <= DOUBLING, `${at}: total`);
      for (const counter of ["decisions", "listings", "edges", "extractions"] as const)
        assert.ok(
          grows(small.counts[counter], large.counts[counter]) <= DOUBLING,
          `${at}: ${counter}`,
        );
    }
    assert.ok(completed > 0, `${name}: some mode freezes a decision`);
  }
});

test("an independent second family completes as it does alone, and a ring lists without waiting on itself", () => {
  for (const mode of HELD_MODES) {
    const alone = analyse(shared(16) + ending, mode).budget.closure;
    if (alone === null) continue;
    const paired = `${shared(16)}\n${shared(16, "e", "g", "h")}${ending}`;
    const both = analyse(paired, mode);
    for (const store of ["d0.f = hostValue", "h0.f = hostValue"]) {
      const result = resultAt(both, paired, store, F);
      assert.ok(result?.state === "complete" && !("shape" in result), `${mode.name}: ${store}`);
      assert.deepEqual(result.ref, NESTED, `${mode.name}: ${store}`);
    }
    // (each family's decisions, listings and taken listings its own: twice the single family's)
    const counts = both.budget.closure!.counts;
    assert.equal(counts.unchanged, 0, mode.name);
    for (const counter of ["decisions", "listings", "taken", "extractions"] as const)
      assert.equal(counts[counter], 2 * alone.counts[counter], `${mode.name}: ${counter}`);
  }
  let ringed = 0;
  for (const mode of HELD_MODES) {
    const source = ring(8) + ending;
    const around = analyse(source, mode, 16);
    if (around.budget.closure === null) continue;
    ringed += 1;
    assert.equal(around.budget.closure.counts.unchanged, 0, `${mode.name}: ring`);
    const a0 = resultAt(around, source, "a0.f = hostValue", F);
    assert.ok(a0?.state === "complete" && !("shape" in a0), `${mode.name}: ring ${a0?.state}`);
    assert.deepEqual(a0.ref, NESTED, `${mode.name}: ring`);
  }
  assert.ok(ringed > 0, "some mode completes the ring");
});

test("a feedback copy's completion lists finitely many keys, each deeper one in the search that reaches it (#1493)", () => {
  // (`w = r.z` feeds a copy back into the object it came from: each listing deferring the next deeper key would never
  // end, so a deeper key is followed in the search that reaches it, whose pump bound ends the chain)
  const source = `let w = {f: 1, z: null}\nlet s = w\nlet r = {f: null, z: null}\nr = s\nw = r.z\nlet c = r${ending}`;
  for (const mode of HELD_MODES) {
    const answers = analyse(source, mode, 16);
    assert.equal(answers.budget.exhausted, null, mode.name);
    const completion = answers.budget.closure;
    assert.ok(completion !== null, mode.name);
    const { counts } = completion;
    assert.ok(counts.listings <= 2 * counts.cells, `${mode.name}: ${counts.listings} listing runs`);
    assert.equal(counts.unchanged, 0, mode.name);
    assert.deepEqual(
      answers.receiving.filter((r) => r.result === null || r.result.state === "lost"),
      [],
      mode.name,
    );
  }
});

test("the copied and direct nested stores owe their checks at every mode's stop", () => {
  // (Astra's round 1 R/Ru witnesses: a destination whose decision read a frozen key has no warning, yet owes; her M2,
  // the unmarked function result, is outside the slice's syntax, a gate witness below)
  const witnesses: readonly (readonly [string, string, readonly string[]])[] = [
    ['let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue' + ending, "b.f = hostValue", F],
    ['let o = {f: [[1]]}\nsay "BEFORE"\no.f = hostValue' + ending, "o.f = hostValue", F],
  ];
  for (const [source, store, path] of witnesses)
    for (const mode of HELD_MODES)
      for (const demand of [16, 64]) {
        const answers = analyse(source, mode, demand);
        const result = resultAt(answers, source, store, path);
        const at = `${store}, ${mode.name}, demand ${demand}`;
        assert.ok(result !== undefined, `${at}: registered`);
        assert.ok(result.state === "complete" && !("shape" in result), `${at}: ${result.state}`);
        assert.deepEqual(result.ref, NESTED, at);
      }
});

/**
 * Programs outside the candidate slice's syntax, a decision of each freezing: a function's result chain (Astra's C-R1),
 * the unmarked function result (her M2), a checked argument and return, an `add`, a list join, a compound assignment and
 * an interpolation. The candidate route declines them, and the analysis is main's: no receiving obligation, no
 * completion, and every unit charged as on `main` at `92a970442`, its event searches charged by comparison since #1221
 * no narrowing index made for a program without a test since #1251, and a read signature's prefixes found by its charged trie walk since #1822 (`rdWalk`, 1–6 units more on four rows; a regression oracle of this gate only), and the route rule's queries since #1073 PR 4 (AD-1: a possible null's route asked at its use, on the rows that have one), at demand 16 and 64 in the four modes (each list: demand 16's four modes,
 * then 64's).
 */
const frozen = `let a = {f: [[1]]}\nlet b = a\n${lines(16, (i) => `b = {f: [[${i}]]}`)}\nb.f = hostValue`;
const OUTSIDE: readonly (readonly [string, string, readonly number[]])[] = [
  ["the C-R1 chain", chain(16), [11837, 12196, 11837, 12196, 19412, 13621, 19433, 13621]],
  [
    "the unmarked function result",
    'function make {\n  let r = {nest: {n: [[1]]}}\n  return r\n}\nlet out = make()\nsay "BEFORE"\nout.nest.n = hostValue',
    [1539, 1617, 1539, 1617, 2424, 2149, 2289, 2149],
  ],
  // (at demand 64, a few units more since #1073 PR 2: a consumer's descendant demand looks up its path's narrowing)
  [
    "a checked argument",
    `${chain(4)}\nfunction take(x: integer[]) { }\nlet maybe = null\nif hostValue { maybe = [1] }\ntake(maybe)`,
    [4958, 5684, 4958, 5412, 7650, 6689, 7671, 6417],
  ],
  // (the same lookup's units at demand 64, #1073 PR 2)
  [
    "a checked return",
    `${chain(4)}\nfunction give: integer[] {\n  let maybe = null\n  if hostValue { maybe = [1] }\n  return maybe\n}\nlet got = give()`,
    [5090, 5789, 5090, 5516, 7394, 6862, 7285, 6589],
  ],
  ["an add", "let b = [[1]]\nb.add(hostValue)", [684, 1020, 684, 852, 1071, 1198, 1002, 1121]],
  // (18 units more at demand 64 since #1828: the mixed join's sentence walks each operand to its leaf and reads its
  // occurrence there, its decider asked once with `decidedAt`'s, Codex r2 on #1899)
  [
    "a list join",
    `${frozen}\nlet xs = [1]\nlet ys = ["s"]\nb.f = [xs + ys]`,
    [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],
  ],
  [
    "a compound assignment",
    `${frozen}\nlet n = 1\nn += 1`,
    [18994, 19136, 18864, 19006, 20720, 22181, 20460, 21814],
  ],
  [
    "an interpolation",
    `${frozen}\nsay "n \${b.f}"`,
    [19238, 19354, 19108, 19224, 20963, 22390, 20703, 22030],
  ],
];

test("outside the slice's syntax the analysis is main's: no inventory, no completion, main's charges (#1526 phase C)", () => {
  for (const [name, body, totals] of OUTSIDE) {
    const source = body + ending;
    let at = 0;
    let froze = 0;
    for (const demand of [16, 64])
      for (const mode of HELD_MODES) {
        const answers = analyse(source, mode, demand);
        const where = `${name}, ${mode.name}, demand ${demand}`;
        if (answers.budget.decisions.some((d) => d.stopped)) froze += 1;
        assert.equal(answers.budget.closure, null, where);
        assert.deepEqual(answers.receiving, [], where);
        assert.equal(answers.budget.total, totals[at], where);
        at += 1;
      }
    assert.ok(froze > 0, `${name}: a decision freezes`);
  }
});

test("a receiving obligation's extent is its store's form's (D1)", () => {
  // (an ingress's slot and the store's other slots alike, but where host data lands inside a whole stored value: there
  // the store owes the whole contract, its ingress the subpath it lands at)
  const rows: readonly (readonly [
    string,
    string,
    readonly (readonly [string, string])[],
    (readonly (readonly [string, string])[])?,
  ])[] = [
    // (a leaf owes its contract and its receiver's shape, never a sibling's contract)
    [
      'let b = {f: [[1]], spare: ["s"]}\nb.f = hostValue',
      "b.f = hostValue",
      [
        ["shape", ""],
        ["complete", "f"],
      ],
    ],
    // (a whole store owes the whole contract)
    ["let b = {f: [[1]]}\nb = hostValue", "b = hostValue", [["complete", ""]]],
    // (a property below an element owes the shapes above it)
    [
      "let b = [{f: [1]}]\nb[0].f = hostValue",
      "b[0].f = hostValue",
      [
        ["shape", ""],
        ["shape", "element"],
        ["complete", "element.f"],
      ],
    ],
    // (host data inside a whole stored value owes the subpath it lands at)
    [
      "let b = {f: [[1]], g: 2}\nb = {f: hostValue, g: 3}",
      "b = {f: hostValue, g: 3}",
      [
        ["shape", ""],
        ["complete", "f"],
      ],
      [["complete", ""]],
    ],
    // (an add, outside the slice's syntax, is a gate witness: `OUTSIDE`)
  ];
  for (const [body, store, expected, others = expected] of rows) {
    const source = body + ending;
    let checked = 0;
    for (const mode of HELD_MODES)
      for (const demand of [16, 64]) {
        const answers = analyse(source, mode, demand);
        // (the obligations are registered where a completion runs: a settled pass that started with frozen keys)
        if (answers.budget.closure === null) continue;
        checked += 1;
        // (each role's slots at the store bound alike: a warning's, a stopped decision's, an ingress's)
        const roles = new Map<string, [string, string][]>();
        for (const { obligation } of answers.receiving) {
          if (!within(source, store, obligation.slot.site)) continue;
          const list = roles.get(obligation.slot.role) ?? [];
          list.push([obligation.extent, obligation.path.join(".")]);
          roles.set(obligation.slot.role, list);
        }
        assert.ok(roles.has("ingress"), `${store}, ${mode.name}, demand ${demand}`);
        for (const [role, found] of roles)
          assert.deepEqual(
            found,
            role === "ingress" ? expected : others,
            `${store}, ${role}, ${mode.name}, demand ${demand}`,
          );
      }
    assert.ok(checked > 0, `${store}: some mode completes`);
  }
});

/** A6: `b` decided an object by its start value, k whole stores beside it, and a scalar store that does not fit. */
const rejecting = (k: number): string =>
  `let b = {f0: 1}\n${lines(k, (i) => `b = {f0: ${i}}`)}\nb = 5\nb.f0 = hostValue${ending}`;

/** #1275: `box` holds objects only, so `box.first` is its own property; while `box` is frozen, a list's element. */
const retargeting = (k: number): string =>
  `let box = {first: {n: [[1]]}}\n${lines(k, (i) => `box = {first: {n: [[${i}]]}}`)}\nbox.first.n = hostValue${ending}`;

test("a completion decision that would reject a store or retarget a selecting store leaves every obligation lost (A6, #1275)", () => {
  // (per case, the stores whose obligations a decision's proof read; and every other obligation, which a rejected or a
  // moved store's value may reach through a copy or a wrapper, Codex r2's: all lost, none completed wider)
  const copied = (mid: string, tail: string): string =>
    `let b = {f: [[1]], first: {n: [[1]]}}\n${lines(16, (i) => `b = {f: [[${i}]], first: {n: [[${i}]]}}`)}\n${mid}\n${tail}${ending}`;
  const cases: readonly (readonly [string, string, readonly string[]])[] = [
    [rejecting(16), "rejection", ["b = 5", "b.f0 = hostValue"]],
    [retargeting(16), "retarget", ["box.first.n = hostValue"]],
    [copied('b.f = "s"', "let c = b.f\nc = hostValue"), "rejection", ["c = hostValue"]],
    [copied('b.f = "s"', "let c = {q: b}\nc.q = hostValue"), "rejection", ["c.q = hostValue"]],
    // (a list join, outside the slice's syntax, is a gate witness: `OUTSIDE`)
    [
      "let b = {first: {n: null}}\nb.first.n = [[1]]\nlet c = {q: b}\nc.q = hostValue" + ending,
      "retarget",
      ["c.q = hostValue"],
    ],
  ];
  const shown = (result: ReceivingResult | null): string =>
    result === null ? "none" : result.state === "lost" ? `lost/${result.cause}` : result.state;
  for (const [source, cause, stores] of cases) {
    let checked = 0;
    for (const mode of HELD_MODES)
      for (const demand of [16, 64]) {
        const answers = analyse(source, mode, demand);
        const at = `${cause}, ${stores[0]}, ${mode.name}, demand ${demand}`;
        const completion = answers.budget.closure;
        if (completion === null || completion.counts.unsettled === 0) continue;
        checked += 1;
        // (the settled pass stands: the stopped stores keep their marks, no store is refused)
        assert.deepEqual(
          answers.diagnostics.filter((d) => d.class === "compile-error"),
          [],
          at,
        );
        assert.ok(completion.counts.forgone > 0, `${at}: what the loss forgoes, counted`);
        // (and none of its own store checks' obligations, which a store's part checks would read: #1682)
        assert.deepEqual(answers.completedWarnings(), [], at);
        // (every obligation lost, the stores' own among them, never completed against a wider contract)
        assert.deepEqual(
          [...new Set(answers.receiving.map(({ result }) => shown(result).split("/")[0]))],
          ["lost"],
          at,
        );
        for (const store of stores) {
          const owed = answers.receiving.filter(({ obligation }) =>
            within(source, store, obligation.slot.site),
          );
          assert.ok(owed.length > 0, `${at}: ${store} owes`);
          assert.deepEqual(
            [...new Set(owed.map(({ result }) => shown(result)))],
            [`lost/${cause}`],
            at,
          );
        }
      }
    assert.ok(checked > 0, `${cause}, ${stores[0]}: some mode marks a decision`);
  }
});

test("after the capture left the slice's depth no receiving inventory or completion is made (#1526 phase C)", () => {
  // (a literal 260 objects deep, its host store's decision made, beside a copy whose 300 stores freeze it: the capture
  // ends at the literal's contract, where the program leaves the slice, and the completion follows it; forward, the
  // demand allowance that decides the one and freezes the other)
  const deep = `let d = ${"{q: ".repeat(260)}1${"}".repeat(260)}\nd = hostValue`;
  const heavy = `let x = {f: [[1]]}\nlet y = x\n${lines(300, (i) => `y = {f: [[${i}]]}`)}\ny.f = hostValue`;
  const answers = analyse(`${deep}\n${heavy}${ending}`, HELD_MODES[0]!, 16000);
  assert.ok(answers.budget.decisions.some((d) => d.stopped));
  assert.equal(answers.budget.closure, null);
  assert.deepEqual(answers.receiving, []);
});

test("a completion ends at the first request that reaches the slice's depth, keeping no result (#1526 phase C)", () => {
  // (graph/533's shape: two cyclic stores and a selection of either, first, beside a frozen copy of 4,000 stores; a
  // contract that reaches the slice's depth means the program has left the slice, as phase B's capture ends there too;
  // its one walk there, about 5.5 M units and 660 more per frozen store, fits the completion's allowance only beside a
  // settled pass of half that, at about 1,190 units per frozen store: past 3,200 of them, so 4,000, forward)
  const frozen = `let x = {f: [[1]]}\nlet y = x\n${lines(4000, (i) => `y = {f: [[${i}]]}`)}\ny.f = hostValue`;
  const source = `let a = {q: null}\nlet b = {q: null}\na.q = b\nb.q = a\nlet c = [a, b][0]\nc.q = hostValue\n${frozen}${ending}`;
  for (const mode of HELD_MODES.slice(0, 1)) {
    const answers = analyse(source, mode, 16);
    const completion = answers.budget.closure;
    assert.ok(completion !== null, mode.name);
    assert.equal(completion.counts.leftSlice, 1, mode.name);
    assert.equal(completion.counts.capped, 0, mode.name);
    // (no A6/#1275 check ran: nothing is marked, lost by it or forgone)
    assert.deepEqual(
      [completion.counts.marked, completion.counts.unsettled, completion.counts.forgone],
      [0, 0, 0],
      mode.name,
    );
    assert.ok(answers.receiving.length > 0, mode.name);
    assert.deepEqual(
      answers.receiving.filter(({ result }) => result !== null),
      [],
      mode.name,
    );
  }
});

/**
 * The completion's allowance: twice what the analysis charged before it, so an analysis with its completion at most
 * triples. Past it the completion ends and keeps no result, every obligation without one and phase B's plan standing.
 * The shapes whose completion costs more: a directed copy chain (its frontier walks each cyclic contract again per
 * listing), #1606's W15 (2,123 scoped decisions at size 1024, each scanning its stores again) and S8's whole stores into
 * one place (fields: 932 decisions at 1024), each at a small size, at demand 16 in the four modes.
 */
const rowsOf = (k: number, f: (i: number) => string): string => lines(k, f);
const directed = (k: number): string =>
  [
    "let a0={x:null,n:1}",
    "let b0={x:null,y:null,n:1}",
    "a0=b0",
    "b0.y=a0",
    rowsOf(k, (i) =>
      [
        `let a${i + 1}={x:null,n:1}`,
        `let b${i + 1}={x:null,n:1}`,
        `a${i + 1}=a${i}.x`,
        `a${i}.x=a${i + 1}`,
        `b${i + 1}=b${i}.x`,
        `b${i}.x=b${i + 1}`,
      ].join("\n"),
    ),
    "let c=a0",
  ].join("\n");
const w15 = (k: number): string =>
  [
    `let seed = {${Array.from({ length: k }, (_, i) => `f${i}: 0`).join(", ")}}`,
    "let state = seed",
    rowsOf(
      k,
      (i) => `let preset${i} = seed\npreset${i}.f${i} = 1\npreset${i}.f${(i * 7 + 3) % k} = 2`,
    ),
    rowsOf(k, (i) => `if hostFlag { state = preset${i} }`),
    rowsOf(k, (i) => `let shown${i}: integer = state.f${i}`),
  ].join("\n");
const fields = (k: number): string =>
  `let b = {f0: 1}\n${rowsOf(k, (i) => `b = {f${i}: ${i}}`)}\nb = hostValue`;

/** The in-slice witnesses: #1556, #1526, the direct store, the ring at 8 and #1493's feedback copy. */
const WITNESSES: readonly string[] = [
  'let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue',
  'let root={f:[[1]], extra:42}\nlet w0={entry:root}\nlet w1={shell:w0}\nlet w2={entry:w1}\nlet old=w2.entry.shell.entry\nsay "BEFORE"\nw2.entry.shell.entry.f=hostValue',
  'let o = {f: [[1]]}\nsay "BEFORE"\no.f = hostValue',
  ring(8),
  "let w = {f: 1, z: null}\nlet s = w\nlet r = {f: null, z: null}\nr = s\nw = r.z\nlet c = r",
];

test("a completion past its allowance ends and keeps no result, the analysis at most three times its settled work (#1526 phase C)", () => {
  for (const [name, body] of [
    ["a directed copy chain at 4", directed(4)],
    ["W15 at 256", w15(256)],
    ["whole stores into one place at 64", fields(64)],
  ] as const) {
    const source = body + ending;
    const request = coreRequest([{ path: "main.tease", source }], [...GLOBALS, "hostFlag"]);
    assert.ok(request !== null, name);
    for (const mode of HELD_MODES) {
      const answers: Answers = mode.run(() =>
        withTestDemandAllowance(16, () => completedCore(request)),
      );
      const at = `${name}, ${mode.name}`;
      const completion = answers.budget.closure;
      assert.ok(completion !== null, at);
      assert.equal(completion.counts.capped, 1, at);
      assert.equal(completion.counts.cappedAt, completion.units, at);
      // (no stop: the analysis settles, its work at most three times what it charged before the completion)
      assert.equal(answers.budget.exhausted, null, at);
      assert.equal(answers.budget.stoppedIn, null, at);
      assert.ok(answers.budget.total <= 3 * (answers.budget.total - completion.units), at);
      assert.ok(answers.receiving.length > 0, at);
      assert.deepEqual(
        answers.receiving.filter(({ result }) => result !== null),
        [],
        at,
      );
      // (nothing of it kept: no decision's record, no completed check)
      assert.deepEqual(completion.decisions, [], at);
      assert.ok(
        answers.receiving.every(({ obligation }) => !answers.completedCheck(obligation.slot.site)),
        at,
      );
      assert.deepEqual(answers.completedWarnings(), [], at);
    }
  }
});

test("a completion that reaches its allowance in the questions asked again keeps none of its store warnings (#1682)", () => {
  // (Codex r1's N3 on #1690: the warnings published, read by the questions asked again, then the allowance reached there)
  const source =
    'let seed: integer = 7\nlet copy = hostInit\ncopy.open = seed\ncopy = hostValue\nsay "REACHED"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostInit", "hostValue"]);
  assert.ok(request !== null);
  const charge = WorkLedger.prototype.charge;
  let ledger: WorkLedger | null = null;
  WorkLedger.prototype.charge = function (this: WorkLedger, ...args) {
    ledger = this;
    return charge.apply(this, args);
  };
  try {
    withTestDemandAllowance(16, () => {
      const answers = analyseCore(request);
      let published = 0;
      const again = answers.completed(() => {
        published = answers.completedWarnings().length;
        ledger!.charge("checks", 1e9);
        return true;
      });
      assert.ok(published > 0);
      assert.equal(again, null);
      assert.equal(answers.budget.closure?.counts.capped, 1);
      assert.deepEqual(answers.completedWarnings(), []);
    });
  } finally {
    WorkLedger.prototype.charge = charge;
  }
});

/**
 * The completion's place (the lead's ruling on #1637): after everything that can stop, the questions included, within
 * the smaller of twice the work before it and what is left of the total, so it never makes or moves a stop. At each
 * allowance the compile with it stops exactly as phase B's (the same compile without it) does, compiles the same where
 * they stop, and where it does not stop charges no more than the allowance: the witnesses in every mode, the capped
 * shapes forward, at demand 16, a sample of the allowances near either end (the compile without the completion's and the
 * head's) and below (`completionAllowances`; all of them in the sweep, every allowance on the queue).
 */
test("the completion never makes or moves a stop: at each allowance the compile stops as phase B's (#1526 phase C)", () => {
  const cases: readonly (readonly [
    string,
    readonly (typeof HELD_MODES)[number][],
    number,
    number,
  ])[] = [
    ...WITNESSES.map((body) => [body, HELD_MODES, 12, 16] as const),
    [directed(4), HELD_MODES.slice(0, 1), 8, 8],
    [fields(64), HELD_MODES.slice(0, 1), 8, 8],
    [w15(128), HELD_MODES.slice(0, 1), 4, 2],
  ];
  for (const [body, modes, samples, band] of cases) {
    const request = coreRequest(
      [{ path: "main.tease", source: body + ending }],
      [...GLOBALS, "hostFlag"],
    );
    assert.ok(request !== null, body);
    for (const mode of modes) {
      const head = completionRun(request, mode, 16, undefined, true);
      const at = `${body.split("\n").at(-1)}, ${mode.name}`;
      assert.ok(head.completed, at);
      const step = Math.max(1, Math.ceil(head.total / samples));
      assert.deepEqual(
        completionStopProblems(
          request,
          mode,
          16,
          completionAllowances(request, mode, 16, step, band),
        ),
        [],
        at,
      );
    }
  }
});

test("the in-slice witnesses complete within the allowance at demand 16 and 64 in every mode (#1526 phase C)", () => {
  // (the largest need: the direct store's 1,237 units against its settled 858, 1.44 times, forward at demand 16)
  for (const body of WITNESSES) {
    const source = body + ending;
    let completed = 0;
    for (const mode of HELD_MODES)
      for (const demand of [16, 64]) {
        const answers = analyse(source, mode, demand);
        const completion = answers.budget.closure;
        if (completion === null) continue;
        completed += 1;
        const at = `${body.split("\n").at(-1)}, ${mode.name}, demand ${demand}`;
        assert.equal(completion.counts.capped, 0, at);
        assert.ok(completion.units <= 2 * (answers.budget.total - completion.units), at);
        assert.deepEqual(
          answers.receiving.filter(({ result }) => result === null),
          [],
          at,
        );
      }
    assert.ok(completed > 0, `${body.split("\n").at(-1)}: some mode completes`);
  }
});

test("every settled stop interval is enumerated, its epoch's own (C-R2's census)", () => {
  // (the shared family with its copies' decisions frozen, and #1556's witness, whose capture's extraction is a settled
  // phase; every allowance below the total read once, against the bisection the held host's stops come from; the
  // receiving completion runs after everything that can stop, so it has no interval)
  // (each in one mode: the family forward, where its copies' decisions froze, and the witness forward)
  const cases: readonly (readonly [
    string,
    number | undefined,
    (typeof HELD_MODES)[number],
    boolean,
  ])[] = [
    [shared(2) + ending, 64, HELD_MODES[0]!, false],
    [
      'let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue' + ending,
      undefined,
      HELD_MODES[0]!,
      true,
    ],
  ];
  for (const [source, demand, mode, extraction] of cases) {
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    const capped = <T>(make: () => T): T =>
      demand === undefined ? make() : withTestDemandAllowance(demand, make);
    const unstopped = mode.run(() => capped(() => analyseCore(request)));
    const records = new Map<number, StopRecord>();
    const recordAt = (allowance: number): StopRecord => {
      let record = records.get(allowance);
      if (record === undefined) {
        const { budget, epoch } = mode.run(() =>
          withTestAllowance(allowance, () => capped(() => analyseCore(request))),
        );
        record = { settled: budget.settled, epoch, phase: budget.stoppedIn };
        records.set(allowance, record);
      }
      return record;
    };
    const census = settledIntervals(stopCensus(unstopped.budget.total, recordAt));
    const at = `${source.split("\n")[0]}, ${mode.name}`;
    assert.equal(
      census.some((interval) => interval.phase === "extraction"),
      extraction,
      at,
    );
    // (one interval a phase, each of the final epoch)
    assert.deepEqual(
      census.map((interval) => interval.epoch),
      census.map(() => unstopped.epoch),
      at,
    );
    assert.deepEqual(bisectedIntervals(unstopped.budget.total, recordAt), census, at);
  }
});

test("the frontier lists a chain from its far end, each listing twice at most, and wakes an item only when its stamp is made", () => {
  const work = new WorkLedger(1_000_000);
  // (listings of a, b, c, d: a's search defers b and c, b's defers d; a request needs a's)
  const sources: Readonly<Record<string, readonly string[]>> = {
    a: ["b", "c"],
    b: ["d"],
    c: [],
    d: [],
  };
  const made = new Set<string>();
  const runs: string[] = [];
  const closure = new Closure(work);
  let extracted = 0;
  closure.run({
    requests: 1,
    extract: () => {
      extracted += 1;
      if (!made.has("a")) throw new Unlisted("a", ["b", "c"]);
    },
    list: (key) => {
      runs.push(key);
      const deferred = sources[key]!.filter((below) => !made.has(below));
      if (deferred.length > 0) return { deferred };
      made.add(key);
      return new Set([key]);
    },
    listed: (key) => made.has(key),
  });
  // (the far end first; a listed once its stamp, b and c both, is made; the request extracted again once)
  assert.deepEqual(runs, ["b", "d", "b", "c", "a"]);
  assert.equal(extracted, 2);
  assert.equal(closure.counts.unchanged, 0);
  // (a cycle: x's search defers y, y's reaches x parked and follows it)
  const cyclic = new Closure(work);
  const done = new Set<string>();
  cyclic.run({
    requests: 1,
    extract: () => {
      if (!done.has("x")) throw new Unlisted("x", ["y"]);
    },
    list: (key) => {
      if (key === "y" && !done.has("x") && !cyclic.parked("x")) return { deferred: ["x"] };
      done.add(key);
      return new Set([key]);
    },
    listed: (key) => done.has(key),
  });
  assert.ok(done.has("x") && done.has("y"));
  assert.equal(cyclic.counts.unchanged, 0);
  // (a request that ends the run, `LeftSlice`, while a listing is parked: the frontier's views are released all the same)
  const ended = new Closure(work);
  assert.throws(
    () =>
      ended.run({
        requests: 2,
        extract: (index) => {
          if (index === 0) throw new Unlisted("p", ["q"]);
          assert.ok(ended.parked("p"));
          throw new LeftSlice();
        },
        list: () => ({ deferred: ["q"] }),
        listed: () => false,
      }),
    LeftSlice,
  );
  assert.equal(ended.parked("p"), false);
});

test("a decision made after a cell read it unmade invalidates that cell and what read it, once, and nothing after close", () => {
  const work = new WorkLedger(1_000_000);
  const cleared: string[] = [];
  const closure = new Closure(work);
  closure.handle("request", (name) => cleared.push(`x:${name}`));
  closure.handle("extent", (name) => cleared.push(`a:${name}`));
  // (a diamond: the request reads the extents p and q, both read the decision k unmade; an unrelated request reads u)
  closure.within("request", "0", () => {
    closure.within("extent", "p", () => closure.took("decision", "k"));
    closure.within("extent", "q", () => closure.took("decision", "k"));
  });
  assert.deepEqual(closure.made("decision", "u"), []);
  closure.within("request", "1", () => closure.took("decision", "u"));
  const before = closure.counts.visits;
  // (k made now: p, q and the request, each once, not the unrelated one, which read u made)
  assert.deepEqual(closure.made("decision", "k"), ["0"]);
  assert.equal(closure.counts.visits - before, 3);
  assert.deepEqual(cleared.sort(), ["a:p", "a:q", "x:0"]);
  assert.equal(closure.counts.transactions, 1);
  // (made again: nothing read it since)
  assert.deepEqual(closure.made("decision", "k"), []);
  closure.close();
  assert.ok(!closure.open);
  assert.deepEqual(closure.made("decision", "v"), []);
});

test("the public route's receiving completion makes the decisions the analysis's own completion makes (#1685's debit probe)", () => {
  // (Astra's witness on #1685: at demand allowance 16 a second pass settles and its receiving completion decides)
  const source = [
    "let t:integer=1",
    "let r0={same:t,nest:{same:t}}",
    "let r1={same:t,nest:{same:t}}",
    "let raw={same:1,nest:{same:hostValue}}",
    "let a=[r0,r1,r0,r1,raw]",
    "let b=[raw,r1,r0]",
    "repeat a[0].nest.same {}",
    "repeat b[0].nest.same {}",
    "exit",
    "",
  ].join("\n");
  const files = [{ path: "main.tease", source }];
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const own = ({ allowance: _, ...rest }: { readonly allowance: number }) => rest;
  for (const mode of MODES) {
    const at = JSON.stringify(mode);
    const routed = decisionRecords(files, GLOBALS, {
      mode,
      demand: 16,
      require: ["ordinary", "completion"],
    });
    const answers: Answers = inMode(mode, () =>
      withTestDemandAllowance(16, () => completedCore(request)),
    );
    assert.deepEqual(routed.ordinary.at(-1), answers.budget.decisions, at);
    // (the same decisions, units and stops; what was left of the program's allowance is less after the route's questions)
    assert.equal(routed.completion.length, 1, at);
    assert.deepEqual(
      routed.completion[0]!.map(own),
      answers.budget.closure!.decisions.map(own),
      at,
    );
  }
  // (a compile inside one, as a source's getter can start, is refused: its records would be the outer compile's too)
  const nested = {
    path: "main.tease",
    get source() {
      decisionRecords(files, GLOBALS, { demand: 16 });
      return "let x = 1\nexit\n";
    },
  };
  assert.throws(() => decisionRecords([nested], GLOBALS), /already recording a compile/);
  // (a compile with no completion reads no completion record: required, it fails rather than compare nothing)
  assert.throws(
    () =>
      decisionRecords([{ path: "main.tease", source: "let x = 1\nexit\n" }], GLOBALS, {
        require: ["completion"],
      }),
    /No completion decision record was read/,
  );
});
