import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { lex } from "../src/lexer.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { compileRegexProgram } from "../src/regex-engine.js";
import { MAX_REGEX_GROUPS, MAX_REGEX_SIZE, regexSizeEstimate } from "../src/regex.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import {
  validateSerializableValue,
  type SerializableRuntimeValue,
} from "../src/runtime/serializable-values.js";
import { TokenKind } from "../src/token.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { runValidSource } from "./helpers/run-valid-source.js";

/*
 * Regexes (V30 §8): the literal, the `regex` value, `toRegex`, and the step-A searches `matches`, `contains`, `find`,
 * `capture`, and `indexOf`, from source through the runtime, checkpoints, and storage.
 */

function said(...lines: string[]): string[] {
  const result = runValidSource([...lines, "exit"].join("\n"));
  assert.equal(result.snapshot.failure, null, lines.join("\n"));
  return sayTexts(result);
}

/** The diagnostics of `source` as code, message, and the source text they mark. */
function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** The first diagnostic of `source` as code, message, and the source text it marks. */
function firstDiagnostic(source: string): [string, string, string] | undefined {
  return diagnostics(source)[0];
}

/** Runs `source` with host globals, whose values the compiler cannot know, and returns the failure or the says. */
function runWithGlobals(source: string, globals: Record<string, string | number | null>) {
  const plan = compileValidPlan(source, { globals: Object.keys(globals) });
  return run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
}

test("matches checks the whole text, and contains, find, and indexOf the first leftmost match", () => {
  assert.deepEqual(
    said(
      'let text = "Moved 12 times, then 3 more"',
      'say "${text.matches(/Moved.*/)} ${text.matches(/Moved/)} ${text.matches(/\\d+/)}"',
      'say "${text.contains(/\\d+ times/)} ${text.contains(/\\d+ days/)}"',
      'say "${text.find(/\\d+/)} ${text.find(/days/)} ${text.indexOf(/\\d+/)} ${text.indexOf(/days/)}"',
      // RE2 keeps the first alternative that matches, and `matches` needs the whole text, not a match that ends early.
      'say "${"ab".find(/a|ab/)} ${"ab".matches(/a|ab/)} ${"a\\nb".matches(/^a$/m)} ${"a\\nb".contains(/^b$/m)}"',
      'say "${"".matches(/x*/)} ${"".find(/x*/) == ""} ${"abc".indexOf(/x*/)}"',
    ),
    ["true false false", "true false", "12 null 6 null", "a true false true", "true true 0"],
  );
});

test("capture gives the whole match and every group in opening order, null for a group that did not take part", () => {
  assert.deepEqual(
    said(
      'say "a".capture(/(a)(b)?(c*)/)',
      'say "x 12-34".capture(/(?<first>\\d+)-(\\d+)/)',
      'say "b".capture(/(a)|(b)/)',
      // re2js's map of group names misses this name, which capture does not read.
      'say "b".capture(/(a){0}(?<v>b)/)',
      // A repeated group keeps its last repetition.
      'say "aaa".capture(/(a)*/)',
      'say "abc".capture(/x/)',
      'let parts = "Score: 7/10".capture(/(\\d+)\\/(\\d+)/)',
      "if parts != null {",
      '  say "${parts[1]} of ${parts[2]}, ${parts.length} parts"',
      "}",
    ),
    [
      '["a", "a", null, ""]',
      '["12-34", "12", "34"]',
      '["b", null, "b"]',
      '["b", null, "b"]',
      '["aaa", "a"]',
      "null",
      "7 of 10, 3 parts",
    ],
  );
  assert.deepEqual(
    firstDiagnostic('let parts = "a".capture(/(a)/)\nsay parts[0].length\nexit')?.[0],
    "TSV043",
  );
});

test("positions count code points, also after emoji", () => {
  assert.deepEqual(
    said(
      'let text = "😀a😀b"',
      'say "${text.indexOf(/a/)} ${text.indexOf(/b/)} ${text.find(/./)} ${text.find(/b|😀$/)}"',
      "say text.capture(/(.)(.)/)",
      "say text.indexOf(/😀b/)",
      // An empty match advances past the whole emoji.
      'say "${"😀".indexOf(/$/)} ${"😀😀x".indexOf(/x/)}"',
    ),
    ["1 3 😀 b", '["😀a", "😀", "a"]', "2", "1 2"],
  );
});

