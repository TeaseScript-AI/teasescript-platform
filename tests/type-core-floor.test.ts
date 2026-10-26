import assert from "node:assert/strict";
import test from "node:test";

import { withLandingIndex } from "../src/type-inference/core/admission.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import type { CompactCheck } from "./helpers/type-core-records.js";

/*
 * The carrier floor (S6-CARRIERS revision 5, §6): Astra's independent 184 shapes of round 4 (`matrix/REPORT.md`,
 * `comparison.md`), transcribed as their 46 placement and endpoint classes, each named and inline, without and with a
 * later store, in both orders. Each shape's C9 records, and the C1 and C10 records of every place but the destination
 * `out` (an own read's family check, a loop variable's check), are compared exactly with the rule function (§3.3,
 * §5.1, TABLE r4.63):
 * - inline host data owes one store boundary at the host value's own span, its target the store's place with the
 *   contribution path up to the first object property step, against the type admitted there;
 * - named data owes its source's own boundary, `parcel [unknown]` at its ingress, and no store boundary;
 * - a `get`'s or an `otherwise`'s default owes C10's family check at the default and its own read's `[unknown]`
 *   boundary; a `load`'s or `fromJson`'s typed default neither, the boundary at the call validating the loaded value;
 * - a loop variable owes the boundary against its own contract, C1 beside it, and `[unknown]` only where it has no
 *   other contract (a loop over external data).
 */

type Endpoint = "scalar" | "collection";

interface FloorClass {
  readonly carrier: string;
  readonly placement: string;
  /** The declaration's value for a known element `k` and the data `v` (`h` the host read or its name alone). */
  readonly form: (k: string, v: string, h: string) => string;
  readonly endpoints: readonly Endpoint[];
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
  },
  {
    carrier: "projection",
    placement: "unknown receiver",
    form: (k, _, h) => `[${k}, ${h}.field][1]`,
    endpoints: BOTH,
  },
  {
    carrier: "iteration",
    placement: "literal",
    form: (k, v) => `[${k}, ${v}]`,
    endpoints: BOTH,
    loop: true,
  },
  {
    carrier: "otherwise",
    placement: "direct literal",
    form: (k, v) => `([${k}, ${v}][1] otherwise ${k})`,
    endpoints: BOTH,
  },
  {
    carrier: "otherwise",
    placement: "whole fallback",
    form: (k, v) => `[${k}, (null otherwise ${v})][1]`,
    endpoints: BOTH,
  },
  {
    carrier: "get",
    placement: "literal receiver",
    form: (k, v) => `[${k}, ${v}].get(1, default: ${k})`,
    endpoints: BOTH,
  },
  {
    carrier: "get",
    placement: "whole default",
    form: (k, v) => `[${k}].get(7, default: ${v})`,
    endpoints: BOTH,
  },
  {
    carrier: "get",
    placement: "unknown receiver",
    form: (k, _, h) => `[${k}, ${h}.get(0, default: ${k})][1]`,
    endpoints: BOTH,
  },
  {
    carrier: "load default",
    placement: "literal default",
    form: (k, v) => `load("parcel", default: [${k}, ${v}][1])`,
    endpoints: BOTH,
  },
  {
    carrier: "load default",
    placement: "whole default",
    form: (k, v) => `[${k}, load("parcel", default: ${v})][1]`,
    endpoints: BOTH,
  },
  {
    carrier: "parse default",
    placement: "literal default",
    form: (k, v) => `fromJson("broken", default: [${k}, ${v}][1])`,
    endpoints: BOTH,
  },
  {
    carrier: "parse default",
    placement: "whole default",
    form: (k, v) => `[${k}, fromJson("broken", default: ${v})][1]`,
    endpoints: BOTH,
  },
  {
    carrier: "copy",
    placement: "literal receiver",
    form: (k, v) => `[${k}, ${v}].takeLast(1)[0]`,
    endpoints: BOTH,
  },
  {
    carrier: "copy",
    placement: "whole receiver",
    form: (k, _, h) => `([${k}] + ${h}.toList())[1]`,
    endpoints: BOTH,
  },
  {
    carrier: "removal",
    placement: "literal receiver",
    form: (k, v) => `[${k}, ${v}].removeAt(1)`,
    endpoints: BOTH,
  },
  {
    carrier: "removal",
    placement: "whole receiver",
    form: (k, _, h) => `[${k}, ${h}.removeAt(0)][1]`,
    endpoints: BOTH,
  },
  {
    carrier: "concatenation",
    placement: "literal operand",
    form: (k, v) => `([${k}] + [${v}])[1]`,
    endpoints: BOTH,
  },
  {
    carrier: "concatenation",
    placement: "whole operand",
    form: (k, _, h) => `([${k}] + ${h})[1]`,
    endpoints: BOTH,
  },
  {
    carrier: "choice",
    placement: "literal option",
    form: (k, v) => `askChoice [${k}, ${v}]`,
    endpoints: SCALAR,
  },
  {
    carrier: "choice",
    placement: "whole option",
    form: (k, v) => `askChoice ${k}, ${v}`,
    endpoints: SCALAR,
  },
  {
    carrier: "choice",
    placement: "selected value",
    form: (k, v) => `askChoice {text: "known", value: ${k}}, {text: "host", value: ${v}}`,
    endpoints: SCALAR,
  },
  // the edges the independent pass added after comparing with the maintained matrix (`additional-edges.mjs`)
  {
    carrier: "iteration",
    placement: "whole operand",
    form: (k) => `[${k}, entry][1]`,
    endpoints: BOTH,
    loop: true,
  },
  {
    carrier: "otherwise",
    placement: "whole operand",
    form: (k, _, h) => `${h} otherwise ${k}`,
    endpoints: BOTH,
  },
  // F25's selected-text edges (`additional-choice.mjs`)
  {
    carrier: "choice",
    placement: "direct selected text",
    form: (_, __, h) => `askChoice {text:"fixed"}, {text:${h}}`,
    endpoints: SCALAR,
    kind: "string",
  },
  {
    carrier: "choice",
    placement: "list selected text",
    form: (_, __, h) => `askChoice [{text:"fixed"}, {text:${h}}]`,
    endpoints: SCALAR,
    kind: "string",
  },
  {
    carrier: "choice",
    placement: "derived selected text",
    form: (_, __, h) => `askChoice dict{left:{text:"fixed"}, right:{text:${h}}}.values`,
    endpoints: SCALAR,
    kind: "string",
  },
];

