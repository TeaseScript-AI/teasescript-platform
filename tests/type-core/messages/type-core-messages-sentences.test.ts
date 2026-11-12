import assert from "node:assert/strict";
import test from "node:test";
import { jsonFieldMismatch, jsonKindMismatch } from "../../../src/runtime/values/value-types.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { reportedDiagnostics } from "../../../src/type-inference/core/check-result/check-result.js";
import { coreRequest, type SourceFile } from "../../helpers/type-core-analysis.js";
import { readFixture } from "../../helpers/type-core/type-core-fixture.js";
import {
  reported,
  main,
  STOPS,
  OUTSIDE,
} from "../../helpers/type-core/type-core-messages-setup.js";

/*
 * The sentences of the coarse core's diagnostics (D1–D3, `core/messages.ts`): each consumer's and
 * obligation's first sentence as an error and as a warning, with its rule's code and its fix (#1195), and each context
 * word's cause on the set's record for that word. The sentences are the owner's: a change here is a change of what an
 * author reads. The form of every sentence of the set's records is tested on the pairs' analysis of the set
 * (`type-core-messages-parity.test.ts`).
 */

const records = readFixture();

/** Each diagnostic of a project's analysis: `E` or `W`, its code, its site's text, and its message. */
function messages(files: readonly SourceFile[]): string[] {
  return reported(files).map(
    ({ error, code, site, message }) => `${error ? "E" : "W"} ${code} '${site}': ${message}`,
  );
}
const COUNT = "A repeat count must be a whole number (integer) of at least 0";
const ROUND = "Round the number with the floor, round or ceil function first.";

