import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  LandingTape,
  withLandingComparison,
  withLandingOps,
  type LandingOp,
} from "../src/type-inference/core/admission/landings.js";
import { Admission } from "../src/type-inference/core/admission.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { WorkLedger } from "../src/type-inference/core/budget.js";
import { ReceivingDomain } from "../src/type-inference/core/inherited/receiving-domain.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import type {
  LandingTask,
  Listing,
  ListingNode,
  TapePoint,
} from "../src/type-inference/core/admission/model.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { MODES, inMode, publishedAnswers } from "./helpers/type-core-oracles.js";

// The landing reporter (#1428, #1547): a call's tape reports each path's first event in a range, and every
// `landedBelow` call returns, in order, what the walk without listings returns.

const GLOBALS = ["hostValue", "hostOther", "hostInit", "otherHost"];

/** The landing families' module (`tests/families/copies/copy-projections/landing-chain-narrow-read-work.mjs`), read where the tests run. */
async function families(): Promise<Record<string, (k: number) => string>> {
  const file = resolve(process.cwd(), "tests/families/copies/copy-projections/landing-chain-narrow-read-work.mjs");
  // EVIDENCE: the module exports `shapes`, each a size to one source's text (the families' module contract).
  return (
    (await import(pathToFileURL(file).href)) as { shapes: Record<string, (k: number) => string> }
  ).shapes;
}

/** Codex r3's crossed descendants (`seed` 1–40), which hold R3's clock boundary (Astra's design review). */
function crossed(seed: number): string {
  let state = seed;
  const next = (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const lines = [
    "let typed: integer | string = 1",
    "let v0 = {p: {f0: typed, f1: typed}, q: {g0: typed, g1: typed}}",
  ];
  for (let i = 1; i <= 8; i += 1) {
    const picks = Array.from({ length: 6 }, () => next(i));
    const variants = Array.from(
      { length: 3 },
      (_, j) => `{p: v${picks[2 * j]}.p, q: v${picks[2 * j + 1]}.q}`,
    );
    variants.splice(next(4), 0, `{p: {f${i + 1}: typed}, q: {g${i + 1}: typed}}`);
    lines.push(`let v${i} = [${variants.join(", ")}][0]`);
  }
  for (let i = 0; i < 4; i += 1) {
    const [a, b, c] = [next(9), next(9), next(9)];
    lines.push(`let x${i} = [{r: v${a}.p}, {r: v${b}.q}, {r: v${c}.p}][0]`);
  }
  lines.push('say "${x0.r} ${x1.r} ${x2.r} ${x3.r}"', "exit");
  return `${lines.join("\n")}\n`;
}

/** Each landing call's result beside the walk's, in the four modes; the calls compared. */
function compared(source: string): number {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null);
  let calls = 0;
  for (const mode of MODES)
    withLandingComparison(
      (place, prefix, listed, walked) => {
        calls += 1;
        assert.deepEqual(listed, walked, `place ${place} at ${prefix.join(".")}`);
      },
      () => inMode(mode, () => analyseCore(request)),
    );
  return calls;
}

test("a tape reports each path's first event in a range, in order, looking at its blocks only where one starts there", () => {
  // tapes of random brings and repeats (interleaved, runs, alternations); every pair of points against the events
  for (let seed = 1; seed <= 60; seed += 1) {
    let state = seed;
    const next = (n: number): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state % n;
    };
    const work = new WorkLedger(Number.MAX_SAFE_INTEGER);
    const tape = new LandingTape(work);
    const events: number[] = [];
    const points: TapePoint[] = [tape.point()];
    for (let step = 0; step < 40 + seed; step += 1) {
      if (tape.texts.length === 0 || next(3) === 0) {
        events.push(tape.bring([`f${tape.texts.length}`], `f${tape.texts.length}`));
      } else {
        // (a few paths, so repeats recur, alternate and run)
        const index = next(Math.min(tape.texts.length, 1 + (seed % 4)));
        tape.repeat(index);
        events.push(index);
      }
      points.push(tape.point());
    }
    for (let i = 0; i < points.length; i += 1)
      for (let j = i; j < points.length; j += 1) {
        const expected: number[] = [];
        for (const index of events.slice(i, j)) if (!expected.includes(index)) expected.push(index);
        assert.deepEqual(
          tape.reports(points[i]!, points[j]!),
          expected,
          `seed ${seed}, ${i}..${j}`,
        );
      }
  }
});

