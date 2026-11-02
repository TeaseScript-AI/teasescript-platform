import assert from "node:assert/strict";
import test from "node:test";

import type { CorePass } from "../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { makeItem, REASON, type Item, type ItemTag } from "../src/type-inference/core/items.js";
import { narrowedItems, type NarrowingForm } from "../src/type-inference/core/narrowing.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { narrowingAt, narrowingPass, nodeAt, routeAt } from "./helpers/type-core-narrowing.js";
import type { CompactRecord } from "./helpers/type-core-records.js";

/*
 * Stage 3b's narrowing index (TABLE §13, S10's first part), asked directly, and the stored values that read it (S10
 * part 2b; the other consumers read it in part 2c). Per N1 form and per N2 event a control that holds and a case that
 * changes only the premise (§13.4), taken from the expectation set's 3b shapes; G's filter on items; N5's preserving and
 * breaking stores, one location and a component; N3's route witnesses for §13's own examples.
 */

const FLAG = 'let flagHost = askBoolean "flag"';
const NULLABLE = [FLAG, "let n = 1", "if flagHost { n = null }"];

interface Analysed {
  readonly pass: CorePass;
  readonly source: string;
}

function pass(...lines: readonly string[]): Analysed {
  const source = `${lines.join("\n")}\nexit\n`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, `the program parses and resolves:\n${source}`);
  return { pass: narrowingPass(request), source };
}

/** The read `delta` code units into the last occurrence of `marker` in the source. */
function read(analysed: Analysed, marker: string, delta: number) {
  const offset = analysed.source.lastIndexOf(marker);
  assert.ok(offset >= 0, `the source holds '${marker}'`);
  return nodeAt(analysed.pass, offset + delta);
}

/** N2 at a read: its narrowing's form and whether it holds or the failing word; `none` without one. */
function at(analysed: Analysed, marker: string, delta: number): string {
  const found = narrowingAt(analysed.pass, read(analysed, marker, delta));
  if (found === null) return "none";
  const form = found.g.form;
  const kinds =
    (form.kind === "is" || form.kind === "is-not") && form.kinds.length > 0
      ? ` ${form.kinds.join("|")}`
      : "";
  return `${form.kind}${kinds}${found.g.elements > 0 ? " element" : ""}: ${found.fails ?? "holds"}`;
}

type Case = readonly [string, readonly string[], string, number, string];

/** Each case's read, `delta` into the last occurrence of its marker, against its expected answer. */
function check(
  cases: readonly Case[],
  ask: (analysed: Analysed, marker: string, delta: number) => string,
): void {
  for (const [name, lines, marker, delta, expected] of cases)
    assert.equal(ask(pass(...lines), marker, delta), expected, name);
}

const REPEAT = "repeat n {}";
const WIPE = "function wipe { n = null\n return true }";

test("every N1 form defines its guarded region, and no other condition does (N1, N9)", () => {
  const forms = (
    name: string,
    body: string,
    expected: string,
    marker = REPEAT,
    delta = 7,
  ): Case => [name, [...NULLABLE, ...body.split("\n")], marker, delta, expected];
  check(
    [
      forms("!= null", "if n != null { repeat n {} }", "non-null: holds"),
      forms("is not null", "if n is not null { repeat n {} }", "non-null: holds"),
      forms("not (is null)", "if not (n is null) { repeat n {} }", "non-null: holds"),
      forms("== null, else", 'if n == null { say "nil" } else { repeat n {} }', "non-null: holds"),
      forms("is null, else", 'if n is null { say "nil" } else { repeat n {} }', "non-null: holds"),
      forms(
        "not (!= null), else",
        'if not (n != null) { say "nil" } else { repeat n {} }',
        "non-null: holds",
      ),
      forms("== null, then", 'if n == null { say n } else { say "x" }', "null: holds", "say n", 4),
      forms("is integer", "if n is integer { repeat n {} }", "is integer: holds"),
      forms(
        "is not integer, else",
        'if n is not integer { say "x" } else { repeat n {} }',
        "is integer: holds",
      ),
      forms("is not integer", "if n is not integer { say n }", "is-not integer: holds", "say n", 4),
      forms(
        "a union naming a kind twice",
        "if n is not string | string | null { say n }",
        "is-not null|string: holds",
        "say n",
        4,
      ),
      forms("while body", "while n != null { repeat n {}\n break }", "non-null: holds"),
      forms("while false exit", "while n != null { n = null }\nrepeat n {}", "none"),
      forms("and operand", 'if n != null and n > 0 { say "ready" }', "non-null: holds", "n > 0", 0),
      forms("or operand", 'if n == null or n > 0 { say "ready" }', "non-null: holds", "n > 0", 0),
      forms("and, the then arm", "if n != null and flagHost { repeat n {} }", "non-null: holds"),
      forms(
        "an and chain's last operand",
        "if n != null and flagHost and n > 0 { say 1 }",
        "non-null: holds",
        "n > 0",
        0,
      ),
      forms(
        "an or chain's false outcome",
        "if n == null or flagHost { exit }\nrepeat n {}",
        "non-null: holds",
      ),
      forms(
        "an operand, a store after the chain",
        "if n != null and n > 0 { say 1 }\nn = null",
        "non-null: holds",
        "n > 0",
        0,
      ),
      forms(
        "an operand, a call before the read",
        "function reset { n = null\n return 1 }\nif n != null and reset() > 0 and n > 0 { say 1 }",
        "non-null: call",
        "n > 0",
        0,
      ),
      forms(
        "an operand, the read an argument",
        "function reset(m) { n = null\n return m }\nif n != null and reset(n) > 0 { say 1 }",
        "non-null: holds",
        "n) > 0",
        0,
      ),
      forms(
        "an operand, a later chain test",
        "if flagHost and n != null and flagHost and n > 0 { say 1 }",
        "non-null: holds",
        "n > 0",
        0,
      ),
      forms(
        "and, the else arm",
        'if n != null and flagHost { say "x" } else { repeat n {} }',
        "none",
      ),
      forms("leaving exit", "if n == null { exit }\nrepeat n {}", "non-null: holds"),
      forms(
        "leaving goto",
        "if n == null { goto done }\nrepeat n {}\nlabel done",
        "non-null: holds",
      ),
      forms(
        "leaving break",
        "repeat 2 { if n == null { break }\n repeat n {} }",
        "non-null: holds",
      ),
      forms(
        "leaving continue",
        "repeat 2 { if n == null { continue }\n repeat n {} }",
        "non-null: holds",
      ),
      forms("not (x > 3)", "if not (n > 3) { repeat n {} }", "none"),
      forms("not (and)", "if not (n == null and flagHost) { repeat n {} }", "none"),
      [
        "leaving return",
        ["function use(n: integer?) { if n == null { return }\n repeat n {} }", "use(2)"],
        REPEAT,
        7,
        "non-null: holds",
      ],
    ],
    at,
  );
});

