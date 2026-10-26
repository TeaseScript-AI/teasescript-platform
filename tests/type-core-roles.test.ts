import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { CARRIER_ROLES, type CarrierRole } from "../src/type-inference/core/carriers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { derive, evaluate } from "./helpers/type-core-derived.js";
import { recordDifferences, recordOf } from "./helpers/type-core-records.js";
import {
  assignments,
  derivedStores,
  plannedStores,
  runGlobals,
} from "./helpers/type-core-route.js";
import { BOTH, records, SCALAR, shapesOf, type RuleClass } from "./helpers/type-core-rule.js";

/*
 * The role matrix (S6-CARRIERS revision 5, §6), beside the floor: generated from the carrier table's roles
 * (`CARRIER_ROLES`), each with its four placements of the data: inside a literal operand, the whole operand, the
 * operation's own read, a member's receiver. Each placement is a class of the rule function (`type-core-rule.ts`), its
 * shapes each named and inline, without and with a later store, compared exactly in both orders; a placement a role
 * cannot have names why. A role the table gains without its row fails here. A shape the candidate route takes also
 * plans the checked stores its record derives and runs as derived under every host value (§5.2, r4.59); the others
 * report the route's reason.
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
  const wrong: string[] = [];
  const outside = new Map<string, number>();
  let routed = 0;
  for (const shape of all) {
    const actual = records(shape.source);
    if (JSON.stringify(actual) !== JSON.stringify(shape.expected))
      wrong.push(
        `${shape.name}: ${JSON.stringify(actual)}, the rule owes ${JSON.stringify(shape.expected)}`,
      );
    // the plan and its runs where the candidate route takes the shape (TABLE r4.59), derived from its record
    let plan;
    try {
      plan = compileSourceWithBackend(shape.source, { globals: ["hostValue"] }, CORE_BACKEND).plan;
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      const what = error.what.replace(/^this /, "");
      outside.set(what, (outside.get(what) ?? 0) + 1);
      continue;
    }
    routed += 1;
    const request = coreRequest([{ path: "main.tease", source: shape.source }]);
    assert.ok(request !== null && plan !== null, shape.name);
    const { stores } = derive(shape.source, compactAnalysis(request));
    assert.deepEqual(
      plannedStores(plan),
      derivedStores(stores),
      `${shape.name}: the checked stores`,
    );
    for (const inputs of assignments(["hostValue"]))
      assert.deepEqual(
        runGlobals(plan, inputs),
        evaluate(shape.source, stores, inputs).run,
        `${shape.name} with ${JSON.stringify(inputs)}`,
      );
  }
  t.diagnostic(
    `${all.length} shapes in ${classes.length} role placements compared exactly, ` +
      `${routed} planned and run on the candidate route; outside the slice until ` +
      `S7–S9b (the records only): ${[...outside].map(([what, count]) => `${what} ${count}`).join(", ")}; ` +
      `no shape: ${none.join("; ")}`,
  );
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

/**
 * The role matrix's compositions (S6-CARRIERS §6), as exact records in both orders: round 4's eight choice regressions
 * (inline data a published choice selects owes the store's boundary at the host value, an unselected property none),
 * a carrier of a carrier and a carrier inside a literal inside a carrier (inline and named), inline and named data in one
 * selected collection (the named data's C1 at the selecting expression, the inline data's boundary alone: r4.63 (1), (2),
 * TABLE r4.67 (3)), a choice over a held list
 * (§3.3's record boundary beside C1), a union holding a reference across two carriers (opaque by dispatch, checked at
 * its consumer), and nullable root and inner receivers of a member (r4.60 beside each receiver's C5 check). The mixed
 * selected-value and absent-value-text lists in both element orders are the cells test's (D1).
 */
test("the role matrix's compositions give their exact records, in both orders (§6)", () => {
  const choice = (options: string): string => `let out = askChoice ${options}\nsay "AFTER"\n`;
  const boundary = (against: string, span: string): string =>
    `outcome valid\nB copy-type out [${against}] ${span}`;
  const shapes: readonly (readonly [string, string, string])[] = [
    ["choice-simple", choice("1, hostValue"), boundary("integer", "23:32")],
    ["choice-list", choice("[1, hostValue]"), boundary("integer", "24:33")],
    [
      "choice-object",
      choice('{text: "one", value: 1}, {text: "two", value: hostValue}'),
      boundary("integer", "66:75"),
    ],
    [
      "choice-object-list",
      choice('[{text: "one", value: 1}, {text: "two", value: hostValue}]'),
      boundary("integer", "67:76"),
    ],
    ["choice-text-list", choice('[{text: "one"}, {text: hostValue}]'), boundary("string", "43:52")],
    ["choice-object-extra", choice('[{text: "one", value: 1, extra: hostValue}]'), "outcome valid"],
    [
      "choice-mixed-extra",
      choice('[{text: "one", value: 1, extra: hostValue}, {text: "two", value: hostValue}]'),
      boundary("integer", "85:94"),
    ],
    [
      "choice-dict-values",
      choice('dict{a: {text: "one", value: 1}, b: {text: "two", value: hostValue}}.values'),
      boundary("integer", "77:86"),
    ],
    [
      "an otherwise of an otherwise",
      'let out = (([1, hostValue][1] otherwise 1) otherwise 1)\nsay "AFTER"\n',
      boundary("integer", "16:25"),
    ],
    [
      "a get inside a literal inside a projection",
      'let out = [[1, hostValue].get(1, default: 1)][0]\nsay "AFTER"\n',
      boundary("integer", "15:24"),
    ],
    [
      "an otherwise inside a record a projection reads",
      'let out = ({data: [1, hostValue][1] otherwise 1}).data\nsay "AFTER"\n',
      boundary("integer", "22:31"),
    ],
    [
      "named data in a get inside a literal inside a projection",
      'let raw = hostValue\nlet out = [[1, raw].get(1, default: 1)][0]\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 35:38 unknown
      C copy-type out [integer] 35:38
      B copy-type raw [unknown] 10:19`,
    ],
    [
      "inline and named data in one selected collection (TABLE r4.67 (3))",
      'let raw = hostValue\nlet out = [[1], [hostValue], [raw]][2]\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 30:58 unknown
      C copy-type out.element [integer] 30:58
      B copy-type raw [unknown] 10:19
      B copy-type out.element [integer] 37:46`,
    ],
    [
      "a choice over a held list",
      'let opts = [{text: "one", value: 1}, {text: "two", value: hostValue}]\nlet out = askChoice opts\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 58:67 unknown
      C copy-type opts.element.value [integer] 58:67
      B copy-type opts.element [object] 58:67`,
    ],
    [
      "a union holding a reference across two carriers",
      "let holder: integer[] | speaker = [1]\nlet out = [holder][0].get(0, default: 7)\nrepeat out {}\n",
      `outcome warning-runtime-check
      D member-read warning 48:59 unmodelled
      D integer-use warning 86:89 unmodelled
      C null-check [holder][0] [non-null] 48:59
      C integer-check out [integer] 86:89`,
    ],
    [
      "a member of nullable root and inner receivers",
      'let out = [1, hostValue.inner.field][1]\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 14:35 unknown
      D member-read warning 14:23 unknown
      D member-read warning 14:29 unknown
      C copy-type out [integer] 14:35
      C null-check hostValue [non-null] 14:23
      C null-check hostValue.inner [non-null] 14:29
      B copy-type out [integer] 14:23`,
    ],
  ];
  for (const [name, source, text] of shapes) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, name);
    const expected = recordOf(text);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], name);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${name} reversed`);
  }
});