test("the flags i, m, and s change matching, and a regex keeps them in canonical order", () => {
  assert.deepEqual(
    said(
      'say "${"ABC".matches(/abc/i)} ${"ABC".matches(/abc/)} ${"ABC".matches(/(?i)abc/)}"',
      'say "${"a\\nb".contains(/a.b/s)} ${"a\\nb".contains(/a.b/)} ${"x\\nab".contains(/^ab$/m)}"',
      "say /a/smi",
      'say "${/a/si == /a/is} ${/a/i == /(?i)a/} ${/a/ == /a/i}"',
    ),
    ["true false true", "true false true", "/a/ims", "true false false"],
  );
});

test("a regex shows as its literal and compares by pattern and flags", () => {
  assert.deepEqual(
    said(
      "let r = /\\d+[a*]/i",
      'say r\nsay "${r}"\nsay toString(r)',
      "say [r, /x/]",
      'say "${r == /\\d+[a*]/i} ${r != /\\d+[a*]/} ${[/a/, r].contains(/\\d+[a*]/i)} ${[/a/, r].indexOf(r)}"',
      'say "${set[/a/, /a/, /a/i].length} ${dict { "k": /a/ } == dict { "k": /a/ }}"',
      'let values: (regex | string)?[] = [r, null, "/a/"]',
      'say "${values[0] is regex} ${values[1] is regex} ${values[2] is regex} ${values[1] is regex?}"',
    ),
    [
      "/\\d+[a*]/i",
      "/\\d+[a*]/i",
      "/\\d+[a*]/i",
      "[/\\d+[a*]/i, /x/]",
      "true true true 1",
      "2 true",
      "true false false true",
    ],
  );
});

test("toRegex makes a regex of pattern text, or gives its default for text that cannot be one", () => {
  assert.deepEqual(
    said(
      'let digits = toRegex("\\\\d+", default: null)',
      'say "${digits} ${digits == /\\d+/}"',
      'say toRegex("(?i)ab", default: null)',
      'say "${toRegex("(", default: null)} ${toRegex("(a)\\\\1", default: /x/)} ${toRegex("a(?=b)", default: null)}"',
      `say toRegex("${"a{1000}".repeat(11)}", default: /too large/)`,
      `say toRegex("${"(a)".repeat(MAX_REGEX_GROUPS + 1)}", default: /too many groups/)`,
      'let chosen: regex = toRegex("[", default: /none/)',
      'say "${chosen} ${"".matches(toRegex("", default: /x/))}"',
    ),
    ["/\\d+/ true", "/(?i)ab/", "null /x/ null", "/too large/", "/too many groups/", "/none/ true"],
  );
  // Text that is not text, which only the runtime can know, gives the default too.
  const unknown = runWithGlobals("say toRegex(value, default: /d/)\nexit", { value: 4 });
  assert.equal(unknown.snapshot.failure, null);
  assert.deepEqual(sayTexts(unknown), ["/d/"]);
  const wrongDefault = runWithGlobals('say toRegex("a", default: value)\nexit', { value: "x" });
  assert.equal(wrongDefault.snapshot.failure?.code, "TSR058");
  assert.equal(
    wrongDefault.snapshot.failure?.message,
    "toRegex(...) needs a regex or null as its default:, not text (string).",
  );
});

test("toRegex needs a default:, which is a regex or null, and decides the result type", () => {
  assert.deepEqual(diagnostics('let r = toRegex("a")\nexit'), [
    [
      "TSV020",
      "'toRegex(text, default: value)' needs a 'default:' for text that is not a valid regex. Add one, such as 'default: null'.",
      'toRegex("a")',
    ],
  ]);
  assert.deepEqual(diagnostics('let r = toRegex("a", default: "a")\nexit'), [
    ["TSV043", "toRegex(...) needs a regex or null as its default:, not text (string).", '"a"'],
  ]);
  assert.deepEqual(diagnostics("let r = toRegex(4, default: null)\nexit"), [
    ["TSV043", "toRegex(...) reads pattern text (string), not a whole number (integer).", "4"],
  ]);
  assert.deepEqual(
    diagnostics('let r = toRegex("a", default: null, flags: "i")\nexit').map((item) => item[0]),
    ["TSV022"],
  );
  assert.deepEqual(diagnostics('let r: regex = toRegex("a", default: /b/)\nexit'), []);
  assert.equal(firstDiagnostic('let r: regex = toRegex("a", default: null)\nexit')?.[0], "TSV041");
});

