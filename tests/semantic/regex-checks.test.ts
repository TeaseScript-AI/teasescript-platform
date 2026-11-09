/*
 * The compiler's regex checks: the literal and `toRegex` checked when a script compiles, the size limits, plan
 * validation, the checks a run confirms, and the lexer's reading of a regex that a run witnesses, on the regex tests'
 * shared host.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../../src/compiler.js";
import { lex } from "../../src/lexer.js";
import { validateInstructionPlan } from "../../src/plan/validation.js";
import { compileRegexProgram } from "../../src/regex-engine.js";
import {
  MAX_REGEX_GROUPS,
  MAX_REGEX_LENGTH,
  MAX_REGEX_SIZE,
  regexSizeEstimate,
} from "../../src/regex.js";
import { run } from "../../src/runtime/engine.js";
import { TokenKind } from "../../src/token.js";
import { compileValidPlan } from "../helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { sayTexts } from "../helpers/runtime-events.js";
import { said, runWithGlobals } from "../helpers/runtime/regex-host.js";

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
      // A `/` where RE2 reads a named class or quoted text does not end the literal.
      'say "${"/".matches(/[[:alpha:]/]/)} ${"/".matches(/[^[:space:]/]/)} ${"[".matches(/\\Q[\\E/)} ${"a/b".matches(/\\Qa/b\\E/)}"',
      // Quoted text without `\E` runs to the closing slash, and `\/` there does not end the literal either.
      'say "${"a\\\\/b".matches(/\\Qa\\/b/)} ${"\\\\/".matches(/\\Q\\//)}"',
    ),
    [
      "4 4 6 3 4 1",
      "4",
      "true",
      "true",
      "true",
      "true true false",
      "true",
      "true false true true",
      "true true",
    ],
  );
  // Where the grammar expects a value after a word, as after a speaker or a message mode, the parse finds the regex.
  assert.deepEqual(
    said(
      "speaker vera {}",
      "say as vera /a/",
      "say prose() /b/",
      'say prose(align: "center") /c/',
      "say skippable /d/",
      "let w = say as vera /e/",
      // A word that can be a value keeps dividing: a say reads a value before a mode or skip word.
      "let prose = 8",
      "say prose / 2",
    ),
    ["/a/", "/b/", "/c/", "/d/", "/e/", "4"],
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

test("after a message mode or skip word, a regex may hold what reads as a comment or an operator elsewhere", () => {
  // The tokens after a `/` do not show a regex's pattern, so a word before it divides only where its value parses
  // without errors.
  assert.deepEqual(
    said(
      "say prose /[/*]/",
      "say prose() /[//]/",
      'say prose(align: "center") /[*/]/',
      "say skippable /[/]/",
      "say bubble unskippable /[/*]/, instant",
      'say "${(say prose /[/*]/).text}"',
    ),
    ["/[/*]/", "/[//]/", "/[*/]/", "/[/]/", "/[/*]/", "/[/*]/", "/[/*]/"],
  );
  // A word whose value parses divides, also over a comment that a regex there would hold, and a comment stays one
  // right after an operator and before a division.
  assert.deepEqual(
    said(
      "let prose = 8",
      "say prose / [4 /* four */][0]",
      "let x = /* a comment */ 6",
      "say x /* a comment */ / 2",
    ),
    ["2", "3"],
  );
});

test("after an ask's message mode, a regex question may hold what reads as a comment or an operator elsewhere", () => {
  // As for `say`, a mode word before a `/` is the question only where the question parses from it without errors. Each
  // ask shows its question and waits for the answer.
  for (const [source, question] of [
    ["let a = askText prose /x/", "/x/"],
    ["let a = askText prose /[/*]/", "/[/*]/"],
    ["let a = askText prose /[/]/", "/[/]/"],
    ['let a = askText bubble() /[//]/, hint: "h"', "/[//]/"],
    ['let a = askNumber as vera prose(align: "center") /[*/]/', "/[*/]/"],
    ['say "${askText prose /[/*]/}"', "/[/*]/"],
  ] as const)
    assert.deepEqual(said('speaker vera {\n    name: "Vera"\n}', source), [question], source);
  // A word whose question parses divides, also over a comment that a regex there would hold.
  assert.deepEqual(said("let prose = 8", "let a = askNumber prose / [4 /* four */][0]"), ["2"]);
  assert.deepEqual(said("let bubble = 6", "let a = askNumber bubble /* a comment */ / 2"), ["3"]);
  // A regex that the divided question holds is found first, so the word before the division stays the question.
  for (const [lines, shown] of [
    [
      ["let prose = 8", "let a = askNumber prose / (say prose /x/).text.length"],
      ["/x/", "2.6666666666666665"],
    ],
    [
      ["let bubble = 8", "let a = askInteger bubble / (say bubble /[/*]/).text.length"],
      ["/[/*]/", "0.8888888888888888"],
    ],
    [
      ["let prose = 8", "let a = askText prose / (say prose /x/).text.length"],
      ["/x/", "2.6666666666666665"],
    ],
  ] as const)
    assert.deepEqual(said(...lines), shown, lines.join("\n"));
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
      "A regex has no 'g' flag: it is not needed. findAll finds every match, and replace and split handle every occurrence.",
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
      `This regex is too large: with its repeats written out it has about 11,002 steps, and a regex may have at most 10,000. Use smaller or fewer repeat counts such as '{100}'.`,
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
      [["TSV064", message, marked]],
      literal,
    );
  // The largest regexes within the limits compile.
  assert.deepEqual(diagnostics(`let r = /${"a{999}".repeat(10)}/\nexit`), []);
  assert.deepEqual(diagnostics(`let r = /${"(a)".repeat(MAX_REGEX_GROUPS)}/\nexit`), []);
});

