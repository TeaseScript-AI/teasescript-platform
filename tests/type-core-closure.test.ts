import assert from "node:assert/strict";
import test from "node:test";

import type { TypePlan } from "../src/plan/model.js";
import { Closure, Unlisted } from "../src/type-inference/core/admission/closure.js";
import type { ReceivingResult } from "../src/type-inference/core/admission/receiving.js";
import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import {
  WorkLedger,
  withTestAllowance,
  withTestDemandAllowance,
} from "../src/type-inference/core/budget.js";
import { propertyStep } from "../src/type-inference/core/program.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { HELD_MODES } from "./helpers/type-core-held-host.js";
import {
  bisectedIntervals,
  settledIntervals,
  stopCensus,
  type StopRecord,
} from "./helpers/type-core-intervals.js";

/*
 * The receiving closure (#1526 phase C steps 1–4, TABLE r4.308; Sol's round 2 §1 and §5): a settled pass that started
 * with frozen keys registers every receiving obligation apart from the diagnostics and completes them in a completion
 * pass without those keys, each decision made where a proof first reads it and each property listing a cell the
 * frontier schedules, taken whole by a search that reaches it. The gate's witnesses (Astra's C-R1 chain of function
 * results, an independent sibling, a pair of chains, a ring) at one doubling; the full series is the PR's evidence,
 * outside CI.
 */

const GLOBALS = ["hostValue", "hostOther"];

/** A list of lists of whole numbers: what each witness's store receives. */
const NESTED: TypePlan = { kind: "list", element: { kind: "list", element: { kind: "integer" } } };

/** As `type-core-work`'s: linear work doubles; a product of two dimensions about quadruples. */
const DOUBLING = 2.15;

const lines = (k: number, line: (i: number) => string): string =>
  Array.from({ length: k }, (_, i) => line(i)).join("\n");

/** Astra's C-R1 chain: k functions, each returning the preceding one's result through a defaulted parameter. */
function chain(k: number, name = "f", root = "a0", out = "out"): string {
  return [
    `let ${root} = {f: [[1]]}`,
    lines(
      k,
      (i) =>
        `function ${name}${i + 1}(x=null) {\n  x=${i === 0 ? root : `${name}${i}()`}\n  return x\n}`,
    ),
    `let ${out} = ${name}${k}()`,
    `${out}.f = hostValue`,
  ].join("\n");
}

const ending = '\nsay "AFTER"\nexit\n';

/** The chain beside an independent sibling whose own store owes its check. */
const sibling = (k: number): string =>
  `let steady = {g: [[1]]}\nsteady.g = hostValue\n${chain(k)}${ending}`;

/** Two independent chains, each with its own store: each completes as it does alone. */
const pair = (k: number): string =>
  `${chain(k, "f", "a0", "out")}\n${chain(k, "g", "b0", "other")}${ending}`;

