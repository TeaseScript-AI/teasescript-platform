import assert from "node:assert/strict";
import test from "node:test";
import { jsonFieldMismatch, jsonKindMismatch } from "../src/runtime/values/value-types.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../src/type-inference/core/messages.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import { heldBack, readFixture } from "./helpers/type-core-fixture.js";

/*
 * The sentences of the coarse core's diagnostics (D1–D3, TABLE r4.53, `core/messages.ts`): each consumer's and
 * obligation's first sentence as an error and as a warning, with its rule's code and its fix (#1195), and each context
 * word's cause on the set's record for that word. The sentences are the owner's: a change here is a change of what an
 * author reads.
 */

const records = readFixture();

/** Each diagnostic of a project's analysis: `E` or `W`, its code, its site's text, and its message. */
function messages(files: readonly SourceFile[]): string[] {
  return reported(files).map(
    ({ error, code, site, message }) => `${error ? "E" : "W"} ${code} '${site}': ${message}`,
  );
}

function reported(files: readonly SourceFile[]) {
  const request = coreRequest(files);
  assert.ok(request !== null, "the files parse and resolve");
  const source = messageSource(files.map((file) => file.source));
  return analyseCore(request).diagnostics.map((diagnostic) => ({
    error: diagnostic.class === "compile-error",
    code: diagnostic.code,
    site: source.text(diagnostic.site),
    message: coreMessage(diagnostic, source),
  }));
}

const main = (source: string): SourceFile[] => [{ path: "main.tease", source }];

const STOPS = "If it is, the Tease stops with an error at this line.";
const OUTSIDE = (name: string): string =>
  `'${name}' comes from outside the script, so its type is known only when the script runs.`;
const COUNT = "A repeat count must be a whole number (integer) of at least 0";
const ROUND = "Round it with floor(...), round(...), or ceil(...) first.";

test("each context word's cause says why the value may be of another type, on the set's record for the word (D1, §3.4)", () => {
  const word = (name: string, expected: readonly string[]): void => {
    const record = records.find((found) => found.name === name);
    assert.ok(record !== undefined, name);
    assert.deepEqual(messages(record.files), expected, name);
  };
  const count = `W TSV011 'n': ${COUNT}, but 'n' may be a number here. ${STOPS} ${ROUND}`;
  word("cp9-cells/X4/entered-label", [
    `${count} This line is also reached by 'goto again', and 'n' may change before that jump.`,
  ]);
  // (the first sentence names the line that decides, so no cause repeats it; the warning advises a written union, ADR
  // 0021 rule 1.7)
  word("cp9-cells/A7/later-decider", [
    "W TSV041 'source.removeAt(0)': 'copy' holds a whole number (integer) because of line 3, but " +
      `'source.removeAt(0)' may be text (string) here. ${STOPS} To allow both, declare it as ` +
      "'let copy: integer | string = ...'.",
  ]);
  word("cp9-cells/F11/missing", [
    "W TSV043 'room.count': 'room' may hold an object without property 'count' here. If it does, the Tease stops " +
      "with an error at this line.",
  ]);
  word("cp9-cells/X6/branch-event", [
    `${count} 'n' is set inside an 'if' or another branch, so which value reaches this line depends on the choice.`,
  ]);
  word("cp9-cells/O13/captured-entry", [
    `${count} 'n' is set outside 'use', before 'use' is called.`,
  ]);
  // a file the script calls has no function to name
  word("cp9-cells/O9/file-call", [
    `${count} 'n' may be changed by a function or a file the script calls before this line.`,
  ]);
  word("cp9-cells/r46/m3/sol-m3x/X1/changed", [`${count} This line never runs.`]);
  word("cp9-cells/F21/multiple", [
    `${count} 'use' is called from more than one place, so 'n' may hold another type in each call.`,
  ]);
  word("cp9-cells/O15/block-local", [
    `${count} This block runs when the button is pressed, and 'n' may change inside it before this line.`,
  ]);
  // a read outside the block a store is in
  word("cp9-cells/H7/timer", [
    `W TSV041 'n': 'copy' is declared as a whole number (integer), but 'n' may be a number here. ${STOPS} ${ROUND} ` +
      "A button, timer, or media block may run before this line and change 'n'.",
  ]);
  word("cp9-cells/r46/m3/sol-m3x/X5/changed", [
    `${count} 'n' may change in an earlier round of this loop.`,
  ]);
  word("cp9-cells/X3/element", [
    `W TSV011 'xs[0]': ${COUNT}, but 'xs[0]' may be a number here. ${STOPS} ${ROUND} 'xs[0]' is a list element, ` +
      "and any element of the list may be a number.",
  ]);
  word("cp9-cells/r46/m3/astra-m3/external-receiver/index-store", [
    "W TSV043 'value[0]': 'value' may have no elements that can be set here. If it has none, the Tease stops with " +
      `an error at this line. ${OUTSIDE("value")}`,
  ]);
  const speaker = "'player' is a speaker, whose properties are known only when the script runs.";
  // (in source order of their sites: the store's member read first, r4.86 (1))
  word("cp9-cells/F19a/direct", [
    "W TSV043 'player.n': 'player' may have no property 'n' that can be set here. If it has none, the Tease stops " +
      `with an error at this line. ${speaker}`,
    `W TSV011 'player.n': ${COUNT}, but 'player.n' may be a value of another type here. ${STOPS} Keep 'player.n' ` +
      "in a variable and check the variable first, as in 'if value is integer { ... }'. The type of 'player.n' is " +
      "known only when the script runs.",
    "W TSV043 'player.n': 'player' may have no property 'n' here. If it has none, the Tease stops with an error at " +
      `this line. Assign the property before this line, as in 'player.n = ...'. ${speaker}`,
  ]);
});

