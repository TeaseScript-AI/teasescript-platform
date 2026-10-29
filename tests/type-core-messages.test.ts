import assert from "node:assert/strict";
import test from "node:test";
import { jsonFieldMismatch, jsonKindMismatch } from "../src/runtime/values/value-types.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { checkedResult, reportedDiagnostics } from "../src/type-inference/core/consumer.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { coreMessage, messageSource } from "../src/type-inference/core/messages.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import { readFixture } from "./helpers/type-core-fixture.js";

/*
 * The sentences of the coarse core's diagnostics (D1–D3, TABLE r4.53, `core/messages.ts`): each consumer's and
 * obligation's first sentence as an error and as a warning, with its rule's code and its fix (#1195), and each context
 * word's cause on the set's record for that word. The sentences are the owner's: a change here is a change of what an
 * author reads. The form of every sentence of the set's records is tested on the pairs' analysis of the set
 * (`type-core-message-parity.test.ts`).
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
  const { diagnostics } = analyseCore(request);
  const source = messageSource(
    files.map((file) => file.source),
    diagnostics,
  );
  return diagnostics.map((diagnostic) => ({
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
const ROUND = "Round the number with the floor, round or ceil function first.";

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
  // (in source order of their sites: the store's member read first, r4.86 (1))
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
    [
      "let n: integer = hostValue\nexit\n",
      [
        "W TSV041 'hostValue': 'n' is declared as a whole number (integer), but 'hostValue' may be a value of " +
          `another type here. ${STOPS} Check that 'hostValue' is a whole number (integer) first. ` +
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
        // (no check in code: 'v' may also lack the method there, which a null check does not rule out, TABLE r4.162)
        `W TSV043 'v.add(2)': 'v' may be null here. ${STOPS} Check that 'v' is not null first.`,
        `W TSV043 'v.add(2)': 'v' may not have method 'add' here. If it does not, the Tease stops with an error at ` +
          `this line. ${OUTSIDE("v")}`,
      ],
    ],
    [
      'let key = "k"\nlet value = load(key, default: null)\nsay value.get(0, default: 3)\nexit\n',
      [
        `W TSV043 'value.get(0, default: 3)': 'value' may be null here. ${STOPS} Check that 'value' is not null ` +
          "first, or give a fallback of the same type with 'otherwise'.",
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
        `W TSV043 'value.get("a\\"b", default: 3)': 'value' may be null here. ${STOPS} Check that 'value' is not ` +
          "null first, or give a fallback of the same type with 'otherwise'.",
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
    // ADR 0021 rule 1.1 (A2, TABLE r4.131): a property only copies bring, where the copy meets the place
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
  for (const [source, expected] of cases)
    assert.deepEqual(messages(main(source)), expected, source);
});

/**
 * #1272 (V30 §4 and §16, ADR 0021 1.3): a list's `+` and `+=` hold both lists' elements, so elements of another type
 * mix as in a literal: the current checker's error and sentence at the join (a `+=`'s at its right operand), its fix on
 * the first operand's variable or parameter, `values` for any other. Later uses see the left list's elements (A6): a
 * read of the joined list and a store of it into a decided place add nothing. A nested join's fix writes the union
 * inside the lists, which V30 §13 permits (the current checker's `(integer[] | string[])[]` it forbids). Numbers beside
 * whole numbers, `null` and empty lists mix nothing, and a written union admits both, as the variable's (A4) or as the
 * place the join lands in (A1, where the current checker errs).
 */
