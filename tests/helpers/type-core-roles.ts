import { CARRIER_ROLES, type CarrierRole } from "../../src/type-inference/core/carriers.js";
import { BOTH, SCALAR, type RuleClass } from "./type-core-rule.js";

/*
 * The role matrix's table and compositions (S6-CARRIERS revision 5, §6): per role of the carrier table
 * (`CARRIER_ROLES`) its four placements of the data, each a class of the rule function (`type-core-rule.ts`) or why it
 * has none, and the compositions as exact records. The role test compares them; the sharing differential runs them.
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

export const ROLES: Readonly<Record<CarrierRole, Readonly<Record<Placement, Row | string>>>> = {
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
  // (a dict list's name read on an object: its own property, r4.46 (2))
  "projection/record field": {
    "literal operand": {
      form: (k, v) => `[${k}, ({noise: 0, values: [${k}, ${v}][1]}).values][1]`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "whole operand": {
      form: (k, v) => `[${k}, ({noise: 0, values: ${v}}).values][1]`,
      endpoints: BOTH,
      data: "cell",
      declares: true,
    },
    "own read": NOT_OWN,
    "member receiver": {
      form: (k, _, h) => `[${k}, ({noise: 0, keys: ${h}.field}).keys][1]`,
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
/** The role matrix's classes, one per role and placement that has a shape, and the placements without one, with why. */
export function roleClasses(): { readonly classes: RuleClass[]; readonly none: string[] } {
  const classes: RuleClass[] = [];
  const none: string[] = [];
  for (const role of CARRIER_ROLES)
    for (const placement of PLACEMENTS) {
      const row = ROLES[role][placement];
      if (typeof row === "string") none.push(`${role} (${placement}): ${row}`);
      else classes.push({ carrier: role, placement, ...row });
    }
  return { classes, none };
}

/** The role matrix's compositions (S6-CARRIERS §6), each a name, its program before its final `exit` and its record. */
export const COMPOSITIONS: readonly (readonly [string, string, string])[] = (() => {
  const choice = (options: string): string => `let out = askChoice ${options}\nsay "AFTER"\n`;
  const boundary = (against: string, span: string): string =>
    `outcome valid\nB copy-type out [${against}] ${span}`;
  return [
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
      "inline data beside an own read's named data (Codex r23 N1)",
      'let raw = hostValue\nlet out = hostValue otherwise [raw]\nout = [1]\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 30:39 later
      D written-target warning 30:55 later
      C copy-type out [list] 30:39
      C copy-type out.element [integer] 30:55
      B copy-type raw [unknown] 10:19
      B copy-type out [list] 30:39`,
    ],
    [
      "a host member beside an own read's named data (TABLE r4.70 (1))",
      'let raw = hostValue\nlet out = hostValue.field otherwise [raw]\nout = [1]\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 30:45 later
      D written-target warning 30:61 later
      D member-read warning 30:39 unknown
      C copy-type out [list] 30:45
      C copy-type out.element [integer] 30:61
      C null-check hostValue [non-null] 30:39
      B copy-type raw [unknown] 10:19
      B copy-type out [list] 30:39`,
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
})();
