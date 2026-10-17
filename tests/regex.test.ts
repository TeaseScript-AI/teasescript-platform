import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { lex } from "../src/lexer.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { compileRegexProgram, MAX_REGEX_WORK, withRegexWorkLimit } from "../src/regex-engine.js";
import {
  MAX_REGEX_GROUPS,
  MAX_REGEX_LENGTH,
  MAX_REGEX_SIZE,
  regexSizeEstimate,
} from "../src/regex.js";
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
 * Regexes (V30 §8): the literal, the `regex` value, `toRegex`, the searches `matches`, `contains`, `find`, `capture`,
 * `indexOf`, `findAll`, `count`, and `lastIndexOf`, `split` and `replace` with a regex, and the work limit of each
 * operation, from source through the runtime, checkpoints, and storage.
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
      // Data with the same fields is a dict, never a regex.
      'say fromJson("{\\"kind\\": \\"regex\\", \\"source\\": \\"a\\", \\"flags\\": \\"\\"}", default: null) is regex',
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
      "false",
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
  // A pattern whose repeats nest far beyond the limits gives the default as well.
  const deep = "(?:".repeat(103) + "a" + "){1000}".repeat(103);
  assert.deepEqual(said(`say toRegex("${deep}", default: null)`), ["null"]);
  // The default is evaluated after the pattern, and only when it is used (owner decision, 2026-10-16).
  assert.deepEqual(
    said(
      "let order: string[] = []",
      "function pattern(text) {\n  order.add(text)\n  return text\n}",
      'function backup {\n  order.add("default")\n  return /b/\n}',
      'let r = toRegex(pattern("a"), default: backup())',
      'let s = toRegex(pattern("("), default: backup())',
      'say "${r} ${s} ${order.join()}"',
    ),
    ["/a/ /b/ a, (, default"],
  );
  // Text that is not text, which only the runtime can know, gives the default too.
  const unknown = runWithGlobals("say toRegex(value, default: /d/)\nexit", { value: 4 });
  assert.equal(unknown.snapshot.failure, null);
  assert.deepEqual(sayTexts(unknown), ["/d/"]);
  const wrongDefault = runWithGlobals('say toRegex("(", default: value)\nexit', { value: "x" });
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

test("findAll gives every match in order, also empty ones one character apart", () => {
  assert.deepEqual(
    said(
      'say "1980-2026-10-14".findAll(/\\d+/)',
      'say "Ab aB".findAll(/ab/i)\nsay "abc".findAll(/x/)',
      // An empty match counts, also right after a match, and the next search starts one character later.
      'say "ab".findAll(/x*/)\nsay "a".findAll(/a*/)\nsay "".findAll(/x*/)',
      // Characters are code points, also between the halves of an emoji's surrogate pair.
      'say "😀a😀".findAll(/./)\nsay "😀😀".findAll(/x*/)',
      // Groups do not change the result, and `^` with `m` matches at each line.
      'say "a=1\\nb=2".findAll(/^(\\w)=/m)',
    ),
    [
      '["1980", "2026", "10", "14"]',
      '["Ab", "aB"]',
      "[]",
      '["", "", ""]',
      '["a", ""]',
      '[""]',
      '["😀", "a", "😀"]',
      '["", "", ""]',
      '["a=", "b="]',
    ],
  );
});

test("split by a regex keeps the parts between separators and never inserts groups", () => {
  assert.deepEqual(
    said(
      'say "a, b;c".split(/[,;]\\s*/)\nsay "a,b,".split(/(,)/)\nsay ",a".split(/,/)',
      'say "abc".split(/x/)\nsay "".split(/,/)',
      // A separator that matches no text separates nothing at either end, right after another separator, or in
      // empty text.
      'say "ab".split(/x*/)\nsay "a  b".split(/ */)\nsay "".split(/x*/)\nsay "😀a".split(/x*/)',
    ),
    [
      '["a", "b", "c"]',
      '["a", "b", ""]',
      '["", "a"]',
      '["abc"]',
      '[""]',
      '["a", "b"]',
      '["a", "b"]',
      "[]",
      '["😀", "a"]',
    ],
  );
});