test("a tape's boundary cases: a repeat first in its range reports, a later one does not, an empty range nothing", () => {
  const tape = new LandingTape(new WorkLedger(Number.MAX_SAFE_INTEGER));
  const start = tape.point();
  tape.bring(["x"], "x");
  tape.bring(["y"], "y");
  const middle = tape.point();
  tape.repeat(0);
  const end = tape.point();
  assert.deepEqual(tape.reports(start, end), [0, 1]);
  assert.deepEqual(tape.reports(middle, end), [0]);
  assert.deepEqual(tape.reports(middle, middle), []);
  const runs = new LandingTape(new WorkLedger(Number.MAX_SAFE_INTEGER));
  runs.bring(["x"], "x");
  const second = runs.point();
  runs.repeat(0);
  assert.deepEqual(runs.reports(second, runs.point()), [0]);
});

test("a tape's query of one path repeated k times looks at O(log k) blocks", () => {
  for (const k of [64, 1024]) {
    const work = new WorkLedger(Number.MAX_SAFE_INTEGER);
    const tape = new LandingTape(work);
    tape.bring(["x"], "x");
    const from = tape.point();
    for (let i = 0; i < k; i += 1) tape.repeat(0);
    const made = work.total;
    assert.deepEqual(tape.reports(from, tape.point()), [0]);
    const looked = work.total - made;
    assert.ok(looked <= 4 * Math.log2(k + 1), `${looked} blocks for ${k} repeats`);
  }
});

test("every landing call returns the walk's paths in order: each family and Astra's clock witness, four modes", async () => {
  // (the sample CI runs; the families at 16 to 128 and Astra's 178 sources, the 40 crossed seeds among them, run on the
  // queue: the PR's evidence)
  const shapes = await families();
  let calls = 0;
  for (const name of Object.keys(shapes)) calls += compared(shapes[name]!(4));
  // (seed 2: a cover stamped at the next free order moves q.g0 and q.g1 behind p.f1, Astra's design review; seed 1: a
  // listing's children taken out of their order)
  calls += compared(crossed(1)) + compared(crossed(2));
  // (a path the walk brought before a record opened, which the record's take must bring again: #1669's Codex r1
  // prefix case)
  calls += compared(
    [
      "let typed: integer | string = 1",
      "let base = {p: {a0: typed}, q: {b0: typed}}",
      "let mid = [base, {p: {a0: typed}, q: {b0: typed}}][0]",
      "let x = [{r: mid.p}, {r: mid.q}][0]",
      "let y = [{r: mid.q}, {r: {b0: typed}}][0]",
      'say "${x.r} ${y.r}"',
      "exit",
    ].join("\n") + "\n",
  );
  assert.ok(calls > 200, `${calls} calls compared`);
});

test("each reporter operation is debited where it happens", async () => {
  const shapes = await families();
  const ops: LandingOp[] = ["report", "child", "select", "visit", "node", "lookup", "publish"];
  const seen = new Set<LandingOp>();
  for (const name of ["narrow-repeat-3", "skip-2", "diamond-2", "skip-cross-3"]) {
    const request = coreRequest([{ path: "main.tease", source: shapes[name]!(8) }], GLOBALS);
    assert.ok(request !== null);
    withLandingOps(
      (place, _prefix, counts) => {
        for (const op of ops) {
          assert.equal(counts.debited[op], counts.ops[op], `${name}: ${op} at place ${place}`);
          if (counts.ops[op] > 0) seen.add(op);
        }
      },
      () => analyseCore(request),
    );
  }
  assert.deepEqual([...seen].sort(), [...ops].sort());
});