test("lexing tells a regex from division and comments by whether an operand is expected", () => {
  assert.deepEqual(
    said(
      "let a = 12",
      "let b = 3",
      "let o = { set: 8 }",
      'say "${a / b} ${a/b} ${(a) / 2} ${[a][0] / 4} ${o.set / 2} ${10 / 2 / 5}" // a comment / here',
      "say a / /* a block comment / */ b",
      'say "x/y".contains(/[/]/)\nsay "x/y".contains(/\\//)\nsay "a]/b".contains(/[]/]b/)',
      'say "${"a}b".contains(/[}"]/)} ${"a\\"b".contains(/[}"]/)} ${"ab".contains(/[}"]/)}"',
      'say "x".contains(',
      "  /x/",
      ")",
    ),
    ["4 4 6 3 4 1", "4", "true", "true", "true", "true true false", "true"],
  );
  const kinds = (source: string) =>
    lex(source)
      .tokens.map((token) => token.kind)
      .filter((kind) => kind !== TokenKind.Newline && kind !== TokenKind.EndOfFile);
  // Past a line break the token before still decides, so an operator at the start of a line stays one (V30 §1).
  assert.deepEqual(kinds("(a\n / b)"), [
    TokenKind.LeftParenthesis,
    TokenKind.Identifier,
    TokenKind.Slash,
    TokenKind.Identifier,
    TokenKind.RightParenthesis,
  ]);
  assert.deepEqual(kinds("a / b / c"), [
    TokenKind.Identifier,
    TokenKind.Slash,
    TokenKind.Identifier,
    TokenKind.Slash,
    TokenKind.Identifier,
  ]);
  assert.deepEqual(kinds('save /a/i as "k"'), [
    TokenKind.Identifier,
    TokenKind.RegexLiteral,
    TokenKind.KeywordAs,
    TokenKind.StringStart,
    TokenKind.StringText,
    TokenKind.StringEnd,
  ]);
  // `//` and `/*` stay comments, so there is no empty regex literal.
  assert.deepEqual(kinds("let r = // a comment"), [
    TokenKind.KeywordLet,
    TokenKind.Identifier,
    TokenKind.Equal,
  ]);
  assert.deepEqual(kinds("let r = /(?:)/"), [
    TokenKind.KeywordLet,
    TokenKind.Identifier,
    TokenKind.Equal,
    TokenKind.RegexLiteral,
  ]);
  // The pattern is opaque: no interpolation and no string escapes.
  const [literal] = lex('let r = /${name}\\n"/').tokens.filter(
    (token) => token.kind === TokenKind.RegexLiteral,
  );
  assert.equal(literal !== undefined && "value" in literal ? literal.value : null, '${name}\\n"');
});

test("an unterminated regex literal is reported at its opening slash", () => {
  assert.deepEqual(diagnostics("let r = /abc\nexit")[0], [
    "TSL009",
    "This regex has no closing '/' on its line. End it with '/', and write '\\/' for a slash inside it.",
    "/abc",
  ]);
  // A physical line break ends it, also inside a class or after a backslash.
  assert.equal(firstDiagnostic("let r = /[a/\n]/\nexit")?.[2], "/[a/");
  assert.equal(firstDiagnostic("let r = /a\\\nb/\nexit")?.[2], "/a\\");
  assert.equal(firstDiagnostic('say "${"a".contains(/a)}"\nexit')?.[0], "TSL009");
});

