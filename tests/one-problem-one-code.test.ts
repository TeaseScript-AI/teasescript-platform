import assert from "node:assert/strict";
import test from "node:test";

import { compileSource, type CompileOptions } from "../src/compiler.js";
import type { ArgumentPlan, ExpressionPlan, InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import { RuntimeFault } from "../src/runtime/errors.js";
import { temporalMethod, temporalNow } from "../src/runtime/values/temporal-operations.js";
import { createSourcePosition, createSourceSpan } from "../src/source.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

// One problem gets one code and one text, whichever pass, path, or form of the source finds it, and two problems get a
// code each (IMPLEMENTATION-AND-REVIEW.md, "One home for each language rule").

/** The code and message of each diagnostic of `source`. */
function diagnostics(source: string, options?: CompileOptions): (readonly [string, string])[] {
  return compileSource(`${source}\nexit`, options).diagnostics.map(({ code, message }) => [
    code,
    message,
  ]);
}

test("problems that shared a code have one each", () => {
  for (const [source, code] of [
    ["debugMode = true", "TSV004"],
    ["function f {\n    return { n: 1 }\n}\nf().n = 5", "TSV067"],
    ["timer 10 s {\n    say 1\n}", "TSV033"],
    ['let t = timer(duration: 1 s, async: true, display: "loud")', "TSV068"],
    ['playAudio(file: "a.mp3", volume: 2)', "TSV036"],
    ['let s = playAudio "bell.mp3"', "TSV069"],
    ["let x = 1e999", "TSC001"],
  ])
    assert.deepEqual(
      diagnostics(source!).map(([found]) => found),
      [code],
      source,
    );
  const plan = validateInstructionPlan({ format: "teasescript-instruction-plan", version: 1 });
  assert.equal(plan.errors[0]?.code, "TSC010");
  assert.equal(plan.errors[0]?.path, "$.version");
});

test("a tag with two different numbers is TST004 with one text in a header, an image, and takePhoto", () => {
  const text = "The tag 'level' has two different numbers, 1 and 2. Keep one, such as 'level: 1'.";
  assert.deepEqual(diagnostics("---\ntags: level: 1, level: 2\n---"), [["TST004", text]]);
  assert.deepEqual(diagnostics('let photo = takePhoto(tags: ["level: 1", "level: 2"])'), [
    ["TST004", text],
  ]);
  // A single-file compile gives an image's diagnostics no path, so the text names the image.
  assert.deepEqual(
    diagnostics("", { images: [{ path: "a.jpg", keywords: ["level: 1", "level: 2"] }] }),
    [
      [
        "TST004",
        "The tag 'level' of the image 'a.jpg' has two different numbers, 1 and 2. Keep one, such as 'level: 1'.",
      ],
    ],
  );
});

test("a missing speaker after 'as' is TSP029 in every form", () => {
  for (const source of [
    'say as "Hello"',
    "let s = say as",
    'showButton as "Go"',
    'let name = askText as "Name?"',
    'let pick = askChoice as "a", "b"',
  ])
    assert.deepEqual(
      diagnostics(source),
      [["TSP029", "Expected a speaker identifier after 'as'."]],
      source,
    );
  assert.deepEqual(diagnostics("speaker")[0]?.[0], "TSP003");
  // The parser rejects a choice without options before the name pass runs.
  assert.deepEqual(diagnostics("let pick = askChoice"), [
    ["TSP030", "Expected at least one choice option."],
  ]);
});

test("a name that a literal gives twice has one text in both passes", () => {
  const property = (owner: string, name: string) =>
    `Duplicate ${owner} property '${name}'. Each property may appear only once. Remove one of the entries.`;
  const key = 'Duplicate dict key "a". Each key may appear only once. Remove one of the entries.';
  assert.deepEqual(diagnostics("speaker vera {\n    mood: 1\n    mood: 2\n}"), [
    ["TSV007", property("speaker", "mood")],
  ]);
  assert.deepEqual(diagnostics("let o = { a: 1, a: 2 }"), [["TSV007", property("object", "a")]]);
  assert.deepEqual(diagnostics('let d = dict{ a: 1, "a": 2, ["${"a"}"]: 3 }'), [
    ["TSV007", key],
    ["TSV007", key],
  ]);
});

test("each argument rule has one text in both passes", () => {
  const F =
    "function f(a) {\n    return a\n}\nfunction g {\n    return 1\n}\nfunction h(a, b = 1) {\n    return a\n}\n";
  for (const [source, code, message] of [
    // The number of arguments: of a script's function, by the name pass; of a method or built-in, by the type checker.
    [`${F}say g(1)`, "TSV020", "g() takes no arguments, received 1."],
    ['say "a".trim(1)', "TSV020", "trim() takes no arguments, received 1."],
    ["say getDate(1)", "TSV020", "getDate() takes no arguments, received 1."],
    [`${F}say f(1, 2)`, "TSV020", "f() takes 1 argument (a), received 2."],
    ["say sqrt(1, 2)", "TSV020", "sqrt() takes 1 argument (value), received 2."],
    // A name the callee does not take.
    [`${F}say g(x: 1)`, "TSV022", "g() takes no arguments. Remove 'x:'."],
    // A method takes its arguments without names, also one that takes none, as the runtime says (TSR015).
    ['say "a".trim(x: 1)', "TSV022", "trim() takes its arguments without names. Remove 'x:'."],
    ["say sqrt(1, x: 1)", "TSV022", "sqrt() takes its arguments without names. Remove 'x:'."],
    [`${F}say f(1, b: 2)`, "TSV022", "f() has no parameter 'b'. Its only named argument is 'a:'."],
    [
      'say toInteger("1", b: 2)',
      "TSV022",
      "toInteger() has no parameter 'b'. Its only named argument is 'default:'.",
    ],
    [
      "let photo = takePhoto(labels: [])",
      "TSV022",
      "takePhoto() has no parameter 'labels'. Its only named argument is 'tags:'.",
    ],
    // A call without the `default:` it needs.
    [
      'let x = load "k"',
      "TSV020",
      `'load("k", default: value)' needs a 'default:' for a key that has not been saved. Add one, such as 'default: 0', or 'default: null' to check for a missing value with '!= null'.`,
    ],
    [
      'let x = fromJson("1")',
      "TSV020",
      "'fromJson(text, default: value)' needs a 'default:' for text that is not valid JSON. Add one, such as 'default: null'.",
    ],
    // A value the callee needs, which named arguments leave out.
    [`${F}say h(b: 2)`, "TSV024", "h() needs a value for 'a'. Add it by position or as 'a: ...'."],
    [
      'showPopup(buttonText: "Go")',
      "TSV024",
      `showPopup() needs a message. Give it first, as in 'showPopup "Task completed"'.`,
    ],
  ] as const)
    assert.deepEqual(diagnostics(source), [[code, message]], source);
});

test("a date or time call with arguments has the compiler's text where the runtime checks it", () => {
  // The runtime checks the calls of a plan that this compiler did not check.
  const span = createSourceSpan(createSourcePosition(0, 0, 0), createSourcePosition(1, 0, 1));
  const capture = {
    boundaryMs: 0,
    sinceEventSequence: 0,
    epochMs: null,
    context: DEFAULT_TEMPORAL_CONTEXT,
  };
  const day = { kind: "date", year: 2026, month: 10, day: 4 } as const;
  const fault = (run: () => void): readonly [string, string] => {
    try {
      run();
    } catch (error) {
      if (error instanceof RuntimeFault) return [error.code, error.message];
      throw error;
    }
    assert.fail("The call did not fail.");
  };
  for (const [source, run, code, compiledCode = "TSV020"] of [
    ["say getDate(1)", () => temporalNow("getDate", [1], {}, capture, 0, span), "TSR028"],
    // A name is an unknown named argument, as for any other built-in.
    [
      "say getDate(foo: 1)",
      () => temporalNow("getDate", [], { foo: 1 }, capture, 0, span),
      "TSR028",
      "TSV022",
    ],
    [
      'say toDate("2026-10-04").formatDate(locale: "de")',
      () => temporalMethod(day, "formatDate", [], { locale: "de" }, DEFAULT_TEMPORAL_CONTEXT, span),
      "TSR015",
      "TSV022",
    ],
    [
      'say toDate("2026-10-04").toISO(1)',
      () => temporalMethod(day, "toISO", [1], {}, DEFAULT_TEMPORAL_CONTEXT, span),
      "TSR015",
    ],
    [
      'say toDate("2026-10-04").formatDate(1)',
      () => temporalMethod(day, "formatDate", [1], {}, DEFAULT_TEMPORAL_CONTEXT, span),
      "TSR015",
    ],
  ] as const) {
    const compiled = diagnostics(source);
    assert.equal(compiled.length, 1, source);
    assert.equal(compiled[0]![0], compiledCode, source);
    assert.deepEqual(fault(run), [code, compiled[0]![1]], source);
  }
});

test("a problem that the compiler and the runtime both find has the compiler's code and text in both", () => {
  // The runtime finds it in a value whose type or value the compiler does not know.
  const D = "function dynamic(value) {\n    return value\n}\n";
  for (const [known, unknown] of [
    ["say hashText(5)", `${D}say hashText(dynamic(5))`],
    ['say [dict{ "a": 1 }].join()', `${D}say dynamic([dict{ "a": 1 }]).join()`],
    ['say "${1..2}"', `${D}say "\${dynamic(1..2)}"`],
    [
      'let t = timer async 10 s\nsave t as "k"',
      `${D}let t = timer async 10 s\nsave dynamic(t) as "k"`,
    ],
    [
      "let items = [1, 2, 3]\nlet i = -1\nsay items[i]",
      `${D}let items = [1, 2, 3]\nlet i = dynamic(-1)\nsay items[i]`,
    ],
    [
      'let h = timer async 10 s\nh.remaining = "wrong"',
      `${D}let t = timer async 10 s\nlet h = dynamic(t)\nh.remaining = "wrong"`,
    ],
    // A collection is named by its kind, which the runtime knows too.
    [
      "let h = timer async 10 s\nh.remaining = [1]",
      `${D}let t = timer async 10 s\nlet h = dynamic(t)\nh.remaining = [1]`,
    ],
    ['say "abc".split([1])', `${D}say "abc".split(dynamic([1]))`],
    ["say [1].take([1])", `${D}say [1].take(dynamic([1]))`],
    ["let xs = [1]\nxs.addAll(set[2])", `${D}let xs = [1]\nxs.addAll(dynamic(set[2]))`],
    ["let xs = [[1]]\nxs.sort()", `${D}let xs = dynamic([[1]])\nxs.sort()`],
    [
      'let r = encryptText("hi", password: ["p"], publicKey: false, timeLock: false)',
      `${D}let r = encryptText("hi", password: dynamic(["p"]), publicKey: false, timeLock: false)`,
    ],
    // A predict line checked in the compiler's order: x first, then a property that is null or missing.
    [
      "let n = predict({ slope: null, intercept: 0, start: 0 }, 1)",
      `${D}let n = predict(dynamic({ slope: null, intercept: 0, start: 0 }), 1)`,
    ],
    ['let n = predict(5, "a")', `${D}let n = predict(dynamic(5), dynamic("a"))`],
    // Then a start that decides x's kind, also one predict cannot use, before the values the compiler does not check.
    [
      "let n = predict({ slope: 1, intercept: 0, start: 1 s }, 1)",
      `${D}let n = predict(dynamic({ slope: 1, intercept: 0, start: 1 s }), dynamic(1))`,
    ],
    [
      'let n = predict({ slope: "bad", intercept: 0, start: 0 }, toDate("2026-01-01"))',
      `${D}let n = predict(dynamic({ slope: "bad", intercept: 0, start: 0 }), dynamic(toDate("2026-01-01")))`,
    ],
    // An argument is not an index written in brackets, so neither names it.
    [
      "let items = [1, 2]\nlet i = -2\nitems.removeAt(i)",
      `${D}let items = [1, 2]\nlet i = dynamic(-2)\nitems.removeAt(i)`,
    ],
    // Of several values that exist only in the session, the first as written.
    [
      'let t = timer async 10 s\nlet m = say "Hi", instant\nsave { a: t, b: m } as "k"',
      `${D}let t = timer async 10 s\nlet m = say "Hi", instant\nsave dynamic({ a: t, b: m }) as "k"`,
    ],
  ]) {
    const compiled = diagnostics(known!);
    assert.equal(compiled.length, 1, known);
    assert.deepEqual(runtimeFailure(compileValidPlan(`${unknown}\nexit`)), compiled[0], unknown);
  }
});

/** The code and message that the runtime fails `plan` with. */
function runtimeFailure(plan: InstructionPlan): readonly [string, string] {
  const failure = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot.failure;
  assert.notEqual(failure, null, "The plan did not fail.");
  return [failure!.code, failure!.message];
}

type Written = number | string | boolean;

/**
 * The plan of `valid` whose first call of `callee` has the arguments `written` instead: a value, `[name, value]` for a
 * named argument, or `{ kept: index }` for the call's own argument at `index`. It is a plan that the compiler did not
 * check.
 */
function forgedCall(
  valid: string,
  callee: string,
  written: readonly (Written | readonly [string, Written] | { readonly kept: number })[],
): InstructionPlan {
  const plan = structuredClone(compileValidPlan(`${valid}\nexit`));
  const find = (node: unknown): { arguments: unknown } | undefined => {
    if (typeof node !== "object" || node === null) return undefined;
    if (
      "kind" in node &&
      node.kind === "call" &&
      "callee" in node &&
      typeof node.callee === "object" &&
      node.callee !== null &&
      "name" in node.callee &&
      node.callee.name === callee &&
      "arguments" in node
    )
      return node;
    for (const child of Object.values(node)) {
      const found = find(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const span = { so: 0, sl: 0, sc: 0, eo: 1, el: 0, ec: 1 };
  const literal = (value: Written): ExpressionPlan => ({ kind: "literal", value, span });
  const call = find(plan.instructions)!;
  const own = Array.isArray(call.arguments) ? call.arguments : [];
  call.arguments = written.map((argument): ArgumentPlan =>
    typeof argument !== "object"
      ? { kind: "positional", value: literal(argument), span }
      : "kept" in argument
        ? own[argument.kept]
        : { kind: "named", name: argument[0], value: literal(argument[1]), span },
  );
  return plan;
}

test("a call's arguments have the compiler's text where the runtime checks them", () => {
  // The runtime checks the arguments of a plan that this compiler did not check (TSR028), and gives the text of the
  // compiler's first problem.
  const TREND = "let trend = linearRegression([1, 2])\n";
  const DICT = "let d = dict{ a: 1 }\n";
  const TIMER = "let t = timer(duration: 10 s, async: true)\n";
  const LINE = 'let line = say "Hi", instant\n';
  const BUTTON = 'let b = showPermanentButton "Press" {\n}\n';
  for (const [bad, valid, callee, written] of [
    // A numeric, angle, or random function, and `escapeMarkup`.
    ["say round(1.5, x: 1)", "say round(1.5)", "round", [1.5, ["x", 1]]],
    ["say pow(2)", "say pow(2, 3)", "pow", [2]],
    ["say sin()", "say sin(1 deg)", "sin", []],
    ["say random(1)", "say random()", "random", [1]],
    ["say chance(50, x: 1)", "say chance(50)", "chance", [50, ["x", 1]]],
    ["say escapeMarkup()", 'say escapeMarkup("a")', "escapeMarkup", []],
    // `min` and `max` of values or of one list.
    ["say min()", "say min(1, 2)", "min", []],
    ["say max(1, 2, by: 3)", "say max(1, 2)", "max", [1, 2, ["by", 3]]],
    ["say min([1, 2], x: 1)", "say min([1, 2])", "min", [{ kept: 0 }, ["x", 1]]],
    ["say min(5, x: 1)", "say min(5, 6)", "min", [5, ["x", 1]]],
    ['say max(5, by: "w", x: 1)', "say max(5, 6)", "max", [5, ["by", "w"], ["x", 1]]],
    // The list functions.
    ["say sum([1], x: 1)", "say sum([1])", "sum", [1, ["x", 1]]],
    ["say percentile([1])", "say percentile([1], 50)", "percentile", [1]],
    ["say linearRegression()", "say linearRegression([1, 2])", "linearRegression", []],
    [`${TREND}say predict(trend)`, `${TREND}say predict(trend, 1)`, "predict", [1]],
    ["say randomWeighted()", 'say randomWeighted(dict{ "a": 1 })', "randomWeighted", []],
    // The conversions and `hashText`: a name, the number of arguments, and a `default:` they need.
    ["say toString(1, 2)", "say toString(1)", "toString", [1, 2]],
    ['say toNumber("1", x: 1)', 'say toNumber("1")', "toNumber", ["1", ["x", 1]]],
    ["say toInteger()", 'say toInteger("1")', "toInteger", []],
    [
      "let at = toDateTime(1, 2, 3)",
      'let at = toDateTime("2026-10-04T18:00")',
      "toDateTime",
      [1, 2, 3],
    ],
    // Without a written `files: false`, `fromJson` is a file store instruction, not a call.
    [
      'let x = fromJson("1", files: false)',
      'let x = fromJson("1", default: null, files: false)',
      "fromJson",
      ["1", ["files", false]],
    ],
    [
      'let x = fromJson("1", default: null, files: false, x: 1)',
      'let x = fromJson("1", default: null, files: false)',
      "fromJson",
      [{ kept: 0 }, { kept: 1 }, ["files", false], ["x", 1]],
    ],
    [
      "say toJson(1, files: false, x: 1)",
      "say toJson(1, files: false)",
      "toJson",
      [1, ["files", false], ["x", 1]],
    ],
    ['say hashText("a", x: 1)', 'say hashText("a")', "hashText", ["a", ["x", 1]]],
    ["say hashText()", 'say hashText("a")', "hashText", []],
    // `script(...)` reports the number of arguments first.
    ["let s = script()", 'let s = script("main.tease")', "script", []],
    [
      'let s = script("main.tease", x: 1)',
      'let s = script("main.tease")',
      "script",
      ["a", ["x", 1]],
    ],
    // The methods of dicts, lists, sets, and ranges.
    [`${DICT}d.clear(1)`, `${DICT}d.clear()`, "clear", [1]],
    [`${DICT}say d.contains("a", x: 1)`, `${DICT}say d.contains("a")`, "contains", ["a", ["x", 1]]],
    [`${DICT}say d.get("a")`, `${DICT}say d.get("a", default: 0)`, "get", ["a"]],
    ["let l = [1]\nl.add(1, 2)", "let l = [1]\nl.add(1)", "add", [1, 2]],
    ["let l = [1]\nsay l.take()", "let l = [1]\nsay l.take(1)", "take", []],
    ["let l = [1]\nsay l.get(0)", "let l = [1]\nsay l.get(0, default: 0)", "get", [0]],
    ["let s = set[1]\ns.add()", "let s = set[1]\ns.add(1)", "add", []],
    ["say (1..=3).toList(1)", "say (1..=3).toList()", "toList", [1]],
    // The methods of handles, which take no arguments.
    [`${TIMER}t.pause(1)`, `${TIMER}t.pause()`, "pause", [1]],
    [`${TIMER}t.stop(now: true)`, `${TIMER}t.stop()`, "stop", [["now", true]]],
    [`${LINE}line.remove(1)`, `${LINE}line.remove()`, "remove", [1]],
    [`${BUTTON}b.remove(1)`, `${BUTTON}b.remove()`, "remove", [1]],
  ] as const) {
    const compiled = diagnostics(bad);
    assert.ok(compiled.length > 0, bad);
    assert.deepEqual(
      runtimeFailure(forgedCall(valid, callee, written)),
      ["TSR028", compiled[0]![1]],
      bad,
    );
  }
});

test("a value of a type the compiler does not know fails with the compiler's text for its type", () => {
  const D = "function dynamic(value) {\n    return value\n}\n";
  const LINE = 'let line = say "Hi", instant\n';
  for (const [unknown, known] of [
    // A message takes 'remove()', a list 'remove(value)', so the compiler accepts either for an unknown receiver.
    [`${D}dynamic([1]).remove()`, "let l = [1]\nl.remove()"],
    [`${D}${LINE}dynamic(line).remove(1)`, `${LINE}line.remove(1)`],
    [
      `${D}say randomWeighted(dynamic(dict{ "a": 1 }), weight: "w")`,
      'say randomWeighted(dict{ "a": 1 }, weight: "w")',
    ],
    [`${D}say randomWeighted(dynamic([{ w: 1 }]))`, "say randomWeighted([{ w: 1 }])"],
    [`${D}say randomWeighted(dynamic(5))`, "say randomWeighted(5)"],
    [`${D}say randomWeighted(dynamic(set[1]))`, "say randomWeighted(set[1])"],
    [`${D}say randomWeighted(dynamic(/x/))`, "say randomWeighted(/x/)"],
    // A start value, which may not select at random, of a key that the compiler cannot read.
    ['global pick = (load "pi" + "cks", default: [1, 2]).random', "global pick = [1, 2].random"],
    ['global shown = "${load "pi" + "cks", default: [1, 2]}"', 'global shown = "${[1, 2]}"'],
    [
      'speaker anna { mood: (load "pi" + "cks", default: [1, 2]).random }',
      "speaker anna { mood: [1, 2].random }",
    ],
    // Tags from a value that the compiler does not know.
    [
      'let names = load "names", default: ["level: 1", "level: 2"]\nlet photo = takePhoto(tags: names)',
      'let photo = takePhoto(tags: ["level: 1", "level: 2"])',
    ],
    [
      'let names = load "names", default: ["Bed Room"]\nlet photo = takePhoto(tags: names)',
      'let photo = takePhoto(tags: ["Bed Room"])',
    ],
  ]) {
    const compiled = diagnostics(known!);
    assert.equal(compiled.length, 1, known);
    assert.equal(runtimeFailure(compileValidPlan(`${unknown}\nexit`))[1], compiled[0]![1], unknown);
  }
});

test("min or max of one value that is not a list fails at run time with the compiler's rule and text", () => {
  // The compiler takes a value of a type it does not know as maybe a list; one that is not a list breaks the rule of the
  // arguments' names and number (TSV020, TSV022), which the runtime checks under TSR028.
  const D = "function dynamic(value) {\n    return value\n}\n";
  for (const [unknown, known, code] of [
    [`${D}say min(dynamic(5))`, "say min(5)", "TSV020"],
    [`${D}say max(dynamic(1..3))`, "say max(1..3)", "TSV020"],
    [`${D}say min(dynamic(5), by: "w")`, 'say min(5, by: "w")', "TSV022"],
    [`${D}say max(dynamic("a"), by: "w")`, 'say max("a", by: "w")', "TSV022"],
  ] as const) {
    const compiled = diagnostics(known);
    assert.deepEqual(
      compiled.map(([found]) => found),
      [code],
      known,
    );
    assert.deepEqual(
      runtimeFailure(compileValidPlan(`${unknown}\nexit`)),
      ["TSR028", compiled[0]![1]],
      unknown,
    );
  }
});

test("a speaker property that a read may miss has one text, from the type checker or the speaker flow", () => {
  const fix =
    "Give it a start value, as in 'speaker anna { mood: ... }', or assign it before this line.";
  // No declaration or assignment gives it: the type checker.
  assert.deepEqual(diagnostics("speaker anna { }\nsay anna.mood"), [
    ["TSV043", `Speaker 'anna' has no custom properties, so it has no 'mood'. ${fix}`],
  ]);
  // Only a later assignment gives it: the speaker flow.
  assert.deepEqual(diagnostics("speaker anna { }\nsay anna.mood\nanna.mood = 1"), [
    [
      "TSV043",
      `Speaker 'anna' has no 'mood' yet here: nothing assigns it before this line runs. Line 3 assigns it, but only later. ${fix}`,
    ],
  ]);
  const copy =
    "Copy the player profile before this line, as in 'player.copyFrom(playerProfile)' at the start of the script, or assign 'player.firstName' first.";
  assert.deepEqual(diagnostics("say player.firstName"), [
    [
      "TSV043",
      `Speaker 'player' has no 'firstName': no assignment or copy of the player profile gives it one. ${copy}`,
    ],
  ]);
  assert.deepEqual(diagnostics('say player.firstName\nplayer.firstName = "Sam"'), [
    [
      "TSV043",
      `Speaker 'player' has no 'firstName' yet here: nothing copies the player profile or assigns 'firstName' before this line runs. Line 2 assigns it, but only later. ${copy}`,
    ],
  ]);
});

test("a start value problem has one text in both passes", () => {
  const H = "function h {\n    return 1\n}\n";
  const global = "The start value of global 'g' cannot";
  const speaker = "The properties of speaker 'anna' cannot";
  const set = "it is set at the start of the session, before the story runs.";
  const setUp = "a speaker is set up at the start of the session, before the story runs.";
  const plain = "Use literals, globals declared before it, operators, and 'load ..., default:'.";
  const pick = "Pick the element in the story instead.";
  for (const [source, message] of [
    // A call, by the name pass; a random selection, which needs the value's type, by the type checker.
    [`${H}global g = h()`, `${global} call a function: ${set} ${plain}`],
    [
      "global g = [1, 2].random",
      `${global} select a random element with '.random': ${set} ${pick}`,
    ],
    [`${H}speaker anna { mood: h() }`, `${speaker} call a function: ${setUp} ${plain}`],
    [
      "speaker anna { mood: [1, 2].random }",
      `${speaker} select a random element with '.random': ${setUp} ${pick}`,
    ],
  ])
    assert.deepEqual(diagnostics(source!), [["TSV055", message]], source);
});
