import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import type { MixedDimensions } from "./helpers/type-core-mixed-family.js";
import {
  mixedCompared,
  mixedDimensions,
  mixedExplained,
  mixedSentences,
} from "./helpers/type-core-mixed-family.js";
import { inMode, MODES } from "./helpers/type-core-oracles.js";

/**
 * #1765's invariant (the lead's family rule on #1789, after Codex r9–r11 and Astra r2), sampled as the owner's
 * test-cost rule asks. The full product is `tests/families/messages/1765-mixed-family.mjs` (run on the queue):
 * - a whole-number side two or three lists deep against its text twin;
 * - its `null` at no layer, at a layer or at the leaf;
 * - at the element or a layer its value carried, or a copy (narrowed, maybe null, held, typed host values tested or
 *   not, an `otherwise` of a copy);
 * - the pair as elements, properties or `+` operands, joined again with a second disagreeing side, or the whole-number
 *   side a `+` of two whose nulls are at different layers;
 * - both orders.
 * Here, each kind at every position with every relation of its carried layer to the null (`RELATIONS`: the null one
 * and two layers below it, inside and at the leaf, three below at the leaf, at its layer, none), the order turned
 * through them, and the two joined positions (`ONE`: the twin's join in both orders of its answers) in both orders;
 * then each case that brings a class the sample lacks (`classes`, the coverage invariant); in four modes. The modes agree. Where both checkers report the error, the first sentences are equal, except
 * the inherited classes, each its issue's work:
 * - the later element's leaf `null`, #1790 (#1819, stacked on this);
 * - an element's own `or null` (a copy at the element that may be null, by flow or from the host), #1843;
 * - a typed host value under `!= null`, which leaves no mark on its unknown items, #1847;
 * - the earliest side's leaf `?` of an `otherwise` of a typed host value with a `null` fallback, #1858.
 * Each class is exactly its issue's change of the checker's sentence (`mixedExplained`, Codex r12 on #1789). A source
 * only one checker reports on is outside the candidate slice there and is not compared.
 */

/** The family modules (the families' module contract), read where the tests run. */
async function family<T>(name: string): Promise<T> {
  const file = resolve(process.cwd(), `tests/families/messages/${name}`);
  // EVIDENCE: the family modules export `cases` (name and source) and `shapes` with `sizes` (the module contract).
  return (await import(pathToFileURL(file).href)) as T;
}

// (the issues still open here, each a class of differences `mixedExplained` names exactly)
const OPEN = ["#1790", "#1843", "#1847", "#1858"];

// (the family's sources are made from its axes alone, Astra r3's B1 on #1789 and the lead's two guards: the generator
// evaluated again where every input outside its axes throws gives every source the direct import gives, and the
// record, each case's source key by name, is what it gives, so a refreshed record shows each changed source by name)
interface FamilySources {
  sourcesOf(generator: unknown): readonly { readonly name: string }[];
  sourceKey(source: unknown): string;
  setKey(keys: readonly string[]): string;
}
// (the host's globals, absent from a new realm and shadowed there by names that throw on use)
const HOST = [
  "process",
  "performance",
  "require",
  "module",
  "Buffer",
  "fetch",
  "crypto",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
];
// (a new realm's own inputs from outside it, ECMA-262's and ECMA-402's: the clock and the local time zone (`Date`),
// randomness, garbage collection's timing (`WeakRef`, `FinalizationRegistry`) and the locale (`Intl`, every
// `toLocale…`, `localeCompare`), each replaced on the realm itself, so every alias of it (`globalThis`, `Function`,
// an indirect `eval`) reads the replacement; strict, so a replacement that does not take throws, Codex r20's B1)
const REALM = `"use strict";
const no = (name) => () => { throw new Error("a family generator read " + name); };
const trap = (name) => new Proxy(function () {}, Object.fromEntries(
  ["get", "has", "set", "apply", "construct", "ownKeys", "getPrototypeOf", "defineProperty",
    "deleteProperty", "getOwnPropertyDescriptor"].map((each) => [each, no(name)])));
for (const name of ["Date", "Intl", "WeakRef", "FinalizationRegistry"]) globalThis[name] = trap(name);
Math.random = no("Math.random");
const typed = Object.getPrototypeOf(Int8Array.prototype);
for (const [owner, name] of [[String.prototype, "localeCompare"], [String.prototype, "toLocaleLowerCase"],
  [String.prototype, "toLocaleUpperCase"], [Number.prototype, "toLocaleString"], [BigInt.prototype, "toLocaleString"],
  [Array.prototype, "toLocaleString"], [typed, "toLocaleString"], [Object.prototype, "toLocaleString"]])
  owner[name] = no(name);
`;

