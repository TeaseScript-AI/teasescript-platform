// A place published with a kind on the candidate route: the external data stored into it, and every carrier kind's
// obligation (A7, C9).

import assert from "node:assert/strict";
import test from "node:test";

import { type CompilationResult } from "../../../src/compiler.js";
import { type SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice } from "../../../src/type-inference/core/backend.js";
import { CARRIER_KINDS, type CarrierKind } from "../../../src/type-inference/core/carriers.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import {
  BOTH,
  owed,
  records,
  type Endpoint,
  type RuleClass,
} from "../../helpers/type-core/type-core-rule.js";
import {
  candidate,
  sited,
  inBothOrdersAs,
  runWith,
  answeredWith,
  checksOf,
} from "../../helpers/type-core/type-core-candidate-setup.js";

/** The admitted type of the binding `name` at `path`: its kinds and its decider's offset. */
function admittedOf(source: string, name: string, path: readonly string[] = []): string {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  // (the core numbers its places alike in every analysis of a request)
  const place = new CoreProgram(request).places.find(
    ({ kind }) => kind.kind === "binding" && kind.name === name,
  );
  assert.ok(place !== undefined, `${source}: ${name}'s place`);
  const admitted = analyseCore(request).place(place.id, path).admitted;
  return admitted.by === "decided"
    ? `decided ${admitted.kinds.join("|")}@${admitted.decider?.start ?? "-"}`
    : admitted.by;
}

test("a place published with a kind checks the external data stored into it, named or inline, at any endpoint (A7, C9)", () => {
  // the external reviewer's endpoint matrix: per kind (a known element, a fitting host value and bad ones, an integer's
  // fractional one too), projection (an index, a nested index, parentheses, an index held in a variable), host data
  // inline or named, and without or with a later store: the place is decided by the known element (or the later store),
  // named data warns where it is read with its check, inline data has its boundary, the declaration's store alone checks
  // the kind, a bad value fails at the declaration's value with nothing said, and the fitting one says AFTER and halts
  const kinds = [
    ["1", 2, ["bad", 2.5]],
    ['"a"', "b", [1]],
    ["true", false, ["bad"]],
  ] as const;
  const forms = [
    (data: string): string => `[K, ${data}][1]`,
    (data: string): string => `[[K, ${data}]][0][1]`,
    (data: string): string => `([K, ${data}])[1]`,
    (data: string): string => `[K, ${data}][i]`,
  ];
  let shapes = 0;
  for (const [known, good, bad] of kinds)
    for (const [index, form] of forms.entries())
      for (const named of [false, true])
        for (const later of [false, true]) {
          const lines = [
            ...(named ? ["let raw = hostValue"] : []),
            ...(index === 3 ? ["let i = 1"] : []),
            `let out = ${form(named ? "raw" : "hostValue").replace("K", known)}`,
            ...(later ? [`out = ${known}`] : []),
            'say "AFTER"',
            "exit",
          ];
          const source = `${lines.join("\n")}\n`;
          const declaration = source.indexOf("let out");
          const decider = later ? source.lastIndexOf(known) : source.indexOf(known, declaration);
          const kind = known === "1" ? "integer" : known === "true" ? "boolean" : "string";
          assert.equal(admittedOf(source, "out"), `decided ${kind}@${decider}`, source);
          // (named data warns where it is read; with a later decider, C1 warns at the stored value, inline data at
          // its host value)
          const value = declaration + "let out = ".length;
          const end = source.indexOf("\n", declaration);
          const data = named ? source.indexOf("raw", declaration) : source.indexOf("hostValue");
          const warned = named ? (later ? value : data) : later ? data : null;
          const [{ plan }, compiled] = inBothOrdersAs(
            () => candidate(source),
            (result) => ({
              diagnostics: sited(result),
              checks: result.plan === null ? null : checksOf(result.plan),
            }),
          );
          assert.deepEqual(
            compiled,
            {
              diagnostics: warned === null ? [] : [`warning TSV041@${warned}`],
              checks: [`${declaration}:${end} ${kind}`],
            },
            source,
          );
          assert.ok(plan !== null, source);
          assert.deepEqual(
            runWith(plan, good),
            { status: "halted", says: ["AFTER"], failure: null },
            `${source} with ${JSON.stringify(good)}`,
          );
          for (const refused of bad)
            assert.deepEqual(
              runWith(plan, refused),
              { status: "failed", says: [], failure: `TSR058@${value}:${end}` },
              `${source} with ${JSON.stringify(refused)}`,
            );
          shapes += 1;
        }
  assert.equal(shapes, 48);
  // the controls: host data alone admits no kind (nothing to check it against), known elements need no check
  for (const [source, admitted] of [
    ['let raw = hostValue\nlet out = [raw][0]\nsay "AFTER"\nexit\n', "undecided"],
    ['let out = [1, 2][1]\nsay "AFTER"\nexit\n', "decided integer@10"],
  ] as const) {
    assert.equal(admittedOf(source, "out"), admitted, source);
    const [{ plan }, diagnostics] = inBothOrdersAs(() => candidate(source), sited);
    assert.deepEqual(diagnostics, [], source);
    assert.ok(plan !== null, source);
    assert.deepEqual(checksOf(plan), [], source);
    assert.deepEqual(
      runWith(plan, "bad"),
      { status: "halted", says: ["AFTER"], failure: null },
      source,
    );
  }
});

