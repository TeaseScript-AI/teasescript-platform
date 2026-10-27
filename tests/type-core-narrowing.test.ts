import assert from "node:assert/strict";
import test from "node:test";

import type { CorePass } from "../src/type-inference/core/answers.js";
import { makeItem, type Item, type ItemTag } from "../src/type-inference/core/items.js";
import { narrowedItems, type NarrowingForm } from "../src/type-inference/core/narrowing.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { narrowingAt, narrowingPass, nodeAt, routeAt } from "./helpers/type-core-narrowing.js";

/*
 * Stage 3b's narrowing index (TABLE §13, S10's first part), asked directly: no consumer reads it yet. Per N1 form and
 * per N2 event a control that holds and a case that changes only the premise (§13.4), taken from the expectation set's
 * 3b shapes; G's filter on items; N5's preserving and breaking stores; N3's route witnesses for §13's own examples.
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
      shown(narrowedItems(form, items(...tags), scope)),
      expected,
      `${JSON.stringify(form)} on ${tags.join(", ")}`,
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
