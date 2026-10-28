import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";

// The type checker checks every value rule, so one problem gets one code and one text in every form of the source, the
// runtime gives the same rule's text where the compiler cannot know the value, and no value problem waits for another
// error to be fixed (IMPLEMENTATION-AND-REVIEW.md, "One home for each language rule").

const PICK = "function pick(value) {\n    return value\n}\n";
const CLOCK = "let clock = timer async 1 s\n";

/** The code, message, and source text of each diagnostic of `source`. */
function diagnostics(source: string): (readonly [string, string, string])[] {
  return compileSource(`${source}\nexit`).diagnostics.map(({ code, message, span }) => [
    code,
    message,
    source.slice(span.start.offset, span.end.offset),
  ]);
}

/** The code and message of the runtime failure of `source`, which compiles. */
function failure(source: string): readonly [string, string] | null {
  const fault = runValidSource(`${source}\nexit`).snapshot.failure;
  return fault === null ? null : [fault.code, fault.message];
}

/**
 * A rule's forms, each with the one problem at `subject`; its code and text; and the runtime failure of a form the
 * compiler cannot know, where the runtime checks the rule.
 */
type Family = readonly [
  forms: readonly (readonly [source: string, subject: string])[],
  code: string,
  message: string,
  runtime: readonly [source: string, code: string, message: string] | null,
];

function checkFamilies(families: readonly Family[]): void {
  for (const [forms, code, message, runtime] of families) {
    for (const [source, subject] of forms)
      assert.deepEqual(diagnostics(source), [[code, message, subject]], source);
    if (runtime === null) continue;
    const [source, runtimeCode, runtimeMessage] = runtime;
    assert.deepEqual(failure(source), [runtimeCode, runtimeMessage], source);
  }
}

