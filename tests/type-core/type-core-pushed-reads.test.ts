import assert from "node:assert/strict";
import test from "node:test";

import type { CorePass } from "../../src/type-inference/core/answers.js";
import type { Contract } from "../../src/type-inference/core/contract.js";
import {
  collectMarks,
  depthOf,
  markAccepts,
  markHolders,
  markResidual,
  markStep,
  marksAt,
  markPrefixVisits,
  markStates,
} from "../../src/type-inference/core/contract/marks.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { Consumers } from "../../src/type-inference/core/consumers.js";
import {
  pushedFacts,
  pushedInvariant,
  withoutPushedReads,
} from "../../src/type-inference/core/contract/frontier.js";
import { stepsOf } from "../../src/type-inference/core/contract/literal-index.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
  WorkLedger,
} from "../../src/type-inference/core/budget.js";
import { inMode, MODES, publication, settledAnswers } from "../helpers/type-core-oracles.js";
import { marked } from "../../src/type-inference/core/indexes/guards.js";
import { itemScope } from "../helpers/type-core-items.js";
import {
  CONTEXT_WORDS,
  makeItem,
  mergeItems,
  type Item,
} from "../../src/type-inference/core/items.js";

/*
 * #1655: a key entry below its place's root in a copy cycle through a projection (`p1 = p1.q` beside the
 * ring `p1 = p0`, `p0 = p1`) is read one step at a time below its writing edge (`contract/frontier.ts`), over a finite
 * producer graph of the pass, instead of as a longer key at every read. Where the native reader ends (a terminating
 * spine, a ring without its closing copy) the two publish the same; where it does not, the program now reaches its
 * check, and the graph grows with the ring and the projection, not with the reads.
 */

const GLOBALS = ["hostValue", "hostOther"];

interface Ring {
  readonly n?: number;
  readonly d?: number;
  readonly q?: string;
  readonly sides?: readonly string[];
  readonly cycle?: boolean;
  readonly extra?: readonly string[];
}

/** The issue's ring of `n` whole copies, its last member holding `q` and read back through its projection `d` deep. */
function ring({ n = 2, d = 1, q = "p0", sides = ["s"], cycle = true, extra = [] }: Ring): string {
  const last = `p${n - 1}`;
  const rows = ["let typed:object={x:1}", "let p0={g:2}"];
  for (let i = 1; i < n; i++) rows.push(`let p${i}={f:typed,g:"s"}`);
  for (const side of sides) rows.push(`${last}.${side}=p0`);
  rows.push(`${last}.q=${q}`);
  for (let i = n - 1; i > 0; i--) rows.push(`p${i}=p${i - 1}`);
  if (cycle) rows.push(`p0=${last}`);
  rows.push(`${last}=${last}${".q".repeat(d)}`, ...extra);
  rows.push(`${last}.f=hostValue`, "let out={p:p0}", "out.p.g=hostOther", 'say "AFTER"', "exit");
  return rows.join("\n") + "\n";
}

/** A literal spine `{q:{q:…leaf}}` of depth `k`. */
function spine(k: number, leaf = '{f:typed,g:"end"}'): string {
  return `${"{q:".repeat(k - 1)}${leaf}${"}".repeat(k - 1)}`;
}

/**
 * One analysis, its pushed reads on (`oracle` none), or answered natively (`native`), or natively below a horizon of
 * that many steps (bottom past it: the least fixed point's approximations from below, where the native reader does not
 * end): its answers, each pass's graph and each pass's settled answers.
 */
function analysed(source: string, mode = MODES[0]!, oracle: "native" | number | null = null) {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  const passes: CorePass[] = [];
  const check = Consumers.prototype.check;
  Consumers.prototype.check = function (this: Consumers) {
    passes.push(this.pass);
    check.call(this);
  };
  try {
    const run = () => inMode(mode, () => analyseCore(request));
    const answers =
      oracle === null ? run() : withoutPushedReads(run, oracle === "native" ? null : oracle);
    const all = passes.map((pass) => pushedFacts(pass.contract));
    const invariants = passes.map((pass) => pushedInvariant(pass.contract));
    // (the automaton's size as the analysis left it, before the truth checks compile every holder)
    const states = passes.map((pass) => markStates(pass.contract));
    const prefixVisits = passes.map((pass) => markPrefixVisits(pass.contract));
    const truth = passes.map((pass) => markTruth(pass.contract));
    return {
      answers,
      facts: all.at(-1)!,
      all,
      invariants,
      truth,
      states,
      prefixVisits,
      settled: passes.map(settledAnswers),
    };
  } finally {
    Consumers.prototype.check = check;
  }
}

/**
 * #1784: the mark automaton against `marksAt` on a pass's real holders: every path of each compiled holder's own prefix
 * trie, and each one step further by each step the trie names and one none does; the asks, the marked ones and every
 * path where the two differ.
 */
function markTruth(contract: Contract): {
  readonly asked: number;
  readonly marked: number;
  readonly differences: readonly string[];
} {
  let [asked, positive] = [0, 0];
  const differences: string[] = [];
  collectMarks(contract);
  // (the paths the pass's arena holds, a few steps deep, each one step further by each step it names and one none
  // does: never the automaton's own, so a holder compiled without a path is asked there too)
  const steps = new Set<string>(["zz"]);
  const found: (readonly string[])[] = [];
  for (let id = 0; id < contract.pathDepths.length && found.length < 160; id += 1)
    if (contract.pathDepths[id]! <= 4) {
      const each = stepsOf(contract, id);
      found.push(each);
      for (const step of each) if (steps.size < 12) steps.add(step);
    }
  for (const holder of [...contract.holders.values(), ...markHolders(contract)]) {
    if (depthOf(contract, holder) === Infinity) continue;
    for (const each of found)
      for (const tail of [[], ...[...steps].map((step) => [step])]) {
        const asks = [...each, ...tail];
        asked += 1;
        const automaton = markAccepts(contract, holder, asks);
        if (automaton) positive += 1;
        if (automaton !== marksAt(contract, holder, asks))
          differences.push(`${holder.id} at ${asks.join(".")}: automaton ${automaton}`);
      }
    // (two histories' pending states together, one step further: marked iff either history's path marks)
    const live = found
      .map((each) => [each, markResidual(contract, holder, each)] as const)
      .filter(([, residual]) => !residual.marked && residual.states.length > 0)
      .slice(0, 8);
    for (const [first, a] of live)
      for (const [second, b] of live)
        for (const step of steps) {
          asked += 1;
          const union = [...new Set([...a.states, ...b.states])].sort((x, y) => x - y);
          const joined = markStep(contract, union, step).marked;
          const either =
            marksAt(contract, holder, [...first, step]) ||
            marksAt(contract, holder, [...second, step]);
          if (joined !== either)
            differences.push(
              `${holder.id} at ${first.join(".")} or ${second.join(".")} then ${step}: automaton ${joined}`,
            );
        }
  }
  return { asked, marked: positive, differences };
}

