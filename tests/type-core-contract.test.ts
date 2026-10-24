import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, coreResult, type Answers } from "../src/type-inference/core/answers.js";
import type { ContractFacts } from "../src/type-inference/core/contract.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import { coreRequest } from "./helpers/type-core-analysis.js";

/**
 * The contract's identity and mark controls (checkpoint 9, TABLE §8's contract row r4.15–r4.27): every path that
 * enters a source into the contract's indexes obtains its identity from one function, so k contributions of one source
 * are one entry on every path; the marks of §3.2 live in one holder per source and projection whose references
 * compose, so the mark structures a program makes and the lookups its reads make grow with k, never with k². The
 * programs are the reference model's ledger controls (`budget-check.mjs`, check 4), with the boolean host flag an
 * interaction, as the expectation set writes it.
 */

const many = (k: number, part: (index: number) => string, separator = "\n"): string =>
  Array.from({ length: k }, (_, index) => part(index)).join(separator);

/** A program of main alone, with a boolean `flagHost` from an interaction before it. */
const flagged = (source: string): string => `let flagHost = askBoolean "flag"\n${source}`;

function analysed(source: string): Answers {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, `the program parses and resolves: ${source.slice(0, 80)}`);
  return analyseCore(request);
}

const facts = (source: string): ContractFacts => analysed(flagged(source)).budget.facts;

const SNAPSHOT = "global seed = {a: 1}\nfunction snapshot { return seed }\n";

