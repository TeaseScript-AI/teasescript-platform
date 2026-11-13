// The narrowing index's events (N2) and preserving stores (N5): what ends a narrowing, and a deep path's events
// (#1640).

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { WorkLedger } from "../../../src/type-inference/core/budget.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import {
  FLAG,
  NULLABLE,
  pass,
  at,
  type Case,
  check,
  REPEAT,
} from "../../helpers/type-core/type-core-narrowing-setup.js";

const WIPE = "function wipe { n = null\n return true }";

test("N2's events: a mutator, a helper holding one, a block holding one, never another narrowing", () => {
  const xs = "let xs = [1, null]";
  const read = "repeat xs[0]";
  check(
    [
      ["held", [xs, "if xs[0] != null { repeat xs[0] {} }"], read, 7, "non-null: holds"],
      ...[
        "add(2)",
        "addAll([2])",
        "clear()",
        "removeFirst()",
        "removeLast()",
        "reverse()",
        "sort()",
        "shuffle()",
      ].map((call): Case => [
        call,
        [xs, `if xs[0] != null { xs.${call}\n repeat xs[0] {} }`],
        read,
        7,
        // (a reordering invalidates the element read, `member`; an add or a removal stores the key, `branch`: #1073
        // PR 4's U5, as the fixture's `invalidation/*/changed` records name them)
        ["reverse()", "sort()", "shuffle()"].includes(call)
          ? "non-null: member"
          : "non-null: branch",
      ]),
      [
        "helper",
        [xs, "function flip { xs.reverse() }", "if xs[0] != null { flip()\n repeat xs[0] {} }"],
        read,
        7,
        "non-null: call",
      ],
      [
        "helper of a helper",
        [
          xs,
          "function flip { xs.reverse() }",
          "function relay { flip() }",
          "if xs[0] != null { relay()\n repeat xs[0] {} }",
        ],
        read,
        7,
        "non-null: call",
      ],
      [
        "block, registered before",
        [xs, "timer async 1 s { xs.reverse() }", "if xs[0] != null { repeat xs[0] {} }"],
        read,
        7,
        "non-null: handler",
      ],
      [
        "a helper only a block runs: the block's, not a call's",
        [
          xs,
          "function flip { xs.reverse() }",
          "function other { say 1 }",
          "timer async 1 s { flip() }",
          "if xs[0] != null { other()\n repeat xs[0] {} }",
        ],
        read,
        7,
        "non-null: handler",
      ],
      [
        "another narrowing",
        [xs, "let m = 1", "if xs[0] != null { if m != null { repeat xs[0] {} } }"],
        read,
        7,
        "non-null: holds",
      ],
    ],
    at,
  );
});

