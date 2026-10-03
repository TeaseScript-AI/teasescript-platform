import assert from "node:assert/strict";
import test from "node:test";

import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function said(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

test("text operations return new values and leave the original unchanged", () => {
  assert.deepEqual(
    said(
      [
        'let name = "  ada lovelace  "',
        "let clean = name.trim()",
        'say "[${clean}] [${name}]"',
        'say "${clean.capitalize()}|${clean.uppercase()}|${"MiXeD".lowercase()}"',
        'say "[${name.trimStart()}] [${name.trimEnd()}]"',
        'say "${clean.contains("love")} ${clean.contains("Love")} ${clean.startsWith("ada")} ${clean.endsWith("ace")}"',
        'say "${clean.indexOf("l")} ${clean.indexOf("z")} ${clean.substring(4)} ${clean.substring(0, 3)}"',
        'say clean.replace("a", "A")',
        'say "${"".capitalize().length} ${"".trim().length}"',
      ].join("\n"),
    ),
    [
      "[ada lovelace] [  ada lovelace  ]",
      "Ada lovelace|ADA LOVELACE|mixed",
      "[ada lovelace  ] [  ada lovelace]",
      "true false true true",
      "4 -1 lovelace ada",
      "AdA lovelAce",
      "0 0",
    ],
  );
});

test("lengths and positions count code points", () => {
  assert.deepEqual(
    said(
      [
        'let text = "a😀b"',
        'say "${text.length} ${text.indexOf("b")} ${text.substring(1, 2)} ${text.substring(2)}"',
        'say text.split("").join("|")',
      ].join("\n"),
    ),
    ["3 2 😀 b", "a|😀|b"],
  );
});

test("case conversion is locale independent", () => {
  assert.deepEqual(
    said('say "Straße".uppercase()\nsay "TITLE".lowercase()\nsay "ß".capitalize()'),
    ["STRASSE", "title", "SS"],
  );
});

test("split keeps empty parts, replace is literal, and list join converts scalars", () => {
  assert.deepEqual(
    said(
      [
        'let parts = "a,b,,c,".split(",")',
        'say "${parts.length} ${parts.join("+")}"',
        'say "a.b.a".replace("a", "$&")',
        'say ["red", 2, -0, true, null, 90 seconds].join()',
        'say [].join("-")',
      ].join("\n"),
    ),
    ["5 a+b++c+", "$&.b.$&", "red, 2, 0, true, null, 1 min 30 s", ""],
  );
});

test("misused text operations raise source-located runtime errors", () => {
  const cases = [
    [
      'say "abc".substring(4)',
      "TSR025",
      "Text position 4 is outside the text, which has length 3.",
    ],
    [
      'say "abc".substring(-1)',
      "TSR025",
      "Text position -1 is outside the text, which has length 3.",
    ],
    ['say "abc".substring(2, 1)', "TSR025", "Text position 1 is before the start position 2."],
    ['say "abc".substring(0.5)', "TSR024", "A text position must be an integer."],
    ['say "abc".replace("", "x")', "TSR057", "replace() needs non-empty text to search for."],
    ['say "abc".contains(1)', "TSR057", "contains() expects text as argument 1."],
    ['say ["a"].join(1)', "TSR057", "join() expects text as its separator."],
    [
      'say [["a"]].join()',
      "TSR021",
      "join() needs a list without lists, sets, or objects. Select an element or a property first.",
    ],
    ['say "abc".trim(1)', "TSR028", "Expected 0 positional argument(s), received 1."],
    ['say "abc".substring()', "TSR028", "Expected 1 to 2 positional arguments, received 0."],
    ['say "abc".nope()', "TSR016", "Text has no method 'nope'."],
    ['say "abc".size', "TSR017", "Text has no property 'size'."],
    ["let n = 5\nsay n.trim()", "TSR016", "Unsupported method 'trim'."],
  ] as const;
  for (const [source, code, message] of cases) {
    const result = runValidSource(source);
    assert.deepEqual(
      [result.snapshot.failure?.code, result.snapshot.failure?.message],
      [code, message],
      source,
    );
    const call = source.slice(source.lastIndexOf("\n") + 1).replace(/^say /u, "");
    const start = source.lastIndexOf(call);
    assert.deepEqual(
      [result.snapshot.failure?.span.start.offset, result.snapshot.failure?.span.end.offset],
      [start, start + call.length],
      source,
    );
  }
});

test("receivers are checked before user-call arguments run", () => {
  const source = [
    "let calls = 0",
    "function part {",
    "    calls += 1",
    '    return "b"',
    "}",
    'say "${"abc".contains(part())} ${calls}"',
    "let n = 5",
    "say n.contains(part())",
  ].join("\n");
  const result = runValidSource(source);
  assert.deepEqual(sayTexts(result), ["true 1"]);
  assert.equal(result.snapshot.failure?.code, "TSR016");
  assert.equal(
    result.snapshot.frames[0]?.bindings.find((binding) => binding.name === "calls")?.value,
    1,
  );
});

test("text operations are checkpoint and resume equivalent", () => {
  assertRuntimeResumeEquivalent(
    [
      'let words = "one two three".split(" ")',
      "let shouted = []",
      "for word in words {",
      "    shouted.add(word.capitalize())",
      "}",
      'say shouted.join(" ")',
      'say "${words.join("").length}"',
    ].join("\n"),
  );
});
