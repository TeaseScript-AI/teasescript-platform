import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import { withoutCycleCertificate } from "../src/type-inference/core/admission/holdings.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { HELD_MODES } from "./helpers/type-core-held-host.js";

/*
 * A store contract that holds a cycle of copies (#1646, TABLE r4.278 (3)): its contract is infinite, and no finite plan
 * carries it. Each walk of a contract (the capture, the completion, the lowering, the facts) gives each level a holding,
 * the positions its key reads whole through copies (`admission/holdings.ts`); a level whose key reads a level still
 * open above it, or reads what one reads below it, takes the program out of the slice there, as at the slice's depth,
 * instead of walking 256 ever longer keys. Elsewhere every walk is the walk without the certificate.
 */

const GLOBALS = ["hostValue", "hostOther"];

/** How a cycle member holds the next: a property copy, an object literal around it, a list literal around it. */
type Form = "property" | "object" | "list";
const FORMS: Readonly<Record<Form, (next: string) => string>> = {
  property: (next: string) => next,
  object: (next: string) => `{r:${next}}`,
  list: (next: string) => `[${next}]`,
};

/**
 * A cycle of `k` places, each holding the next through `form` at `q`, whose stores owe their checks (alternate places
 * copy objects of different property types, as the corpus's mutual feedback does). Each store's walk is a member's, so
 * it meets the cycle again at a level that reads one it is inside of.
 */
function cycle(form: Form, k: number): string {
  const lines = [
    "let typed:object={x:1}",
    "let num:integer=1",
    'let text:string="x"',
    "let root={f:typed,g:num}",
    "let foreign={f:hostValue,g:text}",
  ];
  for (let i = 0; i < k; i += 1) lines.push(`let a${i}=${i % 2 === 0 ? "root" : "foreign"}`);
  lines.push("a0.f=hostValue");
  for (let i = k - 1; i >= 0; i -= 1) lines.push(`a${i}.q=${FORMS[form](`a${(i + 1) % k}`)}`);
  return `${lines.join("\n")}\nexit\n`;
}

/** The compile's outcome: the slice's exit with its site and what it names, else the plan's diagnostics. */
function outcome(source: string): string {
  try {
    const { diagnostics } = compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND);
    return JSON.stringify(diagnostics.map((d) => [d.code, d.message]));
  } catch (error) {
    if (!(error instanceof CandidateOutsideSlice)) throw error;
    return `outside: ${error.message}`;
  }
}

test("a store contract that holds a cycle of copies leaves the slice at linear cost (#1646)", () => {
  // (each form and cycle length; the slice left at the store whose contract holds the cycle. Before,
  // each such program walked its cycle 256 levels deep at 12 to 24 million units, the analysis's charged total; now it
  // stops where the walk meets the cycle again: every total here is under 25,000 units)
  for (const form of ["property", "object", "list"] as const)
    for (const k of [1, 2, 3]) {
      const source = cycle(form, k);
      const name = `${form} k=${k}`;
      assert.match(outcome(source), /^outside: .*a value whose structure the slice/, name);
      const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
      for (const mode of HELD_MODES) {
        const { budget } = mode.run(() => analyseCore(request));
        assert.equal(budget.exhausted, null, `${name}, ${mode.name}`);
        assert.ok(budget.total < 25_000, `${name}, ${mode.name}: ${budget.total}`);
      }
    }
});

test("a list that holds itself leaves the slice instead of failing the compile (#1646)", () => {
  // (found on main: `l=[l]` makes its lists nest without end, and the facts' walk threw past the slice's depth and failed
  // the compile. The backend's list-nesting rule takes it out of the slice; the capture's walk of `l`'s store meets the
  // cycle at its first element level, where it walked 256 levels, 523,745 units of the compile on main)
  const source = 'let l=[[1]]\nl=[l]\nl=hostValue\nsay "AFTER"\nexit\n';
  assert.equal(
    outcome(source),
    "outside: The candidate type analysis does not cover the variable 'l', whose lists nest deeper than the slice follows yet (main.tease, offset 4).",
  );
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  for (const mode of HELD_MODES) {
    const { budget } = mode.run(() => analyseCore(request));
    assert.ok(budget.total < 25_000, `${mode.name}: ${budget.total}`);
  }
});

