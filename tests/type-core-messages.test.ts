import assert from "node:assert/strict";
import test from "node:test";
import { jsonFieldMismatch, jsonKindMismatch } from "../src/runtime/values/value-types.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { reportedDiagnostics } from "../src/type-inference/core/consumer.js";
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
    `'${operator}' would mix ${kinds}. A list holds one type. To keep both, ${fix}.`;
  const integerString = "a whole number (integer) and text (string)";
  const union = (head: string, type = "(integer | string)[]"): string =>
    `declare a union type, as in '${head}: ${type} = ...'`;
  for (const [source, expected] of [
    [
      'let xs = [1]\nlet more = xs + ["x"]\nsay more.length\nexit',
      `TSV044 [24,34) ${mix("+", integerString, union("let xs"))}`,
    ],
    [
      'say ([1] + ["x"]).length\nexit',
      `TSV044 [5,16) ${mix("+", integerString, union("let values"))}`,
    ],
    [
      'let xs = [1]\nlet ys = ["x"]\nlet both = xs + ys\nsay both.length\nexit',
      `TSV044 [39,46) ${mix("+", integerString, union("let xs"))}`,
    ],
    [
      'let xs = [1]\nxs += ["x"]\nexit',
      `TSV044 [19,24) ${mix("+=", integerString, union("let xs"))}`,
    ],
    [
      'let box = {items: [1]}\nbox.items = box.items + ["x"]\nexit',
      `TSV044 [35,52) ${mix("+", integerString, union("let values"))}`,
    ],
    [
      'let xs = [1]\nlet both = xs + ["x"]\nsay both[1] + 1\nexit',
      `TSV044 [24,34) ${mix("+", integerString, union("let xs"))}`,
    ],
    [
      'let left = {items: [true]}\nlet right = {items: ["x"]}\nlet both = left.items + right.items\nsay both.length\nexit',
      `TSV044 [65,89) ${mix("+", "true or false (boolean) and text (string)", union("let values", "(boolean | string)[]"))}`,
    ],
    [
      'function f(xs = [1]) {\n  return xs + ["x"]\n}\nsay f().length\nexit',
      `TSV044 [32,42) ${mix("+", integerString, "declare the parameter as 'xs: (integer | string)[] = ...'")}`,
    ],
    [
      'let xs = [[1]]\nlet more = xs + [["x"]]\nsay more.length\nexit',
      `TSV044 [26,38) ${mix("+", "a list (integer[]) and a list (string[])", union("let xs", "(integer | string)[][]"))}`,
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
      `TSV044 [11,33) ${mix("+", integerString, union("let values"))}`,
    ],
    [
      'let xs = [1] + ([2] + ["x"])\nexit',
      `TSV044 [16,27) ${mix("+", integerString, union("let values"))}`,
    ],
    // whole numbers beside numbers in one operand are numbers (Codex r2 on #1310); a join in a right operand is decided
    // on its own, its fix naming its own operand (Astra on #1310)
    [
      'let both = [1, 1.5] + ["x"]\nexit',
      `TSV044 [11,27) ${mix("+", "a number and text (string)", union("let values", "(number | string)[]"))}`,
    ],
    [
      'let ys = [1]\nlet both = [1] + (ys + ["x"])\nexit',
      `TSV044 [31,41) ${mix("+", integerString, union("let ys"))}`,
    ],
    // null elements decide nothing, but each side's sentence and the union the fix writes hold them (Codex r3 on #1310)
    [
      'let xs = [1, null]\nlet both = xs + ["x"]\nexit',
      `TSV044 [30,40) ${mix("+", "a whole number (integer) or null and text (string)", union("let xs", "(integer | string | null)[]"))}`,
    ],
    [
      'let xs = [1]\nlet both = xs + ["x", null]\nexit',
      `TSV044 [24,40) ${mix("+", "a whole number (integer) and text (string) or null", union("let xs", "(integer | string | null)[]"))}`,
    ],
    // a function's written result decides as a variable's written type does (Codex r5 on #1310)
    [
      'function make: (integer | boolean)[] {\n  return [1]\n}\nlet both = make() + ["x"]\nexit',
      `TSV044 [65,79) ${mix("+", "a whole number (integer) or true or false (boolean) and text (string)", union("let values", "(integer | boolean | string)[]"))}`,
    ],
    // a run of joins has one element type, whole numbers beside numbers numbers
    [
      'say ([1] + [1.5] + ["x"]).length\nexit',
      `TSV044 [5,24) ${mix("+", "a number and text (string)", union("let values", "(number | string)[]"))}`,
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
test("a list join answers the same inline as kept in a variable (#1272)", () => {
  const answers = (source: string): string[] => {
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
  };
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
 * #1272 (TABLE r4.146, Codex r2–r5 on #1310): the type a join's fix declares holds every value the joined lists bring,
 * at every list level, so pasted on the variable it names it takes the error away and adds nothing. Every pair of
 * element kinds (whole numbers, numbers, text, truth values, objects, `null` beside a number and beside text, on
 * either side); nested lists, optional at one level or more; a number only external data gives; a later `null` in a run;
 * and the variable's own later stores (Codex r5 on #1310).
 */
test("a list join's fix, pasted on the variable it names, holds every element the join brings (#1272)", () => {
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
    // the variable's later stores stay valid: a written union's, and a number beside whole numbers (Codex r5)
    'let xs: (integer | boolean)[] = [1]\nlet both = xs + ["x"]\nxs.add(true)\nexit\n',
    'let xs = [1]\nlet both = xs + ["x"]\nxs.add(1.5)\nexit\n',
  );
  let mixed = 0;
  for (const source of sources) {
    const found = reported(source);
    const error = found.filter((line) => line.startsWith("TSV044"));
    if (error.length === 0) continue;
    mixed += 1;
    const fix = /as in 'let xs: (.+) = \.\.\.'\.$/.exec(error.join("\n"));
    assert.ok(error.length === 1 && fix !== null, `${source}: ${found.join(" | ")}`);
    const pasted = source.replace(/let xs(: [^=]+)? = /, `let xs: ${fix[1]} = `);
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