const ORDINARY_KEY_EVENTS: readonly Case[] = [
  [
    "store",
    [...NULLABLE, "if n != null { if flagHost { n = null }\n repeat n {} }"],
    REPEAT,
    7,
    "non-null: branch",
  ],
  [
    "a preserving store (N5)",
    [...NULLABLE, "if n != null { if flagHost { n = 2 }\n repeat n {} }"],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "call",
    [...NULLABLE, "function reset { n = null }", "if n != null { reset()\n repeat n {} }"],
    REPEAT,
    7,
    "non-null: call",
  ],
  [
    "a call later in the condition (B1)",
    [...NULLABLE, WIPE, "if n != null and wipe() { repeat n {} }"],
    REPEAT,
    7,
    "non-null: call",
  ],
  [
    "control: no call",
    [...NULLABLE, WIPE, "if n != null and flagHost { repeat n {} }"],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "control: the call before the test",
    [...NULLABLE, WIPE, "if wipe() and n != null { repeat n {} }"],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "an `or`'s false outcome",
    [...NULLABLE, WIPE, 'if n == null or wipe() { say "x" } else { repeat n {} }'],
    REPEAT,
    7,
    "non-null: call",
  ],
  [
    "control: `or`, no call",
    [...NULLABLE, WIPE, 'if n == null or flagHost { say "x" } else { repeat n {} }'],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "control: `or`, the call before the test",
    [...NULLABLE, WIPE, 'if wipe() or n == null { say "x" } else { repeat n {} }'],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "after a leaving branch",
    [...NULLABLE, WIPE, "if n == null or wipe() { exit }", REPEAT],
    REPEAT,
    7,
    "non-null: call",
  ],
  [
    "control: leaving, no call",
    [...NULLABLE, WIPE, "if n == null or flagHost { exit }", REPEAT],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "control: leaving, the call before the test",
    [...NULLABLE, WIPE, "if wipe() or n == null { exit }", REPEAT],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "a `while` condition",
    [...NULLABLE, WIPE, "while n != null and wipe() { repeat n {}\n break }"],
    REPEAT,
    7,
    "non-null: call",
  ],
  [
    "control: `while`, no call",
    [...NULLABLE, WIPE, "while n != null and flagHost { repeat n {}\n break }"],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "control: `while`, the call before",
    [...NULLABLE, WIPE, "while wipe() and n != null { repeat n {}\n break }"],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "a type test, a fraction stored later in the condition",
    [
      "let n: number = 2",
      "function halve { n = 0.5\n return true }",
      "if n is integer and halve() { repeat n {} }",
    ],
    REPEAT,
    7,
    "is integer: call",
  ],
  [
    "control: the type test, no call",
    [
      FLAG,
      "let n: number = 2",
      "function halve { n = 0.5\n return true }",
      "if n is integer and flagHost { repeat n {} }",
    ],
    REPEAT,
    7,
    "is integer: holds",
  ],
  [
    "control: the type test, the call before",
    [
      "let n: number = 2",
      "function halve { n = 0.5\n return true }",
      "if halve() and n is integer { repeat n {} }",
    ],
    REPEAT,
    7,
    "is integer: holds",
  ],
  [
    "call, no owner outside",
    [...NULLABLE, "function other { say 1 }", "if n != null { other()\n repeat n {} }"],
    REPEAT,
    7,
    "non-null: holds",
  ],
  [
    "label",
    [...NULLABLE, "if n == null { exit }", "label again", REPEAT, "if flagHost { goto again }"],
    REPEAT,
    7,
    "non-null: label",
  ],
  [
    "function body",
    [...NULLABLE, "if n != null { say 1 }", "function show { repeat n {} }", "show()"],
    REPEAT,
    7,
    "none",
  ],
];

test("N2's events of ordinary keys: a store, a call where another callable stores, a label a goto enters", () => {
  check(ORDINARY_KEY_EVENTS, at);
});

test("N5: a preserving store to the location itself is no event in a loop; any other store is", () => {
  const loop = (name: string, body: string, expected: string): Case => [
    name,
    [...NULLABLE, body],
    REPEAT,
    7,
    expected,
  ];
  const xs = ["let xs = [1, null]", "let i = 0"];
  check(
    [
      loop(
        "before, held",
        "if n != null { repeat 2 { n = n + 1\n repeat n {} } }",
        "non-null: holds",
      ),
      loop(
        "before, changed",
        "if n != null { repeat 2 { if flagHost { n = null }\n repeat n {} } }",
        "non-null: loop",
      ),
      loop(
        "after, held",
        "if n != null { repeat 2 { repeat n {}\n n = n + 1 } }",
        "non-null: holds",
      ),
      loop(
        "after, changed",
        "if n != null { repeat 2 { repeat n {}\n n = null } }",
        "non-null: loop",
      ),
      loop(
        "continue, held",
        "if n != null { repeat 2 { if flagHost { n = n + 1\n continue }\n repeat n {} } }",
        "non-null: holds",
      ),
      loop(
        "nested, held",
        "if n != null { repeat 2 { repeat 2 { n = n + 1 }\n repeat n {} } }",
        "non-null: holds",
      ),
      loop(
        "nested, changed",
        "if n != null { repeat 2 { repeat 2 { n = null }\n repeat n {} } }",
        "non-null: loop",
      ),
      loop("no store", "if n != null { repeat 2 { repeat n {} } }", "non-null: holds"),
      loop(
        "save",
        'if n != null { repeat 2 { save null as "n"\n repeat n {} } }',
        "non-null: holds",
      ),
      [
        "`n / 2` breaks `is integer`",
        ["let n: number | string = 2", "if n is integer { repeat 2 { repeat n {}\n n = n / 2 } }"],
        REPEAT,
        7,
        "is integer: loop",
      ],
      [
        "`n / 2` keeps `!= null`",
        [
          FLAG,
          "let n: number? = 2.5",
          "if flagHost { n = null }",
          "if n != null { repeat 2 { say n\n n = n / 2 } }",
        ],
        "say n",
        4,
        "non-null: holds",
      ],
      [
        "another path of the key",
        [...xs, "if xs[i] != null { repeat 2 { repeat xs[i] {}\n xs[0] = 1 } }"],
        "repeat xs[i]",
        7,
        "non-null: loop",
      ],
      [
        "the location's own store",
        [...xs, "if xs[i] != null { repeat 2 { repeat xs[i] {}\n xs[i] = 1 } }"],
        "repeat xs[i]",
        7,
        "non-null: holds",
      ],
      [
        "an index variable",
        [...xs, "if xs[i] != null { repeat 2 { repeat xs[i] {}\n i = i + 1 } }"],
        "repeat xs[i]",
        7,
        "non-null: loop",
      ],
    ],
    at,
  );
});