test("a list's '+' mixes element types as a literal does, with the current checker's sentence at the join (#1272)", () => {
  const sited = (source: string): string[] => {
    const request = coreRequest(main(source));
    assert.ok(request !== null, source);
    const answers = analyseCore(request);
    const text = messageSource([source], answers.diagnostics);
    return [...reportedDiagnostics(answers)].map(
      (diagnostic) =>
        `${diagnostic.code} [${diagnostic.site.start},${diagnostic.site.end}) ${coreMessage(diagnostic, text)}`,
    );
  };
  const mix = (operator: string, kinds: string, fix: string): string =>
    `'${operator}' would mix ${kinds}. A list holds one type. To allow both, ${fix}.`;
  const integerString = "a whole number (integer) and text (string)";
  // (the declaration whose start value the joined list is, with its own start value; else the type in words: #1268)
  const declared = (code: string): string => `declare the list as '${code}'`;
  const typed = (type = "(integer | string)[]"): string =>
    `declare the list with the type '${type}'`;
  for (const [source, expected] of [
    [
      'let xs = [1]\nlet more = xs + ["x"]\nsay more.length\nexit',
      `TSV044 [24,34) ${mix("+", integerString, declared('let more: (integer | string)[] = xs + ["x"]'))}`,
    ],
    ['say ([1] + ["x"]).length\nexit', `TSV044 [5,16) ${mix("+", integerString, typed())}`],
    [
      'let xs = [1]\nlet ys = ["x"]\nlet both = xs + ys\nsay both.length\nexit',
      `TSV044 [39,46) ${mix("+", integerString, declared("let both: (integer | string)[] = xs + ys"))}`,
    ],
    ['let xs = [1]\nxs += ["x"]\nexit', `TSV044 [19,24) ${mix("+=", integerString, typed())}`],
    [
      'let box = {items: [1]}\nbox.items = box.items + ["x"]\nexit',
      `TSV044 [35,52) ${mix("+", integerString, typed())}`,
    ],
    [
      'let xs = [1]\nlet both = xs + ["x"]\nsay both[1] + 1\nexit',
      `TSV044 [24,34) ${mix("+", integerString, declared('let both: (integer | string)[] = xs + ["x"]'))}`,
    ],
    [
      'let left = {items: [true]}\nlet right = {items: ["x"]}\nlet both = left.items + right.items\nsay both.length\nexit',
      `TSV044 [65,89) ${mix("+", "true or false (boolean) and text (string)", declared("let both: (boolean | string)[] = left.items + right.items"))}`,
    ],
    [
      'function f(xs = [1]) {\n  return xs + ["x"]\n}\nsay f().length\nexit',
      `TSV044 [32,42) ${mix("+", integerString, typed())}`,
    ],
    [
      'function f(xs = [1] + ["x"]) {\n  say xs.length\n}\nf()\nexit',
      `TSV044 [16,27) ${mix("+", integerString, "declare the parameter as 'xs: (integer | string)[] = [1] + [\"x\"]'")}`,
    ],
    [
      'global gs = [1] + ["x"]\nexit',
      `TSV044 [12,23) ${mix("+", integerString, declared('global gs: (integer | string)[] = [1] + ["x"]'))}`,
    ],
    [
      'let xs = [[1]]\nlet more = xs + [["x"]]\nsay more.length\nexit',
      `TSV044 [26,38) ${mix("+", "a list (integer[]) and a list (string[])", declared('let more: (integer | string)[][] = xs + [["x"]]'))}`,
    ],
    [
      'let c = [{n: 1}] + [{n: "x"}]\nsay c.length\nexit',
      "TSV044 [8,29) '+' would mix objects whose property 'n' holds a whole number (integer) in one and text " +
        "(string) in another. A list holds one type. Give 'n' one type in every element.",
    ],
    // host data beside a known element decides nothing, as in a literal; a join's right operand that holds joins is
    // read with its left neighbours in source order (Codex r1 on #1310)
    [
      'let both = [1, hostValue] + ["x"] + [2]\nexit',
      `TSV044 [11,33) ${mix("+", integerString, declared('let both: (integer | string)[] = [1, hostValue] + ["x"] + [2]'))}`,
    ],
    [
      'let xs = [1] + ([2] + ["x"])\nexit',
      `TSV044 [16,27) ${mix("+", integerString, declared('let xs: (integer | string)[] = [1] + ([2] + ["x"])'))}`,
    ],
    // whole numbers beside numbers in one operand are numbers (Codex r2 on #1310); a join in a right operand is decided
    // on its own
    [
      'let both = [1, 1.5] + ["x"]\nexit',
      `TSV044 [11,27) ${mix("+", "a number and text (string)", declared('let both: (number | string)[] = [1, 1.5] + ["x"]'))}`,
    ],
    [
      'let ys = [1]\nlet both = [1] + (ys + ["x"])\nexit',
      `TSV044 [31,41) ${mix("+", integerString, declared('let both: (integer | string)[] = [1] + (ys + ["x"])'))}`,
    ],
    // null elements decide nothing, but each side's sentence and the union the fix writes hold them (Codex r3 on #1310)
    [
      'let xs = [1, null]\nlet both = xs + ["x"]\nexit',
      `TSV044 [30,40) ${mix("+", "a whole number (integer) or null and text (string)", declared('let both: (integer | string | null)[] = xs + ["x"]'))}`,
    ],
    [
      'let xs = [1]\nlet both = xs + ["x", null]\nexit',
      `TSV044 [24,40) ${mix("+", "a whole number (integer) and text (string) or null", declared('let both: (integer | string | null)[] = xs + ["x", null]'))}`,
    ],
    // a function's written result decides as a variable's written type does (Codex r5 on #1310)
    [
      'function make: (integer | boolean)[] {\n  return [1]\n}\nlet both = make() + ["x"]\nexit',
      `TSV044 [65,79) ${mix("+", "a whole number (integer) or true or false (boolean) and text (string)", declared('let both: (integer | boolean | string)[] = make() + ["x"]'))}`,
    ],
    // a run of joins has one element type, whole numbers beside numbers numbers
    [
      'say ([1] + [1.5] + ["x"]).length\nexit',
      `TSV044 [5,24) ${mix("+", "a number and text (string)", typed("(number | string)[]"))}`,
    ],
    // an operand reaching an earlier join takes its composed type: beside a part holding only `null`, which decides
    // nothing but keeps its `null` (Codex r15's N1 on #1310)
    [
      "let s = [[null], ([1] + [2])][0] + [true]\nexit",
      `TSV044 [8,41) ${mix("+", "a whole number (integer) or null and true or false (boolean)", declared("let s: (integer | boolean | null)[] = [[null], ([1] + [2])][0] + [true]"))}`,
    ],
    ["let xs = [1]\nlet b = [1.5]\nsay (xs + b).length\nexit", null],
    ['let xs = []\nlet more = xs + ["x"]\nsay more.length\nexit', null],
    ["let xs = [1]\nlet more = xs + []\nsay more.length\nexit", null],
    ["let xs = [1]\nlet more = xs + [null]\nsay more.length\nexit", null],
    ['let xs: (integer | string)[] = [1]\nlet both = xs + ["x"]\nsay both.length\nexit', null],
    [
      'let xs: (integer | string)[][] = [[1]]\nlet more = xs + [["x"]]\nsay more.length\nexit',
      null,
    ],
    ['let ys: (integer | string)[] = ["x"]\nlet both = [1] + ys\nsay both.length\nexit', null],
    ['let xs = [1]\nlet both: (integer | string)[] = xs + ["x"]\nsay both.length\nexit', null],
  ] as const)
    assert.deepEqual(sited(source), expected === null ? [] : [expected], source);
});