/** Every slot both analyses settled, pass by pass, answers the same (the pushed slots, the read's own, apart). */
function sameSettled(
  pushed: ReturnType<typeof analysed>,
  oracle: ReturnType<typeof analysed>,
  source: string,
): void {
  assert.equal(pushed.settled.length, oracle.settled.length, source);
  pushed.settled.forEach((answers, pass) => {
    let common = 0;
    for (const [key, items] of answers) {
      const other = oracle.settled[pass]!.get(key);
      if (key.startsWith("pr|") || other === undefined) continue;
      common += 1;
      assert.equal(items, other, `${key} in pass ${pass}\n${source}`);
    }
    assert.ok(common > 0, source);
  });
}

/** A plain ring of `n` members, every copy live: one component of whole copies. */
function plainRing(n: number, read = "q.q.g"): string {
  const last = `p${n - 1}`;
  const rows = Array.from({ length: n }, (_, i) => `let p${i}={g:${i}}`);
  rows.push(`${last}.q=p0`);
  for (let i = n - 1; i > 0; i--) rows.push(`p${i}=p${i - 1}`);
  rows.push(`p0=${last}`, `${last}=${last}.q`, `say "\${${last}.${read}}"`, "exit");
  return rows.join("\n") + "\n";
}

test("a ring of whole copies read through a projection reaches its check in four modes", () => {
  const sources = [
    ring({}),
    ring({ sides: ["s0", "s1"] }),
    ring({ d: 3 }),
    ring({ n: 3 }),
    // a store below the projection, read there
    ring({ extra: ["p1.q.q.g=5", 'say "${p1.q.q.g}"'] }),
  ];
  for (const source of sources)
    for (const mode of MODES) {
      const { answers, all } = analysed(source, mode);
      assert.equal(answers.budget.exhausted, null, source);
      assert.ok(
        all.some((facts) => facts.reads > 0) && all.every((facts) => facts.declines.size === 0),
        source,
      );
    }
});

test("where the native reader ends, a pushed read answers what it does, raw and published, in four modes", () => {
  const controls = [
    // terminating spines: with the ring, without its closing copy, with a ring of four, read back to the spine's end
    ring({ q: spine(3) }),
    ring({ q: spine(3), cycle: false }),
    ring({ n: 4, q: spine(2) }),
    ring({ q: spine(3), extra: ['say "${p1.q.q.q.g}"'] }),
    // a host's unknown beside the literals' `missing` (reasons that are not `missing` alone), an operation's (`fan`),
    // and that operation's member read below the projection (a value the graph does not model, stepped: declined)
    ring({ q: spine(2, "hostValue"), extra: ['say "${p1.q.q.q}"'] }),
    ring({ q: spine(2, "{f:hostValue+1}"), extra: ['say "${p1.q.q.f}"'] }),
    ring({
      q: spine(2, "{f:hostValue otherwise {x:1}}"),
      extra: ['say "${p1.q.q.f.x}"', 'let w=p1.q.q.f\nsay "${w.x}"'],
    }),
    // the ring without its closing copy, with a store below the projection read there
    ring({ cycle: false }),
    ring({ cycle: false, extra: ["p1.q.q.g=5", 'say "${p1.q.q.g}"'] }),
    // a chain of three whose literals all lack the step: a read that is `missing` alone, its earliest literal's
    ring({ n: 3, q: spine(1, "{g:1}"), cycle: false, extra: ['say "${p2.q.q.q}"'] }),
    // an empty list below the projection read at its element (a collection's: declined), and a host's data read at
    // an element, alone there and beside an object (its frame decides whether it may hold none: declined)
    ring({
      q: spine(2, "{l:[],h:hostValue}"),
      extra: ["let w=p1.q.q.l", "let v=p1.q.q.h", 'say "${w} ${v}"'],
    }),
    ring({
      q: spine(2, "{h:hostValue}"),
      cycle: false,
      extra: ["p1.q.q.h={z:1}", "let v=p1.q.q.h", 'say "${v}"'],
    }),
    // r1's witnesses: a host's data before a last element step through a variable, and a guarded host store below
    // the projection (each declined)
    [
      "let p0={}",
      "let p1={}",
      "p1.q={q:{h:1}}",
      "p1=p0",
      "p0=p1",
      "p1=p1.q",
      "p0.q={q:hostOther}",
      "let x=p1.q.q",
      "let y=x[0]",
      'say "${y}"',
      "exit",
    ].join("\n") + "\n",
    [
      "let p0={g:2}",
      "let p1={g:1}",
      "p1.q={q:{g:3}}",
      "p1=p0",
      "p0=p1",
      "p1=p1.q",
      "if hostValue is integer { p1.q.q.g=hostValue }",
      'say "${p1.q.q.g}"',
      "exit",
    ].join("\n") + "\n",
    // r2's: a host a literal's read reaches at the element step itself (declined there too)
    [
      "let p0={}",
      "let p1={}",
      "p1.q={s:hostValue}",
      "p1=p0",
      "p0=p1",
      "p1=p1.q",
      "p0.q={s:{g:1}}",
      "let x=p1.s",
      "let y=x[0]",
      'say "${y}"',
      "exit",
    ].join("\n") + "\n",
    // a written binding below the projection, where the read ends there (its type answers: read natively)
    ring({ q: spine(3), cycle: false, extra: ['say "${p1.q.q.q.f}"'] }),
  ];
  for (const source of controls)
    for (const mode of MODES) {
      const files = [{ path: "main.tease", source }];
      const pushed = publication(files, mode, GLOBALS);
      const native = withoutPushedReads(() => publication(files, mode, GLOBALS));
      assert.ok(pushed !== null, source);
      assert.equal(pushed, native, source);
      sameSettled(analysed(source, mode), analysed(source, mode, "native"), source);
    }
});

test("where the native reader does not end, its approximations from below reach the pushed read's answers", () => {
  // (each slot both settle, and the publication, the native one with every read past eight steps bottom: the plain
  // ring's publication reads each binding at its element too)
  for (const source of [ring({}), plainRing(3), ring({ q: spine(2, "{q:p0,g:hostValue}") })])
    for (const mode of [MODES[0]!, MODES[3]!]) {
      sameSettled(analysed(source, mode), analysed(source, mode, 8), source);
      const files = [{ path: "main.tease", source }];
      assert.equal(
        publication(files, mode, GLOBALS),
        withoutPushedReads(() => publication(files, mode, GLOBALS), 8),
        source,
      );
    }
});

test("a pushed read's graph is built as shared work: counted to the total, never to the demand that asked (r4.349)", () => {
  const charge = WorkLedger.prototype.charge;
  let outside = 0;
  let inside = 0;
  WorkLedger.prototype.charge = function (this: WorkLedger, ...args) {
    if (args[0] === "structureSteps" && new Error().stack!.includes("frontier.js"))
      if (this.sharing) inside += 1;
      else outside += 1;
    charge.apply(this, args);
  };
  try {
    analysed(ring({ q: spine(2) }));
  } finally {
    WorkLedger.prototype.charge = charge;
  }
  assert.ok(inside > 0);
  assert.equal(outside, 0);
});

