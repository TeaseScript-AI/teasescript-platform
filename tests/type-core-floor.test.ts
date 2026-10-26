import assert from "node:assert/strict";
import test from "node:test";

import { withLandingIndex } from "../src/type-inference/core/admission.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import type { CompactRecord } from "./helpers/type-core-records.js";

/*
 * The carrier floor (S6-CARRIERS revision 5, §6): Astra's independent 184 shapes of round 4 (`matrix/REPORT.md`,
 * `comparison.md`), transcribed as their 46 placement and endpoint classes, each named and inline, without and with a
 * later store, in both orders. Each shape's complete multiset of C1, C9 and C10 records (§5.1: every `copy-type` check,
 * a destination's own null-check, and their written-target warnings with their context words) is compared exactly with
 * the rule function, §5.1's table with TABLE r4.60 and r4.63–r4.65:
 * - inline whole data owes one store boundary at the host value's own span, against the type admitted there, and C1
 *   beside it at that span unless its place is published (r4.63 (1)); reached through a projection of the carrier's
 *   result, it is a member of the data;
 * - named data owes its source's own boundary, `parcel [unknown]` at its ingress, and C1 at the named read where the
 *   place is published, else at the store's value span below a selecting operation and at the named read below a
 *   combining or removing one (r4.63 (2));
 * - a member of host data owes C1 at the member read in any state (r4.60);
 * - a `get`'s or an `otherwise`'s default owes its own read's `[unknown]` boundary, the destination's C1 at the store's
 *   value span, and C10's family check only where the direct value has a family (r4.63 (3), r4.65 (1));
 * - a `load`'s or `fromJson`'s typed default owes no own read; the call is the ingress, its boundary against the
 *   destination, with C1 beside it where the place is decided elsewhere;
 * - a loop variable owes the boundary against its own contract and C1 beside it (r4.63 (4)); a loop over host data
 *   owes one boundary, at the host value, of the ingress landing on the loop variable (r4.64, r4.65 (2)).
 * A place's state is S4's decision, taken as given: published by its one store, decided by the later store, or, for a
 * collection's element, decided at the declaration where the carrier passes the decision on (A2 with F7, F10, F17b).
 * Until §9 step 4's cutover, the shapes run under the landing index, the mechanism the cutover adopts.
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

/**
 * The shapes whose records differ from the rule function at this head, each with its records exactly as the head
 * gives them, which §9 step 4 repairs; the list must be empty at the pull request's head.
 */
