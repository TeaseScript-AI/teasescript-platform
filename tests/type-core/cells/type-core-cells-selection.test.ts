// Collection selection in the cells: a choice object's value by its key, a held button's mark, a selection's emptiness
// mark.

import assert from "node:assert/strict";
import test from "node:test";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import {
  recordDifferences,
  recordOf,
  type CompactRecord,
  type CompactSite,
} from "../../helpers/type-core-records.js";
import { summary } from "../../helpers/type-core/type-core-cells-setup.js";

/**
 * #1026: a choice object gives its `value` where it has the key and its `text` where it has
 * none, decided by the key and never by what the value resolves to (an empty answer is unresolved, not an absent key),
 * per alternative, on the value side and through a function's result (the contract) alike; a dict's `values` and
 * `keys` are lists of its values and of text that may hold none. Per program its record in both orders, with its sites
 * written as the text they start at: the set's records `cp9-cells/s4/choice-value/…` (set `486ac8093b597b45`), C9's
 * boundary check left out (it joins with S6), and controls beside them.
 */
test("a choice object's value is selected by its key, and a dict's values and keys are lists", () => {
  const programs: readonly (readonly [
    string,
    string,
    (at: (text: string) => number) => string[],
  ])[] = [
    [
      "set computed-integer",
      'let result: integer = askChoice {text:"A", value:dict{k:7}.values.first}\nsay [result]\nexit\n',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k:7}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "set computed-string",
      'let result = askChoice {text:0, value:dict{k:"bad"}.values.first}\nrepeat result {}\nexit\n',
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("result {}")}`,
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k:"bad"}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "set bound-integer",
      'let v = dict{k:7}.values.first\nlet result: integer = askChoice {text:"A", value:v}\nsay [result]\nexit\n',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k:7}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "set mixed-omitted",
      'repeat askChoice [{text:"A", value:1}, {text:"B"}] {}\nexit\n',
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("askChoice")}`,
        `integer-check askChoice [{text:"A", value:1}, {text:"B"}] [integer] @${at("askChoice")}`,
      ],
    ],
    [
      "set all-integer",
      'repeat askChoice [{text:"A", value:1}, {text:"B", value:2}] {}\nexit\n',
      () => ["valid"],
    ],
    ["set omitted-integers", "repeat askChoice [{text:0}, {text:1}] {}\nexit\n", () => ["valid"]],
    [
      "set omitted-string-written",
      'let s: integer = askChoice [{text:"A"}]\nexit\n',
      (at) => ["compile-error", `written-target compile-error @${at("askChoice")}`],
    ],
    [
      "set external-written",
      'let result: integer = askChoice {text:"A", value:hostValue}\nsay [result]\nexit\n',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type result [integer] @${at("hostValue")}`,
        // (a choice value from outside the script: C13's warning and its check, the sentence review of #1437)
        `operator warning-runtime-check @${at("hostValue")}`,
        `operand hostValue [integer, number, string, boolean, duration, calendarDuration, angle, date, time, datetime, absoluteDateTime, null] @${at("hostValue")}`,
      ],
    ],
    // each alternative its own: the first object's value, the second's text, never the first's text
    [
      "an omitted value beside a present one",
      // (the options' shared `text` of one kind: a literal's elements share their properties' types, ADR 0021 1.4)
      "repeat askChoice [{text: 1, value: 1}, {text: 2}] {}\nexit",
      () => ["valid"],
    ],
    // a value computed in a solver component: the choice's own result, whichever member the solve enters
    [
      "a value from its own component",
      'function pick(n) {\n  if n > 0 { return askChoice {text: 0, value: pick(n - 1)} }\n  return "bad"\n}\nlet r: string = pick(1)\nexit',
      () => ["valid"],
    ],
    [
      "a wrong value from its own component",
      'function pick(n) {\n  if n > 0 { return askChoice {text: "zero", value: pick(n - 1)} }\n  return 5\n}\nlet r: string = pick(1)\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("pick(1)")}`],
    ],
    // the contract: a function's result (F20)
    [
      "a computed value through a result",
      'function pick { return askChoice {text: "A", value: dict{k: 7}.values.first} }\nlet n: integer = pick()\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k: 7}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "a wrong computed value through a result",
      'function pick { return askChoice {text: 0, value: dict{k: "bad"}.values.first} }\nrepeat pick() {}\nexit',
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("pick() {}")}`,
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k: "bad"}.values [list] @${at("dict")}`,
      ],
    ],
    // a present value that may be a missing member is that value, never the text beside it
    [
      "a value that may be missing",
      'let flag = askBoolean "f"\nfunction pick(f) {\n  if f { return {maybe: "s"} }\n  return {other: 1}\n}\nlet r: string = askChoice {text: 1, value: pick(flag).maybe}\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("pick(flag)")}`,
        `written-target warning-runtime-check @${at("askChoice")}`,
        `copy-type r [string] @${at("askChoice")}`,
        `null-check pick.result [non-null] @${at("pick(flag)")}`,
        `operator warning-runtime-check @${at("pick(flag)")}`,
        `operand pick(flag).maybe [integer, number, string, boolean, duration, calendarDuration, angle, date, time, datetime, absoluteDateTime, null] @${at("pick(flag)")}`,
      ],
    ],
    // choice objects held in a variable, a container or a parameter: each record its own `value` or `text`, never
    // another record's `text` (#1027 review, Astra D1)
    [
      "held records with a value and without one",
      "let opts = [{text: 0, value: 1}, {text: 2}]\nrepeat askChoice opts {}\nexit",
      () => ["valid"],
    ],
    [
      "held records that do not fit",
      'let opts = [{text: "x", value: "bad"}, {text: "also bad"}]\nrepeat askChoice opts {}\nexit',
      (at) => ["compile-error", `integer-use compile-error @${at("askChoice")}`],
    ],
    [
      "held records in a dict under a computed key",
      'let key = "pick"\nlet choices = dict{[key]: {text: 0, value: 3}, other: {text: 4}}\nrepeat askChoice choices.values {}\nexit',
      () => ["valid"],
    ],
    [
      "held records from a parameter of two calls",
      'function pick(opts) { return askChoice opts }\nrepeat pick([{text: "unused", value: 1}]) {}\nrepeat pick([{text: 2}]) {}\nexit',
      () => ["valid"],
    ],
    // (the two returns' records share `text`, of one kind: ADR 0021 1.4, 1.5)
    [
      "a held record from a result",
      "function make(n) {\n  if n > 0 { return {text: 0, value: n} }\n  return {text: 2}\n}\nrepeat askChoice make(1) {}\nexit",
      () => ["valid"],
    ],
    // under a test of the record's `value` the button value is marked, as the read of the `value` is
    [
      "a held record under a test of its value",
      'let o = {text: "A", value: 1.5}\nif o.value is integer { let n: integer = askChoice o }\nexit',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("askChoice")}`,
        `copy-type n [integer] @${at("askChoice")}`,
      ],
    ],
    // a record's `value` stored after it is made is read by its key (a number widens the place, ADR 0021 1.2; a text
    // there would be admission's error and be ignored, A6)
    [
      "a held record whose value is stored",
      'let o = {text: "A", value: 1}\no.value = 2.5\nlet n: integer = askChoice o\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("askChoice")}`],
    ],
    // and a record's `text` stored after it is made (a number widens the place); a key without a store below it stays
    // per record (Astra on #1027), the options' texts of one kind (ADR 0021 1.4)
    [
      "a held record whose text is stored",
      "let o = {text: 1}\no.text = 2.5\nlet n: integer = askChoice o\nexit",
      (at) => ["compile-error", `written-target compile-error @${at("askChoice")}`],
    ],
    [
      "held records beside a value stored elsewhere",
      "let other = {value: 0}\nother.value = 1\nlet opts = [{text: 0, value: 1}, {text: 2}]\nrepeat askChoice opts {}\nexit",
      () => ["valid"],
    ],
    [
      "held records none of whose buttons fits, beside a value stored elsewhere",
      'let other = {value: 0}\nother.value = 1\nlet opts = [{text: "w", value: "x"}, {text: "y"}]\nrepeat askChoice opts {}\nexit',
      (at) => ["compile-error", `integer-use compile-error @${at("askChoice")}`],
    ],
    // a choice object held in a variable, whose value may be a missing member: possibly its text, never certainly
    [
      "a held choice object whose value may be missing",
      'let flag = askBoolean "f"\nfunction pick(f) {\n  if f { return {maybe: "s"} }\n  return {other: 1}\n}\nlet o = {text: 1, value: pick(flag).maybe}\nlet r: string = askChoice o\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("pick(flag)")}`,
        `written-target warning-runtime-check @${at("askChoice")}`,
        `copy-type r [string] @${at("askChoice")}`,
        `null-check pick.result [non-null] @${at("pick(flag)")}`,
      ],
    ],
    // a dict's lists outside a choice: read, copied, and an object's own property of the name
    [
      "a dict's values",
      'repeat dict{k: "bad"}.values.first {}\nexit',
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("dict")}`,
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k: "bad"}.values [list] @${at("dict")}`,
      ],
    ],
    // F12 with P3: an element read from an open derived list is possible, so a key is possible text, a
    // warning with its check; a target through a dict's list is its source text, no key of the dict
    [
      "a dict's keys",
      "let d = dict{k: 1}\nrepeat d.keys.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("d.keys")}`,
        `member-read warning-runtime-check @${at("d.keys")}`,
        `empty-check d.keys [list] @${at("d.keys")}`,
        `integer-check d.keys.first [integer] @${at("d.keys")}`,
      ],
    ],
    [
      "a copy of a dict's values read by its contract",
      'let d = dict{k: "bad"}\nlet vs = d.values\nshowPermanentButton "b" { vs = d.values }\nrepeat vs.first {}\nexit',
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("vs.first")}`,
        `member-read warning-runtime-check @${at("vs.first")}`,
        `empty-check vs [list] @${at("vs.first")}`,
        `integer-check vs.element [integer] @${at("vs.first")}`,
      ],
    ],
    // a selection takes only its own emptiness: a deeper list's `empty-check` stays (#1027 review, Astra B1)
    [
      "a dict's values at depth 1",
      "let d = dict{a: 1}\nrepeat d.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "a dict's values at depth 2",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "a dict's keys below its values",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.keys.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.keys [list] @${at("d.values")}`,
        `integer-check d.values.first.keys.first [integer] @${at("d.values")}`,
      ],
    ],
    [
      "a dict's values at depth 3",
      "let d = dict{a: dict{x: dict{}}, b: dict{y: dict{v: 1}}}\nrepeat d.values.first.values.first.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values.first.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "a cleared inner dict's values",
      "let inner = dict{v: 1}\ninner.clear()\nlet d = dict{a: inner}\nrepeat d.values.first.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "an inner dict bound before its values are read",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nlet inner = d.values.first\nrepeat inner.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("inner.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check inner.values [list] @${at("inner.values")}`,
      ],
    ],
    // the list-literal analogue: the inner list's selection keeps its check
    [
      "a list's lists",
      "let d = [[], [1]]\nrepeat d.first.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.first")}`,
        `empty-check d.element [list] @${at("d.first")}`,
      ],
    ],
    // under a test of its own path the read is marked, as `xs.first` is
    [
      "a dict's values under a test of their path",
      'let d = dict{k: "a"}\nif d.values.first is integer { repeat d.values.first {} }\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values.first is")}`,
        `member-read warning-runtime-check @${at("d.values.first {}")}`,
        `integer-use warning-runtime-check @${at("d.values.first {}")}`,
        `empty-check d.values [list] @${at("d.values.first is")}`,
        `empty-check d.values [list] @${at("d.values.first {}")}`,
        `integer-check d.values.first [integer] @${at("d.values.first {}")}`,
      ],
    ],
    // C1's site at the external value among the options a dict's values give a choice
    [
      "a choice over a dict's values",
      'let n: integer = askChoice dict{a: {text: "A", value: hostValue}}.values\nexit',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type n [integer] @${at("hostValue")}`,
        `operator warning-runtime-check @${at("dict")}`,
        `operand dict{a: {text: "A", value: hostValue}}.values [integer, number, string, boolean, duration, calendarDuration, angle, date, time, datetime, absoluteDateTime, null] @${at("dict")}`,
      ],
    ],
    // F19a: a receiver that may be a reference has the runtime's members, before a dict's list (review r2)
    [
      "a dict's keys on a receiver that may be a reference",
      // (a written union: a store of the speaker into the dict's place would be admission's error and be ignored, A6;
      // the union, a dict beside the speaker, is also V30 §13's error)
      'let o: string dict | speaker = dict{k: "bad"}\nrepeat o.keys.first {}\nexit',
      (at) => [
        "compile-error",
        `written-type compile-error @${at("string dict | speaker")}`,
        `member-read warning-runtime-check @${at("o.keys.first")}`,
        `member-read warning-runtime-check @${at("o.keys.first")}`,
        `member-read warning-runtime-check @${at("o.keys.first")}`,
        `integer-use warning-runtime-check @${at("o.keys.first")}`,
        `null-check o [non-null] @${at("o.keys.first")}`,
        `empty-check o.keys [list] @${at("o.keys.first")}`,
        `null-check o.keys [non-null] @${at("o.keys.first")}`,
        `integer-check o.keys.first [integer] @${at("o.keys.first")}`,
      ],
    ],
    // the same through an operation and a literal: the receiver's completed contract decides (review r3)
    [
      "a dict's keys through an operation whose receiver may be a reference",
      // (a dict or the speaker: a value of an unrestricted dict, since a written union of them is V30 §13's error)
      'speaker vera { length: 2 }\nlet pool: dict = dict{a: dict{k: "bad"}, b: vera}\nlet o = pool.get("a", default: vera)\nrepeat (o otherwise null).keys.first {}\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `integer-use warning-runtime-check @${at("(o otherwise")}`,
        `null-check o otherwise null [non-null] @${at("(o otherwise")}`,
        `null-check o otherwise null [non-null] @${at("(o otherwise")}`,
        `empty-check (o otherwise null).keys [list] @${at("(o otherwise")}`,
        `null-check (o otherwise null).keys [non-null] @${at("(o otherwise")}`,
        `integer-check (o otherwise null).keys.first [integer] @${at("(o otherwise")}`,
        // (#1072: the stored values are a dict and the speaker, never null, so the fallback never runs, V30 §18; the
        // current checker reads the unrestricted dict's value as unknown and gives no warning)
        `static warning @${at("otherwise null)")}`,
      ],
    ],
    // a path through eight objects' own `values` is read once per step, as any property's (review r2: it exhausted the
    // allowance)
    [
      "a path through eight objects' own values",
      `let n0 = {v: 7}\n${Array.from({ length: 8 }, (_, i) => `let n${i + 1} = {values: [n${i}]}`).join("\n")}\nrepeat n8${".values.first".repeat(8)}.v {}\nexit`,
      () => ["valid"],
    ],
    [
      "an object's own values",
      "let o = {values: [1]}\nlet t: string = o.values.first\nexit",
      (at) => ["compile-error", `written-target compile-error @${at("o.values.first")}`],
    ],
    [
      "external data among a dict's values",
      "let n: integer = dict{k: hostValue}.values.first\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type n [integer] @${at("hostValue")}`,
        `empty-check dict{k: hostValue}.values [list] @${at("dict")}`,
      ],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expect] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const expected = expect((text) => source.indexOf(text)).sort();
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = summary({ ...record, checks: record.checks.filter((check) => !check.boundary) });
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * Review round 5 on #1027: a held choice object's button value keeps the mark of a test of the key it selects,
 * through copies, a list's element and a parameter, as the keyed read does; a test of the other key marks neither. (A
 * path below a button's value holds nothing: an object there is TSV029's error.) Per program its record in both orders against the same program with the keyed read in its place, the
 * checks' targets aside.
 */