test("a switch case narrows by `case null` and a literal's value; other cases give none (N1)", () => {
  const whole = "let n: number | string = 8 / 4";
  check(
    [
      [
        "case 2 on 8 / 4",
        [whole, "switch n { case 2 { repeat n {} } default { say 1 } }"],
        REPEAT,
        7,
        "is integer: holds",
      ],
      [
        "case 2.0",
        [whole, "switch n { case 2.0 { repeat n {} } default { say 1 } }"],
        REPEAT,
        7,
        "is integer: holds",
      ],
      [
        "case 2.5",
        [
          "let n: integer | number | string = 2.5",
          "switch n { case 2.5 { repeat n {} } default { say 1 } }",
        ],
        REPEAT,
        7,
        "is number: holds",
      ],
      [
        'case "hi"',
        ['let n: integer | string = "hi"', 'switch n { case "hi" { say n } default { say 1 } }'],
        "say n",
        4,
        "is string: holds",
      ],
      [
        "case null",
        [...NULLABLE, "switch n { case null { say n } default { say 1 } }"],
        "say n",
        4,
        "null: holds",
      ],
      [
        "default after case null",
        [...NULLABLE, 'switch n { case null { say "nil" } default { repeat n {} } }'],
        REPEAT,
        7,
        "non-null: holds",
      ],
      [
        "case 1 after case null",
        [...NULLABLE, 'switch n { case null { say "nil" } case 1 { repeat n {} } }'],
        REPEAT,
        7,
        "is integer: holds",
      ],
      [
        "case null, 1",
        [...NULLABLE, "switch n { case null, 1 { repeat n {} } default { say 1 } }"],
        REPEAT,
        7,
        "none",
      ],
      [
        "case 1..3",
        [...NULLABLE, "switch n { case 1..3 { repeat n {} } default { say 1 } }"],
        REPEAT,
        7,
        "none",
      ],
    ],
    at,
  );
});

test("a truth value, duration, calendar duration or angle case narrows as its type's test does (N1)", () => {
  // each literal by its value (the shared case recogniser): a sign, parentheses and units change nothing
  const families: readonly (readonly [string, ...string[]])[] = [
    ["boolean", "true", "(false)"],
    ["duration", "2 s", "-500 ms", "1 d"],
    ["calendarDuration", "1 calendar day", "-2 calendar months"],
    ["angle", "90 deg", "-1 rad"],
  ];
  for (const [type, ...literals] of families) {
    const declared = `let value: ${type} | null = load("value", default: null)`;
    const tested = at(pass(declared, `if value is ${type} { say value }`), "say value", 4);
    assert.equal(tested, `is ${type}: holds`, type);
    for (const literal of literals) {
      const switched = `switch value { case ${literal} { say value } default { say 1 } }`;
      assert.equal(at(pass(declared, switched), "say value", 4), tested, literal);
    }
  }
  const truth = 'let value: boolean | null = load("value", default: null)';
  const span = 'let value: duration | null = load("value", default: null)';
  check(
    [
      [
        "a store between",
        [truth, "switch value { case true { value = null\n say value } default { say 1 } }"],
        "say value",
        4,
        "is boolean: branch",
      ],
      [
        "a call between",
        [
          span,
          "function wipe { value = null }",
          "switch value { case 2 s { wipe()\n say value } default { say 1 } }",
        ],
        "say value",
        4,
        "is duration: call",
      ],
      [
        "case true, false",
        [truth, "switch value { case true, false { say value } default { say 1 } }"],
        "say value",
        4,
        "none",
      ],
      [
        "case is boolean",
        [truth, "switch value { case is boolean { say value } default { say 1 } }"],
        "say value",
        4,
        "none",
      ],
    ],
    at,
  );
});