test("a fixed-width chain's landings take its listings: linear, and at most half the walk's", async () => {
  const shapes = await families();
  for (const name of [
    "narrow-after-chain",
    "join-reach-copy-left",
    "narrow-repeat-1",
    "narrow-repeat-3",
  ]) {
    const units = (k: number): { listed: number; walked: number } => {
      const request = coreRequest([{ path: "main.tease", source: shapes[name]!(k) }], GLOBALS);
      assert.ok(request !== null);
      const sum = { listed: 0, walked: 0 };
      withLandingComparison(
        (_place, _prefix, _listed, _walked, call) => {
          sum.listed += call.listed;
          sum.walked += call.walked;
        },
        () => analyseCore(request),
      );
      return sum;
    };
    const [small, large] = [units(32), units(64)];
    assert.ok(large.listed <= 2.15 * small.listed, `${name}: ${small.listed} → ${large.listed}`);
    assert.ok(
      2 * large.listed <= large.walked,
      `${name}: ${large.listed} of the walk's ${large.walked}`,
    );
  }
});

test("the census is the state a pass's admissions retain: tapes, listings, their tasks and every trie node", async () => {
  // (the admissions a pass makes, seen at their decisions; what their tries and pending listings hold, counted here
  // apart from the calls' own census, every object once)
  const shapes = await families();
  const decide = Admission.prototype.decide;
  for (const name of ["narrow-repeat-3", "diamond-2", "skip-cross-3"]) {
    const request = coreRequest([{ path: "main.tease", source: shapes[name]!(8) }], GLOBALS);
    assert.ok(request !== null);
    const admissions = new Set<Admission>();
    Admission.prototype.decide = function (
      this: Admission,
      ...args: Parameters<Admission["decide"]>
    ) {
      admissions.add(this);
      return decide.apply(this, args);
    };
    let reported = 0;
    let made = 0;
    try {
      withLandingOps(
        (_place, _prefix, counts) => {
          reported += counts.retained;
          made += counts.trieNodes;
        },
        () => analyseCore(request),
      );
    } finally {
      Admission.prototype.decide = decide;
    }
    type Held = Listing | LandingTape | TapePoint | LandingTask;
    const counted = new Set<Held>();
    let held = 0;
    let trie = 0;
    const once = (owner: Held, slots: number): void => {
      if (counted.has(owner)) return;
      counted.add(owner);
      held += slots;
    };
    const listing = (kept: Listing): void => {
      if (counted.has(kept)) return;
      once(kept, 1);
      const { tape } = kept;
      once(
        tape,
        tape.paths.reduce((sum, path) => sum + path.length + 4, 0) +
          3 * tape.at.length +
          tape.levels.slice(1).reduce((sum, level) => sum + level.length, 0),
      );
      for (const point of [kept.from, kept.own, kept.to]) once(point, 3);
      const task = (start: LandingTask): void => {
        for (let at: LandingTask | undefined = start; at !== undefined; at = at.parent)
          once(at, 4 + at.below.length + at.prepend.length);
      };
      task(kept.frame);
      for (const child of kept.children) {
        held += 1;
        once(child.from, 3);
        task(child.task);
      }
    };
    const node = (at: ListingNode): void => {
      held += 1;
      trie += 1;
      if (at.listing !== null) listing(at.listing);
      for (const next of at.next.values()) node(next);
    };
    for (const admission of admissions) {
      for (const root of admission.listings.values()) node(root);
      for (const pending of admission.pendingListings.values()) pending.forEach(listing);
    }
    assert.ok(trie > 0, name);
    assert.equal(made, trie, name);
    assert.equal(reported, held, name);
  }
});

/**
 * #1948: `r0` to `r3`, each `a` read at its own field, over four whole copies into `a` of objects whose one field is a
 * list of a written integer: each one's element inherits that type through the copy of the object holding its field
 * (`landed`), whose copies `landed` takes by the next step their sources land (`nextStepCopies`). `first` is `root0`'s
 * definition.
 */
