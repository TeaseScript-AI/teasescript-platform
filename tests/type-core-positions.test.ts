import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { ingressLeaves, type Item, writerKey } from "../src/type-inference/core/items.js";
import { withTextKeys } from "../src/type-inference/core/cursors.js";
import { withoutPositions } from "../src/type-inference/core/positions.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { publishedAnswers, publishedRoute } from "./helpers/type-core-standing.js";

/*
 * G3 3a (TABLE r4.164, r4.178, r4.187): a read through wrappers (`a2 = {q: a1}`, `a2.q.q`) stands one step below its
 * parent's position (`positions.ts`), never at its root and its whole path, and that is output-neutral: every program
 * of the family below publishes the same (the answers, every binding's admitted types with their deciders, the plan or
 * the rejection, and the observed answer at every flow node with its element and properties) with positions and
 * `withoutPositions`, in both orders, with the sharing on and off. The family varies what keeps a binding from being a
 * wrapper (`Contract.wrapperHop`, `admission/inherited.ts`'s `scanHop`, `landings.ts`'s `landingHop`) at a middle one:
 * a store below it before or after the read, a sibling store, a rejected store before a valid one, a test of it, a
 * store from another callable or a handler, a copy of it, a sibling property, reads at every depth, a literal leaf. Each
 * program publishes the same, too, with its keys and paths kept as their texts (`withTextKeys`, `cursors.ts`).
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

function itemText(item: Item): string {
  return [
    item.tag,
    item.cert,
    item.reasons,
    item.writer === null ? "" : writerKey(item.writer),
    item.context ?? "",
    item.word ?? "",
    item.guarded === true ? "g" : "",
    item.called === true ? "c" : "",
    item.ingress === undefined ? "" : ingressLeaves(item.ingress).map(writerKey).join("+"),
  ].join("|");
}

/** The observed answer at every flow node, with its element and properties where it holds a collection or an object. */
function observed(analysis: ReturnType<typeof analyseCore>): string {
  const out: string[] = [];
  for (const node of analysis.graph.nodes) {
    const at = analysis.at(node);
    if (at === null) continue;
    const tags = new Set(at.items.map((item) => item.tag));
    out.push(
      JSON.stringify([
        node.id,
        at.route,
        at.place,
        at.items.map(itemText),
        tags.has("list") ? analysis.project(node, "element").map(itemText) : null,
        tags.has("object")
          ? [...analysis.properties(node)].map(([name, items]) => [name, items.map(itemText)])
          : null,
      ]),
    );
  }
  return out.join("\n");
}

/** What one source publishes in one order: answers, admitted types, the plan or rejection, the observed answers. */
function published(source: string, reversed: boolean): string {
  const files = [{ path: "main.tease", source }];
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null, "the source parses and resolves");
  const bindings = new CoreProgram(request).places
    .filter(({ kind }) => kind.kind === "binding")
    .map((place) => place.id);
  const inOrder = <T>(callback: () => T): T =>
    reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, callback),
        )
      : callback();
  const analysis = inOrder(() => analyseCore(request));
  const answers = publishedAnswers(analysis, bindings, ["main.tease"]);
  const route = inOrder(() => publishedRoute(files, GLOBALS));
  return [answers.text, route.text, observed(analysis)].join("\n");
}

test("a read through wrappers publishes the same from its position as from its root, and with its keys as cursors as with their texts, for every variant, in both orders, with the sharing on and off (G3 3a, path cursors)", () => {
  const differing: string[] = [];
  let runs = 0;
  for (const depth of [2, 4])
    for (const leaf of ["typed", "7"])
      for (const variant of VARIANTS) {
        const source = wrapped(depth, variant, leaf);
        for (const reversed of [false, true])
          for (const shared of [true, false]) {
            const run = (): string => published(source, reversed);
            const on = shared ? run() : withoutSharing(run);
            const off = withoutPositions(() => (shared ? run() : withoutSharing(run)));
            const texts = withTextKeys(() => (shared ? run() : withoutSharing(run)));
            runs += 1;
            const name = `${variant} depth ${depth} leaf ${leaf}${reversed ? " reversed" : ""}${shared ? "" : " unshared"}`;
            if (on !== off) differing.push(name);
            if (on !== texts) differing.push(`${name} (text keys)`);
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
    // (a root and residual walk per read was cubic: 1,275 → 4,059 frames and 39,530 → 184,741 units at these sizes; the
    // keys' texts, quadratic)
    assert.ok(
      (2 * large.frames) / small.frames / scale < 2.2,
      `frames ${small.frames} → ${large.frames}${reversed ? " (reversed)" : ""}`,
    );
    assert.ok(
      (2 * large.total) / small.total / scale < 2.2,
      `total ${small.total} → ${large.total}${reversed ? " (reversed)" : ""}`,
    );
  }
});
