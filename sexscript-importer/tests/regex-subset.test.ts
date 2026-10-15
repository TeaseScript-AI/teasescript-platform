import assert from "node:assert/strict";
import test from "node:test";
import { javaRegex, javaReplacement } from "../src/java-regex.ts";
import { javaReplacementText, literalPattern, parseTailPattern } from "../src/regex-subset.ts";

test("legacy regular expressions of literal text are searched as text", () => {
  assert.equal(literalPattern("BOSS"), "BOSS");
  assert.equal(literalPattern("\\\\"), "\\");
  assert.equal(literalPattern("\\|"), "|");
  for (const pattern of ["", "\\[|\\]", "[^0-9X]", "\\W+", "(?i)Domme", "a.c", "x*"])
    assert.equal(literalPattern(pattern), null, pattern);
});

test("Java replacement texts are plain text unless they name a group", () => {
  assert.equal(javaReplacementText("a\\$b\\\\c"), "a$b\\c");
  assert.equal(javaReplacementText("$1"), null);
});

test("patterns that a whole text matches by its end", () => {
  assert.deepEqual(parseTailPattern(".*\\.jpg"), { insensitive: false, tail: ".jpg" });
  assert.deepEqual(parseTailPattern("(?i).*\\.png"), { insensitive: true, tail: ".png" });
  // Digits before the end are a regex (java-regex.ts).
  assert.equal(parseTailPattern(".*\\d+\\.jpg"), null);
  assert.equal(parseTailPattern("Domme(\\d+).jpg"), null);
  assert.equal(parseTailPattern(".*"), null);
});

// Java's `.` stops at each of its line terminators, its `\s` holds the vertical tab, its `$` also matched before a
// final line terminator, which a test of a match anywhere may take into the match, and it ignored the case of ASCII
// letters only; features RE2 leaves out, or whose meaning differs, say why they do not convert (tests/fixtures/groovy-oracle/legacy-regex.groovy runs the converted ones).
test("Java regular expressions as RE2 patterns", () => {
  const dot = String.raw`[^\n\r\x{85}\x{2028}\x{2029}]`;
  const converts = (
    pattern: string,
    within: "whole" | "find" | "all",
    expected: string,
    flags = "",
  ): void => {
    const regex = javaRegex(pattern, within);
    assert.deepEqual(
      "reason" in regex ? regex : { pattern: regex.pattern, flags: regex.flags },
      { pattern: expected, flags },
      pattern,
    );
  };
  converts(".{1,50}@x/y", "whole", `${dot}{1,50}@x\\/y`);
  converts("(?s)a.b", "whole", "a.b", "s");
  converts("(?si)\\.png", "whole", "\\.png", "is");
  converts("[\\s,]\\S", "whole", String.raw`[\t\n\x0B\f\r ,][^\t\n\x0B\f\r ]`);
  // RE2 reads no leading zero in a count and has no empty literal.
  converts("a{01,002}", "whole", "a{1,2}");
  converts("", "whole", "(?:)");
  converts("b$", "whole", "b$");
  converts("b$", "find", String.raw`b(?:\r\n|[\n\r\x{85}\x{2028}\x{2029}])?$`);
  converts("^\\s*$", "find", String.raw`^[\t\n\x0B\f\r ]*(?:\r\n|[\n\r\x{85}\x{2028}\x{2029}])?$`);
  converts("([\\w]\\s*)[\\(|{]", "all", String.raw`([\w][\t\n\x0B\f\r ]*)[\(\|\{]`);
  for (const [pattern, reason] of [
    ["(a)\\1", "a backreference"],
    ["a(?=b)", "a lookaround, a named or atomic group, or a mode inside the pattern"],
    ["a(?i)b", "a lookaround, a named or atomic group, or a mode inside the pattern"],
    ["(?i)ok", "a letter that RE2 matches with other characters when it ignores case"],
    ["(?i)[a-c]", "a letter that RE2 matches with other characters when it ignores case"],
    ["\\bword", "a word boundary"],
    ["a++", "a possessive quantifier"],
    ["\\p{Lu}", "the escape \\p"],
    ["\\uD83D\\uDE00", "the escape \\u"],
    ["[a-z&&[^b]]", "a class intersection"],
    ["[a[b]]", "a nested class"],
    ["[\\s-a]", "a - between a class and another member"],
    ["a$|b", "$ before the end of the pattern"],
    ["\\r$", "$ after a part that may end with a carriage return"],
    ["a{1001}", "a repetition over 1000 or with its bounds reversed"],
    ["(a{100}){11}", "a counted repetition of a group or of nothing"],
    ["[a-", "an unclosed class"],
    ["a{600}b{600}", "counted repetitions of more than 1000 copies"],
    ["(a)".repeat(101), "more than 100 groups"],
    ["a".repeat(1001), "a pattern longer than 1000 characters"],
    [".".repeat(35), "a regex longer than 1000 characters once converted"],
  ])
    assert.deepEqual(javaRegex(pattern!, "find"), { reason }, pattern);
});

