import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, coreResult, type Answers } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import type { ContractFacts, PrefixStores } from "../src/type-inference/core/contract.js";
import { keyOf } from "../src/type-inference/core/definitions.js";
import { writerKey } from "../src/type-inference/core/items.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { narrowingPass } from "./helpers/type-core-narrowing.js";

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
    // (each nested literal's index the inner one's at its element, shared: the read one entry, never one per level)
    "a read in nested literals",
    "literalEntries",
    (k) =>
      `let seed = {a: 1}\nlet archive = ${"[".repeat(k)}seed${"]".repeat(k)}\nlet n: integer = archive${"[0]".repeat(k)}.a`,
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
 * TABLE r4.46 (3), §8 (review round 5 on #1027): the property a choice object's button value reads is decided once per
 * record where its literal is indexed, so k reads below the button value inspect each record once per read, never its
 * properties: from 8 to 32 fields and reads a linear count grows four times, a square sixteen times.
 */
test("a choice's selection inspects a record's properties once, not once per read below it", () => {
  const program = (k: number): string =>
    `let o = {${many(k, (i) => `f${i}: 1`, ", ")}, text: "unused", value: {${many(k, (i) => `p${i}: 1`, ", ")}}}\n${many(k, (i) => `repeat (askChoice o).p${i} {}`)}\nexit`;
  const small = facts(program(8)).selectionVisits;
  const large = facts(program(32)).selectionVisits;
  assert.ok(small > 0 && large <= 6 * small, `selection visits from 8 to 32: ${small}, ${large}`);
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

/**
 * A literal's signature names each path by its id (TABLE r4.58): `first` and `second` hold the same kinds in the same
 * order under the same record names and empty lists, but their integer at different paths, so they are two sources and
 * `archive`'s element at `.a` holds an integer; a signature without the paths' ids would merge them and lose it (the
 * deep-literal review's witness). Alike in both orders, with the sharing on and off.
 */
test("two literals whose kinds differ only in their paths are two sources, in both orders", () => {
  const request = coreRequest([
    {
      path: "main.tease",
      source:
        "let first = [{a: [], b: [1]}, {a: [], b: []}]\nlet second = [{a: [1], b: []}, {a: [], b: []}]\n" +
        "let archive = [first, second]\nlet n: integer = archive[0][0].a[0]\nexit\n",
    },
  ]);
  assert.ok(request !== null);
  const archive = new CoreProgram(request).places.find(
    (place) => place.kind.kind === "binding" && place.kind.name === "archive",
  );
  assert.ok(archive !== undefined);
  const answer = (): string => {
    const place = analyseCore(request).place(archive.id, ["element", "element", "a", "element"]);
    return `${place.contract.kinds.map((item) => item.tag).join("|")} ${place.admitted.by}`;
  };
  const reversed = (run: () => string): string =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => withSolverSeam({ reverseWorklist: true }, run),
    );
  assert.deepEqual(
    [answer(), reversed(answer), withoutSharing(answer), reversed(() => withoutSharing(answer))],
    Array<string>(4).fill("integer decided"),
  );
});

/**
 * #1392: a literal's class is its structure's, never what was asked of it before: two equal literals share one whether
 * or not absent properties were read of either first (Codex r3's probe of #1375), whichever is indexed first, with the
 * sharing on and off.
 */
test("two equal literals share a class whatever absent properties were asked of them before", () => {
  const request = coreRequest([
    {
      path: "main.tease",
      source: "let one = {a: 1}\nlet two = {a: 1}\nlet context = {q: {z: 1}}\nexit\n",
    },
  ]);
  assert.ok(request !== null);
  const got: string[] = [];
  for (const sharing of [true, false])
    for (const reversed of [false, true])
      for (const asked of ["none", "absent properties", "a path another literal holds"] as const) {
        const run = (): boolean => {
          const pass = narrowingPass(request);
          const { contract, program, solver } = pass;
          const literals = [...program.hasOf.keys()].filter((value) =>
            program.hasOf.get(value)!.some((has) => has.type.kind === "object"),
          );
          const [one, two] = literals;
          for (const value of reversed ? [...literals].reverse() : literals)
            contract.literalIndex(value);
          if (asked === "absent properties") {
            solver.run(contract.indexItems(two!, ["missingA"], null, false));
            solver.run(contract.indexItems(two!, ["missingB"], null, false));
          } else if (asked === "a path another literal holds") {
            solver.run(contract.indexItems(one!, ["q", "z"], null, false));
            solver.run(contract.indexItems(two!, ["missing"], null, false));
          }
          return contract.classOf(one!, false) === contract.classOf(two!, false);
        };
        if (!(sharing ? run() : withoutSharing(run)))
          got.push(
            `${sharing ? "shared" : "unshared"} ${reversed ? "reversed" : "in order"}: ${asked}`,
          );
      }
  assert.deepEqual(got, []);
});

/**
 * G5 (5a, #1339): a cycle of whole copies is cut at its stops at once, so each member's whole stores are one answer
 * whichever place enters the cycle first: its own entries, a copy of a member with more than one store an entry of that
 * member's key, a member with one store (a copy of another) replaced by its source's entry, and none of them cut. Asked
 * in fresh passes in three orders: the members in source order, reversed, and a copy outside the cycle first; the
 * stores, each entry's source, writer and stores that brought it, compared whole.
 */
const RINGS: readonly [string, string][] = [
  [
    "a ring fed once",
    "let good = {p0: 1}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\na0 = a3",
  ],
  [
    "a ring fed at every member",
    "let good = {p0: 1}\nlet other = {p0: 2}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\na0 = a3\n" +
      "a1 = other\na2 = other\na3 = other",
  ],
  [
    "a ring with chords",
    "let good = {p0: 1, p1: 1}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\na0 = a3\n" +
      "a0 = a2\na1 = a3\na2 = a0\na3 = a1",
  ],
  [
    "a ring whose members store their own properties",
    "let good = {f0: 1, f1: 1, f2: 1, f3: 1}\nlet a0 = good\na0.f0 = 2\nlet a1 = a0\na1.f1 = 2\nlet a2 = a1\n" +
      "a2.f2 = 2\nlet a3 = a2\na3.f3 = 2\na0 = a3",
  ],
  [
    "two rings through one member",
    "let good = {p0: 1}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\nlet a3 = a1\na1 = a2\na1 = a3\na0 = a2",
  ],
  [
    "a ring with a guarded copy",
    "let good = {p0: 1}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\na0 = a3\n" +
      "if a3.p0 is integer { a1 = a3 }",
  ],
];

test("each member of a cycle of whole copies has one answer whichever place enters the cycle first", () => {
  const text = (stores: PrefixStores): string =>
    JSON.stringify({
      list: stores.list.map((entry) => ({
        key: entry.key,
        value: entry.value,
        unk: entry.unk,
        empty: entry.empty,
        elem: entry.elem,
        at: entry.at,
        w: entry.w === null ? null : writerKey(entry.w),
        ds: [...entry.ds].map((d) => d?.uid ?? -1).sort((a, b) => a - b),
        guarded: entry.guarded,
        ingress: entry.ingress !== undefined,
      })),
      subs: stores.subs !== null,
      also: stores.also.length,
      other: stores.other,
      cut: stores.cut,
    });
  for (const [name, ring] of RINGS) {
    const request = coreRequest([
      { path: "main.tease", source: `${ring}\nlet outside = a2\nexit\n` },
    ]);
    assert.ok(request !== null, name);
    const { places } = new CoreProgram(request);
    const id = (named: string): number =>
      places.find((place) => place.kind.kind === "binding" && place.kind.name === named)!.id;
    const members = ["a0", "a1", "a2", "a3"].map(id);
    const asked = (order: readonly number[]): string[] => {
      const { contract } = narrowingPass(request);
      for (const place of order) contract.prefixStores(keyOf(place, []));
      return members.map((member) => text(contract.prefixStores(keyOf(member, []))));
    };
    const inSource = asked(members);
    assert.deepEqual(asked([...members].reverse()), inSource, `${name}: reversed`);
    assert.deepEqual(
      asked([id("outside"), ...[...members].reverse()]),
      inSource,
      `${name}: from outside`,
    );
    assert.ok(
      inSource.every((stores) => stores.endsWith('"cut":false}')),
      `${name}: no member's stores cut`,
    );
  }
});