/**
 * Per carrier kind, the ways a declaration gives host data through the carrier beside a known integer, each at a scalar
 * endpoint (the place's value) and at a collection one (its element): the data inside a literal operand, the whole
 * operand, the operation's own read, or the receiver whose member the runtime reads (F15: the destination's own
 * check beside C5's obligation on the receiver). `lists` counts the lists around the host value at each endpoint;
 * `read` names the read that brings the data into the declaration where it is not the data's (a loop variable).
 */
interface CarrierShape {
  readonly data: string;
  readonly scalar: string;
  readonly collection: string | { readonly none: string };
  /** Where the data stands by the rule function's terms, per endpoint where they differ. */
  readonly rule: Rule | ((endpoint: Endpoint) => Rule);
  readonly lists?: readonly [scalar: number, collection: number];
  readonly read?: string;
}

/** A shape's class for the rule function (`owed`): its data's row and the carrier's facts. */
type Rule = Omit<RuleClass, "carrier" | "placement" | "form" | "endpoints">;

const CARRIER_SHAPES: Readonly<Record<CarrierKind, readonly CarrierShape[]>> = {
  projection: [
    {
      data: "in a literal",
      scalar: "let out = [1, D][1]",
      collection: "let out = [[1, D]][0]",
      rule: { data: "cell", declares: true },
    },
    {
      data: "a member",
      scalar: "let out = [1, D[0]][1]",
      collection: "let out = [[1], D[0]][1]",
      lists: [1, 2],
      rule: { data: "member", declares: true, member: (h) => `${h}[0]` },
    },
  ],
  iteration: [
    {
      data: "in a literal",
      scalar: "for entry in [1, D] {\n  let out = entry\n  LATER\n}",
      collection: "for entry in [[1, D]] {\n  let out = entry\n  LATER\n}",
      rule: { data: "loop-cell", loop: true },
    },
    {
      data: "a member",
      scalar: "for entry in D {\n  let out = [1, entry][1]\n  LATER\n}",
      collection: "for entry in D {\n  let out = [[1], entry][1]\n  LATER\n}",
      lists: [1, 2],
      read: "entry",
      rule: { data: "loop-operand", loop: true, declares: true },
    },
  ],
  otherwise: [
    {
      data: "the operand",
      scalar: "let out = D otherwise 1",
      collection: "let out = D otherwise [1]",
      lists: [0, 1],
      rule: { data: "whole" },
    },
  ],
  get: [
    {
      data: "in a literal",
      scalar: "let out = [1, D].get(1, default: 1)",
      collection: "let out = [[1, D]].get(0, default: [])",
      rule: { data: "cell", declares: true },
    },
    {
      data: "a member",
      scalar: "let out = D.get(0, default: 1)",
      collection: "let out = D.get(0, default: [1])",
      lists: [1, 2],
      rule: { data: "member", member: (h, k) => `${h}.get(0, default: ${k})` },
    },
  ],
  "load default": [
    {
      data: "its own read",
      scalar: 'let out = load("k", default: [1, D][1])',
      collection: 'let out = load("k", default: [1, D])',
      rule: { data: "typed", own: (k, _, h) => (k === "1" ? `[1, ${h}][1]` : `[1, ${h}]`) },
    },
  ],
  "parse default": [
    {
      data: "its own read",
      // text that is not JSON, so the default is the value
      scalar: 'let out = fromJson("broken", default: [1, D][1])',
      collection: 'let out = fromJson("broken", default: [1, D])',
      rule: { data: "typed", own: (k, _, h) => (k === "1" ? `[1, ${h}][1]` : `[1, ${h}]`) },
    },
  ],
  copy: [
    {
      data: "in a literal",
      scalar: "let out = [1, D].take(2)[1]",
      collection: "let out = [1, D].take(2)",
      rule: { data: "cell", declares: true },
    },
    {
      data: "a member",
      scalar: "let out = [1, D.take(1)[0]][1]",
      collection: "let out = [[1], D.take(1)][1]",
      lists: [1, 1],
      // (the copy is what the operation reads of its receiver, the member C1 sits at)
      rule: { data: "member", declares: true, member: (h) => `${h}.take(1)`, listed: true },
    },
  ],
  removal: [
    {
      data: "in a literal",
      scalar: "let out = [1, D].removeFirst()",
      collection: "let out = [[1, D]].removeFirst()",
      rule: { data: "cell", combining: true },
    },
    {
      data: "a member",
      scalar: "let out = [1, D.removeFirst()][1]",
      collection: "let out = [[1], D.removeFirst()][1]",
      lists: [1, 2],
      rule: { data: "member", declares: true, member: (h) => `${h}.removeFirst()` },
    },
  ],
  concatenation: [
    {
      data: "the operand",
      scalar: "let out = ([1] + D)[1]",
      collection: "let out = [1] + D",
      lists: [1, 1],
      // (an element of the result is a member of the data; the result itself a list whatever the data holds)
      rule: (endpoint) =>
        endpoint === "scalar"
          ? { data: "through", combining: true }
          : { data: "whole", combining: true, listed: true },
    },
  ],
  choice: [
    {
      data: "an option",
      scalar: "let out = askChoice 1, D",
      collection: { none: "a button's value is never a list or a set (V30 §19, TSV029)" },
      rule: { data: "cell" },
    },
  ],
};