function analyse(source: string, mode: (typeof HELD_MODES)[number], demand = 64): Answers {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  return mode.run(() => withTestDemandAllowance(demand, () => analyseCore(request)));
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
  `${lines(k, (i) => `let a${i} = {f: [[1]]}`)}\n${lines(k, (i) => `a${i} = a${(i + 1) % k}`)}\na0.f = hostValue${ending}`;

test("a chain of results whose decisions froze is completed in every mode, its work linear with every obligation (C-R1)", () => {
  for (const mode of HELD_MODES) {
    const sizes = [16, 32].map((k) => {
      const source = chain(k) + ending;
      const answers = analyse(source, mode);
      const at = `${mode.name}, k = ${k}`;
      const result = resultAt(answers, source, "out.f = hostValue", F);
      assert.ok(result?.state === "complete" && !("shape" in result), `${at}: ${result?.state}`);
      assert.deepEqual(result.ref, NESTED, at);
      // (the stopped decisions' stores owe their obligations, by the marks the stop gave them)
      assert.ok(
        answers.receiving.some(({ obligation }) => obligation.slot.role === "stopped"),
        `${at}: a stopped store's slot`,
      );
      // (every obligation of the seed completes, the stopped stores' among them: none left without a result)
      assert.deepEqual(
        answers.receiving.filter((r) => r.result === null || r.result.state !== "complete"),
        [],
        at,
      );
      const completion = answers.budget.closure;
      assert.ok(completion !== null, at);
      const { counts } = completion;
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
    const small = sizes[0]!;
    const large = sizes[1]!;
    const scale = large.nodes / small.nodes;
    const grows = (a: number, b: number): number => (2 * (b / Math.max(1, a))) / scale;
    // (the aggregate with the full seed, and the completion's own counts)
    assert.ok(grows(small.total, large.total) <= DOUBLING, `${mode.name}: total`);
    for (const counter of ["decisions", "listings", "edges", "extractions"] as const)
      assert.ok(
        grows(small.counts[counter], large.counts[counter]) <= DOUBLING,
        `${mode.name}: ${counter}`,
      );
  }
});

test("an independent sibling and a second chain complete as they do alone, and a ring lists without waiting on itself", () => {
  for (const mode of HELD_MODES) {
    const source = sibling(16);
    const answers = analyse(source, mode);
    const steady = resultAt(answers, source, "steady.g = hostValue", [propertyStep("g")]);
    assert.ok(steady?.state === "complete" && !("shape" in steady), mode.name);
    assert.deepEqual(steady.ref, NESTED, mode.name);
    const out = resultAt(answers, source, "out.f = hostValue", F);
    assert.ok(out?.state === "complete" && !("shape" in out), mode.name);
    const paired = pair(16);
    const both = analyse(paired, mode);
    for (const store of ["out.f = hostValue", "other.f = hostValue"]) {
      const result = resultAt(both, paired, store, F);
      assert.ok(result?.state === "complete" && !("shape" in result), `${mode.name}: ${store}`);
      assert.deepEqual(result.ref, NESTED, `${mode.name}: ${store}`);
    }
    // (each chain's listings and decisions its own: twice the single chain's)
    const counts = both.budget.closure!.counts;
    const alone = analyse(chain(16) + ending, mode).budget.closure!.counts;
    assert.equal(counts.unchanged, 0, mode.name);
    assert.equal(counts.listings, 2 * alone.listings, mode.name);
    assert.equal(counts.decisions, 2 * alone.decisions, mode.name);
    const ringed = ring(8);
    const around = analyse(ringed, mode, 16);
    if (around.budget.closure === null) continue;
    assert.equal(around.budget.closure.counts.unchanged, 0, `${mode.name}: ring`);
    const a0 = resultAt(around, ringed, "a0.f = hostValue", F);
    assert.ok(a0?.state === "complete" && !("shape" in a0), `${mode.name}: ring ${a0?.state}`);
    assert.deepEqual(a0.ref, NESTED, `${mode.name}: ring`);
  }
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

test("the unmarked function result and the copied and direct nested stores owe their checks at every mode's stop", () => {
  // (Astra's round 1 M2 and R/Ru witnesses: a destination whose decision read a frozen key has no warning, yet owes)
  const witnesses: readonly (readonly [string, string, readonly string[]])[] = [
    [
      'function make {\n  let r = {nest: {n: [[1]]}}\n  return r\n}\nlet out = make()\nsay "BEFORE"\nout.nest.n = hostValue' +
        ending,
      "out.nest.n = hostValue",
      [propertyStep("nest"), propertyStep("n")],
    ],
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

test("an argument and a return owe their checks as a store does, each its own destination (#1526 phase C)", () => {
  // (Codex r1: a checked argument or return is a transfer, not a store; its warning's site owes its obligation too)
  const cases = [
    [
      "function take(x: integer[]) { }\nlet maybe = null\nif hostValue { maybe = [1] }\ntake(maybe)",
      "take(maybe)",
    ],
    [
      "function give: integer[] {\n  let maybe = null\n  if hostValue { maybe = [1] }\n  return maybe\n}\nlet got = give()",
      "return maybe",
    ],
  ] as const;
  for (const [body, store] of cases) {
    const source = `${chain(4)}\n${body}${ending}`;
    let checked = 0;
    for (const mode of HELD_MODES)
      for (const demand of [16, 64]) {
        const answers = analyse(source, mode, demand);
        if (answers.budget.closure === null) continue;
        checked += 1;
        const at = `${store}, ${mode.name}, demand ${demand}`;
        const owed = answers.receiving.filter(({ obligation }) =>
          within(source, store, obligation.slot.site),
        );
        assert.ok(owed.length > 0, `${at}: owes`);
        assert.ok(
          owed.every(({ result }) => result !== null),
          `${at}: ${JSON.stringify(owed.map(({ result }) => result))}`,
        );
      }
    assert.ok(checked > 0, `${store}: some mode completes`);
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
    // (an add owes its element's contract and its list's shape)
    [
      "let b = [[1]]\nb.add(hostValue)",
      "b.add(hostValue)",
      [
        ["shape", ""],
        ["complete", "element"],
      ],
    ],
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
    // (a join's operand, rejected outside every decision's check: where the settled pass's own join check rejects it,
    // it stands there and the completion completes, unwidened)
    [
      copied('let xs = [1]\nlet ys = ["s"]\nb.f = [xs + ys]', "let c = b\nc = hostValue"),
      "rejection",
      ["c = hostValue"],
    ],
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

test("every settled stop interval is enumerated, its epoch's own (C-R2's census)", () => {
  // (the chain's frozen keys completed in its settled pass, and #1556's witness; every allowance below the total read
  // once, against the bisection the held host's stops come from)
  // (each in one mode: the chain reversed, where every function's result froze, and the witness forward)
  const cases: readonly (readonly [string, number | undefined, (typeof HELD_MODES)[number]])[] = [
    [chain(2) + ending, 64, HELD_MODES[1]!],
    [
      'let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue' + ending,
      undefined,
      HELD_MODES[0]!,
    ],
  ];
  for (const [source, demand, mode] of cases) {
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
    assert.ok(
      census.some((interval) => interval.phase === "extraction"),
      at,
    );
    // (one interval a phase, each of the final epoch: the closure completes in the pass it settled in)
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