test("a regex literal is checked when the script compiles, with an explanation", () => {
  const cases: [string, string, string][] = [
    [
      "/a/g",
      "A regex has no 'g' flag: it is not needed. Finding every match will be findAll, which comes later, and replace and split with text already handle every occurrence.",
      "g",
    ],
    ["/a/u", "A regex has no 'u' flag: a regex always matches Unicode characters.", "u"],
    [
      "/a/x",
      "A regex has no flag 'x'. Its flags are 'i' (ignore case), 'm' (^ and $ match at each line), and 's' (. also matches a line break).",
      "x",
    ],
    ["/a/isi", "The flag 'i' appears twice. Write it once.", "isi"],
    [
      "/(a)\\1/",
      "A regex cannot refer back to a group with '\\1', because a regex must match in time proportional to the text. Repeat the group's pattern instead.",
      "/(a)\\1/",
    ],
    [
      "/a(?=b)/",
      "A regex cannot look ahead with '(?=', because a regex must match in time proportional to the text. Match that text as part of the regex, or check it with a second regex.",
      "/a(?=b)/",
    ],
    [
      "/a(?!b)/",
      "A regex cannot look ahead with '(?!', because a regex must match in time proportional to the text. Match that text as part of the regex, or check it with a second regex.",
      "/a(?!b)/",
    ],
    [
      "/(?<=a)b/",
      "A regex cannot look behind with '(?<=', because a regex must match in time proportional to the text. Match that text as part of the regex, or check it with a second regex.",
      "/(?<=a)b/",
    ],
    ["/(a/", "This regex is not valid: missing closing ) in '(a'.", "/(a/"],
    ["/a{1001}/", "This regex is not valid: invalid repeat count in '{1001}'.", "/a{1001}/"],
    [
      `/${"a{1000}".repeat(11)}/`,
      `This regex is too large: with its repeats written out it has about 11,000 steps, and a regex may have at most 10,000. Use smaller or fewer repeat counts such as '{100}'.`,
      `/${"a{1000}".repeat(11)}/`,
    ],
    [
      `/${"(a)".repeat(MAX_REGEX_GROUPS + 1)}/`,
      "This regex has 101 groups, and a regex may have at most 100. Write '(?:...)' for a group that only groups.",
      `/${"(a)".repeat(MAX_REGEX_GROUPS + 1)}/`,
    ],
  ];
  for (const [literal, message, marked] of cases)
    assert.deepEqual(
      diagnostics(`let r = ${literal}\nexit`),
      [["TSV063", message, marked]],
      literal,
    );
  // The largest regexes within the limits compile.
  assert.deepEqual(diagnostics(`let r = /${"a{999}".repeat(10)}/\nexit`), []);
  assert.deepEqual(diagnostics(`let r = /${"(a)".repeat(MAX_REGEX_GROUPS)}/\nexit`), []);
});

test("findAll and a regex in split, replace, and lastIndexOf are compile errors that say they come later", () => {
  const later = (method: string, parameter: string) =>
    `${method}() does not take a regex yet: that comes later. Give text for '${parameter}' instead.`;
  assert.deepEqual(diagnostics('let parts = "a,b".split(/,/)\nexit'), [
    ["TSV043", later("split", "separator"), "/,/"],
  ]);
  assert.deepEqual(diagnostics('let tidy = "a  b".replace(/ +/, " ")\nexit'), [
    ["TSV043", later("replace", "search"), "/ +/"],
  ]);
  assert.deepEqual(diagnostics('let at = "aba".lastIndexOf(/a/)\nexit'), [
    ["TSV043", later("lastIndexOf", "part"), "/a/"],
  ]);
  assert.deepEqual(diagnostics('let all = "a1b2".findAll(/\\d/)\nexit'), [
    [
      "TSV043",
      "Text has no method 'findAll' yet: it comes later. Use find(...) for the first match.",
      "findAll",
    ],
  ]);
  // The text forms stay as they are.
  assert.deepEqual(
    said('say "a,b".split(",")\nsay "a  b".replace("  ", " ")\nsay "aba".lastIndexOf("a")'),
    ['["a", "b"]', "a b", "2"],
  );
  // Where only the runtime knows the value, it fails the same way.
  const runtime = runValidSource(
    'let separators: list = [/,/]\nlet parts = "a,b".split(separators[0])\nexit',
  );
  assert.equal(runtime.snapshot.failure?.code, "TSR057");
  assert.equal(runtime.snapshot.failure?.message, later("split", "separator"));
});

test("the regex methods and a regex's members are checked", () => {
  assert.deepEqual(diagnostics('let ok = "a".matches("a")\nexit'), [
    [
      "TSV043",
      "matches() needs a regex for 'pattern', not text (string). Write a regex such as /[0-9]+/, or make one from text with toRegex(text, default: ...).",
      '"a"',
    ],
  ]);
  assert.deepEqual(
    diagnostics('let at = "a".indexOf(4)\nexit')[0]?.[1],
    "indexOf() needs text (string) or a regex for 'part', not a whole number (integer). Convert it with toString(...).",
  );
  assert.deepEqual(diagnostics('let r = /a/\nlet ok = r.matches("a")\nexit'), [
    [
      "TSV043",
      "A regex has no method 'matches'. Call a method of the text with the regex instead, such as text.contains(regex) or text.matches(regex).",
      "matches",
    ],
  ]);
  assert.equal(
    firstDiagnostic('let ok = "a".find(toRegex("a", default: null))\nexit')?.[0],
    "TSV043",
  );
  const runtime = runWithGlobals('let ok = "a".matches(pattern)\nexit', { pattern: "a" });
  assert.equal(runtime.snapshot.failure?.code, "TSR057");
});

