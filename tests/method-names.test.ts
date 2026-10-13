import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { Story } from "./helpers/story-session.js";

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** Hides a value's type from the compiler, as an untyped parameter does. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";
const VERA = 'speaker vera {\n    title: "Mistress"\n}\n';

test("a method that no value has is a compile error on a value of unknown type", () => {
  const cases: [string, string, string, string][] = [
    [
      "function use(p) {\n    p.foo()\n}\nexit",
      "TSV043",
      "No value has a method 'foo'. Check the name.",
      "foo",
    ],
    [
      "function use(p) {\n    say p.lenght()\n}\nexit",
      "TSV043",
      "No value has a method 'lenght'. Did you mean 'length'?",
      "lenght",
    ],
    [
      "function use(p) {\n    say p.trimm()\n}\nexit",
      "TSV043",
      "No value has a method 'trimm'. Did you mean 'trim'?",
      "trimm",
    ],
    [
      "function use(p) {\n    say p.length()\n}\nexit",
      "TSV043",
      "'length' is a property, not a method. Write .length without parentheses.",
      "length",
    ],
    [
      'let key = "toys." + "ball"\nlet toy = load key, default: "ball"\nsay toy.foo()\nexit',
      "TSV043",
      "No value has a method 'foo'. Check the name.",
      "foo",
    ],
    [
      `${DYNAMIC}say "\${dynamic(["a"])[0].foo()}"\nexit`,
      "TSV043",
      "No value has a method 'foo'. Check the name.",
      "foo",
    ],
    [
      "let items = []\nif items.length > 0 {\n    say items[0].foo()\n}\nexit",
      "TSV043",
      "No value has a method 'foo'. Check the name.",
      "foo",
    ],
  ];
  for (const [source, code, message, text] of cases)
    assert.deepEqual(diagnostics(source), [[code, message, text]], source);
});

test("a method call on a speaker is a compile error", () => {
  const cases: [string, string, string][] = [
    ["say vera.trim()", "trim", "vera.title"],
    ["let other = vera\nother.foo()", "foo", "other.title"],
    ['say as vera "${speaker.foo()}"', "foo", "speaker.title"],
    ["let cast = [vera]\ncast[0].foo()", "foo", "title"],
  ];
  for (const [statements, name, property] of cases) {
    const source = `${VERA}${statements}\nexit`;
    assert.deepEqual(
      diagnostics(source),
      [
        [
          "TSV043",
          `A speaker has no methods, so it has no '${name}'. Use one of its properties instead, such as '${property}'.`,
          name,
        ],
      ],
      statements,
    );
  }
  // In a union, the property example would need a check first, so the error only names the method the speaker lacks.
  const union = `${VERA}function use(x: speaker | string) {\n    x.foo()\n}\nexit`;
  assert.deepEqual(diagnostics(union), [["TSV043", "A speaker has no method 'foo'.", "foo"]]);
});

const CAST = 'speaker vera {\n    title: "Mistress"\n    toys: ["rope", "cane"]\n}';

test("a method on a property of the contextual speaker runs as on the speaker's name", () => {
  const result = runValidSource(
    [
      CAST,
      'say as vera "${speaker.title.uppercase()}"',
      'say as vera speaker.title.contains("ist")',
      'say as vera "${speaker.toys.join(", ")}: ${speaker.toys[1].uppercase()}"',
      "speaker vera",
      'say "${(speaker.title).lowercase()} ${vera.title.uppercase()}"',
      // A plain property read, arithmetic on one, and an interaction with 'as', which prepares its speaker apart.
      'say "${speaker.title} ${speaker.title.length + 1}"',
      'showButton as vera "${speaker.title.uppercase()}"',
      "exit",
    ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), [
    "MISTRESS",
    "true",
    "rope, cane: CANE",
    "mistress MISTRESS",
    "Mistress 9",
  ]);
  const button = result.snapshot.foregroundAction;
  assert.ok(button?.kind === "interaction" && button.ui.kind === "button");
  assert.equal(button.ui.buttonLabel, "MISTRESS");
});

test("the contextual speaker is a method receiver in timer and button blocks and in a pacing", () => {
  const story = new Story(
    [
      CAST,
      "speaker vera",
      'showPermanentButton "Kneel" {',
      '    say "${speaker.title.lowercase()}", instant',
      "}",
      "timer async 1 s {",
      '    say as vera "${speaker.toys.join(" and ")}", instant',
      "}",
      'say as vera "Wait.", speaker.toys.count("cane") * 3 s',
      'say "Done.", instant',
      "exit",
    ].join("\n"),
  );
  story.at(1_000);
  assert.equal(story.press(1), "pressed");
  story.at(2_999);
  assert.deepEqual(story.said(), ["Wait.", "rope and cane", "mistress"]);
  story.at(3_000);
  assert.deepEqual(story.said(), ["Wait.", "rope and cane", "mistress", "Done."]);
  assert.equal(story.snapshot.failure, null);
});

test("a method that some value has compiles on a value of unknown type", () => {
  // Every method of text (V30 §8), lists, sets, and dicts (V30 §16), timer and media handles (V30 §22), messages and
  // permanent buttons, and date and time values (V30 §35).
  const names = [
    [
      "contains",
      "startsWith",
      "endsWith",
      "indexOf",
      "lastIndexOf",
      "substring",
      "split",
      "replace",
    ],
    [
      "trim",
      "trimStart",
      "trimEnd",
      "uppercase",
      "lowercase",
      "uppercaseFirst",
      "reverse",
      "repeat",
    ],
    [
      "padStart",
      "padEnd",
      "add",
      "addAll",
      "remove",
      "removeAt",
      "removeFirst",
      "removeLast",
      "clear",
    ],
    [
      "sort",
      "shuffle",
      "take",
      "takeLast",
      "count",
      "get",
      "join",
      "intersection",
      "union",
      "difference",
    ],
    [
      "toSet",
      "toList",
      "pause",
      "resume",
      "stop",
      "toISO",
      "formatDate",
      "formatTime",
      "formatDateTime",
    ],
    ["toAbsoluteDateTime", "toDateTime", "toSeconds", "toMilliseconds"],
  ].flat();
  for (const name of names) {
    const found = diagnostics(`function use(p) {\n    say p.${name}()\n}\nexit`);
    assert.ok(!found.some(([, message]) => message.includes("has a method")), `${name}: ${found}`);
  }
  const result = runValidSource(
    [
      DYNAMIC,
      VERA,
      'say dynamic(" a ").trim()',
      'say dynamic(["b", "a"]).join("-")',
      'say dynamic(["a", "b", "a"]).count("a")',
      'say dynamic(toDate("2026-01-02")).formatDate().length > 0',
      "function trimmed(x: speaker | string) {",
      "    return x.trim()",
      "}",
      'say trimmed(" c ")',
      "function stopped(x: speaker | timer) {",
      "    x.stop()",
      "}",
      'stopped(timer async 10 s { say "late" })',
      "vera.toys = dynamic(dict{ a: 1 })",
      'say vera.toys.contains("a")',
      "exit",
    ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["a", "b-a", "2", "true", "c", "true"]);
});
