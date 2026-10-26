import assert from "node:assert/strict";

import { withConsumerOrder } from "../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./type-core-analysis.js";
import type { CompactRecord } from "./type-core-records.js";

/*
 * The rule function of the carrier tests (S6-CARRIERS revision 5, §5.1, §6): the floor's 46 classes and the role
 * matrix's are placement and endpoint classes, each shape named and inline, without and with a later store, compared in
 * both orders. Each shape's complete multiset of C1, C9 and C10 records (§5.1: every `copy-type` check, a destination's
 * own null-check, and their written-target warnings with their context words) is compared exactly with what this rule
 * function owes, §5.1's table with TABLE r4.60 and r4.63–r4.66:
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

export type Endpoint = "scalar" | "collection";

/** Where the data stands (§5.1's rows). */
export type Data =
  "cell" | "whole" | "through" | "member" | "own" | "typed" | "loop-cell" | "loop-operand";

export interface RuleClass {
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
  /** The operation's own read's text (a fallback, a default), for `k`, the data `v` and `h` (C10, F18). */
  readonly own?: (k: string, v: string, h: string) => string;
  /** The loop's head, where the data reaches `out` through a loop variable: `for entry in …`. */
  readonly loop?: true;
  /** A loop's iterable where it is no literal: the host value or its name `h` by default, else this text of it. */
  readonly iterable?: (h: string) => string;
  /** The kind the known element gives (`text` for the selected-text choices). */
  readonly kind?: "string";
}

export const BOTH: readonly Endpoint[] = ["scalar", "collection"];
export const SCALAR: readonly Endpoint[] = ["scalar"];

export interface Shape {
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
  floor: RuleClass,
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
  // the operation the data is carried through, and its own read: a literal default types its call (r4.66 (2))
  const operation = floor.carrier.split("/")[0];
  const known = floor.kind === "string" ? '"fixed"' : collection ? "[1]" : "1";
  const ownText = floor.own?.(known, collection ? `[${host}]` : host, host) ?? "";
  const literal = ownText.startsWith("[");
  const c1 = (target: string, against: string, site: string, state: State): void => {
    out.push(`C copy-type ${target} [${against}] ${site}`);
    out.push(`D warning-runtime-check ${site} ${state === "later" ? "later" : "unknown"}`);
  };
  // each destination path's state: the place itself published by its one store or decided by the later one; a
  // collection's element decided at the declaration where the carrier passes the decision on (a typed default's literal
  // does not: F18 decides the list, its element open beside host data, TABLE r4.66 (3) with A7)
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
      // (an own read that is no literal gives the collection's own kind beside its elements: unknown there too)
      if (collection && !literal) c1("out", "list", value, whole);
      if (operation === "get") {
        // C10: the default fits the family of the `get`'s direct value, at the default's own expression (a collection's
        // elements, a default that is no literal its whole kind)
        const at = spanOf(source, ownText, first);
        out.push(
          collection && !literal
            ? `C copy-type ${ownText} [list] ${at}`
            : `C copy-type ${collection ? `${ownText}.element` : ownText} [integer|number] ${at}`,
          `D warning-runtime-check ${at} unknown`,
        );
      }
      break;
    }
    case "typed": {
      const call = callSpan(
        source,
        source.indexOf(operation === "load default" ? "load(" : "fromJson("),
      );
      out.push(`B copy-type out [${collection ? "list" : kind}] ${call}`);
      // r4.66 (2): a default types its call where its kinds are definite, a literal's; a host value's own read stays an
      // own read; named data owes its source's boundary wherever the loaded value meets a consumer, and a default that
      // reads a member of the data is itself that consumer (C5, r4.66 (1)), whatever the place's state
      const data = named ? "parcel" : "hostValue";
      const reads = ownText.includes(".");
      if (reads) out.push(`B copy-type ${data} [unknown] ${ingress}`);
      const [target, state] = collection ? ["out.element", element] : ["out", whole];
      if (state === "published") break;
      // (a consumer meets the loaded value: the destination's check beside the call's boundary; a default that is no
      // literal leaves the collection's own kind open too)
      c1(target, kind, call, state);
      if (collection && !literal && whole !== "published") c1("out", "list", call, whole);
      if (!reads && (named || !literal)) out.push(`B copy-type ${data} [unknown] ${ingress}`);
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

/** Each class's shapes: each endpoint, named and inline, without and with a later store, with what the rule owes. */
export function shapesOf(classes: readonly RuleClass[]): Shape[] {
  const out: Shape[] = [];
  for (const floor of classes)
    for (const endpoint of floor.endpoints)
      for (const named of [false, true])
        for (const later of [false, true]) {
          const host = named ? "parcel" : "hostValue";
          const known = floor.kind === "string" ? '"fixed"' : endpoint === "scalar" ? "1" : "[1]";
          const data = endpoint === "scalar" ? host : `[${host}]`;
          const value = floor.form(known, data, host);
          // (a loop over a literal holding the data reads its variable; over the host data, a carrier reads it)
          const cells = floor.data === "loop-cell";
          const body = `let out = ${floor.loop === true && cells ? "entry" : value}\n${later ? `out = ${known}\n` : ""}say "AFTER"`;
          const head =
            floor.loop === true
              ? `for entry in ${cells ? value : (floor.iterable?.(host) ?? host)} {\n`
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
export function records(source: string): string[] {
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