test("a range, handle member, or media position problem has one code and one text in every form of the source", () => {
  checkFamilies([
    [
      [
        ["say randomInteger(1.5..=3)", "1.5"],
        ["say randomInteger((1.5..=3))", "1.5"],
        ["let low = 1.5\nsay randomInteger(low..=3)", "low"],
        [
          "function draw(low: number) {\n    return randomInteger(low..=3)\n}\nsay draw(1.5)",
          "low",
        ],
      ],
      "TSV010",
      "randomInteger(range) needs a range of whole numbers, but its start is a number. Round its bounds with floor(...), round(...), or ceil(...) first.",
      // The runtime names the range it got.
      [
        "function draw(low) {\n    return randomInteger(low..=3)\n}\nsay draw(1.5)",
        "TSR045",
        "randomInteger(range) needs a range of whole numbers, but this range is 1.5..=3. Round its bounds with floor(...), round(...), or ceil(...) first.",
      ],
    ],
    [
      [
        ["for i in 1.5..=3 {\n}", "1.5"],
        ["for i in (1.5..=3) {\n}", "1.5"],
      ],
      "TSV010",
      "A 'for' loop needs a range of whole numbers, but its start is a number. Round its bounds with floor(...), round(...), or ceil(...) first.",
      [
        `${PICK}for i in pick(1.5)..=3 {\n}`,
        "TSR045",
        "A 'for' loop needs a range of whole numbers, but this range is 1.5..=3. Round its bounds with floor(...), round(...), or ceil(...) first.",
      ],
    ],
    [
      [
        ['for i in "a"..3 {\n}', '"a"'],
        ['for i in ("a")..3 {\n}', '("a")'],
      ],
      "TSV010",
      "A range needs a number as its start, but this is text (string). Use a number instead.",
      [
        `${PICK}for i in pick("a")..3 {\n}`,
        "TSR027",
        `A range needs a number as its start, but this is text (string) "a". Use a number instead.`,
      ],
    ],
    [
      [['for i in "3"..5 {\n}', '"3"']],
      "TSV010",
      "A range needs a number as its start, but this is text (string). Convert the text with toNumber(...) first.",
      [
        `${PICK}for i in pick("3")..5 {\n}`,
        "TSR027",
        `A range needs a number as its start, but this is text (string) "3". Convert the text with toNumber(...) first.`,
      ],
    ],
    [
      // A name that says "duration" is still a range bound, which takes a number.
      [["let durationValue = 1 calendar day\nfor i in durationValue..3 {\n}", "durationValue"]],
      "TSV010",
      "'durationValue..3' needs a number for 'durationValue', but this is a calendar duration. Use a number instead.",
      [
        `${PICK}let durationValue = pick(1 calendar day)\nfor i in durationValue..3 {\n}`,
        "TSR027",
        "'durationValue..3' needs a number for 'durationValue', but this is 1 calendar day. Use a number instead.",
      ],
    ],
    [
      [["let durationValue = 1 calendar day\nfor i in 1..durationValue {\n}", "durationValue"]],
      "TSV010",
      "'1..durationValue' needs a number for 'durationValue', but this is a calendar duration. Use a number instead.",
      [
        `${PICK}let durationValue = pick(1 calendar day)\nfor i in 1..durationValue {\n}`,
        "TSR027",
        "'1..durationValue' needs a number for 'durationValue', but this is 1 calendar day. Use a number instead.",
      ],
    ],
    [
      [
        ['let low = "a"\nsay randomInteger(low..=3)', "low"],
        ['let low = "a"\nsay randomInteger((low)..=3)', "(low)"],
      ],
      "TSV010",
      "'low..=3' needs a number for 'low', but this is text (string). Use a number instead.",
      [
        `${PICK}let low = pick("a")\nsay randomInteger(low..=3)`,
        "TSR027",
        `'low..=3' needs a number for 'low', but this is text (string) "a". Use a number instead.`,
      ],
    ],
    [
      [
        ["say randomInteger(3..=1)", "3..=1"],
        ["say randomInteger((3..=1))", "3..=1"],
        ["say randomInteger(3..=(2 - 1))", "3..=(2 - 1)"],
        ["let high = 3\nsay randomInteger(high..=1)", "high..=1"],
      ],
      "TSV010",
      "randomInteger(range) needs a range that holds at least one whole number, but 3..=1 holds none. Check that the range is not empty first.",
      [
        `${PICK}let high = pick(3)\nsay randomInteger(high..=1)`,
        "TSR041",
        "randomInteger(range) needs a range that holds at least one whole number, but 3..=1 holds none. Check that the range is not empty first.",
      ],
    ],
    [
      [
        ["wait (3..=1) s", "3..=1"],
        ["wait ((3..=1)) s", "3..=1"],
        ["let high = 3\nwait (high..=1) s", "high..=1"],
      ],
      "TSV010",
      "A wait needs a range that holds at least one whole number, but 3..=1 holds none. Check that the range is not empty first.",
      [
        `${PICK}let high = pick(3)\nwait (high..=1) s`,
        "TSR041",
        "A wait needs a range that holds at least one whole number, but 3..=1 holds none. Check that the range is not empty first.",
      ],
    ],
    [
      [
        ["wait (-1..=3) s", "-1..=3"],
        ["wait ((0 - 1)..=3) s", "(0 - 1)..=3"],
        ["let low = -1\nwait (low..=3) s", "low..=3"],
      ],
      "TSV010",
      "A wait range must not start below 0, but this range is -1..=3.",
      [
        `${PICK}let low = pick(-1)\nwait (low..=3) s`,
        "TSR050",
        "A wait range must not start below 0, but this range is -1..=3.",
      ],
    ],
    [
      [
        ["let t = timer(duration: (0..=3) s, async: true, repeat: true)", "0..=3"],
        ["let low = 0\nlet t = timer(duration: (low..=3) s, async: true, repeat: true)", "low..=3"],
      ],
      "TSV010",
      "A repeating timer needs every round to last longer than zero, but this range can draw 0 seconds. Start the range at 1 or more.",
      [
        `${PICK}let low = pick(0)\nlet t = timer(duration: (low..=3) s, async: true, repeat: true)`,
        "TSR050",
        "A repeating timer needs every round to last longer than zero, but this range can draw 0 seconds. Start the range at 1 or more.",
      ],
    ],
    [
      [
        [`${CLOCK}say clock.missing`, "missing"],
        [`${CLOCK}say (clock).missing`, "missing"],
        [`${CLOCK}let alias = clock\nsay alias.missing`, "missing"],
        [`${CLOCK}let clocks = [clock]\nsay clocks[0].missing`, "missing"],
        ["function show(t: timer) {\n    say t.missing\n}", "missing"],
      ],
      "TSV034",
      "Timer handles have no property 'missing'.",
      [
        `${PICK}${CLOCK}say pick(clock).missing`,
        "TSR017",
        "Timer handles have no property 'missing'.",
      ],
    ],
    [
      [
        [`${CLOCK}clock.clear()`, "clear"],
        [`${CLOCK}let alias = clock\nalias.clear()`, "clear"],
      ],
      "TSV034",
      "Timer handles have no method 'clear'. Use pause(), resume(), or stop().",
      [
        `${PICK}${CLOCK}pick(clock).clear()`,
        "TSR016",
        "Timer handles have no method 'clear'. Use pause(), resume(), or stop().",
      ],
    ],
    [
      [
        [`${CLOCK}clock.pause(1)`, "pause"],
        [`${CLOCK}let alias = clock\nalias.pause(1)`, "pause"],
      ],
      "TSV034",
      "pause() takes no arguments, received 1.",
      // On any receiver, 'pause(1)' is TSV020.
      null,
    ],
    [
      [
        [`${CLOCK}clock.elapsed = 1 s`, "elapsed"],
        [`${CLOCK}let alias = clock\nalias.elapsed = 1 s`, "elapsed"],
      ],
      "TSV034",
      "Timer handle property 'elapsed' cannot be assigned. You can assign remaining, display, or repeatDuration.",
      [
        `${PICK}${CLOCK}pick(clock).elapsed = 1 s`,
        "TSV034",
        "Timer handle property 'elapsed' cannot be assigned. You can assign remaining, display, or repeatDuration.",
      ],
    ],
    [
      [
        [`${CLOCK}clock.display = "big"`, '"big"'],
        [`${CLOCK}let alias = clock\nalias.display = "big"`, '"big"'],
      ],
      "TSV034",
      'Timer display must be "visible", "mystery", or "hidden", but this is "big".',
      [
        `${PICK}${CLOCK}clock.display = pick("big")`,
        "TSV034",
        'Timer display must be "visible", "mystery", or "hidden", but this is "big".',
      ],
    ],
    [
      [
        ['let m = playAudio async "a.mp3"\nsay m.missing', "missing"],
        ['let m = playAudio async "a.mp3"\nlet alias = m\nsay alias.missing', "missing"],
        ["function show(m: media) {\n    say m.missing\n}", "missing"],
      ],
      "TSV037",
      "Media handles have no property 'missing'.",
      null,
    ],
    [
      [
        ['let m = playAudio async "a.mp3"\nm.volume = 2', "2"],
        ['let m = playAudio async "a.mp3"\nlet alias = m\nalias.volume = 1 + 1', "1 + 1"],
      ],
      "TSV037",
      "Media volume must be a number from 0 through 1, but this is 2.",
      null,
    ],
    [
      [
        ["let view = showCamera stage\nsay view.missing", "missing"],
        ["let view = showCamera stage\nlet alias = view\nsay alias.missing", "missing"],
      ],
      "TSV059",
      "Camera views have no property 'missing'. Use the placement property.",
      null,
    ],
    [
      [
        ['playAudio(file: "a.mp3", startAt: -1 s)', "-1 s"],
        ['playAudio(file: "a.mp3", startAt: (-1 s))', "(-1 s)"],
      ],
      "TSV036",
      "Media startAt must be a duration of at least 0 seconds, but this is -1 second.",
      null,
    ],
  ]);
});