test("a held choice object's button value is marked by a test of its selected key, as the keyed read is", () => {
  // (each read at a count: the keyed read of the tested path takes its narrowing at every consumer since #1073 PR 2,
  // which the choice's value, no read of the tested path, does not; there the choice keeps the mark the keyed read had,
  // and the keyed read is the tested kind, the last column)
  const cases: readonly (readonly [string, string, string, string, string, string])[] = [
    [
      "a test of its value",
      'let o = {text: "unused", value: 2.0}\nif o.value is integer { repeat READ {} }\nexit',
      "askChoice o",
      "o.value",
      "warning-runtime-check",
      "valid",
    ],
    [
      "a test of its text, without a value",
      "let o = {text: 2.0}\nif o.text is integer { repeat READ {} }\nexit",
      "askChoice o",
      "o.text",
      "warning-runtime-check",
      "valid",
    ],
    [
      "a copy of a copy in the tested branch",
      'let o = {text: "unused", value: 2.0}\nif o.value is integer {\nlet p = o\nlet q = p\nrepeat READ {}\n}\nexit',
      "askChoice q",
      "q.value",
      "warning-runtime-check",
      "warning-runtime-check",
    ],
    [
      "a list's element",
      'let opts = [{text: "unused", value: 2.0}]\nif opts[0].value is integer { repeat READ {} }\nexit',
      "askChoice opts",
      "opts[0].value",
      "warning-runtime-check",
      "valid",
    ],
    [
      "a parameter",
      'function pick(o) {\nif o.value is integer { repeat READ {} }\n}\npick({text: "unused", value: 2.0})\nexit',
      "askChoice o",
      "o.value",
      "warning-runtime-check",
      "valid",
    ],
    [
      "a test of the other key",
      "let o = {text: 2.0, value: 2.5}\nif o.text is integer { repeat READ {} }\nexit",
      "askChoice o",
      "o.value",
      "compile-error",
      "compile-error",
    ],
  ];
  // its outcome first, then its diagnostics with their contexts and its checks without their targets
  const shape = (record: CompactRecord): string[] => [
    record.outcome,
    ...[
      ...record.diagnostics.map(
        (d) => `${d.kind} ${d.class} ${d.context ?? "-"} @${d.site.offset}`,
      ),
      ...record.checks.map(
        (check) =>
          `${check.kind} [${check.against.join(", ")}]${check.boundary ? " boundary" : ""} @${check.site.offset}`,
      ),
    ].sort(),
  ];
  const differing: string[] = [];
  for (const [name, program, choice, keyed, outcome, keyedOutcome] of cases)
    for (const reversed of [false, true]) {
      const [got, expected] = [choice, keyed].map((read) => {
        const request = coreRequest([
          { path: "main.tease", source: program.replace("READ", read) },
        ]);
        assert.ok(request !== null, `${name}: its source parses and resolves`);
        const run = (): CompactRecord =>
          withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
        return shape(reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run());
      });
      // (where the keyed read takes its narrowing, the choice keeps the mark it had: a warning and its check at the read)
      const at = program.indexOf("READ");
      const marked = [
        outcome,
        `integer-check [integer] @${at}`,
        `integer-use warning-runtime-check branch @${at}`,
      ];
      const same =
        keyedOutcome === outcome
          ? JSON.stringify(got) === JSON.stringify(expected)
          : JSON.stringify(got) === JSON.stringify(marked) &&
            JSON.stringify(expected) === JSON.stringify([keyedOutcome]);
      if (!same || got![0] !== outcome)
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got!.join("; ")}`);
    }
  assert.deepEqual(differing, []);
});

/**
 * #1027's B1 beyond a dict's lists (review round 5's R5-3, Astra's delta): a collection's `get`, a loop's visit and the
 * removals that give an element consume only the selected element's emptiness mark; a demanded descendant's passes
 * through, so its read keeps the check whose runtime failure (TSR018) it guards. Per collection (a list, a dict's
 * values), form and depth 1–3, the selected element holds a list that many levels deep whose innermost may be empty,
 * read that many `first`s down; both orders. A scalar element is the control.
 */
test("a selection consumes only its own emptiness mark below get, a loop's visit and a removal", () => {
  const nest = (inner: string, depth: number): string =>
    `${"[".repeat(depth - 1)}${inner}${"]".repeat(depth - 1)}`;
  const collections: readonly (readonly [string, (depth: number) => string])[] = [
    ["a list", (depth) => `let c = [${nest("[]", depth)}, ${nest("[1]", depth)}]`],
    [
      "a dict's values",
      (depth) =>
        `let d = dict{a: ${nest("[]", depth)}, b: ${nest("[1]", depth)}}\nlet c = d.values`,
    ],
  ];
  // per form, the selection with its default (the selected element's shape) and the read below it
  const forms: readonly (readonly [string, (fallback: string, read: string) => string])[] = [
    ["get", (fallback, read) => `let picked = c.get(0, default: ${fallback})\nrepeat ${read} {}`],
    ["a loop's visit", (_, read) => `for picked in c { repeat ${read} {} }`],
    ["removeFirst", (_, read) => `let picked = c.removeFirst()\nrepeat ${read} {}`],
    ["removeAt", (_, read) => `let picked = c.removeAt(0)\nrepeat ${read} {}`],
  ];
  const programs: [string, string, string[]][] = [];
  for (const [collection, made] of collections)
    for (const [form, select] of forms)
      for (const depth of [1, 2, 3]) {
        const read = `picked${".first".repeat(depth)}`;
        const source = `${made(depth)}\n${select(nest("[1]", depth), read)}\nexit`;
        const at = source.indexOf(`repeat ${read}`) + "repeat ".length;
        const expected = [
          "warning-runtime-check",
          `member-read warning-runtime-check @${at}`,
          `empty-check picked${".element".repeat(depth - 1)} [list] @${at}`,
        ];
        // a dict's values may hold none: its removal keeps its own check (C6)
        if (collection === "a dict's values" && form === "removeFirst")
          expected.push(
            `member-read warning-runtime-check @${source.indexOf("c.removeFirst")}`,
            `empty-check c [list] @${source.indexOf("c.removeFirst")}`,
          );
        programs.push([`${form} of ${collection} at depth ${depth}`, source, expected.sort()]);
      }
  for (const [form, select] of forms)
    programs.push([
      `${form} of a list's scalar`,
      `let c = [1, 2]\n${select("1", "picked")}\nexit`,
      ["valid"],
    ]);
  const differing: string[] = [];
  for (const [name, source, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const got = summary(reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run());
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * #1303: host data may be an empty list whatever a written type or a collection test says of its elements (V30 §16;
 * a test proves no element, #1245), so C6 keeps a selection's `empty-check` and its warning at the selection. #1303's
 * two witnesses as exact records; then its matrix: `first`, `last` and `random`, with and without a collection test, on
 * a host list written, with nullable elements, copied, nested, below a property or untyped, beside the `fromJson`,
 * `load` and literal controls, where only a literal with an element is quiet; and beside it the same data through a
 * computed key's load, a parameter, loops and an interpolation, with an opaque and a literal control. Every program
 * alike forward, with the sharing of answers off, and with the consumers' and solver's orders reversed.
 */
test("a host list's selection keeps its empty-check under a written type or a collection test (#1303)", () => {
  const modes: readonly (readonly [string, (run: () => CompactRecord) => CompactRecord])[] = [
    ["forward", (run) => run()],
    ["unshared", (run) => withoutSharing(run)],
    [
      "reversed",
      (run) =>
        withSolverSeam({ reverseWorklist: true }, () =>
          withConsumerOrder((list) => [...list].reverse(), run),
        ),
    ],
  ];
  const analysedIn = (source: string): CompactRecord => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const [first, ...others] = modes.map(([, mode]) => mode(() => compactAnalysis(request)));
    others.forEach((other, index) =>
      assert.deepEqual(other, first, `${source}(${modes[index + 1]![0]})`),
    );
    return first!;
  };
  const witnesses: readonly (readonly [string, string])[] = [
    [
      'let xs: integer[] = hostValue\nsay "BEFORE"\nlet out = xs.first\nsay "AFTER"\nexit\n',
      `outcome warning-runtime-check
       D written-target warning 20:29 unknown
       D written-target warning 20:29 unknown
       D member-read warning 53:61 unknown
       D member-read warning 53:61 unknown
       C copy-type xs [list] 20:29
       C copy-type xs.element [integer] 20:29
       B copy-type xs [list] 20:29
       C null-check xs [non-null] 53:61
       C empty-check xs [list] 53:61`,
    ],
    // (the collection test proves the kind, never the ingress: the external data keeps its boundary check where it
    // enters, C9, the lead's ruling (a) on #1073 PR 2, as the fixture's `n1-unknown-positive` records)
    [
      'let xs = hostValue\nif xs is integer[] {\n    let out = xs.first\n    say "AFTER"\n}\nexit\n',
      `outcome warning-runtime-check
       D member-read warning 54:62 unknown
       B copy-type xs [unknown] 9:18
       C empty-check xs [list] 54:62`,
    ],
  ];
  for (const [source, text] of witnesses)
    assert.deepEqual(recordDifferences(recordOf(text), analysedIn(source)), [], source);
  // a program's empty-checks, each its target at a read, and at each one's site a warning per check there
  const differing: string[] = [];
  const expect = (source: string, owed: readonly (readonly [string, string])[]): void => {
    const record = analysedIn(source);
    const at = (site: CompactSite): string => `${site.offset}:${site.end}`;
    const got = record.checks
      .filter((check) => check.kind === "empty-check")
      .map((check) => `${check.target} [${check.against.join(", ")}] ${at(check.site)}`);
    const expected = owed.map(([target, read]) => {
      const start = source.lastIndexOf(read);
      return `${target} [list] ${start}:${start + read.length}`;
    });
    const unwarned = record.checks
      .filter((check) => check.kind === "empty-check")
      .filter(
        (check) =>
          record.checks.filter((other) => !other.boundary && at(other.site) === at(check.site))
            .length !==
          record.diagnostics.filter(
            (diagnostic) =>
              diagnostic.kind === "member-read" && at(diagnostic.site) === at(check.site),
          ).length,
      );
    if (JSON.stringify(got) !== JSON.stringify(expected) || unwarned.length > 0)
      differing.push(`${source}: ${got.join("; ")}${unwarned.length > 0 ? " (unwarned)" : ""}`);
  };
  const carriers: readonly (readonly [string, string])[] = [
    ["let xs: integer[] = hostValue", "xs"],
    ["let xs: integer?[] = hostValue", "xs"],
    ["let ys: integer[] = hostValue\nlet xs = ys", "xs"],
    ["let rows: integer[][] = hostValue\nlet xs = rows[0]", "xs"],
    ["let ys: integer[] = hostValue\nlet o = { items: ys }", "o.items"],
    ["let xs = hostValue", "xs"],
    ["let xs: integer[] = fromJson(hostValue, default: [])", "xs"],
    ["let xs = fromJson(hostValue, default: [1])", "xs"],
    ['let xs: integer[] = load("k", default: [])', "xs"],
    ['let xs = load("k", default: [1])', "xs"],
    ["let xs: integer[] = []", "xs"],
    ["let xs: integer[] = [1]", "xs"],
  ];
  for (const [carrier, owner] of carriers)
    for (const tested of [false, true])
      for (const selection of ["first", "last", "random"]) {
        const read = `${owner}.${selection}`;
        const body = tested
          ? `if ${owner} is integer[] {\n    let out = ${read}\n    say "AFTER"\n}`
          : `say "BEFORE"\nlet out = ${read}\nsay "AFTER"`;
        expect(
          `${carrier}\n${body}\nexit\n`,
          carrier === "let xs: integer[] = [1]" ? [] : [[owner, read]],
        );
      }
  // a computed key's load is host data (F19), below a property, written or tested, and gathered in a literal too (one
  // answer for every path below its root, whose mark is the path's, in either order); so is a written parameter's host
  // argument; a loop over a host list may not run, so the list it fills may stay empty (F5a); a loop's variable over a
  // host list, nested and written, tested or copied to a written place, may be empty; so may an interpolated written
  // host list (C11); an opaque value stored after `[]` keeps its check, selected or looped over (F5a); a literal with a
  // host element holds one
  const computed = 'let k = askText "key?"\n';
  const raw = "let key: string = hostValue\nlet raw = load(key, default: {items: [1]})\n";
  const loads = `${computed}let rows = [load(k, default: [1]), load(k, default: [2])]\n`;
  expect(`${computed}let xs: integer[] = load(k, default: [1])\nlet out = xs.first\nexit\n`, [
    ["xs", "xs.first"],
  ]);
  expect(`${raw}let xs: integer[] = raw.items\nlet out = xs.first\nexit\n`, [["xs", "xs.first"]]);
  expect(`${raw}if raw.items is integer[] {\n    let out = raw.items.first\n}\nexit\n`, [
    ["raw.items", "raw.items.first"],
  ]);
  expect(`${loads}let xs: integer[] = rows[0]\nlet out = xs.first\nexit\n`, [["xs", "xs.first"]]);
  expect(
    "let rows = hostValue\nfor row in rows {\n    let xs: integer[] = row\n    let out = xs.first\n}\nexit\n",
    [["xs", "xs.first"]],
  );
  expect("function f(xs: integer[]) {\n    return xs.first\n}\nlet out = f(hostValue)\nexit\n", [
    ["f.xs", "xs.first"],
  ]);
  expect(
    "let xs: integer[] = hostValue\nlet ys: integer[] = []\nfor x in xs {\n    ys.add(x)\n}\nlet out = ys.first\nexit\n",
    [["ys", "ys.first"]],
  );
  expect("let rows: integer[][] = hostValue\nfor xs in rows {\n    let out = xs.first\n}\nexit\n", [
    ["xs", "xs.first"],
  ]);
  expect(
    "let rows = hostValue\nfor xs in rows {\n    if xs is integer[] {\n        let out = xs.first\n    }\n}\nexit\n",
    [["xs", "xs.first"]],
  );
  expect('let xs: string[] = hostValue\nsay "${xs}"\nexit\n', [["xs", "xs"]]);
  const opaque = 'let s = "zzz"\nlet xs: string[] = []\nxs = s.findAll(/a/)\n';
  expect(`${opaque}let out = xs.first\nexit\n`, [["xs", "xs.first"]]);
  expect(
    `${opaque}let ys: string[] = []\nfor x in xs {\n    ys.add(x)\n}\nlet out = ys.first\nexit\n`,
    [["ys", "ys.first"]],
  );
  expect("let xs: integer[] = [hostValue]\nlet out = xs.first\nexit\n", []);
  assert.deepEqual(differing, []);
});
