import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { PlaceId } from "../src/type-inference/graph.js";
import {
  analyseCore,
  coreResult,
  solveDemands,
  type Answers,
  type CorePass,
} from "../src/type-inference/core/answers.js";
import { joinSteps } from "../src/type-inference/core/budget.js";
import type { Contract, ContractFacts, PrefixStores } from "../src/type-inference/core/contract.js";
import {
  offendingStores,
  summaryCount,
  summaryItems,
  summaryPresence,
} from "../src/type-inference/core/contract/prefix-index.js";
import {
  exportNames,
  isSteps,
  PathSteps,
  spanRef,
  stepsRest,
  type Rest,
} from "../src/type-inference/core/contract/key-ids.js";
import { entryGroups, groupsAt, prefixLevels } from "../src/type-inference/core/contract/levels.js";
import { annotated } from "../src/type-inference/core/contract/marks.js";
import { keyOf, type Key } from "../src/type-inference/core/definitions.js";
import { withWriter } from "../src/type-inference/core/exact-path.js";
import { mergeItems, REASON, writerKey, type Item } from "../src/type-inference/core/items.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import type { Solver, Work } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { PROPERTY_STORE_FAMILIES } from "./helpers/type-core-families.js";
import { narrowingPass } from "./helpers/type-core-narrowing.js";
import {
  inMode,
  inOrder,
  itemText,
  mergedIdentity,
  MODES,
  publishedAnswers,
  publishedRoute,
  publishedUpToOrder,
} from "./helpers/type-core-oracles.js";

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
  // (behind a wrapper the guarded copy is of its projection, a copy the marks still collect: a test names the wrapper,
  // so its keys are text, G3 stage 1)
  const wrapped = flagged(
    "let seed = {n: 1.5, m: 2.5}\nlet w = {q: seed}\nlet a = w.q\nif w.q.n is integer { a = w.q }\nlet b = w.q\nif flagHost { b = w.q }\nlet x: integer = b.n\nexit",
  );
  assert.deepEqual(result(wrapped), { outcome: "warning-runtime-check", checked: true });
});

/**
 * #1466: A5's candidates through a prefix's layers are the stores that brought each layer whose summary holds an
 * offending item, a joined layer's too: `t` decided a whole number by its start value, then copied `a2`, whose own
 * store below its root brings host data, owes its check at that copy, in either order.
 */
