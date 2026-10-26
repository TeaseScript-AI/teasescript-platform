import assert from "node:assert/strict";
import test from "node:test";

import { CARRIER_ROLES, type CarrierRole } from "../src/type-inference/core/carriers.js";
import { BOTH, records, SCALAR, shapesOf, type RuleClass } from "./helpers/type-core-rule.js";

/*
 * The role matrix (S6-CARRIERS revision 5, §6), beside the floor: generated from the carrier table's roles
 * (`CARRIER_ROLES`), each with its four placements of the data: inside a literal operand, the whole operand, the
 * operation's own read, a member's receiver. Each placement is a class of the rule function (`type-core-rule.ts`), its
 * shapes each named and inline, without and with a later store, compared exactly in both orders; a placement a role
 * cannot have names why. A role the table gains without its row fails here.
 */

type Placement = "literal operand" | "whole operand" | "own read" | "member receiver";

const PLACEMENTS: readonly Placement[] = [
  "literal operand",
  "whole operand",
  "own read",
  "member receiver",
];

type Row = Omit<RuleClass, "carrier" | "placement">;

/** Only an operation's own read has one (C10: a fallback's, a default's). */
const NOT_OWN = "this operand is no own read (C10)";
/** An own role's whole operand is its own read: the own-read row. */
const OWN_ROW = "the whole operand is the operation's own read: its row";
/** A button's value is never a list or a set (V30 §19, TSV029). */
const CHOICE = SCALAR;

