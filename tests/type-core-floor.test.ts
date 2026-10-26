import assert from "node:assert/strict";
import test from "node:test";

import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import type { CompactRecord } from "./helpers/type-core-records.js";

/*
 * The carrier floor (S6-CARRIERS revision 5, §6): Astra's independent 184 shapes of round 4 (`matrix/REPORT.md`,
 * `comparison.md`), transcribed as their 46 placement and endpoint classes, each named and inline, without and with a
 * later store, in both orders. Each shape's complete multiset of C1, C9 and C10 records (§5.1: every `copy-type` check,
 * a destination's own null-check, and their written-target warnings with their context words) is compared exactly with
 * the rule function, §5.1's table with TABLE r4.60 and r4.63–r4.66:
 * - inline whole data owes one store boundary at the host value's own span, against the type admitted there, and C1
 *   beside it at that span unless its place is published (r4.63 (1)); reached through a projection of the carrier's
 *   result, it is a member of the data;
 * - named data owes its source's own boundary, `parcel [unknown]` at its ingress, and C1 at the named read where the
 *   place is published, else at the store's value span below a selecting operation and at the named read below a
 *   combining or removing one (r4.63 (2));
 * - a member of host data owes C1 at the member read in any state (r4.60);
 * - a `get`'s or an `otherwise`'s default owes its own read's `[unknown]` boundary, the destination's C1 at the store's
 *   value span, and C10's family check only where the direct value has a family (r4.63 (3), r4.65 (1));
 * - a `load`'s or `fromJson`'s default: the call is the ingress, its boundary against the destination, with C1 beside
 *   it where a consumer meets the loaded value; a default with definite kinds (a literal) types the call and owes no own
 *   read, a host value's own read stays an own read, and named data owes its source's boundary (r4.66 (2));
 * - a loop variable owes the boundary against its own contract and C1 beside it (r4.63 (4)); a loop over host data
 *   owes one boundary, at the host value, of the ingress landing on the loop variable (r4.64, r4.65 (2)).
 * A place's state is S4's decision, taken as given: published by its one store, decided by the later store, or, for a
 * collection's element, decided at the declaration where the carrier passes the decision on (A2 with F7, F10, F17b).
 */

type Endpoint = "scalar" | "collection";

/** Where the data stands (§5.1's rows). */
type Data =
  "cell" | "whole" | "through" | "member" | "own" | "typed" | "loop-cell" | "loop-operand";

interface FloorClass {
  readonly carrier: string;
  readonly placement: string;
  /** The declaration's value for a known element `k` and the data `v` (`h` the host read or its name alone). */
  readonly form: (k: string, v: string, h: string) => string;
  readonly endpoints: readonly Endpoint[];
  readonly data: Data;
  /** The operation the data is carried through: one that selects its value, or one that combines or removes (r4.63 (2)). */
  readonly combining?: true;
  /** A collection's element is decided at the declaration: the carrier passes the decision on (A2). */
  readonly declares?: true;
  /** A member read's text, for the host value or its name `h` and the known element `k` (r4.60). */
  readonly member?: (h: string, k: string) => string;
  /** The loop's head, where the data reaches `out` through a loop variable: `for entry in …`. */
  readonly loop?: true;
  /** The kind the known element gives (`text` for the selected-text choices). */
  readonly kind?: "string";
}

const BOTH: readonly Endpoint[] = ["scalar", "collection"];
const SCALAR: readonly Endpoint[] = ["scalar"];

