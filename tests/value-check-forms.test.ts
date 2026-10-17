import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";

// The type checker checks the values of ranges, handle members, and media positions, so one problem gets one code and
// one text in every form of the source, and the runtime gives the same rule's text where the compiler cannot know the
// value (IMPLEMENTATION-AND-REVIEW.md, "One home for each language rule").

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

test("a range, handle member, or media position problem has one code and one text in every form of the source", () => {
  // [forms, each with the one problem at `subject`; the code and the text; the runtime failure of a form the compiler
  // cannot know]
  const families: readonly (readonly [
    forms: readonly (readonly [source: string, subject: string])[],
    code: string,
    message: string,
    runtime: readonly [source: string, code: string, message: string] | null,
  ])[] = [
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
        ['let low = "a"\nsay randomInteger(low..=3)', "low"],
      ],
      "TSV010",
      "A range bound is a number, but this is text (string).",
      null,
    ],
    [
      [
        ["say randomInteger(3..=1)", "3..=1"],
        ["say randomInteger((3..=1))", "3..=1"],
        ["say randomInteger(3..=(2 - 1))", "3..=(2 - 1)"],
      ],
      "TSV010",
      "randomInteger(range) needs a range that holds at least one whole number, but 3..=1 holds none. Check that the range is not empty first.",
      [
        "let high = 3\nsay randomInteger(high..=1)",
        "TSR041",
        "randomInteger(range) needs a range that holds at least one whole number, but 3..=1 holds none. Check that the range is not empty first.",
      ],
    ],
    [
      [
        ["wait (3..=1) s", "3..=1"],
        ["wait ((3..=1)) s", "3..=1"],
      ],
      "TSV010",
      "A wait needs a range that holds at least one whole number, but 3..=1 holds none. Check that the range is not empty first.",
      [
        "let high = 3\nwait (high..=1) s",
        "TSR041",
        "A wait needs a range that holds at least one whole number, but 3..=1 holds none. Check that the range is not empty first.",
      ],
    ],
    [
      [
        ["wait (-1..=3) s", "-1..=3"],
        ["wait ((0 - 1)..=3) s", "(0 - 1)..=3"],
      ],
      "TSV010",
      "A wait range must not start below 0, but this range is -1..=3.",
      [
        "let low = -1\nwait (low..=3) s",
        "TSR050",
        "A wait range must not start below 0, but this range is -1..=3.",
      ],
    ],
    [
      [["let t = timer(duration: (0..=3) s, async: true, repeat: true)", "0..=3"]],
      "TSV010",
      "A repeating timer needs every round to last longer than zero, but this range can draw 0 seconds. Start the range at 1 or more.",
      [
        "let low = 0\nlet t = timer(duration: (low..=3) s, async: true, repeat: true)",
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
      "Timer pause() takes no arguments.",
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
        "TSR003",
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
        "TSR050",
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
  ];
  for (const [forms, code, message, runtime] of families) {
    for (const [source, subject] of forms)
      assert.deepEqual(diagnostics(source), [[code, message, subject]], source);
    if (runtime === null) continue;
    const [source, runtimeCode, runtimeMessage] = runtime;
    assert.deepEqual(failure(source), [runtimeCode, runtimeMessage], source);
  }
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
