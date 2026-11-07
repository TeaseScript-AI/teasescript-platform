import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type CorePass } from "../src/type-inference/core/answers.js";
import { WorkLedger } from "../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { annotationTags } from "../src/type-inference/core/contract/terms.js";
import {
  itemsSignature,
  makeItem,
  REASON,
  type Item,
  type ItemTag,
} from "../src/type-inference/core/items.js";
import { narrowedItems, type NarrowingForm } from "../src/type-inference/core/narrowing.js";
import { siteKey } from "../src/type-inference/core/program.js";
import type { Obligation } from "../src/type-inference/core/result.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { narrowingAt, narrowingPass, nodeAt, routeAt } from "./helpers/type-core-narrowing.js";
import { readFixture } from "./helpers/type-core-fixture.js";
import { inMode, MODES, stopSet } from "./helpers/type-core-oracles.js";
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
        "is integer element: member",
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
  // (`.random`'s test is a check the compiler cannot keep, the warning; with none, its `null` is the route rule's error,
  // AD-1)
  assert.match(tested("xs.random", "xs.random"), /^warning-runtime-check/);
  assert.match(untested("xs.random"), /^compile-error/);
  // (a test of `.first` is one of the element key `.last` reads too: the warning, the proof limit of a corridor that
  // follows keys, not locations, #1938; with no test, `.last`'s `null` is the route rule's error)
  assert.match(tested("xs.first", "xs.last"), /^warning-runtime-check/);
  assert.match(untested("xs.last"), /^compile-error/);
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