test("a length, count, file, repeat, index, loop source, key, colour, or presentation problem has one code and one text in every form", () => {
  const playing = 'playAudio(file: "a.mp3", ';
  const timeout = "Remove 'timeout:' to wait for the click without a time limit.";
  const form = 'let a = askForm "Q", fields: { rope: false }, ';
  const formTimeout = "Remove 'timeout:' and 'onTimeout:' to wait without a time limit.";
  checkFamilies([
    [
      [
        ["wait -1 s", "-1 s"],
        ["wait (-1 s)", "(-1 s)"],
        ["wait ((1 - 2) s)", "((1 - 2) s)"],
        ["let d = -1 s\nwait d", "d"],
      ],
      "TSV011",
      "Wait duration must not be negative, but this is -1 second.",
      [
        `${PICK}let d = pick(-1 s)\nwait d`,
        "TSR050",
        "Wait duration must not be negative, but this is -1 second.",
      ],
    ],
    [
      [
        ["wait (1 - 2) s", "(1 - 2)"],
        ["wait (-1) s", "(-1)"],
        ["let n = -1\nwait n s", "n"],
      ],
      "TSV011",
      "Wait duration must not be negative, but this is -1.",
      [
        `${PICK}let n = pick(-1)\nwait n s`,
        "TSR050",
        "Wait duration must not be negative, but this is -1.",
      ],
    ],
    [
      [
        ["let t = timer(duration: 0 s, async: true, repeat: true)", "0 s"],
        ["let t = timer(duration: ((1 - 1) s), async: true, repeat: true)", "((1 - 1) s)"],
        ["let d = 0 s\nlet t = timer(duration: d, async: true, repeat: true)", "d"],
      ],
      "TSV011",
      "A repeating timer needs every round to last longer than zero, but this round can be 0 seconds. Use a duration of at least 1 second.",
      [
        `${PICK}let d = pick(0 s)\nlet t = timer(duration: d, async: true, repeat: true)`,
        "TSR050",
        "A repeating timer needs every round to last longer than zero, but this round can be 0 seconds. Use a duration of at least 1 second.",
      ],
    ],
    [
      [
        ["repeat -1 {\n}", "-1"],
        ["repeat (0 - 1) {\n}", "(0 - 1)"],
      ],
      "TSV011",
      "A repeat count must be a whole number (integer) of at least 0, but this is -1. Check that it is at least 0 first.",
      [
        `${PICK}repeat pick(-1) {\n}`,
        "TSR043",
        "A repeat count must be a whole number (integer) of at least 0, but this is -1. Check that it is at least 0 first.",
      ],
    ],
    [
      [
        ["repeat 1.5 {\n}", "1.5"],
        ["let n = 1.5\nrepeat n {\n}", "n"],
        ["function f(n: number) {\n    repeat n {\n    }\n}", "n"],
      ],
      "TSV011",
      "A repeat count must be a whole number (integer) of at least 0, but this is a number. Round it with floor(...), round(...), or ceil(...) first.",
      null,
    ],
    [
      [
        ['say "a", -1 s', "-1 s"],
        ['say "a", (0 - 1) s', "(0 - 1) s"],
        ['let d = -1 s\nsay "a", d', "d"],
      ],
      "TSV011",
      "Say pacing must be a duration of at least 0 seconds, but this is -1 second.",
      [
        `${PICK}let d = pick(-1 s)\nsay "a", d`,
        "TSR050",
        "Say pacing must be a duration of at least 0 seconds, but this is -1 second.",
      ],
    ],
    [
      [
        ['showButton "Go", timeout: 0 s', "0 s"],
        ['showButton "Go", timeout: (1 - 1) s', "(1 - 1) s"],
        ['let d = 0 s\nshowButton "Go", timeout: d', "d"],
      ],
      "TSV011",
      `A showButton timeout must be a duration greater than zero, but this is 0 seconds. ${timeout}`,
      [
        `${PICK}let d = pick(0 s)\nshowButton "Go", timeout: d`,
        "TSR050",
        `A showButton timeout must be a duration greater than zero, but this is 0 seconds. ${timeout}`,
      ],
    ],
    [
      [
        [`${form}timeout: 0 s, onTimeout: "submit"`, "0 s"],
        [`${form}timeout: (1 - 1) s, onTimeout: "cancel"`, "(1 - 1) s"],
        [
          'let a = askForm("Q", fields: { rope: false }, timeout: 0 ms, onTimeout: "submit")',
          "0 ms",
        ],
        [`let d = 0 s\n${form}timeout: d, onTimeout: "submit"`, "d"],
      ],
      "TSV011",
      `An askForm timeout must be a duration greater than zero, but this is 0 seconds. ${formTimeout}`,
      [
        `${PICK}let d = pick(0 s)\n${form}timeout: d, onTimeout: "submit"`,
        "TSR052",
        `An askForm timeout must be a duration greater than zero, but this is 0 seconds. ${formTimeout}`,
      ],
    ],
    [
      [[`${form}timeout: 1e16 ms, onTimeout: "cancel"`, "1e16 ms"]],
      "TSV011",
      "This askForm timeout is too long for scene time to reach. Use a shorter timeout, or remove 'timeout:' and 'onTimeout:' to wait without a time limit.",
      null,
    ],
    [
      [
        ['let t = timer(duration: 1 s, async: true, display: "loud")', '"loud"'],
        ['let t = timer(duration: 1 s, async: true, display: ("loud"))', '("loud")'],
      ],
      "TSV068",
      'Timer display must be "visible", "mystery", or "hidden", but this is "loud".',
      [
        'let s = "loud"\nlet t = timer(duration: 1 s, async: true, display: s)',
        "TSR050",
        'Timer display must be "visible", "mystery", or "hidden", but this is "loud".',
      ],
    ],
    [
      [
        ["wait (5 s) s", "(5 s)"],
        ["let d = 5 s\nwait d s", "d"],
      ],
      // One rule with the amount before any unit (#951).
      "TSV043",
      "A unit follows a number, but this is a duration. Remove the 's' after it.",
      [
        `${PICK}wait pick(5 s) s`,
        "TSR027",
        "A unit follows a number, but this is 5 seconds. Remove the 's' after it.",
      ],
    ],
    [
      [
        ["playAudio 3", "3"],
        ["let f = 3\nplayAudio f", "f"],
      ],
      "TSV036",
      "playAudio needs a file reference in text (string) or null, but this is a whole number (integer).",
      [
        `${PICK}playAudio pick(3)`,
        "TSR050",
        "playAudio needs a file reference in text (string) or null, but this is 3.",
      ],
    ],
    [
      [
        [`${playing}volume: 2)`, "2"],
        [`${playing}volume: 1 + 1)`, "1 + 1"],
        [`let v = 2\n${playing}volume: v)`, "v"],
      ],
      "TSV036",
      "Media volume must be a number from 0 through 1, but this is 2.",
      [
        `${PICK}let v = pick(2)\n${playing}volume: v)`,
        "TSR050",
        "Media volume must be a number from 0 through 1, but this is 2.",
      ],
    ],
    [
      [
        [`${playing}repeat: 0 s)`, "0 s"],
        [`${playing}repeat: (1 - 1) s)`, "(1 - 1) s"],
        [`let d = 0 s\n${playing}repeat: d)`, "d"],
      ],
      "TSV036",
      "Media repeat must be true, false, a count such as '3 times', or a positive duration, but this is 0 seconds.",
      [
        `${PICK}let d = pick(0 s)\n${playing}repeat: d)`,
        "TSR050",
        "Media repeat must be true, false, a count such as '3 times', or a positive duration, but this is 0 seconds.",
      ],
    ],
    [
      [
        [`${playing}repeat: 0 times)`, "0"],
        [`${playing}repeat: (1 - 1) times)`, "(1 - 1)"],
        [`let n = 0\n${playing}repeat: n times)`, "n"],
      ],
      "TSV036",
      "A repeat count must be a whole number of at least 1, such as '3 times', but this is 0.",
      [
        `${PICK}let n = pick(0)\n${playing}repeat: n times)`,
        "TSR050",
        "A repeat count must be a whole number of at least 1, such as '3 times', but this is 0.",
      ],
    ],
    [
      [
        [`${playing}repeat: true)`, "true"],
        [`${playing}repeat: (true))`, "(true)"],
        ['playAudio repeat "a.mp3"', "repeat"],
      ],
      "TSV036",
      "Blocking media cannot repeat indefinitely. Use 'playAudio async', a count such as 'repeat: 3 times', or a duration such as 'repeat: 60 s'.",
      [
        `let r = true\n${playing}repeat: r)`,
        "TSR050",
        "Blocking media cannot repeat indefinitely. Use 'playAudio async', a count such as 'repeat: 3 times', or a duration such as 'repeat: 60 s'.",
      ],
    ],
    [
      [
        ["let l = [1]\nsay l[-1]", "-1"],
        ["let l = [1]\nsay l[(0 - 1)]", "(0 - 1)"],
        ["let l = [1]\nl[-1] = 2", "-1"],
        ["let l = [1]\nl.removeAt(-1)", "-1"],
      ],
      "TSV045",
      "A list index cannot be negative, but the index is -1. The first element is at index 0, and the last at 'l.length - 1'.",
      // An index the compiler does not know fails with the same code and text.
      [
        `${PICK}let l = [1]\nsay l[pick(-1)]`,
        "TSV045",
        "A list index cannot be negative, but the index is -1. The first element is at index 0, and the last at 'l.length - 1'.",
      ],
    ],
    [
      [
        ["let l = [1]\nlet i = -1\nsay l[i]", "i"],
        ["let l = [1]\nlet i = -1\nl[i] = 2", "i"],
      ],
      "TSV045",
      "A list index cannot be negative, but 'i' is -1. The first element is at index 0, and the last at 'l.length - 1'.",
      [
        `${PICK}let l = [1]\nlet i = pick(-1)\nsay l[i]`,
        "TSV045",
        "A list index cannot be negative, but 'i' is -1. The first element is at index 0, and the last at 'l.length - 1'.",
      ],
    ],
    [
      [
        // Only a list has an index or removeAt, so the receiver need not be known, and on a receiver the compiler
        // cannot know, removeAt checks no other index rule.
        ["function f(x) {\n    say x[-1]\n}", "-1"],
        ["function f(x) {\n    x.removeAt(-1)\n}", "-1"],
      ],
      "TSV045",
      "A list index cannot be negative, but the index is -1. The first element is at index 0, and the last at 'x.length - 1'.",
      null,
    ],
    [
      [
        ["function f(x) {\n    x.removeAt(-1.5)\n}", "-1.5"],
        ["function f(x) {\n    x.removeAt((-3 / 2))\n}", "(-3 / 2)"],
      ],
      "TSV045",
      "A list index cannot be negative, but the index is -1.5. The first element is at index 0, and the last at 'x.length - 1'.",
      null,
    ],
    [
      [
        ["say 1 / 0", "1 / 0"],
        ["say 1 s / 0 s", "1 s / 0 s"],
        ["function f(x) {\n    return x / 0\n}", "x / 0"],
      ],
      "TSV050",
      "This divides by zero, so it has no result. Divide by a value other than zero.",
      null,
    ],
    [
      [
        ["for i in 5 {\n}", "5"],
        ["let n = 5\nfor i in n {\n}", "n"],
      ],
      "TSV012",
      "A 'for' loop goes through a list, set, dict, or range, but this is a whole number (integer).",
      [
        `${PICK}for i in pick(5) {\n}`,
        "TSR044",
        "A 'for' loop goes through a list, set, dict, or range, but this is 5.",
      ],
    ],
    [
      [
        ["save 1 as 5", "5"],
        ["let k = 5\nsave 1 as k", "k"],
      ],
      "TSV038",
      "Storage key must be a string.",
      null,
    ],
    [
      // A sign never gives text, also of a value the compiler cannot know.
      [
        ["function f(k) {\n    save 1 as -k\n}", "-k"],
        ["function f(k) {\n    delete ((+k))\n}", "((+k))"],
        [`${PICK}save 1 as -pick(3)`, "-pick(3)"],
      ],
      "TSV038",
      "Storage key must be a string.",
      null,
    ],
    [
      [["function f(k) {\n    return load(-k, default: 0)\n}", "-k"]],
      "TSV038",
      "Storage key must be a string. To compare the loaded value, write 'let value: string? = load(\"k\", default: null)', then 'value == null'.",
      null,
    ],
    [
      [
        ['showButton "Go", background: "nope"', '"nope"'],
        ['showButton "Go", background: ("nope")', '("nope")'],
        ['let a = askChoice { text: "A", background: "nope" }', '"nope"'],
      ],
      "TSV029",
      'A button background must be an opaque CSS colour, such as "#336699", but this is text (string) "nope".',
      [
        'let c = "nope"\nshowButton "Go", background: c',
        "TSR052",
        'A button background must be an opaque CSS colour, such as "#336699", but this is text (string) "nope".',
      ],
    ],
    [
      [
        ["let a = askChoice []", "askChoice []"],
        ["let a = askChoice [], set[]", "askChoice [], set[]"],
      ],
      "TSV029",
      "A choice needs at least one button, but its option lists are empty.",
      [
        "let l = []\nlet a = askChoice l",
        "TSR052",
        "A choice needs at least one button, but its option lists are empty.",
      ],
    ],
    [
      [
        ["let a = askChoice { value: 1 }", "{ value: 1 }"],
        ["let a = askChoice [{ value: 1 }]", "{ value: 1 }"],
      ],
      "TSV029",
      "A choice object needs a 'text' property to label its button.",
      [
        "let o = { value: 1 }\nlet a = askChoice o",
        "TSR052",
        "A choice object needs a 'text' property to label its button.",
      ],
    ],
    [
      [
        ['say prose(color: "not-a-color") "x"', '"not-a-color"'],
        ['say prose(color: ("not-a-color")) "x"', '"not-a-color"'],
        ['speaker vera { color: "not-a-color" }', '"not-a-color"'],
      ],
      "TSC008",
      'A message\'s color must be a CSS colour, such as "#336699".',
      null,
    ],
  ]);
  // A duration with a number has its own code in every form, with the fix for the operand, also where a union may
  // hold the number.
  for (const source of [
    "say 1 + 2 s",
    "let n = 1\nsay n + 2 s",
    "say (1) + 2 s",
    "function f(n: number | duration) {\n    say 1 s + n\n}",
    "function f(n: number | duration) {\n    say n + 1 s\n}",
  ])
    assert.deepEqual(
      diagnostics(source).map(([code]) => code),
      ["TSV035"],
      source,
    );
});