test("replace with a regex replaces every match, and $0, $1, $<name>, and $$ insert the match, a group, and $", () => {
  assert.deepEqual(
    said(
      'say "2026-10-14".replace(/(\\d+)-(\\d+)-(\\d+)/, "$3.$2.$1")',
      'say "Ann Lee".replace(/(?<first>\\w+) (?<last>\\w+)/, "$<last>, $<first>")',
      'say "5 USD".replace(/(\\d+) USD/, "$$$1")\nsay "a1".replace(/\\d/, "[$0]")',
      // A group that did not take part inserts nothing, and every digit after `$` counts.
      'say "ab".replace(/(x)?b/, "<$1>")',
      'say "abcdefghijk".replace(/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)/, "$10$01$11")',
      // Any other `$` is text, and so is an unclosed `$<`.
      'say "ab".replace(/b/, "$x $ $<y")',
      // Interpolation comes first, and a text search replaces literally.
      'let suffix = "!"\nsay "Ann".replace(/(?<n>\\w+)/, "$<n>${suffix}")\nsay "a$1".replace("a", "$1")',
      // Empty matches are replaced too, one character apart.
      'say "ab".replace(/x*/, "-")\nsay "a".replace(/a*/, "-")\nsay "😀".replace(/x*/, "-")',
      // RE2 keeps the name of a group that a repeat of zero times precedes.
      'say "b".replace(/(a){0}(?<v>b)/, "<$<v>$2>")',
    ),
    [
      "14.10.2026",
      "Lee, Ann",
      "$5",
      "a[1]",
      "a<>",
      "jak",
      "a$x $ $<y",
      "Ann!",
      "$1$1",
      "-a-b-",
      "--",
      "-😀-",
      "<bb>",
    ],
  );
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
    assert.equal(runtime.snapshot.failure?.code, "TSR057", source);
    assert.match(
      runtime.snapshot.failure!.message,
      /^'\$[12]' in the replacement refers to group/u,
    );
  }
});

test("lastIndexOf with a regex gives the start of the last match, as findAll finds them", () => {
  assert.deepEqual(
    said(
      'say "2026-10-14".lastIndexOf(/\\d+/)\nsay "abc".lastIndexOf(/x/)\nsay "abc".lastIndexOf(/x*/)',
      // Matches do not overlap, unlike the occurrences of text.
      'say "${"ababa".lastIndexOf(/aba/)} ${"ababa".lastIndexOf("aba")}"',
      'say "😀a😀b".lastIndexOf(/\\p{So}/)',
    ),
    ["8", "null", "3", "0 2", "2"],
  );
});

test("count with a regex gives the number of matches findAll finds", () => {
  assert.deepEqual(
    said(
      'say "${"1980-2026-10-14".count(/\\d+/)} ${"Ab aB".count(/ab/i)} ${"abc".count(/x/)}"',
      // An empty match counts, also right after a match, as for findAll.
      'say "${"ab".count(/x*/)} ${"a".count(/a*/)} ${"".count(/x*/)} ${"😀😀".count(/x*/)}"',
      // Matches do not overlap, as the text form counts occurrences.
      'say "${"aaaa".count(/aa/)} ${"aaaa".count("aa")} ${"ababa".count(/aba/)}"',
    ),
    ["4 2 0", "3 2 1 3", "2 2 1"],
  );
});

test("the regex operations check their arguments", () => {
  assert.deepEqual(diagnostics('let all = "a".findAll("a")\nexit'), [
    [
      "TSV043",
      "findAll() needs a regex for 'pattern', not text (string). Write a regex such as /[0-9]+/, or make one from text with toRegex(text, default: ...).",
      '"a"',
    ],
  ]);
  assert.equal(
    firstDiagnostic('let t = "a".replace("", "b")\nexit')?.[1],
    "replace() needs non-empty text for 'search'.",
  );
  assert.equal(
    firstDiagnostic('let at = "a".lastIndexOf(4)\nexit')?.[1],
    "lastIndexOf() needs text (string) or a regex for 'part', not a whole number (integer). Convert it with toString(...).",
  );
  // A regex that matches empty text is a valid search.
  assert.deepEqual(diagnostics('let t = "a".replace(/x*/, "")\nexit'), []);
  const runtime = runWithGlobals('let all = "a,b".split(separator)\nexit', { separator: 4 });
  assert.equal(runtime.snapshot.failure?.code, "TSR057");
  assert.equal(
    runtime.snapshot.failure?.message,
    "split() needs text (string) or a regex for 'separator', not a whole number (integer). Convert it with toString(...).",
  );
});