interface Exported {
  readonly cases: readonly (readonly [string, string])[];
  readonly globals: unknown;
}

/**
 * A generator's cases, evaluated in a new realm whose every input from outside it throws on use (`REALM`), with each host
 * global a name that throws (`HOST`), and no `import`. Its exports come back as JSON.
 */
function sandboxed(text: string): Exported {
  assert.ok(!/^\s*import\b/m.test(text), "a family generator that imports");
  const made: unknown = runInContext(
    `${REALM}((names) => ((${HOST.join(", ")}) => {
      ${text.replace(/^export /gm, "")}
      return JSON.stringify({ cases, globals });
    })(...names.map(trap)))(${JSON.stringify(HOST)})`,
    createContext({}),
  );
  assert.ok(typeof made === "string", "a family generator's exports");
  const exported: unknown = JSON.parse(made);
  assert.ok(
    typeof exported === "object" &&
      exported !== null &&
      "cases" in exported &&
      "globals" in exported,
    "a family generator's exports",
  );
  const { cases, globals } = exported;
  assert.ok(Array.isArray(cases), "a family generator's cases");
  return {
    cases: Array.from(cases, (each: unknown): readonly [string, string] => {
      assert.ok(Array.isArray(each) && typeof each[0] === "string" && typeof each[1] === "string");
      return [each[0], each[1]];
    }),
    globals,
  };
}

/**
 * Where two lists of `[name, source key]` differ, in order (at most five): a changed, missing, added or repeated case
 * each shows, so equal lists are the same cases in the same order (Codex r20's B2).
 */
function changed(
  mine: readonly (readonly [string, string])[],
  theirs: readonly (readonly [string, string])[],
): string[] {
  const out: string[] = [];
  for (let at = 0; at < Math.max(mine.length, theirs.length) && out.length < 5; at += 1) {
    const [a, b] = [mine[at]?.join(" ") ?? "(none)", theirs[at]?.join(" ") ?? "(none)"];
    if (a !== b) out.push(`${at}: ${a} | ${b}`);
  }
  return out;
}

