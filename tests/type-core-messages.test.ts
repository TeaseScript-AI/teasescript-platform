import assert from "node:assert/strict";
import test from "node:test";
import { compileProject, compileSourceWithBackend } from "../src/compiler.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { jsonFieldMismatch, jsonKindMismatch } from "../src/runtime/values/value-types.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { withTestAllowance, withTestDemandAllowance } from "../src/type-inference/core/budget.js";
import {
  checkedResult,
  coreCheckResult,
  reportedDiagnostics,
  SliceIndex,
} from "../src/type-inference/core/consumer.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { coreMessage, messageSource } from "../src/type-inference/core/messages.js";
import {
  type Given,
  givenBy,
  landingOf,
  ownerOf,
} from "../src/type-inference/core/messages/site.js";
import { parse } from "../src/parser.js";
import type { SourceSite } from "../src/type-inference/graph.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import { readFixture } from "./helpers/type-core-fixture.js";
import { inMode, MODES } from "./helpers/type-core-oracles.js";

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
        "E TSV043: substring() needs a whole number (integer) for 'start', but 'n' is a number that can have decimals. Convert the number with the toInteger function, which drops the fraction.",
      ],
    ],
    [
      // (a place written `number` is no whole number whatever it holds, as at every whole-number use: #1173)
      "TSV043 repeat written number",
      'let n: number = 1\nsay "abc".repeat(n)\n',
      [
        "E TSV043: repeat() needs a whole number (integer) for 'count', but 'n' is a number that can have decimals. Convert the number with the toInteger function, which drops the fraction.",
      ],
    ],
    [
      "TSV043 repeat written optional null",
      'let n: number? = null\nsay "abc".repeat(n)\n',
      ["E TSV043: repeat() needs a whole number (integer) for 'count', but 'n' is null."],
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

/**
 * #1468 (ADR 0021 rule 1.4, `docs/DIAGNOSTICS.md` "Messages"): where a store types a property below the warned value,
 * the fix names that property, in words with no value of its own (the lead's ruling after Codex r2), and following it
 * removes the warning (Astra r1's A1). Where the checker's definitions prove the value a load with a default, the load
 * as its variable's declaration's value or a copy of a variable whose key holds only that declaration and the keys below
 * it on the way none, the load's default is given the property; else, a write in any spelling, another binding of the
 * name, a selection or a join around the read (Codex r4's N1 to N3, r5's), no property check removes the warning
 * (#1496), so the words say where the type must come from and offer no check. A type with null takes no default that removes it yet (#1470). A value that is the place
 * keeps its own check. Each followed source compiles under both checkers and no longer owes the warning.
 */
test("a store's property below the warned value is the property its fix names, and following it removes the warning (#1468)", () => {
  const load = 'load("prefs", default: {volume: 5})';
  const given = 'load("prefs", default: {volume: 5, caption: 7})';
  const guarded = (body: string) =>
    `if original.entry is integer {\n${body.replace(/^/gm, "    ").trimEnd()}\n}\nexit\n`;
  const cases: readonly (readonly [
    source: string,
    value: string,
    fix: string,
    followed: string | null,
  ])[] = [
    [
      `let prefs = ${load}\nprefs.caption = 2\nexit\n`,
      load,
      `Give 'caption' a whole number (integer) in the default of '${load}'.`,
      `let prefs = ${given}\nprefs.caption = 2\nexit\n`,
    ],
    [
      'let prefs = load("prefs", default: {inner: {volume: 5}})\nprefs.inner.caption = "on"\nexit\n',
      'load("prefs", default: {inner: {volume: 5}})',
      `Give 'inner.caption' text (string) in the default of 'load("prefs", default: {inner: {volume: 5}})'.`,
      'let prefs = load("prefs", default: {inner: {volume: 5, caption: "off"}})\nprefs.inner.caption = "on"\nexit\n',
    ],
    [
      'let loaded = load("prefs", default: [{volume: 5}])\nloaded[0].caption = 2\nexit\n',
      'load("prefs", default: [{volume: 5}])',
      `Give 'caption' of an element of 'loaded' a whole number (integer) in the default of 'load("prefs", default: [{volume: 5}])'.`,
      'let loaded = load("prefs", default: [{volume: 5, caption: 7}])\nloaded[0].caption = 2\nexit\n',
    ],
    // (Astra r1's copy, its property already checked)
    [
      `let original = load("cfg", default: {marker: 8})\n${guarded('let box = original\nbox.entry = 4\nsay "done"')}`,
      "original",
      `Give 'entry' a whole number (integer) in the default of 'load("cfg", default: {marker: 8})'.`,
      `let original = load("cfg", default: {marker: 8, entry: 7})\n${guarded('let box = original\nbox.entry = 4\nsay "done"')}`,
    ],
    [
      'let loaded = load("prefs", default: [{volume: 5}])\nlet prefs = loaded[0]\nprefs.caption = 2\nexit\n',
      "loaded[0]",
      `Give 'caption' of an element of 'loaded' a whole number (integer) in the default of 'load("prefs", default: [{volume: 5}])'.`,
      'let loaded = load("prefs", default: [{volume: 5, caption: 7}])\nlet prefs = loaded[0]\nprefs.caption = 2\nexit\n',
    ],
    // (a load the checker's definitions do not prove: a list literal, a selection around the read; Codex r4's N1 and
    // r5's, a write by an index, a mutator through a parenthesized receiver and callee; N2, two ways from one load; N3,
    // an object's property named like a selection; another binding of the name, a parameter; a second load of the
    // variable; a load that is not its variable's declaration's value)
    [
      `let prefs = ${load}\nlet items = [{volume: 5}, prefs]\nitems[1].caption = 2\nexit\n`,
      "[{volume: 5}, prefs]",
      "Give 'caption' of an element of 'items' a whole number (integer) where '[{volume: 5}, prefs]' gets its value.",
      null,
    ],
    [
      `let saved = ${load}\nlet prefs = [saved, saved].random\nprefs.caption = 2\nexit\n`,
      "[saved, saved].random",
      "Give 'prefs.caption' a whole number (integer) where '[saved, saved].random' gets its value.",
      null,
    ],
    ...["loaded[0] = hostValue", "(loaded).add(hostValue)", "(loaded.add)(hostValue)"].map(
      (write) =>
        [
          `let loaded = load("prefs", default: [{volume: 5}])\n${write}\nlet items = loaded\nitems[0].caption = 2\nexit\n`,
          "loaded",
          "Give 'caption' of an element of 'items' a whole number (integer) where 'loaded' gets its value.",
          null,
        ] as const,
    ),
    [
      'let loaded = load("prefs", default: {left: {volume: 5}, right: {volume: 5}})\nlet prefs = [loaded.left, loaded.right].random\nprefs.caption = 2\nexit\n',
      "[loaded.left, loaded.right].random",
      "Give 'prefs.caption' a whole number (integer) where '[loaded.left, loaded.right].random' gets its value.",
      null,
    ],
    [
      'let loaded = load("prefs", default: {first: {volume: 5}})\nlet prefs = loaded.first\nprefs.caption = 2\nexit\n',
      "loaded.first",
      "Give 'prefs.caption' a whole number (integer) where 'loaded.first' gets its value.",
      null,
    ],
    [
      `function keep {\n    let prefs = ${load}\n    say "kept"\n}\nkeep()\nfunction use(prefs) {\n    let copy = prefs\n    copy.caption = 2\n}\nuse(hostValue)\nuse({volume: 1})\nexit\n`,
      "prefs",
      "Give 'copy.caption' a whole number (integer) where 'prefs' gets its value.",
      null,
    ],
    [
      `let prefs = ${load}\nprefs = load("other", default: {volume: 5})\nlet copy = prefs\ncopy.caption = 2\nexit\n`,
      "prefs",
      "Give 'copy.caption' a whole number (integer) where 'prefs' gets its value.",
      null,
    ],
    [
      `let prefs = load("saved", default: {volume: 5})\nprefs = ${load}\nprefs.caption = 2\nexit\n`,
      load,
      `Give 'prefs.caption' a whole number (integer) where '${load}' gets its value.`,
      null,
    ],
    // (host data: no property check removes the warning, Astra r1's host and kept lists)
    [
      "let items = [{volume: 5}, hostValue]\nitems[1].caption = 2\nexit\n",
      "hostValue",
      "Give 'caption' of an element of 'items' a whole number (integer) where 'hostValue' gets its value.",
      null,
    ],
    [
      'if hostValue is object and hostValue.entry is integer {\n    let boxes = [{marker: 8}, hostValue]\n    boxes[1].entry = 4\n    say "done"\n}\nexit\n',
      "hostValue",
      "Give 'entry' of an element of 'boxes' a whole number (integer) where 'hostValue' gets its value.",
      null,
    ],
    [
      'let kept = [hostValue]\nif kept[0].entry is integer {\n    let box = kept\n    box[0].entry = 4\n    say "done"\n}\nexit\n',
      "kept",
      "Give 'entry' of an element of 'box' a whole number (integer) where 'kept' gets its value.",
      null,
    ],
    [
      `let prefs = ${load}\nprefs.caption = [null, 2].random\nexit\n`,
      load,
      `Give 'prefs.caption' a whole number (integer) or null where '${load}' gets its value.`,
      null,
    ],
    [
      "let prefs = hostValue otherwise {volume: 5}\nprefs.caption = 2\nexit\n",
      "hostValue",
      "Give 'prefs.caption' a whole number (integer) where 'hostValue' gets its value.",
      null,
    ],
    [
      "let o = {caption: hostValue}\no.caption = 2\nexit\n",
      "hostValue",
      "Check that 'hostValue' is a whole number (integer) first.",
      "if hostValue is integer {\n    let o = {caption: hostValue}\n    o.caption = 2\n}\nexit\n",
    ],
  ];
  const errors = (source: string) =>
    compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] }).diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
  for (const [source, value, fix, followed] of cases) {
    const warned = reported(main(source)).filter(
      ({ code, site, message }) =>
        code === "TSV041" && site === value && !/holds (objects|an object)/.test(message),
    );
    assert.equal(warned.length, 1, `${source}: ${JSON.stringify(warned)}`);
    const { message } = warned[0]!;
    assert.ok(message.endsWith(` ${STOPS} ${fix}`), `${source}: ${message}`);
    const place = message.slice(0, message.indexOf(" holds "));
    if (followed === null) {
      assert.ok(!/check/i.test(fix), `${source}: no check is offered`);
      continue;
    }
    assert.deepEqual(errors(followed), [], followed);
    assert.deepEqual(
      reported(main(followed)).filter(
        ({ code, message: other }) => code === "TSV041" && other.startsWith(`${place} holds `),
      ),
      [],
      followed,
    );
  }
});