test("a chain's root is read from the pass's index, its making shared work and a hit nothing (#1793)", () => {
  // (the accessor itself, whatever reads it: the chain index made again from empty after the analysis, then read again)
  const source = 'let a={b:{c:{d:1}}}\nlet x=a.b.c.d\nsay "${x}"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null);
  const passes: CorePass[] = [];
  const check = Consumers.prototype.check;
  Consumers.prototype.check = function (this: Consumers) {
    passes.push(this.pass);
    check.call(this);
  };
  try {
    analyseCore(request);
  } finally {
    Consumers.prototype.check = check;
  }
  const { contract, program } = passes.at(-1)!;
  const deepest = [...program.projOf.keys()].find(
    (value) => ![...program.projOf.values()].some((projection) => projection.owner === value),
  );
  assert.ok(deepest !== undefined);
  contract.chains.clear();
  const work = program.work;
  const read = () => {
    const [total, own] = [work.total, work.own];
    const chain = contract.chainOf(deepest);
    return { chain, total: work.total - total, own: work.own - own };
  };
  const first = read();
  assert.ok(first.chain !== null && first.total > 0, JSON.stringify(first));
  assert.equal(first.own, 0);
  assert.deepEqual(read(), { chain: first.chain, total: 0, own: 0 });
});

test("a chain's root index is shared work through each caller that first builds it inside a demand (#1793)", () => {
  // (each source's first build of the index comes through one caller: a direct chain's read through `positionOf`; a
  // wrapper's chain read through `Values.#rooted`, at its demand allowance in source order unshared, Astra r1 S1)
  const rows = [
    { source: "let a={b:{c:{d:1}}}\nlet x=a.b.c.d\nsay x\nexit\n", mode: MODES[0]!, demand: null },
    {
      source:
        'let leaf={n:1}\nlet a={b:leaf}\nlet w={c:a}\nw.c.b.n=hostValue\nrepeat w.c.b.n { say "AFTER" }\nexit\n',
      mode: MODES[1]!,
      demand: 59,
    },
  ];
  const charge = WorkLedger.prototype.charge;
  let [shared, owned] = [0, 0];
  WorkLedger.prototype.charge = function (this: WorkLedger, ...args) {
    // (the index's own making: a charge inside `positions.ts`'s helper, not the accessor's frame)
    if (/at chainOf \(.*positions\.js/.test(new Error().stack!))
      if (this.sharing) shared += 1;
      else owned += 1;
    charge.apply(this, args);
  };
  try {
    for (const { source, mode, demand } of rows) {
      [shared, owned] = [0, 0];
      const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
      const run = () => analyseCore(request);
      inMode(mode, () => (demand === null ? run() : withTestDemandAllowance(demand, run)));
      assert.ok(shared > 0, source);
      assert.equal(owned, 0, source);
    }
  } finally {
    WorkLedger.prototype.charge = charge;
  }
});

test("the producer graph grows with the ring and the projection's depth, each by a constant", () => {
  const rings = [4, 8, 16].map((n) => analysed(ring({ n })).facts);
  const plain = [4, 8, 16].map((n) => analysed(plainRing(n)).facts);
  const depths = [4, 8, 16].map((d) => analysed(ring({ d })).facts);
  for (const sizes of [rings, plain, depths])
    for (const field of ["nodes", "goals", "edges", "sets"] as const)
      assert.equal(
        sizes[2]![field] - sizes[1]![field],
        2 * (sizes[1]![field] - sizes[0]![field]),
        `${field}: ${sizes.map((facts) => facts[field]).join(", ")}`,
      );
});

/*
 * #1784: a route through a marking entry (a whole copy stored under a test of its source, or one whose holder marks
 * at the rest below it) reaches the same nodes marked: their leaves `marked`, then joined. HEAD 1: `marked` commutes with
 * `mergePair`'s join per item unless a non-`unknown` item with a context ranked after `"branch"` meets one without, and
 * only a native value's item carries such a context; so a native value reached marked declines (`marks-native`).
 */

/** #1784's ring: the copy of `p0` into `p1` stored under a test of `p0`'s path `g` (`tested`), read `read` below `p2`. */
function guardedRing({
  tested = "g",
  read = "q.q.g",
  leaf = "{g:0}",
  closing = true,
} = {}): string {
  return (
    [
      `let p0=${leaf}`,
      "let p1={g:1}",
      "let p2={g:2}",
      "p2.q=p0",
      "p2=p1",
      `if p0.${tested} is integer { p1=p0 }`,
      ...(closing ? ["p0=p2"] : []),
      "p2=p2.q",
      `say "\${p2.${read}}"`,
      "exit",
    ].join("\n") + "\n"
  );
}

test("a closed ring of copies each marked two steps deep grows its graph and its pending marks with the ring, each by a constant (#1784, Codex r2 B2)", () => {
  // (k copies, each stored under a two-step test of its source: the same few pending sets at every member, kept once)
  const ring = (k: number): string => {
    const last = `p${k - 1}`;
    const rows = Array.from({ length: k }, (_, i) => `let p${i}={g:{h:${i}}}`);
    rows.push(`${last}.q=p0`);
    for (let i = k - 1; i > 0; i--) rows.push(`if p${i - 1}.g.h is integer { p${i}=p${i - 1} }`);
    rows.push(`p0=${last}`, `${last}=${last}.q`, `say "\${${last}.q.q.g.h}"`, "exit");
    return rows.join("\n") + "\n";
  };
  const sizes = [8, 16, 32].map((k) => analysed(ring(k)));
  for (const { answers } of sizes) assert.equal(answers.budget.exhausted, null);
  for (const field of ["nodes", "goals", "edges", "pending"] as const) {
    const [a, b, c] = sizes.map(({ facts }) => facts[field]);
    assert.equal(c! - b!, 2 * (b! - a!), `${field}: ${a}, ${b}, ${c}`);
  }
});

test("a closed ring of copies each marked nine steps deep reaches its check, its held states one chain per node (#1784, Codex r3 B3)", () => {
  // (four copies, each stored under a test nine steps below its source, read to that depth: every combination of the
  // pending marks once exhausted the analysis; their union per node is one chain)
  const steps = ["g", "h", "i", "j", "z4", "z5", "z6", "z7", "z8"];
  const literal = (value: number): string =>
    steps.reduceRight((inner, step) => `{${step}:${inner}}`, String(value));
  const path = steps.join(".");
  const rows = [0, 1, 2, 3].map((i) => `let p${i}=${literal(i)}`);
  rows.push("p3.q=p0");
  for (let i = 3; i > 0; i--) rows.push(`if p${i - 1}.${path} is integer { p${i}=p${i - 1} }`);
  rows.push("p0=p3", "p3=p3.q", `say "\${p3.q.q.${path}}"`, "exit");
  const source = rows.join("\n") + "\n";
  for (const mode of MODES) {
    const pushed = analysed(source, mode);
    assert.equal(pushed.answers.budget.exhausted, null);
    assert.ok(pushed.facts.reads > 0 && pushed.facts.declines.size === 0);
    // (the native reader with pushed keys past the read's whole path and eight more bottom)
    sameSettled(pushed, analysed(source, mode, steps.length + 8), source);
    const files = [{ path: "main.tease", source }];
    assert.equal(
      publication(files, mode, GLOBALS),
      withoutPushedReads(() => publication(files, mode, GLOBALS), steps.length + 8),
    );
  }
});

/**
 * #1784's family of held marks: a ring of `n` members, each a literal `d` steps deep, the last holding the first at `q`;
 * `m` of the copies stored under a test `d` steps below their source; `closed` with the first copying the last back;
 * read at `q.q` and the `d` steps.
 */
function heldRing(n: number, d: number, m: number, closed: boolean): string {
  const steps = Array.from({ length: d }, (_, i) => `s${i}`);
  const literal = (value: number): string =>
    steps.reduceRight((inner, step) => `{${step}:${inner}}`, String(value));
  const last = `p${n - 1}`;
  const path = steps.join(".");
  const rows = Array.from({ length: n }, (_, i) => `let p${i}=${literal(i)}`);
  rows.push(`${last}.q=p0`);
  for (let i = n - 1; i > 0; i--)
    rows.push(i <= m ? `if p${i - 1}.${path} is integer { p${i}=p${i - 1} }` : `p${i}=p${i - 1}`);
  if (closed) rows.push(`p0=${last}`);
  rows.push(`${last}=${last}.q`, `say "\${${last}.q.q.${path}}"`, "exit");
  return rows.join("\n") + "\n";
}

test("a ring's held marks are one pending set per goal and base node, its automaton answering as the holders' marks do, in four modes (#1784)", () => {
  // (a sample of the family the queue runs whole: one doubling of the ring, the depth and the marked copies)
  const rows: [number, number, number, boolean][] = [];
  for (const n of [3, 6])
    for (const d of [2, 4])
      for (const m of [1, n - 1]) for (const closed of [false, true]) rows.push([n, d, m, closed]);
  // (#2005: an open ring of 24 whose 23 marked copies share one marking path: its holder's prefix made once)
  rows.push([24, 8, 23, false]);
  for (const [n, d, m, closed] of rows) {
    const source = heldRing(n, d, m, closed);
    const files = [{ path: "main.tease", source }];
    // (native exact where it ends; where it does not, below the read's whole path and eight more)
    const horizon = closed ? d + 8 : null;
    for (const mode of MODES) {
      const pushed = analysed(source, mode);
      const label = `n ${n}, d ${d}, m ${m}, closed ${closed}, ${JSON.stringify(mode)}`;
      assert.equal(pushed.answers.budget.exhausted, null, label);
      for (const { violations, largest } of pushed.invariants) {
        assert.deepEqual(violations, [], label);
        // (the marks still pending at a node: one per marked copy, whatever the depth)
        assert.ok(largest <= m, `${label}: ${largest}`);
      }
      // (the pending states accept what the holders' marks mark, on every real holder's paths)
      for (const truth of pushed.truth) assert.deepEqual(truth.differences, [], label);
      const native = analysed(source, mode, horizon ?? "native");
      // (where the native reader ends, every pushed slot is its read of the same path, marks included)
      if (!closed) samePushedSlots(pushed, native, source);
      // (#2005: an open ring's receiver scopes cost at most ×1.0105 native's work; a closed one's none)
      assert.ok(
        pushed.answers.budget.total <= native.answers.budget.total * (closed ? 1 : 1.0105),
        `${label}: ${pushed.answers.budget.total} > ${native.answers.budget.total}`,
      );
      const published = publication(files, mode, GLOBALS);
      assert.equal(
        published,
        withoutPushedReads(() => publication(files, mode, GLOBALS), horizon),
        label,
      );
    }
  }
});

test("a ring read through a marked copy reaches its check, and its leaves are read marked, in four modes (#1784)", () => {
  // (the issue's source, a second test path, a deeper read, the holder's mark at a rest it does not test)
  for (const source of [
    guardedRing(),
    guardedRing({ tested: "h" }),
    guardedRing({ read: "q.q.q.g" }),
    guardedRing({ read: "q.q.f" }),
    // a holder two steps deep in the closed ring, its depth set by its own test or by an unrelated one: one pending mark
    // per holder and steps, however often the cycle reaches it (Codex r1 B1)
    guardedRing({ tested: "g.h", leaf: "{g:{h:0}}" }),
    'let x={a:{b:1}}\nif x.a.b is integer { say "x" }\n' + guardedRing(),
    // the marked copy the ring's only marking route (the projection stores \`p1\`, no other read of \`p0\`): its mark
    // reaches the ring's members through the component's own copies alone
    guardedRing().replace("p2.q=p0", "p2.q=p1"),
  ])
    for (const mode of MODES) {
      const pushed = analysed(source, mode);
      assert.equal(pushed.answers.budget.exhausted, null, source);
      assert.ok(pushed.facts.reads > 0 && pushed.facts.declines.size === 0, source);
      // (the reads through the ring's marked copy carry its mark, as native's read of it does: a guarded item, whose
      // flags hold `g`, in some pushed slot)
      assert.ok(
        pushed.settled.some((answers) =>
          [...answers].some(
            ([key, items]) =>
              key.startsWith("pr|") &&
              items.split(" ").some((item) => item.split("|")[6]?.includes("g")),
          ),
        ),
        source,
      );
      // (where the native reader does not end, its approximations from below reach the pushed read's answers)
      sameSettled(pushed, analysed(source, mode, 8), source);
      const files = [{ path: "main.tease", source }];
      assert.equal(
        publication(files, mode, GLOBALS),
        withoutPushedReads(() => publication(files, mode, GLOBALS), 8),
        source,
      );
    }
});

/**
 * #1784: each pushed slot (`pr|place|path|rest`) against the native reader's answer of the same read (`c|place|path.rest`,
 * `rc|` where it recurs), its items' writers apart (the entry's writing edge sets the writer after the read,
 * `withWriter`); the slots compared.
 */
function samePushedSlots(
  pushed: ReturnType<typeof analysed>,
  native: ReturnType<typeof analysed>,
  source: string,
): number {
  const unwritten = (items: string): string =>
    items
      .split(" ")
      .map((item) =>
        item
          .split("|")
          .map((field, index) => (index === 3 ? "*" : field))
          .join("|"),
      )
      .join(" ");
  let compared = 0;
  pushed.settled.forEach((answers, pass) => {
    for (const [key, items] of answers) {
      const slot = /^pr\|(\d+)\|([^|]*)\|(.*)$/.exec(key);
      if (slot === null) continue;
      const read = `c|${slot[1]}|${[slot[2], slot[3]].filter((part) => part !== "").join(".")}`;
      const other = native.settled[pass]?.get(read) ?? native.settled[pass]?.get(`r${read}`);
      if (other === undefined) continue;
      compared += 1;
      assert.equal(unwritten(items), unwritten(other), `${key} in pass ${pass}\n${source}`);
    }
  });
  return compared;
}

test("where the native reader ends, a read through a marked route answers what it does, raw and published, in four modes (#1784)", () => {
  const ring = (...rows: string[]): string =>
    [...rows.slice(0, -2), "p2.q=p0", "p2=p1", rows.at(-2)!, "p2=p2.q", rows.at(-1)!, "exit"].join(
      "\n",
    ) + "\n";
  const plain = ["let p0={g:0}", "let p1={g:1}", "let p2={g:2}"];
  const nested = ["let p0={g:{h:0}}", "let p1={g:{h:1}}", "let p2={g:{h:2}}"];
  const deep = ["let x={a:{b:{c:1}}}", 'if x.a.b.c is integer { say "x" }', ...plain];
  const referred = (leaf: string, tested: string): string[] => [
    `let x0=${leaf}`,
    `let x=${leaf}`,
    `if x0.${tested} is integer { x=x0 }`,
    "let p0={g:x}",
    `let p1={g:${leaf}}`,
    `let p2={g:${leaf}}`,
  ];
  const controls = [
    // a holder's mark (a test of the copy's source below it), read at the tested path, beside it, and whole
    guardedRing({ closing: false }),
    guardedRing({ closing: false, read: "q.q.f" }),
    ring(...plain, "if p0.g is integer { p1=p0 }", 'let w=p2.q.q\nsay "${w.g}"'),
    // the guard bit (a test of the source itself), and steps below a mark
    ring(...plain, "if p0 is object { p1=p0 }", 'say "${p2.q.q.g}"'),
    ring(...nested, "if p0.g is object { p1=p0 }", 'say "${p2.q.q.g.h}"'),
    ring(...nested, "if p0 is object { p1=p0 }", 'say "${p2.q.q.g.h}"'),
    // a holder two steps deep, and one whose depth another test sets, its hold decided where the path ends
    ring(...nested, "if p0.g.h is integer { p1=p0 }", 'let w=p2.q.q.g\nsay "${w.h}"'),
    ring(...deep, "if p0.g is integer { p1=p0 }", 'say "${p2.q.q.g}"'),
    ring(...deep, "if p0.g is integer { p1=p0 }", 'let w=p2.q.q\nsay "${w.g}"'),
    // a literal holding a value stored under a test of its source: the literal's holder marks through its reference
    ring(...referred("{h:0}", "h"), "p1=p0", 'say "${p2.q.q.g.h}"'),
    ring(...referred("{h:0}", "h"), "p1=p0", 'let w=p2.q.q.g\nsay "${w.h}"'),
    ring(...referred("{h:{k:0}}", "h.k"), "p1=p0", 'say "${p2.q.q.g.h.k}"'),
    // a projection's holder marked only through its shifted reference to its base's (Codex r4: no marking entry on
    // the walk restores it), its depth set by an unrelated deeper test
    [
      "let x={g:{h:0}}",
      "x={g:{h:1}}",
      "let saved={g:{h:2}}",
      "if x.g is object { saved=x }",
      "let z={a:{b:{c:0}}}",
      'if z.a.b.c is integer { say "z" }',
      "let p0={h:2}",
      "let p1={h:3}",
      "let p2={h:4}",
      "p0=x.g",
      "p2.q=p0",
      "p2=p1",
      "p1=p0",
      "p2=p2.q",
      'say "${p2.q.h}"',
      "exit",
    ].join("\n") + "\n",
    // two copies marked under tests of different paths: their pending states meet at a node, and only their union
    // marks both reads below it
    ...["s1", "t1"].map(
      (read) =>
        [
          "let p0={s0:{s1:0,t1:0}}",
          "let p1={s0:{s1:1,t1:1}}",
          "let p2={s0:{s1:2,t1:2}}",
          "p2.q=p0",
          "if p1.s0.t1 is integer { p2=p1 }",
          "if p0.s0.s1 is integer { p1=p0 }",
          "p2=p2.q",
          `say "\${p2.q.q.s0.${read}}"`,
          'say "${p2.q.s0.s1} ${p2.q.s0.t1}"',
          "exit",
        ].join("\n") + "\n",
    ),
    // a marked copy of a literal whose leaf is an operation's (a native value): declined, read natively
    guardedRing({ closing: false, leaf: "{g:hostValue+1}" }),
  ];
  for (const source of controls) {
    let compared = 0;
    for (const mode of MODES) {
      const files = [{ path: "main.tease", source }];
      assert.equal(
        publication(files, mode, GLOBALS),
        withoutPushedReads(() => publication(files, mode, GLOBALS)),
        source,
      );
      const [pushed, native] = [analysed(source, mode), analysed(source, mode, "native")];
      sameSettled(pushed, native, source);
      compared += samePushedSlots(pushed, native, source);
      // (the pending states accept what the holders' marks mark, on every real holder's paths)
      for (const truth of pushed.truth) assert.deepEqual(truth.differences, [], source);
    }
    if (!source.includes("hostValue")) assert.ok(compared > 0, source);
  }
  // (the operation's leaf reached through the marked copy declines; the native reader answers it, as above)
  const declined = analysed(guardedRing({ closing: false, leaf: "{g:hostValue+1}" }));
  assert.ok(declined.all.some((facts) => (facts.declines.get("marks-native") ?? 0) > 0));
});

test("a pushed read's mark walk charges no negative work, a reference above the rest included, in four modes (#1784, Astra r1 B2)", () => {
  // (a projection's holder whose references stand above the rest the walk asks: a shallower path is not below it)
  const literal = "{h0:{h1:0}}";
  const source =
    [
      `let x={g:${literal}}`,
      `x={g:${literal}}`,
      `let saved={g:${literal}}`,
      "if x.g is object { saved=x }",
      "let z={z0:{z1:{z2:{z3:0}}}}",
      'if z.z0.z1.z2.z3 is integer { say "z" }',
      `let p0=${literal}`,
      `let p1=${literal}`,
      `let p2=${literal}`,
      "p0=x.g",
      "p2.q=p0",
      "p2=p1",
      "p1=p0",
      "p2=p2.q",
      'say "${p2.q.h0.h1}"',
      "exit",
    ].join("\n") + "\n";
  const charge = WorkLedger.prototype.charge;
  const negative: number[] = [];
  WorkLedger.prototype.charge = function (
    this: WorkLedger,
    ...args: Parameters<WorkLedger["charge"]>
  ) {
    if ((args[1] ?? 1) < 0) negative.push(args[1]!);
    charge.apply(this, args);
  };
  try {
    for (const mode of MODES) {
      const pushed = analysed(source, mode);
      assert.ok(pushed.facts.reads > 0 && pushed.facts.declines.size === 0, JSON.stringify(mode));
      // (its marks resolve before any hold: the publication the native reader's)
      const files = [{ path: "main.tease", source }];
      assert.equal(
        publication(files, mode, GLOBALS),
        withoutPushedReads(() => publication(files, mode, GLOBALS)),
        JSON.stringify(mode),
      );
    }
  } finally {
    WorkLedger.prototype.charge = charge;
  }
  assert.deepEqual(negative, []);
});

test("marking a route's leaves before their join is marking their join, except where a late context meets none (#1784 HEAD 1)", () => {
  const scope = itemScope();
  const late = new Set(CONTEXT_WORDS.slice(CONTEXT_WORDS.indexOf("branch") + 1));
  const variants = (tag: Item["tag"]): Item[] =>
    [null, ...CONTEXT_WORDS].flatMap((context) =>
      (["def", "pos"] as const).flatMap((cert) =>
        [false, true].flatMap((guarded) =>
          (tag === "null" ? [undefined, "unknown" as const] : [undefined]).map((word) =>
            makeItem(tag, null, {
              context,
              cert,
              ...(guarded ? { guarded: true as const } : {}),
              ...(word === undefined ? {} : { word }),
            }),
          ),
        ),
      ),
    );
  const failing: string[] = [];
  let pairs = 0;
  for (const tag of ["integer", "string", "null", "unknown"] as const)
    for (const one of variants(tag))
      for (const other of variants(tag)) {
        pairs += 1;
        const joinedThenMarked = marked(mergeItems([one, other], scope));
        const markedThenJoined = mergeItems(marked([one, other]), scope);
        const condition =
          tag === "unknown" ||
          ![one, other].some((item) => item.context !== null && late.has(item.context));
        if (condition)
          assert.deepEqual(
            markedThenJoined,
            joinedThenMarked,
            `${tag} ${one.context}/${other.context}`,
          );
        else if (JSON.stringify(markedThenJoined) !== JSON.stringify(joinedThenMarked))
          failing.push(`${tag}:${one.context}/${other.context}`);
      }
  assert.ok(pairs > 1000, `${pairs} pairs`);
  // (HEAD 1's twelve pairs: a null context beside a late one, either order, on a tag that is not `unknown`)
  for (const tag of ["integer", "null"])
    for (const word of late)
      for (const pair of [`${tag}:null/${word}`, `${tag}:${word}/null`])
        assert.ok(failing.includes(pair), pair);
});

/** Astra r1 B1's family: a projection's holder marked through its shifted reference, below `d` nested or flat steps. */
function shiftedRing(d: number, nested: boolean): string {
  const steps = Array.from({ length: d }, (_, i) => `h${i}`);
  const literal = nested
    ? steps.reduceRight((inner, step) => `{${step}:${inner}}`, "0")
    : `{${steps.map((step) => `${step}:0`).join(",")}}`;
  const read = nested ? steps.join(".") : steps.at(-1)!;
  const z = Array.from({ length: d + 2 }, (_, i) => `z${i}`);
  return (
    [
      `let x={g:${literal}}`,
      `x={g:${literal}}`,
      `let saved={g:${literal}}`,
      "if x.g is object { saved=x }",
      `let z=${z.reduceRight((inner, step) => `{${step}:${inner}}`, "0")}`,
      `if z.${z.join(".")} is integer { say "z" }`,
      `let p0=${literal}`,
      `let p1=${literal}`,
      `let p2=${literal}`,
      "p0=x.g",
      "p2.q=p0",
      "p2=p1",
      "p1=p0",
      "p2=p2.q",
      `say "\${p2.q.${read}}"`,
      "exit",
    ].join("\n") + "\n"
  );
}

test("a shifted reference's held marks keep no history: the automaton's size is the depth's none, in four modes (#1784, Astra r1 B1)", () => {
  // (a sample of the family the queue runs to 128: one doubling, nested and flat, the deep test beside it)
  for (const nested of [true, false])
    for (const mode of MODES) {
      const sizes = [4, 8].map((d) => {
        const source = shiftedRing(d, nested);
        const pushed = analysed(source, mode);
        const label = `d ${d}, nested ${nested}, ${JSON.stringify(mode)}`;
        assert.equal(pushed.answers.budget.exhausted, null, label);
        assert.ok(pushed.facts.reads > 0 && pushed.facts.declines.size === 0, label);
        for (const { violations } of pushed.invariants) assert.deepEqual(violations, [], label);
        for (const truth of pushed.truth) assert.deepEqual(truth.differences, [], label);
        // (no pending state left: each route's mark accepts at once)
        assert.equal(
          pushed.all.reduce((all, facts) => all + facts.pending, 0),
          0,
          label,
        );
        const files = [{ path: "main.tease", source }];
        assert.equal(
          publication(files, mode, GLOBALS),
          withoutPushedReads(() => publication(files, mode, GLOBALS)),
          label,
        );
        return pushed.states;
      });
      assert.deepEqual(sizes[0], sizes[1], `nested ${nested}, ${JSON.stringify(mode)}`);
    }
});

test("the mark automaton answers as the holders' marks do on branching prefixes, two references at a site and their union (#1784)", () => {
  const sources = [
    // one holder: `a` and `c` unmarked, `a.b` marked, `c.b` not, `c.d` marked (Sol's counterexample to a depth key)
    'let x={g:{a:{b:1},c:{d:2}}}\nx={g:{a:{b:3},c:{d:4}}}\nlet saved=x\nif x.g.a.b is integer { saved=x }\nif x.g.c.d is integer { saved=x }\nlet copied=x.g\nsay "${copied.a.b} ${copied.c.d}"\nexit\n',
    'let a={k:0}\nlet x={g:{k:1}}\nif a is object { x={g:a} }\nlet p0=x\nlet p1={g:{k:2}}\nlet p2={g:{k:3}}\np2.q=p0\np2=p1\np1=p0\np2=p2.q\nsay "${p2.q.g.k}"\nexit\n',
    'let a={k:0,l:"a"}\nlet b={k:"b",l:3}\nlet saved=a\nlet other=b\nif a.k is integer { saved=a }\nif b.l is integer { other=b }\nlet x=[a,b]\nlet first=x.get(0, default: {k:0,l:0})\nsay "${first.k} ${first.l}"\nexit\n',
    'let a={k:0,l:1}\nlet b={k:2,l:3}\nlet saved=a\nlet other=b\nif a.k is integer { saved=a }\nif b.l is integer { other=b }\nlet x={g:{h:a},j:{h:b}}\nsay "${x.g.h.k} ${x.j.h.l}"\nexit\n',
  ];
  for (const source of sources)
    for (const mode of MODES) {
      const pushed = analysed(source, mode);
      let marked = 0;
      for (const truth of pushed.truth) {
        assert.deepEqual(truth.differences, [], `${JSON.stringify(mode)}\n${source}`);
        marked += truth.marked;
      }
      assert.ok(marked > 0, source);
    }
});

test("a closed ring's dead histories are not kept to an unrelated tested depth: no pending state, in four modes (#1784)", () => {
  // (the blind review's row on the old head: a marked closed ring, a deep test on one unrelated object and a tested `q`
  // on another, which kept the ring's `q`, `q.q`, … histories pending to that depth)
  const source = (d: number): string => {
    const steps = Array.from({ length: d }, (_, i) => `a${i}`);
    return (
      [
        `let depth=${steps.reduceRight((inner, step) => `{${step}:${inner}}`, "0")}`,
        `if depth.${steps.join(".")} is integer { say "depth" }`,
        "let other={q:0}",
        'if other.q is integer { say "other" }',
        "let p0={s0:0}",
        "let p1={s0:1}",
        "let p2={s0:2}",
        "p2.q=p0",
        "p2=p1",
        "if p0.s0 is integer { p1=p0 }",
        "p0=p2",
        "p2=p2.q",
        'say "${p2.q.q.s0}"',
        "exit",
      ].join("\n") + "\n"
    );
  };
  for (const mode of MODES) {
    const sizes = [8, 16].map((d) => {
      const pushed = analysed(source(d), mode);
      const label = `d ${d}, ${JSON.stringify(mode)}`;
      assert.equal(pushed.answers.budget.exhausted, null, label);
      assert.ok(pushed.facts.reads > 0, label);
      for (const { violations } of pushed.invariants) assert.deepEqual(violations, [], label);
      for (const truth of pushed.truth) assert.deepEqual(truth.differences, [], label);
      assert.equal(
        pushed.all.reduce((all, facts) => all + facts.pending, 0),
        0,
        label,
      );
      const files = [{ path: "main.tease", source: source(d) }];
      assert.equal(
        publication(files, mode, GLOBALS),
        withoutPushedReads(() => publication(files, mode, GLOBALS), d + 8),
        label,
      );
      return pushed.states;
    });
    assert.deepEqual(sizes[0], sizes[1], JSON.stringify(mode));
  }
});

test("two pending sets that meet at one node are held as their union, in four modes (#1784, Codex r6 on R8b)", () => {
  // (one holder pending at `q` for `a`, another for `q.b`: a goal reaches one base node with both sets, so only their
  // union marks both reads below it)
  const source =
    [
      "let p0={a:0,b:0}",
      "let p1={a:0,b:0}",
      "let p2={a:0,b:0}",
      "p2.q=p0",
      "if p0.q.a is integer { p1=p0 }",
      "if p0.q.q.b is integer { p1=p0 }",
      "p2=p1",
      "p2=p2.q",
      'say "${p2.q.a} ${p2.q.q.b}"',
      "exit",
    ].join("\n") + "\n";
  for (const mode of MODES) {
    const pushed = analysed(source, mode);
    const label = JSON.stringify(mode);
    // (its raw slot below `p2.q.q` floors as native's does, #2005: the floor test below)
    assert.ok(pushed.facts.reads > 0, label);
    for (const { violations } of pushed.invariants) assert.deepEqual(violations, [], label);
    for (const truth of pushed.truth) assert.deepEqual(truth.differences, [], label);
    const files = [{ path: "main.tease", source }];
    assert.equal(
      publication(files, mode, GLOBALS),
      withoutPushedReads(() => publication(files, mode, GLOBALS)),
      label,
    );
  }
});

/** Codex r7's family: a ring copying `p2.<step>` into `p2`, the copy into `p1` of `p0` held under tests below it. */
function floorRing(step: string, nested: boolean, depth: number, marked: boolean): string {
  const leaf = "{a:0,b:0}";
  const literal = nested ? `{${step}:${leaf}}` : leaf;
  return (
    [
      `let p0=${literal}`,
      `let p1=${leaf}`,
      `let p2=${leaf}`,
      `p2.${step}=p0`,
      ...(marked
        ? [
            `if p0.${step}.a is integer { p1=p0 }`,
            `if p0.${Array(depth).fill(step).join(".")}.b is integer { p1=p0 }`,
          ]
        : ["p1=p0"]),
      "p2=p1",
      `p2=p2.${step}`,
      `say "\${p2.b} \${p2.${step}.a} \${p2.${step}.${step}.b}"`,
      "exit",
    ].join("\n") + "\n"
  );
}

test("below a receiver with no structure the pushed read floors as native does: every settled answer and pushed slot equal, in four modes (#2005, #1859 Codex r7)", () => {
  // (native reads no shorter prefix's stores below a receiver holding no record or collection, `receiverWalk`; a
  // pending mark reached under such a receiver dies there, an accepted one survives)
  for (const step of ["q", "r"])
    for (const nested of [false, true])
      for (const depth of [1, 2, 3])
        for (const marked of [true, false]) {
          const source = floorRing(step, nested, depth, marked);
          for (const mode of MODES) {
            const label = `${JSON.stringify(mode)}\n${source}`;
            const pushed = analysed(source, mode);
            const native = analysed(source, mode, "native");
            pushed.settled.forEach((answers, pass) => {
              for (const [key, items] of answers) {
                const other = native.settled[pass]?.get(key);
                if (key.startsWith("pr|") || other === undefined) continue;
                assert.equal(items, other, `${key}: ${label}`);
              }
            });
            samePushedSlots(pushed, native, source);
            for (const { violations } of pushed.invariants) assert.deepEqual(violations, [], label);
            const files = [{ path: "main.tease", source }];
            assert.equal(
              publication(files, mode, GLOBALS),
              withoutPushedReads(() => publication(files, mode, GLOBALS)),
              label,
            );
          }
        }
});

/** #2005's controls: a ring whose receiver has a scalar sibling `g` (tested at `g` or `g.h`), and a key entry under a test. */
function floorControls(): { readonly source: string; readonly horizon: number | null }[] {
  const out: { readonly source: string; readonly horizon: number | null }[] = [];
  for (const leaf of ["{g:0}", "{g:{h:0}}"])
    for (const closed of [false, true]) {
      const tested = leaf.includes("h:") ? "g.h" : "g";
      const rows = [
        `let p0=${leaf}`,
        "let p1={g:1}",
        "let p2={g:2}",
        "p2.q=p0",
        "p2=p1",
        `if p0.${tested} is integer { p1=p0 }`,
        ...(closed ? ["p0=p2"] : []),
        "p2=p2.q",
        'say "${p2.q.q.g}"',
        "exit",
      ];
      out.push({ source: rows.join("\n") + "\n", horizon: closed ? 10 : null });
    }
  // (the floor's witnesses, #2005: r7's ring over a literal lacking the tested property, read one step past it, where a
  // hold kept at a floor marks; and a key entry under a test of a property the literal lacks, read at the ring's own
  // property, where a floor's step taken as a plain goal, or an immediate mark past an unwitnessed root, marks)
  for (const p0 of ["{b:0}", "{a:0}"])
    out.push({
      source:
        [
          `let p0=${p0}`,
          "let p1={a:0,b:0}",
          "let p2={a:0,b:0}",
          "p2.q=p0",
          "if p0.q.a is integer { p1=p0 }",
          "if p0.q.q.b is integer { p1=p0 }",
          "p2=p1",
          "p2=p2.q",
          'say "${p2.q.a.z} ${p2.q.q.b.z}"',
          "exit",
        ].join("\n") + "\n",
      horizon: null,
    });
  for (const p0 of ["{a:0}", "{b:1}"])
    out.push({
      source:
        [
          `let p0=${p0}`,
          "let p2={a:1}",
          "p2.q=p0.q",
          "if p0.q.b is integer { p2.q=p0.q }",
          "p2=p2.q",
          'say "${p2.b}"',
          "exit",
        ].join("\n") + "\n",
      horizon: null,
    });
  // (an accepted mark over a host value a floor carries: the mark survives the floor, #2005's F5)
  for (const p0 of ["{q:hostValue}", "{q:{q:hostValue}}"])
    out.push({
      source:
        [
          `let p0=${p0}`,
          "let p1={a:0,b:0}",
          "let p2={a:0,b:0}",
          "p2.q=p0",
          "if p0.q is object { p1=p0 }",
          "p2=p1",
          "p2=p2.q",
          'say "${p2.q.a.z}"',
          "exit",
        ].join("\n") + "\n",
      horizon: null,
    });
  // (a store below that floor, which native reads at its longer prefix: the floor keeps a key's direct children)
  for (const read of ["${p2.q.r.c}", "${p2.r.c}"])
    out.push({
      source:
        [
          "let p0={q:hostValue}",
          "let p1={a:0,b:0}",
          "let p2={a:0,b:0}",
          "p2.q=p0",
          "p2.q.q.r={c:1}",
          "if p0.q is object { p1=p0 }",
          "p2=p1",
          "p2=p2.q",
          `say "${read}"`,
          "exit",
        ].join("\n") + "\n",
      horizon: null,
    });
  for (const condition of ["p0.q.b is integer", "p0.q is object"]) {
    const rows = [
      "let p0={a:0}",
      "let p2={a:1}",
      "p2.q=p0.q",
      `if ${condition} { p2.q=p0.q }`,
      "p2=p2.q",
      'say "${p2.q.b}"',
      "exit",
    ];
    out.push({ source: rows.join("\n") + "\n", horizon: null });
  }
  // (a structural sibling two steps deep, read below it and one step past it, where a floor's pending mark would
  // mark; and Codex r7's witness read one step past an already marked leaf, which a floor carries marked)
  const sibling = [
    "let p0={g:{h:0}}",
    "let p1={g:1}",
    "let p2={g:2}",
    "p2.q=p0",
    "p2=p1",
    "if p0.g.h is integer { p1=p0 }",
    "p2=p2.q",
  ];
  for (const read of ["p2.q.q.g.h", "p2.q.q.g.h.z"])
    out.push({
      source: [...sibling, `say "\${${read}}"`, "exit"].join("\n") + "\n",
      horizon: null,
    });
  out.push({
    source:
      [
        "let p0={a:0,b:0}",
        "let p1={a:0,b:0}",
        "let p2={a:0,b:0}",
        "p2.q=p0",
        "if p0.q.a is integer { p1=p0 }",
        "if p0.q.q.b is integer { p1=p0 }",
        "p2=p1",
        "p2=p2.q",
        'say "${p2.q.a.z} ${p2.q.q.b}"',
        "exit",
      ].join("\n") + "\n",
    horizon: null,
  });
  return out;
}

test("a receiver with a scalar sibling, a structural sibling, an already marked leaf and a key entry under a test, read as native reads them, in four modes (#2005)", () => {
  // (one record sibling keeps a receiver structured; a scalar or `null` alone floors it; within a bounded allowance,
  // so a rule that loses the floor exhausts instead of running on)
  for (const { source, horizon } of floorControls())
    for (const mode of MODES) {
      const label = `${JSON.stringify(mode)}\n${source}`;
      const pushed = withTestAllowance(1_000_000, () => analysed(source, mode));
      assert.equal(pushed.answers.budget.exhausted, null, label);
      for (const { violations } of pushed.invariants) assert.deepEqual(violations, [], label);
      const native = withTestAllowance(1_000_000, () =>
        analysed(source, mode, horizon ?? "native"),
      );
      assert.equal(native.answers.budget.exhausted, null, label);
      // (every settled answer both hold, where native ends; every pushed slot its native read)
      if (horizon === null) {
        pushed.settled.forEach((answers, pass) => {
          for (const [key, items] of answers) {
            const other = native.settled[pass]?.get(key);
            if (key.startsWith("pr|") || other === undefined) continue;
            assert.equal(items, other, `${key}: ${label}`);
          }
        });
        samePushedSlots(pushed, native, source);
      }
      const files = [{ path: "main.tease", source }];
      assert.equal(
        publication(files, mode, GLOBALS),
        withoutPushedReads(() => publication(files, mode, GLOBALS), horizon),
        label,
      );
    }
});

test("a path of 2,048 steps below pure nodes is walked without a native frame per step: the analysis stops where native's does (#2005, Codex r1)", () => {
  // (the pure path's steps and a floor's children pass through the build's tasks, as a goal's nodes do)
  const source =
    [
      "let p0={a:0}",
      "let p2={a:0}",
      `p2.q={a:0}${".x".repeat(2048)}`,
      "if p0.q.a is integer { p2=p0 }",
      "p2=p2.q",
      'say "${p2.a}"',
      "exit",
    ].join("\n") + "\n";
  const files = [{ path: "main.tease", source }];
  const mode = MODES[0]!;
  assert.equal(
    publication(files, mode, GLOBALS),
    withoutPushedReads(() => publication(files, mode, GLOBALS)),
  );
});

/** Astra r2 B3's family: `x` copied `copies` times under a conjunction of `tests` tests of its properties, then marked. */
function guardedCopies(tests: number, copies: number): string {
  const literal = `{${Array.from({ length: tests }, (_, i) => `a${i}:0`).join(",")}}`;
  const condition = Array.from({ length: tests }, (_, i) => `x.a${i} is integer`).join(" and ");
  return (
    [
      `let x=${literal}`,
      `x=${literal}`,
      "let saved=x",
      `if ${condition} {`,
      ...Array.from({ length: copies }, (_, i) => `let save${i}=x`),
      "}",
      "let p0=x",
      `let p1=${literal}`,
      `let p2=${literal}`,
      "p2.q=p0",
      "p2=p1",
      "p1=p0",
      "p2=p2.q",
      'say "${p2.q.a0}"',
      "exit",
    ].join("\n") + "\n"
  );
}

test("a holder's compilation visits each guarded prefix of reads its tests guard alike once, however many such reads (Astra r2 B3)", () => {
  const visits = (tests: number, copies: number): number => {
    const { prefixVisits, invariants } = analysed(guardedCopies(tests, copies));
    for (const { violations } of invariants)
      assert.deepEqual(violations, [], `${tests} tests, ${copies} copies`);
    return prefixVisits.reduce((sum, at) => sum + at, 0);
  };
  // (the copies under one conjunction ask one answer: the visits do not grow with them)
  const one = visits(16, 1);
  assert.ok(one > 0, String(one));
  for (const copies of [4, 16]) assert.equal(visits(16, copies), one, `16 tests, ${copies} copies`);
  // (and grow with the tests as the distinct prefixes do: linearly)
  assert.equal(visits(32, 32), 2 * visits(16, 16));
});