const UNTIL_CUTOVER: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  // r4.60: a member of host data owes the destination's C1 at the member read
  [
    "copy/whole receiver/collection/inline/later",
    [
      "B copy-type out [list] 19:28",
      "C copy-type out [list] 19:28",
      "C copy-type out.element [integer] 19:28",
      "D warning-runtime-check 19:28 later",
      "D warning-runtime-check 19:28 later",
    ],
  ],
  [
    "copy/whole receiver/collection/inline/no-later",
    [
      "B copy-type out [list] 19:28",
      "C copy-type out [list] 19:28",
      "C copy-type out.element [integer] 19:28",
      "D warning-runtime-check 19:28 unknown",
      "D warning-runtime-check 19:28 unknown",
    ],
  ],
  [
    "copy/whole receiver/collection/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [list] 33:61",
      "C copy-type out.element [integer] 33:61",
      "D warning-runtime-check 33:61 later",
      "D warning-runtime-check 33:61 later",
    ],
  ],
  [
    "copy/whole receiver/collection/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [list] 42:48",
      "C copy-type out.element [integer] 42:48",
      "D warning-runtime-check 42:48 unknown",
      "D warning-runtime-check 42:48 unknown",
    ],
  ],
  [
    "copy/whole receiver/scalar/inline/later",
    [
      "B copy-type out [integer] 17:26",
      "C copy-type out [integer] 17:26",
      "D warning-runtime-check 17:26 later",
    ],
  ],
  [
    "copy/whole receiver/scalar/inline/no-later",
    [
      "B copy-type out [integer] 17:26",
      "C copy-type out [integer] 17:26",
      "D warning-runtime-check 17:26 unknown",
    ],
  ],
  [
    "copy/whole receiver/scalar/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 33:59",
      "D warning-runtime-check 33:59 later",
    ],
  ],
  [
    "copy/whole receiver/scalar/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 40:46",
      "D warning-runtime-check 40:46 unknown",
    ],
  ],
  [
    "get/unknown receiver/collection/inline/later",
    [
      "B copy-type out [list] 16:25",
      "C copy-type out [list] 16:25",
      "C copy-type out.element [integer] 16:25",
      "D warning-runtime-check 16:25 later",
      "D warning-runtime-check 16:25 unknown",
    ],
  ],
  [
    "get/unknown receiver/collection/inline/no-later",
    [
      "B copy-type out [list] 16:25",
      "C copy-type out [list] 16:25",
      "C copy-type out.element [integer] 16:25",
      "D warning-runtime-check 16:25 unknown",
      "D warning-runtime-check 16:25 unknown",
    ],
  ],
  [
    "get/unknown receiver/collection/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [list] 33:70",
      "C copy-type out.element [integer] 33:70",
      "D warning-runtime-check 33:70 later",
      "D warning-runtime-check 33:70 unknown",
    ],
  ],
  [
    "get/unknown receiver/collection/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [list] 39:45",
      "C copy-type out.element [integer] 33:70",
      "D warning-runtime-check 33:70 unknown",
      "D warning-runtime-check 39:45 unknown",
    ],
  ],
  [
    "get/unknown receiver/scalar/inline/later",
    [
      "B copy-type out [integer] 14:23",
      "C copy-type out [integer] 14:23",
      "D warning-runtime-check 14:23 later",
    ],
  ],
  [
    "get/unknown receiver/scalar/inline/no-later",
    [
      "B copy-type out [integer] 14:23",
      "C copy-type out [integer] 14:23",
      "D warning-runtime-check 14:23 unknown",
    ],
  ],
  [
    "get/unknown receiver/scalar/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 33:66",
      "D warning-runtime-check 33:66 later",
    ],
  ],
  [
    "get/unknown receiver/scalar/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 37:43",
      "D warning-runtime-check 37:43 unknown",
    ],
  ],
  [
    "projection/unknown receiver/collection/inline/later",
    [
      "B copy-type out [list] 16:25",
      "C copy-type out [list] 16:25",
      "C copy-type out.element [integer] 16:25",
      "D warning-runtime-check 16:25 later",
      "D warning-runtime-check 16:25 unknown",
    ],
  ],
  [
    "projection/unknown receiver/collection/inline/no-later",
    [
      "B copy-type out [list] 16:25",
      "C copy-type out [list] 16:31",
      "C copy-type out.element [integer] 16:25",
      "D warning-runtime-check 16:25 unknown",
      "D warning-runtime-check 16:31 unknown",
    ],
  ],
  [
    "projection/unknown receiver/collection/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [list] 33:55",
      "C copy-type out.element [integer] 33:55",
      "D warning-runtime-check 33:55 later",
      "D warning-runtime-check 33:55 unknown",
    ],
  ],
  [
    "projection/unknown receiver/collection/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [list] 39:51",
      "C copy-type out.element [integer] 33:55",
      "D warning-runtime-check 33:55 unknown",
      "D warning-runtime-check 39:51 unknown",
    ],
  ],
  [
    "projection/unknown receiver/scalar/inline/later",
    [
      "B copy-type out [integer] 14:23",
      "C copy-type out [integer] 14:23",
      "D warning-runtime-check 14:23 later",
    ],
  ],
  [
    "projection/unknown receiver/scalar/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 33:53",
      "D warning-runtime-check 33:53 later",
    ],
  ],
  [
    "removal/whole receiver/collection/inline/later",
    [
      "B copy-type out [list] 16:25",
      "C copy-type out [list] 16:25",
      "C copy-type out.element [integer] 16:25",
      "D warning-runtime-check 16:25 later",
      "D warning-runtime-check 16:25 unknown",
    ],
  ],
  [
    "removal/whole receiver/collection/inline/no-later",
    [
      "B copy-type out [list] 16:25",
      "C copy-type out [list] 16:25",
      "C copy-type out.element [integer] 16:25",
      "D warning-runtime-check 16:25 unknown",
      "D warning-runtime-check 16:25 unknown",
    ],
  ],
  [
    "removal/whole receiver/collection/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [list] 33:61",
      "C copy-type out.element [integer] 33:61",
      "D warning-runtime-check 33:61 later",
      "D warning-runtime-check 33:61 unknown",
    ],
  ],
  [
    "removal/whole receiver/collection/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [list] 39:45",
      "C copy-type out.element [integer] 33:61",
      "D warning-runtime-check 33:61 unknown",
      "D warning-runtime-check 39:45 unknown",
    ],
  ],
  [
    "removal/whole receiver/scalar/inline/later",
    [
      "B copy-type out [integer] 14:23",
      "C copy-type out [integer] 14:23",
      "D warning-runtime-check 14:23 later",
    ],
  ],
  [
    "removal/whole receiver/scalar/inline/no-later",
    [
      "B copy-type out [integer] 14:23",
      "C copy-type out [integer] 14:23",
      "D warning-runtime-check 14:23 unknown",
    ],
  ],
  [
    "removal/whole receiver/scalar/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 33:59",
      "D warning-runtime-check 33:59 later",
    ],
  ],
  [
    "removal/whole receiver/scalar/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 37:43",
      "D warning-runtime-check 37:43 unknown",
    ],
  ],
  // r4.63 (3): an own default's destination C1 at the store's value span
  [
    "get/whole default/collection/inline/no-later",
    [
      "B copy-type hostValue [unknown] 33:42",
      "C copy-type [hostValue].element [integer|number] 32:43",
      "C copy-type out.element [integer] 33:42",
      "D warning-runtime-check 32:43 unknown",
      "D warning-runtime-check 33:42 unknown",
    ],
  ],
  [
    "get/whole default/collection/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type [parcel].element [integer|number] 55:63",
      "C copy-type out.element [integer] 56:62",
      "D warning-runtime-check 55:63 unknown",
      "D warning-runtime-check 56:62 unknown",
    ],
  ],
  [
    "get/whole default/scalar/inline/no-later",
    [
      "B copy-type hostValue [unknown] 30:39",
      "C copy-type hostValue [integer|number] 30:39",
      "C copy-type out [integer] 30:39",
      "D warning-runtime-check 30:39 unknown",
      "D warning-runtime-check 30:39 unknown",
    ],
  ],
  [
    "get/whole default/scalar/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 53:59",
      "C copy-type parcel [integer|number] 53:59",
      "D warning-runtime-check 53:59 unknown",
      "D warning-runtime-check 53:59 unknown",
    ],
  ],
  [
    "otherwise/whole fallback/scalar/inline/no-later",
    [
      "B copy-type hostValue [unknown] 30:39",
      "C copy-type out [integer] 30:39",
      "D warning-runtime-check 30:39 unknown",
    ],
  ],
  [
    "otherwise/whole fallback/scalar/named/no-later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 53:59",
      "D warning-runtime-check 53:59 unknown",
    ],
  ],
  // r4.63 (4), r4.64, r4.65 (2): a loop variable's boundary against its own contract, one ingress landing on it
  [
    "iteration/literal/collection/inline/later",
    [
      "B copy-type entry.element [integer] 20:29",
      "B copy-type entry.element [unknown] 13:31",
      "B copy-type out.element [unknown] 44:49",
      "C copy-type entry.element [integer] 20:29",
      "C copy-type out.element [integer] 44:49",
      "D warning-runtime-check 20:29 unknown",
      "D warning-runtime-check 44:49 later",
    ],
  ],
  [
    "iteration/literal/collection/inline/no-later",
    [
      "B copy-type entry.element [integer] 20:29",
      "B copy-type entry.element [unknown] 13:31",
      "C copy-type entry.element [integer] 20:29",
      "D warning-runtime-check 20:29 unknown",
    ],
  ],
  [
    "iteration/literal/scalar/inline/later",
    [
      "B copy-type entry [integer] 17:26",
      "B copy-type entry [unknown] 17:26",
      "B copy-type out [unknown] 40:45",
      "C copy-type entry [integer] 17:26",
      "C copy-type out [integer] 40:45",
      "D warning-runtime-check 17:26 unknown",
      "D warning-runtime-check 40:45 later",
    ],
  ],
  [
    "iteration/literal/scalar/inline/no-later",
    [
      "B copy-type entry [integer] 17:26",
      "B copy-type entry [unknown] 17:26",
      "C copy-type entry [integer] 17:26",
      "D warning-runtime-check 17:26 unknown",
    ],
  ],
  [
    "iteration/whole operand/collection/inline/later",
    [
      "B copy-type hostValue [unknown] 13:22",
      "B copy-type out [unknown] 35:50",
      "B copy-type out.element [unknown] 35:50",
      "C copy-type out [list] 35:50",
      "C copy-type out.element [integer] 35:50",
      "D warning-runtime-check 35:50 later",
      "D warning-runtime-check 35:50 unknown",
    ],
  ],
  [
    "iteration/whole operand/collection/inline/no-later",
    [
      "B copy-type hostValue [unknown] 13:22",
      "B copy-type out [unknown] 41:46",
      "B copy-type out.element [unknown] 35:50",
      "C copy-type out [list] 41:46",
      "C copy-type out.element [integer] 35:50",
      "D warning-runtime-check 35:50 unknown",
      "D warning-runtime-check 41:46 unknown",
    ],
  ],
  [
    "iteration/whole operand/scalar/inline/later",
    [
      "B copy-type hostValue [unknown] 13:22",
      "B copy-type out [unknown] 35:48",
      "C copy-type out [integer] 35:48",
      "D warning-runtime-check 35:48 later",
    ],
  ],
  [
    "iteration/whole operand/scalar/inline/no-later",
    [
      "B copy-type hostValue [unknown] 13:22",
      "B copy-type out [unknown] 39:44",
      "C copy-type out [integer] 39:44",
      "D warning-runtime-check 39:44 unknown",
    ],
  ],
  // r4.63 (3): a typed default owes no own read beside the call's boundary
  [
    "load default/whole default/collection/inline/later",
    [
      "B copy-type hostValue [unknown] 41:50",
      "B copy-type out [list] 16:52",
      "C copy-type out.element [integer] 16:52",
      "D warning-runtime-check 16:52 unknown",
    ],
  ],
  [
    "load default/whole default/collection/inline/no-later",
    [
      "B copy-type hostValue [unknown] 41:50",
      "B copy-type out [list] 16:52",
      "C copy-type out.element [integer] 16:52",
      "D warning-runtime-check 16:52 unknown",
    ],
  ],
  [
    "load default/whole default/collection/named/later",
    [
      "B copy-type out [list] 39:72",
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out.element [integer] 39:72",
      "D warning-runtime-check 39:72 unknown",
    ],
  ],
  [
    "load default/whole default/collection/named/no-later",
    [
      "B copy-type out [list] 39:72",
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out.element [integer] 39:72",
      "D warning-runtime-check 39:72 unknown",
    ],
  ],
  [
    "load default/whole default/scalar/inline/later",
    [
      "B copy-type hostValue [unknown] 38:47",
      "B copy-type out [integer] 14:48",
      "C copy-type out [integer] 14:48",
      "D warning-runtime-check 14:48 later",
    ],
  ],
  [
    "load default/whole default/scalar/named/later",
    [
      "B copy-type out [integer] 37:68",
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 37:68",
      "D warning-runtime-check 37:68 later",
    ],
  ],
  [
    "parse default/whole default/collection/inline/later",
    [
      "B copy-type hostValue [unknown] 45:54",
      "B copy-type out [list] 16:56",
      "C copy-type out.element [integer] 16:56",
      "D warning-runtime-check 16:56 unknown",
    ],
  ],
  [
    "parse default/whole default/collection/inline/no-later",
    [
      "B copy-type hostValue [unknown] 45:54",
      "B copy-type out [list] 16:56",
      "C copy-type out.element [integer] 16:56",
      "D warning-runtime-check 16:56 unknown",
    ],
  ],
  [
    "parse default/whole default/collection/named/later",
    [
      "B copy-type out [list] 39:76",
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out.element [integer] 39:76",
      "D warning-runtime-check 39:76 unknown",
    ],
  ],
  [
    "parse default/whole default/collection/named/no-later",
    [
      "B copy-type out [list] 39:76",
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out.element [integer] 39:76",
      "D warning-runtime-check 39:76 unknown",
    ],
  ],
  [
    "parse default/whole default/scalar/inline/later",
    [
      "B copy-type hostValue [unknown] 42:51",
      "B copy-type out [integer] 14:52",
      "C copy-type out [integer] 14:52",
      "D warning-runtime-check 14:52 later",
    ],
  ],
  [
    "parse default/whole default/scalar/named/later",
    [
      "B copy-type out [integer] 37:72",
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 37:72",
      "D warning-runtime-check 37:72 later",
    ],
  ],
  // r4.63 (2): named data below a removing or combining operation owes C1 at the named read
  [
    "concatenation/literal operand/collection/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out.element [integer] 33:56",
      "D warning-runtime-check 33:56 later",
    ],
  ],
  [
    "concatenation/literal operand/scalar/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 33:52",
      "D warning-runtime-check 33:52 later",
    ],
  ],
  [
    "removal/literal receiver/collection/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out.element [integer] 33:60",
      "D warning-runtime-check 33:60 later",
    ],
  ],
  [
    "removal/literal receiver/scalar/named/later",
    [
      "B copy-type parcel [unknown] 13:22",
      "C copy-type out [integer] 33:56",
      "D warning-runtime-check 33:56 later",
    ],
  ],
  // the rule function's reading, held for the lead: C1 beside a typed call's boundary where a later store decides a collection's element
  ["load default/literal default/collection/inline/later", ["B copy-type out [list] 10:56"]],
  ["load default/literal default/collection/named/later", ["B copy-type out [list] 33:76"]],
  ["parse default/literal default/collection/inline/later", ["B copy-type out [list] 10:60"]],
  ["parse default/literal default/collection/named/later", ["B copy-type out [list] 33:80"]],
]);

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

