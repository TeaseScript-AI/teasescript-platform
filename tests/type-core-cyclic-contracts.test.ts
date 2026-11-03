import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import { withoutCycleCertificate } from "../src/type-inference/core/admission/holdings.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
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
 * copy objects of different property types, as the corpus's mutual feedback does). `off` reads the cycle from a place
 * outside it (`out`, holding a copy of a member), so the walk's own place is not on the cycle.
 */
function cycle(form: Form, k: number, off: boolean): string {
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
  if (off) lines.push("let c=a0", "let out={p:c}");
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
  // (each form, cycle length and place of the walk; the slice left at the store whose contract holds the cycle. Before,
  // each such program walked its cycle 256 levels deep at 12 to 24 million units, the analysis's charged total; now it
  // stops where the walk meets the cycle again: every total here is under 25,000 units)
  for (const form of ["property", "object", "list"] as const)
    for (const k of [1, 2, 3])
      for (const off of [false, true]) {
        const source = cycle(form, k, off);
        const name = `${form} k=${k}${off ? " off the cycle" : ""}`;
        assert.match(outcome(source), /^outside: .*a value whose structure the slice/, name);
        const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
        for (const mode of HELD_MODES) {
          const { budget } = mode.run(() => analyseCore(request));
          assert.equal(budget.exhausted, null, `${name}, ${mode.name}`);
          assert.ok(budget.total < 25_000, `${name}, ${mode.name}: ${budget.total}`);
        }
      }
});

test("a cycle of copies read through a ring of whole copies leaves the slice at linear cost (#1646)", () => {
  // (the generated family's seed 11: `p1` holds `p2`, a copy of itself, so `p1`'s levels read a ring of whole copies;
  // each wraps `p0`, whose `q` and `s` hold it again. Before the ring was closed, its holding stayed unfinished and
  // the walk ran to the slice's depth, 16,836,900 units)
  const source =
    'let typed:object={x:1}\nlet p0={f:typed,g:"s"}\nlet p1={f:typed,g:"s"}\nlet p2={f:typed,g:"s"}\np1.q=[p0]\np1=p2\np0.q={r:p0}\np1.q=[p0]\np2=p2\np0.s={r:p0}\np0.f=hostValue\nsay "AFTER"\nexit\n';
  assert.equal(
    outcome(source),
    withoutCycleCertificate(() => outcome(source)),
  );
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  for (const mode of HELD_MODES) {
    const { budget } = mode.run(() => analyseCore(request));
    assert.ok(budget.total < 25_000, `${mode.name}: ${budget.total}`);
  }
});

test("a list that holds itself leaves the slice instead of failing the compile (#1646)", () => {
  // (`l=[l]`: its lists nest without end; before, the facts' walk threw past the slice's depth and failed the compile)
  assert.equal(
    outcome('let l=[[1]]\nl=[l]\nl=hostValue\nsay "AFTER"\nexit\n'),
    "outside: The candidate type analysis does not cover the variable 'l', whose lists nest deeper than the slice follows yet (main.tease, offset 4).",
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
    // (copies no contract reads: dead after `exit`, and into a place with a written type)
    "let a={f:[[1]],g:1}\nlet b={f:[[2]],g:2}\na.f=hostValue\nlet out={p:a}\nout.p.g=hostOther\nexit\na.q=b\nb.q=a",
    "let t:object={x:1}\nlet a={f:[[1]],g:1}\na.q=t\nt=a\na.f=hostValue\nlet out={p:a}\nexit",
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
