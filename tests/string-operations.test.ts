import assert from "node:assert/strict";
import { constants } from "node:buffer";
import test from "node:test";

import { compileProject, compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { MAX_TEXT_LENGTH } from "../src/runtime/text-length.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function said(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

/** Runs `source` with host globals, whose values the compiler cannot know. */
function runWithGlobals(source: string, globals: Record<string, string | number | boolean | null>) {
  const plan = compileValidPlan(source, { globals: Object.keys(globals) });
  return run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
}

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

test("text operations return new values and leave the original unchanged", () => {
  assert.deepEqual(
    said(
      [
        'let name = "  ada lovelace  "',
        "let clean = name.trim()",
        'say "[${clean}] [${name}]"',
        'say "${clean.uppercaseFirst()}|${clean.uppercase()}|${"MiXeD".lowercase()}"',
        'say "[${name.trimStart()}] [${name.trimEnd()}]"',
        'say "${clean.contains("love")} ${clean.contains("Love")} ${clean.startsWith("ada")} ${clean.endsWith("ace")}"',
        'say "${clean.indexOf("l")} ${clean.indexOf("z")} ${clean.substring(4)} ${clean.substring(0, 3)}"',
        'say clean.replace("a", "A")',
        'say "${"".uppercaseFirst().length} ${"".trim().length}"',
        'say "${clean.lastIndexOf("a")} ${clean.lastIndexOf("z")} ${"ab".repeat(3)}|${"ab".repeat(0)}|"',
        'say "${"7".padStart(3, "0")} ${"7".padEnd(3, "-")} ${"long".padStart(2, "0")} ${"ab".padStart(7, "xyz")}"',
        "exit",
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
      "9 -1 ababab||",
      "007 7-- long xyzxyab",
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
        'say "${"😀a😀".lastIndexOf("😀")} ${text.lastIndexOf("")} ${"x".padStart(4, "😀a")} ${"x".padEnd(3, "😀a").length}"',
        'say "😀".repeat(2).length',
        "exit",
      ].join("\n"),
    ),
    ["3 2 😀 b", "a|😀|b", "2 3 😀a😀x 3", "2"],
  );
});

test("case conversion is locale independent", () => {
  assert.deepEqual(
    said('say "Straße".uppercase()\nsay "TITLE".lowercase()\nsay "ß".uppercaseFirst()\nexit'),
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
        'say "${["red", "blue"].join()} | ${[2, -0].join()} | ${[true, false].join()} | ${[90 seconds].join()}"',
        'say [].join("-")',
        "let maybe: string[]? = null",
        "let name: string? = null",
        'say "${[maybe].join()} | ${[name, "a"].join()}"',
        "exit",
      ].join("\n"),
    ),
    ["5 a+b++c+", "$&.b.$&", "red, blue | 2, 0 | true, false | 1 min 30 s", "", "null | null, a"],
  );
});