test("a read below a selection takes its narrowing, each selected owner's own selection beside it (#1073, F11)", () => {
  const answer = (...lines: readonly string[]): string => {
    const { outcome, diagnostics, checks } = record(...lines);
    return [
      outcome,
      ...diagnostics.map((d) => `${d.kind} ${d.context ?? "-"}`),
      ...checks.map((c) => c.kind),
    ].join(", ");
  };
  const choice = 'let choice = askBoolean "change?"';
  const rows = [choice, "let rows: integer?[][] = [[1]]", "if choice { rows = [[null]] }"];
  const cube = [choice, "let cube: integer?[][][] = [[[1]]]", "if choice { cube = [[[null]]] }"];
  // each program read at `@` two element steps down, by indexes and by selections at either step (`.random` in the
  // middle included): a selection answers as the index does where G holds, where it fails and where a nearer
  // definition answers
  const scenarios: readonly (readonly [string, readonly string[]])[] = [
    ["a collection test", [...rows, "if rows is integer[][] { let sink: integer = rows@ }"]],
    [
      "a root test, which proves no element's kind",
      [
        choice,
        "let rows: integer?[][]? = [[1]]",
        "if choice { rows = [[null]] }",
        "if choice { rows = null }",
        "if rows != null { let sink: integer = rows@ }",
      ],
    ],
    [
      "an inner mutation after the test",
      [...rows, "if rows is integer[][] { rows[0].add(null)\nlet sink: integer = rows@ }"],
    ],
    [
      "a call storing the list after the test",
      [
        ...rows,
        "function spoil { rows = [[null]] }",
        "if rows is integer[][] { spoil()\nlet sink: integer = rows@ }",
      ],
    ],
    [
      "a nearer store of the prefix",
      [...rows, "if rows is integer[][] { rows[0] = [null]\nlet sink: integer = rows@ }"],
    ],
    [
      "one literal's reads before and after a call (one class per environment)",
      [
        ...rows,
        "function spoil { rows = [[null]]\nreturn 1 }",
        "if rows is integer[][] { let both: integer[] = [rows@, spoil(), rows@] }",
      ],
    ],
    [
      "a store to the row's index between two reads (one class per environment)",
      [
        choice,
        "let cube: integer?[][][] = [[[1]], [[null]]]",
        "if choice { cube = [[[null]]] }",
        "let row = 0",
        "function bump { row = 1\nreturn 1 }",
        "if cube[row] is integer[][] { let both: integer[] = [cube[row]@, bump(), cube[row]@] }",
      ],
    ],
    ["a test of one row", [...cube, "if cube[0] is integer[][] { let sink: integer = cube[0]@ }"]],
    ["another row's test", [...cube, "if cube[0] is integer[][] { let sink: integer = cube[1]@ }"]],
    [
      "a parameter given lists and an object with its own selections",
      [
        "function pick(v) {",
        'if v is integer[][] { let sink: integer = v@\nsay "${sink}" }',
        "}",
        "pick([[1]])",
        'pick({first: {last: "a"}})',
      ],
    ],
  ];
  const indexes = scenarios.map(([name, lines]) => {
    const index = answer(...lines.map((line) => line.replaceAll("@", "[0][0]")));
    for (const selection of [".first.last", ".random.first", ".first[0]", ".last.random"])
      assert.equal(
        answer(...lines.map((line) => line.replaceAll("@", selection))),
        index,
        `${name}: ${selection}`,
      );
    return index;
  });
  assert.deepEqual([indexes[0], indexes[7], indexes[9]], ["valid", "valid", "valid"]);
  // a descendant path's own test narrows it as an index path's does; `.random` selects anew, so a path through it is no
  // path, and a test of one path says nothing of another
  const rs = [choice, "let rs = [{f: 1}]", "if choice { rs = [{f: null}] }"];
  const tested = (base: readonly string[], test: string, read: string): string =>
    answer(...base, `if ${test} != null { let sink: integer = ${read} }`);
  const untested = (base: readonly string[], read: string): string =>
    answer(...base, `let sink: integer = ${read}`);
  assert.equal(tested(rs, "rs.first.f", "rs.first.f"), "valid");
  assert.equal(tested(rs, "rs.last.f", "rs.last.f"), tested(rs, "rs[0].f", "rs[0].f"));
  assert.equal(tested(rows, "rows.first.last", "rows.first.last"), "valid");
  assert.equal(tested(rs, "rs.first.f", "rs.last.f"), untested(rs, "rs.last.f"));
  assert.equal(tested(rs, "rs.random.f", "rs.random.f"), untested(rs, "rs.random.f"));
  // (a selection through `.random` is read anew: its test is a check the compiler cannot keep, the warning; with none,
  // its `null` is the route rule's error, AD-1)
  for (const read of ["rows.random.first", "rows.first.random"]) {
    assert.match(tested(rows, read, read), /^warning-runtime-check/, read);
    assert.match(untested(rows, read), /^compile-error/, read);
  }
  // an empty list passes every element test: C6 still asks each selection's element of its owner; a property an
  // element lacks stays a member read
  const checks = (...lines: readonly string[]): string[] =>
    record(...lines).checks.map((c) => c.kind);
  assert.deepEqual(
    checks(
      choice,
      "let rows: integer?[][] = []",
      "if choice { rows = [[null]] }",
      "if rows is integer[][] { let sink: integer = rows.first.last }",
    ),
    ["empty-check", "empty-check"],
  );
  assert.ok(
    record(
      choice,
      "let rs = [{g: 1}]",
      "if choice { rs = [{f: null}] }",
      "if rs.first.f != null { let sink: integer = rs.first.f }",
    ).diagnostics.some((d) => d.kind === "member-read" && d.context === "missing"),
  );
  // each owner that may be an object keeps its own selection opaque beside the narrowed element (F11), at the inner
  // link and at the outer one, where G holds and where it fails; lists alone are narrowed
  const pick = (body: string, ...calls: readonly string[]): readonly string[] =>
    record(
      "function pick(v) {",
      `if v.first.last != null { ${body}let sink: integer = v.first.last\nsay "\${sink}" }`,
      "}",
      "pick([[1], [null]])",
      ...calls.map((call) => `pick(${call})`),
    )
      .diagnostics.filter((d) => d.kind === "written-target")
      .map((d) => d.context ?? "-");
  assert.deepEqual(pick(""), []);
  for (const object of ["{first: [null]}", "[{last: null}]"]) {
    assert.deepEqual(pick("", object), ["unmodelled"], object);
    assert.ok(pick("v.first.add(null)\n", object).includes("unmodelled"), object);
  }
});