const CLASSES: readonly FloorClass[] = [
  {
    carrier: "projection",
    placement: "literal",
    form: (k, v) => `[${k}, ${v}][1]`,
    endpoints: BOTH,
    data: "cell",
    declares: true,
  },
  {
    carrier: "projection",
    placement: "unknown receiver",
    form: (k, _, h) => `[${k}, ${h}.field][1]`,
    endpoints: BOTH,
    data: "member",
    declares: true,
    member: (h) => `${h}.field`,
  },
  {
    carrier: "iteration",
    placement: "literal",
    form: (k, v) => `[${k}, ${v}]`,
    endpoints: BOTH,
    data: "loop-cell",
    loop: true,
  },
  {
    carrier: "otherwise",
    placement: "direct literal",
    form: (k, v) => `([${k}, ${v}][1] otherwise ${k})`,
    endpoints: BOTH,
    data: "cell",
    declares: true,
  },
  {
    carrier: "otherwise",
    placement: "whole fallback",
    form: (k, v) => `[${k}, (null otherwise ${v})][1]`,
    endpoints: BOTH,
    data: "own",
    declares: true,
  },
  {
    carrier: "get",
    placement: "literal receiver",
    form: (k, v) => `[${k}, ${v}].get(1, default: ${k})`,
    endpoints: BOTH,
    data: "cell",
    declares: true,
  },
  {
    carrier: "get",
    placement: "whole default",
    form: (k, v) => `[${k}].get(7, default: ${v})`,
    endpoints: BOTH,
    data: "own",
  },
  {
    carrier: "get",
    placement: "unknown receiver",
    form: (k, _, h) => `[${k}, ${h}.get(0, default: ${k})][1]`,
    endpoints: BOTH,
    data: "member",
    declares: true,
    member: (h, k) => `${h}.get(0, default: ${k})`,
  },
  {
    carrier: "load default",
    placement: "literal default",
    form: (k, v) => `load("parcel", default: [${k}, ${v}][1])`,
    endpoints: BOTH,
    data: "typed",
    declares: true,
  },
  {
    carrier: "load default",
    placement: "whole default",
    form: (k, v) => `[${k}, load("parcel", default: ${v})][1]`,
    endpoints: BOTH,
    data: "typed",
    declares: true,
  },
  {
    carrier: "parse default",
    placement: "literal default",
    form: (k, v) => `fromJson("broken", default: [${k}, ${v}][1])`,
    endpoints: BOTH,
    data: "typed",
    declares: true,
  },
  {
    carrier: "parse default",
    placement: "whole default",
    form: (k, v) => `[${k}, fromJson("broken", default: ${v})][1]`,
    endpoints: BOTH,
    data: "typed",
    declares: true,
  },
  {
    carrier: "copy",
    placement: "literal receiver",
    form: (k, v) => `[${k}, ${v}].takeLast(1)[0]`,
    endpoints: BOTH,
    data: "cell",
    declares: true,
  },
  {
    carrier: "copy",
    placement: "whole receiver",
    form: (k, _, h) => `([${k}] + ${h}.toList())[1]`,
    endpoints: BOTH,
    data: "member",
    member: (h) => `${h}.toList()`,
  },
  {
    carrier: "removal",
    placement: "literal receiver",
    form: (k, v) => `[${k}, ${v}].removeAt(1)`,
    endpoints: BOTH,
    data: "cell",
    combining: true,
  },
  {
    carrier: "removal",
    placement: "whole receiver",
    form: (k, _, h) => `[${k}, ${h}.removeAt(0)][1]`,
    endpoints: BOTH,
    data: "member",
    combining: true,
    declares: true,
    member: (h) => `${h}.removeAt(0)`,
  },
  {
    carrier: "concatenation",
    placement: "literal operand",
    form: (k, v) => `([${k}] + [${v}])[1]`,
    endpoints: BOTH,
    data: "cell",
    combining: true,
  },
  {
    carrier: "concatenation",
    placement: "whole operand",
    form: (k, _, h) => `([${k}] + ${h})[1]`,
    endpoints: BOTH,
    data: "through",
    combining: true,
  },
  {
    carrier: "choice",
    placement: "literal option",
    form: (k, v) => `askChoice [${k}, ${v}]`,
    endpoints: SCALAR,
    data: "cell",
  },
  {
    carrier: "choice",
    placement: "whole option",
    form: (k, v) => `askChoice ${k}, ${v}`,
    endpoints: SCALAR,
    data: "cell",
  },
  {
    carrier: "choice",
    placement: "selected value",
    form: (k, v) => `askChoice {text: "known", value: ${k}}, {text: "host", value: ${v}}`,
    endpoints: SCALAR,
    data: "cell",
  },
  // the edges the independent pass added after comparing with the maintained matrix (`additional-edges.mjs`)
  {
    carrier: "iteration",
    placement: "whole operand",
    form: (k) => `[${k}, entry][1]`,
    endpoints: BOTH,
    data: "loop-operand",
    declares: true,
    loop: true,
  },
  {
    carrier: "otherwise",
    placement: "whole operand",
    form: (k, _, h) => `${h} otherwise ${k}`,
    endpoints: BOTH,
    data: "whole",
  },
  // F25's selected-text edges (`additional-choice.mjs`)
  {
    carrier: "choice",
    placement: "direct selected text",
    form: (_, __, h) => `askChoice {text:"fixed"}, {text:${h}}`,
    endpoints: SCALAR,
    data: "cell",
    kind: "string",
  },
  {
    carrier: "choice",
    placement: "list selected text",
    form: (_, __, h) => `askChoice [{text:"fixed"}, {text:${h}}]`,
    endpoints: SCALAR,
    data: "cell",
    kind: "string",
  },
  {
    carrier: "choice",
    placement: "derived selected text",
    form: (_, __, h) => `askChoice dict{left:{text:"fixed"}, right:{text:${h}}}.values`,
    endpoints: SCALAR,
    data: "cell",
    kind: "string",
  },
];