/**
 * V30 §13, §19 (#1352): an `askChoice` whose buttons return more than one type is a compile error where its answer, as
 * it stands or through an `otherwise`, is stored with its type inferred (a variable's start value or a later store
 * beside an unknown, an untyped parameter's argument at either of two calls, an inferred result, a list's element, an
 * add to an empty list, an object's property), with the declaration of every type the place takes (`null` among them,
 * an optional list), which pasted compiles under both checkers, else buttons of one type in words; in four modes. An
 * argument is typed by its own call (V30 §11), whatever another call passes. A written union, a copy of one, an
 * unrestricted `list` or `object` at any depth, one type (numbers with whole numbers,
 * `null` beside a type, an `otherwise` that leaves one), a button the script cannot know (beside known types of more
 * than one, the error names those alone), a list option whose own
 * elements mix (that list's error), and a place another store decides (whose store warning keeps the choice in a
 * variable declared with the union, as a choice used directly does) get no such error.
 */
test("an askChoice of more than one type errs where its type would be inferred, and its fixes keep both (V30 §19, #1352)", () => {
  const MIXED = "This askChoice returns a whole number (integer) or text (string).";
  const BUTTONS = "or give every button a value of one type.";
  const C = 'askChoice [{text: "A", value: 1}, {text: "B"}]';
  const S = 'askChoice "None", [5, 10]';
  const call = "function f(p) {\n  say p\n}\n";
  // [source, the error's sentence after MIXED or, from "This askChoice", its whole message (none: no error), the code
  // it replaces and the code that replaces it]
  const cases: readonly (readonly [string, string | null, readonly [string, string] | null])[] = [
    [
      `let value = ${C}\nif value is integer {\n  say value + 1\n}\nexit\n`,
      `To keep both, declare the variable as 'let value: integer | string = ${C}', ${BUTTONS}`,
      ["let value =", "let value: integer | string ="],
    ],
    [
      `let other = ${S}\nexit\n`,
      `To keep both, declare the variable as 'let other: integer | string = ${S}', ${BUTTONS}`,
      ["let other =", "let other: integer | string ="],
    ],
    [
      `let opts = [{text: "A", value: 1}, {text: "B"}]\nlet value = askChoice opts\nexit\n`,
      `To keep both, declare the variable as 'let value: integer | string = askChoice opts', ${BUTTONS}`,
      ["let value =", "let value: integer | string ="],
    ],
    [
      `${call}f(1)\nf(${S})\nexit\n`,
      `To keep both, declare the parameter as 'p: integer | string', ${BUTTONS}`,
      ["f(p)", "f(p: integer | string)"],
    ],
    [
      `function g {\n  return ${S}\n}\nsay g()\nexit\n`,
      `To return both, declare the result type of function 'g' as 'integer | string', ${BUTTONS}`,
      ["function g {", "function g: integer | string {"],
    ],
    [
      `let xs = [${S}]\nexit\n`,
      `To keep both, declare the list as 'let xs: (integer | string)[] = [${S}]', ${BUTTONS}`,
      ["let xs =", "let xs: (integer | string)[] ="],
    ],
    [
      `let xs = []\nxs.add(${S})\nexit\n`,
      `To keep both, declare the list as 'let xs: (integer | string)[] = []', ${BUTTONS}`,
      ["let xs =", "let xs: (integer | string)[] ="],
    ],
    [
      'let v = askChoice "None", 1, null\nexit\n',
      `This askChoice returns a whole number (integer), text (string), or null. To keep both, declare the variable as 'let v: integer | string | null = askChoice "None", 1, null', ${BUTTONS}`,
      ["let v =", "let v: integer | string | null ="],
    ],
    [
      `let v = null\nv = ${S}\nexit\n`,
      `To keep both, declare the variable as 'let v: integer | string | null = null', ${BUTTONS}`,
      ["let v =", "let v: integer | string | null ="],
    ],
    [
      `let v = hostValue\nv = ${S}\nexit\n`,
      `To keep both, declare the variable as 'let v: integer | string = hostValue', ${BUTTONS}`,
      ["let v =", "let v: integer | string ="],
    ],
    [
      'let v = (askChoice "None", 1, null) otherwise 1\nexit\n',
      `This askChoice returns a whole number (integer), text (string), or null. To keep both, declare the variable as 'let v: integer | string = (askChoice "None", 1, null) otherwise 1', ${BUTTONS}`,
      ["let v =", "let v: integer | string ="],
    ],
    [
      `let xs = null\nxs = [${S}]\nexit\n`,
      `To keep both, declare the list as 'let xs: (integer | string)[]? = null', ${BUTTONS}`,
      ["let xs =", "let xs: (integer | string)[]? ="],
    ],
    [
      // (an unknown button beside two known types: the known ones decide, Codex r2 on #1660)
      `${call}f(askChoice "None", 1, hostValue)\nexit\n`,
      `To keep both, declare the parameter as 'p: integer | string', ${BUTTONS}`,
      ["f(p)", "f(p: integer | string)"],
    ],
    [
      `let xs = []\nlet v = xs.get(0, default: ${S})\nexit\n`,
      `To keep both, declare the variable as 'let v: integer | string = xs.get(0, default: ${S})', ${BUTTONS}`,
      ["let v =", "let v: integer | string ="],
    ],
    [
      `${call}f(true)\nf(${S})\nexit\n`,
      `To keep all of them, declare the parameter as 'p: integer | string | boolean', ${BUTTONS}`,
      ["f(p)", "f(p: integer | string | boolean)"],
    ],
    [
      // (a declaration on more than one line: the type in words, the variable named)
      'let v = askChoice [\n  {text: "A", value: 1},\n  {text: "B"}\n]\nexit\n',
      `To keep both, declare the variable 'v' with the type 'integer | string', ${BUTTONS}`,
      ["let v =", "let v: integer | string ="],
    ],
    [
      `let box = {value: ${S}}\nexit\n`,
      "but 'box.value' holds one type. Give every button a value of one type.",
      null,
    ],
    [
      `${call}let u: integer | string = 1\nf(u)\nf(${S})\nexit\n`,
      `To keep both, declare the parameter as 'p: integer | string', ${BUTTONS}`,
      ["f(p)", "f(p: integer | string)"],
    ],
    [`let other: integer | string = ${S}\nexit\n`, null, null],
    [`let u: integer | string = 1\nlet w = u\nw = ${S}\nexit\n`, null, null],
    [`let xs: list = [${S}]\nexit\n`, null, null],
    [`let xs: list = [{v: ${S}}]\nexit\n`, null, null],
    [`let o: object = {v: ${S}}\nexit\n`, null, null],
    ["let v = (askChoice 1, null) otherwise 2\nexit\n", null, null],
    // (a list option whose elements mix is that list's error alone)
    ['let v = askChoice ["a", 1]\nexit\n', null, null],
    [`let u: integer | string = ${S}\nlet copy = u\nexit\n`, null, null],
    ["let value = askChoice 1, 1.5\nexit\n", null, null],
    ['let value = askChoice "A", null\nexit\n', null, null],
    [
      'let value = askChoice [{text: "A", value: 1}, {text: "B", value: hostValue}]\nexit\n',
      null,
      null,
    ],
    [`let v = 1\nv = ${S}\nexit\n`, null, null],
  ];
  // (the current checker rejects a choice as a `get` default whatever written type receives it, a recorded difference
  // from V30 §19 as #1412's: those pastes are checked under the core alone)
  const getDefault = (source: string): boolean => source.includes(".get(0, default: askChoice");
  const v1Errors = (source: string) =>
    compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] }).diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
  // (the error names the known types alone, whatever a button the script cannot know adds)
  const hosted = coreRequest(main('let v = askChoice "None", 1, hostValue\nexit\n'));
  assert.ok(hosted !== null);
  assert.deepEqual(
    analyseCore(hosted)
      .diagnostics.filter((diagnostic) => diagnostic.code === "TSV044")
      .map((diagnostic) => ("kinds" in diagnostic ? diagnostic.kinds : null)),
    [["integer", "string"]],
  );
  for (const [source, sentence, fix] of cases) {
    for (const mode of MODES) {
      const mixed = inMode(mode, () => reported(main(source))).filter(
        ({ code, message }) => code === "TSV044" && message.startsWith("This askChoice"),
      );
      const name = `${JSON.stringify(mode)} ${source}`;
      if (sentence === null) {
        assert.deepEqual(mixed, [], name);
        continue;
      }
      assert.equal(mixed.length, 1, name);
      assert.ok(mixed[0]!.error, name);
      assert.ok(source.includes(mixed[0]!.site) && mixed[0]!.site.startsWith("askChoice"), name);
      assert.equal(
        mixed[0]!.message,
        sentence.startsWith("This askChoice")
          ? sentence
          : sentence.startsWith("but")
            ? `${MIXED.slice(0, -1)}, ${sentence}`
            : `${MIXED} ${sentence}`,
        name,
      );
    }
    if (fix === null) continue;
    const pasted = source.replace(fix[0], fix[1]);
    assert.notEqual(pasted, source, fix[1]);
    assert.deepEqual(
      reported(main(pasted)).filter(({ error }) => error),
      [],
      `the core: ${pasted}`,
    );
    if (!getDefault(pasted))
      assert.deepEqual(v1Errors(pasted), [], `the current checker: ${pasted}`);
  }
  // (a store warning's and a count's kept value: the variable declared with the union, which pasted compiles, or in
  // words where no form is proved)
  const kept: readonly (readonly [string, string, string | null])[] = [
    [
      `let o = {a: 1}\no.a = ${S}\nexit\n`,
      `Keep '${S}' in a new variable declared with the type 'integer | string' and check that it is a whole number (integer) first.`,
      null,
    ],
    [
      `let v = 1\nv = ${S}\nexit\n`,
      `Keep '${S}' in a new variable, as in 'let value: integer | string = ${S}', and check it, as in 'if value is integer { v = value }'.`,
      `let v = 1\nlet value: integer | string = ${S}\nif value is integer { v = value }\nexit\n`,
    ],
    [
      'repeat (askChoice "None", 1, null) {}\nexit\n',
      `Keep 'askChoice "None", 1, null' in a new variable, as in 'let value: integer | string | null = askChoice "None", 1, null', and check it, as in 'if value is integer { repeat (value) {} }'`,
      'let value: integer | string | null = askChoice "None", 1, null\nif value is integer { repeat (value) {} }\nexit\n',
    ],
    [
      'repeat ((askChoice "None", 1, null) otherwise 1) {}\nexit\n',
      `Keep '(askChoice "None", 1, null) otherwise 1' in a new variable, as in 'let value: integer | string = (askChoice "None", 1, null) otherwise 1', and check it, as in 'if value is integer { repeat (value) {} }'`,
      'let value: integer | string = (askChoice "None", 1, null) otherwise 1\nif value is integer { repeat (value) {} }\nexit\n',
    ],
    [
      `let xs = []\nrepeat xs.get(0, default: ${S}) {}\nexit\n`,
      `Keep 'xs.get(0, default: ${S})' in a new variable, as in 'let value: integer | string = xs.get(0, default: ${S})', and check it, as in 'if value is integer { repeat value {} }'.`,
      `let xs = []\nlet value: integer | string = xs.get(0, default: ${S})\nif value is integer { repeat value {} }\nexit\n`,
    ],
    [
      'repeat (askChoice "None", 1, hostValue) {}\nexit\n',
      `Keep 'askChoice "None", 1, hostValue' in a new variable, as in 'let value: integer | string = askChoice "None", 1, hostValue', and check it, as in 'if value is integer { repeat (value) {} }'`,
      'let value: integer | string = askChoice "None", 1, hostValue\nif value is integer { repeat (value) {} }\nexit\n',
    ],
    [
      // (a block past the nesting limit runs the finishing path, whose reads answer nothing: the walk's own record keeps
      // the union, Codex r6 on #1660)
      `repeat (${S}) {}\n${"if true {\n".repeat(257)}say "Done"\n${"}\n".repeat(257)}exit\n`,
      `Keep '${S}' in a new variable, as in 'let value: integer | string = ${S}', and check it, as in 'if value is integer { repeat (value) {} }'`,
      null,
    ],
    [
      // (a list option whose elements mix: its own error, and what its answer reaches is still recorded)
      'repeat ((askChoice ["A", 1]) otherwise 1) {}\nexit\n',
      `Keep '(askChoice ["A", 1]) otherwise 1' in a new variable declared with the type 'integer | string' and check that it is a whole number (integer) first.`,
      null,
    ],
    [
      `repeat ${C} {}\nexit\n`,
      `Keep '${C}' in a new variable, as in 'let value: integer | string = ${C}', and check it, as in 'if value is integer { repeat value {} }'.`,
      `let value: integer | string = ${C}\nif value is integer { repeat value {} }\nexit\n`,
    ],
  ];
  for (const [source, sentence, pasted] of kept) {
    // (each warning at the site gives it, the null's and the text's alike)
    const warned = reported(main(source)).filter(({ error }) => !error);
    assert.ok(
      warned.length > 0 && warned.every(({ message }) => message.includes(` ${sentence}`)),
      `${source}: ${JSON.stringify(warned)}`,
    );
    if (pasted === null) continue;
    assert.deepEqual(
      reported(main(pasted)).filter(({ error }) => error),
      [],
      `the core: ${pasted}`,
    );
    if (!getDefault(pasted))
      assert.deepEqual(v1Errors(pasted), [], `the current checker: ${pasted}`);
  }
  // (where a demand stop holds the walk's read of the answer, the kept form proves its union by a read that answers, or
  // is words: never a plain `let`, Codex r7 on #1660)
  // ([source, demand allowance, whether a read that answers proves the union there, as code or in words; else no read
  // does, and the kept form is words])
  for (const [source, allowance, union] of [
    [`repeat (${S}) {}\nexit\n`, 25, true],
    [`let xs = []\nrepeat xs.get(0, default: ${S}) {}\nexit\n`, 64, true],
    [`let xs = []\nrepeat xs.get(0, default: ${S}) {}\nexit\n`, 256, true],
    [`let xs = []\nrepeat xs.get(0, default: ${S}) {}\nexit\n`, 1, false],
    [`repeat ((${S}) otherwise 1) {}\nexit\n`, 4, true],
    // (the walk's read stopped, and a block past the nesting limit ran the finishing walk, so the read again answers
    // nothing either)
    [
      `repeat (${S}) {}\n${"if true {\n".repeat(257)}say "Done"\n${"}\n".repeat(257)}exit\n`,
      1,
      false,
    ],
  ] as const)
    for (const mode of MODES) {
      const stopped = coreRequest(main(source));
      assert.ok(stopped !== null);
      const { diagnostics } = inMode(mode, () =>
        withTestDemandAllowance(allowance, () => analyseCore(stopped)),
      );
      const text = messageSource([source], diagnostics);
      const kept = diagnostics
        .map((diagnostic) => coreMessage(diagnostic, text))
        .filter((message) => message.includes("in a new variable"));
      assert.ok(
        kept.length > 0 &&
          kept.every(
            (message) =>
              !message.includes("as in 'let value = ") &&
              (!union ||
                message.includes("let value: integer | string = ") ||
                message.includes("in a new variable declared with the type 'integer | string'")),
          ),
        `${allowance} ${JSON.stringify(mode)} ${source}: ${JSON.stringify(kept)}`,
      );
    }
  // (r7's witnesses' kept forms pasted compile: under both checkers, the `get` default's under the core alone, #1075)
  for (const pasted of [
    `let value: integer | string = ${S}\nif value is integer { repeat (value) {} }\nexit\n`,
    `let xs = []\nlet value: integer | string = xs.get(0, default: ${S})\nif value is integer { repeat value {} }\nexit\n`,
  ]) {
    assert.deepEqual(
      reported(main(pasted)).filter(({ error }) => error),
      [],
      `the core: ${pasted}`,
    );
    if (!getDefault(pasted))
      assert.deepEqual(v1Errors(pasted), [], `the current checker: ${pasted}`);
  }
  // (a program that holds no mixed askChoice gets nothing of this rule: no kept-value field, also where a stopped
  // decision leaves a subject unfound, and a warning whose facts a stop did not ask keeps main's plain kept `let`)
  const box =
    "let box = {branch: {branch: {n: 1}}}\n" +
    Array.from({ length: 12 }, (_, i) => `box.branch.branch.n = ${i + 2} + ${i + 3}\n`).join("") +
    "box = {branch: {branch: {n: 4}}}\nrepeat box.branch.branch.n {}\nexit\n";
  const plain = "repeat hostValue.count {}\nexit\n";
  for (const [source, allowance] of [
    [box, 16],
    ["let xs = []\nrepeat xs.get(0, default: hostValue) {}\nexit\n", 16],
    [plain, null],
  ] as const) {
    const nonChoice = coreRequest(main(source));
    assert.ok(nonChoice !== null);
    const analysed =
      allowance === null
        ? analyseCore(nonChoice)
        : withTestDemandAllowance(allowance, () => analyseCore(nonChoice));
    assert.ok(
      analysed.diagnostics.length > 0 && analysed.diagnostics.every((d) => !("keeps" in d)),
      source,
    );
  }
  // (a stopped read of a non-mixed choice leaves an unrelated warning's subject, not found, its plain `let`: an
  // answer reaches a subject only through its own operands, Codex r8 on #1660)
  // (nor does an askChoice that is only a name in the text: a string, a comment, a property, Codex r9 on #1660)
  for (const unrelated of [
    "let xs = []\nrepeat xs.get(0, default: hostValue) {}\nrepeat (askChoice 1, null) {}\nexit\n",
    'let xs = []\nrepeat xs.get(0, default: "askChoice") {}\nexit\n',
    "let xs = []\nrepeat xs.get(0, /* askChoice */ default: hostValue) {}\nexit\n",
    "let box = {askChoice: hostValue}\nlet xs = []\nrepeat xs.get(0, default: box.askChoice) {}\nexit\n",
    // (a recorded choice in an expression that starts with the warned site but ends past it is not within it)
    'let xs = []\nrepeat xs.get(0, default: hostValue) otherwise askChoice "None", [5, 10] {}\nexit\n',
  ])
    for (const mode of MODES) {
      const request = coreRequest(main(unrelated));
      assert.ok(request !== null);
      const { diagnostics } = inMode(mode, () =>
        withTestDemandAllowance(16, () => analyseCore(request)),
      );
      const atGet = diagnostics.filter(
        (d) =>
          d.site.start === unrelated.indexOf("xs.get") &&
          d.site.end === unrelated.indexOf(") ", unrelated.indexOf("xs.get")) + 1,
      );
      assert.ok(
        atGet.length > 0 && atGet.every((d) => !("keeps" in d)),
        `${JSON.stringify(mode)} ${unrelated}`,
      );
    }
  // (a stop inside the rule's stage takes back the running choice's unit alone: the choice completed before it keeps its
  // error, Codex r10 on #1660; the stop is the second choice's read, so its own error is the one taken back)
  const two = `let a = ${S}\nlet b = ${S}\nexit\n`;
  for (const [mode, allowance] of MODES.map(
    (mode) => [mode, mode.unshared ? 1149 : 1240] as const,
  )) {
    const request = coreRequest(main(two));
    assert.ok(request !== null);
    const stopped = inMode(mode, () => withTestAllowance(allowance, () => analyseCore(request)));
    assert.equal(stopped.budget.exhausted, "work", JSON.stringify(mode));
    assert.equal(
      stopped.diagnostics.filter((d) => d.code === "TSV044").length,
      1,
      `${JSON.stringify(mode)} ${allowance}`,
    );
  }
  // (a non-mixed choice's carried subject whose own publication read stops: the honest unproved fact, its message the
  // same, though a later read of the choice itself settles, which never proves the carried subject (a second home for
  // its types); at the first allowance where the subject's read settles, no fact: the lead's amendment of ruling A on
  // #1660, worded after Codex r10)
  const unsettled = "let xs = []\nrepeat xs.get(0, default: askChoice 1, 2) {}\nexit\n";
  for (const mode of MODES) {
    const request = coreRequest(main(unsettled));
    assert.ok(request !== null);
    const stopped = inMode(mode, () => withTestDemandAllowance(1, () => analyseCore(request)));
    const text = messageSource([unsettled], stopped.diagnostics);
    const facts = stopped.diagnostics.filter((d) => "keeps" in d && d.keeps === "unproved");
    assert.ok(facts.length > 0, JSON.stringify(mode));
    for (const diagnostic of facts) {
      if (!("keeps" in diagnostic)) continue;
      const { keeps: _, ...without } = diagnostic;
      assert.equal(coreMessage(diagnostic, text), coreMessage(without, text), JSON.stringify(mode));
    }
    const settled = inMode(mode, () => withTestDemandAllowance(4, () => analyseCore(request)));
    assert.ok(
      settled.diagnostics.every((d) => !("keeps" in d)),
      `${JSON.stringify(mode)} settles at 4`,
    );
  }
  // (a `get` call's receiver is its own place, however it is grouped or chained: the choice in its arguments never
  // makes the receiver's kept form unproved, Codex r12 on #1660)
  for (const receiverForm of ["(xs)", "((xs))", "(xs.get(0, default: hostValue))", "(f())"]) {
    const grouped = `let xs = []\nfunction f {\n  return hostValue\n}\nrepeat ${receiverForm}.get(0, default: askChoice 1, 2) {}\nexit\n`;
    const at = grouped.indexOf(`${receiverForm}.get(0, default: askChoice`);
    for (const mode of MODES) {
      const request = coreRequest(main(grouped));
      assert.ok(request !== null);
      const { diagnostics } = inMode(mode, () =>
        withTestDemandAllowance(1, () => analyseCore(request)),
      );
      const onReceiver = diagnostics.filter((d) => d.code === "TSV043" && d.site.start === at);
      assert.ok(
        onReceiver.length > 0 && onReceiver.every((d) => !("keeps" in d)),
        `${JSON.stringify(mode)} ${receiverForm}`,
      );
    }
  }
  // (an unfound subject is unproved where its own span holds the recorded choice: the receiver of the outer `get`;
  // the inner `get`'s receiver `xs` holds none, Codex r11 on #1660)
  const holding = `let xs = []\nrepeat (xs.get(0, default: ${S})).get(0, default: 1) {}\nexit\n`;
  for (const mode of MODES) {
    const request = coreRequest(main(holding));
    assert.ok(request !== null);
    const { diagnostics } = inMode(mode, () =>
      withTestDemandAllowance(1, () => analyseCore(request)),
    );
    const outer = diagnostics.filter(
      (d) => d.code === "TSV043" && d.site.start === holding.indexOf("(xs.get"),
    );
    assert.ok(
      outer.length > 0 && outer.every((d) => "keeps" in d && d.keeps === "unproved"),
      JSON.stringify(mode),
    );
    const inner = diagnostics.filter(
      (d) => d.code === "TSV043" && d.site.start === holding.indexOf("xs.get"),
    );
    assert.ok(
      inner.every((d) => !("keeps" in d)),
      JSON.stringify(mode),
    );
  }
  const plainRequest = coreRequest(main(plain));
  assert.ok(plainRequest !== null);
  const plainDiagnostics = analyseCore(plainRequest).diagnostics;
  const plainText = messageSource([plain], plainDiagnostics);
  const unasked = plainDiagnostics.map((diagnostic) => {
    if (!("present" in diagnostic)) return coreMessage(diagnostic, plainText);
    const { present: _, ...rest } = diagnostic;
    return coreMessage(rest, plainText);
  });
  assert.ok(
    unasked.some((message) =>
      message.includes("in a new variable, as in 'let value = hostValue.count'"),
    ),
    JSON.stringify(unasked),
  );
  // (a warning no fact proves a plain `let` for keeps its value in words: Codex r2 on #1660)
  const direct = `repeat ${C} {}\nexit\n`;
  const request = coreRequest(main(direct));
  assert.ok(request !== null);
  const { diagnostics } = analyseCore(request);
  const text = messageSource([direct], diagnostics);
  // (as after a stop: no facts asked)
  const unproved = diagnostics.map((diagnostic) => {
    if (!("keeps" in diagnostic)) return coreMessage(diagnostic, text);
    const { keeps: _, present: __, ...rest } = diagnostic;
    return coreMessage(rest, text);
  });
  assert.ok(
    unproved.some((message) =>
      message.includes(
        `Keep '${C}' in a new variable and check that it is a whole number (integer) first.`,
      ),
    ),
    JSON.stringify(unproved),
  );
});