/** The outcome of `say expression` when regex operations may use at most `limit` units of work. */
function sayWithin(limit: number, expression: string): string {
  return withRegexWorkLimit(limit, () => {
    const result = runValidSource(`say ${expression}\nexit`);
    if (result.snapshot.failure === null) return sayTexts(result).join("\n");
    assert.deepEqual(sayTexts(result), [], expression);
    return `${result.snapshot.failure.code} ${result.snapshot.failure.message}`;
  });
}

const TOO_MUCH_WORK =
  "TSR087 This regex needed too much work for this text. Use a simpler pattern or a shorter text.";

test("every regex operation stops at its work limit, at the same count each time", () => {
  // The exact counts are a regression oracle of the current unit metric (docs/RESOURCE-LIMITS.md), which makes a limit
  // stop the same operation at the same point on every host; an intended change of the metric updates them.
  const cases: [string, string, number][] = [
    ['"a1b22".matches(/[a-z0-9]+/)', "true", 131],
    ['"a1b22".contains(/2/)', "true", 48],
    ['"a1b22".find(/\\d+/)', "1", 92],
    ['"a1b22".capture(/(\\d)(\\d)?/)', '["1", "1", null]', 353],
    ['"a1b22".indexOf(/\\d\\d/)', "3", 133],
    ['"a1b22".findAll(/\\d+/)', '["1", "22"]', 200],
    ['"😀a😀".findAll(/x*/)', '["", "", "", ""]', 170],
    ['"a1b22".split(/\\d/)', '["a", "b", "", ""]', 183],
    ['"a1b22".replace(/(\\d)/, "<$1>")', "a<1>b<2><2>", 459],
    ['"a1b22".lastIndexOf(/\\d+/)', "3", 195],
    ['"a1b22".count(/\\d+/)', "2", 195],
  ];
  for (const [expression, said, units] of cases) {
    assert.equal(sayWithin(units, expression), said, expression);
    assert.equal(sayWithin(units - 1, expression), TOO_MUCH_WORK, expression);
    // A search stopped in the middle leaves nothing behind that changes the next count.
    assert.equal(sayWithin(units, expression), said, expression);
  }
});

test("the work limit stops repeated searches, long texts, and large results", () => {
  // Each search for `a.*b` reads the rest of the text: 200 characters pass, and 2,000 need too much work.
  assert.equal(sayWithin(MAX_REGEX_WORK, '"a".repeat(200).findAll(/a.*b|a/).length'), "200");
  assert.equal(
    sayWithin(MAX_REGEX_WORK, '"a".repeat(2000).findAll(/a.*b|a/).length'),
    TOO_MUCH_WORK,
  );
  assert.equal(sayWithin(MAX_REGEX_WORK, '"a".repeat(200).count(/a.*b|a/)'), "200");
  assert.equal(sayWithin(MAX_REGEX_WORK, '"a".repeat(2000).count(/a.*b|a/)'), TOO_MUCH_WORK);
  // Single searches count too.
  assert.equal(sayWithin(MAX_REGEX_WORK, '"a".repeat(1000000).contains(/x/)'), TOO_MUCH_WORK);
  // What a replace builds counts, so a few matches cannot make a huge text.
  assert.equal(
    sayWithin(MAX_REGEX_WORK, '"ab".replace(/./, "x".repeat(2600000)).length'),
    TOO_MUCH_WORK,
  );
  assert.equal(
    sayWithin(MAX_REGEX_WORK, '"ab".replace("a", "x".repeat(2600000)).length'),
    "2600001",
  );
});