test("each consumer's first sentence and fix, as an error and as a warning, with its rule's code (D1, D3, #1195)", () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    // C1, ADR 0021 rule 1.1: a written type, a decided one with its line and a written union, a possible value
    [
      "let n: integer = 1.5\nexit\n",
      [
        `E TSV041 '1.5': 'n' is declared as a whole number (integer), so it cannot take a number. ${ROUND}`,
      ],
    ],
    [
      'let n = 1\nn = "text"\nexit\n',
      [
        "E TSV041 '\"text\"': 'n' holds a whole number (integer) since line 1, so it cannot take text (string). " +
          "To allow both, declare it as 'let n: integer | string = ...'.",
      ],
    ],
    [
      "let n: integer = 1\nn = null\nexit\n",
      [
        "E TSV041 'null': 'n' is declared as a whole number (integer), so it cannot take null. To allow null, " +
          "declare it as 'let n: integer? = ...'.",
      ],
    ],
    [
      "let n: integer = hostValue\nexit\n",
      [
        "W TSV041 'hostValue': 'n' is declared as a whole number (integer), but 'hostValue' may be a value of " +
          `another type here. ${STOPS} Check 'hostValue' first, as in 'if hostValue is integer { ... }'. ` +
          OUTSIDE("hostValue"),
      ],
    ],
    // C2
    ["repeat 2.5 {}\nexit\n", [`E TSV011 '2.5': ${COUNT}, but '2.5' is a number. ${ROUND}`]],
    [
      "let xs = [1, 2]\nlet y = xs[0.5]\nexit\n",
      [
        `E TSV043 '0.5': A list index must be a whole number (integer), but '0.5' is a number. ${ROUND}`,
      ],
    ],
    [
      "let xs = [1, 2]\nxs.removeAt(1.5)\nexit\n",
      [
        `E TSV043 '1.5': removeAt() needs a whole number (integer), but '1.5' is a number. ${ROUND}`,
      ],
    ],
    [
      "let xs = [1, 2]\nlet ys = xs.take(hostValue)\nexit\n",
      [
        "W TSV043 'hostValue': take() needs a whole number (integer), but 'hostValue' may be a value of another " +
          `type here. ${STOPS} Check 'hostValue' first, as in 'if hostValue is integer { ... }'. ` +
          OUTSIDE("hostValue"),
      ],
    ],
    // C3
    [
      'if 1 { say "x" }\nexit\n',
      [
        "E TSV043 '1': A condition must be true or false (boolean), but '1' is a whole number (integer).",
      ],
    ],
    [
      "let y = not 1\nexit\n",
      ["E TSV043 '1': 'not' needs true or false (boolean), but '1' is a whole number (integer)."],
    ],
    [
      'let ok = hostValue\nif ok { say "x" }\nexit\n',
      [
        "W TSV043 'ok': A condition must be true or false (boolean), but 'ok' may be a value of another type " +
          `here. ${STOPS} Check 'ok' first, as in 'if ok is boolean { ... }'. ${OUTSIDE("ok")}`,
      ],
    ],
    // C4: the offending operand, else the operation
    [
      'let x = "s" - 1\nexit\n',
      ["E TSV043 '\"s\"': '-' needs a number, but '\"s\"' is text (string)."],
    ],
    [
      "let x = hostValue - 1\nexit\n",
      [
        "W TSV043 'hostValue': '-' needs a number, but 'hostValue' may be a value of another type here. " +
          `${STOPS} Check 'hostValue' first, as in 'if hostValue is number { ... }'. ${OUTSIDE("hostValue")}`,
      ],
    ],
    // C5a–c: a null receiver, a kind without the member, a property no source has at a read and at a store (ADR 1.4)
    [
      "let x = null\nsay x.length\nexit\n",
      [
        "E TSV043 'x.length': 'x' is null here, so it has no property 'length'. Give 'x' a value first.",
      ],
    ],
    [
      "let x = null\nx.add(1)\nexit\n",
      ["E TSV043 'x.add(1)': 'x' is null here, so it has no method 'add'. Give 'x' a value first."],
    ],
    [
      "let n = 1\nsay n.length\nexit\n",
      [
        "E TSV043 'n.length': A whole number (integer) has no property 'length', so 'n.length' cannot be used. " +
          "Convert 'n' to text first, as in 'toString(n).length'.",
      ],
    ],
    [
      "let x = {n: 1}\nsay x.other\nexit\n",
      ["E TSV043 'x.other': 'x' has no property 'other'. Its only property is 'n'."],
    ],
    [
      "let x = {n: 1}\nx.other = 2\nexit\n",
      [
        "E TSV043 '{n: 1}': This object has no property 'other', so 'x.other' on line 2 cannot set 'other'. Its " +
          "only property is 'n'. Add 'other' to this object.",
      ],
    ],
    // C6
    [
      "let xs = []\nsay xs.first\nexit\n",
      [`W TSV043 'xs.first': 'xs' may be empty here. ${STOPS} Check 'xs.length' first.`],
    ],
    // C10
    [
      'say (1 otherwise "x")\nexit\n',
      [
        "E TSV041 '\"x\"': The fallback '\"x\"' is text (string), but the value it stands in for is a number. " +
          "Use null or a value of that type instead.",
      ],
    ],
    [
      'let x = toInteger("3", default: "x")\nexit\n',
      [
        "E TSV041 '\"x\"': The default '\"x\"' is text (string), but the value it stands in for is a number. " +
          "Use null or a value of that type instead.",
      ],
    ],
    // C11
    [
      'say "${{a: 1}}"\nexit\n',
      ["E TSV042 '{a: 1}': '${...}' cannot show an object. Show one of its properties instead."],
    ],
    [
      'let s = "${hostValue}"\nexit\n',
      [
        "W TSV042 'hostValue': '${...}' shows its value as text, but 'hostValue' may be a value of another type " +
          `here. ${STOPS} ${OUTSIDE("hostValue")}`,
      ],
    ],
    // C12
    [
      "let d = dict{a: 1}\nsay d[1]\nexit\n",
      [
        "E TSV043 '1': A dict key is text (string), but '1' is a whole number (integer). Write a number key as " +
          "text, as in '\"1\"'.",
      ],
    ],
    // C13's iterable
    [
      "for x in 1 { }\nexit\n",
      [
        "E TSV012 '1': A 'for' loop goes through a list, set, dict, or range, but '1' is a whole number (integer).",
      ],
    ],
    // ADR 0021 1.3, A8: a literal's elements of one type
    [
      'let a = [1, "x"]\nexit\n',
      [
        "E TSV044 '\"x\"': This list mixes a number and text (string). A list holds one type. To keep both, " +
          "declare a union type, as in '(number | string)[]'.",
      ],
    ],
    [
      'let a = [{n: 1}, {n: "x"}]\nexit\n',
      [
        "E TSV044 '\"x\"': This list mixes a number and text (string) in 'n' of its elements. A list holds one " +
          "type. Give 'n' one type in every element.",
      ],
    ],
    // the whole path to the mixed part, through a record and through a collection
    [
      'let a = [{a: {n: 1}}, {a: {n: "x"}}]\nexit\n',
      [
        "E TSV044 '\"x\"': This list mixes a number and text (string) in 'a.n' of its elements. A list holds one " +
          "type. Give 'n' one type in every element.",
      ],
    ],
    [
      'let a = [{a: [1]}, {a: ["x"]}]\nexit\n',
      [
        "E TSV044 '\"x\"': This list mixes a number and text (string) in an element of 'a' of its elements. A list " +
          "holds one type. Use values of one type in it.",
      ],
    ],
    // a property named as an internal step stays a property
    [
      'let x = {element: 1}\nx.element = "bad"\nexit\n',
      [
        "E TSV041 '\"bad\"': 'x.element' holds a whole number (integer) since line 1, so it cannot take text " +
          "(string). Use a separate property for a value of another type.",
      ],
    ],
    [
      'let a = [{entry: 1}, {entry: "bad"}]\nexit\n',
      [
        "E TSV044 '\"bad\"': This list mixes a number and text (string) in 'entry' of its elements. A list holds " +
          "one type. Give 'entry' one type in every element.",
      ],
    ],
    // a store into an element names its collection, never an index the source does not have (#1195's decided text)
    [
      'let n = [1]\nn[0] = "x"\nexit\n',
      [
        "E TSV041 '\"x\"': 'n' holds whole numbers (integer[]) since line 1, so it cannot contain text (string). To " +
          "allow both, declare it as 'let n: (integer | string)[] = ...'.",
      ],
    ],
    // ADR 0021 rule 1.1 (A2, r4.75 (4)): a property only copies bring, at its first direct read, naming the copy
    [
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, b]\nrepeat xs[0].n {}\nexit\n',
      [
        "E TSV041 'xs[0].n': 'n' of an element of 'xs' holds a number, but 'b' on line 3 brings text (string) " +
          "into that property. Use a separate property for a value of another type.",
      ],
    ],
    // a copy made through a projection, named whole
    [
      'let bundle = {left: {n: 1}, right: {n: "bad"}}\nlet c = bundle.left\nc = bundle.right\nsay c.n\nexit\n',
      [
        "E TSV041 'c.n': 'c.n' holds a whole number (integer) since line 2, but 'bundle.right' on line 3 brings " +
          "text (string) into that property. Use a separate property for a value of another type.",
      ],
    ],
    // a direct store keeps its own error at its value, whatever names the value
    [
      'let a = {n: 1}\nlet c = a\nsay c.n\nlet wrong = "bad"\nc.n = wrong\nexit\n',
      [
        "E TSV041 'wrong': 'c.n' holds a whole number (integer) since line 2, so it cannot take text (string). Use " +
          "a separate property for a value of another type.",
      ],
    ],
    // V30 §13: a union holding a whole collection beside another type, with V30's suggestion where it has one
    [
      "let h: integer | string[] = 1\nexit\n",
      [
        "E TSV075 'integer | string[]': A union cannot hold a whole list, set, or dict beside another type, but " +
          "'integer | string[]' does. Write '(integer | string)[]' instead.",
      ],
    ],
    [
      "let f: integer[] | string[] = []\nexit\n",
      [
        "E TSV075 'integer[] | string[]': A union cannot hold a whole list, set, or dict beside another type, but " +
          "'integer[] | string[]' does. Write the union inside the collection instead.",
      ],
    ],
  ];
  for (const [source, expected] of cases)
    assert.deepEqual(messages(main(source)), expected, source);
});