test("toJson cannot write a regex, also inside a list or a dict", () => {
  assert.deepEqual(diagnostics("let text = toJson(/a/)\nexit"), [
    [
      "TSV043",
      "toJson(...) cannot write a regex, which has no JSON form. Write plain values, such as text, numbers, lists, or dicts, instead.",
      "/a/",
    ],
  ]);
  assert.equal(firstDiagnostic('let text = toJson(dict { "k": /a/ })\nexit')?.[0], "TSV043");
  // The parameter's type is not known, so only the runtime sees the regex.
  const plan = compileValidPlan(
    'function write(value) {\n  say toJson(value)\n}\nwrite(dict { "k": [/a/] })\nexit',
  );
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(result.snapshot.failure?.code, "TSR059");
  assert.equal(
    result.snapshot.failure?.message,
    "toJson(...) cannot write this value: it holds a regex, which has no JSON form. Write plain values, such as text, numbers, lists, or dicts, instead.",
  );
});

test("ignoring case reads pinned Unicode case pairs, not the host's", () => {
  // U+0264 and U+A7CB became a case pair in Unicode 16, which older browsers do not know.
  const source =
    'say "${"Ɤ".matches(/ɤ/i)} ${"Ɤ".matches(/(?i)[ɠ-ɰ]/)} ${"É".matches(/é/i)} ${"SS".matches(/ß/i)}"\nexit';
  const expected = ["true true true false"];
  assert.deepEqual(sayTexts(runValidSource(source)), expected);
  // A host whose case mapping knows no pairs at all gives the same results, with a regex compiled and searched anew.
  const lower = String.prototype.toLowerCase;
  const upper = String.prototype.toUpperCase;
  const unchanged = function (this: string): string {
    return `${this}`;
  };
  String.prototype.toLowerCase = unchanged;
  String.prototype.toUpperCase = unchanged;
  try {
    assert.deepEqual(sayTexts(runValidSource(source.replace("ɠ-ɰ", "ɡ-ɰ"))), expected);
  } finally {
    String.prototype.toLowerCase = lower;
    String.prototype.toUpperCase = upper;
  }
  assert.equal("Ä".toLowerCase(), "ä");
});

test("ignoring case for wide character ranges is bounded when a regex compiles", () => {
  const wide = (from: number) => `[\\x{${from.toString(16)}}-\\x{10FFFF}]`;
  assert.deepEqual(diagnostics(`let r = /${wide(0x80)}${wide(0x81)}/i\nexit`), []);
  assert.deepEqual(
    diagnostics(`let r = /${wide(0x80)}${wide(0x81)}${wide(0x82)}/i\nexit`)[0]?.slice(0, 2),
    [
      "TSV063",
      "This regex is too large: ignoring case for its character ranges takes too much work. Use smaller ranges such as [a-z], or match both cases without the 'i' flag.",
    ],
  );
  // Without ignoring case the same ranges cost nothing to compile.
  assert.deepEqual(diagnostics(`let r = /${wide(0x80)}${wide(0x81)}${wide(0x82)}/\nexit`), []);
});

test("regexes survive checkpoints and restores at every boundary, and save and load keep them", () => {
  const source = [
    "let pattern = /(\\d+) (times|days)/i",
    'let found = "3 TIMES".capture(pattern)',
    "let patterns = [pattern, /x/]",
    'let byName = dict { "count": pattern }',
    'let built = toRegex("(?s)a.b", default: null)',
    "wait 1 s",
    "say found\nsay patterns",
    'say "${byName["count"] == pattern} ${built}"',
    'save pattern as "pattern"',
    'save [built] as "built"',
    'let loaded: regex = load("pattern", default: /none/)',
    'let more: regex?[] = load("built", default: [])',
    'say "${loaded == pattern} ${"5 days".matches(loaded)} ${more[0]}"',
    "exit",
  ].join("\n");
  const result = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    [
      '["3 TIMES", "3", "TIMES"]',
      "[/(\\d+) (times|days)/i, /x/]",
      "true /(?s)a.b/",
      "true true /(?s)a.b/",
    ],
  );
  assert.deepEqual(result.finalSnapshot.scriptStorage, [
    {
      key: "built",
      value: { kind: "list", items: [{ kind: "regex", source: "(?s)a.b", flags: "" }] },
    },
    { key: "pattern", value: { kind: "regex", source: "(\\d+) (times|days)", flags: "i" } },
  ]);
  // A checkpoint keeps a regex as plain data and restores it.
  const plan = compileValidPlan(source);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const json = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  assert.ok(json.includes('"kind":"regex"'));
  assert.equal(deserializeCheckpoint(json).snapshot.status, waiting.snapshot.status);
});