interface Shape {
  readonly name: string;
  readonly source: string;
  /** The records the rule function owes, sorted, in `records`' form. */
  readonly expected: readonly string[];
}

/** The span of the text `text` at or after `from`. */
function spanOf(source: string, text: string, from = 0): string {
  const at = source.indexOf(text, from);
  assert.ok(at >= 0, `${text} in ${source}`);
  return `${at}:${at + text.length}`;
}

/** The span of the parenthesised call that starts at `start`: to its matching closing parenthesis. */
function callSpan(source: string, start: number): string {
  let depth = 0;
  for (let at = source.indexOf("(", start); at < source.length; at += 1) {
    if (source[at] === "(") depth += 1;
    else if (source[at] === ")" && (depth -= 1) === 0) return `${start}:${at + 1}`;
  }
  throw new Error(`no call at ${start}`);
}

type State = "published" | "later" | "decided";

/** The records `floor`'s shape owes by the rule function (§5.1 with TABLE r4.60, r4.63–r4.66), sorted. */
function owed(
  floor: FloorClass,
  endpoint: Endpoint,
  named: boolean,
  later: boolean,
  source: string,
): string[] {
  const out: string[] = [];
  const collection = endpoint === "collection";
  const kind = floor.kind ?? "integer";
  const host = named ? "parcel" : "hostValue";
  const ingress = spanOf(source, "hostValue");
  const first = named ? source.indexOf("\n") + 1 : 0;
  const read = spanOf(source, host, first);
  const declaration = /let out = (.*)\n/u.exec(source);
  const value = declaration === null ? "" : spanOf(source, declaration[1]!);
  const c1 = (target: string, against: string, site: string, state: State): void => {
    out.push(`C copy-type ${target} [${against}] ${site}`);
    out.push(`D warning-runtime-check ${site} ${state === "later" ? "later" : "unknown"}`);
  };
  // each destination path's state: the place itself published by its one store or decided by the later one; a
  // collection's element decided at the declaration where the carrier passes the decision on
  const whole: State = later ? "later" : "published";
  const element: State = floor.declares === true ? "decided" : whole;
  const paths = (list: string): (readonly [string, string, State])[] => [
    ["out", collection ? list : kind, whole],
    ...(collection ? [["out.element", kind, element] as const] : []),
  ];
  if (named && floor.data !== "typed") out.push(`B copy-type parcel [unknown] ${ingress}`);
  switch (floor.data) {
    case "cell": {
      const [target, state] = collection ? ["out.element", element] : ["out", whole];
      if (!named) {
        out.push(`B copy-type ${target} [${kind}] ${ingress}`);
        if (state !== "published") c1(target, kind, ingress, state);
      } else
        c1(target, kind, state === "published" || floor.combining === true ? read : value, state);
      break;
    }
    case "whole":
    case "through":
    case "member": {
      if (!named) out.push(`B copy-type out [${collection ? "list" : kind}] ${ingress}`);
      for (const [target, against, state] of paths("list"))
        if (floor.data === "member")
          c1(
            target,
            against,
            spanOf(source, floor.member!(host, collection ? "[1]" : "1"), first),
            state,
          );
        else if (named) c1(target, against, state === "published" ? read : value, state);
        else if (state !== "published" || floor.data === "through")
          c1(target, against, ingress, state);
      break;
    }
    case "own": {
      if (!named) out.push(`B copy-type hostValue [unknown] ${ingress}`);
      const [target, state] = collection ? ["out.element", element] : ["out", whole];
      c1(target, kind, value, state);
      if (floor.carrier === "get") {
        const at = collection ? spanOf(source, `[${host}]`, first) : read;
        out.push(
          `C copy-type ${collection ? `[${host}].element` : host} [integer|number] ${at}`,
          `D warning-runtime-check ${at} unknown`,
        );
      }
      break;
    }
    case "typed": {
      const call = callSpan(
        source,
        source.indexOf(floor.carrier === "load default" ? "load(" : "fromJson("),
      );
      out.push(`B copy-type out [${collection ? "list" : kind}] ${call}`);
      const [target, state] = collection ? ["out.element", element] : ["out", whole];
      if (state === "published") break;
      // (a consumer meets the loaded value: the destination's check beside the call's boundary)
      c1(target, kind, call, state);
      // r4.66 (2): a default types its call where its kinds are definite, a literal's; a host value's own read stays an
      // own read; named data owes its source's boundary wherever the loaded value meets a consumer
      const typed = floor.placement === "literal default" || collection;
      if (named) out.push(`B copy-type parcel [unknown] ${ingress}`);
      else if (!typed) out.push(`B copy-type hostValue [unknown] ${ingress}`);
      break;
    }
    case "loop-cell": {
      const target = collection ? "entry.element" : "entry";
      if (!named) {
        out.push(`B copy-type ${target} [${kind}] ${ingress}`);
        c1(target, kind, ingress, "decided");
      } else {
        const iterable = source.indexOf("[", source.indexOf("for entry in"));
        c1(
          target,
          kind,
          collection ? `${iterable}:${source.indexOf(" {", iterable)}` : read,
          "decided",
        );
      }
      if (later)
        c1(
          collection ? "out.element" : "out",
          kind,
          spanOf(source, "entry", source.indexOf("let out")),
          "later",
        );
      break;
    }
    case "loop-operand": {
      if (!named) out.push(`B copy-type entry [unknown] ${ingress}`);
      const reading = spanOf(source, "entry", source.indexOf("let out"));
      for (const [target, against, state] of paths("list"))
        c1(target, against, state === "published" ? reading : value, state);
      break;
    }
  }
  return out.sort();
}

