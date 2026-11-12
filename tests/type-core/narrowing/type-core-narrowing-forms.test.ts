import assert from "node:assert/strict";
import test from "node:test";
import {
  makeItem,
  REASON,
  type Item,
  type ItemTag,
} from "../../../src/type-inference/core/items.js";
import {
  narrowedItems,
  type NarrowingForm,
} from "../../../src/type-inference/core/narrowing/narrowings.js";
import {
  FLAG,
  NULLABLE,
  pass,
  at,
  type Case,
  check,
  REPEAT,
} from "../../helpers/type-core/type-core-narrowing-setup.js";

/*
 * Stage 3b's narrowing index (S10's first part), asked directly, and the stored values that read it (S10
 * part 2b; the other consumers read it in part 2c). Per N1 form and per N2 event a control that holds and a case that
 * changes only the premise, taken from the expectation set's 3b shapes; G's filter on items; N5's preserving and
 * breaking stores, one location and a component; N3's route witnesses for the cases below.
 */

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
  // given, the table's order: #1398)
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