test("a replacement that refers to a group the regex does not have is a compile or runtime error", () => {
  assert.deepEqual(diagnostics('let t = "ab".replace(/(a)/, "$2")\nexit'), [
    [
      "TSV043",
      "'$2' in the replacement refers to group 2, but this regex has 1 group. Write '$0' for the whole match or '$1' for its group, or '$$' for a '$'.",
      '"$2"',
    ],
  ]);
  assert.equal(
    firstDiagnostic('let t = "ab".replace(/(a)(b)/, "$<x>")\nexit')?.[1],
    "'$<x>' in the replacement refers to a group named 'x', but this regex has no group of that name. Name a group with '(?<x>...)', or write '$$' for a '$'.",
  );
  // The text after interpolation counts.
  assert.equal(
    firstDiagnostic('let t = "ab".replace(/a/, "${"$"}1")\nexit')?.[1],
    "'$1' in the replacement refers to group 1, but this regex has no groups. Write '$0' for the whole match, or '$$' for a '$'.",
  );
  // A replacement or regex the compiler cannot know fails when it runs, also when nothing matches.
  for (const source of [
    'let t = "ab".replace(/x(y)/, replacement)\nexit',
    'function dynamic(value) {\n  return value\n}\nlet r = toRegex(dynamic("x"), default: null)\nif r != null {\n  let t = "ab".replace(r, "$1")\n}\nexit',
  ]) {
    const runtime = runWithGlobals(source, { replacement: "$2" });
    assert.equal(runtime.snapshot.failure?.code, "TSV043", source);
    assert.match(
      runtime.snapshot.failure!.message,
      /^'\$[12]' in the replacement refers to group/u,
    );
  }
});

test("the regex operations check their arguments", () => {
  assert.deepEqual(diagnostics('let all = "a".findAll("a")\nexit'), [
    [
      "TSV043",
      "findAll() needs a regex for 'pattern', not text (string). Write a regex such as '/[0-9]+/' instead, or make one from the text with the toRegex function.",
      '"a"',
    ],
  ]);
  assert.equal(
    firstDiagnostic('let t = "a".replace("", "b")\nexit')?.[1],
    "replace() needs non-empty text for 'search'.",
  );
  assert.equal(
    firstDiagnostic('let at = "a".lastIndexOf(4)\nexit')?.[1],
    "lastIndexOf() needs text (string) or a regex for 'part', not a whole number (integer). Convert the value with the toString function.",
  );
  // A regex that matches empty text is a valid search.
  assert.deepEqual(diagnostics('let t = "a".replace(/x*/, "")\nexit'), []);
  const runtime = runWithGlobals('let all = "a,b".split(separator)\nexit', { separator: 4 });
  assert.equal(runtime.snapshot.failure?.code, "TSV043");
  assert.equal(
    runtime.snapshot.failure?.message,
    "split() needs text (string) or a regex for 'separator', not a whole number (integer). Convert the value with the toString function.",
  );
});