/**
 * #1272 (Astra's B1, Codex r7's B1 on #1310, ADR 0021 1.3, 1.10): a join answers the same written inline as kept in a
 * variable first, its elements' type the one a variable holding them is decided by. Unions declared on the left
 * operand, on the right, on both, alike or overlapping (`(integer | string)[]` beside `(integer | boolean)[]`), or
 * none; the join inline in a store (as either operand of another join), a join nested a level deeper, an interpolation,
 * beside text or a truth value; both orders, the sharing on and off. Each inline form errs as its kept form does, with
 * the same kinds; inline in an argument the join lands in the parameter's written union, which holds both (A1).
 */
/**
 * A source's compile errors, a list join's with its decided and offending kinds, the same in both orders with the
 * sharing on and off.
 */
function joinAnswers(source: string): string[] {
  const request = coreRequest(main(source));
  assert.ok(request !== null, source);
  const runs: string[][] = [];
  for (const shared of [true, false])
    for (const reversed of [false, true]) {
      const go = () => analyseCore(request);
      const ordered = reversed
        ? () =>
            withConsumerOrder(
              (list) => [...list].reverse(),
              () => withSolverSeam({ reverseWorklist: true }, go),
            )
        : go;
      const answers = shared ? ordered() : withoutSharing(ordered);
      runs.push(
        [...reportedDiagnostics(answers)]
          .filter((diagnostic) => diagnostic.class === "compile-error")
          .map((diagnostic) =>
            "rule" in diagnostic && diagnostic.rule.rule === "mixed"
              ? `${diagnostic.code} ${JSON.stringify([diagnostic.rule.type, diagnostic.kinds])}`
              : diagnostic.code,
          ),
      );
    }
  for (const run of runs) assert.deepEqual(run, runs[0], source);
  return runs[0]!;
}

test("a list join answers the same inline as kept in a variable (#1272)", () => {
  const answers = joinAnswers;
  const joins = { left: "typed + [1]", right: "[1] + typed", both: "typed + other" };
  const contexts = [
    (join: string, beside: string) => `let result = ${beside} + ${join}\nsay result.length`,
    (join: string, beside: string) => `let result = ${join} + ${beside}\nsay result.length`,
    (join: string, beside: string) => `show(${beside} + ${join})`,
    (join: string, beside: string) => `let result = [2] + (${beside} + ${join})\nsay result.length`,
    (join: string, beside: string) => `say "\${(${join} + ${beside}).length}"`,
  ];
  const show = "function show(xs: (integer | string)[]) {\n  say xs.length\n}\n";
  const declarations = {
    none: ["", ""],
    alike: [": (integer | string)[]", ": (integer | string)[]"],
    overlapping: [": (integer | string)[]", ": (integer | boolean)[]"],
  };
  for (const [declared, [typed, other]] of Object.entries(declarations))
    for (const beside of ['["b"]', "[true]"])
      for (const [position, join] of Object.entries(joins))
        for (const context of contexts) {
          const start = `${show}let typed${typed} = ["a"]\nlet other${other} = [2]\n`;
          const inline = answers(`${start}${context(`(${join})`, beside)}\nexit\n`);
          const name = `${declared} ${position}: ${context("J", beside)}`;
          if (context("J", beside).startsWith("show(")) {
            if (beside === '["b"]' && declared === "alike") assert.deepEqual(inline, [], name);
            continue;
          }
          const kept = answers(`${start}let inner = ${join}\n${context("inner", beside)}\nexit\n`);
          // (kept, the inner join's error comes on its own line first)
          assert.deepEqual(inline.toSorted(), kept.toSorted(), name);
          // (a union holds the text beside it, never a truth value beside it that neither declaration holds)
          if (declared === "alike" && beside === '["b"]') assert.deepEqual(inline, [], name);
          if (declared !== "none" && beside === "[true]" && position === "both")
            assert.ok(
              inline.some((answer) => answer.startsWith("TSV044")),
              name,
            );
        }
});

/**
 * #1272 (Astra r2's B1 and Codex r9's B1 on #1310, ADR 0021 1.3, V30 §13 and §16, `joinedDomain`): an operand's element
 * domain decides a join as it decides a variable holding the join. An open one (`list`, `list[]` with or without an
 * element yet) leaves the join open there and below, whatever decided before or after it, a written type included, so
 * nothing beside it errs and a variable holding the join takes any element; one that holds only `null` (`null[]`,
 * `null[][]`) decides nothing and makes the joined list optional, so a join errs only where its other operands
 * conflict, and a variable holding it takes `null`; a strict written destination stays strict. Each domain (beside a
 * concrete, a nullable written, a written union and a two-level one) as either operand of a join, alone or nested in
 * either operand of another, beside whole numbers, text, `null` or a written `integer[]` before or after it; a binding,
 * a copy, a call with a written result, and a call returning it inferred (inline only, #1393); inline as kept, both
 * orders, the sharing on and off.
 */