test("N5 evaluates a long preserving store without deepening the native stack", () => {
  // 2,048 terms: a recursive evaluation overflowed Node's default stack here (Sol r1)
  const long = pass(
    'let n: number? = load("n", default: null)',
    `if n != null { repeat 2 { say n\n n = n${" + 1".repeat(2_048)} } }`,
  );
  assert.equal(at(long, "say n", 4), "non-null: holds");
});

/** `at` with the solver's worklist reversed, its pass made under the seam (a solver reads it as it is made). */
function atReversed(lines: readonly string[], marker: string, delta: number): string {
  return withSolverSeam({ reverseWorklist: true }, () => at(pass(...lines), marker, delta));
}

test("N5's component: stores that read one another, through copies too, preserve together in either order", () => {
  const loop = (body: readonly string[]): readonly string[] => [
    FLAG,
    "let v = 1",
    "let w = 1",
    "if flagHost { v = null\n w = null }",
    'if v != null { if w != null { while askBoolean "More?" {',
    ...body,
    "repeat v {}",
    "} } }",
  ];
  const cases: Case[] = [
    // the expectation set's indirect pair: the copy reads the tested location, the store reads the copy
    ["through a copy, held", loop(["let c = v", "v = c + 1"]), "repeat v", 7, "non-null: holds"],
    [
      "through a copy, `otherwise null` keeps its fallback (F17a)",
      loop(["let c = v", "v = c otherwise null"]),
      "repeat v",
      7,
      "non-null: loop",
    ],
    // the expectation set's component pair: two locations, each store reading the other
    ["two locations, held", loop(["v = w", "w = v"]), "repeat v", 7, "non-null: holds"],
    ["two locations, broken", loop(["v = w", "w = null"]), "repeat v", 7, "non-null: loop"],
    [
      "a store reading the other's copy, broken by it",
      loop(["let c = w", "w = null", "v = c"]),
      "repeat v",
      7,
      "non-null: loop",
    ],
  ];
  check(cases, at);
  for (const [name, lines, marker, delta, expected] of cases)
    assert.equal(atReversed(lines, marker, delta), expected, `${name}, reversed`);
});