/**
 * #1352 (Codex r10 on #1660): the kept-value fact's work, counted apart from the allowance, grows with the warnings and
 * choices no faster than linearly: k warnings each holding its own mixed choice, k = 16 to 128, four modes, at most
 * ×2.05 per doubling (a scan of every recorded choice per warning grows by more).
 */
test("the kept-value fact's work grows linearly with the warnings and the choices (#1352)", () => {
  for (const mode of MODES) {
    const work = [16, 32, 64, 128].map((k) => {
      const source = `${'repeat (askChoice "None", [5, 10]) {}\n'.repeat(k)}exit\n`;
      const request = coreRequest(main(source));
      assert.ok(request !== null);
      return inMode(mode, () => analyseCore(request)).budget.apart.get("checks") ?? 0;
    });
    for (let at = 1; at < work.length; at += 1)
      assert.ok(work[at]! <= 2.05 * work[at - 1]!, `${JSON.stringify(mode)} ${work.join(", ")}`);
  }
});

/**
 * #1274: a fix that keeps a value in a new variable names one free in the whole project (`MessageSource.freeName`):
 * `value`, else `value2`, `value3`, …, the first no identifier of any file's code spells (a property's name aside) and
 * no host global or built-in reserves, and its check reads that name. Each of the sentence's three forms (a null check,
 * a type check of a kept union, a selection's length) beside each way a name is or is not taken (declared before the
 * use or after it, as a function, a parameter, two names at once; only in a text or as a property's name; a host
 * global): the `let` and the check pasted in place of the use's line compile.
 */
