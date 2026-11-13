import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withoutPositions } from "../../../src/type-inference/core/positions.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import {
  COPY_CHAIN_DEPTH,
  COPY_CHAIN_SOURCES,
} from "../../helpers/type-core/families/copy-chains.js";
import { inMode, MODES, orderedItems, publication } from "../../helpers/type-core-oracles.js";

/*
 * G3 3a: a read through wrappers (`a2 = {q: a1}`, `a2.q.q`) stands one step below its
 * parent's position (`positions.ts`), never at its root and its whole path, and that is output-neutral: every program
 * of the family below publishes the same (the answers, every binding's admitted types with their deciders, the plan or
 * the rejection, and the observed answer at every flow node with its element and properties) with positions and
 * `withoutPositions`, in both orders, with the sharing on and off. The family varies what keeps a binding from being a
 * wrapper (`Contract.wrapperHop`, `inherited/inherited.ts`'s `scanHop`, `landings/landed.ts`'s `landingHop`) at a middle one:
 * a store below it before or after the read, a sibling store, a rejected store before a valid one, a test of it, a
 * store from another callable or a handler, a copy of it, a sibling property, reads at every depth, a literal leaf.
 */

const GLOBALS = ["hostValue", "hostOther", "hostInit"];

/** A chain of `depth` wrappers over `root`, with `variant` at the middle one, and the deepest read. */
function wrapped(depth: number, variant: string, leaf: string): string {
  const middle = Math.floor(depth / 2);
  const below = middle === 0 ? "root" : `a${middle - 1}`;
  const path = (k: number): string => Array.from({ length: k }, () => "q").join(".");
  const lines = [`let typed: integer = 1`, `let root = {f: ${leaf}, q: null}`];
  for (let i = 0; i < depth; i += 1) {
    const inner = i === 0 ? "root" : `a${i - 1}`;
    lines.push(
      i === middle && variant === "sibling-property"
        ? `let a${i} = {q: ${inner}, r: 1}`
        : `let a${i} = {q: ${inner}}`,
    );
  }
  const top = `a${depth - 1}`;
  const read = `let out = ${top}.${path(depth)}.f`;
  const before: Record<string, readonly string[]> = {
    "store-before": [`a${middle}.q = ${below}`],
    "sibling-store": [`a${middle}.r = 2`],
    rejected: [`a${middle}.q = 5`, `a${middle}.q = ${below}`],
    guarded: [`if a${middle}.q is object {`, `  say "here"`, `}`],
    foreign: [`function poke {`, `  a${middle}.q = ${below}`, `  return 0`, `}`, `let z = poke()`],
    handler: [
      `function register {`,
      `  showPermanentButton "Change" { a${middle}.q = ${below} }`,
      `  return 0`,
      `}`,
      `let z = register()`,
    ],
    copy: [`let c = a${middle}`, `let viaCopy = c.${path(middle + 1)}.f`],
    "every-depth": Array.from(
      { length: depth },
      (_, k) => `let r${k} = ${top}${k === 0 ? "" : `.${path(k)}`}`,
    ),
  };
  const after: Record<string, readonly string[]> = { "store-after": [`a${middle}.q = ${below}`] };
  return [...lines, ...(before[variant] ?? []), read, ...(after[variant] ?? []), "exit", ""].join(
    "\n",
  );
}

const VARIANTS = [
  "plain",
  "store-before",
  "store-after",
  "sibling-store",
  "sibling-property",
  "rejected",
  "guarded",
  "foreign",
  "handler",
  "copy",
  "every-depth",
];

test("a read through wrappers publishes the same from its position as from its root, for every variant, in both orders, with the sharing on and off (G3 3a)", () => {
  const differing: string[] = [];
  let runs = 0;
  for (const depth of [2, 4])
    for (const leaf of ["typed", "7"])
      for (const variant of VARIANTS) {
        const source = wrapped(depth, variant, leaf);
        for (const reversed of [false, true])
          for (const shared of [true, false]) {
            const files = [{ path: "main.tease", source }];
            const mode = { reversed, unshared: !shared };
            const on = publication(files, mode, GLOBALS);
            assert.ok(on !== null, "the source parses and resolves");
            const off = withoutPositions(() => publication(files, mode, GLOBALS));
            runs += 1;
            if (on !== off)
              differing.push(
                `${variant} depth ${depth} leaf ${leaf}${reversed ? " reversed" : ""}${shared ? "" : " unshared"}`,
              );
          }
      }
  assert.equal(runs, 2 * 2 * VARIANTS.length * 4);
  assert.deepEqual(differing, []);
});