test("a narrowing's refined location is its stable path's text; a computed path, a call or a reference has none", () => {
  const box = [FLAG, "let box = {n: 1}", "if flagHost { box.n = null }"];
  const xs = "let xs = [1, null]";
  const d = 'let d = dict {"a": 1, "b": null}';
  check(
    [
      [
        "property, held",
        [...box, "if box.n != null { repeat box.n {} }"],
        "repeat box.n",
        7,
        "non-null: holds",
      ],
      [
        "property, changed",
        [...box, "if box.n != null { if flagHost { box.n = null }\n repeat box.n {} }"],
        "repeat box.n",
        7,
        "non-null: branch",
      ],
      [
        "prefix replaced",
        [...box, "if box.n != null { if flagHost { box = {n: null} }\n repeat box.n {} }"],
        "repeat box.n",
        7,
        "non-null: branch",
      ],
      [
        "fixed index, held",
        [xs, "if xs[0] != null { repeat xs[0] {} }"],
        "repeat xs[0]",
        7,
        "non-null: holds",
      ],
      [
        "fixed index, changed",
        [FLAG, xs, "if xs[0] != null { if flagHost { xs[0] = null }\n repeat xs[0] {} }"],
        "repeat xs[0]",
        7,
        "non-null: branch",
      ],
      [
        "variable index, held",
        [xs, "let i = 0", "if xs[i] != null { repeat xs[i] {} }"],
        "repeat xs[i]",
        7,
        "non-null: holds",
      ],
      [
        "variable index, changed",
        [FLAG, xs, "let i = 0", "if xs[i] != null { if flagHost { i = 1 }\n repeat xs[i] {} }"],
        "repeat xs[i]",
        7,
        "non-null: branch",
      ],
      ["sibling index", [xs, "if xs[0] != null { repeat xs[1] {} }"], "repeat xs[1]", 7, "none"],
      // a key's text never spells another path's steps (#1244): each path keeps its own location
      [
        "a key text spelling another path",
        [
          'let d: integer? dict dict = dict {"a": dict {"b].[string:c": null}, "a].[string:b": dict {"c": 1}}',
          'if d["a"]["b].[string:c"] == null { if d["a].[string:b"]["c"] != null { say d["a"]["b].[string:c"] } }',
        ],
        'say d["a"]',
        4,
        "null: holds",
      ],
      [
        "the same, the tests' forms swapped",
        [
          'let d: integer? dict dict = dict {"a": dict {"b].[string:c": 1}, "a].[string:b": dict {"c": null}}',
          'if d["a"]["b].[string:c"] != null { if d["a].[string:b"]["c"] == null { say d["a"]["b].[string:c"] } }',
        ],
        'say d["a"]',
        4,
        "non-null: holds",
      ],
      [
        "a key text holding every delimiter of a location",
        [
          'let d: integer? dict dict = dict {"x": dict {"y": 1}}',
          String.raw`if d["x\\\\"]["y|@*"] == null { if d["x\\].[string:y|@*"] != null { say d["x\\\\"]["y|@*"] } }`,
        ],
        "say d",
        4,
        "null: holds",
      ],
      [
        "a key text spelling a path one step deeper",
        [
          'let d: integer? dict dict dict = dict {"a": dict {"b": dict {"c": null}}}',
          'if d["a"]["b"]["c"] == null { if d["a].[string:b"]["c"] != null { say d["a"]["b"]["c"] } }',
        ],
        "say d",
        4,
        "null: holds",
      ],
      [
        "a key text spelling an element scope",
        [
          'let d: integer? dict dict = load("d", default: dict {})',
          'let k = "a"',
          'if d["a"] is integer dict { if d["a].[*"] == null { say d["a"][k + ""] } }',
        ],
        'say d["a"]',
        4,
        "is integer element: holds",
      ],
      [
        "fixed key, held",
        [d, 'if d["a"] != null { repeat d["a"] {} }'],
        'repeat d["a"]',
        7,
        "non-null: holds",
      ],
      [
        "variable key, changed",
        [
          FLAG,
          d,
          'let key = "a"',
          'if d[key] != null { if flagHost { key = "b" }\n repeat d[key] {} }',
        ],
        "repeat d[key]",
        7,
        "non-null: branch",
      ],
      [
        "computed index",
        [xs, "let i = 0", "if xs[i + 1] != null { repeat xs[i + 1] {} }"],
        "repeat xs[i + 1]",
        7,
        "none",
      ],
      [
        "random",
        [xs, "if xs.random != null { repeat xs.random {} }"],
        "repeat xs.random",
        7,
        "none",
      ],
      [
        "call",
        [
          FLAG,
          "function read { if flagHost { return null }\n return 2 }",
          "if read() != null { repeat read() {} }",
        ],
        "repeat read()",
        7,
        "none",
      ],
      [
        "reference",
        ["if player.rounds != null { repeat player.rounds {} }"],
        "repeat player.rounds",
        7,
        "none",
      ],
      [
        "through a value holding a reference (N8)",
        [
          "speaker s { rounds: 1 }",
          "let p = s",
          "if p.rounds is integer {\n s.rounds = null\n repeat p.rounds {} }",
        ],
        "repeat p.rounds",
        7,
        "is integer: unmodelled",
      ],
    ],
    at,
  );
});