test("a kept value's variable takes a name free in the project, and the fix compiles where pasted (#1274)", () => {
  const uses = [
    { setup: "let xs = [7, null]", use: "say xs[0] + 1" },
    { setup: "let v = 1", use: 'v = askChoice "None", [5, 10]' },
    { setup: "let groups: integer[][] = [[], [21]]", use: "say groups.random.last" },
  ];
  const taken: readonly (readonly [string, readonly string[], readonly string[], string])[] = [
    ["free", [], [], "value"],
    ["declared before", ["let value = 2"], ["say value"], "value2"],
    ["declared after", [], ["let value = 2", "say value"], "value2"],
    ["a function", ["function value { return 1 }"], [], "value2"],
    ["a parameter", ["function f(value) { return value }"], [], "value2"],
    ["two names", ["let value = 2", "let value2 = 3"], ["say value + value2"], "value3"],
    ["only in a text", ['say "value"'], [], "value"],
    ["only a property's name", ["let o = {value: 1}", "say o.value"], [], "value"],
  ];
  for (const { setup, use } of uses)
    for (const [name, before, after, expected] of taken) {
      const source = [setup, ...before, use, ...after, "exit", ""].join("\n");
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, source);
      const { diagnostics } = analyseCore(request);
      const text = messageSource([source], diagnostics);
      const fix = diagnostics
        .map((diagnostic) => coreMessage(diagnostic, text))
        .map((message) =>
          /as in '(let [^']*)', and check (?:it|its length), as in '(if [^']*)'/.exec(message),
        )
        .find((found) => found !== null);
      assert.ok(fix !== undefined && fix !== null, `${name}: ${source}`);
      const [, keep, check] = fix;
      assert.ok(keep!.startsWith(`let ${expected}`), `${name}: ${keep}`);
      assert.ok(new RegExp(`\\b${expected}\\b`).test(check!), `${name}: ${check}`);
      const pasted = source.replace(`${use}\n`, `${keep}\n${check}\n`);
      const fixed = coreRequest([{ path: "main.tease", source: pasted }]);
      assert.ok(fixed !== null, `${name}: the pasted names resolve: ${pasted}`);
      assert.deepEqual(
        analyseCore(fixed).diagnostics.filter((d) => d.class === "compile-error"),
        [],
        `${name}: ${pasted}`,
      );
    }
  // (a host global the script never names is reserved too, as the compile reads the analysis: `coreCheckResult`, the
  // one that forwards the request's globals and built-ins to its message source)
  const source = "let xs = [7, null]\nsay xs[0] + 1\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "value"])!;
  const checked = coreCheckResult(
    analyseCore(request),
    new SliceIndex(request.files.map((file) => file.program)),
    request,
  );
  const messages = checked.diagnostics.flat().map((diagnostic) => diagnostic.message);
  assert.ok(
    messages.some((message) => message.includes("as in 'let value2 = xs[0]'")),
    JSON.stringify(messages),
  );
});