async function pure(
  direct: unknown,
  record: { readonly sha256: string; readonly keys: string },
): Promise<void> {
  const file = resolve(process.cwd(), "tests/families/messages/1765-mixed-family.mjs");
  // EVIDENCE: `tests/families/sources.mjs` exports `sourcesOf`, `sourceKey` and `setKey` (the families' source identity).
  const lib = (await import(
    pathToFileURL(resolve(process.cwd(), "tests/families/sources.mjs")).href
  )) as FamilySources;
  const keys = (generator: unknown): (readonly [string, string])[] =>
    Array.from(lib.sourcesOf(generator), (source) => [source.name, lib.sourceKey(source)] as const);
  const text = readFileSync(file, "utf8");
  const made = keys(direct);
  assert.deepEqual(
    changed(keys(sandboxed(text)), made),
    [],
    "a source made from more than its axes",
  );
  // (the record's lines, `[name, source key]`: its `recorded.keys` file, written by its second command)
  const recorded = readFileSync(resolve(dirname(file), record.keys), "utf8")
    .trim()
    .split("\n")
    .map((line): readonly [string, string] => {
      const entry: unknown = JSON.parse(line);
      assert.ok(
        Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
        line,
      );
      return [entry[0], entry[1]];
    });
  assert.deepEqual(changed(made, recorded), [], "a source other than the record's");
  assert.equal(
    lib.setKey(recorded.map(([, key]) => key)),
    record.sha256,
    "a record other than the run's",
  );
  // (negative controls: Astra r3's two probes, an inner order and a depth domain read from the environment, and Codex
  // r20's, the clock through an alias, randomness through an indirect `eval` and the locale with no name of it, each fail
  // the first guard; the same order changed in the text fails the second, and a case repeated over another fails both,
  // in the direct and the sandboxed evaluation alike)
  const variant = (from: string, to: string): string => {
    assert.ok(text.includes(from), from);
    return text.replace(from, to);
  };
  const inner = "(([${one}]).take(9)+([${twin}]).take(9))";
  const swapped = "(([${twin}]).take(9)+([${one}]).take(9))";
  const domain = '["depth", () => [2, 3]]';
  const probes = [
    variant(
      `\`${inner}\``,
      `(process.env.REVIEW_TWIN_REVERSED === "1" ? \`${swapped}\` : \`${inner}\`)`,
    ),
    ...[
      'process.env.REVIEW_DEPTHS === "4"',
      "globalThis.Date.now()",
      'Function("return Date.now()")()',
      '(0, eval)("Math.random()")',
      "(1234.5).toLocaleString()",
      '"a".localeCompare("b")',
      "new Intl.NumberFormat().format(1)",
    ].map((read) => variant(domain, `["depth", () => (${read}, [2, 3])]`)),
  ];
  for (const probe of probes) assert.throws(() => sandboxed(probe), /a family generator read /);
  assert.notDeepEqual(changed(keys(sandboxed(variant(inner, swapped))), recorded), []);
  const repeated = "export const globals";
  assert.notDeepEqual(
    changed(
      keys(sandboxed(variant(repeated, `cases[cases.length - 1] = cases[0];\n${repeated}`))),
      recorded,
    ),
    [],
  );
  assert.notDeepEqual(
    changed(
      keys(
        sandboxed(
          variant(
            repeated,
            `if (typeof process === "function") cases[cases.length - 1] = cases[0];\n${repeated}`,
          ),
        ),
      ),
      made,
    ),
    [],
  );
}

// (the sample: each kind at every position with every relation of its carried layer to the null (`RELATIONS`, the
// null's distance below it inside a list and at the leaf), the order turned through them; the joined positions at one
// relation or two (`ONE`): a second disagreeing side asks the first join again at the interior relation, and the side
// joined with its twin in both orders of their answers, the side's null above the twin's (Codex r17's witness) and
// below it (a copy two lists in, the twin's at the element's own layer, Codex r18))
type Relation = readonly [depth: number, at: number, nullAt: number];
const RELATIONS: readonly Relation[] = [
  [3, 1, 2],
  [3, 0, 2],
  [3, 0, 3],
  [3, 1, 3],
  [3, 2, 0],
  [3, 1, 1],
  [2, 0, 1],
  [2, 1, 2],
];
const ONE: Readonly<Record<string, readonly Relation[]>> = {
  joinTwice: [[3, 1, 2]],
  joinNulls: [
    [3, 1, 1],
    [3, 2, 0],
  ],
};

// (the coverage invariant, the lead's after Codex r16–r18 each found an axis those relations missed: a case's classes,
// from its name, which is exactly its values on the generator's axes (`axes`, the only values a case varies by). One
// per value of each axis; the relation (the depth triple) and the side's null above or below its twin's; and one per
// pair of axes the transport composes (the relation with the order, the carried layer with the kind). The sample holds
// every class the family has)
function classes(row: MixedDimensions): string[] {
  const relation = `${row.depth},${row.at},${row.nullAt}`;
  const twin =
    row.twin === 0 ? "-" : row.nullAt === 0 ? "free" : row.nullAt < row.twin ? "above" : "below";
  return [
    ...Object.entries(row).map(([axis, value]) => `${axis} ${String(value)}`),
    `relation ${relation}`,
    `twin ${twin}`,
    `relation×later ${relation} ${row.later}`,
    `layer×kind ${row.depth}@${row.at} ${row.kind}`,
  ];
}