test("the regex methods and a regex's members are checked", () => {
  assert.deepEqual(diagnostics('let ok = "a".matches("a")\nexit'), [
    [
      "TSV043",
      "matches() needs a regex for 'pattern', not text (string). Write a regex such as '/[0-9]+/' instead, or make one from the text with the toRegex function.",
      '"a"',
    ],
  ]);
  assert.deepEqual(
    diagnostics('let at = "a".indexOf(4)\nexit')[0]?.[1],
    "indexOf() needs text (string) or a regex for 'part', not a whole number (integer). Convert the value with the toString function.",
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
  assert.equal(runtime.snapshot.failure?.code, "TSV043");
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
  assert.equal(result.snapshot.failure?.code, "TSV043");
  assert.equal(
    result.snapshot.failure?.message,
    "toJson(...) cannot write this dict: it holds a regex, which has no JSON form. Write plain values, such as text, numbers, lists, or dicts, instead.",
  );
});

test("ignoring case for wide character ranges is bounded when a regex compiles", () => {
  const wide = (from: number) => `[\\x{${from.toString(16)}}-\\x{10FFFF}]`;
  assert.deepEqual(diagnostics(`let r = /${wide(0x80)}${wide(0x81)}/i\nexit`), []);
  assert.deepEqual(
    diagnostics(`let r = /${wide(0x80)}${wide(0x81)}${wide(0x82)}/i\nexit`)[0]?.slice(0, 2),
    [
      "TSV064",
      "This regex is too large: ignoring case for its character ranges takes too much work. Use smaller ranges such as [a-z], or match both cases without the 'i' flag.",
    ],
  );
  // Without ignoring case the same ranges cost nothing to compile.
  assert.deepEqual(diagnostics(`let r = /${wide(0x80)}${wide(0x81)}${wide(0x82)}/\nexit`), []);
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

test("a pattern cannot hold half of a character, and text with lone surrogates is searched by code point", () => {
  const half =
    "A regex cannot hold half of a character: '\\x{D83D}' is a surrogate, which stands for half of a character such as an emoji. Write the whole character, as in '\\x{1F600}'.";
  assert.deepEqual(diagnostics("let r = /(\\x{D83D})/\nexit"), [["TSV064", half, "/(\\x{D83D})/"]]);
  assert.equal(firstDiagnostic("let r = /[\\x{DE00}]/\nexit")?.[0], "TSV064");
  // RE2 takes any number of hex digits.
  assert.equal(firstDiagnostic("let r = /(\\x{00000D83D})/\nexit")?.[0], "TSV064");
  assert.equal(firstDiagnostic("let r = /\\x{000000000DE00}/\nexit")?.[0], "TSV064");
  assert.deepEqual(diagnostics("let r = /\\x{00000001F600}/\nexit"), []);
  // Quoted or escaped, the same characters are text.
  assert.deepEqual(diagnostics("let r = /\\Q\\x{D83D}\\E|\\\\x{D83D}/\nexit"), []);
  // From text, and with a lone surrogate written in the text, the pattern gives the default.
  assert.deepEqual(
    said(
      'say "${toRegex("\\\\x{D83D}", default: null)} ${toRegex("\\\\x{1F600}", default: null)}"',
    ),
    ["null /\\x{1F600}/"],
  );
  const plan = compileValidPlan("let r = toRegex(pattern, default: /none/)\nsay r\nexit", {
    globals: ["pattern"],
  });
  const lone = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { globals: { pattern: "\uD83D" } }),
  );
  assert.deepEqual(sayTexts(lone), ["/none/"]);
  // Every search agrees: a lone surrogate in text is one character, and half of a pair is none.
  const searches = (text: string) =>
    runWithGlobals(
      [
        "let r = /[\\x{D7FF}-\\x{E000}]/",
        'say "${text.contains(r)} ${text.find(r) != null} ${text.capture(r) != null} ${text.indexOf(r)} ${text.matches(r)}"',
        'say "${text.matches(/./)} ${text.indexOf(/x/)}"',
        "exit",
      ].join("\n"),
      { text },
    );
  assert.deepEqual(sayTexts(searches("😀x")), ["false false false null false", "false 1"]);
  assert.deepEqual(sayTexts(searches("\uD83Dx")), ["true true true 0 false", "false 1"]);
  assert.deepEqual(sayTexts(searches("\uDE00")), ["true true true 0 true", "true null"]);
});

test("the program-size limit holds at exactly 10,000 instructions, and long patterns are refused before compiling", () => {
  // `a{1000}` nine times and `a{998}` compile to 10,000 instructions; one character more is over the limit.
  const largest = "a{1000}".repeat(9) + "a{998}";
  const compiled = compileRegexProgram(largest, "");
  assert.ok(compiled.ok && compiled.program.size === MAX_REGEX_SIZE);
  assert.deepEqual(diagnostics(`let r = /${largest}/\nexit`), []);
  assert.equal(
    firstDiagnostic(`let r = /${largest}a/\nexit`)?.[1],
    "This regex is too large: with its repeats written out it has about 10,001 steps, and a regex may have at most 10,000. Use smaller or fewer repeat counts such as '{100}'.",
  );
  assert.equal(
    firstDiagnostic(`let r = /(?:${"(?:".repeat(103)}a${"){1000}".repeat(103)})/\nexit`)?.[1],
    "This regex is too large: with its repeats written out it has more than a million steps, and a regex may have at most 10,000. Use smaller or fewer repeat counts such as '{100}'.",
  );
  // A long class compiles to one instruction, but RE2 reads all of it: the pattern's length is limited too.
  assert.deepEqual(diagnostics(`let r = /[${"a".repeat(MAX_REGEX_LENGTH - 2)}]/\nexit`), []);
  assert.deepEqual(
    firstDiagnostic(`let r = /[${"a".repeat(MAX_REGEX_LENGTH - 1)}]/\nexit`)?.slice(0, 2),
    [
      "TSV064",
      "This regex is too long: a regex may have at most 10,000 characters. Use a shorter pattern.",
    ],
  );
});