test("stored and restored regex values are validated, with RE2 and the regex limits", () => {
  assert.equal(validateSerializableValue({ kind: "regex", source: "a+", flags: "im" }), null);
  assert.equal(
    validateSerializableValue({ kind: "list", items: [{ kind: "regex", source: "", flags: "" }] }),
    null,
  );
  for (const [value, failure] of [
    [{ kind: "regex", source: "a", flags: "mi" }, "$ contains a malformed regex."],
    [{ kind: "regex", source: "a", flags: "g" }, "$ contains a malformed regex."],
    [{ kind: "regex", source: "a", flags: "ii" }, "$ contains a malformed regex."],
    [{ kind: "regex", source: 4, flags: "" }, "$ contains a malformed regex."],
    [{ kind: "regex", source: "a" }, "$ contains a malformed regex."],
    [{ kind: "regex", source: "a", flags: "", extra: 1 }, "$ contains a malformed regex."],
    [
      { kind: "regex", source: "(", flags: "" },
      "$ contains a regex that cannot be used: This regex is not valid: missing closing ) in '('.",
    ],
    [
      { kind: "list", items: [{ kind: "regex", source: "a{1000}".repeat(11), flags: "" }] },
      "$.items[0] contains a regex that cannot be used: This regex is too large: with its repeats written out it has about 11,000 steps, and a regex may have at most 10,000. Use smaller or fewer repeat counts such as '{100}'.",
    ],
  ] as const)
    assert.equal(validateSerializableValue(value), failure, JSON.stringify(value));
  // Host storage holds plain values, so a stored regex is checked like any other.
  const plan = compileValidPlan('let r: regex = load("r", default: /x/)\nsay r\nexit');
  const stored = (value: SerializableRuntimeValue) =>
    run(plan, createImmediatePacingRuntimeSnapshot(plan, { scriptStorage: [{ key: "r", value }] }));
  assert.deepEqual(sayTexts(stored({ kind: "regex", source: "b", flags: "s" })), ["/b/s"]);
  assert.throws(() => stored({ kind: "regex", source: "(?=b)", flags: "" }), /cannot be used/u);
});

test("plan validation checks a regex literal's pattern and flags", () => {
  const plan = compileValidPlan("let r = /a+/i\nexit");
  // Whether the plan validates with its regex literal's pattern and flags replaced.
  const validWith = (source: string, flags: string): boolean =>
    validateInstructionPlan(
      JSON.parse(
        JSON.stringify(plan).replace(
          '"source":"a+","flags":"i"',
          `"source":${JSON.stringify(source)},"flags":${JSON.stringify(flags)}`,
        ),
      ),
    ).valid;
  assert.ok(JSON.stringify(plan).includes('{"kind":"regex","source":"a+","flags":"i"'));
  assert.equal(validWith("b", ""), true);
  for (const [source, flags] of [
    ["a", "q"],
    ["a", "si"],
    ["(", ""],
    ["\\1", ""],
  ] as const)
    assert.equal(validWith(source, flags), false, `${source} ${flags}`);
});

test("the size estimate is at least what RE2 compiles, so the limit is checked before a regex is written out", () => {
  for (const pattern of [
    "a",
    "a+b*c?",
    "(a|bc){3,7}",
    "(?i:ab){5}",
    "[]a]{5}x{2,}",
    "\\Qa*b\\E{3}",
    "(?P<n>[[:alpha:]]){4}",
    "((a{10}){10}){5}",
    "\\x{41}{9}\\p{L}+",
    "😀{5}",
  ]) {
    const compiled = compileRegexProgram(pattern, "");
    assert.ok(compiled.ok, pattern);
    // RE2 adds two instructions around every program.
    assert.ok(regexSizeEstimate(pattern) + 2 >= compiled.program.size, pattern);
  }
  assert.equal(regexSizeEstimate("a{1000}".repeat(10)), MAX_REGEX_SIZE);
});