test("a copy that joins a layer of host data owes its check where the layer's summary offends (#1466)", () => {
  const source =
    "let a = {g: 1}\nlet b = {g: 1}\nlet a2 = a\na2.g = hostValue\nlet b2 = b\nb2.g = 2\nlet t = b2\nt = a2\nrepeat t.g {}\nexit";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  for (const reversed of [false, true]) {
    const { checks } = inOrder(reversed, () => compactAnalysis(request));
    assert.ok(
      checks.some(
        (check) =>
          check.kind === "copy-type" &&
          check.target === "t.g" &&
          source.slice(check.site.offset, check.site.end) === "a2",
      ),
      `reversed: ${reversed}`,
    );
  }
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
  const reversed = (run: () => string): string => inOrder(true, run);
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
 * in fresh passes in three orders: the members in source order, reversed, and a copy outside the cycle first; each
 * entry's source, path, writer, holder, guard and the stores that brought it compared, whether it holds ingress, and whether the stores
 * hold layers, hold more than copies, and are cut.
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
        holder: entry.holder?.id ?? null,
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

/**
 * TABLE r4.185 (G5 5a's case 5): a stop whose own entries merge into one (two copies of one member, two copies reaching
 * one member, a plain and a guarded copy of one member, of one holding an operation's result too, a copy of a parameter
 * no call reaches) was replaced by its entry where `main`'s walk reached it and cut where it was open, so `main`'s answer
 * hung on which place entered the cycle first; the cut is now the open stop's everywhere. What it publishes may differ
 * from `main`'s only in the order of the items in an answer and of the kinds in a decided admitted type: in all four
 * modes, its records and route are one, the rest (`publishedUpToOrder`) is one with those orders set aside, and both are
 * `main`'s: the hashes of the record with the route, its diagnostics by their identity (`mergedIdentity`), and of the
 * publication with those orders set aside, and its outcome, diagnostics, checks and decided types with their deciders,
 * are a regression oracle taken from `main` at `ab3ec62bf` for these sources only (a change that changes `main`'s records
 * of them updates it; a change of a message, or of the fix's facts `mergedIdentity` sets aside, does not).
 */
const MERGED_STOPS: readonly [string, string, MergedRecord][] = [
  [
    "two copies of one member",
    'let bad = {p0: "x", p1: "x"}\nlet wobj: object? = {p0: 1}\nlet a0 = bad\nlet a1 = a0\nlet a2 = a1\na2 = a1\n' +
      "a0 = a2\na1 = wobj\nexit\n",
    {
      record: "8aaeac9dadbf8b26",
      upToOrder: "8ec84600facd682a",
      compact: [
        "valid",
        "bad object by 10",
        "bad.p0 string by 15",
        "bad.p1 string by 24",
        "wobj.element unknown by -",
        "wobj.p0 unknown by 54",
        "a0 null|object by 66",
        "a0.p0 integer|string by 66",
        "a0.p1 string by 66",
        "a1 null|object by 79",
        "a1.p0 integer|string by 79",
        "a1.p1 string by 79",
        "a2 null|object by 91",
        "a2.p0 integer|string by 91",
        "a2.p1 string by 91",
      ],
    },
  ],
  [
    "a plain and a guarded copy of one member",
    "let good = [1]\nlet host = hostValue\nlet a5 = good\nlet a4 = a5\nlet a3 = a4\nlet a1 = a3\nlet a0 = a1\n" +
      "if a1 != null {\n  a0 = a1\n}\na5 = a0\na1 = host\nexit\n",
    {
      record: "6ac9cd3fc25be5c7",
      upToOrder: "e56cd6479164593a",
      compact: [
        "warning-runtime-check",
        "warning-runtime-check TSV041 121-123",
        "warning-runtime-check TSV041 131-133",
        "warning-runtime-check TSV041 131-133",
        "warning-runtime-check TSV041 139-143",
        "check copy-type host 26",
        "check copy-type a0.element 121",
        "check copy-type a0.element 121",
        "check copy-type a5 131",
        "check copy-type a5.element 131",
        "check copy-type a5.element 131",
        "check copy-type a1 139",
        "good list by 11",
        "good.element integer by 12",
        "a5 list by 45",
        "a5.element integer by 45",
        "a4 list by 59",
        "a4.element integer by 59",
        "a3 list by 71",
        "a3.element integer by 71",
        "a1 list by 83",
        "a1.element integer by 83",
        "a0 list by 95",
        "a0.element integer by 95",
      ],
    },
  ],
  [
    "two copies reaching one member",
    'let good = {p0: 1}\nlet bad = {p0: "x"}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\na0 = a2\nlet b = a1\nb = a2\n' +
      'a0 = b\na2 = bad\nsay "${a0.p0}"\nsay "${a1.p0}"\nsay "${a2.p0}"\nexit\n',
    {
      record: "47db810b2ecdbb7b",
      upToOrder: "63c49cbe0b0205e9",
      compact: [
        "compile-error",
        "compile-error TSV041 115-118",
        "good object by 11",
        "good.p0 integer by 16",
        "bad object by 29",
        "bad.p0 string by 34",
        "a0 object by 48",
        "a0.p0 integer by 48",
        "a1 object by 62",
        "a1.p0 integer by 62",
        "a2 object by 74",
        "a2.p0 integer by 74",
        "b object by 93",
        "b.p0 integer by 93",
      ],
    },
  ],
  [
    "a copy of a parameter no call reaches",
    'let bad = {p0: "x"}\nfunction f(x) {\n  let a = x\n  let b = a\n  a = b\n  b = bad\n  say "${a.p0}"\n}\nexit\n',
    {
      record: "1c31c49184a58f96",
      upToOrder: "e721593c76151fe3",
      compact: [
        "valid",
        "bad object by 10",
        "bad.p0 string by 15",
        "a object by 66",
        "a.p0 string by 66",
        "b object by 58",
        "b.p0 string by 58",
      ],
    },
  ],
  [
    "a plain and a guarded copy of a member holding an operation's result",
    "let seed = [hostValue + 1, hostValue, hostValue + hostValue]\nlet a = seed\nlet b = a\nlet c = b\n" +
      "if b != null {\n  c = b\n}\na = c\nb = [1]\nlet value = a[0]\nexit\n",
    {
      record: "87391b2d85943354",
      upToOrder: "3a0cd1e7a8ab7743",
      compact: [
        "warning-runtime-check",
        "warning-runtime-check TSV043 12-21",
        "warning-runtime-check TSV043 38-47",
        "warning-runtime-check TSV043 50-59",
        "warning-runtime-check TSV041 82-83",
        "check operand hostValue 12",
        "check copy-type seed.element 12",
        "check operand hostValue 38",
        "check operand hostValue 50",
        "check copy-type b.element 82",
        "check copy-type b.element 82",
        "seed list by 11",
        "seed.element integer|number by 24",
        "a list by 69",
        "a.element integer|number by 69",
        "b list by 82",
        "b.element integer by 130",
        "c list by 92",
        "c.element integer|number by 92",
        "value integer|number by 145",
      ],
    },
  ],
];

interface MergedRecord {
  readonly record: string;
  readonly upToOrder: string;
  readonly compact: readonly string[];
}

test("a stop whose own entries merge into one publishes main's records, its answers' orders aside (TABLE r4.185)", () => {
  const hash = (text: string): string =>
    createHash("sha256").update(text).digest("hex").slice(0, 16);
  for (const [name, source, expected] of MERGED_STOPS) {
    const files = [{ path: "main.tease", source }];
    const request = coreRequest(files);
    assert.ok(request !== null, name);
    const { places } = new CoreProgram(request);
    const bindings = places.filter((place) => place.kind.kind === "binding");
    const ids = bindings.map((place) => place.id);
    const runs = MODES.map((mode) =>
      inMode(
        mode,
        (): { exact: string; identity: string; upToOrder: string; compact: string[] } => {
          const answers = analyseCore(request);
          const route = publishedRoute(files, ["hostValue"]);
          const compact = [
            answers.outcome,
            ...answers.diagnostics.map((d) => `${d.class} ${d.code} ${d.site.start}-${d.site.end}`),
            ...answers.checks.map(
              (check) => `check ${check.kind} ${check.target} ${check.site.start}`,
            ),
            ...bindings.flatMap((place) =>
              ["", "element", ...[...answers.placeProperties(place.id, [])].sort()].flatMap(
                (property) => {
                  const type = answers.place(place.id, property === "" ? [] : [property]).admitted;
                  const label = `${place.kind.kind === "binding" ? place.kind.name : place.id}${property === "" ? "" : `.${property}`}`;
                  return type.by === "decided"
                    ? [
                        `${label} ${[...type.kinds].sort().join("|")} by ${type.decider?.start ?? "-"}`,
                      ]
                    : [];
                },
              ),
            ),
          ];
          return {
            exact: `${publishedAnswers(answers, ids, request).record}\n${route.text}`,
            identity: mergedIdentity(answers, route.text),
            upToOrder: publishedUpToOrder(answers, ids),
            compact,
          };
        },
      ),
    );
    for (const other of runs.slice(1)) {
      assert.equal(other.exact, runs[0]!.exact, `${name}: one record and route in every mode`);
      assert.equal(other.upToOrder, runs[0]!.upToOrder, `${name}: one publication, orders aside`);
    }
    assert.deepEqual(
      {
        record: hash(runs[0]!.identity),
        upToOrder: hash(runs[0]!.upToOrder),
        compact: runs[0]!.compact,
      },
      expected,
      `${name}: main's records`,
    );
  }
});

/**
 * #1466, TABLE r4.251: a read one holder's source answers asks that source by reference at the read's whole path, so
 * the answer is the source's own there (a reference at the path's first step alone answered the object at `g`,
 * `unknown`, for every property), and keeps the mark a tested path's guard leaves on the source's holder (§3.2): the
 * host value stored at `a.g.n`, tested before `b` copies `a`, reads guarded through `b`'s layer, as the source read by
 * itself does. In the four modes.
 */
test("a read its one holder's source answers is that source's answer at its whole path, its marks kept (#1466)", () => {
  const bindings = (source: string, names: readonly string[], path: readonly string[] = []) => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const places = new CoreProgram(request).places;
    const ids = names.map(
      (name) =>
        places.find((place) => place.kind.kind === "binding" && place.kind.name === name)!.id,
    );
    return MODES.map((mode) => {
      const answers = inMode(mode, () => analyseCore(request));
      return ids.map((id) => answers.place(id, path).contract);
    });
  };
  // (three copies of one seed, each storing its own property below one step, joined, read at each)
  const joined = [
    "let seed = {g: {z: 1}}",
    "let c0 = seed",
    "c0.g.p0 = 1",
    "let c1 = seed",
    'c1.g.p1 = "s"',
    "let c2 = seed",
    "c2.g.p2 = [true]",
    "let joined = c0",
    "joined = c1",
    "joined = c2",
    "let one = joined.g.p0",
    "let two = joined.g.p1",
    "let three = joined.g.p2",
    "exit",
  ].join("\n");
  for (const contracts of bindings(joined, ["one", "two", "three"]))
    assert.deepEqual(
      contracts.map(({ kinds }) =>
        kinds.some((item) => ["integer", "string", "list"].includes(item.tag)),
      ),
      [true, true, true],
    );
  for (const contracts of bindings(joined, ["one", "two", "three"]))
    assert.deepEqual(
      contracts.map(({ kinds }) =>
        kinds.map((item) => item.tag).filter((tag) => tag !== "unknown"),
      ),
      [["integer"], ["string"], ["list"]],
    );
  const tested = flagged(
    "let seed = {g: {n: 1.5}}\nlet a = seed\na.g.n = hostValue\nlet b = a\nif a.g.n is integer { b = a }\nlet x: integer = b.g.n\nexit",
  );
  for (const [contract] of bindings(tested, ["b"], ["g", "n"]))
    assert.ok(
      contract!.kinds.some(
        (item) => item.tag === "unknown" && item.ingress !== undefined && item.guarded === true,
      ),
      "the host value read through the copy's layer is guarded",
    );
});

/**
 * #1466, r4.262 (Codex r11's F1, r12's F1 and F2): no path or span id is made while a read's selection runs. A read whose
 * selection passes a listing layer holding nothing at its path (`a`, its own store at `g.r`) to the one holder below it
 * (`seed`) asks that holder's source by reference, as a read finding its holder directly does (`direct`, the control):
 * through each of the four consumers, in the four modes, one forwarded demand and no layer demand, the path arena and the
 * spans' ids unchanged from the consumer's start to the forwarded demand, for each kind of path a read meets: a plain
 * array; a span whose suffixes have no id yet, and a span from a later step whose own id has none; a record whose id is
 * found lazily, a view of one, a join; and a view made again after its first was resolved, which finds the id kept on
 * the steps it views.
 */
test("no path or span id is made while a read's selection runs, its one holder's source asked by reference (#1466)", () => {
  const sources = {
    direct:
      "let seed = {g: {p: 1}}\nlet a = seed\na.g.p = hostValue\nlet b = a\nrepeat b.g.p {}\nexit",
    passed:
      "let seed = {g: {p: 1}}\nseed.g.p = hostValue\nlet a = seed\na.g.r = hostOther\nlet b = a\nrepeat b.g.p {}\nexit",
  };
  const made = (contract: Contract, steps: readonly string[]): number =>
    steps.reduce((at, step) => contract.pathStep(at, step), 0);
  const record = (contract: Contract, steps: readonly string[]): PathSteps =>
    new PathSteps(contract, steps, () => made(contract, steps));
  const rests: Record<string, (contract: Contract) => Rest> = {
    array: () => ["g", "p"],
    span: (contract) => spanRef(contract, made(contract, ["g", "p"])),
    suffix: (contract) => spanRef(contract, made(contract, ["x", "g", "p"]), 1),
    lazy: (contract) => record(contract, ["g", "p"]).rest(),
    viewed: (contract) => {
      const view = record(contract, ["x", "g", "p"]).from(1);
      assert.equal(view.made, undefined, "a view not yet resolved has no id");
      return view.rest();
    },
    joined: (contract) => record(contract, ["g"]).followedBy(["p"]).rest(),
    remade: (contract) => {
      const steps = record(contract, ["x", "g", "p"]);
      const id = steps.from(1).path;
      const view = steps.from(1);
      assert.equal(view.made, id, "a view made again finds the id kept on the steps it views");
      return view.rest();
    },
  };
  const consumers = {
    summaryItems: (contract: Contract, stores: PrefixStores, rest: Rest, solver: Solver) =>
      solver.run(summaryItems(contract, stores, rest)),
    summaryCount: (contract: Contract, stores: PrefixStores, rest: Rest, solver: Solver) =>
      solver.run(summaryCount(contract, stores, rest)),
    summaryPresence: (contract: Contract, stores: PrefixStores, rest: Rest, solver: Solver) =>
      summaryPresence(contract, stores, rest, 0, (work) => solver.run(work)),
    offendingStores: (contract: Contract, stores: PrefixStores, rest: Rest, solver: Solver) =>
      offendingStores(
        contract,
        stores,
        rest,
        (items) => items.some((item) => item.tag === "unknown"),
        (work) => solver.run(work),
      ),
  };
  const arenas = (contract: Contract) => ({
    paths: contract.pathParents.length,
    spans: [...contract.pathFacts.values()].reduce(
      (count, facts) => count + (facts.spans?.size ?? 0),
      0,
    ),
  });
  for (const [name, source] of Object.entries(sources)) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
    assert.ok(request !== null, name);
    for (const mode of MODES)
      inMode(mode, () => {
        for (const [kind, restOf] of Object.entries(rests))
          for (const [consumer, ask] of Object.entries(consumers)) {
            const { contract, program, solver } = narrowingPass(request);
            const b = program.places.find(
              (place) => place.kind.kind === "binding" && place.kind.name === "b",
            )!.id;
            const stores = contract.prefixStores(keyOf(b, []));
            const rest = restOf(contract);
            const before = arenas(contract);
            let forwarded = 0;
            let selected: ReturnType<typeof arenas> | undefined;
            const subAt = contract.subAt.bind(contract);
            contract.subAt = function* (sub, asked) {
              if (asked === rest) {
                forwarded += 1;
                selected ??= arenas(contract);
              }
              return yield* subAt(sub, asked);
            };
            ask(contract, stores, rest, solver);
            assert.deepEqual(
              { forwarded, demands: contract.facts.layerDemands, selected },
              { forwarded: 1, demands: 0, selected: before },
              `${name}, ${kind}, ${consumer}`,
            );
          }
      });
  }
});