test("a consumer reads the narrowing as a store does, in §13.2's order (#1073 PR 2, #1320)", () => {
  // (a record's outcome, its diagnostics' kinds and classes and its checks' kinds, in the three modes `record` asks)
  const answer = (...lines: readonly string[]): string => {
    const { outcome, diagnostics, checks } = record(...lines);
    return [
      outcome,
      ...diagnostics.map((d) => `${d.kind} ${d.class}`),
      ...checks.map((c) => `${c.kind}${c.boundary === true ? " boundary" : ""}`),
    ].join(", ");
  };
  const flag = 'let flag = askBoolean "?"';
  // G holds at a consumer: a fitting kind is quiet, as at a store
  for (const [test, use] of [
    ["n != null", "repeat n {}"],
    ["n is integer", "repeat n {}"],
    ["n != null", 'say "${n}"'],
  ] as const)
    assert.equal(
      answer(flag, "let n = 1", "if flag { n = null }", `if ${test} { ${use} }`),
      "valid",
      `${test}: ${use}`,
    );
  // a nearer store after the test answers the consumer exactly: an invalid value stays invalid (V30 §13)
  assert.equal(
    answer(flag, "let n = 1", "if flag { n = null }", "if n != null { n = null\n repeat n {} }"),
    "compile-error, integer-use compile-error",
  );
  // a test of the read's own key keeps its guard (§3.2)
  assert.equal(
    answer("let box = {n: 1.5}", "if box.n < 2 { repeat box.n {} }"),
    "warning-runtime-check, integer-use warning-runtime-check, integer-check",
  );
  // the test proves a kind, never an ingress (C9, the lead's ruling (a)): external data keeps exactly one boundary
  // check, at its ingress store or, where no store brought it, at the consumer (r4.10), through every transfer that
  // keeps the value; a computed result brings no data in (Codex r1–r3 on #1770: the typed store, the operator, the
  // selection without an ingress are rows)
  const transfers: readonly (readonly [string, string, string, string, string])[] = [
    ["a read", "", "integer", "repeat X {}", "valid, copy-type boundary"],
    ["a copy", "", "integer", "let c = X\n repeat c {}", "valid, copy-type boundary"],
    [
      "a merge of one kind",
      "",
      "integer",
      "let xs = [X, 1]\n repeat xs[0] {}",
      "valid, copy-type boundary",
    ],
    [
      "a literal's element",
      "",
      "integer",
      "let xs = [X]\n repeat xs[0] {}",
      "valid, copy-type boundary",
    ],
    ["a selection", "", "integer[]", "repeat X[0] {}", "valid, copy-type boundary"],
    [
      "an operator",
      "",
      "integer",
      "let out: integer = X + 1\n repeat out {}",
      "valid, copy-type boundary",
    ],
    [
      "a typed store",
      "",
      "integer",
      "let out: integer = X\n repeat out {}",
      "valid, copy-type boundary",
    ],
    [
      "an argument",
      "function f(p: integer) {\n repeat p {}\n}\n",
      "integer",
      "f(X)",
      "valid, copy-type boundary",
    ],
    [
      "a result",
      "function g(p): integer {\n return p\n}\n",
      "integer",
      "let out = g(X)\n repeat out {}",
      "valid, copy-type boundary",
    ],
    [
      "a default",
      "",
      "integer",
      "let out: integer = X otherwise 0\n repeat out {}",
      "warning, static warning, copy-type boundary",
    ],
  ];
  for (const [name, prelude, type, body, expected] of transfers)
    for (const [where, before, read] of [
      ["an ingress store", "let raw = hostValue\n", "raw"],
      ["no ingress store", "", "hostValue"],
    ] as const)
      assert.equal(
        answer(`${prelude}${before}if ${read} is ${type} {\n${body.replaceAll("X", read)}\n}`),
        expected,
        `${name}, ${where}`,
      );
  // a stopped read keeps its C9 check: the stop leaves the kinds unknown, never the ingress (Codex r4), at the read's
  // root occurrence or at the store that brought the data in, with its target, site and domain
  for (const [source, expected] of [
    ["if hostValue is integer {repeat hostValue {}}", "hostValue [unknown] 32-41"],
    ['if hostValue is string[] {say "${hostValue}"}', "hostValue [unknown] 33-42"],
    // (a projection's own read, data or computed, is the occurrence's check alone, Codex r5)
    ["if hostValue is integer[] {repeat hostValue[0] {}}", "hostValue [unknown] 34-43"],
    ["if hostValue is integer[] {repeat hostValue.length {}}", "hostValue [unknown] 34-43"],
    ["if hostValue is integer {let out:integer=hostValue\nrepeat out {}}", "out [integer] 41-50"],
    [
      "if hostValue is integer[] {let out:integer=hostValue[0]\nrepeat out {}}",
      "out [integer] 43-52",
    ],
  ] as const)
    for (const mode of MODES) {
      const stopped = stopSet(
        [{ path: "main.tease", source: `${source}\nexit\n` }],
        mode,
        ["hostValue"],
        1,
      )!;
      // EVIDENCE: `stoppedRecord` serializes the answers' `checks`, a list of `Obligation`s.
      const { checks } = JSON.parse(stopped.record) as { checks: readonly Obligation[] };
      assert.ok(stopped.record.includes('"context":"budget"'), `${source}: a read stops`);
      assert.equal(
        checks
          .filter((c) => c.boundary === true)
          .map((c) => `${c.target} [${c.against.join("|")}] ${c.site.start}-${c.site.end}`)
          .join("; "),
        expected,
        `${source} ${JSON.stringify(mode)}`,
      );
    }
  // #1320: a scalar under its test needs no operand check; a list under an element test keeps C6's emptiness, read
  // directly and at a row (a consumer's descendant demand takes its path's G)
  assert.equal(
    answer("let v = hostValue", 'if v is string { say "${v}" }'),
    "valid, copy-type boundary",
  );
  for (const [test, use] of [
    ["xs is string[]", 'say "${xs}"'],
    ["xs is string[][]", 'say "${xs[0]}"'],
  ] as const)
    assert.equal(
      answer("let xs = hostValue", `if ${test} { ${use} }`),
      "warning-runtime-check, member-read warning-runtime-check, copy-type boundary, empty-check",
      `${test}: ${use}`,
    );
  // without the test, the operand check stays
  assert.equal(
    answer("let xs = hostValue", 'say "${xs}"'),
    "warning-runtime-check, operator warning-runtime-check, copy-type boundary, operand",
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

/**
 * #1398 (TABLE r4.277 (3), Codex r6 on #1558): a type test's spelling is read once per test and pass, whatever the
 * number of reads it narrows: k stored reads of host data under a test of k alternating members carry one spelling, one
 * array, `[string, integer]`, in the four modes, so the type's walks grow with the test alone.
 */
test("a type test's spelling is read once, for every read it narrows (#1398)", () => {
  for (const k of [8, 16, 32]) {
    const members = Array.from({ length: k }, (_, index) =>
      index % 2 === 0 ? "string" : "integer",
    );
    const stores = Array.from({ length: k }, (_, index) => `  let y${index} = x`);
    const source = `let x = hostValue\nif x is ${members.join(" | ")} {\n${stores.join("\n")}\n}\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, `${k}`);
    const reads = stores.map((line) => source.indexOf(line) + line.length - 1);
    for (const mode of MODES)
      inMode(mode, () => {
        const answers = analyseCore(request);
        const spellings = new Set(
          answers.graph.nodes
            .filter((node) => node.span !== null && reads.includes(node.span.start.offset))
            .flatMap((node) => answers.at(node)?.items ?? [])
            .map((item) => item.spelling),
        );
        assert.equal(spellings.size, 1, `${k} ${JSON.stringify(mode)}`);
        assert.deepEqual([...spellings][0], ["string", "integer"], `${k} ${JSON.stringify(mode)}`);
      });
  }
});

/**
 * #1398 (TABLE r4.277 (2), Codex r7 on #1558): two type tests of one kinds in two written orders narrow host data to two
 * answers, `[string, integer]` and `[integer, string]`, and the value side tells them apart in every identity it reads:
 * their items' signatures and their exact read classes, which take the test's spelling (`Values.narrowingMark`).
 */
test("two type tests of one kinds in two written orders give two read classes (#1398)", () => {
  const source =
    "let x = hostValue\nif x is string | integer | string { let first = x }\n" +
    "if x is integer | string | integer | string { let second = x }\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null);
  const pass = narrowingPass(request);
  const reads = ["first", "second"].map((name) => {
    const node = nodeAt(pass, source.indexOf(`let ${name} = x`) + `let ${name} = `.length);
    const value = pass.program.placeBySite.get(
      siteKey({ file: node.file, start: node.span!.start.offset, end: node.span!.end.offset }),
    )!;
    const items = pass.solver.run(pass.values.valueItems(value, node, []));
    return {
      tags: items.map((item) => item.tag),
      signature: itemsSignature(items, pass.program.scope),
      read: pass.contract.readClass(value, true),
    };
  });
  assert.deepEqual(
    reads.map((read) => read.tags),
    [
      ["string", "integer"],
      ["integer", "string"],
    ],
  );
  assert.notEqual(reads[0]!.signature, reads[1]!.signature);
  assert.notEqual(reads[0]!.read, reads[1]!.read);
});

/**
 * #1398 (TABLE r4.277 (2), Codex r8 on #1558): the narrowing a read takes is part of every exact value class it is
 * given, whichever way the class is joined: two tests of one kinds in two written orders, of a host read, a host
 * property, a host element and their local controls, give the two stored reads two value classes and two bound
 * classes, in the four modes.
 */
test("two type tests of one kinds in two written orders give two value classes, a host read's too (#1398)", () => {
  for (const tested of ["hostValue", "hostValue.x", "hostValue[0]", "x", "x.n", "x[0]"]) {
    const local = tested.startsWith("x") ? "let x = hostValue\n" : "";
    const source =
      `${local}if ${tested} is string | integer | string { let first = ${tested} }\n` +
      `if ${tested} is integer | string | integer | string { let second = ${tested} }\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, tested);
    for (const mode of MODES)
      inMode(mode, () => {
        const pass = narrowingPass(request);
        const reads = ["first", "second"].map((name) => {
          const node = nodeAt(pass, source.indexOf(`let ${name} = `) + `let ${name} = `.length);
          const value = pass.program.placeBySite.get(
            siteKey({
              file: node.file,
              start: node.span!.start.offset,
              end: node.span!.end.offset,
            }),
          )!;
          return {
            tags: pass.solver.run(pass.values.valueItems(value, node, [])).map((item) => item.tag),
            cls: pass.contract.classOf(value, true),
            bound: pass.contract.boundClass(value, true).cls,
          };
        });
        const at = `${tested} ${JSON.stringify(mode)}`;
        assert.notDeepEqual(reads[0]!.tags, reads[1]!.tags, at);
        assert.notEqual(reads[0]!.cls, reads[1]!.cls, at);
        assert.notEqual(reads[0]!.bound, reads[1]!.bound, at);
      });
  }
});

/**
 * #1398 (TABLE r4.277 (3), Codex r7 on #1558): a type's written kinds are read by one walk, each node and each kind it
 * gives once: at depths 32, 64 and 128 of unions nested to the right and to the left, and of optionals, the walk of the
 * test's type as its narrowing holds it gives one kind per name the type writes, in their written order.
 */
test("a type test's written kinds are one kind per name, in written order, however deeply it nests (#1398)", () => {
  const alternate = (at: number): string => (at % 2 === 0 ? "integer" : "string");
  for (const shape of ["right", "left", "optional"])
    for (const k of [32, 64, 128]) {
      let type = "string";
      const kinds: string[] = ["string"];
      for (let at = 0; at < k; at += 1)
        if (shape === "right") {
          type = `${alternate(at)} | (${type})`;
          kinds.unshift(alternate(at));
        } else if (shape === "left") {
          type = `(${type}) | ${alternate(at)}`;
          kinds.push(alternate(at));
        } else {
          type = `${type} ?`;
          kinds.push("null");
        }
      const source = `let x = hostValue\nif x is ${type} {\n  let y = x\n}\nexit\n`;
      const analysed = pass(source);
      const form = narrowingAt(analysed.pass, read(analysed, "x\n}", 0))?.g.form;
      assert.ok(form?.kind === "is" && form.test !== undefined, `${shape} ${k}`);
      assert.deepEqual(annotationTags(form.test), kinds, `${shape} ${k}`);
    }
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

test("N3 certifies every producer by what its value holds (AD-1), a certified `otherwise` and scalar copies; refuses a default no run selects", () => {
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
        "values.get(0, default: null)",
      ],
      [
        "parsing default",
        ['let n = fromJson("4", default: null)', REPEAT],
        REPEAT,
        7,
        "null",
        'fromJson("4", default: null)',
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
        "rounds(true)",
      ],
      // (AD-1, TABLE r4.52: a lookup's, a parse's and a void exit's `null` certify as a literal's does; a fallback never
      // selected certifies nothing)
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
        "values.get(0, default: null) otherwise null",
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
        "{n: a}",
      ],
    ];
  for (const [name, lines, marker, delta, tag, expected] of cases)
    assert.equal(route(pass(...lines), marker, delta, tag), expected, name);
});

/*
 * #1251: a program without a condition, a `switch` or an `and`/`or` builds no narrowing index (`GuardIndex.testless`,
 * read by `Values.#narrowingOf`): those are the only places the index makes a narrowing definition, so it would list
 * none. Over the fixture, every such program's index is empty.
 */
test("a program without a test lists no narrowing (#1251)", () => {
  let testless = 0;
  for (const record of readFixture()) {
    const request = coreRequest(record.files);
    if (request === null) continue;
    const { guards } = narrowingPass(request);
    if (!guards.testless) continue;
    testless += 1;
    assert.deepEqual(guards.narrowing.all, [], record.name);
  }
  assert.ok(testless > 0, "the fixture has programs without a test");
});

/**
 * #1251, Astra r1's witness: a root tested only in an `or`'s right operand keeps its narrowing for a stored read after
 * the early exit (an integer), with no warning; the test proves a kind, never an ingress, so `b`'s external data keeps
 * its boundary check where it enters (C9, #1073 PR 2), as the fixture's `n1-unknown-positive` records.
 */
test("a root tested in an or's right operand keeps its narrowing for a stored read (#1251)", () => {
  const source = [
    "let a = hostValue",
    "let b = hostOther",
    "if a is not integer or b is not integer { exit }",
    "let n = b + 1",
    "say n",
    "exit",
  ].join("\n");
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
  for (const mode of MODES) {
    const answers = inMode(mode, () => analyseCore(request));
    assert.deepEqual(answers.diagnostics, [], JSON.stringify(mode));
    assert.deepEqual(
      answers.checks.map((c) => [c.kind, c.target, c.boundary, c.site.start]),
      [["copy-type", "b", true, source.indexOf("hostOther")]],
      JSON.stringify(mode),
    );
  }
});

test("a program without a test does not pay for the narrowing index; the same with a test does (#1251)", () => {
  // (k copies in a chain and a read, with or without one condition testing another variable)
  const chain = (k: number, test: boolean): string =>
    [
      "let v0 = 1",
      ...Array.from({ length: k }, (_, i) => `let v${i + 1} = v${i} + 1`),
      `say v${k}`,
      ...(test ? ["let t = hostValue", "if t is integer { say 1 }"] : []),
      "exit",
    ].join("\n");
  const request = (source: string) => coreRequest([{ path: "main.tease", source }])!;
  const total = (source: string): number => analyseCore(request(source)).budget.total;
  for (const k of [16, 64]) {
    // the index's build for the program without the test, measured apart: its first ask, charged then
    const { guards, program } = narrowingPass(request(chain(k, false)));
    assert.ok(guards.testless, `k = ${k}: no test`);
    const before = program.work.total;
    assert.deepEqual(guards.narrowing.all, [], `k = ${k}: no narrowing definition`);
    const index = program.work.total - before;
    assert.ok(index > 0, `k = ${k}: the index's build is charged`);
    // the program with the condition pays that build on top of its three more statements
    const [without, withTest] = [total(chain(k, false)), total(chain(k, true))];
    assert.ok(
      withTest - without >= index,
      `k = ${k}: ${without} without the test, ${withTest} with it, index ${index}`,
    );
  }
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
    if (args[0] === "literalUnits" && /narrowing(-events)?\.js/.test(new Error().stack!))
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
