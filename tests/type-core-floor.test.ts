import assert from "node:assert/strict";
import test from "node:test";

import { roleClasses } from "./helpers/type-core-roles.js";
import { BOTH, records, SCALAR, shapesOf, type RuleClass } from "./helpers/type-core-rule.js";

/*
 * The carrier floor (S6-CARRIERS revision 5, §6): Astra's independent 184 shapes of round 4 (`matrix/REPORT.md`,
 * `comparison.md`), transcribed as their 46 placement and endpoint classes, each named and inline, without and with a
 * later store. Its purpose is the enumeration, independent of the carrier table the role matrix is generated from: each
 * of these shapes owes its complete C1, C9 and C10 records, exactly as the rule function
 * (`tests/helpers/type-core-rule.ts`) derives them, in both orders, so a carrier or placement the table lacks or loses
 * still fails here. A shape the role matrix holds as it is (the same source owing the same records) is compared by the
 * role test, once in the suite; this test compares the rest.
 */

const CLASSES: readonly RuleClass[] = [
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
    own: (_, v) => v,
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
    own: (_, v) => v,
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
    own: (k, v) => `[${k}, ${v}][1]`,
  },
  {
    carrier: "load default",
    placement: "whole default",
    form: (k, v) => `[${k}, load("parcel", default: ${v})][1]`,
    endpoints: BOTH,
    data: "typed",
    own: (_, v) => v,
    declares: true,
  },
  {
    carrier: "parse default",
    placement: "literal default",
    form: (k, v) => `fromJson("broken", default: [${k}, ${v}][1])`,
    endpoints: BOTH,
    data: "typed",
    own: (k, v) => `[${k}, ${v}][1]`,
  },
  {
    carrier: "parse default",
    placement: "whole default",
    form: (k, v) => `[${k}, fromJson("broken", default: ${v})][1]`,
    endpoints: BOTH,
    data: "typed",
    own: (_, v) => v,
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
    form: (_, __, h) => `askChoice {text: "fixed"}, {text: ${h}}`,
    endpoints: SCALAR,
    data: "cell",
    kind: "string",
  },
  {
    carrier: "choice",
    placement: "list selected text",
    form: (_, __, h) => `askChoice [{text: "fixed"}, {text: ${h}}]`,
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

test("the carrier floor's complete C1, C9 and C10 records are what the rule function owes, in both orders (§6, §5.1, r4.60, r4.63–r4.66)", (t) => {
  const all = shapesOf(CLASSES);
  assert.equal(all.length, 184);
  assert.equal(new Set(all.map((shape) => shape.name)).size, 184);
  // (the role test compares each of its shapes exactly; a role-table change that drops or alters one the floor shares
  // leaves that shape's comparison here)
  const roles = new Map(
    shapesOf(roleClasses().classes).map((shape) => [shape.source, JSON.stringify(shape.expected)]),
  );
  const wrong: string[] = [];
  let shared = 0;
  for (const shape of all) {
    const expected = JSON.stringify(shape.expected);
    if (roles.get(shape.source) === expected) {
      shared += 1;
      continue;
    }
    const actual = JSON.stringify(records(shape.source));
    if (actual !== expected) wrong.push(`${shape.name}: ${actual}, the rule owes ${expected}`);
  }
  t.diagnostic(
    `${all.length} shapes in ${new Set(all.map((shape) => shape.name.split("/").slice(0, 3).join("/"))).size} ` +
      `classes compared exactly, ${shared} of them by the role test (the same source owing the same records)`,
  );
  assert.deepEqual(wrong, [], wrong.join("\n"));
});