/** Items as the property tests compare them, each by the oracles' `itemText`, in order. */
const itemsText = (items: readonly Item[]): string => items.map(itemText).join(" ");

/** The place of the binding `name` of a pass's program. */
const bindingOf = (pass: CorePass, name: string): PlaceId =>
  pass.program.places.find((place) => place.kind.kind === "binding" && place.kind.name === name)!
    .id;

/**
 * A prefix's items at a path from its levels alone, as `contractAlong` read them before #1456: its entries that answer
 * by themselves in their groups (`entryGroups`), then its literals' groups at the path (`groupsAt`).
 */
function* levelsAt(contract: Contract, prefix: Key, rest: Rest): Work<readonly Item[]> {
  const out: Item[] = [];
  const levels = prefixLevels(contract, prefix, contract.prefixStores(prefix));
  for (const group of entryGroups(contract, levels)) {
    const first = yield* contract.entryAt(group.entries[0]!, rest);
    if (
      group.entries.length > 1 &&
      !first.some((item) => item.tag === "unknown" || item.fan !== undefined)
    ) {
      out.push(...withWriter(first, group.w));
      continue;
    }
    out.push(...first);
    for (const entry of group.entries.slice(1)) out.push(...(yield* contract.entryAt(entry, rest)));
  }
  if (levels.base.length > 0)
    for (const group of groupsAt(contract, prefix, levels.base, rest))
      out.push(
        ...annotated(
          contract,
          group,
          rest,
          withWriter(
            yield* contract.contractOfValueAt(
              group.literal,
              isSteps(rest) ? joinSteps(group.at, rest) : rest.after(group.at),
            ),
            group.w,
          ),
        ),
      );
  return out;
}