function listCopies(first: string): string {
  const rows = (k: number, row: (i: number) => string) =>
    Array.from({ length: k }, (_, i) => row(i)).join("\n");
  return `${[
    "let t:integer=1",
    first,
    rows(3, (i) => `let root${i + 1}={f${i + 1}:[t]}`),
    "let a=root0",
    rows(3, (i) => `a=root${i + 1}`),
    rows(4, (i) => `let r${i}=a.f${i}`),
    "exit",
  ].join("\n")}\n`;
}

/**
 * The bindings whose published element type (`publishedAnswers`: every binding's admitted types asked in turn, the
 * root's before the element's) is not inherited through the copies, among `r0` to `r3`, in each of the four modes.
 */
function inheritedElements(source: string): readonly string[] {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null);
  const bindings = new CoreProgram(request).places.filter(({ kind }) => kind.kind === "binding");
  const reads = new Map(
    bindings.flatMap((place) =>
      place.kind.kind === "binding" && /^r\d$/.test(place.kind.name)
        ? [[place.id, place.kind.name] as const]
        : [],
    ),
  );
  assert.equal(reads.size, 4);
  const lost: string[] = [];
  for (const [index, mode] of MODES.entries())
    inMode(mode, () => {
      const answers = analyseCore(request);
      const { text } = publishedAnswers(
        answers,
        bindings.map(({ id }) => id),
        request,
      );
      // EVIDENCE: the publication's `admitted` lists each binding's place and its admitted types at its root and element.
      const { admitted } = JSON.parse(text) as {
        readonly admitted: readonly (readonly [
          number,
          unknown,
          { readonly inherited?: boolean },
        ])[];
      };
      for (const [place, , element] of admitted)
        if (reads.has(place) && element.inherited !== true)
          lost.push(`mode ${index}: ${reads.get(place)}`);
    });
  return lost;
}

/**
 * #1948: a copy whose source's landings are not its seeds alone is taken by `landed` whatever step follows: a source
 * other copies land in, a copy forest's child (its one whole copy of another place), a member of a cycle of copies and
 * a member of a cycle fed by one place's whole copies each land `f0` through the place copied into them, so `r0`'s
 * element inherits the written integer as `r1` to `r3` do.
 */
test("a copy whose source lands through other copies is taken for every path: copies in it, a forest's child, a cycle, a fed cycle (#1948)", () => {
  const lost = {
    copies: inheritedElements(
      listCopies("let w={f0:[t]}\nlet v={f0:[t]}\nlet root0=w\nif hostValue < 1 {root0=v}"),
    ),
    forest: inheritedElements(listCopies("let w={f0:[t]}\nlet root0=w")),
    cycle: inheritedElements(listCopies("let p={f0:[t]}\nlet root0=p\np=root0")),
    fed: inheritedElements(listCopies("let p0={f0:[t]}\nlet x=p0\nlet root0=x\nx=root0")),
  };
  assert.deepEqual(lost, { copies: [], forest: [], cycle: [], fed: [] });
});

/**
 * #1948: the next-step index is its admission's alone (`ReceivingDomain`, cleared by `reset` for each admission made on
 * a pass): a program whose objects hold the fields one place later, analysed after one that indexed the same places and
 * paths, inherits every element as it does alone.
 */
test("the next-step index is its admission's: a later program's copies are taken by their own sources' steps (#1948)", () => {
  const domain = new ReceivingDomain();
  domain.nextSteps.set("0|", { scans: 2, size: 1, next: new Map(), any: [] });
  domain.sourceSteps.set("0|", null);
  domain.reset();
  assert.deepEqual([domain.nextSteps.size, domain.sourceSteps.size], [0, 0]);
  const first = listCopies("let root0={f0:[t]}");
  // (the same places, each object holding the next one's field)
  const shifted = first.replace(
    /let root(\d)=\{f\d:/g,
    (_, i: string) => `let root${i}={f${(Number(i) + 1) % 4}:`,
  );
  assert.deepEqual(inheritedElements(first), []);
  assert.deepEqual(inheritedElements(shifted), []);
});