test("an open or null-only operand proves no conflict in a list join, inline as kept (#1272)", () => {
  const domains = [
    ["concrete", 1, "let d = [1]"],
    ["nullable", 1, "let d: integer?[] = [1]"],
    ["union", 1, "let d: (integer | string)[] = [1]"],
    ["open", 1, "let d: list = [1]"],
    ["null", 1, "let d: null[] = [null]"],
    ["two-concrete", 2, "let d = [[1]]"],
    ["two-open", 2, "let d: list[] = [[1]]"],
    ["two-open-empty", 2, "let d: list[] = []"],
    ["two-null", 2, "let d: null[][] = [[null]]"],
  ] as const;
  // (whole numbers, text, `null`, and `w`, a written `integer[]`: before, after or beside the domain's operand)
  const neighbours = { I: "2", S: '"tail"', N: "null", W: "w" } as const;
  const positions = [
    ["left", "X", (j: string) => j],
    ["right", "X", (j: string) => j],
    ["left of left", "XY", (j: string) => `${j} + Y`],
    ["right of left", "XY", (j: string) => `${j} + Y`],
    ["left of right", "XY", (j: string) => `Y + ${j}`],
    ["right of right", "XY", (j: string) => `Y + ${j}`],
  ] as const;
  const pairs = [
    ["I", "S"],
    ["N", "S"],
    ["S", "I"],
    ["W", "S"],
    ["S", "W"],
  ] as const;
  let checked = 0;
  for (const [domain, depth, declaration] of domains) {
    const wrap = (element: string) =>
      element === "w" ? element : "[".repeat(depth) + element + "]".repeat(depth);
    const forms: (readonly [string, string, string])[] = [["binding", "", "d"]];
    if (domain === "open" || domain === "null")
      forms.push(
        ["copy", "let c = d\n", "c"],
        [
          "written call",
          `function make: ${domain === "open" ? "list" : "null[]"} {\n  return d\n}\n`,
          "make()",
        ],
      );
    if (domain === "open" || domain === "union")
      forms.push(["inferred call", "function make {\n  return d\n}\n", "make()"]);
    const open = domain.includes("open");
    const nulls = domain === "null" || domain === "two-null";
    for (const [form, extra, d] of forms)
      for (const [position, uses, outer] of positions)
        for (const [x, y] of uses === "X"
          ? (["I", "S", "N", "W"] as const).map((x) => [x, "I"] as const)
          : pairs) {
          // (the other forms, the controls and a join in a right operand at fewer neighbours: `w` before or after it,
          // whole numbers, text beside them)
          if (form !== "binding" && !(position === "left" || position === "right of left"))
            continue;
          if ((form !== "binding" || position.endsWith("of right")) && x === "N") continue;
          if (depth === 2 && position.endsWith("of right") && x !== "W") continue;
          if (form !== "binding" && x === "S") continue;
          if (!open && !nulls && !(uses === "X" ? x === "S" : x === "I" || x === "W")) continue;
          const [X, Y] = [wrap(neighbours[x]), wrap(neighbours[y])];
          const inner = position.startsWith("left") ? `${d} + ${X}` : `${X} + ${d}`;
          const result = (join: string) => outer(join).replace("Y", Y);
          const start = `let w: integer${"[]".repeat(depth)} = ${wrap("7")}\n${declaration}\n${extra}`;
          const nested = uses === "XY";
          const name = `${domain} ${form} ${position}: ${result(`(${inner})`)}`;
          const inline = joinAnswers(
            `${start}let result = ${nested ? result(`(${inner})`) : inner}\nsay result.length\nexit\n`,
          );
          checked += 1;
          // (inline as kept; a variable holding an inferred call's result loses its written type: #1393)
          if (nested && form !== "inferred call")
            assert.deepEqual(
              inline.toSorted(),
              joinAnswers(
                `${start}let held = ${inner}\nlet result = ${result("held")}\nsay result.length\nexit\n`,
              ).toSorted(),
              name,
            );
          // (open: nothing errs, and a variable holding the join takes text; only `null`: an error only where whole
          // numbers meet text beside it, and a variable holding the join takes `null`)
          if (open) assert.deepEqual(inline, [], name);
          if (nulls) {
            const kinds = new Set(
              [x, y].flatMap((kind) => (kind === "N" ? [] : [kind === "W" ? "I" : kind])),
            );
            assert.equal(
              inline.some((answer) => answer.startsWith("TSV044")),
              nested && kinds.size === 2,
              name,
            );
          }
          if (!nested && form !== "inferred call" && (open || nulls) && (x === "I" || x === "W"))
            assert.deepEqual(
              joinAnswers(
                `${start}let held = ${inner}\nheld.add(${"[".repeat(depth - 1)}${open ? '"tail"' : "null"}${"]".repeat(depth - 1)})\nsay held.length\nexit\n`,
              ),
              [],
              `${name}, then a store`,
            );
        }
  }
  assert.ok(checked > 150, `${checked} joins`);
  // a strict written destination stays strict: a `+=` or a store back into a written `null[]` errs
  for (const store of ["d += [1]", "d = d + [1]"])
    assert.deepEqual(
      joinAnswers(`let d: null[] = [null]\n${store}\nsay d.length\nexit\n`),
      [`TSV044 ${JSON.stringify([["null"], ["integer"]])}`],
      store,
    );
  // a call's written result a join carries deeper than any written copy (in a literal's property or element, below
  // two): the decider reads it at every depth a stop stands at, the values' too (#1410's `stopDepths`), so an open one
  // takes text and a union keeps out what it does not hold, warnings included, as V1 has them
  const reported = (source: string): string[] => {
    const request = coreRequest(main(source));
    assert.ok(request !== null, source);
    const runs = [true, false].flatMap((shared) =>
      [false, true].map((reversed) => {
        const go = () => analyseCore(request);
        const ordered = reversed
          ? () =>
              withConsumerOrder(
                (list) => [...list].reverse(),
                () => withSolverSeam({ reverseWorklist: true }, go),
              )
          : go;
        return reportedDiagnostics(shared ? ordered() : withoutSharing(ordered)).map(
          (diagnostic) => `${diagnostic.class === "compile-error" ? "E" : "W"} ${diagnostic.code}`,
        );
      }),
    );
    for (const run of runs) assert.deepEqual(run, runs[0], source);
    return runs[0]!;
  };
  for (const [contain, read] of [
    [(j: string) => `{n: ${j}}`, ".n"],
    [(j: string) => `[${j}]`, "[0]"],
    [(j: string) => `{m: {n: ${j}}}`, ".m.n"],
    [(j: string) => `[{n: ${j}}]`, "[0].n"],
  ] as const)
    for (const join of ["make() + [2]", "[2] + make()"])
      for (const [result, element, expected] of [
        ["list", '"tail"', []],
        ["(integer | string)[]", '"tail"', []],
        ["(integer | string)[]", "true", ["E TSV041"]],
        ["(integer | string)[]", "null", ["E TSV041"]],
      ] as const) {
        const source = `function make: ${result} {\n  return [1]\n}\nlet o = ${contain(join)}\no${read}.add(${element})\nsay o${read}.length\nexit\n`;
        assert.deepEqual(reported(source), expected, source);
      }
});