/**
 * #1456: a property of a place replaced by objects answers as the place's levels do: in every mode, for each family's
 * property read and one no object holds, the place's contract there equals its levels' items at the property, merged,
 * so the property index reading the objects holding it and one `missing` for the others keeps every holder's answer
 * (each store by itself with the sharing off), the missing status, its writer (the earliest literal, or with the
 * sharing on the first stored of objects alike there) and its place among the holders' answers. The objects are
 * indexed where every store is a closed object literal and, with the sharing on, a level's member; a host value among
 * them or a test marking the reads leaves the place to its levels, and so does, with the sharing on, a tested operand
 * marking an object's structure.
 */
test("a property of a place replaced by objects answers as its levels do, in every mode (#1456)", () => {
  const differing: string[] = [];
  const indexed = new Set<string>();
  for (const family of PROPERTY_STORE_FAMILIES) {
    const files = family.program(4);
    const request = coreRequest(files, ["hostValue", "hostOther"]);
    assert.ok(request !== null, family.name);
    const properties = [
      ...new Set([...files[0]!.source.matchAll(/root\.(\w+)/g)].map((read) => read[1]!)),
      "absent",
    ];
    for (const mode of MODES)
      inMode(mode, () => {
        const pass = narrowingPass(request);
        const root = bindingOf(pass, "root");
        const prefix = keyOf(root, []);
        for (const property of properties) {
          const asked = pass.solver.run(pass.contract.contractOf(keyOf(root, [property])));
          const levels = pass.solver.run(levelsAt(pass.contract, prefix, stepsRest([property])));
          if (itemsText(asked) !== itemsText(mergeItems(levels, pass.program.scope)))
            differing.push(`${family.name} ${property} ${JSON.stringify(mode)}`);
        }
        if (pass.contract.propertyIndexes.has(pass.contract.prefixStores(prefix)))
          indexed.add(`${family.name}${mode.unshared ? " unshared" : ""}`);
      });
  }
  assert.deepEqual(differing, []);
  const closed = ["plain", "two", "shared", "half", "typed", "open-value", "provenance", "alike"];
  assert.deepEqual(
    [...indexed].sort(),
    [
      ...[...closed, "before", "reverse"].flatMap((kind) => [
        `property-stores-${kind}`,
        `property-stores-${kind} unshared`,
      ]),
      // (a marked structure only keeps an object from its level's groups: with the sharing off each store answers alone)
      "property-stores-marked unshared",
    ].sort(),
  );
});