test("positions stay on code points for combining marks, expanding case, and lone surrogates", () => {
  assert.deepEqual(
    said(
      [
        'let accent = "cafe\u0301!"',
        'say "${accent.length} ${accent.substring(4, 5).length} ${accent.substring(5)} ${"abc".substring(3, 3).length}"',
        'say "${"İ".lowercase().length} ${"ﬀ".uppercase()}"',
        "exit",
      ].join("\n"),
    ),
    ["6 1 ! 0", "2 FF"],
  );

  // A lone high surrogate before a lone low one joins into one code point, so padding needs another round.
  const result = runWithGlobals(
    [
      'say "${emoji.indexOf(low)} ${emoji.lastIndexOf(low)} ${emoji.contains(low)} ${emoji.endsWith(low)} ${emoji.split(low).length} ${emoji.replace(low, "x")} ${low.contains(low)}"',
      'say "${high.padEnd(3, low).length} ${"x".padStart(5, "${low}${high}").length}"',
      "exit",
    ].join("\n"),
    { emoji: "a😀", low: "\udE00", high: "\ud800" },
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(sayTexts(result), ["-1 -1 false false 1 a😀 true", "3 5"]);
});

test("misuse the compiler can see is a compile error that names the fix", () => {
  const cases: [string, string, string, string][] = [
    [
      'let t = "abc"\nsay t.size\nexit',
      "TSV043",
      "Text has no property 'size'. Use length.",
      "size",
    ],
    [
      'let t = "abc"\nsay t.toUpperCase()\nexit',
      "TSV043",
      "Text has no method 'toUpperCase'. Use uppercase().",
      "toUpperCase",
    ],
    ['let t = "abc"\nsay t.nope()\nexit', "TSV043", "Text has no method 'nope'.", "nope"],
    [
      'let t = "abc"\nsay t.length()\nexit',
      "TSV043",
      "length is a property, not a method; write .length without parentheses.",
      "length",
    ],
    [
      'let t = "abc"\nsay t.trim\nexit',
      "TSV043",
      "trim is a method; write trim() with parentheses.",
      "trim",
    ],
    [
      "let count = 5\nsay count.uppercase()\nexit",
      "TSV043",
      "A whole number (integer) has no method 'uppercase'. Convert it to text first with toString(...).",
      "uppercase",
    ],
    [
      "let ok = true\nsay ok.size\nexit",
      "TSV043",
      "True or false (boolean) has no property 'size'.",
      "size",
    ],
    [
      'let t = "abc"\nsay t.contains(1)\nexit',
      "TSV043",
      "contains() needs text (string) for 'part', not a whole number (integer). Convert it with toString(...).",
      "1",
    ],
    [
      'let items = ["a"]\nsay items.join(true)\nexit',
      "TSV043",
      "join() needs text (string) for 'separator', not true or false (boolean). Convert it with toString(...).",
      "true",
    ],
    [
      'let items = ["a"]\nsay items.join\nexit',
      "TSV043",
      "join is a method; write .join() with parentheses.",
      "join",
    ],
    [
      'let t = "abc"\nsay t.repeat(1.5)\nexit',
      "TSV043",
      "repeat() needs a whole number (integer) for 'count', not a number. Convert it with toInteger(...), which drops the fraction.",
      "1.5",
    ],
    [
      'let t = "abc"\nsay t.substring("1")\nexit',
      "TSV043",
      "substring() needs a whole number (integer) for 'start', not text (string). Convert it with toInteger(...).",
      '"1"',
    ],
    [
      'let t = "abc"\nsay t.repeat(-2)\nexit',
      "TSV043",
      "repeat() needs 'count' to be 0 or more, not -2.",
      "-2",
    ],
    [
      'let t = "abc"\nsay t.padEnd(-1, " ")\nexit',
      "TSV043",
      "padEnd() needs 'length' to be 0 or more, not -1.",
      "-1",
    ],
    [
      'let t = "abc"\nsay t.substring(-1)\nexit',
      "TSV043",
      "substring() needs 'start' to be 0 or more, not -1.",
      "-1",
    ],
    [
      'say "abc".substring(1, 4)\nexit',
      "TSV043",
      "substring() needs 'end' from 0 through 3 (the length of the text), not 4.",
      "4",
    ],
    [
      'say "abc".substring(2, 1)\nexit',
      "TSV043",
      "substring() needs 'end' not before 'start'; 1 is before 2.",
      "1",
    ],
    [
      'let t = "abc"\nsay t.replace("", "x")\nexit',
      "TSV043",
      "replace() needs non-empty text for 'search'.",
      '""',
    ],
    [
      'let t = "abc"\nsay t.padStart(5, "")\nexit',
      "TSV043",
      "padStart() needs non-empty text for 'fill'.",
      '""',
    ],
    [
      'let t = "abc"\nsay t.padStart(5)\nexit',
      "TSV020",
      "padStart() takes 2 arguments (length, fill), received 1.",
      "t.padStart(5)",
    ],
    [
      'let t = "abc"\nsay t.trim(1)\nexit',
      "TSV020",
      "trim() takes no arguments, received 1.",
      "t.trim(1)",
    ],
    [
      'let t = "abc"\nsay t.substring()\nexit',
      "TSV020",
      "substring() takes 1 to 2 arguments (start, end), received 0.",
      "t.substring()",
    ],
    [
      'let t = "abc"\nsay t.padStart(length: 5, fill: "0")\nexit',
      "TSV022",
      "padStart() takes its arguments without names. Remove 'length:'.",
      "length",
    ],
    [
      "function shout(value) { return value.repeat(-1) }\nexit",
      "TSV043",
      "repeat() needs 'count' to be 0 or more, not -1.",
      "-1",
    ],
    [
      "function shout(value) { return value.trim(1) }\nexit",
      "TSV020",
      "trim() takes no arguments, received 1.",
      "value.trim(1)",
    ],
    [
      'let t = "abc"\nt.length = 0\nexit',
      "TSV043",
      "Text cannot be changed, so 'length' cannot be assigned. Assign a new text to the variable instead.",
      "t",
    ],
    [
      "say [[1], [2]].join()\nexit",
      "TSV043",
      "join() can only join text, numbers, true or false, null, durations, date and time values, and script references, not a list (integer[]). Select an element or a property first.",
      "[1]",
    ],
    ["say null.trim()\nexit", "TSV043", "Null has no method 'trim'.", "trim"],
    [
      "null.length = 0\nexit",
      "TSV043",
      "Only objects, speakers, and timer, media, and message handles have properties to assign, but this is null.",
      "null",
    ],
    [
      'let count = 2\nsay "x".repeat(count)\ncount = 2.5\nexit',
      "TSV043",
      "repeat() needs a whole number (integer) for 'count', not a number. 'count' is a number because line 3 can store a non-whole number in it. Convert it with toInteger(...), which drops the fraction.",
      "count",
    ],
  ];
  for (const [source, code, message, text] of cases)
    assert.deepEqual(diagnostics(source), [[code, message, text]], source);
  // `contains` also belongs to lists and sets, which may contain any value, so only its shape is checked.
  assert.deepEqual(diagnostics("function has(value) { return value.contains(1) }\nexit"), []);
  assert.deepEqual(diagnostics("function has(value) { return value.contains(1, 2) }\nexit"), [
    ["TSV020", "contains() takes 1 argument (part), received 2.", "value.contains(1, 2)"],
  ]);
});

test("values the compiler cannot know are checked at runtime, with messages that name the fix", () => {
  const cases: [string, Record<string, string | number | boolean | null>, string, string][] = [
    [
      "say text.substring(at)\nexit",
      { text: "abc", at: 4 },
      "TSR025",
      "substring() needs 'start' from 0 through 3 (the length of the text), not 4.",
    ],
    [
      "say text.substring(at)\nexit",
      { text: "abc", at: -1 },
      "TSR025",
      "substring() needs 'start' to be 0 or more, not -1.",
    ],
    [
      "say text.substring(2, at)\nexit",
      { text: "abc", at: 1 },
      "TSR025",
      "substring() needs 'end' not before 'start'; 1 is before 2.",
    ],
    [
      "say text.substring(at)\nexit",
      { text: "abc", at: 0.5 },
      "TSR024",
      "substring() needs a whole number (integer) for 'start', not a number. Convert it with toInteger(...), which drops the fraction.",
    ],
    [
      'say text.replace(part, "x")\nexit',
      { text: "abc", part: "" },
      "TSR057",
      "replace() needs non-empty text for 'search'.",
    ],
    [
      "say text.contains(part)\nexit",
      { text: "abc", part: 1 },
      "TSR057",
      "contains() needs text (string) for 'part', not a number. Convert it with toString(...).",
    ],
    [
      "say text.repeat(times)\nexit",
      { text: "abc", times: -1 },
      "TSR057",
      "repeat() needs 'count' to be 0 or more, not -1.",
    ],
    [
      "say text.repeat(times)\nexit",
      { text: "abc", times: 1.5 },
      "TSR057",
      "repeat() needs a whole number (integer) for 'count', not a number. Convert it with toInteger(...), which drops the fraction.",
    ],
    [
      "say text.padStart(size, fill)\nexit",
      { text: "abc", size: 5, fill: "" },
      "TSR057",
      "padStart() needs non-empty text for 'fill'.",
    ],
    [
      'say text.padEnd(size, "-")\nexit',
      { text: "abc", size: "5" },
      "TSR057",
      "padEnd() needs a whole number (integer) for 'length', not text (string). Convert it with toInteger(...).",
    ],
    [
      "say [text].join(separator)\nexit",
      { text: "a", separator: null },
      "TSR057",
      "join() needs text (string) for 'separator', not null.",
    ],
    [
      "say value.trim()\nexit",
      { value: 5 },
      "TSR016",
      "A number has no method 'trim'. Convert it to text first with toString(...).",
    ],
    [
      "say value.length\nexit",
      { value: null },
      "TSR017",
      "The value null has no property 'length'. Check that it is not null first.",
    ],
    ["say value.nope()\nexit", { value: "abc" }, "TSR016", "Text has no method 'nope'."],
    [
      "say value.size\nexit",
      { value: "abc" },
      "TSR017",
      "Text has no property 'size'. Use length.",
    ],
  ];
  for (const [source, globals, code, message] of cases) {
    const result = runWithGlobals(source, globals);
    assert.deepEqual(
      [result.snapshot.failure?.code, result.snapshot.failure?.message],
      [code, message],
      `${source} ${JSON.stringify(globals)}`,
    );
    const call = source.split("\n")[0]!.replace(/^say /u, "");
    assert.deepEqual(
      [result.snapshot.failure?.span.start.offset, result.snapshot.failure?.span.end.offset],
      [4, 4 + call.length],
      source,
    );
  }
  const nested = runValidSource(
    'function dynamic(value) { return value }\nsay dynamic([["a"]]).join()\nexit',
  );
  assert.deepEqual(
    [nested.snapshot.failure?.code, nested.snapshot.failure?.message],
    [
      "TSR021",
      "join() can only join text, numbers, true or false, null, durations, date and time values, and script references. Select an element or a property first.",
    ],
  );
});

test("text operations have static result types", () => {
  assert.deepEqual(
    diagnostics(
      [
        'let t = "a,b"',
        "let size: integer = t.length",
        'let at: integer = t.indexOf("b") + t.lastIndexOf("a")',
        'let found: boolean = t.contains("a") and t.startsWith("a") and t.endsWith("b")',
        'let parts: string[] = t.split(",")',
        'let joined: string = "${parts.join(" ")}${t.trim()}${t.repeat(2)}${t.padStart(5, "0")}"',
        "exit",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(diagnostics('let t = "a"\nlet at: string = t.indexOf("a")\nexit'), [
    [
      "TSV041",
      "'at' is declared as string, so it cannot start as a whole number (integer). To show it as text, write \"${value}\".",
      't.indexOf("a")',
    ],
  ]);
});

test("object properties named like text operations keep working", () => {
  assert.deepEqual(
    said('let box = { length: 3, trim: "no" }\nsay "${box.length} ${box.trim}"\nexit'),
    ["3 no"],
  );
});

test("a grouped method call keeps its receiver and argument order", () => {
  const source = [
    'let text = "old"',
    "function replaceText {",
    '    text = "new"',
    '    return "old"',
    "}",
    'say ("  a  ".trim)()',
    "say (text.contains)(replaceText())",
    "exit",
  ].join("\n");
  assert.deepEqual(said(source), ["a", "true"]);
});

test("receivers are checked before user-call arguments run", () => {
  const source = [
    "let calls = 0",
    "function part {",
    "    calls += 1",
    '    return "b"',
    "}",
    'say "${"abc".contains(part())} ${calls}"',
    "say n.contains(part())",
    "exit",
  ].join("\n");
  const result = runWithGlobals(source, { n: 5 });
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
      "    shouted.add(word.uppercaseFirst())",
      "}",
      'say shouted.join(" ")',
      'say "${words.join("").length}"',
      "exit",
    ].join("\n"),
  );
});

test("an operation that would make a text longer than any text can be fails with TSR084", () => {
  // The limit is what V8 can hold, here and in every other host.
  assert.equal(MAX_TEXT_LENGTH, constants.MAX_STRING_LENGTH);
  const limit = "but a text can hold at most about 536 million.";
  // Doubling builds long texts without copying them.
  const doubled = (times: number, text = "x") =>
    [`let s = "${text}"`, `repeat ${times} {`, "    s = s + s", "}"].join("\n");
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  for (const [source, line, message] of [
    [
      'let s = "x".repeat(9007199254740991)\nexit',
      1,
      `Text too long: repeat(9007199254740991) would make about 9,007,199,254,740,991 characters, ${limit}`,
    ],
    [
      `let s = "x".repeat(${MAX_TEXT_LENGTH + 1})\nexit`,
      1,
      `Text too long: repeat(536870889) would make about 536,870,889 characters, ${limit}`,
    ],
    [
      'let s = "x".padStart(600000000, "x")\nexit',
      1,
      `Text too long: padStart(600000000) would make about 600,000,000 characters, ${limit}`,
    ],
    [
      'let s = "x".padEnd(600000000, "ab")\nexit',
      1,
      `Text too long: padEnd(600000000) would make about 600,000,000 characters, ${limit}`,
    ],
    // Lone surrogates join while padding, so the length the text would reach is not known.
    [
      `let s = "${high}".padEnd(536870889, "${low}")\nexit`,
      1,
      `Text too long: padEnd(536870889) would make a text longer than a text can hold, which is about 536 million characters.`,
    ],
    [
      `${doubled(30)}\nexit`,
      3,
      `Text too long: joining with + would make about 536,870,912 characters, ${limit}`,
    ],
    [
      'let s = "x"\nrepeat 30 {\n    s = "${s}${s}"\n}\nexit',
      3,
      `Text too long: \${…} would make a text longer than a text can hold, which is about 536 million characters.`,
    ],
    [
      `${doubled(27)}\nlet joined = [s, s, s, s, s].join("")\nexit`,
      5,
      `Text too long: join would make about 671,088,640 characters, ${limit}`,
    ],
    [
      `${doubled(27)}\nlet grown = "aaaaa".replace("a", s)\nexit`,
      5,
      `Text too long: replace would make about 671,088,640 characters, ${limit}`,
    ],
    [
      'let s = "ß".repeat(268435445).uppercase()\nexit',
      1,
      `Text too long: uppercase would make about 536,870,890 characters, ${limit}`,
    ],
    [
      'let s = escapeMarkup("-".repeat(268435445))\nexit',
      1,
      `Text too long: escapeMarkup would make about 536,870,890 characters, ${limit}`,
    ],
    [
      'let s = "x".repeat(268435444)\nlet answers = askForm fields: { a: { value: true, description: s }, b: { value: true, description: s } }\nexit',
      2,
      `Text too long: askForm would make about 536,870,897 characters, ${limit}`,
    ],
    // Quoting doubles each line break, so the notation of one text is too long.
    [
      `${doubled(28, "\\n")}\nsay [s], instant\nexit`,
      5,
      `Text too long: say would make a text longer than a text can hold, which is about 536 million characters.`,
    ],
    [
      `${doubled(28, "\\n")}\nlet t = "\${script("main.tease", label: s)}"\nexit`,
      5,
      `Text too long: script(…) would make about 536,870,943 characters, ${limit}`,
    ],
    [
      `${doubled(28, "\\n")}\nlet t = timer(duration: 1 s, async: true, label: s)\nsay t, instant\nexit`,
      6,
      `Text too long: say would make about 536,870,932 characters, ${limit}`,
    ],
  ] as const) {
    const failure = runValidSource(source).snapshot.failure;
    assert.deepEqual(
      [failure?.code, failure === null ? null : failure.span.start.line + 1, failure?.message],
      ["TSR084", line, message],
      source,
    );
  }
});

test("an error message cuts the script's text it quotes, and a text no check foresaw still fails with TSR084", (context) => {
  const key = "k".repeat(2_000);
  const missing = runValidSource(
    `let key = "${key}"\nlet stock = dict{ "a": 1 }\nlet count = stock[key]\nexit`,
  ).snapshot.failure;
  assert.deepEqual(
    [missing?.code, missing?.message],
    ["TSR061", `Dictionary has no key "${"k".repeat(1_024)}…". Check stock.contains(key) first.`],
  );
  const literal = runValidSource(`let stock = dict{ "a": 1 }\nlet count = stock["${key}"]\nexit`)
    .snapshot.failure;
  const cut = `"${"k".repeat(1_024)}…"`;
  assert.equal(
    literal?.message,
    `Dictionary has no key ${cut}. Check stock.contains(${cut}) first.`,
  );
  const path = `${"d".repeat(2_000)}.tease`;
  const project = compileProject([
    {
      path: "main.tease",
      source: `let target = "${path}"\ncall script(target, label: "missing")\nexit`,
    },
    { path, source: "exit" },
  ]);
  assert.ok(project.plan !== null);
  const unlabeled = run(project.plan, createImmediatePacingRuntimeSnapshot(project.plan)).snapshot
    .failure;
  assert.equal(
    unlabeled?.message,
    `This call names label 'missing' of '${"d".repeat(1_024)}…', but that file has no such label.`,
  );
  // V8 says that a text is too long with this error.
  context.mock.method(String.prototype, "toUpperCase", () => {
    throw new RangeError("Invalid string length");
  });
  const failure = runValidSource('let s = "a"\nlet shout = s.uppercase()\nexit').snapshot.failure;
  assert.deepEqual(
    [failure?.code, failure === null ? null : failure.span.start.line + 1, failure?.message],
    [
      "TSR084",
      2,
      "Text too long: this line would make a text longer than a text can hold, which is about 536 million characters.",
    ],
  );
});