const ROLES: Readonly<Record<CarrierRole, Readonly<Record<Placement, Row | string>>>> = {
  "projection/owner": {
    "literal operand": {
      form: (k, v) => `[${k}, ${v}][1]`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "whole operand": {
      form: (k, _, h) => `[${k}, ${h}.field][1]`,
      endpoints: BOTH,
      data: "member",
      declares: true,
      member: (h) => `${h}.field`,
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `[${k}, ${h}.inner.field][1]`,
      endpoints: BOTH,
      data: "member",
      declares: true,
      member: (h) => `${h}.inner.field`,
    },
  },
  "projection/record field": {
    "literal operand": {
      form: (k, v) => `[${k}, ({noise: 0, data: [${k}, ${v}][1]}).data][1]`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "whole operand": {
      form: (k, v) => `[${k}, ({noise: 0, data: ${v}}).data][1]`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `[${k}, ({noise: 0, data: ${h}.field}).data][1]`,
      endpoints: BOTH,
      data: "member",
      declares: true,
      member: (h) => `${h}.field`,
    },
  },
  "projection/dict values": {
    "literal operand": {
      form: (k, v) => `dict{a: ${k}, b: [${k}, ${v}][1]}.values[1]`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "whole operand": {
      form: (k, v) => `dict{a: ${k}, b: ${v}}.values[1]`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `dict{a: ${k}, b: ${h}.field}.values[1]`,
      endpoints: BOTH,
      data: "member",
      declares: true,
      member: (h) => `${h}.field`,
    },
  },
  "iteration/collection": {
    "literal operand": {
      form: (k, v) => `[${k}, ${v}]`,
      endpoints: BOTH,
      data: "loop-cell",
      loop: true,
    },
    "whole operand": {
      form: (k) => `[${k}, entry][1]`,
      endpoints: BOTH,
      data: "loop-operand",
      declares: true,
      loop: true,
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k) => `[${k}, entry][1]`,
      endpoints: BOTH,
      data: "loop-operand",
      declares: true,
      loop: true,
      iterable: (h) => `${h}.field`,
    },
  },
  "otherwise/operand": {
    "literal operand": {
      form: (k, v) => `([${k}, ${v}][1] otherwise ${k})`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "whole operand": { form: (k, _, h) => `${h} otherwise ${k}`, endpoints: BOTH, data: "whole" },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `${h}.field otherwise ${k}`,
      endpoints: BOTH,
      data: "member",
      member: (h) => `${h}.field`,
    },
  },
  "otherwise/fallback": {
    "literal operand": {
      form: (k, v) => `[${k}, (null otherwise [${k}, ${v}][1])][1]`,
      endpoints: BOTH,
      data: "own",
      declares: true,
      own: (k, v) => `[${k}, ${v}][1]`,
    },
    "whole operand": OWN_ROW,
    "own read": {
      form: (k, v) => `[${k}, (null otherwise ${v})][1]`,
      endpoints: BOTH,
      data: "own",
      declares: true,
      own: (_, v) => v,
    },
    "member receiver": {
      form: (k, _, h) => `[${k}, (null otherwise ${h}.field)][1]`,
      endpoints: BOTH,
      data: "own",
      declares: true,
      own: (_, __, h) => `${h}.field`,
    },
  },
  "get/receiver": {
    "literal operand": {
      form: (k, v) => `[${k}, ${v}].get(1, default: ${k})`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "whole operand": {
      form: (k, _, h) => `[${k}, ${h}.get(0, default: ${k})][1]`,
      endpoints: BOTH,
      data: "member",
      declares: true,
      member: (h, k) => `${h}.get(0, default: ${k})`,
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `[${k}, ${h}.field.get(0, default: ${k})][1]`,
      endpoints: BOTH,
      data: "member",
      declares: true,
      member: (h, k) => `${h}.field.get(0, default: ${k})`,
    },
  },
  "get/default": {
    "literal operand": {
      form: (k, v) => `[${k}].get(7, default: [${k}, ${v}][1])`,
      endpoints: BOTH,
      data: "own",
      declares: true,
      own: (k, v) => `[${k}, ${v}][1]`,
    },
    "whole operand": OWN_ROW,
    "own read": {
      form: (k, v) => `[${k}].get(7, default: ${v})`,
      endpoints: BOTH,
      data: "own",
      own: (_, v) => v,
    },
    "member receiver": {
      form: (k, _, h) => `[${k}].get(7, default: ${h}.field)`,
      endpoints: BOTH,
      data: "own",
      own: (_, __, h) => `${h}.field`,
    },
  },
  "load default/default": {
    "literal operand": {
      form: (k, v) => `load("parcel", default: [${k}, ${v}][1])`,
      endpoints: BOTH,
      data: "typed",
      own: (k, v) => `[${k}, ${v}][1]`,
    },
    "whole operand": OWN_ROW,
    "own read": {
      form: (k, v) => `[${k}, load("parcel", default: ${v})][1]`,
      endpoints: BOTH,
      data: "typed",
      declares: true,
      own: (_, v) => v,
    },
    "member receiver": {
      form: (k, _, h) => `[${k}, load("parcel", default: ${h}.field)][1]`,
      endpoints: BOTH,
      data: "typed",
      declares: true,
      own: (_, __, h) => `${h}.field`,
    },
  },
  "parse default/default": {
    "literal operand": {
      form: (k, v) => `fromJson("broken", default: [${k}, ${v}][1])`,
      endpoints: BOTH,
      data: "typed",
      own: (k, v) => `[${k}, ${v}][1]`,
    },
    "whole operand": OWN_ROW,
    "own read": {
      form: (k, v) => `[${k}, fromJson("broken", default: ${v})][1]`,
      endpoints: BOTH,
      data: "typed",
      declares: true,
      own: (_, v) => v,
    },
    "member receiver": {
      form: (k, _, h) => `[${k}, fromJson("broken", default: ${h}.field)][1]`,
      endpoints: BOTH,
      data: "typed",
      declares: true,
      own: (_, __, h) => `${h}.field`,
    },
  },
  "copy/receiver": {
    "literal operand": {
      form: (k, v) => `[${k}, ${v}].takeLast(1)[0]`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "whole operand": {
      form: (k, _, h) => `([${k}] + ${h}.toList())[1]`,
      endpoints: BOTH,
      data: "member",
      member: (h) => `${h}.toList()`,
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `([${k}] + ${h}.field.toList())[1]`,
      endpoints: BOTH,
      data: "member",
      member: (h) => `${h}.field.toList()`,
    },
  },
  "removal/receiver": {
    "literal operand": {
      form: (k, v) => `[${k}, ${v}].removeAt(1)`,
      endpoints: BOTH,
      data: "cell",
      combining: true,
    },
    "whole operand": {
      form: (k, _, h) => `[${k}, ${h}.removeAt(0)][1]`,
      endpoints: BOTH,
      data: "member",
      combining: true,
      declares: true,
      member: (h) => `${h}.removeAt(0)`,
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `[${k}, ${h}.field.removeAt(0)][1]`,
      endpoints: BOTH,
      data: "member",
      combining: true,
      declares: true,
      member: (h) => `${h}.field.removeAt(0)`,
    },
  },
  "concatenation/operand": {
    "literal operand": {
      form: (k, v) => `([${k}] + [${v}])[1]`,
      endpoints: BOTH,
      data: "cell",
      combining: true,
    },
    "whole operand": {
      form: (k, _, h) => `([${k}] + ${h})[1]`,
      endpoints: BOTH,
      data: "through",
      combining: true,
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `([${k}] + ${h}.field)[1]`,
      endpoints: BOTH,
      data: "member",
      combining: true,
      member: (h) => `${h}.field`,
    },
  },
  "choice/option value": {
    "literal operand": {
      form: (k, v) =>
        `askChoice {text: "known", value: ${k}}, {text: "host", value: [${k}, ${v}][1]}`,
      endpoints: CHOICE,
      data: "cell",
    },
    "whole operand": {
      form: (k, v) => `askChoice {text: "known", value: ${k}}, {text: "host", value: ${v}}`,
      endpoints: CHOICE,
      data: "cell",
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) =>
        `askChoice {text: "known", value: ${k}}, {text: "host", value: ${h}.field}`,
      endpoints: CHOICE,
      data: "member",
      member: (h) => `${h}.field`,
    },
  },
  "choice/option text": {
    "literal operand": {
      form: (k, _, h) => `askChoice {text: ${k}}, {text: [${k}, ${h}][1]}`,
      endpoints: CHOICE,
      data: "cell",
      kind: "string",
    },
    "whole operand": {
      form: (k, _, h) => `askChoice {text: ${k}}, {text: ${h}}`,
      endpoints: CHOICE,
      data: "cell",
      kind: "string",
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `askChoice {text: ${k}}, {text: ${h}.field}`,
      endpoints: CHOICE,
      data: "member",
      kind: "string",
      member: (h) => `${h}.field`,
    },
  },
  "choice/option element value": {
    "literal operand": {
      form: (k, v) =>
        `askChoice [{text: "known", value: ${k}}, {text: "host", value: [${k}, ${v}][1]}]`,
      endpoints: CHOICE,
      data: "cell",
    },
    "whole operand": {
      form: (k, v) => `askChoice [{text: "known", value: ${k}}, {text: "host", value: ${v}}]`,
      endpoints: CHOICE,
      data: "cell",
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) =>
        `askChoice [{text: "known", value: ${k}}, {text: "host", value: ${h}.field}]`,
      endpoints: CHOICE,
      data: "member",
      member: (h) => `${h}.field`,
    },
  },
  "choice/option element text": {
    "literal operand": {
      form: (k, _, h) => `askChoice [{text: ${k}}, {text: [${k}, ${h}][1]}]`,
      endpoints: CHOICE,
      data: "cell",
      kind: "string",
    },
    "whole operand": {
      form: (k, _, h) => `askChoice [{text: ${k}}, {text: ${h}}]`,
      endpoints: CHOICE,
      data: "cell",
      kind: "string",
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `askChoice [{text: ${k}}, {text: ${h}.field}]`,
      endpoints: CHOICE,
      data: "member",
      kind: "string",
      member: (h) => `${h}.field`,
    },
  },
};

/** Path discovery: a source read past the program's longest key is dropped (`#collect`), so its literal's paths go undecided. */
const CUT =
  "held for the lead: out.element is never decided, so r4.60's C1 there is not owed; with any longer key elsewhere " +
  "in the program it is (the source read past the longest key is dropped from the literal's structure)";
/** A7's whole-store exception (r4.9) below an own read, whose boundary is against `[unknown]`. */
const BELOW_OWN =
  "held for the lead: decided by the later store, the default's element C1 falls under A7's whole-store exception, " +
  "although the own read's boundary checks it against nothing; published, it is owed";

/** The shapes held for a ruling, by name, each with its reason (the step report gives them). */
const HELD: ReadonlyMap<string, string> = new Map([
  ["concatenation/operand/member receiver/collection/inline/no-later", CUT],
  ["concatenation/operand/member receiver/collection/named/no-later", CUT],
  ["copy/receiver/member receiver/collection/inline/no-later", CUT],
  ["copy/receiver/member receiver/collection/named/no-later", CUT],
  ["removal/receiver/member receiver/collection/inline/no-later", CUT],
  ["removal/receiver/member receiver/collection/named/no-later", CUT],
  ["get/receiver/member receiver/collection/inline/no-later", CUT],
  ["get/receiver/member receiver/collection/named/no-later", CUT],
  ["get/default/member receiver/collection/inline/later", BELOW_OWN],
  ["get/default/member receiver/collection/named/later", BELOW_OWN],
]);

test("every carrier role's placements owe the rule function's complete C1, C9 and C10 records, in both orders (§6, §5.1)", (t) => {
  assert.deepEqual(Object.keys(ROLES).sort(), [...CARRIER_ROLES].sort());
  const classes: RuleClass[] = [];
  const none: string[] = [];
  for (const role of CARRIER_ROLES)
    for (const placement of PLACEMENTS) {
      const row = ROLES[role][placement];
      if (typeof row === "string") none.push(`${role} (${placement}): ${row}`);
      else classes.push({ carrier: role, placement, ...row });
    }
  const all = shapesOf(classes);
  for (const name of HELD.keys())
    assert.ok(
      all.some((shape) => shape.name === name),
      `${name}: a held shape the matrix generates`,
    );
  const wrong: string[] = [];
  for (const shape of all) {
    if (HELD.has(shape.name)) continue;
    const actual = records(shape.source);
    if (JSON.stringify(actual) !== JSON.stringify(shape.expected))
      wrong.push(
        `${shape.name}: ${JSON.stringify(actual)}, the rule owes ${JSON.stringify(shape.expected)}`,
      );
  }
  t.diagnostic(
    `${all.length - HELD.size} of ${all.length} shapes in ${classes.length} role placements compared exactly, ` +
      `${HELD.size} held for the lead; no shape: ${none.join("; ")}`,
  );
  assert.deepEqual(wrong, [], wrong.join("\n"));
});