test("a read through wrappers makes its states one step at a time: the wrapper chain's demands and work grow with the source in both orders (G3 3a, 3b)", () => {
  const source = (n: number): string => wrapped(n, "plain", "typed");
  for (const reversed of [false, true]) {
    const counts = [16, 32].map((n) => {
      const request = coreRequest([{ path: "main.tease", source: source(n) }], GLOBALS)!;
      const go = (): ReturnType<typeof analyseCore> => analyseCore(request);
      const analysis = reversed
        ? withConsumerOrder(
            (list) => [...list].reverse(),
            () => withSolverSeam({ reverseWorklist: true }, go),
          )
        : go();
      assert.equal(analysis.outcome, "valid");
      return {
        frames: analysis.budget.counts.get("frames") ?? 0,
        nodes: analysis.budget.counts.get("syntaxNodes") ?? 0,
        total: analysis.budget.total,
      };
    });
    const small = counts[0]!;
    const large = counts[1]!;
    const scale = large.nodes / small.nodes;
    // (a root and residual walk per read was cubic: 1,275 → 4,059 frames and 39,530 → 184,741 units at these sizes)
    assert.ok(
      (2 * large.frames) / small.frames / scale < 2.2,
      `frames ${small.frames} → ${large.frames}${reversed ? " (reversed)" : ""}`,
    );
    assert.ok(
      (2 * large.total) / small.total / scale < 2.3,
      `total ${small.total} → ${large.total}${reversed ? " (reversed)" : ""}`,
    );
  }
});

/**
 * #1605: a key's element levels through wrappers stand one step below their parent's positions (`positionStep`), never
 * at each wrapper's root and whole path again, and that is output-neutral: each program of the family publishes the
 * same with positions and `withoutPositions` (the derivation every element level took before), in the four modes; and
 * the contract (kinds, elements, emptiness, each item with its writer, marks and ingress) of every binding of the chain
 * at its key `…q.f`, that key's element, its element's element, a property `r` of its element and that property's
 * element (a property step after an element step), asked shallow-first and base-first or deepest-first, equals the one
 * `withoutPositions` gives. The family samples each axis against the issue's shape (a store of external data at `b`'s
 * long key): the leaf, the use and what breaks the chain (`COPY_CHAIN_SOURCES`).
 */
test("a key's element levels through wrappers answer the same from their positions as from their roots, in every mode and either question order (#1605)", () => {
  const depth = COPY_CHAIN_DEPTH;
  const sources = COPY_CHAIN_SOURCES.map(({ source }) => source);
  const globals = [...GLOBALS];
  const differing: string[] = [];
  for (const source of sources) {
    const files = [{ path: "main.tease", source }];
    const request = coreRequest(files, globals);
    assert.ok(request !== null, `the source parses and resolves:\n${source}`);
    const bindings = new CoreProgram(request).places.filter(
      (place) => place.kind.kind === "binding",
    );
    const idOf = (name: string): number => bindings.find((place) => place.label === name)!.id;
    // (every binding of the chain at its key `…q.f`, the frontier's own first: its depth below the binding)
    const chain = [
      ["a", 0],
      ...Array.from({ length: depth }, (_, i) => [`w${i}`, i + 1] as const),
      ["b", depth],
    ] as const;
    const questions = chain.flatMap(([name, below]) =>
      [[], ["element"], ["element", "element"], ["element", "r"], ["element", "r", "element"]].map(
        (tail) => ({
          name: `${name}.${[...Array.from({ length: below }, () => "q"), "f", ...tail].join(".")}`,
          id: idOf(name),
          path: [...Array.from({ length: below }, () => "q"), "f", ...tail],
        }),
      ),
    );
    // shallow-first and base-first, or deepest-first: each a fresh analysis
    const orders = [questions, [...questions].reverse()];
    const levels = (order: typeof questions): Map<string, string> => {
      const answers = analyseCore(request);
      const out = new Map<string, string>();
      for (const question of order) {
        const { contract } = answers.place(question.id, question.path);
        out.set(
          question.name,
          JSON.stringify([
            orderedItems(contract.kinds),
            orderedItems(contract.elements),
            contract.emptiness,
          ]),
        );
      }
      return out;
    };
    for (const mode of MODES) {
      const where = `${mode.reversed ? "reversed" : "forward"}${mode.unshared ? ", unshared" : ""}`;
      const on = publication(files, mode, globals);
      const off = withoutPositions(() => publication(files, mode, globals));
      if (on !== off) differing.push(`${where}: the publication\n${source}`);
      const before = withoutPositions(() => inMode(mode, () => levels(questions)));
      for (const [index, order] of orders.entries()) {
        const now = inMode(mode, () => levels(order));
        for (const question of questions)
          if (now.get(question.name) !== before.get(question.name))
            differing.push(`${where}, order ${index}: ${question.name}\n${source}`);
      }
    }
  }
  assert.equal(sources.length, 32);
  assert.deepEqual(differing, []);
});