/**
 * Invariant O over the carrier table (`carriers.ts`), without exception: each kind of `CARRIER_KINDS` has its
 * shapes, each named or inline, without and with a later store, in both orders. The place is admitted an integer where
 * the data stands (published or decided), and the shape's complete multiset of C1, C9 and C10 records is what the rule
 * function owes (`type-core-rule.ts`): named data A7's `copy-type` warning and check beside its source's
 * own boundary, inline data C9's boundary or C1's check, a member's C1 at what is read of it,
 * data in the operation's own read the operation's boundary (C10), every site and multiplicity (Astra r5 D2).
 * Where the candidate route reaches a shape, its plan checks the declaration against the whole type, a
 * fitting value says AFTER and halts, and each bad one fails at the declaration's value with nothing said; a shape
 * outside the slice is proved at the answers, the route's reason reported.
 */
test("every carrier kind leaves an obligation for the external data it gives a place admitted a kind (O, A7, C9, C10)", (t) => {
  assert.deepEqual(Object.keys(CARRIER_SHAPES).sort(), [...CARRIER_KINDS].sort());
  const outside = new Map<string, string>();
  const none: string[] = [];
  let shapes = 0;
  let routed = 0;
  for (const kind of CARRIER_KINDS)
    for (const { data: placed, scalar, collection, rule, lists = [0, 0], read } of CARRIER_SHAPES[
      kind
    ])
      for (const [endpoint, template, wrap] of [
        ["scalar", scalar, lists[0]],
        ["collection", collection, lists[1]],
      ] as const) {
        if (typeof template !== "string") {
          none.push(`${kind} at a collection: ${template.none}`);
          continue;
        }
        const shape: string = template;
        for (const named of [false, true])
          for (const later of [false, true]) {
            const store = endpoint === "scalar" ? "out = 1" : "out = [1]";
            const filled = shape.replace("D", named ? "raw" : "hostValue");
            const body: string = filled.includes("LATER")
              ? filled.replace(later ? "LATER" : /\n *LATER/, later ? store : "")
              : `${filled}${later ? `\n${store}` : ""}`;
            const source: string = `${named ? "let raw = hostValue\n" : ""}${body}\nsay "AFTER"\nexit\n`;
            const name =
              `${kind}, the data ${placed}, at a ${endpoint}, ${named ? "named" : "inline"}` +
              (later ? ", a later store" : "");
            // the data's read, and the statement that holds it: its place and its value
            const data =
              read !== undefined
                ? source.indexOf(read, source.indexOf("let out"))
                : named
                  ? source.indexOf("raw", source.indexOf("\n"))
                  : source.indexOf("hostValue");
            const holder = source.lastIndexOf("\n", data) + 1;
            const end = source.indexOf("\n", holder);
            const [opening] = /^ *(?:let|for) \w+ (?:=|in) /.exec(source.slice(holder))!;
            const value = holder + opening.length;
            // the complete C1, C9 and C10 multiset the rule function owes (S6-CARRIERS), the named source's own
            // boundary, every site and multiplicity included, in both orders (Astra r5 D2)
            const owes = typeof rule === "function" ? rule(endpoint) : rule;
            assert.deepEqual(
              records(source),
              owed(
                { carrier: kind, placement: placed, form: () => "", endpoints: BOTH, ...owes },
                endpoint,
                named,
                later,
                source,
                "raw",
              ),
              name,
            );
            assert.equal(
              admittedOf(source, "out", endpoint === "scalar" ? [] : ["element"]).split("@")[0],
              "decided integer",
              name,
            );
            shapes += 1;
            let compiled: readonly [
              CompilationResult,
              { readonly checks: readonly string[] | null },
            ];
            try {
              compiled = inBothOrdersAs(
                () => candidate(source),
                (result) => ({ checks: result.plan === null ? null : checksOf(result.plan) }),
              );
            } catch (error) {
              if (!(error instanceof CandidateOutsideSlice)) throw error;
              outside.set(`${kind} (${placed})`, error.what.replace(/^this /, ""));
              continue;
            }
            const [result, { checks }] = compiled;
            // (the checked store, a loop body's after its indentation)
            const statement = holder + /^ */.exec(source.slice(holder))![0].length;
            assert.deepEqual(
              checks,
              [`${statement}:${end} ${endpoint === "scalar" ? "integer" : "list<integer>"}`],
              name,
            );
            const plan = result.plan!;
            // (a choice's run waits at the ask: the player picks the button holding the data, the option after `1`)
            const ran = (hostValue: SerializableRuntimeValue) =>
              kind === "choice" ? answeredWith(plan, hostValue, 1) : runWith(plan, hostValue);
            const host = (
              scalar: SerializableRuntimeValue,
              depth = wrap,
            ): SerializableRuntimeValue =>
              depth === 0 ? scalar : { kind: "list", items: [host(scalar, depth - 1)] };
            assert.deepEqual(
              ran(host(2)),
              { status: "halted", says: ["AFTER"], failure: null },
              `${name} with 2`,
            );
            for (const bad of ["bad", 2.5])
              assert.deepEqual(
                ran(host(bad)),
                { status: "failed", says: [], failure: `TSR058@${value}:${end}` },
                `${name} with ${JSON.stringify(bad)}`,
              );
            routed += 1;
          }
      }
  t.diagnostic(
    `${shapes} shapes, ${routed} on the candidate route; outside the slice (later port steps; the answers only): ` +
      [...outside].map(([shape, what]) => `${shape}: ${what}`).join(", ") +
      `; no shape: ${none.join("; ")}`,
  );
});
