// S9b's sentences word for word, as the sentence review of #1437 settled them: the value checks that owe the runtime
// nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { checkedResult } from "../../../src/type-inference/core/check-result/check-result.js";
import { coreMessage, messageSource } from "../../../src/type-inference/core/messages.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { main } from "../../helpers/type-core/type-core-messages-setup.js";

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

/**
 * S9b's sentences word for word (the sentence review of #1437, the ported-sentence rule): every new or changed sentence
 * of the checks that owe the runtime nothing, TSV029, C13's consumers and G2, as the compiler reads them (`checkedResult`:
 * the analysis's diagnostics with the static ones, a known calendar offset one diagnostic), each source's diagnostics
 * in order.
 */
test("S9b's sentences read word for word as the sentence review settled them (#1437)", () => {
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
