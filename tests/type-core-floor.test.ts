import assert from "node:assert/strict";
import test from "node:test";

import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import type { CompactCheck } from "./helpers/type-core-records.js";

/*
 * The carrier floor (S6-CARRIERS revision 5, §6): Astra's independent 184 shapes of round 4 (`matrix/REPORT.md`,
 * `comparison.md`), transcribed as their 46 placement and endpoint classes, each named and inline, without and with a
 * later store, in both orders. Each shape's C9 records are compared exactly with the boundaries §3.3's rule places:
 * - inline host data owes one store boundary at the host value's own span, its target the store's place with the
 *   contribution path up to the first object property step, against the type admitted there;
 * - named data owes its source's own boundary, `parcel [unknown]` at its ingress, and no store boundary.
 * The classes whose data stands in an operation's own read (a `get`'s or `otherwise`'s default, a `load`'s or
 * `fromJson`'s), and the loop variable's, are held: §5.1's rows for them are the lead's open question, so they are only
 * run in both orders here.
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

/** The classes whose data stands in an operation's own read, or reaches `out` through a loop variable. */
const HELD: ReadonlySet<string> = new Set([
  "otherwise/whole fallback",
  "get/whole default",
  "load default/literal default",
  "load default/whole default",
  "parse default/literal default",
  "parse default/whole default",
  "iteration/literal",
  "iteration/whole operand",
]);

/**
 * The shapes whose C9 records differ from the rule at this head: the round-4 review's witnesses (B-M2's boundaries at a
 * carrier's span instead of the host value's, B-M1's missing selected-text boundaries), which §9 step 4's cutover
 * repairs. The list must be empty at the pull request's head.
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
]);

interface Shape {
  readonly name: string;
  readonly held: boolean;
  readonly source: string;
  /** The C9 records §3.3's rule places, each `target [against] start:end`. */
  readonly expected: readonly string[];
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
          const ingress = source.indexOf("hostValue");
          const span = `${ingress}:${ingress + "hostValue".length}`;
          const kind = floor.kind ?? "integer";
          // (a collection's host data stands in a literal's cell, at the element, or whole, at the list itself)
          const inCell = source.slice(0, ingress).trimEnd().endsWith("[");
          const expected = named
            ? [`parcel [unknown] ${span}`]
            : endpoint === "scalar"
              ? [`out [${kind}] ${span}`]
              : [inCell ? `out.element [integer] ${span}` : `out [list] ${span}`];
          out.push({
            name: [
              floor.carrier,
              floor.placement,
              endpoint,
              named ? "named" : "inline",
              later ? "later" : "no-later",
            ].join("/"),
            held: HELD.has(`${floor.carrier}/${floor.placement}`),
            source,
            expected,
          });
        }
  return out;
}

/** A shape's C9 records in both orders: each `target [against] start:end`, sorted; the two orders equal. */
function boundaries(source: string): string[] {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const of = (checks: readonly CompactCheck[]): string[] =>
    checks
      .filter((check) => check.boundary)
      .map(
        (check) =>
          `${check.target} [${check.against.join("|")}] ${check.site.offset}:${check.site.end}`,
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

test("the carrier floor's C9 records are exactly the boundaries §3.3 places, in both orders (§6)", (t) => {
  const all = shapes();
  assert.equal(all.length, 184);
  assert.equal(new Set(all.map((shape) => shape.name)).size, 184);
  const differing: string[] = [];
  let compared = 0;
  for (const shape of all) {
    const actual = boundaries(shape.source);
    if (shape.held) continue;
    compared += 1;
    if (JSON.stringify(actual) !== JSON.stringify([...shape.expected].sort()))
      differing.push(
        `${shape.name}: expected ${shape.expected.join(", ")}, got ${actual.join(", ") || "none"}`,
      );
  }
  t.diagnostic(
    `${all.length} shapes in ${new Set(all.map((shape) => shape.name.split("/").slice(0, 3).join("/"))).size} classes: ` +
      `${compared} compared exactly, ` +
      `${all.length - compared} held (own reads and loop variables); ${differing.length} differ until the cutover`,
  );
  assert.equal(compared, 120);
  assert.deepEqual(
    differing.map((entry) => entry.split(":")[0]).sort(),
    [...UNTIL_CUTOVER].sort(),
    differing.join("\n"),
  );
});