/**
 * The shapes whose records differ from the rule at this head, which §9 step 4's cutover repairs: the round-4 review's
 * witnesses (B-M2's boundaries at a carrier's span instead of the host value's, B-M1's missing selected-text
 * boundaries), and r4.63's (an `otherwise` default without its family check, a typed default's own read, a loop
 * variable's boundary against `[unknown]` or at the collection). The list must be empty at the pull request's head.
 */
const UNTIL_CUTOVER: ReadonlySet<string> = new Set([
  "copy/whole receiver/scalar/inline/no-later",
  "copy/whole receiver/scalar/inline/later",
  "copy/whole receiver/collection/inline/no-later",
  "copy/whole receiver/collection/inline/later",
  "concatenation/whole operand/scalar/inline/no-later",
  "concatenation/whole operand/scalar/inline/later",
  "concatenation/whole operand/collection/inline/no-later",
  "concatenation/whole operand/collection/inline/later",
  "choice/whole option/scalar/inline/no-later",
  "choice/whole option/scalar/inline/later",
  "otherwise/whole operand/scalar/inline/no-later",
  "otherwise/whole operand/scalar/inline/later",
  "otherwise/whole operand/collection/inline/no-later",
  "otherwise/whole operand/collection/inline/later",
  "choice/list selected text/scalar/inline/no-later",
  "choice/derived selected text/scalar/inline/no-later",
  // r4.63 (3): an `otherwise` default's C10 family check
  "otherwise/whole fallback/collection/inline/later",
  "otherwise/whole fallback/collection/inline/no-later",
  "otherwise/whole fallback/collection/named/later",
  "otherwise/whole fallback/collection/named/no-later",
  "otherwise/whole fallback/scalar/inline/later",
  "otherwise/whole fallback/scalar/inline/no-later",
  "otherwise/whole fallback/scalar/named/later",
  "otherwise/whole fallback/scalar/named/no-later",
  // r4.63 (3): a typed default owes no own read beside the call's boundary
  "load default/whole default/collection/inline/later",
  "load default/whole default/collection/inline/no-later",
  "load default/whole default/collection/named/later",
  "load default/whole default/collection/named/no-later",
  "load default/whole default/scalar/inline/later",
  "load default/whole default/scalar/named/later",
  "parse default/whole default/collection/inline/later",
  "parse default/whole default/collection/inline/no-later",
  "parse default/whole default/collection/named/later",
  "parse default/whole default/collection/named/no-later",
  "parse default/whole default/scalar/inline/later",
  "parse default/whole default/scalar/named/later",
  // r4.63 (4): a loop variable's boundary against its own contract, at the host value
  "iteration/literal/collection/inline/later",
  "iteration/literal/collection/inline/no-later",
  "iteration/literal/scalar/inline/later",
  "iteration/literal/scalar/inline/no-later",
  "iteration/whole operand/collection/inline/later",
  "iteration/whole operand/collection/inline/no-later",
  "iteration/whole operand/scalar/inline/later",
  "iteration/whole operand/scalar/inline/no-later",
]);