test("a list below a property that holds itself leaves the slice instead of failing the compile (#1646)", () => {
  // (found on main: `a.f=[a.f]` nests `a.f`'s lists without end; the facts' walk threw past the slice's depth and failed
  // the compile, after the lowering's walk had followed the elements 256 levels down, about 555,000 units. The lowering's
  // walk of the store's contract meets the cycle at its first element level and leaves the slice there, so the compile
  // fits an allowance a tenth of that)
  const source = "let a={f:[[1]]}\na.f=[a.f]\na.f=hostValue\nexit\n";
  assert.match(
    withTestAllowance(50_000, () => outcome(source)),
    /^outside: .*a value whose structure the slice/,
  );
});

test("a contract walk without a cycle of copies is the walk without the certificate (#1646)", () => {
  // (copies that never hold a level in itself: chains, rings of whole copies at one path, wrappers, projections,
  // nested literals and a copy landing deeper than the copied place; and the corpus's in-slice families at small sizes)
  const lines = (k: number, f: (i: number) => string): string =>
    Array.from({ length: k }, (_, i) => f(i)).join("\n");
  const sources = [
    'let a={f:[[1]]}\nlet w0={q:a}\nlet w1={q:w0}\nlet w2={q:w1}\nlet b=w2\nb.q.q.q.f=hostValue\nsay "AFTER"\nexit',
    `${lines(3, (i) => `let a${i}={f:[[1]]}`)}\n${lines(3, (i) => `a${i}=a${(i + 1) % 3}`)}\na0.f=hostValue\nexit`,
    `${lines(3, (i) => `let a${i}={f:[[1]]}\nlet b${i}=a${i}\na${i}=b${i}`)}\na0.f=hostValue\nexit`,
    `let a={f:[[1]]}\n${lines(3, (i) => `let c${i}=${i === 0 ? "a" : `c${i - 1}`}`)}\n${lines(3, (i) => `let d${i}=c2\nd${i}.f=hostValue`)}\nexit`,
    "let a={f:[[1]],g:{h:[2]}}\nlet b={q:{r:a}}\nlet c=[b]\nlet out={p:c}\nout.p=hostValue\nexit",
    "let a={f:1}\nlet b={g:a}\nlet out={p:b.g}\nout.p.f=hostValue\nexit",
    "let out={p:{q:{r:[[1]]}}}\nout.p.q.r=hostValue\nexit",
    "let a={f:[[1]]}\nlet out={p:a}\nout.p.q={s:a}\nout.p.f=hostValue\nexit",
    'let a={f:[[1]]}\nlet b=a\nb.f=hostValue\nsay "AFTER"\nexit',
    // (Codex r1 B1: `b.q` copied into `b.q.q` holds nothing, so its reads repeat without a contribution: `a`'s levels read
    // the same two positions two levels apart, and the contract is `a`'s finite literal)
    'let b={}\nb.q.q=b.q\nlet a={q:{q:{q:{f:[[1]]}}}}\na=b.q\na=hostValue\nsay "AFTER"\nexit',
    // (Codex r2 B1: the same with `b.q=null`, which repeats no structure either; both walks go down `a`'s own literal,
    // so the levels below `a.q` are not pure)
    'let b={}\nb.q=null\nb.q.q=b.q\nlet a={q:{q:{q:{f:[[1]]}}}}\na=b.q\na=hostValue\nsay "AFTER"\nexit',
    // (Codex r2: a copy that lands below a level, `a.q.q=seed`, with an unrelated cycle that makes holdings be built)
    "let seed={f:[[1]]}\nlet unused={}\nunused.x=unused\nlet a={q:seed}\na.q.q=seed\na=hostValue\nexit",
    // (copies no contract reads, which would close a cycle along a path the walk descends: a store A6 rejects, and one
    // into a place with a written type, whose contract is that type)
    "let a={f:[[1]]}\nlet b={s:[[1]]}\nb.q=[[1]]\nb.q=a\na.q=b\na=hostValue\nexit",
    "let t:object={x:1}\nlet a={f:[[1]]}\na.q={s:[[1]]}\nt=a\na.q.q=t\na=hostValue\nexit",
  ];
  for (const source of sources) {
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    assert.ok(request !== null, source);
    assert.equal(
      outcome(source),
      withoutCycleCertificate(() => outcome(source)),
      source,
    );
    for (const mode of HELD_MODES) {
      const contracts = (): string =>
        JSON.stringify(mode.run(() => analyseCore(request)).contracts.map((c) => c.result));
      assert.equal(contracts(), withoutCycleCertificate(contracts), `${source}, ${mode.name}`);
    }
  }
});