/**
 * #1274, Codex r1's B1: the names a fix may not declare are surveyed without a native call per level, so a warning's
 * message beside an expression of any depth still compiles (12,800 nested parentheses).
 */
test("a warning's fix beside a deeply nested expression still compiles (#1274)", () => {
  const source = `let n = ${"(".repeat(12800)}1${")".repeat(12800)}\nrepeat hostValue {}\nexit\n`;
  const result = compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND);
  assert.ok(result.plan !== null);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV011"],
  );
});

/**
 * #1274, Astra r1 on #1715: the kept variable's name is chosen once per program, its survey charged to the analysis's
 * total as a shared build and to no demand. k warnings beside a taken `value`, k = 16 to 256: each fix names `value2`,
 * the survey's charge is at least one unit per syntax node, the demands' records stay as the analysis left them, and
 * the total after the messages grows at most ×2.15 per doubling of the nodes (a survey per warning grows by ×4).
 */
test("a kept value's name is surveyed once, charged to the analysis and no demand (#1274)", () => {
  const measured = [16, 32, 64, 128, 256].map((k) => {
    const source = `let value = 1\nlet xs = [7, null]\n${"say xs[0] + 1\n".repeat(k)}exit\n`;
    const request = coreRequest([{ path: "main.tease", source }])!;
    const answers = analyseCore(request);
    const before = answers.budget;
    // (the records as the analysis left them, copied: the budget's lists are the answers' own, Codex r4 T1 on #1730)
    const [demands, decisions] = [
      structuredClone(before.demands),
      structuredClone(before.decisions),
    ];
    const checked = coreCheckResult(
      answers,
      new SliceIndex(request.files.map((file) => file.program)),
      request,
    );
    const fixes = checked.diagnostics
      .flat()
      .filter((diagnostic) => diagnostic.message.includes("as in 'let value2 = xs[0]'"));
    assert.equal(fixes.length, k, `k = ${k}`);
    const nodes = before.counts.get("syntaxNodes")!;
    const surveyed =
      (answers.budget.counts.get("indexSteps") ?? 0) - (before.counts.get("indexSteps") ?? 0);
    assert.ok(surveyed >= nodes, `k = ${k}: ${surveyed} survey units for ${nodes} nodes`);
    assert.deepEqual(answers.budget.demands, demands, `k = ${k}`);
    assert.deepEqual(answers.budget.decisions, decisions, `k = ${k}`);
    return { total: answers.budget.total, nodes };
  });
  for (let at = 1; at < measured.length; at += 1) {
    const [small, large] = [measured[at - 1]!, measured[at]!];
    const doubling = (2 * (large.total / small.total)) / (large.nodes / small.nodes);
    assert.ok(doubling <= 2.15, `${JSON.stringify(measured)}: ${doubling.toFixed(3)} per doubling`);
  }
});

