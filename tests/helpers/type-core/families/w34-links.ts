// pins for tests/type-core/type-core-work-b.test.ts: main's 64 → 128 growth step of W34's two known products, as gates | line /^\s*measured: \d/u
import { type WorkFamily, rows, lines, fields, main, type KnownProduct } from "./builders.js";

/** A W34 chain: a k-field record replaced by one of nulls under the flag, k whole copies, the last read at k fields. */
function w34Chain(
  k: number,
  record: (value: string) => string,
  field: (index: number) => string,
  link: (index: number) => string,
): string {
  const values = (value: string): string => record(`{${fields(k, () => value)}}`);
  return lines(
    `let box0 = ${values("1")}`,
    `if flagHost { box0 = ${values("null")} }`,
    rows(k, link),
    rows(k, (i) => `repeat box${k}.${field(i)} {}`),
  );
}

/** A W34 fan: k copies of one tested record, each read at the field its own test tests. */
function w34Fan(k: number, copy: (index: number) => string): string {
  return lines(
    `let root = {${fields(k, () => "1")}}`,
    `if flagHost { root = {${fields(k, () => "null")}} }`,
    rows(k, copy),
  );
}

/** A W34 source redefined k times from one record, each definition followed by its own statements. */
function w34Redefined(k: number, each: (index: number) => string, after: string): string {
  return lines(
    `let base = {${fields(k + 1, () => "1")}}`,
    `if flagHost { base = {${fields(k + 1, () => "null")}} }`,
    "let seed = base",
    rows(k, (i) => `seed = base\n${each(i)}`),
    after,
  );
}

const plainRecord = (literal: string): string => literal;
const plainField = (index: number): string => `f${index}`;

/** The chain variants of W34: the statements of each link before the next copy, or around it. */
const W34_LINKS: readonly (readonly [string, (index: number) => string])[] = [
  ["plain", (i: number) => `let box${i + 1} = box${i}`],
  ["tested", (i: number) => `if box${i}.f0 != null {}\nlet box${i + 1} = box${i}`],
  ["different", (i: number) => `if box${i}.f${i} != null {}\nlet box${i + 1} = box${i}`],
  [
    "guarded",
    (i: number) => `if box${i}.f0 != null { repeat box${i}.f0 {} }\nlet box${i + 1} = box${i}`,
  ],
  [
    "copies-of-copies",
    (i: number) => `if box${i}.f0 != null {}\nlet alias${i} = box${i}\nlet box${i + 1} = alias${i}`,
  ],
  [
    "copy-test",
    (i: number) =>
      `let box${i + 1} = box${i}\nif box${i + 1}.f${i} != null { repeat box${i + 1}.f${i} {} }`,
  ],
  [
    "stores",
    (i: number) =>
      `if box${i}.f${i} != null {}\nif flagHost { box${i}.f${i} = 2 }\nlet box${i + 1} = box${i}`,
  ],
  [
    "interleaved-stores",
    (i: number) => `if flagHost { box${i}.f${i} = 2 }\nlet box${i + 1} = box${i}`,
  ],
  ["exit-tested", (i: number) => `if box${i}.f0 == null { exit }\nlet box${i + 1} = box${i}`],
  [
    "exit-tested-own-fields",
    (i: number) => `if box${i}.f${i} == null { exit }\nlet box${i + 1} = box${i}`,
  ],
  [
    "guarded-siblings",
    (i: number) =>
      `if box${i}.f0 != null {\nlet side${i} = box${i}\nrepeat side${i}.f0 {}\n}\nlet box${i + 1} = box${i}\nrepeat box${i + 1}.f0 {}`,
  ],
];

/**
 * A record passed down k single-site functions, each passing its parameter on as `step` writes the call; the last reads
 * every field (review r5: k bindings and k fields, resolved per binding and per field, never per pair).
 */
const argumentChain = (k: number, step: (index: number) => string): string =>
  lines(
    `let seed = {guard: 1, ${fields(k, () => "1")}}`,
    `if flagHost { seed = {guard: 1, ${fields(k, () => "null")}} }`,
    rows(k, (j) =>
      j === k - 1
        ? `function use${j}(p${j}) {\n${rows(k, (i) => `repeat p${j}.f${i} {}`)}\nreturn true\n}`
        : `function use${j}(p${j}) {\n${step(j)}\nreturn true\n}`,
    ),
    "use0(seed)",
  );

