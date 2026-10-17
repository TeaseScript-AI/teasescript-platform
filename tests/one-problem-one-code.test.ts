import assert from "node:assert/strict";
import test from "node:test";

import { compileSource, type CompileOptions } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { RuntimeFault } from "../src/runtime/errors.js";
import { temporalMethod, temporalNow } from "../src/runtime/temporal-operations.js";
import { createSourcePosition, createSourceSpan } from "../src/source.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";

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
  for (const [source, run, code] of [
    ["say getDate(1)", () => temporalNow("getDate", [1], {}, capture, 0, span), "TSR028"],
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
    assert.equal(compiled[0]![0], "TSV020", source);
    assert.deepEqual(fault(run), [code, compiled[0]![1]], source);
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
    "Copy the account before this line, as in 'player.copyFrom(account)' at the start of the script, or assign 'player.firstName' first.";
  assert.deepEqual(diagnostics("say player.firstName"), [
    [
      "TSV043",
      `Speaker 'player' has no 'firstName': no assignment or copy of the account gives it one. ${copy}`,
    ],
  ]);
  assert.deepEqual(diagnostics('say player.firstName\nplayer.firstName = "Sam"'), [
    [
      "TSV043",
      `Speaker 'player' has no 'firstName' yet here: nothing copies the account or assigns 'firstName' before this line runs. Line 2 assigns it, but only later. ${copy}`,
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