interface Shape {
  readonly name: string;
  readonly source: string;
  /** The records the rule function owes, each `B` (a boundary) or `C` (a check), `target [against] start:end`. */
  readonly expected: readonly string[];
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

/** The records `floor`'s shape owes by the rule function (§3.3, §5.1, TABLE r4.63). */
function owed(floor: FloorClass, endpoint: Endpoint, named: boolean, source: string): string[] {
  const at = (start: number, length: number): string => `${start}:${start + length}`;
  const ingress = source.indexOf("hostValue");
  const ing = at(ingress, "hostValue".length);
  const host = named ? "parcel" : "hostValue";
  const read = named ? source.indexOf("parcel", source.indexOf("\n")) : ingress;
  const kind = floor.kind ?? "integer";
  const place = `${floor.carrier}/${floor.placement}`;
  const own = `B ${host} [unknown] ${ing}`;
  if (place === "get/whole default" || place === "otherwise/whole fallback")
    return [
      own,
      endpoint === "scalar"
        ? `C ${host} [integer|number] ${at(read, host.length)}`
        : `C [${host}].element [integer|number] ${at(read - 1, host.length + 2)}`,
    ];
  if (floor.carrier === "load default" || floor.carrier === "parse default") {
    const call = source.indexOf(floor.carrier === "load default" ? "load(" : "fromJson(");
    return [`B out [${endpoint === "scalar" ? "integer" : "list"}] ${callSpan(source, call)}`];
  }
  if (place === "iteration/literal") {
    const target = endpoint === "scalar" ? "entry" : "entry.element";
    const collection = source.indexOf("[", source.indexOf("for entry in"));
    const end = source.indexOf(" {", collection);
    return named
      ? [
          own,
          `C ${target} [integer] ${endpoint === "scalar" ? at(read, host.length) : `${collection}:${end}`}`,
        ]
      : [`B ${target} [integer] ${ing}`, `C ${target} [integer] ${ing}`];
  }
  if (place === "iteration/whole operand") return named ? [own] : [`B entry [unknown] ${ing}`];
  if (named) return [own];
  if (endpoint === "scalar") return [`B out [${kind}] ${ing}`];
  // (a collection's host data stands in a literal's cell, at the element, or whole, at the list itself)
  return [
    source.slice(0, ingress).trimEnd().endsWith("[")
      ? `B out.element [integer] ${ing}`
      : `B out [list] ${ing}`,
  ];
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
            expected: owed(floor, endpoint, named, source),
          });
        }
  return out;
}

/**
 * A shape's compared records in both orders: its C9 boundaries, and its `copy-type` checks of any place but `out`, each
 * `B` or `C`, `target [against] start:end`, sorted; the two orders equal.
 */
function records(source: string): string[] {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const of = (checks: readonly CompactCheck[]): string[] =>
    checks
      .filter(
        (check) =>
          check.boundary ||
          (check.kind === "copy-type" &&
            check.target !== "out" &&
            !check.target.startsWith("out.")),
      )
      .map(
        (check) =>
          `${check.boundary ? "B" : "C"} ${check.target} [${check.against.join("|")}] ` +
          `${check.site.offset}:${check.site.end}`,
      )
      .sort();
  const forward = of(compactAnalysis(request).checks);
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => of(compactAnalysis(request).checks),
    ),
  );
  assert.deepEqual(reversed, forward, `${source}: both orders`);
  return forward;
}

/** The shapes whose compared records differ from the rule function's, each with what it owes and what it gives. */
function differing(all: readonly Shape[]): string[] {
  const out: string[] = [];
  for (const shape of all) {
    const actual = records(shape.source);
    if (JSON.stringify(actual) !== JSON.stringify([...shape.expected].sort()))
      out.push(
        `${shape.name}: expected ${shape.expected.join(", ")}, got ${actual.join(", ") || "none"}`,
      );
  }
  return out;
}

/** The review witnesses among the cutover's shapes (B-M2, B-M1): the landing index's own placement repairs them. */
const WITNESSES: ReadonlySet<string> = new Set(
  [...UNTIL_CUTOVER].filter(
    (name) =>
      !name.startsWith("otherwise/whole fallback/") &&
      !name.startsWith("load default/") &&
      !name.startsWith("parse default/") &&
      !name.startsWith("iteration/"),
  ),
);

test("the carrier floor's records are exactly what the rule function owes, in both orders (§6, §5.1, r4.63)", (t) => {
  const all = shapes();
  assert.equal(all.length, 184);
  assert.equal(new Set(all.map((shape) => shape.name)).size, 184);
  const found = differing(all);
  t.diagnostic(
    `${all.length} shapes in ${new Set(all.map((shape) => shape.name.split("/").slice(0, 3).join("/"))).size} ` +
      `classes compared exactly; ${found.length} differ until the cutover`,
  );
  assert.deepEqual(
    found.map((entry) => entry.split(":")[0]).sort(),
    [...UNTIL_CUTOVER].sort(),
    found.join("\n"),
  );
});

/**
 * S6-CARRIERS §9 step 3: the landing index beside the ingress index, until the cutover. With C9's placement and
 * resolution from the landing index, the round-4 witnesses are repaired (each boundary at its host value's span, the
 * selected-text boundaries there), and only r4.63's shapes still differ.
 */
test("the landing index repairs the floor's round-4 witnesses, in both orders (§3.2–§3.4)", () => {
  assert.equal(WITNESSES.size, 16);
  const found = withLandingIndex(() => differing(shapes()));
  assert.deepEqual(
    found.map((entry) => entry.split(":")[0]).sort(),
    [...UNTIL_CUTOVER].filter((name) => !WITNESSES.has(name)).sort(),
    found.join("\n"),
  );
});