function shapes(): Shape[] {
  const out: Shape[] = [];
  for (const floor of CLASSES)
    for (const endpoint of floor.endpoints)
      for (const named of [false, true])
        for (const later of [false, true]) {
          const host = named ? "parcel" : "hostValue";
          const known = floor.kind === "string" ? '"fixed"' : endpoint === "scalar" ? "1" : "[1]";
          const data = endpoint === "scalar" ? host : `[${host}]`;
          const value = floor.form(known, data, host);
          const body = `let out = ${floor.loop === true ? (floor.placement === "literal" ? "entry" : value) : value}\n${later ? `out = ${known}\n` : ""}say "AFTER"`;
          const head =
            floor.loop === true
              ? `for entry in ${floor.placement === "literal" ? value : host} {\n`
              : "";
          const source = `${named ? "let parcel = hostValue\n" : ""}${head}${body}\n${floor.loop === true ? "}\n" : ""}exit`;
          out.push({
            name: [
              floor.carrier,
              floor.placement,
              endpoint,
              named ? "named" : "inline",
              later ? "later" : "no-later",
            ].join("/"),
            source,
            expected: owed(floor, endpoint, named, later, source),
          });
        }
  return out;
}

/**
 * A shape's compared records in both orders, sorted, the two orders equal: its written-target warnings
 * (`D class start:end context`), and its `copy-type` checks and a destination's own null-checks (`B` a boundary, `C` a
 * check: `kind target [against] start:end`). A member's receiver checks (C5) and an iterable's (C13) are not C1's,
 * C9's or C10's.
 */
function records(source: string): string[] {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const of = (record: CompactRecord): string[] =>
    [
      ...record.diagnostics
        .filter((diagnostic) => diagnostic.kind === "written-target")
        .map(
          (diagnostic) =>
            `D ${diagnostic.class} ${diagnostic.site.offset}:${diagnostic.site.end} ${diagnostic.context}`,
        ),
      ...record.checks
        .filter(
          (check) =>
            check.kind === "copy-type" ||
            (check.kind === "null-check" && /^(out|entry)(\.|$)/u.test(check.target)),
        )
        .map(
          (check) =>
            `${check.boundary ? "B" : "C"} ${check.kind} ${check.target} [${check.against.join("|")}] ` +
            `${check.site.offset}:${check.site.end}`,
        ),
    ].sort();
  const forward = of(compactAnalysis(request));
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => of(compactAnalysis(request)),
    ),
  );
  assert.deepEqual(reversed, forward, `${source}: both orders`);
  return forward;
}

test("the carrier floor's complete C1, C9 and C10 records are what the rule function owes, in both orders (§6, §5.1, r4.60, r4.63–r4.66)", (t) => {
  const all = shapes();
  assert.equal(all.length, 184);
  assert.equal(new Set(all.map((shape) => shape.name)).size, 184);
  const wrong: string[] = [];
  for (const shape of all) {
    const actual = records(shape.source);
    if (JSON.stringify(actual) !== JSON.stringify(shape.expected))
      wrong.push(
        `${shape.name}: ${JSON.stringify(actual)}, the rule owes ${JSON.stringify(shape.expected)}`,
      );
  }
  t.diagnostic(
    `${all.length} shapes in ${new Set(all.map((shape) => shape.name.split("/").slice(0, 3).join("/"))).size} ` +
      "classes compared exactly",
  );
  assert.deepEqual(wrong, [], wrong.join("\n"));
});