/**
 * #1274, Codex r3 on #1715: the kept name's survey charges each name the host reserves and each file's root too, so its
 * charge grows with unused host globals and with empty files (16 and 256 of each). After a stop, its units are
 * finishing work, counted in the finishing breakdown as in the total.
 */
test("a kept value's name survey charges the host's names and every file (#1274)", () => {
  const source = "let value = 1\nlet xs = [7, null]\nsay xs[0] + 1\nexit\n";
  for (const [globals, empty] of [
    [16, 0],
    [256, 0],
    [0, 16],
    [0, 256],
  ] as const) {
    const files = [
      { path: "main.tease", source },
      ...Array.from({ length: empty }, (_, at) => ({ path: `empty${at}.tease`, source: "" })),
    ];
    const hosts = ["hostValue", ...Array.from({ length: globals }, (_, at) => `host${at}`)];
    const request = coreRequest(files, hosts)!;
    const answers = analyseCore(request);
    const before = answers.budget;
    assert.equal(answers.keptName("value"), "value2");
    const nodes = before.counts.get("syntaxNodes")!;
    const surveyed =
      (answers.budget.counts.get("indexSteps") ?? 0) - (before.counts.get("indexSteps") ?? 0);
    assert.ok(
      surveyed >= nodes + hosts.length,
      `${globals} globals, ${empty} empty files: ${surveyed} units for ${nodes} nodes and ${hosts.length} names`,
    );
  }
  const request = coreRequest([{ path: "main.tease", source }])!;
  const stopped = analyseCore(request).stoppedAt("work");
  stopped.keptName("value");
  const { finishing, apart } = stopped.budget;
  assert.equal(
    [...apart.values()].reduce((sum, units) => sum + units, 0),
    finishing,
  );
});

/**
 * #1495 (#1468's rule for a place an object literal types): where a store's place is a property below the warned value,
 * TSV041's advice names that property in words and where its type must come from, the narrowest expression that owns it
 * (`MessageSource.owner`), never the whole literal; also where a part of the value already fits, and for a value an
 * element selection of a list literal gives (`[a, b].random`) or either operand of `otherwise` (a value the set's
 * collision family gives, where the check named a whole number for an element that holds an object). A value whose
 * place is its own keeps its own check, also where its landing is unknown (`boxes[0].x`, Codex r1 N1 on #1730), and a
 * declared place with no test of what fits keeps its own advice, a separate property, beside the same place's type
 * inferred from a value (the lead's ruling on #1730).
 */
test("TSV041's advice names the property an object literal types and its narrowest owner (#1495)", () => {
  const other = 'let other = fromJson("{\\"volume\\": \\"loud\\"}", default: null)';
  const cases: readonly (readonly [string, string, string, string])[] = [
    [
      `${other}\nlet wrap = {inner: [{volume: 5}, other].random}\nsay "\${wrap.inner.volume}"\nexit\n`,
      "{inner: [{volume: 5}, other].random}",
      "Give 'wrap.inner.volume' a whole number (integer) where '[{volume: 5}, other].random' gets its value.",
      "Check that 'other' is an object first.",
    ],
    [
      'let wrap = {inner: [{volume: 5}, hostValue].random}\nsay "${wrap.inner.volume}"\nexit\n',
      "hostValue",
      "Give 'wrap.inner.volume' a whole number (integer) where 'hostValue' gets its value.",
      "",
    ],
    [
      `${other}\nlet wrap = ({inner: {deep: ([{volume: 5}, other][0])}})\nsay "\${wrap.inner.deep.volume}"\nexit\n`,
      "({inner: {deep: ([{volume: 5}, other][0])}})",
      "Give 'wrap.inner.deep.volume' a whole number (integer) where '[{volume: 5}, other][0]' gets its value.",
      "Check that 'other' is an object first.",
    ],
    [
      "let t: integer = 7\nlet peer = {x: t}\nlet first = [hostValue otherwise {x: 1}, peer]\nexit\n",
      "hostValue",
      "Give 'x' of an element of 'first' a whole number (integer) where 'hostValue' gets its value.",
      "Check that 'hostValue' is an object first.",
    ],
    [
      "let t: integer = 7\nlet peer = {x: t}\nlet first = [{y: hostValue otherwise peer}, {y: peer}]\nexit\n",
      "hostValue",
      "Give 'y.x' of an element of 'first' a whole number (integer) where 'hostValue' gets its value.",
      "Check that 'hostValue' is an object first.",
    ],
    [
      "let t: integer = 7\nlet peer = {x: t}\nlet first = [peer, {x: hostValue otherwise 1}]\nexit\n",
      "hostValue",
      "Check that 'hostValue' is a whole number (integer) first.",
      "",
    ],
    [
      "let t: integer = 1\nlet box = {x: t}\nlet boxes = [box]\nboxes[0].x = hostValue otherwise 1\nexit\n",
      "hostValue",
      "Check 'hostValue' first, as in 'if hostValue is integer { boxes[0].x = hostValue otherwise 1 }'.",
      "",
    ],
    [
      "let typed: list = [1]\nlet root = {f: typed}\nlet holder = [root, hostValue]\nexit\n",
      "hostValue",
      "Use a separate property for a value of another type.",
      "Check that 'hostValue' is an object first.",
    ],
    [
      `${other}\nlet holder = [{f: [1]}, other]\nsay "\${holder[0].f}"\nexit\n`,
      "[{f: [1]}, other]",
      "Give 'f' of an element of 'holder' a list where '[{f: [1]}, other]' gets its value.",
      "",
    ],
  ];
  for (const [source, at, advice, own] of cases) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const message = (site: string): string =>
      diagnostics
        .filter((d) => d.code === "TSV041" && text.text(d.site) === site)
        .map((d) => coreMessage(d, text))
        .join(" | ");
    assert.ok(message(at).includes(advice), `${at}: ${message(at)}`);
    // (the value whose place is its own keeps its own check)
    const all = diagnostics
      .filter((d) => d.code === "TSV041")
      .map((d) => coreMessage(d, text))
      .join(" | ");
    if (own !== "") assert.ok(all.includes(own), all);
  }
});