/** A small deterministic generator (mulberry32), so a seed names one program. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The generated family's program of a seed (the PR's queue evidence runs 4,000 of them): two to four places, some
 * empty, two to six copies among them (a property copy, an object or list literal around one, a whole copy, a
 * projection into a property or a property's property, a whole store of a projection), host data stored, and half the
 * time a place outside reading one of them.
 */
function generated(seed: number): string {
  const r = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
  const names = Array.from({ length: 2 + Math.floor(r() * 3) }, (_, i) => `p${i}`);
  const lines = ["let typed:object={x:1}"];
  for (const p of names)
    lines.push(
      pick([`let ${p}={f:[[1]],g:1}`, `let ${p}={f:typed,g:"s"}`, `let ${p}={g:2}`, `let ${p}={}`]),
    );
  const steps = 2 + Math.floor(r() * 5);
  for (let i = 0; i < steps; i += 1) {
    const [a, b] = [pick(names), pick(names)];
    const prop = pick(["q", "q", "s"]);
    lines.push(
      pick([
        `${a}.${prop}=${b}`,
        `${a}.${prop}={r:${b}}`,
        `${a}.${prop}=[${b}]`,
        `${a}=${b}`,
        `${a}.${prop}=${b}.${pick(["q", "s", "g"])}`,
        `${a}.${prop}.${pick(["q", "s"])}=${b}.${pick(["q", "s"])}`,
        `${a}=${b}.${pick(["q", "s"])}`,
      ]),
    );
  }
  lines.push(`${pick(names)}.f=hostValue`);
  if (r() < 0.5) lines.push(`let out={p:${pick(names)}}`, "out.p.g=hostOther");
  return `${lines.join("\n")}\nsay "AFTER"\nexit\n`;
}

test("the generated family's first seeds compile alike with and without the certificate (#1646)", () => {
  // (seeds 1 to 30, forward. Five hold cycles a walk is inside of, whose walks without the certificate take 13 to 28
  // million units: there the program leaves the slice at linear cost, the outcome the walk to the slice's depth gives.
  // Seed 19 is the ruling's case (c): without the certificate the walk exhausts the allowance (TSV076, a plan of runtime
  // checks); with it the analysis ends and the program leaves the slice at another construct. Seeds 24 and 25 walk a
  // cycle from a place outside it, which the certificate does not prove: 8 and 15 million units as on main. Seed 8
  // stops before admission on main as on the head, #1655)
  const cyclic = new Set([6, 9, 15, 17, 28]);
  for (let seed = 1; seed <= 30; seed += 1) {
    if ([8, 24, 25].includes(seed)) continue;
    const source = generated(seed);
    if (seed === 19) {
      assert.match(outcome(source), /^outside: /, `seed ${seed}`);
      continue;
    }
    if (!cyclic.has(seed)) {
      assert.equal(
        outcome(source),
        withoutCycleCertificate(() => outcome(source)),
        `seed ${seed}`,
      );
      continue;
    }
    assert.match(outcome(source), /^outside: .*a value whose structure the slice/, `seed ${seed}`);
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    assert.ok(analyseCore(request).budget.total < 25_000, `seed ${seed}`);
  }
});

test("a ring of whole copies costs its copies once, in both orders (Codex r1 B2)", () => {
  // (k places that copy one another round a ring, each with a copy landing below it: a finite contract. Each member read
  // every other, a ring of k copies k × k reads; at k = 128, 4.5 million units where main takes 154,530. The ring is one
  // position now, so the total at most doubles with k; and it compiles as without the certificate)
  const ring = (k: number): string => {
    const lines = ["let seed={f:[[1]],q:{}}"];
    for (let i = 0; i < k; i += 1) lines.push(`let a${i}=seed`);
    for (let i = 0; i < k; i += 1) lines.push(`a${i}=a${(i + 1) % k}`, `a${i}.q=seed`);
    return `${lines.join("\n")}\na0.f=hostValue\nexit\n`;
  };
  assert.equal(
    outcome(ring(8)),
    withoutCycleCertificate(() => outcome(ring(8))),
  );
  for (const mode of HELD_MODES.slice(0, 2)) {
    const total = (k: number): number =>
      mode.run(() => analyseCore(coreRequest([{ path: "main.tease", source: ring(k) }], GLOBALS)!))
        .budget.total;
    const [small, large] = [total(32), total(64)];
    assert.ok(large / small < 2.2, `${mode.name}: ${small} → ${large}`);
  }
});