/** The records `floor`'s shape owes by the rule function (§5.1 with TABLE r4.60, r4.63–r4.65), sorted. */
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
      if (state !== "published") c1(target, kind, call, state);
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
  const forward = withLandingIndex(() => of(compactAnalysis(request)));
  const reversed = withLandingIndex(() =>
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => of(compactAnalysis(request)),
      ),
    ),
  );
  assert.deepEqual(reversed, forward, `${source}: both orders`);
  return forward;
}

test("the carrier floor's complete C1, C9 and C10 records are what the rule function owes, in both orders (§6, §5.1, r4.60, r4.63–r4.65)", (t) => {
  const all = shapes();
  assert.equal(all.length, 184);
  assert.equal(new Set(all.map((shape) => shape.name)).size, 184);
  const wrong: string[] = [];
  let deferred = 0;
  for (const shape of all) {
    const actual = records(shape.source);
    const until = UNTIL_CUTOVER.get(shape.name);
    if (until !== undefined) {
      deferred += 1;
      // (a deferred shape gives exactly its listed records, and still not the rule's)
      if (JSON.stringify(actual) !== JSON.stringify([...until].sort()))
        wrong.push(
          `${shape.name}: deferred as ${JSON.stringify(until)}, got ${JSON.stringify(actual)}`,
        );
      else if (JSON.stringify(actual) === JSON.stringify(shape.expected))
        wrong.push(`${shape.name}: deferred, yet as the rule owes`);
      continue;
    }
    if (JSON.stringify(actual) !== JSON.stringify(shape.expected))
      wrong.push(
        `[${JSON.stringify(shape.name)}, ${JSON.stringify(actual)}], // expected ${JSON.stringify(shape.expected)}`,
      );
  }
  t.diagnostic(
    `${all.length} shapes in ${new Set(all.map((shape) => shape.name.split("/").slice(0, 3).join("/"))).size} ` +
      `classes compared exactly; ${deferred} deferred to the cutover`,
  );
  assert.deepEqual(wrong, [], wrong.join("\n"));
});