/**
 * #1753 (ADR 0021 rule 4.2): a store whose place is an element below the stored value, through collections alone, is
 * checked by the value's whole receiving type, which tests every element, where the root's written type proves every
 * layer of it with its `null` (a `let`, a `global`, a parameter: Codex r1's B1, `integer[]?[]`); pasted where `codeAt`
 * proves it, else in words, and with no fallback, which would replace the whole value. Where no written type proves
 * the layers (a copy of one), the words name the elements the check tests. An element store keeps its element's test.
 * Each pasted check compiles under both checkers, where the element's scalar test it replaces is an error. Below a
 * literal's element, the mixed error names the earliest element's type with its `null`; the element itself keeps its
 * kinds' words. In four modes.
 */
test("a store below its value checks the whole receiving type, null kept, and the mixed error names it (#1753)", () => {
  const warned = (into: string, value: string, fix: string) =>
    `${into}, but '${value}' may be a value of another type here. ${STOPS} ${fix} ${OUTSIDE(value)}`;
  const nullable = "'a' holds whole numbers or null (integer?[])";
  const cases: readonly (readonly [source: string, site: string, message: string])[] = [
    [
      'let a:integer?[]=[1]\na=hostValue\nlet b=a\nlet c=b\nlet xs=[c,["x"]]\nexit\n',
      "hostValue",
      warned(
        nullable,
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer?[] { a=hostValue }'.",
      ),
    ],
    [
      'let a:integer?[]=[1]\na=hostValue\nlet b=a\nlet c=b\nlet xs=[c,["x"]]\nexit\n',
      '"x"',
      "This list mixes a list (integer?[]) and a list (string[]). A list holds one type. Use values of one type in it.",
    ],
    [
      'let a:integer?[]=[1]\na=hostValue\nlet xs=[{f:a},{f:["x"]}]\nexit\n',
      '"x"',
      "This list mixes objects whose property 'f' holds a list (integer?[]) in one and a list (string[]) in another. " +
        "A list holds one type. Give 'f' one type in every element.",
    ],
    [
      'let xs=[[1,null],["x"]]\nexit\n',
      '"x"',
      "This list mixes a list (integer?[]) and a list (string[]). A list holds one type. Use values of one type in it.",
    ],
    [
      'let n:integer?=1\nlet xs=[n,"x"]\nexit\n',
      '"x"',
      "This list mixes a whole number (integer) and text (string). A list holds one type. To allow both, declare it " +
        "as 'let xs: (integer | string)[] =[n,\"x\"]'.",
    ],
    [
      "let d:integer? dict=dict {}\nd=hostValue\nexit\n",
      "hostValue",
      warned(
        "'d' holds whole numbers or null (integer? dict)",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer? dict { d=hostValue }'.",
      ),
    ],
    [
      "let a:integer?[][]=[[1]]\na=hostValue\nexit\n",
      "hostValue",
      warned(
        "An element of an element of 'a' is declared as a whole number (integer) or null",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer?[][] { a=hostValue }'.",
      ),
    ],
    [
      "let a:integer[]=[1]\nlet b=[1, hostValue]\na=b\nexit\n",
      "b",
      warned(
        "'a' holds whole numbers (integer[])",
        "b",
        "Check 'b' first, as in 'if b is integer[] { a=b }'.",
      ),
    ],
    [
      "let a:integer[]=[1]\nlet b=[hostValue otherwise null]\na=b\nexit\n",
      "b",
      "'a' holds whole numbers (integer[]), but 'b' may be null here. " +
        `${STOPS} Check 'b' first, as in 'if b is integer[] { a=b }'.`,
    ],
    // (every layer's `null`, from the written type: Codex r1's B1)
    ...[
      "An element of 'a' is declared as a list or null",
      "An element of an element of 'a' is declared as a whole number (integer)",
    ].map(
      (into) =>
        [
          "let a:integer[]?[]=[[1]]\na=hostValue\nexit\n",
          "hostValue",
          warned(
            into,
            "hostValue",
            "Check 'hostValue' first, as in 'if hostValue is integer[]?[] { a=hostValue }'.",
          ),
        ] as const,
    ),
    [
      "let a:integer[]?=[1]\na=hostValue\nexit\n",
      "hostValue",
      warned(
        "'a' holds whole numbers (integer[])",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer[]? { a=hostValue }'.",
      ),
    ],
    [
      "global g: integer[]? dict = dict {}\ng=hostValue\nexit\n",
      "hostValue",
      warned(
        "An element of an element of 'g' is declared as a whole number (integer)",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer[]? dict { g=hostValue }'.",
      ),
    ],
    [
      'function f(p: integer[]?[]) {\n    p=hostValue\n    say "${p.length}"\n}\nf([[1]])\nexit\n',
      "hostValue",
      warned(
        "An element of an element of 'p' is declared as a whole number (integer)",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer[]?[] { p=hostValue }'.",
      ),
    ],
    // (a copy of a written type: no written type proves its layers, so the words name the elements)
    [
      "let x:integer[]?[]=[[1]]\nlet b=x\nb=hostValue\nexit\n",
      "hostValue",
      warned(
        "An element of an element of 'b' is declared as a whole number (integer)",
        "hostValue",
        "Check that every element of every element of 'hostValue' is a whole number (integer) first.",
      ),
    ],
    [
      "let x:integer[]? dict=dict {}\nlet b=x\nb=hostValue\nexit\n",
      "hostValue",
      warned(
        "An element of 'b' is declared as a list or null",
        "hostValue",
        "Check that every value of 'hostValue' is a list or null first.",
      ),
    ],
    [
      "let x:integer[]?[]=[[1]]\nlet a={f: x}\na.f=[hostValue]\nexit\n",
      "hostValue",
      warned(
        "An element of an element of 'a.f' is declared as a whole number (integer)",
        "hostValue",
        "Check that every element of 'hostValue' is a whole number (integer) first.",
      ),
    ],
    // (words where no form holds: a declaration's start value)
    [
      "let a:integer?[]=hostValue\nexit\n",
      "hostValue",
      warned(nullable, "hostValue", "Check that 'hostValue' is a list (integer?[]) first."),
    ],
    // (an element store, and a literal's element: the element's own test)
    [
      "let a:integer?[]=[1]\na[0]=hostValue\nexit\n",
      "hostValue",
      warned(
        nullable,
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer { a[0]=hostValue }'.",
      ),
    ],
    [
      "let a:integer?[]=[1]\na=[1, hostValue]\nexit\n",
      "hostValue",
      warned(
        nullable,
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer { a=[1, hostValue] }'.",
      ),
    ],
  ];
  for (const mode of MODES)
    for (const [source, site, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.site === site && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
  // (each pasted check compiles under both checkers; the scalar test it replaces does not)
  const errors = (source: string) => [
    ...compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] })
      .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => `current ${diagnostic.code}`),
    ...reported(main(source))
      .filter((each) => each.error)
      .map((each) => `core ${each.code}`),
  ];
  for (const followed of [
    "let a:integer?[]=[1]\nif hostValue is integer?[] { a=hostValue }\nexit\n",
    "let d:integer? dict=dict {}\nif hostValue is integer? dict { d=hostValue }\nexit\n",
    "let a:integer?[][]=[[1]]\nif hostValue is integer?[][] { a=hostValue }\nexit\n",
    "let a:integer[]=[1]\nlet b=[1, hostValue]\nif b is integer[] { a=b }\nexit\n",
    "let a:integer[]?[]=[[1]]\nif hostValue is integer[]?[] { a=hostValue }\nexit\n",
    "let a:integer[]?=[1]\nif hostValue is integer[]? { a=hostValue }\nexit\n",
    "global g: integer[]? dict = dict {}\nif hostValue is integer[]? dict { g=hostValue }\nexit\n",
  ])
    assert.deepEqual(errors(followed), [], followed);
  assert.deepEqual(
    errors("let a:integer?[]=[1]\nif hostValue is integer { a=hostValue }\nexit\n"),
    ["current TSV041", "core TSV041"],
  );
});

/**
 * #1730 Codex r1 B1: a warning's landing and owner (`landingOf`, `ownerOf`) find the value a statement gives and a
 * literal's part by their start, so k warnings, each in its own statement or each an element of one list, read the
 * statements' values and the list's elements O(k log k) times, not once per earlier one (k = 64 to 256, at most ×2.5
 * per doubling; a scan per warning grows by ×4).
 */