function sampled(
  cases: readonly (readonly [string, string])[],
  axes: readonly string[],
): (readonly [string, string])[] {
  // (each case's name is its values on the generator's axes, so a value a case varies by is one the invariant reads;
  // and one name is one source, so a value varied outside the axes is a second source under a name, Codex r19)
  const named = new Map<string, string>();
  for (const [name, source] of cases) {
    assert.deepEqual(Object.keys(mixedDimensions(name)), axes, name);
    assert.equal(named.get(name) ?? source, source, `a second source under ${name}`);
    named.set(name, source);
  }
  const kinds = [...new Set(cases.map(([name]) => mixedDimensions(name).kind))];
  const positions = [...new Set(cases.map(([name]) => mixedDimensions(name).position))];
  const out: (readonly [string, string])[] = [];
  let turn = 0;
  for (const kind of kinds)
    for (const position of positions)
      for (const [depth, carried, nullAt] of ONE[position] ?? RELATIONS)
        for (const later of position in ONE ? [false, true] : [turn++ % 2 === 1]) {
          const at = kind === "plain" ? -1 : carried;
          const found = cases.find(([name]) => {
            const d = mixedDimensions(name);
            return (
              d.kind === kind &&
              d.position === position &&
              d.later === later &&
              d.depth === depth &&
              d.nullAt === nullAt &&
              d.at === at
            );
          });
          assert.ok(found !== undefined, `${kind} ${position} ${later}`);
          out.push(found);
        }
  // (then each case, in the family's order, that brings a class no sampled case has)
  const taken = new Set(out.flatMap(([name]) => classes(mixedDimensions(name))));
  for (const each of cases) {
    const mine = classes(mixedDimensions(each[0]));
    if (mine.every((one) => taken.has(one))) continue;
    out.push(each);
    for (const one of mine) taken.add(one);
  }
  return out;
}

test("a mixed-list error's type text equals the current checker's across the sampled family (#1765)", async () => {
  const generator = await family<{
    cases: readonly (readonly [string, string])[];
    axes: readonly (readonly [string, unknown])[];
    recorded: { readonly sha256: string; readonly keys: string };
  }>("1765-mixed-family.mjs");
  await pure(generator, generator.recorded);
  const { cases, axes } = generator;
  const differing: string[] = [];
  let compared = 0;
  for (const [name, source] of sampled(
    cases,
    axes.map(([axis]) => axis),
  )) {
    const { current, core } = mixedSentences(source);
    for (const each of core) assert.deepEqual(each, core[0], name);
    const row = mixedDimensions(name);
    const pair = mixedCompared(row, core[0]!, current);
    if (pair === null) continue;
    compared += 1;
    if (mixedExplained(row, pair.core, pair.current, OPEN) === null)
      differing.push(
        `${name}\n  core: ${pair.core.join(" | ")}\n  checker: ${pair.current.join(" | ")}`,
      );
  }
  assert.deepEqual(differing, [], `${compared} compared`);
  assert.ok(compared > 0);
});

/**
 * #1765's invariant, its work (the lead's family rule): each composition dimension of
 * `tests/families/messages/1765-mixed-growth.mjs` (nest depth, join width, the otherwise chain, index chains, null
 * density, each carrier kind deep, wide and at every depth) at its first doubling, in one mode. The queue runs both
 * doublings in four modes against main, the head's work over main's flat (#1857 names the shapes main itself grows
 * past their bound on).
 */
test("a mixed-list error's work grows as its dimensions do (#1765)", async () => {
  const { shapes, sizes } = await family<{
    shapes: Record<string, (size: number) => string>;
    sizes: readonly number[];
  }>("1765-mixed-growth.mjs");
  const total = (source: string): number => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const answers = inMode(MODES[0]!, () => analyseCore(request));
    assert.equal(answers.budget.exhausted, null, source);
    return answers.budget.total;
  };
  for (const [shape, make] of Object.entries(shapes)) {
    // (width and the otherwise chain linear, ×2.5; depth as the errors' paths grow, ×4.5)
    const bound = /^(wide:|join-width:|otherwise-chain)/.test(shape) ? 2.5 : 4.5;
    const [small, large] = [sizes[0]!, sizes[1]!].map((size) => total(make(size)));
    assert.ok(large! <= bound * small!, `${shape}: ${small}, ${large}`);
  }
});