/**
 * #1272 (TABLE r4.146, Codex r2–r5 on #1310): the declaration a join's fix offers, the variable the join starts with the
 * type (#1268), holds every value the joined lists bring, at every list level, so pasted in place of the source's own it
 * takes the error away and adds nothing. Every pair of element kinds, either order (whole numbers, numbers, text, truth
 * values, objects, `null` beside a number and beside text); nested lists, optional at one level or more; a number only
 * external data gives; a later `null` in a run; and the variable's own later stores of a kind it holds.
 */
test("a list join's fix, pasted as the declaration it offers, holds every element the join brings (#1272)", () => {
  const reported = (source: string): string[] => {
    const request = coreRequest(main(source));
    assert.ok(request !== null, source);
    const answers = analyseCore(request);
    const text = messageSource([source], answers.diagnostics);
    return [...reportedDiagnostics(answers)].map(
      (diagnostic) => `${diagnostic.code} ${coreMessage(diagnostic, text)}`,
    );
  };
  const elements = ["1", "1.5", '"x"', "true", "{n: 1}", "1, null", "null, 2.5", '"x", null'];
  const sources: string[] = [];
  for (const left of elements)
    for (const right of elements)
      sources.push(`let xs = [${left}]\nlet both = xs + [${right}]\nexit\n`);
  sources.push(
    'let xs = [[1], null]\nlet both = xs + [["x"]]\nexit\n',
    'let xs = [[[1]], [null], null]\nlet both = xs + [[["x"]]]\nexit\n',
    'let xs = [1, hostValue / 2]\nlet both = xs + ["x"]\nexit\n',
    'let xs = [1]\nlet both = xs + ["x"] + [null]\nexit\n',
    // (a number stored later is among what the variable holds, Codex r5)
    'let xs = [1]\nlet both = xs + ["x"]\nboth.add(1.5)\nexit\n',
    'let xs = [1]\nlet both = xs + ["x"]\nboth[0] = 2.5\nexit\n',
  );
  let mixed = 0;
  for (const source of sources) {
    const found = reported(source);
    const error = found.filter((line) => line.startsWith("TSV044"));
    if (error.length === 0) continue;
    mixed += 1;
    const fix = /declare the list as '(let both: [^=]+ = (.+))'\.$/.exec(error.join("\n"));
    assert.ok(error.length === 1 && fix !== null, `${source}: ${found.join(" | ")}`);
    const pasted = source.replace(`let both = ${fix[2]!}`, fix[1]!);
    assert.notEqual(pasted, source, fix[1]);
    // (external data is checked where it comes in, against the type the fix declares, ADR 0021 1.7)
    assert.deepEqual(
      reported(pasted).filter((line) => !line.startsWith("TSV041") || !line.includes("hostValue")),
      found.filter((line) => line !== error[0]),
      pasted,
    );
  }
  assert.equal(mixed, 48);
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

/**
 * S9b's sentences word for word (the sentence review of #1437, the ported-sentence rule): every new or changed sentence
 * of the checks that owe the runtime nothing, TSV029, C13's consumers and G2, as the compiler reads them (`checkedResult`:
 * the analysis's diagnostics with the static ones, a known calendar offset one diagnostic), each source's diagnostics
 * in order.
 */
test("S9b's sentences read word for word as the sentence review settled them (#1437)", () => {
  const cases: readonly (readonly [string, string, readonly string[]])[] = [
    [
      "TSV011 repeat count",
      'repeat -2 { say "a" }\n',
      [
        "E TSV011: A repeat count must be a whole number (integer) of at least 0, but this is -2. Check that it is at least 0 first.",
      ],
    ],
    [
      "TSV043 conversion",
      'let n = toInteger("x")\nsay n\n',
      [
        'E TSV043: toInteger(...) cannot convert text (string) "x" to a whole number (integer). The text must be a number such as 2.5 or -3.',
      ],
    ],
    [
      "TSV046 empty range loop",
      "for i in 3..1 { say i }\n",
      [
        "W TSV046: This range contains no numbers, so the loop never runs: a range never counts down. Write '1..3' to count up.",
      ],
    ],
    [
      "TSV046 empty range toList",
      "let xs = (3..1).toList()\nsay xs\n",
      [
        "W TSV046: This range contains no numbers, so toList() returns []: a range never counts down. Write '1..3' to count up.",
      ],
    ],
    [
      "TSV046 single",
      "for i in 3..3 { say i }\n",
      [
        "W TSV046: This range contains no numbers, so the loop never runs: '3..3' excludes its end. Write '3..=3' for the single number 3.",
      ],
    ],
    [
      "TSV029 value error (object option value)",
      'let c = askChoice {text: "x", value: {n: 1}}\n',
      [
        "E TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but '{n: 1}' is an object. Give the buttons text or number values, and pick the object from the answer.",
      ],
    ],
    [
      "TSV029 written text object",
      "let c = askChoice {text: {n: 1}}\nexit\n",
      [
        "E TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but '{n: 1}' is an object. Give the buttons text or number values, and pick the object from the answer.",
      ],
    ],
    [
      "TSV029 held value object",
      'let w = {text: "t", value: {n: 1}}\nlet c = askChoice w\nexit\n',
      [
        "E TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but 'w.value' is an object. Give the buttons text or number values, and pick the object from the answer.",
      ],
    ],
    [
      "TSV029 value error (text object)",
      "let w = {text: {n: 1}}\nlet c = askChoice w\n",
      [
        "E TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but 'w.text' is an object. Give the buttons text or number values, and pick the object from the answer.",
      ],
    ],
    [
      "TSV029 held in list",
      'let w = {text: {n: 1}}\nlet c = askChoice [w, "b"]\nexit\n',
      [
        "E TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but 'w.text' is an object. Give the buttons text or number values, and pick the object from the answer.",
        "E TSV044: This list mixes an object and text (string). A list holds one type. To allow both, declare it as '(object | string)[]'.",
      ],
    ],
    [
      "TSV029 value error (list)",
      'let c = askChoice {text: "x", value: [1]}\n',
      [
        "E TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but '[1]' is a list. Give the buttons text or number values, and pick the list from the answer.",
      ],
    ],
    [
      "TSV029 value warning",
      'let c = askChoice {text: "x", value: hostValue otherwise {n: 1}}\n',
      [
        "W TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but 'hostValue otherwise {n: 1}' may be an object here. If it is, the Tease stops with an error at this line. Give the buttons text or number values, and pick the object from the answer.",
      ],
    ],
    [
      "TSV029 value warning hostValue",
      'let c = askChoice {text: "x", value: hostValue}\n',
      [
        "W TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but 'hostValue' may be a value of another type here. If it is, the Tease stops with an error at this line. 'hostValue' comes from outside the script, so its type is known only when the script runs.",
      ],
    ],
    [
      "TSV029 value warning beside a known button",
      'let c = askChoice [{text: "one", value: 1}, {text: "two", value: hostValue}][1]\nexit\n',
      [
        'W TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but \'[{text: "one", value: 1}, {text: "two", value: hostValue}][1].value\' may be a value of another type here. If it is, the Tease stops with an error at this line. \'[{text: "one", value: 1}, {text: "two", value: hostValue}][1].value\' comes from outside the script, so its type is known only when the script runs.',
      ],
    ],
    [
      "TSV029 value warning within",
      'let c = askChoice dict{a: {text: "one", value: 1}, b: {text: "two", value: hostValue}}.values\nexit\n',
      [
        'W TSV029: A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value, but the value of an element of \'dict{a: {text: "one", value: 1}, b: {text: "two", value: hostValue}}.values\' may be a value of another type here. If it is, the Tease stops with an error at this line. \'dict{a: {text: "one", value: 1}, b: {text: "two", value: hostValue}}.values\' comes from outside the script, so its type is known only when the script runs.',
      ],
    ],
    [
      "TSV029 option dict",
      "let d = dict{a: 1}\nlet c = askChoice d\n",
      [
        "E TSV029: A choice option must be a choice value, a choice object { value?, text, background? }, a list, or a set, but 'd' is a dict.",
      ],
    ],
    [
      "TSV029 option warning",
      "let c = askChoice hostValue otherwise dict{a: 1}\nexit\n",
      [
        "W TSV029: A choice option must be a choice value, a choice object { value?, text, background? }, a list, or a set, but 'hostValue otherwise dict{a: 1}' may be a dict here. If it is, the Tease stops with an error at this line.",
      ],
    ],
    [
      "TSV029 computed option",
      "let o = 1..3\nlet c = askChoice o\nexit\n",
      [
        "E TSV029: A choice option must be a choice value, a choice object { value?, text, background? }, a list, or a set, but 'o' is a range. Copy 'o' into a list with the toList method first.",
      ],
    ],
    [
      "TSV029 element",
      "let c = askChoice [[1]]\n",
      [
        "E TSV029: A choice list element must be a choice value or a choice object { value?, text, background? }, but '[1]' is a list.",
      ],
    ],
    [
      "TSV029 element set",
      "let c = askChoice [set[1]]\nexit\n",
      [
        "E TSV029: A choice list element must be a choice value or a choice object { value?, text, background? }, but 'set[1]' is a set.",
      ],
    ],
    [
      "TSV029 element warning",
      "let c = askChoice [hostValue otherwise [1]]\nexit\n",
      [
        "W TSV029: A choice list element must be a choice value or a choice object { value?, text, background? }, but 'hostValue otherwise [1]' may be a list here. If it is, the Tease stops with an error at this line.",
      ],
    ],
    [
      "TSV043 contains",
      'say "abc".contains(1)\n',
      [
        "E TSV043: contains() needs text (string) or a regex for 'part', but '1' is a whole number (integer). Convert the value with the toString function.",
      ],
    ],
    [
      "TSV043 contains warning",
      'say "abc".contains(hostValue)\n',
      [
        "W TSV043: contains() needs text (string) or a regex for 'part', but 'hostValue' may be a value of another type here. If it is, the Tease stops with an error at this line. Check 'hostValue' first, as in 'if hostValue is string | regex { say \"abc\".contains(hostValue) }'. 'hostValue' comes from outside the script, so its type is known only when the script runs.",
      ],
    ],
    [
      "TSV043 contains warning known",
      'let v = hostValue otherwise 1\nsay "abc".contains(v)\nexit\n',
      [
        "W TSV043: contains() needs text (string) or a regex for 'part', but 'v' may be a whole number (integer) here. If it is, the Tease stops with an error at this line. Convert the value with the toString function.",
      ],
    ],
    [
      "TSV043 matches",
      'say "abc".matches("a")\n',
      [
        "E TSV043: matches() needs a regex for 'pattern', but '\"a\"' is text (string). Write a regex such as '/[0-9]+/' instead, or make one from the text with the toRegex function.",
      ],
    ],
    [
      "TSV043 matches warning",
      'let v = hostValue otherwise "a"\nsay "abc".matches(v)\nexit\n',
      [
        "W TSV043: matches() needs a regex for 'pattern', but 'v' may be text (string) here. If it is, the Tease stops with an error at this line. Write a regex such as '/[0-9]+/' instead, or make one from the text with the toRegex function.",
      ],
    ],
    [
      "TSV043 substring",
      'say "abc".substring("bad")\n',
      [
        "E TSV043: substring() needs a whole number (integer) for 'start', but '\"bad\"' is text (string). Convert the text with the toInteger function.",
      ],
    ],
    [
      "TSV043 substring number",
      'let n = 1.5\nsay "abc".substring(n)\n',
      [
        "E TSV043: substring() needs a whole number (integer) for 'start', but 'n' is a number. Convert the number with the toInteger function, which drops the fraction.",
      ],
    ],
    [
      "TSV043 substring warning unknown",
      'say "abc".substring(hostValue)\nexit\n',
      [
        "W TSV043: substring() needs a whole number (integer) for 'start', but 'hostValue' may be a value of another type here. If it is, the Tease stops with an error at this line. Check 'hostValue' first, as in 'if hostValue is integer { say \"abc\".substring(hostValue) }'. 'hostValue' comes from outside the script, so its type is known only when the script runs.",
      ],
    ],
    [
      "TSV043 dict key contains",
      "let d = dict{a: 1}\nsay d.contains(1)\n",
      [
        "E TSV043: A dict key is text (string), but '1' is a whole number (integer). Write a number key as text.",
      ],
    ],
    [
      "TSV043 dict key warning",
      "let d = dict{a: 1}\nsay d.contains(hostValue otherwise 1)\nexit\n",
      [
        "W TSV043: A dict key is text (string), but 'hostValue otherwise 1' may be a whole number (integer) here. If it is, the Tease stops with an error at this line. Write a number key as text.",
      ],
    ],
    [
      "TSV043 union",
      "let r = [1].union(3)\nsay r\n",
      ["E TSV043: union() needs a list or a set for 'other', but '3' is a whole number (integer)."],
    ],
    [
      "TSV043 union range",
      "let r = [1].union(1..3)\nsay r\n",
      [
        "E TSV043: union() needs a list or a set for 'other', but '1..3' is a range. Copy '1..3' into a list with the toList method first.",
      ],
    ],
    [
      "TSV043 union warning",
      "let r = [1].union(hostValue)\nexit\n",
      [
        "W TSV043: union() needs a list or a set for 'other', but 'hostValue' may be a value of another type here. If it is, the Tease stops with an error at this line. 'hostValue' comes from outside the script, so its type is known only when the script runs.",
      ],
    ],
    [
      "TSV043 join separator",
      'say ["a"].join(1)\n',
      [
        "E TSV043: join() needs text (string) for 'separator', but '1' is a whole number (integer). Convert the value with the toString function.",
      ],
    ],
    [
      "TSV042 join elements",
      "let xs = [{n: 1}]\nsay xs.join()\n",
      [
        "E TSV042: join() can only join text, numbers, true or false, null, durations, angles, date and time values, script references, and regexes, but 'xs' holds objects. Select an element or a property first.",
      ],
    ],
    [
      "TSV042 join warning",
      "let xs = [hostValue]\nsay xs.join()\n",
      [
        "W TSV042: join() can only join text, numbers, true or false, null, durations, angles, date and time values, script references, and regexes, but 'xs' may hold values of another type here. If it does, the Tease stops with an error at this line.",
      ],
    ],
    [
      "TSV042 join warning known",
      "let xs = [hostValue otherwise {n: 1}]\nsay xs.join()\nexit\n",
      [
        "W TSV042: join() can only join text, numbers, true or false, null, durations, angles, date and time values, script references, and regexes, but 'xs' may hold objects here. If it does, the Tease stops with an error at this line. Select an element or a property first.",
      ],
    ],
    [
      "TSV043 sort elements",
      "let xs = [{n: 1}]\nxs.sort()\n",
      [
        "E TSV043: sort() sorts numbers, text, durations, angles, or date and time values, but 'xs' holds objects.",
      ],
    ],
    [
      "TSV043 sort warning",
      "let xs = [hostValue]\nxs.sort()\n",
      [
        "W TSV043: sort() sorts numbers, text, durations, angles, or date and time values, but 'xs' may hold values of another type here. If it does, the Tease stops with an error at this line.",
      ],
    ],
    [
      "TSV043 sort warning known",
      "let xs = [hostValue otherwise {n: 1}]\nxs.sort()\nexit\n",
      [
        "W TSV043: sort() sorts numbers, text, durations, angles, or date and time values, but 'xs' may hold objects here. If it does, the Tease stops with an error at this line.",
      ],
    ],
    [
      "TSV043 sort mixed typed",
      'let xs: (integer | string)[] = [1, "a"]\nxs.sort()\nexit\n',
      [
        "W TSV043: sort() sorts elements of one type, but 'xs' may hold both numbers and text here. If it does, the Tease stops with an error at this line.",
      ],
    ],
    [
      "TSV043 sort mixed three types",
      'let ys:(integer|string|duration)[]=[2,"a",1 s]\nys.sort()\nexit\n',
      [
        "W TSV043: sort() sorts elements of one type, but 'ys' may hold numbers, text, and durations here. If it does, the Tease stops with an error at this line.",
      ],
    ],
    [
      "TSV043 toJson nested",
      "say toJson({a: [1..2]})\n",
      [
        "E TSV043: toJson(...) cannot write this object: it holds a range, which has no JSON form. Write plain values, such as text, numbers, lists, or dicts, instead.",
      ],
    ],
    [
      "TSV043 toJson direct",
      "say toJson(1..2)\n",
      [
        "E TSV043: toJson(...) cannot write a range, which has no JSON form. Write plain values, such as text, numbers, lists, or dicts, instead.",
      ],
    ],
    [
      "TSV043 toJson warning direct",
      "let x = hostValue otherwise /a/\nsay toJson(x)\n",
      [
        "W TSV043: 'x' may be a regex here, which toJson(...) cannot write. If it is, the Tease stops with an error at this line. Write plain values, such as text, numbers, lists, or dicts, instead.",
      ],
    ],
    [
      "TSV043 toJson warning nested",
      "let x = [hostValue otherwise /a/]\nsay toJson(x)\n",
      [
        "W TSV043: 'x' may hold a regex here, which toJson(...) cannot write. If it does, the Tease stops with an error at this line. Write plain values, such as text, numbers, lists, or dicts, instead.",
      ],
    ],
    [
      "TSV043 toJson warning nested obj",
      "let o = {a: hostValue otherwise /x/}\nsay toJson(o)\nexit\n",
      [
        "W TSV043: 'o' may hold a regex here, which toJson(...) cannot write. If it does, the Tease stops with an error at this line. Write plain values, such as text, numbers, lists, or dicts, instead.",
      ],
    ],
    [
      "TSV012 iterable",
      "for e in 1 { say e }\n",
      [
        "E TSV012: A 'for' loop goes through a list, set, dict, or range, but '1' is a whole number (integer).",
      ],
    ],
    [
      "TSV012 pair iterable",
      "for k, e in [1] { say e }\n",
      ["E TSV012: A 'for' loop with a key and a value goes through a dict, but '[1]' is a list."],
    ],
    [
      "TSV012 warning",
      "for e in hostValue { say e }\nexit\n",
      [
        "W TSV012: A 'for' loop goes through a list, set, dict, or range, but 'hostValue' may be a value of another type here. If it is, the Tease stops with an error at this line. 'hostValue' comes from outside the script, so its type is known only when the script runs.",
      ],
    ],
    [
      "TSV012 warning known",
      "for e in hostValue otherwise 1 { say e }\nexit\n",
      [
        "W TSV012: A 'for' loop goes through a list, set, dict, or range, but 'hostValue otherwise 1' may be a whole number (integer) here. If it is, the Tease stops with an error at this line.",
      ],
    ],
    [
      "TSV043 calendar date",
      'let d = toDate("2026-08-11")\nlet e = d + (1 calendar day + 2 h)\nsay e\nexit\n',
      [
        "E TSV043: A date moves only by calendar units, not by 1 calendar day 2 hours. A date has no clock time, so leave out the 2 hours.",
      ],
    ],
    [
      "TSV043 calendar date compound",
      'let d = toDate("2026-08-11")\nd += 1 calendar day + 2 h\nexit\n',
      [
        "E TSV043: A date moves only by calendar units, not by 1 calendar day 2 hours. A date has no clock time, so leave out the 2 hours.",
      ],
    ],
    [
      "G2 compound o.x",
      "let o = {x: hostValue otherwise null}\no.x += 1\nexit\n",
      [
        "W TSV043: '+' needs a number, but 'o.x' may be null here. If it is, the Tease stops with an error at this line. Check that 'o.x' is not null first.",
        "W TSV043: '+' needs a number, but 'o.x' may be a value of another type here. If it is, the Tease stops with an error at this line. Check that 'o.x' is a number first. 'o.x' comes from outside the script, so its type is known only when the script runs.",
      ],
    ],
    [
      "G2 compound null var",
      "let x = hostValue otherwise null\nx += 1\nexit\n",
      [
        "W TSV043: '+' needs a number, but 'x' may be null here. If it is, the Tease stops with an error at this line. Check that 'x' is not null first.",
        "W TSV043: '+' needs a number, but 'x' may be a value of another type here. If it is, the Tease stops with an error at this line. Check that 'x' is a number first. 'x' comes from outside the script, so its type is known only when the script runs.",
      ],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expected] of cases) {
    const request = coreRequest(main(source));
    assert.ok(request !== null, name);
    const { diagnostics } = checkedResult(analyseCore(request), request);
    const text = messageSource([source], diagnostics);
    const got = diagnostics
      .filter((diagnostic) => diagnostic.kind !== "budget")
      .map(
        (diagnostic) =>
          `${diagnostic.class === "compile-error" ? "E" : "W"} ${diagnostic.code}: ${coreMessage(diagnostic, text)}`,
      );
    if (JSON.stringify(got) !== JSON.stringify(expected))
      differing.push(`${name}:\n  ${got.join("\n  ")}`);
  }
  assert.deepEqual(differing, []);
});