test("each context word's cause says why the value may be of another type, on the set's record for the word (D1)", () => {
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
      "'let copy: integer | string = source.removeAt(0)'.",
  ]);
  word("cp9-cells/F11/missing", [
    "W TSV043 'room.count': 'room' may hold an object without property 'count' here. If it does, the Tease stops " +
      "with an error at this line.",
  ]);
  word("cp9-cells/X6/branch-event", [
    `${count} 'n' is set inside an 'if' or another branch, so which value reaches this line depends on which ` +
      "branch runs.",
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
    // (an element is not set as a property is: no "that can be set", #1195 owner's review)
    "W TSV043 'value[0]': 'value' may not have elements here. If it does not, the Tease stops with an error at " +
      `this line. ${OUTSIDE("value")}`,
  ]);
  const speaker = "'player' is a speaker, whose properties are known only when the script runs.";
  // (in source order of their sites: the store's member read first)
  word("cp9-cells/F19a/direct", [
    // (a store into a speaker gives it the property: no stop, #1195 rule 3)
    "W TSV043 'player.n': 'player' may not have property 'n' here. A speaker takes the property when the script runs.",
    `W TSV011 'player.n': ${COUNT}, but 'player.n' may be a value of another type here. ${STOPS} Keep 'player.n' ` +
      "in a new variable, as in 'let value = player.n', and check it, as in 'if value is integer { repeat value {} }'. " +
      "The type of " +
      "'player.n' is known only when the script runs.",
    "W TSV043 'player.n': 'player' may not have property 'n' here. If it does not, the Tease stops with an error " +
      `at this line. Assign 'player.n' before this line. ${speaker}`,
  ]);
});

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
        "To allow both, declare it as 'let n: integer | string = 1'.",
    ],
  ],
  [
    "let n: integer = 1\nn = null\nexit\n",
    [
      "E TSV041 'null': 'n' is declared as a whole number (integer), so it cannot take null. To allow null, " +
        "declare it as 'let n: integer? = 1'.",
    ],
  ],
  // (#2289: a copy of a declared variable holds its type, and declares nothing itself; the owner's sentences)
  [
    "let lives: integer = 3\nlet copy = lives\ncopy = 2.5\nexit\n",
    [
      "E TSV041 '2.5': 'copy' holds a whole number (integer) because it is a copy of 'lives', declared " +
        "'integer' on line 1. To store other numbers in it, write 'let copy: number = lives'.",
    ],
  ],
  [
    "let lives: integer = 3\nlet scores = [lives]\nscores.add(2.5)\nexit\n",
    [
      "E TSV041 '2.5': 'scores' holds whole numbers (integer[]) because its elements are copies of 'lives', " +
        "declared 'integer' on line 1. To add other numbers to it, write 'let scores: number[] = [lives]'.",
    ],
  ],
  // (a later store's copy: its declaration's `null` start value would not fit 'let scores: number[] = null', so
  // the sentence that names the line stays, Codex r1 on #2317)
  [
    "let lives: integer = 3\nlet scores = null\nscores = [lives]\nscores.add(2.5)\nexit\n",
    [
      "E TSV041 '2.5': 'scores' holds whole numbers (integer[]) since line 3, so it cannot contain a number. " +
        ROUND,
    ],
  ],
  // (a global's `default:` is a second stored value: its `null` would not fit the fix's type, the final review's B1
  // on #2317, for a list and a set alike)
  [
    "let lives: integer = 3\nglobal scores = [lives], default: null\nscores.add(2.5)\nexit\n",
    [
      "E TSV041 '2.5': 'scores' holds whole numbers (integer[]) since line 2, so it cannot contain a number. " +
        ROUND,
    ],
  ],
  [
    "let lives: integer = 3\nglobal seen = set[lives], default: null\nseen.add(2.5)\nexit\n",
    [
      "E TSV041 '2.5': 'seen' holds whole numbers (integer set) since line 2, so it cannot contain a number. " +
        ROUND,
    ],
  ],
  // (#2289 R12: a dict's values take the list's sentence; a property, another type, a warning take the reason)
  [
    'let lives: integer = 3\nlet table = dict{a: lives}\ntable["b"] = 2.5\nexit\n',
    [
      "E TSV041 '2.5': 'table' holds whole numbers (integer dict) because its values are copies of 'lives', " +
        "declared 'integer' on line 1. To add other numbers to it, write 'let table: number dict = dict{a: lives}'.",
    ],
  ],
  [
    "let lives: integer = 3\nlet box = {count: lives}\nbox.count = 2.5\nexit\n",
    [
      "E TSV041 '2.5': 'box.count' holds a whole number (integer) because it is a copy of 'lives', declared " +
        `'integer' on line 1, so it cannot take a number. ${ROUND}`,
    ],
  ],
  [
    'let name: string = "Ann"\nlet copy = name\ncopy = 3\nexit\n',
    [
      "E TSV041 '3': 'copy' holds text (string) because it is a copy of 'name', declared 'string' on line 1, so " +
        "it cannot take a whole number (integer). To show '3' as text, write '\"${3}\"'.",
    ],
  ],
  [
    "let lives: integer = 3\nlet copy = lives\ncopy = hostValue\nexit\n",
    [
      "W TSV041 'hostValue': 'copy' holds a whole number (integer) because it is a copy of 'lives', declared " +
        `'integer' on line 1, but 'hostValue' may be a value of another type here. ${STOPS} Check 'hostValue' ` +
        `first, as in 'if hostValue is integer { copy = hostValue }'. ${OUTSIDE("hostValue")}`,
    ],
  ],
  // (a copy of a copy: no declared variable to name, so the line that decided it)
  [
    "let lives: integer = 3\nlet copy = lives\nlet again = copy\nagain = 2.5\nexit\n",
    [
      `E TSV041 '2.5': 'again' holds a whole number (integer) since line 3, so it cannot take a number. ${ROUND}`,
    ],
  ],
  [
    "let n: integer = hostValue\nexit\n",
    [
      "W TSV041 'hostValue': 'n' is declared as a whole number (integer), but 'hostValue' may be a value of " +
        `another type here. ${STOPS} Check that 'hostValue' is a whole number (integer) first. ` +
        OUTSIDE("hostValue"),
    ],
  ],
  // C2
  [
    "repeat 2.5 {}\nexit\n",
    [`E TSV011 '2.5': ${COUNT}, but '2.5' is a number that can have decimals. ${ROUND}`],
  ],
  // (a written `number?` known to hold null names the null, not the number: Codex r7 on #1717)
  [
    "let n: number? = null\nrepeat n {}\nexit\n",
    [`E TSV011 'n': ${COUNT}, but 'n' is null. Use a whole number here.`],
  ],
  [
    "let xs = [1, 2]\nlet y = xs[0.5]\nexit\n",
    [
      `E TSV043 '0.5': A list index must be a whole number (integer), but '0.5' is a number that can have decimals. ${ROUND}`,
    ],
  ],
  [
    "let xs = [1, 2]\nxs.removeAt(1.5)\nexit\n",
    [
      `E TSV043 '1.5': removeAt() needs a whole number (integer), but '1.5' is a number that can have decimals. ${ROUND}`,
    ],
  ],
  [
    "let xs = [1, 2]\nlet ys = xs.take(hostValue)\nexit\n",
    [
      "W TSV043 'hostValue': take() needs a whole number (integer), but 'hostValue' may be a value of another " +
        `type here. ${STOPS} Check that 'hostValue' is a whole number (integer) first. ` +
        OUTSIDE("hostValue"),
    ],
  ],
  // C3: the advice without an example where the value is no stable path (Astra r3)
  [
    'if 1 { say "x" }\nexit\n',
    [
      "E TSV043 '1': A condition must be true or false (boolean), but '1' is a whole number (integer). Compare " +
        "it instead.",
    ],
  ],
  [
    "let y = not 1\nexit\n",
    [
      "E TSV043 '1': 'not' needs true or false (boolean), but '1' is a whole number (integer). Compare it " +
        "instead.",
    ],
  ],
  [
    'let ok = hostValue\nif ok { say "x" }\nexit\n',
    [
      "W TSV043 'ok': A condition must be true or false (boolean), but 'ok' may be a value of another type " +
        `here. ${STOPS} Check 'ok' first, as in 'if ok is boolean { if ok { say "x" } }'. ${OUTSIDE("ok")}`,
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
        `${STOPS} Check that 'hostValue' is a number first. ${OUTSIDE("hostValue")}`,
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
  // a store into a speaker or an object: what happens to each (#1195 rule 3)
  [
    'let flagHost = askBoolean "f"\nlet x: speaker | object = player\nif flagHost { x = {m: 1} }\nx.n = 1\nexit\n',
    [
      "W TSV043 'x.n': 'x' may not have property 'n' here. If it is an object without 'n', the Tease stops with an " +
        "error at this line. A speaker takes the property. 'x' may be a speaker, whose properties are known only " +
        "when the script runs.",
      `W TSV043 'x.n': 'x' may hold an object without property 'n' here. If it does, the Tease stops with an error ` +
        "at this line.",
    ],
  ],
  // a method that changes its value, called on a speaker: no property is set, so no speaker takes one, and the fix
  // says what a speaker lacks (Astra r3 N1, Sol r7)
  [
    "function recipient { return player }\nlet target = recipient()\ntarget.add(73)\nexit\n",
    [
      "W TSV043 'target.add(73)': 'target' may not have method 'add' here. If it does not, the Tease stops with an " +
        "error at this line. A speaker has no methods. Use one of its properties instead.",
    ],
  ],
  // a method on a value from outside: called, not set; a literal index of it, with no test and no cause of its own
  // (the owner's review)
  [
    'let key = "k"\nlet v = load(key, default: null)\nv.add(2)\nexit\n',
    [
      // (no check in code: 'v' may also lack the method there, which a null check does not rule out, #1449;
      // the load's null reaches the call by a route without a check: the route rule's error, AD-1)
      `E TSV043 'v.add(2)': 'v' must be checked for null before it is used here: 'load' on line 2 can give null. ` +
        "Check that 'v' is not null first.",
      `W TSV043 'v.add(2)': 'v' may not have method 'add' here. If it does not, the Tease stops with an error at ` +
        `this line. ${OUTSIDE("v")}`,
    ],
  ],
  [
    'let key = "k"\nlet value = load(key, default: null)\nsay value.get(0, default: 3)\nexit\n',
    [
      // (the load's null reaches the call by a route without a check: the route rule's error, AD-1)
      `E TSV043 'value.get(0, default: 3)': 'value' must be checked for null before it is used here: 'load' on ` +
        "line 2 can give null. Check that 'value' is not null first, or give a fallback of the same type with 'otherwise'.",
      "W TSV043 'value.get(0, default: 3)': 'value' may not have method 'get' here. If it does not, the Tease " +
        `stops with an error at this line. ${OUTSIDE("value")}`,
      `W TSV043 '0': A list index must be a whole number (integer), but '0' may be a value of another type here. ${STOPS}`,
      `W TSV043 '0': A dict key is text (string), but '0' may be a value of another type here. ${STOPS}`,
    ],
  ],
  // (a text literal with an escape is a literal too: classified by the parser, Sol r5)
  [
    'let key = "k"\nlet value = load(key, default: null)\nsay value.get("a\\"b", default: 3)\nexit\n',
    [
      // (the load's null reaches the call by a route without a check: the route rule's error, AD-1)
      `E TSV043 'value.get("a\\"b", default: 3)': 'value' must be checked for null before it is used here: 'load' ` +
        "on line 2 can give null. Check that 'value' is not null first, or give a fallback of the same type with 'otherwise'.",
      `W TSV043 'value.get("a\\"b", default: 3)': 'value' may not have method 'get' here. If it does not, the ` +
        `Tease stops with an error at this line. ${OUTSIDE("value")}`,
      `W TSV043 '"a\\"b"': A list index must be a whole number (integer), but '"a\\"b"' may be a value of another ` +
        `type here. ${STOPS}`,
      `W TSV043 '"a\\"b"': A dict key is text (string), but '"a\\"b"' may be a value of another type here. ${STOPS}`,
    ],
  ],
  // a possible null as an operand of an operator: its fallback in parentheses, as the parser asks of `otherwise`
  [
    "let xs = [7, null]\nsay xs[0] + 1\nexit\n",
    [
      `W TSV043 'xs[0]': '+' needs a number, but 'xs[0]' may be null here. ${STOPS} Keep 'xs[0]' in a new variable, ` +
        "as in 'let value = xs[0]', and check it, as in 'if value != null { say value + 1 }', or give a fallback, " +
        "as in " +
        "'(xs[0] otherwise 0)'. 'xs[0]' is a list element, and any element of the list may be null.",
    ],
  ],
  // C6
  [
    "let xs = []\nsay xs.first\nexit\n",
    [
      `W TSV043 'xs.first': 'xs' may be empty here. ${STOPS} Check 'xs.length' first, as in ` +
        "'if xs.length > 0 { say xs.first }'.",
    ],
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
    [
      "E TSV042 '{a: 1}': '${{a: 1}}' cannot show an object. Show one of its properties instead, as in " +
        "'${{a: 1}.a}'.",
    ],
  ],
  [
    'let s = "${hostValue}"\nexit\n',
    [
      "W TSV042 'hostValue': '${hostValue}' shows its value as text, but 'hostValue' may be a value of another type " +
        `here. ${STOPS} ${OUTSIDE("hostValue")}`,
    ],
  ],
  // C12
  [
    "let d = dict{a: 1}\nsay d[1]\nexit\n",
    [
      // (a key written as a literal: the sentence alone, Astra r1)
      "E TSV043 '1': A dict key is text (string), but '1' is a whole number (integer). Write a number key as " +
        "text.",
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
      // (the current checker's sentences, the elements' own types, the owner's review)
      "E TSV044 '\"x\"': This list mixes a whole number (integer) and text (string). A list holds one type. To " +
        "allow both, declare it as 'let a: (integer | string)[] = [1, \"x\"]'.",
    ],
  ],
  [
    'let a = [{n: 1}, {n: "x"}]\nexit\n',
    [
      "E TSV044 '\"x\"': This list mixes objects whose property 'n' holds a whole number (integer) in one and " +
        "text (string) in another. A list holds one type. Give 'n' one type in every element.",
    ],
  ],
  // the whole path to the mixed part, through a record and through a collection
  [
    'let a = [{a: {n: 1}}, {a: {n: "x"}}]\nexit\n',
    [
      "E TSV044 '\"x\"': This list mixes objects whose property 'a.n' holds a whole number (integer) in one " +
        "and text (string) in another. A list holds one type. Give 'a.n' one type in every element.",
    ],
  ],
  [
    'let a = [{a: [1]}, {a: ["x"]}]\nexit\n',
    [
      "E TSV044 '\"x\"': This list mixes objects whose property 'a' holds a list (integer[]) in one and a list " +
        "(string[]) in another. A list holds one type. Give 'a' one type in every element.",
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
      "E TSV044 '\"bad\"': This list mixes objects whose property 'entry' holds a whole number (integer) in one " +
        "and text (string) in another. A list holds one type. Give 'entry' one type in every element.",
    ],
  ],
  // a store into an element names its collection, never an index the source does not have (#1195's decided text)
  [
    'let n = [1]\nn[0] = "x"\nexit\n',
    [
      "E TSV041 '\"x\"': 'n' holds whole numbers (integer[]) since line 1, so it cannot contain text (string). To " +
        "allow both, declare it as 'let n: (integer | string)[] = [1]'.",
    ],
  ],
  // ADR 0021 rule 1.1 (A2): a property only copies bring, where the copy meets the place
  [
    'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, b]\nrepeat xs[0].n {}\nexit\n',
    [
      "E TSV044 'b': This list mixes objects whose property 'n' holds a whole number (integer) in one and text " +
        "(string) in another. A list holds one type. Give 'n' one type in every element.",
    ],
  ],
  // a copy made through a projection, at the store that brings it
  [
    'let bundle = {left: {n: 1}, right: {n: "bad"}}\nlet c = bundle.left\nc = bundle.right\nsay c.n\nexit\n',
    [
      "E TSV041 'bundle.right': 'c.n' holds a whole number (integer) since line 2, so it cannot take text " +
        "(string). Use a separate property for a value of another type.",
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

test("each consumer's first sentence and fix, as an error and as a warning, with its rule's code (D1, D3, #1195)", () => {
  for (const [source, expected] of cases)
    assert.deepEqual(messages(main(source)), expected, source);
});

/**
 * The route rule's error for a null names what brings it, one sentence per cause (the owner, 2026-11-11, #2287): each
 * row of `nullCause` once, the line its own, and the error's code, site and advice as the rule gives them.
 */
test("the route rule's error for a null says it must be checked, and what brings the null, by its writer (#2287)", () => {
  const first = (subject: string, cause: string): string =>
    `'${subject}' must be checked for null before it is used here: ${cause}.`;
  const cases: readonly (readonly [string, string, string])[] = [
    // a `null` stored: #2287's own script, where the arms exclude each other
    [
      "let n = 1\nif hostValue is boolean { n = null }\nif hostValue is not boolean { repeat n {} }\nexit\n",
      "n",
      first("n", "it is set to null on line 2"),
    ],
    // a parameter's default some call omits, and a property of an object written with null, also two lines down
    [
      "function f(n: integer? = null) {\n  repeat n {}\n}\nf()\nf(2)\nexit\n",
      "n",
      first("n", "it is set to null on line 1"),
    ],
    [
      "let o = { p: { x: 1 } }\nif hostValue is boolean {\n  o = {\n    p: { x: null }\n  }\n}\nrepeat o.p.x {}\nexit\n",
      "o.p.x",
      first("o.p.x", "it is set to null on line 4"),
    ],
    // a `load`, stored and where it is used
    [
      'let a: integer? = load("k", default: null)\nif a != null { let b: integer? = load("k", default: null)\nrepeat b {} }\nexit\n',
      "b",
      first("b", "'load' on line 2 can give null"),
    ],
    // a copy, of a variable and of a property (#2287's second form)
    [
      "let n: integer? = 1\nif hostValue is boolean { n = null }\nlet b = n\nrepeat b {}\nexit\n",
      "b",
      first("b", "it is a copy of 'n' (line 3), which can hold null"),
    ],
    [
      "let o = { x: 1 }\nif hostValue is boolean { o.x = null }\nlet b = o.x\nrepeat b {}\nexit\n",
      "b",
      first("b", "it is a copy of 'o.x' (line 3), which can hold null"),
    ],
    // an `otherwise` whose fallback is null (#2287's third form)
    [
      "let a = null\nif hostValue is boolean { a = 1 }\nlet b = a otherwise null\nrepeat b {}\nexit\n",
      "b",
      first("b", "'a otherwise null' on line 3 can give null"),
    ],
    // another call, by its function's name
    [
      'let p = "abc".indexOf("b")\nrepeat p {}\nexit\n',
      "p",
      first("p", "'indexOf' on line 1 can give null"),
    ],
    [
      'let v: integer? = fromJson("1", default: null)\nrepeat v {}\nexit\n',
      "v",
      first("v", "'fromJson' on line 1 can give null"),
    ],
    // a selection, where it is used
    [
      "let xs = [1, null]\nrepeat xs.last {}\nexit\n",
      "xs.last",
      first("xs.last", "'xs.last' on line 2 can give null"),
    ],
    // an element, of a list and of a dict
    [
      "let xs = [1, null]\nlet e = xs[0]\nrepeat e {}\nexit\n",
      "e",
      first("e", "an element of 'xs' (line 2) can be null"),
    ],
    [
      'let d = dict{"a": 1, "b": null}\nlet v = d["a"]\nsay v + 1\nexit\n',
      "v",
      first("v", "an element of 'd' (line 2) can be null"),
    ],
  ];
  for (const [source, subject, sentence] of cases) {
    const errors = reported(main(source)).filter(({ error }) => error);
    assert.equal(errors.length, 1, source);
    assert.ok(errors[0]!.message.startsWith(`${sentence} `), `${source}\n${errors[0]!.message}`);
    assert.ok(errors[0]!.message.includes(`'${subject}'`), source);
  }
});

test("a union beside a set or a dict suggests the union inside it, in the list's sentence (#1104 point 3)", () => {
  const sentence = (union: string, fix: string): string[] => [
    `E TSV075 '${union}': A union cannot hold a whole list, set, or dict beside another type, but '${union}' ` +
      `does. ${fix}`,
  ];
  const write = (suggestion: string): string => `Write '${suggestion}' instead.`;
  const inside = "Write the union inside the collection instead.";
  const cases: readonly (readonly [string, string])[] = [
    // the list's sentence, which the set's and the dict's follow
    ["integer | string[]", write("(integer | string)[]")],
    ["integer | string set", write("(integer | string) set")],
    ["string dict | integer", write("(string | integer) dict")],
    // three members, and a `?` where it is written: on a member, on the element, on the collection
    ["integer | boolean | string set", write("(integer | boolean | string) set")],
    ["integer? | string dict", write("(integer? | string) dict")],
    ["integer | string?[]?", write("(integer | string?)[]?")],
    // no suggestion: `null` beside the collection may as well make it optional; the element beside it is `g`'s form
    ["integer | string set | null", inside],
    ["string | string dict", inside],
  ];
  for (const [union, fix] of cases)
    assert.deepEqual(
      messages(main(`function use(x: ${union}) {\n}\nexit\n`)),
      sentence(union, fix),
      union,
    );
});

test("a warning whose expression never runs is not reported, as the line's TSV065 says it; an error there is (#1195)", () => {
  const shown = (source: string): string[] => {
    const request = coreRequest(main(source));
    assert.ok(request !== null, source);
    return reportedDiagnostics(analyseCore(request)).map(
      (diagnostic) => `${diagnostic.class === "compile-error" ? "E" : "W"} ${diagnostic.code}`,
    );
  };
  const read = 'let key = "n"\n';
  // a branch, the right side of `and` and `or`, code after a function's `return`
  assert.deepEqual(shown(`${read}if false { say load(key, default: "") - 1 }\nexit\n`), []);
  assert.deepEqual(shown(`${read}say false and (load(key, default: "") - 1 > 0)\nexit\n`), []);
  assert.deepEqual(shown(`${read}say true or (load(key, default: "") - 1 > 0)\nexit\n`), []);
  assert.deepEqual(
    shown(`function f {\nreturn\n${read}say load(key, default: "") - 1\n}\nf()\nexit\n`),
    [],
  );
  // an expression that runs before its statement ends early, and a store's error that never runs
  assert.deepEqual(
    shown(
      `function stop { exit }\n${read}function use(a, b) { say a }\n` +
        'use(load(key, default: "") - 1, stop())\nexit\n',
    ),
    ["W TSV043"],
  );
  assert.deepEqual(shown('if false { let n: integer = "x" }\nexit\n'), ["E TSV041"]);
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
    "'n' is set inside an 'if' or another branch, so which value reaches this line depends on which branch runs.",
  );
  count(
    "let n = 1\nif hostValue { n = 1.5 }\nlet c = n\nrepeat c {}\nexit\n",
    "c",
    from("c", "an 'if' or another branch, so which value it gets depends on which branch runs."),
  );
  count(
    "let n = 1\nif hostValue { n = 1.5 }\nrepeat n + 1 {}\nexit\n",
    "n + 1",
    from(
      "n + 1",
      "an 'if' or another branch, so which value it gets depends on which branch runs.",
    ),
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
  // (the parameter is `pick`'s, and `use` has one call; `pick` copies before it returns, so the analysis does not read
  // its call as the argument, as it reads an identity function's: r4.452)
  count(
    "function pick(n) {\n  let m = n\n  return m\n}\nfunction use { let c = pick(1)\nrepeat c {} }\nlet b = pick(1.5)\nuse()\nexit\n",
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
  // (no type test and no cause where the read itself stops: the member warning at that read says it, the owner's review)
  count(
    'let room = {count: 1}\nif hostValue { room = {name: "hall"} }\nrepeat room.count {}\nexit\n',
    "room.count",
    STOPS,
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
    "'x' may not have property 'n' here. If it does not, the Tease stops with an error at this line.";
  assert.deepEqual(
    reported(
      main("let x: speaker | timer = hostValue\nlet c = x.n\nlet d = c\nrepeat d {}\nexit\n"),
    )
      .filter((found) => found.site !== "hostValue")
      .map((found) => found.message),
    [
      `${member} Assign 'x.n' before this line. 'x' may be a speaker, whose properties are known only when the ` +
        "script runs.",
      `${member} 'x' may be a timer handle, whose properties are known only when the script runs.`,
      `${member} ${OUTSIDE("x")}`,
      `${COUNT}, but 'd' may be a value of another type here. ${STOPS} Check 'd' first, as in ` +
        "'if d is integer { repeat d {} }'. The type of 'd' is known only when the script runs.",
    ],
  );
});

test("the developer warning for JSON that does not fit fromJson's expected type keeps the form (TSW020)", () => {
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