test("a word that came with its value from another line names that value's origin, never this line's read as its subject (D1)", () => {
  // the cause, the last sentence of each warning of `code` at the site `site`
  const why = (source: string, code: string, site: string): string[] =>
    reported(main(source))
      .filter((found) => !found.error && found.code === code && found.site === site)
      .map((found) => found.message.split(/(?<=\.) (?=[A-Z'])/).at(-1)!);
  const count = (source: string, site: string, expected: string): void =>
    assert.deepEqual(why(source, "TSV011", site), [expected], source);
  const from = (name: string, origin: string): string => `'${name}' gets its value from ${origin}`;
  // each word read where it arises, then through a copy (or an operation, a call) that only carries it
  count(
    "let n = 1\nif hostValue { n = 1.5 }\nrepeat n {}\nexit\n",
    "n",
    "'n' is set inside an 'if' or another branch, so which value reaches this line depends on the choice.",
  );
  count(
    "let n = 1\nif hostValue { n = 1.5 }\nlet c = n\nrepeat c {}\nexit\n",
    "c",
    from("c", "an 'if' or another branch, so which value it gets depends on the choice."),
  );
  count(
    "let n = 1\nif hostValue { n = 1.5 }\nrepeat n + 1 {}\nexit\n",
    "n + 1",
    from("n + 1", "an 'if' or another branch, so which value it gets depends on the choice."),
  );
  count(
    "let n = 1\nrepeat 2 {\nrepeat n {}\nn = 1.5\n}\nexit\n",
    "n",
    "'n' may change in an earlier round of this loop.",
  );
  count(
    "let n = 1\nrepeat 2 {\nlet c = n\nrepeat c {}\nn = 1.5\n}\nexit\n",
    "c",
    from("c", "a variable that may change in an earlier round of a loop."),
  );
  count(
    "let n = 1\nfunction change { n = 1.5 }\nchange()\nrepeat n {}\nexit\n",
    "n",
    "'n' may be changed by a function or a file the script calls before this line.",
  );
  count(
    "let n = 1\nfunction change { n = 1.5 }\nchange()\nlet c = n\nrepeat c {}\nexit\n",
    "c",
    from("c", "a place that a function or a file the script calls may change."),
  );
  count(
    'let n = 1\nshowPermanentButton "x" { n = 1.5 }\nrepeat n {}\nexit\n',
    "n",
    "A button, timer, or media block may run before this line and change 'n'.",
  );
  count(
    'let n = 1\nshowPermanentButton "x" { n = 1.5 }\nlet c = n\nrepeat c {}\nexit\n',
    "c",
    from("c", "a place that a button, timer, or media block may change."),
  );
  count(
    "let n = 1\nlabel again\nlet c = n\nrepeat c {}\nn = 1.5\ngoto again\nexit\n",
    "c",
    from("c", "a line that is also reached by a 'goto'."),
  );
  count(
    "function use(n) {\nrepeat n {}\n}\nuse(1)\nuse(1.5)\nexit\n",
    "n",
    "'use' is called from more than one place, so 'n' may hold another type in each call.",
  );
  // (the parameter is `pick`'s, and `use` has one call)
  count(
    "function pick(n) { return n }\nfunction use { let c = pick(1)\nrepeat c {} }\nlet b = pick(1.5)\nuse()\nexit\n",
    "c",
    from("c", "a parameter of a function called from more than one place."),
  );
  count(
    "let xs = [1, 1.5]\nrepeat xs[0] {}\nexit\n",
    "xs[0]",
    "'xs[0]' is a list element, and any element of the list may be a number.",
  );
  count(
    "let xs = [1, 1.5]\nlet c = xs[0]\nrepeat c {}\nexit\n",
    "c",
    from("c", "a list element or a part of another value."),
  );
  count(
    'let room = {count: 1}\nif hostValue { room = {name: "hall"} }\nrepeat room.count {}\nexit\n',
    "room.count",
    "'room' may hold an object that has no 'count' property.",
  );
  // (every object `c` holds has `ok`: its value is what lacks a property)
  count(
    'let room = {n: 1}\nroom = {name: "hall"}\nlet c = {ok: room.n}\nrepeat c.ok {}\nexit\n',
    "c.ok",
    from("c.ok", "a property that an object may lack."),
  );
  // an object's own `first` is not followed either, and no reference is claimed for it
  count(
    "let x = {first: 1.5}\nrepeat x.first {}\nexit\n",
    "x.first",
    "The type of 'x.first' is known only when the script runs.",
  );
  count(
    "let x = {first: 1.5}\nlet c = x.first\nrepeat c {}\nexit\n",
    "c",
    "The type of 'c' is known only when the script runs.",
  );
  // a reference union: each warning names its own kind, and a speaker's alone gets the speaker's fix
  const member =
    "'x' may have no property 'n' here. If it has none, the Tease stops with an error at this line.";
  assert.deepEqual(
    reported(
      main("let x: speaker | timer = hostValue\nlet c = x.n\nlet d = c\nrepeat d {}\nexit\n"),
    )
      .filter((found) => found.site !== "hostValue")
      .map((found) => found.message),
    [
      `${member} Assign the property before this line, as in 'x.n = ...'. 'x' is a speaker, whose properties are ` +
        "known only when the script runs.",
      `${member} 'x' is a timer handle, whose properties are known only when the script runs.`,
      `${member} ${OUTSIDE("x")}`,
      `${COUNT}, but 'd' may be a value of another type here. ${STOPS} Check 'd' first, as in ` +
        "'if d is integer { ... }'. The type of 'd' is known only when the script runs.",
    ],
  );
});

test("every sentence of the set's records keeps the form: code in single quotes, no semicolon, the word never shown (D1)", (t) => {
  let count = 0;
  for (const record of records) {
    if (heldBack(record) !== null) continue;
    for (const { message: text } of reported(record.files)) {
      count += 1;
      // (code is quoted whole, so outside the quotes no semicolon, backquote or double quote stands)
      assert.ok(!/[;`"]/.test(text.replace(/'[^']*'/g, "")), `${record.name}: ${text}`);
      assert.ok(!/dead-code|deferred-parameter|unmodelled/.test(text), `${record.name}: ${text}`);
      // (#1195 rule 2: no implementation terms, "type" never "kind")
      assert.ok(
        !/\b(compiler|follows?|kinds?)\b/.test(text.replace(/'[^']*'/g, "")),
        `${record.name}: ${text}`,
      );
      assert.ok(text.endsWith("."), `${record.name}: ${text}`);
    }
  }
  t.diagnostic(`${count} sentences of the positive list`);
});

test("the developer warning for JSON that does not fit fromJson's expected type keeps the form (TSW020, TABLE r4.77 (5))", () => {
  const integer = { kind: "integer" } as const;
  assert.equal(
    jsonKindMismatch("x", integer),
    "'fromJson(...)' reads this JSON as a whole number (integer), but it is text (string), so the call gives its " +
      "default.",
  );
  assert.equal(
    jsonFieldMismatch({ path: ["age"], found: "x", type: integer }),
    "'fromJson(...)' reads 'age' of this JSON as a whole number (integer), but it is text (string), so the call " +
      "takes 'age' from its default.",
  );
  assert.equal(
    jsonFieldMismatch({ path: ["age"], found: undefined, type: integer }),
    "'fromJson(...)' reads 'age' of this JSON as a whole number (integer), but the JSON has no 'age', so the call " +
      "takes 'age' from its default.",
  );
});