/** Per entry path into the contract's indexes, a program with k contributions of one source, and the index it enters. */
const IDENTITY: readonly [string, "prefixEntries" | "literalEntries", (k: number) => string][] = [
  [
    "a whole store",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1}\nlet picked = seed\n${many(k, () => "if flagHost { picked = seed }")}\nlet n: integer = picked.a`,
  ],
  [
    "a guarded copy",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1}\nlet picked = seed\n${many(k, () => "if seed != null { picked = seed }")}\nlet n: integer = picked.a`,
  ],
  [
    "a copy with a tested child",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1, b: 1}\nlet picked = seed\n${many(k, () => "if seed.a is integer { picked = seed }")}\nlet n: integer = picked.b`,
  ],
  [
    "a call result in a store",
    "prefixEntries",
    (k) =>
      `${SNAPSHOT}let archive = snapshot()\n${many(k, () => "if flagHost { archive = snapshot() }")}\nlet n: integer = archive.a`,
  ],
  [
    "a literal in a store",
    "prefixEntries",
    (k) =>
      `${SNAPSHOT}let archive = {layer: [snapshot()]}\n${many(k, () => "if flagHost { archive = {layer: [snapshot()]} }")}\nlet n: integer = archive.layer.first.a`,
  ],
  [
    "an argument",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1}\nfunction take(p) { let n: integer = p.a }\n${many(k, () => "take(seed)")}`,
  ],
  [
    "an add",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1}\nlet xs = [seed]\n${many(k, () => "xs.add(seed)")}\nlet n: integer = xs.first.a`,
  ],
  [
    "a store through a prefix",
    "prefixEntries",
    (k) =>
      `let seed = {a: 1, b: 1}\nseed.a = 2\nlet picked = seed\n${many(k, () => "if flagHost { picked = seed }")}\nlet n: integer = picked.a`,
  ],
  [
    "an alias",
    "literalEntries",
    (k) =>
      `let seed = {a: 1}\n${many(k, (i) => `let s${i} = seed`)}\nlet archive = [${many(k, (i) => `s${i}`, ", ")}]\nlet n: integer = archive.first.a`,
  ],
  [
    "a place of copies",
    "literalEntries",
    (k) =>
      `let seed = {a: 1}\n${many(k, (i) => `let c${i} = seed\nif seed.a is integer { c${i} = seed }`)}\nlet archive = [${many(k, (i) => `c${i}`, ", ")}]\nlet n: integer = archive.first.a`,
  ],
  [
    "a read in a literal",
    "literalEntries",
    (k) =>
      `let seed = {a: 1}\nlet archive = [${many(k, () => "seed", ", ")}]\nlet n: integer = archive.first.a`,
  ],
  [
    "a call result in a literal",
    "literalEntries",
    (k) =>
      `${SNAPSHOT}let archive = [${many(k, () => "snapshot()", ", ")}]\nlet n: integer = archive.first.a`,
  ],
  [
    "a guarded wrapper literal",
    "prefixEntries",
    (k) =>
      `let root = {p0: 2.0, p1: 2.0}\nlet picked = {layer: [root]}\n${many(k, (i) => `if root.p${i % 2} is integer { picked = {layer: [root]} }`)}\nlet x: number = picked.layer.first.p0\nlet y: number = picked.layer.first.p1`,
  ],
];

test("two and eight contributions of one source give the same entries on every entry path", () => {
  // (two and eight: a single-site argument is exact, F21, so one would differ for another reason)
  const growing = IDENTITY.filter(
    ([, index, program]) => facts(program(2))[index] !== facts(program(8))[index],
  );
  assert.deepEqual(
    growing.map(([path]) => path),
    [],
  );
});

/** Programs with k aliases, guards or wrappers of one source, whose mark structures and lookups grow O(k). */
const MARKS: readonly [string, (k: number) => string][] = [
  [
    "an alias chain",
    (k) =>
      `let seed = {n0: 1, n1: 1}\nlet a0 = seed\nif a0.n0 is not integer { exit }\n${many(k - 1, (i) => `let a${i + 1} = a${i}\nif a${i + 1}.n0 is not integer { exit }`)}\nlet out: integer = a${k - 1}.n1`,
  ],
  [
    "an alias group",
    (k) =>
      `let seed = {n0: 1, ${many(k, (i) => `f${i}: 1`, ", ")}}\n${many(k, (i) => `let a${i} = seed\nlet b${i} = a${i}\nif a${i}.n0 is integer { b${i} = a${i} }`)}\nlet bundle = [${many(k, (i) => `b${i}`, ", ")}]\n${many(k, (i) => `let n${i}: integer = bundle.first.f${i}`)}`,
  ],
  [
    "sibling guards",
    (k) =>
      `let seed = {${many(k, (i) => `f${i}: 1`, ", ")}}\nlet picked = seed\n${many(k, (i) => `if seed.f${i} is integer { picked = seed }`)}\n${many(k, (i) => `let n${i}: integer = picked.f${i}`)}`,
  ],
  [
    "every alias tested",
    (k) =>
      `let seed = {${many(k, (i) => `n${i}: 3`, ", ")}}\nlet a0 = seed\nif a0.n0 is integer { say "ok" }\n${many(k, (i) => `let a${i + 1} = a${i}\nif a${i + 1}.n0 is integer { say "ok" }`)}\nlet bundle = a${k}\n${many(k, (i) => `let out${i}: integer = bundle.n${i}`)}`,
  ],
  [
    "one entry's reads shared by k entries",
    (k) =>
      `let seed = {n0: 3, n1: 3}\n${many(k, (i) => `let a${i} = seed\nif a${i}.n0 is integer { say "ok" }`)}\nlet picked = seed\n${many(k, (i) => `if flagHost { picked = a${i} }`)}\n${many(k, (j) => `let c${j} = picked\nif flagHost { c${j} = picked }\nlet o${j}: integer = c${j}.n0`)}`,
  ],
  [
    "a chain read through k aliases of its end",
    (k) =>
      `let seed = {n0: 3}\nlet a0 = seed\n${many(k, (i) => `let a${i + 1} = a${i}\nif a${i + 1}.n0 is integer { say "ok" }`)}\n${many(k, (j) => `let b${j} = a${k}\nlet o${j}: integer = b${j}.n0`)}`,
  ],
  [
    "a chain of projected aliases",
    (k) =>
      `let seed = ${Array.from({ length: k }).reduce<string>((literal) => `{x: ${literal}, t: 3}`, "3")}\nlet p0 = seed\n${many(k - 1, (i) => `if p${i}.x.t is integer { say "ok" }\nlet p${i + 1} = p${i}.x`)}\n${many(k, (j) => `let q${j} = p${k - 1}\nlet o${j}: integer = q${j}.t`)}`,
  ],
  [
    "guarded projected aliases",
    (k) =>
      `let root = {wrap: {flag: 2.0, ${many(k, (i) => `p${i}: 2.0`, ", ")}}}\nlet picked = root.wrap\n${many(k, (i) => `if root.wrap.flag is integer { let a${i} = root.wrap\npicked = a${i} }`)}\n${many(k, (i) => `let got${i}: number = picked.p${i}`)}`,
  ],
  [
    "projected aliases in wrappers",
    (k) =>
      `let root = {wrap: {flag: 2.0, ${many(k, (i) => `p${i}: 2.0`, ", ")}}}\nlet picked = {one: [{two: root.wrap}]}\n${many(k, (i) => `if root.wrap.flag is integer { let a${i} = root.wrap\npicked = {one: [{two: a${i}}]} }`)}\n${many(k, (i) => `let got${i}: number = picked.one.first.two.p${i}`)}`,
  ],
  [
    "wrappers of one alias",
    (k) =>
      `let seed = {n0: 3, n1: 3}\nlet selected = seed\n${many(k, () => "if seed.n0 is integer { selected = seed }")}\n${many(k, (i) => `let w${i} = {shell: [{payload: selected}]}`)}\nlet bag = [${many(k, (i) => `w${i}`, ", ")}]\nrepeat bag.first.shell.first.payload.n1 {}`,
  ],
  [
    "an alias forest",
    (k) =>
      `let seed = {${many(k + 1, (i) => `n${i}: 3`, ", ")}}\nlet merged = seed\n${many(k, (i) => `let a${i} = seed\nif a${i}.n0 is not integer { exit }\nlet b${i} = a${i}\nif b${i}.n0 is not integer { exit }\nlet c${i} = b${i}\nif flagHost { merged = c${i} }`)}\n${many(k, (j) => `repeat merged.n${j + 1} {}`)}`,
  ],
  [
    "callable groups per tested field",
    (k) =>
      `let root = {wrap: {${many(k, (i) => `f${i}: "x"`, ", ")}}}\nlet picked = root.wrap\n${many(k, (i) => `function contribute${i} { if root.wrap.f${i} is integer { picked = root.wrap } }\ncontribute${i}()`)}\n${many(k, (i) => `say picked.f${i} + 1`)}`,
  ],
  [
    "logical operand tests in k callables",
    (k) =>
      `let root = {${many(k, (i) => `f${i}: "bad"`, ", ")}}\nlet chosen = root\n${many(k, (i) => `function pick${i} { chosen = root }\npick${i}()`)}\n${many(k, (i) => `say root.f${i} is integer and flagHost\nif chosen.f${i} is integer { repeat chosen.f${i} {} }`)}\nexit`,
  ],
  [
    "operand tests in k functions",
    (k) =>
      `let root = {wrap: {${many(k, (i) => `f${i}: "x"`, ", ")}}}\nlet picked = root.wrap\n${many(k, (i) => `function take${i} {\nlet checked${i} = root.wrap.f${i} is integer and root.wrap.f${i} == 1\npicked = root.wrap\n}\ntake${i}()`)}\n${many(k, (i) => `say picked.f${i} + "tail"`)}\nexit`,
  ],
  [
    "one source read k times in a literal",
    (k) =>
      `let seed = {t: 3, ${many(k, (i) => `f${i}: 3`, ", ")}}\nif seed.t is integer { say "ok" }\nlet archive = [${many(k, () => "seed", ", ")}]\n${many(k, (i) => `let o${i}: integer = archive.first.f${i}`)}`,
  ],
];

test("the mark structures and lookups grow with the aliases, guards and wrappers of one source, not their square", () => {
  // from 8 to 32 a linear count grows four times, a square sixteen times
  const growing = MARKS.filter(([, program]) => {
    const small = facts(program(8));
    const large = facts(program(32));
    return (["markNodes", "markVisits"] as const).some(
      (fact) => large[fact] > 6 * Math.max(1, small[fact]),
    );
  });
  assert.deepEqual(
    growing.map(([shape]) => shape),
    [],
  );
});

/**
 * r4.27: one holder per source and projection merges its contributions' guards, so a tested path's mark reaches an
 * untested sibling entry's read of that path: its error becomes a warning with its check, never silence; the same read
 * without the test errs, and so does the untested field.
 */
test("a tested path's mark reaches every entry of its source, and only that path", () => {
  const pair = (guard: string, read: string): string =>
    flagged(
      `let seed = {n: 1.5, m: 2.5}\nlet a = seed\n${guard}\nlet b = seed\nif flagHost { b = seed }\n${read}\nexit`,
    );
  const result = (source: string): { outcome: string; checked: boolean } => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const record = coreRecord(coreResult(analyseCore(request)), ["main.tease"]);
    return {
      outcome: record.outcome,
      checked: record.runtimeChecks.some(
        (check) => check.kind === "copy-type" && check.target === "x",
      ),
    };
  };
  assert.deepEqual(result(pair("if seed.n is integer { a = seed }", "let x: integer = b.n")), {
    outcome: "warning-runtime-check",
    checked: true,
  });
  assert.deepEqual(result(pair("if flagHost { a = seed }", "let x: integer = b.n")), {
    outcome: "compile-error",
    checked: false,
  });
  assert.deepEqual(result(pair("if seed.n is integer { a = seed }", "let x: integer = b.m")), {
    outcome: "compile-error",
    checked: false,
  });
});

test("a chain of whole copies read at k fields resolves each copy once (W34)", () => {
  const chain = (k: number): string =>
    flagged(
      `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif flagHost { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `let box${i + 1} = box${i}`)}\n${many(k, (i) => `repeat box${k}.f${i} {}`)}\nexit`,
    );
  const counts = (k: number): ReadonlyMap<string, number> => analysed(chain(k)).budget.counts;
  const small = counts(8);
  const large = counts(32);
  for (const counter of ["exactQueries", "exactValues"] as const)
    assert.ok(
      (large.get(counter) ?? 0) <= 8 * Math.max(1, small.get(counter) ?? 0),
      `${counter}: ${small.get(counter)} at 8, ${large.get(counter)} at 32`,
    );
});

/**
 * §8: the prefix index and the handler index do work linear in the copies and reads (review r1): an edited record
 * copied through k aliases inherits its source once per alias, not under each of its k fields; k reads of a record
 * with k stores below it look a block's stores up by the read's path (X7), never by the keys below it.
 */
const INDEXES: readonly [string, "invSteps" | "eventSteps", (k: number) => string][] = [
  [
    "an edited record through k aliases",
    "invSteps",
    (k) =>
      `let root = {${many(k, (i) => `f${i}: 2.0`, ", ")}}\n${many(k, (i) => `root.f${i} = 3.0`)}\nlet a0 = root\n${many(k - 1, (i) => `let a${i + 1} = a${i}`)}\nlet out: integer = a${k - 1}.f0\nexit`,
  ],
  [
    "k reads of a record with k stores below it beside a block",
    "eventSteps",
    (k) =>
      `let other = 1\nshowPermanentButton "x" { other = 2 }\nlet state = {${many(k, (i) => `f${i}: 1`, ", ")}}\n${many(k, (i) => `state.f${i} = 2`)}\nstate = {${many(k, (i) => `f${i}: 3`, ", ")}}\n${many(k, () => "repeat state {}")}`,
  ],
];

test("the prefix index and the handler index grow with the copies and reads, not their square", () => {
  const growing = INDEXES.filter(([, counter, program]) => {
    // from 32 to 128 a linear count grows four times, a square sixteen times (at 8 the square term is still small)
    const small = analysed(program(32)).budget.counts.get(counter) ?? 0;
    const large = analysed(program(128)).budget.counts.get(counter) ?? 0;
    return large > 6 * Math.max(1, small);
  });
  assert.deepEqual(
    growing.map(([shape]) => shape),
    [],
  );
});

/**
 * Native resilience (TABLE §8): flat chains of 8,192 links run through every walk along aliases, copies, wrappers and
 * default sources on explicit stacks or loops (review r1: the default-source and alias-root walks recursed natively).
 */
const CHAINS: readonly [string, string, (k: number) => string][] = [
  [
    "copies of a text read at its length",
    "valid",
    (k) => `let v0 = "text"\n${many(k, (i) => `let v${i + 1} = v${i}`)}\nsay v${k}.length`,
  ],
  [
    "aliases of a record read under a test",
    "warning-runtime-check",
    (k) =>
      `let root = {n: 2.0}\nlet a0 = root\n${many(k - 1, (i) => `let a${i + 1} = a${i}`)}\nif a${k - 1}.n is integer {\n  let picked = a${k - 1}\n  let out: integer = picked.n\n}\nexit`,
  ],
  [
    "copies stored twice",
    "compile-error",
    (k) =>
      `let flag = askBoolean "f"\nlet b0 = {n: 2.0}\n${many(k, (i) => `let b${i + 1} = b${i}\nif flag { b${i + 1} = b${i} }`)}\nlet out: integer = b${k}.n\nexit`,
  ],
  [
    "records wrapping the one before",
    "compile-error",
    (k) =>
      `let w0 = {n: 2.0}\nif w0.n is integer { say "ok" }\n${many(k, (i) => `let w${i + 1} = {x: w${i}}`)}\nlet out: integer = w${k}.x.n\nexit`,
  ],
];

test("flat chains of 8,192 links analyse without native recursion", () => {
  assert.deepEqual(
    CHAINS.map(([shape, , program]) => `${shape}: ${analysed(program(8192)).outcome}`),
    CHAINS.map(([shape, outcome]) => `${shape}: ${outcome}`),
  );
});