test("a warning's landing and owner read the program's values by their start (#1495)", () => {
  // (an array whose every element is read through a counting getter, as the lookups' indexed reads and searches do)
  const counted = <T extends object>(items: readonly T[], count: { reads: number }): T[] => {
    const array: T[] = [...items];
    items.forEach((item, at) =>
      Object.defineProperty(array, at, {
        get: () => {
          count.reads += 1;
          return item;
        },
      }),
    );
    return array;
  };
  const reads = (k: number, list: boolean): number => {
    const source = list
      ? `let holder = [${Array.from({ length: k }, () => "{inner: hostValue}").join(", ")}]\nexit\n`
      : `${Array.from({ length: k }, (_, at) => `let w${at} = {inner: {volume: 5}}\nw${at}.inner = hostValue\n`).join("")}exit\n`;
    const count = { reads: 0 };
    const statements = parse(source).program.statements;
    let given: Given[] = statements.flatMap((statement) => givenBy(statement) ?? []);
    const sites = source
      .split("hostValue")
      .slice(0, -1)
      .map((_, at, parts) => {
        const start = parts.slice(0, at + 1).join("hostValue").length;
        return { file: 0, start, end: start + "hostValue".length };
      });
    assert.equal(sites.length, k);
    if (list) {
      const [holder] = given;
      assert.ok(holder !== undefined && holder.value.kind === "listLiteral");
      given = [
        { ...holder, value: { ...holder.value, elements: counted(holder.value.elements, count) } },
      ];
    } else given = counted(given, count);
    for (const site of sites) {
      assert.notEqual(landingOf(given, site), null);
      ownerOf(given, site, [{ property: "volume" }]);
    }
    return count.reads;
  };
  for (const list of [false, true]) {
    const measured = [64, 128, 256].map((k) => reads(k, list));
    for (let at = 1; at < measured.length; at += 1)
      assert.ok(
        measured[at]! <= 2.5 * measured[at - 1]!,
        `${list ? "elements" : "values"}: ${measured.join(", ")}`,
      );
  }
});

/**
 * #1730, Astra r1 B1: a message's walk to a warned value and an owner's index charge their work, one unit per item a
 * search compares, per expression walked, per property an owner's index holds (made once per literal) and per step it
 * takes; through `coreCheckResult` the units count to the analysis's total as a shared build (`Answers.messageWork`),
 * to no demand, and grow linearly with the warnings (k = 64 to 256, at most ×2.5 per doubling).
 */
test("a message's walk and owner index charge their work, to the analysis and no demand (#1495)", () => {
  const n = 64;
  const properties = Array.from({ length: n }, (_, at) => `p${at}: 1`).join(", ");
  const source = `let wrap = {${properties}, inner: {volume: 5}}\nexit\n`;
  const [given] = parse(source).program.statements.flatMap((statement) => givenBy(statement) ?? []);
  assert.ok(given !== undefined && given.value.kind === "objectLiteral");
  const literal = given.value;
  const whole = { file: 0, start: literal.span.start.offset, end: literal.span.end.offset };
  let units = 0;
  const charge = (more: number): void => {
    units += more;
  };
  const steps = [{ property: "inner" }, { property: "volume" }];
  ownerOf([given], whole, steps, charge);
  // (one value compared, one expression walked, the outer index's n + 1 entries and the inner's one, two steps taken)
  assert.equal(units, 1 + 1 + (n + 1) + 1 + 2);
  units = 0;
  ownerOf([given], whole, steps, charge);
  // (each index made once)
  assert.equal(units, 1 + 1 + 2);
  // (the landing at `5`: one value compared, three expressions walked, the properties each literal's search compares)
  const count = { reads: 0 };
  const read = <T extends object>(items: readonly T[]): T[] => {
    const array: T[] = [...items];
    items.forEach((item, at) =>
      Object.defineProperty(array, at, {
        get: () => {
          count.reads += 1;
          return item;
        },
      }),
    );
    return array;
  };
  const inner = literal.properties.at(-1)!.value;
  assert.ok(inner.kind === "objectLiteral");
  const counted: Given = {
    ...given,
    value: {
      ...literal,
      properties: read([
        ...literal.properties.slice(0, -1),
        { ...literal.properties.at(-1)!, value: { ...inner, properties: read(inner.properties) } },
      ]),
    },
  };
  const five = source.indexOf("volume: 5") + "volume: ".length;
  units = 0;
  assert.notEqual(landingOf([counted], { file: 0, start: five, end: five + 1 }, charge), null);
  assert.equal(units, 1 + 3 + count.reads);
  // (each parenthesis unwrapped is a unit more: d around an owner's two literals, 2d; d around a selection's list, d)
  const charged = (code: string, at: (code: string) => SourceSite, owned: boolean): number => {
    const [entry] = parse(code).program.statements.flatMap((statement) => givenBy(statement) ?? []);
    assert.ok(entry !== undefined, code);
    let spent = 0;
    const add = (more: number): void => {
      spent += more;
    };
    if (owned) ownerOf([entry], at(code), steps, add);
    else assert.notEqual(landingOf([entry], at(code), add), null, code);
    return spent;
  };
  const wrapped = (d: number, text: string): string => `${"(".repeat(d)}${text}${")".repeat(d)}`;
  const value = (code: string): SourceSite => ({
    file: 0,
    start: code.indexOf("= ") + 2,
    end: code.indexOf("\nexit"),
  });
  const element = (code: string): SourceSite => {
    const start = code.indexOf("{volume: 5}");
    return { file: 0, start, end: start + "{volume: 5}".length };
  };
  for (const d of [1, 4, 16]) {
    const owner = (depth: number): string =>
      `let wrap = ${wrapped(depth, `{a: 1, inner: ${wrapped(depth, "{volume: 5}")}}`)}\nexit\n`;
    assert.equal(
      charged(owner(d), value, true) - charged(owner(0), value, true),
      2 * d,
      `owner, ${d}`,
    );
    const selection = (depth: number): string =>
      `let wrap = {inner: ${wrapped(depth, "[{volume: 5}, hostValue]")}[0]}\nexit\n`;
    assert.equal(
      charged(selection(d), element, false) - charged(selection(0), element, false),
      d,
      `selection, ${d}`,
    );
  }
  // (through the compile's consumer: what the messages charge is the analysis's, beside the same compile whose messages
  // charge nothing; a demand's records as they were)
  const compiled = (k: number, charging: boolean) => {
    const program = `${Array.from({ length: k }, (_, at) => `let w${at} = {inner: [{volume: 5}, hostValue].random}\n`).join("")}exit\n`;
    const request = coreRequest([{ path: "main.tease", source: program }])!;
    const answers = analyseCore(request);
    const before = answers.budget;
    // (the records as the analysis left them, copied: the budget's lists are the answers' own, Codex r4 T1 on #1730)
    const [demands, decisions] = [
      structuredClone(before.demands),
      structuredClone(before.decisions),
    ];
    let charged = 0;
    const counts = answers.messageWork.bind(answers);
    answers.messageWork = (more) => {
      charged += more;
      counts(charging ? more : 0);
    };
    const checked = coreCheckResult(
      answers,
      new SliceIndex(request.files.map((file) => file.program)),
      request,
    );
    const owned = checked.diagnostics
      .flat()
      .filter((diagnostic) => diagnostic.message.includes("where 'hostValue' gets its value"));
    assert.equal(owned.length, k, `k = ${k}`);
    assert.deepEqual(answers.budget.demands, demands, `k = ${k}`);
    assert.deepEqual(answers.budget.decisions, decisions, `k = ${k}`);
    return {
      charged,
      total: answers.budget.total,
      indexSteps: answers.budget.counts.get("indexSteps") ?? 0,
    };
  };
  const work = [64, 128, 256].map((k) => {
    const [charging, free] = [compiled(k, true), compiled(k, false)];
    assert.ok(charging.charged >= 2 * k, `k = ${k}: ${charging.charged}`);
    assert.equal(charging.charged, free.charged, `k = ${k}`);
    assert.equal(charging.total - free.total, charging.charged, `k = ${k}`);
    assert.equal(charging.indexSteps - free.indexSteps, charging.charged, `k = ${k}`);
    return charging.charged;
  });
  for (let at = 1; at < work.length; at += 1)
    assert.ok(work[at]! <= 2.5 * work[at - 1]!, work.join(", "));
});