/**
 * #1456 (Sol's prototype r1): a property's answer read from the objects holding it is the read's alone, never the
 * place's groups at the property, from which a deeper read folds every object's, so the deeper read keeps the `missing`
 * of the object without the property, with that object's literal as its writer, whether the property is read first,
 * after it or only by the deeper read's own question of its owner; in every mode.
 */
test("a deeper read below a place replaced by objects keeps each object's absence, whichever read comes first (#1456)", () => {
  const source = "let root = {f0: {n: 1}}\nsay root.f0\nroot = {f1: 2}\nrepeat root.f0.n {}\nexit";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const lacking = source.indexOf("{f1: 2}");
  const expected = { f0: ["object", "unknown"], "f0.n": ["integer", "unknown"] };
  for (const mode of MODES)
    for (const order of [["f0", "f0.n"], ["f0.n", "f0"], ["f0.n"]] as const)
      inMode(mode, () => {
        const pass = narrowingPass(request);
        const root = bindingOf(pass, "root");
        for (const at of order) {
          const items = pass.solver.run(pass.contract.contractOf(keyOf(root, at.split("."))));
          const where = `${at} after ${order.join(", ")} ${JSON.stringify(mode)}`;
          assert.deepEqual(
            items.map((item) => item.tag),
            expected[at],
            where,
          );
          const missing = items.find((item) => item.tag === "unknown")!;
          assert.deepEqual(
            [missing.reasons, missing.writer?.start],
            [REASON.missing, lacking],
            where,
          );
        }
      });
});