test("a value problem does not hide a type error elsewhere in the script", () => {
  const typeError = [
    "TSV041",
    "'b' is declared as integer, so it cannot start as text (string). To allow both, declare it as 'let b: integer | string = ...'.",
    '"x"',
  ] as const;
  for (const [source, code] of [
    ["let a = randomInteger(1.5..=3)", "TSV010"],
    ["say randomInteger(3..=1)", "TSV010"],
    ["wait (3..=1) s", "TSV010"],
    [`${CLOCK}say clock.missing`, "TSV034"],
    ['playAudio(file: "a.mp3", startAt: -1 s)', "TSV036"],
    ["wait (-1 s)", "TSV011"],
    ["repeat -1 {\n}", "TSV011"],
    ['let t = timer(duration: 1 s, async: true, display: "loud")', "TSV068"],
    ['playAudio(file: "a.mp3", volume: 2)', "TSV036"],
    ["let l = [1]\nsay l[-1]", "TSV045"],
    ["say 1 / 0", "TSV050"],
    ["for i in 5 {\n}", "TSV012"],
    ["say 1 + 2 s", "TSV035"],
    ["save 1 as 5", "TSV038"],
    ["let a = askChoice { value: 1 }", "TSV029"],
    ['say prose(color: "not-a-color") "x"', "TSC008"],
  ] as const) {
    const found = diagnostics(`${source}\nlet b: integer = "x"`);
    assert.deepEqual(
      found.map(([foundCode]) => foundCode),
      [code, "TSV041"],
      source,
    );
    assert.deepEqual(found[1], typeError, source);
  }
});

test("a value problem inside a start value, or in a load without default:, is reported beside that error", () => {
  const empty =
    "randomInteger(range) needs a range that holds at least one whole number, but 3..=1 holds none. Check that the range is not empty first.";
  for (const [source, placement, subject] of [
    ["global g = randomInteger(3..=1)", "TSV055", "3..=1"],
    ['speaker vera {\n    title: "${randomInteger(3..=1)}"\n}', "TSV055", "3..=1"],
    ['let x = load "k" == null', "TSV020", null],
  ] as const) {
    const found = diagnostics(source);
    assert.ok(
      found.some(([code]) => code === placement),
      `${source}: ${found.map(([code]) => code).join(" ")}`,
    );
    if (subject !== null)
      assert.ok(
        found.some(
          ([code, message, at]) => code === "TSV010" && message === empty && at === subject,
        ),
        source,
      );
    else
      assert.ok(
        found.some(([code]) => code === "TSV038"),
        source,
      );
  }
});