/**
 * W34 as the reference model's round-10 generators write it (`fresh.py`, `fan-probe.py`,
 * `siblings.py`): a chain of k whole copies of a k-field record read at k fields of the last copy, plain, with a test
 * on the source before each copy (of one field, of the copy's own field, guarding a read), through an alias, nested a
 * level, tested after each copy, with a conditional store below each source (tested and not); and k sibling copies of
 * one record under tests of their own fields (one test, two nested, an unrelated test before the copy, one `and` chain
 * over all k fields). Review round 2's shapes beside them: chains after early exits on one field (read at the others,
 * and every copy read at it) and on each copy's own field, guarded sibling copies along a chain, k unrelated edited
 * records with one field name, k edited siblings of one copy, k copies of one record edited at k fields; round 3's:
 * one source defined k times, each definition copied after an early exit (on one field, on its own field) or with k
 * stores below the source, and k sources of two copied definitions each; round 4's: a source redefined from its own
 * copies under one test, k sources of five copied definitions each, a source tested at k paths and redefined k times
 * beside four more sources tested there. Every copy is resolved once and read once per field: k + k, never k × k.
 */
export const W34_VARIANTS: readonly WorkFamily[] = W34_LINKS.map(([variant, link]): WorkFamily => ({
  name: `W34-${variant}`,
  measures: "W34: a copy chain resolved once per copy, projected per field",
  program: (k) => main(w34Chain(k, plainRecord, plainField, link)),
})).concat([
  {
    name: "W34-nested",
    measures: "W34: a copy chain resolved once per copy, projected per field",
    program: (k) =>
      main(
        w34Chain(
          k,
          (literal) => `{inner: ${literal}}`,
          (i) => `inner.f${i}`,
          (i) => `if box${i}.inner.f0 != null {}\nlet box${i + 1} = box${i}`,
        ),
      ),
  },
  {
    name: "W34-exit-tested-every-copy",
    measures: "W34 r4.38: a chain's marks found per path, each copy read once",
    program: (k) =>
      main(
        lines(
          `let box0 = {${fields(k, () => "1")}}`,
          `if flagHost { box0 = {${fields(k, () => "null")}} }`,
          rows(k, (i) => `if box${i}.f0 == null { exit }\nlet box${i + 1} = box${i}`),
          rows(k, (i) => `repeat box${i + 1}.f0 {}`),
        ),
      ),
  },
  {
    name: "W34-independent-stores",
    measures: "W34 r4.38: a store's stop found per path within its own copies",
    program: (k) =>
      main(
        rows(
          k,
          (i) => `let r${i} = {f0: 1.5}\nr${i}.f0 = 1\nlet a${i} = r${i}\nrepeat a${i}.f0 {}`,
        ),
      ),
  },
  {
    name: "W34-sibling-stores",
    measures: "W34 r4.38: a store's stop found per path within its own copies",
    program: (k) =>
      main(
        lines(
          "let seed = {f0: 1, f1: 1}",
          "if flagHost { seed = {f0: null, f1: null} }",
          "let base = seed",
          rows(
            k,
            (i) =>
              `let a${i} = base\nif flagHost { a${i}.f0 = 2 }\nlet b${i} = a${i}\nrepeat b${i}.f0 {}\nrepeat b${i}.f1 {}`,
          ),
        ),
      ),
  },
  {
    name: "W34-fan-stores",
    measures: "W34 r4.38: a store's stop found per path within its own copies",
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          `if flagHost { root = {${fields(k, () => "null")}} }`,
          rows(k, (i) => `if flagHost { root.f${i} = 2 }`),
          rows(k, (i) => `let copy${i} = root\nrepeat copy${i}.f${i} {}`),
        ),
      ),
  },
  {
    name: "W34-redefined-exit-tested",
    measures: "W34 r4.38: k definitions of one source, each copied after a test",
    program: (k) =>
      main(
        w34Redefined(
          k,
          (i) => `if seed.f0 == null { exit }\nlet a${i} = seed\nrepeat a${i}.f0 {}`,
          "",
        ),
      ),
  },
  {
    name: "W34-redefined-exit-tested-own-fields",
    measures: "W34 r4.38: k definitions of one source, each copied after a test of its own field",
    program: (k) =>
      main(
        w34Redefined(
          k,
          (i) => `if seed.f${i} == null { exit }\nlet a${i} = seed\nrepeat a${i}.f${i} {}`,
          "",
        ),
      ),
  },
  {
    name: "W34-redefined-stores",
    measures: "W34 r4.38: k definitions of one source, each copied, and k stores below it",
    program: (k) =>
      main(
        w34Redefined(
          k,
          (i) => `let a${i} = seed\nrepeat a${i}.f0 {}`,
          rows(k, (i) => `seed.f${i + 1} = 1`),
        ),
      ),
  },
  {
    name: "W34-redefined-independent",
    measures: "W34 r4.38: k sources of two copied definitions each, a store at one shared path",
    program: (k) =>
      main(
        rows(
          k,
          (i) =>
            `let r${i} = {f0: 1.5}\nlet b${i} = r${i}\nr${i} = {f0: 2.5}\nr${i}.f0 = 1\nlet a${i} = r${i}\nrepeat a${i}.f0 {}\nrepeat b${i}.f0 {}`,
        ),
      ),
  },
  {
    name: "W34-redefined-through-copies",
    measures: "W34 r4.38: a source redefined from its own copies k times, one test of it",
    program: (k) =>
      main(
        lines(
          `let base = {${fields(k, () => "1")}}`,
          `if flagHost { base = {${fields(k, () => "null")}} }`,
          "let seed = base",
          'if seed != null { say "tested" }',
          rows(k, (i) => `let a${i} = seed\nseed = a${i}`),
          rows(k, (i) => `repeat seed.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-redefined-five-times-independent",
    measures: "W34 r4.38: k sources of five copied definitions each, a store at one shared path",
    program: (k) =>
      main(
        lines(
          rows(
            k,
            (i) =>
              `let seed${i} = {f0: 1.5}\nlet a${i}_0 = seed${i}\n${rows(4, (j) => `seed${i} = {f0: 2.5}\nlet a${i}_${j + 1} = seed${i}`)}\nseed${i}.f0 = 1`,
          ),
          rows(k, (i) => `repeat a${i}_0.f0 {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-redefined-beside-tested-sources",
    measures:
      "W34 r4.38: a source tested at k paths and redefined k times beside four sources tested there",
    program: (k) =>
      main(
        lines(
          `let base = {${fields(k, () => "1")}}`,
          `if flagHost { base = {${fields(k, () => "null")}} }`,
          rows(
            4,
            (j) =>
              `let side${j} = base\n${rows(k, (i) => `if side${j}.f${i} == null { say "side" }`)}`,
          ),
          "let seed = base",
          rows(k, (i) => `if seed.f${i} == null { exit }`),
          rows(k, (i) => `seed = base\nlet a${i} = seed`),
          rows(k, (i) => `repeat a${i}.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-fan-marked",
    measures: "W34 r4.38: a copy's marks asked per path and guard scope",
    program: (k) =>
      main(
        w34Fan(
          k,
          (i) =>
            `if root.f${i} != null {\nif root.f${i} > 0 {\nlet copy${i} = root\nrepeat copy${i}.f${i} {}\n}\n}`,
        ),
      ),
  },
  {
    name: "W34-fan-unmarked",
    measures: "W34 r4.38: a copy's marks asked per path and guard scope",
    program: (k) =>
      main(
        w34Fan(
          k,
          (i) =>
            `if root.f${i} != null {\nif root.f${i} > 0 {}\nlet copy${i} = root\nrepeat copy${i}.f${i} {}\n}`,
        ),
      ),
  },
  {
    name: "W34-fan-narrowing",
    measures: "W34 r4.38: a copy's marks asked per path and guard scope",
    program: (k) =>
      main(
        w34Fan(
          k,
          (i) => `if root.f${i} != null {\nlet copy${i} = root\nrepeat copy${i}.f${i} {}\n}`,
        ),
      ),
  },
  {
    name: "W34-fan-and-chain",
    measures: "W34 r4.38: k copies in one guard scope share its marks",
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          `if flagHost { root = {${fields(k, () => "null")}} }`,
          `if ${Array.from({ length: k }, (_, i) => `root.f${i} != null`).join(" and ")} {`,
          rows(k, (i) => `let copy${i} = root\nrepeat copy${i}.f${i} {}`),
          "}",
        ),
      ),
  },
  {
    name: "W34-argument-chain",
    measures: "W34 (review r5): a record passed down k calls and read at k fields",
    program: (k) => main(argumentChain(k, (j) => `use${j + 1}(p${j})`)),
  },
  {
    name: "W34-argument-operands",
    measures:
      "W34 r4.38 (review r5): the same, each call in an operand a test of an unread field guards",
    program: (k) =>
      main(argumentChain(k, (j) => `if p${j}.guard != null and use${j + 1}(p${j}) {}`)),
  },
  {
    name: "W34-argument-own-tests",
    measures:
      "W34 r4.38: the same, each call in an operand a test of the field it passes on guards",
    program: (k) =>
      main(argumentChain(k, (j) => `if p${j}.f${j} != null and use${j + 1}(p${j}) {}`)),
  },
  {
    name: "W34-captured-own-tests",
    measures:
      "W34 (review r6): a record captured into one global down k calls, each testing its own field, read at k fields",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          `if flagHost { seed = {${fields(k, () => "null")}} }`,
          rows(k, (j) =>
            lines(
              `function use${j}(p${j}) {`,
              `seed = p${j}`,
              j === k - 1
                ? rows(k, (i) => `repeat seed.f${i} {}`)
                : `if seed.f${j} != null { use${j + 1}(seed) }`,
              "return true",
              "}",
            ),
          ),
          "use0(seed)",
        ),
      ),
  },
  {
    name: "W34-fanout-tested-callables",
    measures: "W34 (review r7): one source passed to k functions that each test it and copy it",
    program: (k) =>
      main(
        lines(
          'let seed = {f: fromJson("2", default: null, files: false)}',
          rows(k, (i) =>
            lines(
              `function use${i}(p) {`,
              "seed = p",
              "if seed.f is integer {",
              "let snap = seed",
              "repeat snap.f {}",
              "}",
              "}",
            ),
          ),
          rows(k, (i) => `use${i}(seed)`),
        ),
      ),
  },
  {
    name: "W34-fanout-tested-exits",
    measures:
      "W34 (review r7): k fields each tested in five functions that each pass the source on k times, read once",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          `if flagHost { seed = {${fields(k, () => "null")}} }`,
          rows(5, (c) =>
            lines(
              rows(k, (j) =>
                lines(
                  `function u${c}_${j}(r) {`,
                  "seed = r",
                  "let snap = seed",
                  c === 0 && j === 0 ? rows(k, (i) => `repeat snap.f${i} {}`) : 'say "u"',
                  "return true",
                  "}",
                ),
              ),
              `function t${c}(p) {`,
              "seed = p",
              rows(k, (i) => `if seed.f${i} != null { say "t" }`),
              rows(k, (j) => `u${c}_${j}(seed)`),
              "return true",
              "}",
            ),
          ),
          rows(5, (c) => `t${c}(seed)`),
        ),
      ),
  },
  {
    name: "W34-fanout-distinct-exits",
    measures:
      "W34 (review r8): k fields tested by one condition in five functions, each passing k redefinitions on",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => 'fromJson("1", default: null, files: false)')}}`,
          rows(5, (c) =>
            lines(
              rows(k, (j) =>
                lines(
                  `function u${c}_${j}(r) {`,
                  "seed = r",
                  "let snap = seed",
                  c === 0 && j === 0 ? rows(k, (i) => `repeat snap.f${i} {}`) : 'say "u"',
                  "return true",
                  "}",
                ),
              ),
              `function t${c}(p) {`,
              "seed = p",
              `if ${Array.from({ length: k }, (_, i) => `seed.f${i} != null`).join(" and ")} {`,
              rows(k, (j) => `seed = p\nu${c}_${j}(seed)`),
              "}",
              "return true",
              "}",
            ),
          ),
          rows(5, (c) => `t${c}(seed)`),
        ),
      ),
  },
]);

/**
 * W34's two remaining combinations, gated known limits by the owner's decision
 * (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-45): more than four sources
 * tested at one path, each with more than four anchors in one tree, read there many times; and sources copied from more
 * than four shared roots, stored at one path every copy reads (review r5's generators). The gate is a regression check
 * on the 64 → 128 growth step only (3.37 and 2.53), not a bound at larger sizes: 128 → 256 already grows 3.62 and 2.82.
 * They are reconsidered when a realistic script shows both dimensions; a change to that lookup re-measures them and
 * proposes the gate with its counts, never retunes it; the linear alternative is a separate PR after S4.
 */
export const W34_KNOWN_PRODUCTS: readonly KnownProduct[] = [
  {
    name: "W34-known-tested-anchors",
    measures:
      "W34: k sources each tested and redefined through five copies in one tree, read at k fields",
    // 114,507 / 347,723 / 1,170,507 / 4,241,483 units at k = 32 … 256 (review r5: 110,646 / 335,894 / 1,130,454)
    measured: 3.37,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "hostValue")}}`,
          rows(k, (i) =>
            lines(
              `let seed${i} = ${i === 0 ? "root" : `seed${i - 1}`}`,
              `if seed${i} != null { say "tested" }`,
              rows(5, (j) => `let a${i}_${j} = seed${i}\nseed${i} = a${i}_${j}`),
            ),
          ),
          rows(k, (j) => `repeat seed${k - 1}.f${j} {}`),
        ),
      ),
  },
  {
    name: "W34-known-stored-roots",
    measures:
      "W34: k sources copied from five shared roots, each stored at the path every copy reads",
    // 49,782 / 113,942 / 285,910 / 803,158 units at k = 32 … 256 (review r5: 113,562 / 285,146 / 801,626 from 64)
    measured: 2.53,
    program: (k) =>
      main(
        lines(
          rows(5, (j) => `let root${j} = {f0: hostValue}`),
          rows(k, (i) =>
            lines(
              `let seed${i} = root0`,
              rows(5, (j) => `${j === 0 ? "" : `seed${i} = root${j}\n`}let a${i}_${j} = seed${i}`),
              `seed${i}.f0 = 1`,
            ),
          ),
          rows(k, (i) => `repeat a${i}_0.f0 {}`),
        ),
      ),
  },
];