test("a deep path's events are its prefixes' and collections' that hold one, wherever they stand (#1640)", () => {
  const rows = ["let rows = [[[1, null]]]", "let other = [1]"];
  const test = (body: string): string[] => [
    ...rows,
    `if rows[0][0][1] != null { ${body}\n repeat rows[0][0][1] {} }`,
  ];
  const lists = "let m: integer?[][] = [[1]]";
  check(
    [
      ["held", test("say 1"), "repeat rows[0][0][1]", 7, "non-null: holds"],
      ["another collection", test("other.reverse()"), "repeat rows[0][0][1]", 7, "non-null: holds"],
      [
        "the innermost collection",
        test("rows[0][0].reverse()"),
        "repeat rows[0][0][1]",
        7,
        "non-null: member",
      ],
      [
        "a middle collection",
        test("rows[0].reverse()"),
        "repeat rows[0][0][1]",
        7,
        "non-null: member",
      ],
      [
        "a middle prefix's store",
        test("rows[0] = [[null]]"),
        "repeat rows[0][0][1]",
        7,
        "non-null: branch",
      ],
      [
        "a mutated prefix that is no collection of the path (a property step below it)",
        [
          "let rows = [{xs: [1, null]}, [3]]",
          "if rows[0].xs[0] != null { rows[1].reverse()\n repeat rows[0].xs[0] {} }",
        ],
        "repeat rows[0].xs[0]",
        7,
        "non-null: holds",
      ],
      [
        "a quoted property's collection",
        [
          "let box = {element: [[1, null]]}",
          "if box.element[0][0] != null { box.element[0].reverse()\n repeat box.element[0][0] {} }",
        ],
        "repeat box.element[0][0]",
        7,
        "non-null: member",
      ],
      [
        "a collection below a variable index",
        [
          "let rows = [[1, null]]",
          "let i = 0",
          "if rows[i][0] != null { rows[i].reverse()\n repeat rows[i][0] {} }",
        ],
        "repeat rows[i][0]",
        7,
        "non-null: member",
      ],
      [
        "a collection below a fixed key",
        [
          'let d = dict {"a": [1, null]}',
          'if d["a"][0] != null { d["a"].reverse()\n repeat d["a"][0] {} }',
        ],
        'repeat d["a"][0]',
        7,
        "non-null: member",
      ],
      [
        "a collection mutated in a later operand: that operand's read",
        [
          "let rows = [[1, null]]",
          "if rows[0][0] != null and rows.reverse() == null and rows[0][0] > 0 { repeat rows[0][0] {} }",
        ],
        "rows[0][0] > 0",
        0,
        "non-null: member",
      ],
      [
        "a collection mutated in a later operand: the body's read",
        [
          "let rows = [[1, null]]",
          "if rows[0][0] != null and rows.reverse() == null and rows[0][0] > 0 { repeat rows[0][0] {} }",
        ],
        "repeat rows[0][0]",
        7,
        "non-null: member",
      ],
      [
        "a positive collection test's element step",
        [lists, "if m is integer[][] { m[0].reverse()\n repeat m[0][0] {} }"],
        "repeat m[0][0]",
        7,
        "is integer element: member",
      ],
    ],
    at,
  );
});

test("a deep path's narrowing makes no text per prefix: its events' kept text grows with the path, not its square (#1640)", () => {
  // (#1770's family: a k-deep chain of selections under its own null test, read once below it)
  const chain = (k: number): string =>
    Array.from({ length: k }, (_, i) => (i % 2 === 0 ? ".first" : ".last")).join("");
  const nested = (k: number, leaf: string): string => `${"[".repeat(k)}${leaf}${"]".repeat(k)}`;
  const source = (k: number): string =>
    [
      'let choice = askBoolean "change?"',
      `let rows = ${nested(k, "1")}`,
      `if choice { rows = ${nested(k, "null")} }`,
      `if rows${chain(k)} != null { let sink: integer = rows${chain(k)} }`,
      "exit",
    ].join("\n");
  const charge = WorkLedger.prototype.charge;
  let units = 0;
  WorkLedger.prototype.charge = function (this: WorkLedger, ...args) {
    if (args[0] === "literalUnits" && /narrowing\/(narrowings|events)\.js/.test(new Error().stack!))
      units += args[1] ?? 1;
    charge.apply(this, args);
  };
  const kept = (k: number): number => {
    units = 0;
    analyseCore(coreRequest([{ path: "main.tease", source: source(k) }])!);
    return units;
  };
  try {
    const [small, large] = [kept(64), kept(128)];
    assert.ok(large <= 2.25 * small, `${small} at 64, ${large} at 128`);
  } finally {
    WorkLedger.prototype.charge = charge;
  }
});
