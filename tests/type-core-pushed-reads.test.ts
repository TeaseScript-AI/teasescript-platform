import assert from "node:assert/strict";
import test from "node:test";

import type { CorePass } from "../src/type-inference/core/answers.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { Consumers } from "../src/type-inference/core/consumers.js";
import { pushedFacts, withoutPushedReads } from "../src/type-inference/core/contract/frontier.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { withTestDemandAllowance, WorkLedger } from "../src/type-inference/core/budget.js";
import { inMode, MODES, publication, settledAnswers } from "./helpers/type-core-oracles.js";

/*
 * #1655 (TABLE r4.385): a key entry below its place's root in a copy cycle through a projection (`p1 = p1.q` beside the
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
    return { answers, facts: all.at(-1)!, all, settled: passes.map(settledAnswers) };
  } finally {
    Consumers.prototype.check = check;
  }
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