test("a collection test defines its element steps; a negative one none (N1)", () => {
  const rows = ["let rows: integer?[][] = [[1], [null]]"];
  const xs = ["let xs: integer?[] = [1, null]", "let i = 0"];
  check(
    [
      [
        "the tested row",
        [...rows, "if rows[0] is integer[] { repeat rows[0][0] {}\n repeat rows[1][0] {} }"],
        "repeat rows[0][0]",
        7,
        "is integer element: holds",
      ],
      [
        "another row",
        [...rows, "if rows[0] is integer[] { repeat rows[0][0] {}\n repeat rows[1][0] {} }"],
        "repeat rows[1][0]",
        7,
        "none",
      ],
      [
        "a variable index",
        [...xs, "if xs is integer[] { repeat xs[i] {} }"],
        "repeat xs[i]",
        7,
        "is integer element: holds",
      ],
      [
        "a selection",
        [...xs, "if xs is integer[] { repeat xs.first {} }"],
        "repeat xs.first",
        7,
        "is integer element: holds",
      ],
      [
        "the root's two steps",
        [
          "let grid: integer?[][] = [[1]]",
          "let i = 0",
          "if grid is integer[][] { repeat grid[i][0] {} }",
        ],
        "repeat grid[i][0]",
        7,
        "is integer element: holds",
      ],
      // a computed or random step under a fixed or variable step or a selection reads the root's element fact (#1245)
      [
        "a computed row, then a fixed column",
        [...rows, "let i = 0", "if rows is integer[][] { repeat rows[i + 1][0] {} }"],
        "repeat rows[i",
        7,
        "is integer element: holds",
      ],
      [
        "a computed row, then a variable column",
        [...rows, "let i = 0", "if rows is integer[][] { repeat rows[i + 1][i] {} }"],
        "repeat rows[i",
        7,
        "is integer element: holds",
      ],
      [
        "a random row, then a fixed column",
        [...rows, "if rows is integer[][] { repeat rows.random[0] {} }"],
        "repeat rows.random",
        7,
        "is integer element: holds",
      ],
      [
        "a computed row, then a selection",
        [...rows, "let i = 0", "if rows is integer[][] { repeat rows[i + 1].last {} }"],
        "repeat rows[i",
        7,
        "is integer element: holds",
      ],
      [
        "below a property",
        [
          "let box = {rows: [[1], [null]]}",
          "let i = 0",
          "if box.rows is integer[][] { repeat box.rows[i + 1][0] {} }",
        ],
        "repeat box.rows[i",
        7,
        "is integer element: holds",
      ],
      [
        "a computed key, then a fixed key",
        [
          'let d: integer? dict dict = dict {"a": dict {"b": 1}}',
          'let k = "a"',
          'if d is integer dict dict { repeat d[k + ""]["b"] {} }',
        ],
        "repeat d[k",
        7,
        "is integer element: holds",
      ],
      [
        "a computed row beside a tested row",
        [...rows, "let i = 0", "if rows[0] is integer[] { repeat rows[i + 1][0] {} }"],
        "repeat rows[i",
        7,
        "none",
      ],
      [
        "negative",
        [
          ...xs,
          'if xs is not integer[] { say "x" } else { say 1 }',
          "if xs is not integer[] { repeat xs[0] {} }",
        ],
        "repeat xs[0]",
        7,
        "none",
      ],
      [
        "a negative test keeps the list",
        [...xs, "if xs is not integer[] { say xs }"],
        "say xs",
        4,
        "is-not: holds",
      ],
      [
        "it removes `null` only",
        [...xs, "if xs is not integer[]? { say xs }"],
        "say xs",
        4,
        "is-not null: holds",
      ],
      [
        "the complement arm",
        [...xs, "if xs is not integer[] { say 1 } else { repeat xs[0] {} }"],
        "repeat xs[0]",
        7,
        "is integer element: holds",
      ],
      [
        "`not` of a negative test",
        [...xs, "if not (xs is not integer[]) { repeat xs[0] {} }"],
        "repeat xs[0]",
        7,
        "is integer element: holds",
      ],
      [
        "after a leaving negative test",
        [...xs, "if xs is not integer[] { exit }", "repeat xs[0] {}"],
        "repeat xs[0]",
        7,
        "is integer element: holds",
      ],
      [
        "the read's own test beside its collection's, at one entry: the more specific",
        [
          'let xs = load("xs", default: [])',
          "if xs is number[] and xs[0] is integer { say xs[0] }",
        ],
        "say xs[0]",
        4,
        "is integer: holds",
      ],
      [
        "the same, the tests reversed",
        [
          'let xs = load("xs", default: [])',
          "if xs[0] is integer and xs is number[] { say xs[0] }",
        ],
        "say xs[0]",
        4,
        "is integer: holds",
      ],
      [
        "an element scope beside a wider one, at one entry",
        [
          'let xs = load("xs", default: [])',
          "if xs is number[][] and xs[0] is integer[] { say xs[0][0] }",
        ],
        "say xs[0][0]",
        4,
        "is integer element: holds",
      ],
      [
        "an element step's collection reordered (N2)",
        [...xs, "if xs is integer[] { xs.reverse()\n repeat xs[0] {} }"],
        "repeat xs[0]",
        7,
        "is integer element: branch",
      ],
    ],
    at,
  );
});

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
        "non-null: branch",
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