/**
 * #1456: the property index is the pass's, made again from the prefix's stores in each pass: a component reaching it
 * through a wrapper, replayed in a fresh pass through its names' packet from its first and its last member (each
 * making the paths in its own order), answers as it did; and a pass that made other paths first and asks the
 * properties in reverse answers each as the first pass did.
 */
test("a replayed component below a place replaced by objects answers alike, its paths made in another order (#1456)", () => {
  const plain = PROPERTY_STORE_FAMILIES.find((family) => family.name === "property-stores-plain")!;
  const source = plain
    .program(8)[0]!
    .source.replace(
      "exit",
      "let wrapper = {box: root}\nrepeat wrapper.box.f0 {}\nrepeat wrapper.box.f7 {}\nexit",
    );
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"]);
  assert.ok(request !== null);
  const reads = ["f0", "f7", "absent"];
  for (const mode of MODES)
    inMode(mode, () => {
      const pass = narrowingPass(request);
      const wrapper = bindingOf(pass, "wrapper");
      const first = reads.map((property) =>
        itemsText(pass.solver.run(pass.contract.contractOf(keyOf(wrapper, ["box", property])))),
      );
      const members = pass.solver
        .demandWork()
        .filter((demand) => /^(c|cop|rc|s)\|/.test(demand.key))
        .flatMap((demand) => {
          const items = pass.solver.answer(demand.key);
          return items === undefined ? [] : [{ key: demand.key, items }];
        });
      const exported = exportNames(
        pass.contract,
        members.map((member) => member.key),
      );
      const names = exported?.names ?? members.map((member) => member.key);
      for (const entry of [names[0]!, names.at(-1)!])
        assert.deepEqual(
          solveDemands(request, [entry, ...names], exported?.packet)
            .slice(1)
            .map(itemsText),
          members.map((member) => itemsText(member.items)),
          `${entry} ${JSON.stringify(mode)}`,
        );
      const other = narrowingPass(request);
      for (const name of ["unusedC", "unusedB", "unusedA"]) other.contract.pathIdOf([name]);
      const again = [...reads]
        .reverse()
        .map((property) =>
          itemsText(
            other.solver.run(
              other.contract.contractOf(keyOf(bindingOf(other, "wrapper"), ["box", property])),
            ),
          ),
        )
        .reverse();
      assert.deepEqual(again, first, JSON.stringify(mode));
    });
});