// A regex whose matches are used (replaceAll(), split()) takes no `$`, which Java also matched before a final line
// terminator; it tells its groups, which a replacement names, and whether it can match no text, which split() rejects.
test("Java regular expressions whose every match is used", () => {
  assert.deepEqual(javaRegex('^"|"$', "all"), {
    reason:
      "$, which Java also matched before a line terminator at the end, where the match is used",
  });
  // Java filled the groups of a repeated group that can match no text otherwise than RE2.
  for (const pattern of ["(a*)*b", "(?:(a)?)+", "(a|)?"])
    assert.deepEqual(
      javaRegex(pattern, "all"),
      {
        reason:
          "a repeated group that can match no text and holds a group, which Java filled otherwise",
      },
      pattern,
    );
  assert.equal("reason" in javaRegex("(?:a*)*b", "all"), false);
  const shape = (pattern: string): { groups: number; empty: boolean } | { reason: string } => {
    const regex = javaRegex(pattern, "all");
    return "reason" in regex ? regex : { groups: regex.groups, empty: regex.empty };
  };
  assert.deepEqual(shape("a"), { groups: 0, empty: false });
  assert.deepEqual(shape("(a)(?:b)(c)?"), { groups: 2, empty: false });
  const empty = (pattern: string): boolean | string => {
    const regex = javaRegex(pattern, "all");
    return "reason" in regex ? regex.reason : regex.empty;
  };
  for (const pattern of ["", "a*", "a?", "a{0,3}", "(a|)", "a|b*", "(?:ab)*", "^", "(a*)(b?)"])
    assert.equal(empty(pattern), true, pattern);
  for (const pattern of ["a+", "(a|b)", "a*b", "(a*)b|c", "[,]\\s*", "a{1,3}"])
    assert.equal(empty(pattern), false, pattern);
});

// Java read `$n` as the first digit and each next one while the number stays a group, `\x` as x; a group the regex
// lacks, `$` without a number, a named group, a trailing backslash, and a digit after a group, also an escaped one,
// which TeaseScript would join to the group's number, failed or do not convert.
test("Java replacements as TeaseScript regex replacements", () => {
  assert.equal(javaReplacement("$1[", 1), "$1[");
  assert.equal(javaReplacement("\\$x\\\\", 0), "$$x\\");
  assert.equal(javaReplacement("$0-$12", 12), "$0-$12");
  assert.equal(javaReplacement("$2$1", 2), "$2$1");
  for (const [text, groups] of [
    ["$2", 1],
    ["$12", 1],
    ["$", 1],
    ["${name}", 1],
    ["a\\", 0],
    ["$x", 1],
    ["$1\\2", 1],
  ] as const)
    assert.equal(javaReplacement(text, groups), null, text);
});