test("N2's events of ordinary keys: a store, a call where another callable stores, a label a goto enters", () => {
  check(
    [
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
    ],
    at,
  );
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

test("N5's component: stores that read one another, through copies too, preserve together in either order (r4.33)", () => {
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

/** A program's analysis, alike with the sharing of answers off and with the consumers' and solver's orders reversed. */
function record(...lines: readonly string[]): CompactRecord {
  const request = coreRequest([{ path: "main.tease", source: `${lines.join("\n")}\nexit\n` }]);
  assert.ok(request !== null, lines.join("\n"));
  const modes = [
    compactAnalysis(request),
    withoutSharing(() => compactAnalysis(request)),
    withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    ),
  ];
  for (const other of modes.slice(1)) assert.deepEqual(other, modes[0], lines.join("\n"));
  return modes[0]!;
}

test("a read in a stored value takes its narrowing where it holds, and its mark where it fails (S10 part 2b)", () => {
  const outcome = (...lines: readonly string[]): string => record(...lines).outcome;
  const real = "let n = 2.0";
  // a whole number passes `is integer`: the stored value is the tested kind
  assert.equal(outcome(real, "if n is integer { let whole: integer = n }"), "valid");
  assert.equal(outcome(real, "if n is not integer { let whole: integer = n }"), "compile-error");
  // through a copy and an operation of the stored value
  assert.equal(
    outcome(real, "if n is integer { let copy = n\n let whole: integer = copy }"),
    "valid",
  );
  assert.equal(outcome(real, "if n is integer { let whole: integer = n + 1 }"), "valid");
  // a call storing the location between the test and the read drops G: the read keeps its mark
  assert.equal(
    outcome(
      real,
      "function halve { n = n / 2 }",
      "if n is integer { halve()\n let whole: integer = n }",
    ),
    "warning-runtime-check",
  );
  // a definition after the test answers the read itself (the nearest candidate, §13.2 (2))
  assert.equal(
    outcome(
      FLAG,
      "let v: number? = 2.5",
      "if flagHost { v = null }",
      "if v != null { v = 2\n let whole: integer = v }",
    ),
    "valid",
  );
  // a test whose input is a definition in a loop around it reads the contract, never that definition's value, which
  // would wait on the test's own component (Sol's U3 build review r2): the inner loop's stores preserve both facts
  assert.equal(
    outcome(
      FLAG,
      "let a: integer? = 1",
      "if flagHost { a = null }",
      "if a != null { repeat 2 { let n = a",
      "if n != null { repeat 2 { a = n",
      "n = n + 1",
      "let m: integer = n",
      "a = m } } } }",
    ),
    "valid",
  );
  // an element test's input is the element key's read at the test, never the collection's narrowing
  assert.equal(
    outcome(
      FLAG,
      "let xs = [1]",
      "if flagHost { xs = [null] }",
      "if flagHost { xs = null }",
      "if xs != null { if xs is integer[] { let first: integer = xs[0] } }",
    ),
    "valid",
  );
  // a key text spelling another path never lends it that path's test: the stored read is the outer test's `null`
  // (#1244), as with a key that spells nothing
  const spelling = [
    'let d: integer? dict dict = dict {"a": dict {"b].[string:c": null}, "a].[string:b": dict {"c": 1}}',
    'if d["a"]["b].[string:c"] == null { if d["a].[string:b"]["c"] != null {',
    'let saved: integer = d["a"]["b].[string:c"]',
    "say saved } }",
  ];
  for (const lines of [spelling, spelling.map((line) => line.replaceAll("a].[string:b", "z"))]) {
    const offset = lines.join("\n").lastIndexOf('d["a"]');
    const end = offset + 'd["a"]["b].[string:c"]'.length;
    assert.deepEqual(record(...lines), {
      outcome: "compile-error",
      diagnostics: [
        {
          kind: "written-target",
          class: "compile-error",
          site: { file: "main.tease", offset, end },
          context: null,
        },
      ],
      checks: [],
    });
  }
  // a computed row under a fixed column reads the root test's element fact, as under a computed column (#1245): the
  // storage ingress check alone remains
  const rows = [
    'let rows: integer?[][] = load("rows", default: [[1], [2]])',
    "let row = 0",
    "if rows is integer[][] { let saved: integer = rows[row + 1][0]\n say saved }",
  ];
  const computed = rows.map((line) => line.replace("[0]", "[0 + 0]"));
  for (const lines of [rows, computed]) {
    const analysed = pass(...lines);
    const found = narrowingAt(analysed.pass, read(analysed, "rows[row", 0));
    // (the form's test, its type as written, `integer`, beside its kinds: #1398)
    const form = found?.g.form;
    assert.deepEqual(
      [
        form?.kind,
        form?.kind === "is" ? [form.kinds, form.test?.kind] : null,
        found?.g.elements,
        found?.fails,
      ],
      ["is", [["integer"], "namedType"], 2, null],
    );
  }
  const stored = record(...rows);
  assert.deepEqual([stored.outcome, stored.diagnostics, stored.checks.length], ["valid", [], 1]);
  assert.deepEqual(record(...computed), stored);
});

test("a stored selection takes its element's narrowing as an index does, never its emptiness (U4a, N1)", () => {
  // (a record without its sites: an index and a selection of one owner differ in their spans)
  const answer = (...lines: readonly string[]): string => {
    const { outcome, diagnostics, checks } = record(...lines);
    return [
      outcome,
      ...diagnostics.map((d) => `${d.kind} ${d.context ?? "-"}`),
      ...checks.map((c) => c.kind),
    ].join(", ");
  };
  const choice = 'let choice = askBoolean "change?"';
  const xs = [choice, "let xs: integer?[] = [1]", "if choice { xs = [null] }"];
  const rows = [choice, "let rows: integer?[][] = [[1]]", "if choice { rows = [[null]] }"];
  // each program read at `@` by an index and by selections: a selection answers as the index does (Astra's N1 on
  // #1228), where G holds and where it fails
  const scenarios: readonly (readonly [string, readonly string[]])[] = [
    ["a collection test", [...xs, "if xs is integer[] { let sink: integer = xs@ }"]],
    [
      "a root test, which proves no element's kind",
      [
        choice,
        "let xs: integer?[]? = [1]",
        "if choice { xs = [null] }",
        "if choice { xs = null }",
        "if xs != null { let sink: integer = xs@ }",
      ],
    ],
    [
      "a mutation after the test",
      [...xs, "if xs is integer[] { xs.reverse()\nlet sink: integer = xs@ }"],
    ],
    [
      "a call storing the list after the test",
      [
        ...xs,
        "function spoil { xs = [null] }",
        "if xs is integer[] { spoil()\nlet sink: integer = xs@ }",
      ],
    ],
    ["a nearer store", [...xs, "if xs is integer[] { xs = [null]\nlet sink: integer = xs@ }"]],
    [
      "one literal's reads before and after a call (one class per environment)",
      [
        ...xs,
        "function spoil { xs = [null]\nreturn 1 }",
        "if xs is integer[] { let both: integer[] = [xs@, spoil(), xs@] }",
      ],
    ],
    [
      "a computed row under a test of every row",
      [...rows, "let row = 0", "if rows is integer[][] { let sink: integer = rows[row + 1]@ }"],
    ],
    ["another row's test", [...rows, "if rows[0] is integer[] { let sink: integer = rows[1]@ }"]],
    [
      "a parameter given a list and an object with its own `first`",
      [
        "function pick(v) {",
        'if v is integer[] { let sink: integer = v@\nsay "${sink}" }',
        "}",
        "pick([1])",
        'pick({first: "a"})',
      ],
    ],
  ];
  const indexes = scenarios.map(([name, lines]) => {
    const index = answer(...lines.map((line) => line.replaceAll("@", "[0]")));
    for (const selection of [".first", ".last", ".random"])
      assert.equal(
        answer(...lines.map((line) => line.replaceAll("@", selection))),
        index,
        `${name}: ${selection}`,
      );
    return index;
  });
  assert.equal(indexes[0], "valid");
  // a selected path's own test narrows it as an index's does; `.random` selects anew, so it is no path, and a test of
  // one path says nothing of another
  const tested = (test: string, read: string): string =>
    answer(...xs, `if ${test} != null { let sink: integer = ${read} }`);
  const untested = (read: string): string => answer(...xs, `let sink: integer = ${read}`);
  assert.equal(tested("xs.first", "xs.first"), tested("xs[0]", "xs[0]"));
  assert.equal(tested("xs.random", "xs.random"), untested("xs.random"));
  assert.equal(tested("xs.first", "xs.last"), untested("xs.last"));
  // an empty list passes every element test: C6 still asks the selection's element of its owner
  const empty = record(
    choice,
    "let xs: integer?[] = []",
    "if choice { xs = [null] }",
    "if xs is integer[] { let sink: integer = xs.first }",
  );
  assert.deepEqual(
    empty.checks.map((c) => c.kind),
    ["empty-check"],
  );
  // an owner that may be an object keeps its own `first` opaque beside the narrowed element (F11)
  const own = record(
    "function pick(v) {",
    'if v.first != null { let sink: integer = v.first\nsay "${sink}" }',
    "}",
    "pick([1, null])",
    "pick({first: null})",
  );
  assert.deepEqual(
    own.diagnostics.filter((d) => d.kind === "written-target").map((d) => d.context),
    ["unmodelled"],
  );
});

/** The work one query charges, at k = 64 and 128, per doubling of the source: about 2 for linear work. */
function queryDoubling(source: (k: number) => string, marker: string, delta: number): number {
  const [small, large] = [64, 128].map((k) => {
    const analysed = pass(source(k));
    const node = read(analysed, marker, delta);
    const work = analysed.pass.program.work;
    const before = work.total;
    narrowingAt(analysed.pass, node);
    return { units: work.total - before, nodes: work.counts().get("syntaxNodes") ?? 1 };
  });
  return (2 * (large!.units / small!.units)) / (large!.nodes / small!.nodes);
}

test("a long `otherwise` chain's preserving store and a deep element read cost what their size does (Sol r3)", () => {
  // each value's items merged by kind: a chain's intermediates never grow with it
  const chain = (k: number): string => {
    let value = "n";
    for (let index = 0; index < k; index += 1) value = `(${value} otherwise n)`;
    return `let n: integer? = load("n", default: null)\nif n is integer | null { repeat 2 { say n\n n = ${value} } }`;
  };
  assert.ok(queryDoubling(chain, "say n", 4) <= 2.15);
  // one walk of the read's steps down the tested paths' trie, never a scope text per trailing depth
  const deep = (k: number): string =>
    `let xs = load("xs", default: [])\nif xs is integer[][] { say 1 }\nsay xs${"[0 + 0]".repeat(k)}`;
  assert.ok(queryDoubling(deep, "say xs", 4) <= 2.15);
});

test("G's value is its input filtered by its form (N1)", () => {
  const scope = pass().pass.program.scope;
  const items = (...tags: readonly ItemTag[]): Item[] =>
    tags.map((tag) => makeItem(tag, null, { cert: "pos" }));
  const shown = (found: readonly Item[]): string =>
    found.map((item) => `${item.cert} ${item.tag}`).join(", ");
  const cases: readonly (readonly [NarrowingForm, readonly ItemTag[], string])[] = [
    [{ kind: "non-null" }, ["integer", "null"], "def integer"],
    [{ kind: "non-null" }, ["integer", "string", "null"], "pos integer, pos string"],
    [{ kind: "null" }, ["integer", "null"], "def null"],
    [{ kind: "null" }, ["unknown"], "def null"],
    [{ kind: "null" }, ["integer"], ""],
    [{ kind: "is", kinds: ["integer"] }, ["number", "string"], "def integer"],
    [{ kind: "is", kinds: ["integer"] }, ["unknown"], "def integer"],
    [{ kind: "is", kinds: ["number"] }, ["integer", "string"], "def integer"],
    [
      { kind: "is", kinds: ["number"], fractional: true },
      ["integer", "number", "string"],
      "def number",
    ],
    [
      { kind: "is", kinds: ["integer", "string"] },
      ["number", "string", "null"],
      "pos integer, pos string",
    ],
    [{ kind: "is", kinds: ["list"] }, ["list", "null", "empty"], "def list, pos empty"],
    [
      { kind: "is-not", kinds: ["integer"] },
      ["integer", "number", "string"],
      "pos number, pos string",
    ],
    [{ kind: "is-not", kinds: ["number"] }, ["integer", "number", "unknown"], "pos unknown"],
    [{ kind: "is-not", kinds: ["list"] }, ["list", "null"], "pos null"],
  ];
  for (const [form, tags, expected] of cases)
    assert.equal(
      shown(narrowedItems(form, items(...tags), scope, undefined)),
      expected,
      `${JSON.stringify(form)} on ${tags.join(", ")}`,
    );
  // (the kinds a type test proves of a value a stop left keep the test's spelling, as written, `string | integer`; none
  // given, the table's order: #1398, TABLE r4.277 (3))
  const stopped = [makeItem("unknown", null, { reasons: REASON.budget })];
  const tested: NarrowingForm = { kind: "is", kinds: ["integer", "string"] };
  assert.deepEqual(
    [["string", "integer"] as const, undefined].map((spelling) =>
      narrowedItems(tested, stopped, scope, spelling).map((item) => item.tag),
    ),
    [
      ["string", "integer"],
      ["integer", "string"],
    ],
  );
});

/** N3 at a read: the witness's source text, or `none`. */
function route(analysed: Analysed, marker: string, delta: number, tag: ItemTag = "null"): string {
  const witness = routeAt(analysed.pass, read(analysed, marker, delta), tag);
  return witness === null ? "none" : analysed.pass.program.textAt(witness.site);
}

test("N3 proves a route without a check, and refuses every corridor §13 closes", () => {
  const restore = "function restore { n = 2 }";
  const clear = 'let clear = askBoolean "c"';
  const fork = 'let fork = askBoolean "f"';
  const choose = 'let pick = askBoolean "pick"';
  const nullable = [clear, "let n = 1", "if clear { n = null }"];
  const corridor = (
    name: string,
    lines: readonly string[],
    expected: string,
    marker = REPEAT,
    delta = 7,
  ): Case => [name, lines, marker, delta, expected];
  check(
    [
      corridor("absent", [...nullable, REPEAT], "null"),
      corridor(
        "an open implicit arm",
        [fork, ...nullable, restore, "if fork { restore() }", REPEAT],
        "null",
      ),
      corridor(
        "killed after it",
        [clear, "let n = 1", "if clear { n = null\n n = 2 }", REPEAT],
        "none",
      ),
      corridor(
        "killed in its block",
        [
          clear,
          'let r = askBoolean "r"',
          "let n = 1",
          "if clear { if r { n = null }\n n = 2 }",
          REPEAT,
        ],
        "none",
      ),
      corridor(
        "both arms kill",
        [
          'let r = askBoolean "r"',
          "let n = 1",
          "n = null",
          "if r { n = 2 } else { n = 3 }",
          REPEAT,
        ],
        "none",
      ),
      corridor(
        "a prefix replaced",
        [clear, "let box = {n: 1}", "if clear { box.n = null\n box = {n: 2} }", "repeat box.n {}"],
        "none",
        "repeat box.n",
        7,
      ),
      corridor(
        "the consumer side",
        [
          'let enter = askBoolean "e"',
          choose,
          ...nullable,
          "if enter { if pick { n = 2 } else { n = 3 }\n repeat n {} }",
        ],
        "none",
      ),
      corridor(
        "the mixed split",
        [choose, ...nullable, restore, "if pick { n = 2 } else { restore() }", REPEAT],
        "none",
      ),
      corridor(
        "both arms call",
        [fork, ...nullable, restore, "if fork { restore() } else { restore() }", REPEAT],
        "none",
      ),
      corridor("blocking assignment", [...nullable, "if n == null { n = 1 }", REPEAT], "none"),
      corridor("blocking exit", [...nullable, "if n == null { exit }", REPEAT], "none"),
      corridor(
        "blocking else",
        [...nullable, "if n != null { say n } else { n = 0 }", REPEAT],
        "none",
      ),
      corridor("an empty else", [...nullable, "if n != null { say n }", REPEAT], "null"),
      corridor("a closed prefix", [...nullable, restore, "if restore() { say 1 }", REPEAT], "none"),
      corridor("a header call", [...nullable, restore, "if restore() { repeat n {} }"], "none"),
      corridor("an earlier operand", [...nullable, restore, "say restore() + n"], "none", "+ n", 2),
      corridor("a later operand", [...nullable, restore, "say n + restore()"], "null", "say n", 4),
      corridor(
        "an argument",
        [clear, "let a = 1", "if clear { a = null }", "function use(n) { repeat n {} }", "use(a)"],
        "none",
      ),
      corridor("a `null` argument", ["function use(n) { repeat n {} }", "use(null)"], "none"),
      corridor("an omitted default", ["function use(n = null) { repeat n {} }", "use()"], "null"),
      corridor(
        "a member through a reference",
        [
          clear,
          "speaker s { rounds: 1 }",
          "let p = s",
          "if clear { p.rounds = null }",
          "repeat p.rounds {}",
        ],
        "none",
        "repeat p.rounds",
        7,
      ),
      corridor(
        "a sibling arm",
        [clear, "let n = 1", "if clear { n = null } else { repeat n {} }"],
        "none",
      ),
      corridor(
        "routes, not runs",
        ['let b = askBoolean "Clear?"', "let n = 1", "if b { n = null }", "if not b { say n + 1 }"],
        "null",
        "say n",
        4,
      ),
      corridor(
        "out of a loop",
        [clear, "let n = 1", "repeat 2 { repeat 2 { if clear { n = null } }\n repeat n {} }"],
        "null",
      ),
      corridor("a handler store", [...nullable, "timer async 1 s { n = 2 }", REPEAT], "none"),
    ],
    route,
  );
});

test("N3 certifies seeds, a certified `otherwise` and scalar copies; refuses defaults no run must select", () => {
  const c = 'let c = askBoolean "c"';
  const cases: readonly (readonly [string, readonly string[], string, number, ItemTag, string])[] =
    [
      [
        "load default",
        ['let n = load("n", default: null)', REPEAT],
        REPEAT,
        7,
        "null",
        'load("n", default: null)',
      ],
      [
        "lookup default",
        ["let values = [3]", "let n = values.get(0, default: null)", REPEAT],
        REPEAT,
        7,
        "null",
        "none",
      ],
      [
        "parsing default",
        ['let n = fromJson("4", default: null)', REPEAT],
        REPEAT,
        7,
        "null",
        "none",
      ],
      [
        "void exit",
        [
          "function rounds(enabled: boolean) { if enabled { return 3 } }",
          "let n = rounds(true)",
          REPEAT,
        ],
        REPEAT,
        7,
        "null",
        "none",
      ],
      ["dead fallback", ["let n = 1 otherwise null", REPEAT], REPEAT, 7, "null", "none"],
      [
        "certified otherwise",
        ['let a = load("a", default: null)', "let n = a otherwise null", REPEAT],
        REPEAT,
        7,
        "null",
        "a otherwise null",
      ],
      [
        "otherwise after a literal null",
        [c, "let n: integer? = 5", "if c { n = null otherwise null }", REPEAT],
        REPEAT,
        7,
        "null",
        "null otherwise null",
      ],
      [
        "otherwise after a literal null, a union member",
        [c, "let n: integer | string = 5", 'if c { n = null otherwise "bad" }', REPEAT],
        REPEAT,
        7,
        "string",
        'null otherwise "bad"',
      ],
      [
        "otherwise after a literal null, another kind",
        [c, "let n: integer? = 5", "if c { n = null otherwise 3 }", REPEAT],
        REPEAT,
        7,
        "null",
        "none",
      ],
      [
        "otherwise after an uncertified null",
        [
          c,
          "let n: integer? = 5",
          "let values = [3]",
          "if c { n = values.get(0, default: null) otherwise null }",
          REPEAT,
        ],
        REPEAT,
        7,
        "null",
        "none",
      ],
      [
        "an omitted default after a literal null",
        ["function use(n: integer? = null otherwise null) { repeat n {} }", "use()"],
        REPEAT,
        7,
        "null",
        "null otherwise null",
      ],
      [
        "a supplied default after a literal null",
        ["function use(n: integer? = null otherwise null) { repeat n {} }", "use(4)"],
        REPEAT,
        7,
        "null",
        "none",
      ],
      [
        "copy",
        [c, "let source = 1", "if c { source = null }", "let saved = source", "repeat saved {}"],
        "repeat saved",
        7,
        "null",
        "source",
      ],
      [
        "copy, closed",
        [
          c,
          "let source = 1",
          "if c { source = null\n source = 2 }",
          "let saved = source",
          "repeat saved {}",
        ],
        "repeat saved",
        7,
        "null",
        "none",
      ],
      [
        "union member",
        ['let n: integer | string = load("n", default: "bad")', REPEAT],
        REPEAT,
        7,
        "string",
        'load("n", default: "bad")',
      ],
      [
        "whole store",
        [c, "let box = {n: 1}", "if c { box = {n: null} }", "repeat box.n {}"],
        "repeat box.n",
        7,
        "null",
        "{n: null}",
      ],
      [
        "whole store, read field",
        [c, "let a = null", "let box = {n: 1}", "if c { box = {n: a} }", "repeat box.n {}"],
        "repeat box.n",
        7,
        "null",
        "none",
      ],
    ];
  for (const [name, lines, marker, delta, tag, expected] of cases)
    assert.equal(route(pass(...lines), marker, delta, tag), expected, name);
});