test("a search through a long chain of lazy repeats stops at a fixed depth, not at the host's stack limit", () => {
  // Each `a??` nests one more call of re2js's NFA as it adds the states after it: 499 of them and the start fit.
  assert.equal(sayWithin(MAX_REGEX_WORK, '"zz".contains(/(?:a??){499}/)'), "true");
  for (const method of ["contains", "matches", "find", "capture", "indexOf", "findAll"])
    assert.equal(
      sayWithin(MAX_REGEX_WORK, `"zz".${method}(/(?:a??){500}/)`),
      TOO_MUCH_WORK,
      method,
    );
  // Ten times as deep passes the stack limit of V8 hosts, and stops the same way.
  assert.equal(
    sayWithin(MAX_REGEX_WORK, '"zz".contains(/(?:a??b??c??d??e??){999}/)'),
    TOO_MUCH_WORK,
  );
});

test("a run that needed too much regex work fails the same way when it is restored or replayed", () => {
  withRegexWorkLimit(400, () => {
    const source = [
      'let words = "a1 b2 c3"',
      "wait 1 s",
      "say words.findAll(/\\d/)",
      "say words.split(/ /)",
      'let all = words.replace(/(\\w)(\\d)/, "$2$1")',
      "say all",
      "exit",
    ].join("\n");
    const result = assertRuntimeResumeEquivalent(source, { ending: "failed" });
    assert.deepEqual(
      result.events.filter((event) => event.kind === "say").map((event) => event.text),
      ['["1", "2", "3"]', '["a1", "b2", "c3"]'],
    );
    const failure = result.finalSnapshot.failure;
    assert.deepEqual([failure?.code, failure?.message], TOO_MUCH_WORK.split(/(?<=^\S+) /u));
    // The replace, on the fifth line, counted from 0.
    assert.equal(failure?.span.start.line, 4);
    // The failed session restores from its checkpoint as it was.
    const plan = compileValidPlan(source);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, result.finalSnapshot)),
    );
    assert.deepEqual(restored.snapshot.failure, failure);
  });
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
      "TSV064",
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
      "$.items[0] contains a regex that cannot be used: This regex is too large: with its repeats written out it has about 11,002 steps, and a regex may have at most 10,000. Use smaller or fewer repeat counts such as '{100}'.",
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

test("\\d, \\w, and \\s match ASCII characters, and Unicode properties match every script", () => {
  assert.deepEqual(
    said(
      'say "${"٣".matches(/\\d/)} ${"é".matches(/\\w/)} ${"\u00a0".matches(/\\s/)} ${"٣".matches(/\\p{Nd}/)} ${"é".matches(/\\p{L}/)}"',
    ),
    ["false false false true true"],
  );
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

test("searching and compiling leave the case methods the host had, and never ask the host for a character's case", () => {
  const lower = String.prototype.toLowerCase;
  const upper = String.prototype.toUpperCase;
  let hostCalls = 0;
  // Methods a page may have installed before: each counts the single characters from U+0080 on it is asked about.
  const counting = (native: () => string) =>
    function (this: string): string {
      const text = `${this}`;
      if (text.codePointAt(0)! >= 0x80 && [...text].length === 1) hostCalls += 1;
      return native.call(text);
    };
  const installedLower = counting(lower);
  const installedUpper = counting(upper);
  String.prototype.toLowerCase = installedLower;
  String.prototype.toUpperCase = installedUpper;
  try {
    // Fresh patterns, which compile now: ignoring case, a class of two characters, and one RE2 rejects.
    const result = runValidSource(
      'say "${"Ꞩ".matches(/ꞩ/i)} ${"☃".matches(/[☁☃]/)} ${toRegex("(?i)(ɥ", default: null)}"\nexit',
    );
    assert.deepEqual(sayTexts(result), ["true true null"]);
    assert.equal(String.prototype.toLowerCase, installedLower);
    assert.equal(String.prototype.toUpperCase, installedUpper);
    assert.equal(hostCalls, 0);
  } finally {
    String.prototype.toLowerCase = lower;
    String.prototype.toUpperCase = upper;
  }
});
