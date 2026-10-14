import assert from "node:assert/strict";
import test from "node:test";
import { javaRegex } from "../src/java-regex.ts";
import { javaReplacementText, parseRegexSubset, parseTailPattern } from "../src/regex-subset.ts";

test("the regular expressions that text operations express are recognized", () => {
  assert.deepEqual(parseRegexSubset("BOSS"), { kind: "literal", text: "BOSS" });
  assert.deepEqual(parseRegexSubset("\\\\"), { kind: "literal", text: "\\" });
  // Java escapes any character but a letter or digit as itself.
  assert.deepEqual(parseRegexSubset("\\#BODYPART"), { kind: "literal", text: "#BODYPART" });
  assert.deepEqual(parseRegexSubset("\\[|\\]"), { kind: "alternatives", texts: ["[", "]"] });
  assert.deepEqual(parseRegexSubset("[^0-9X]"), {
    kind: "class",
    chars: "0123456789X",
    negated: true,
    runs: false,
  });
  assert.deepEqual(parseRegexSubset("[,\\|]"), {
    kind: "class",
    chars: ",|",
    negated: false,
    runs: false,
  });
  assert.deepEqual(parseRegexSubset("\\W+"), {
    kind: "class",
    chars: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_",
    negated: true,
    runs: true,
  });
  for (const pattern of ["(?i)Domme", "a.c", "^x", "([A-Z]+)\\(.*?\\)", "[a", "x*"])
    assert.equal(parseRegexSubset(pattern), null, pattern);
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
  assert.deepEqual(javaRegex(".{1,50}@x/y", "whole"), { pattern: `${dot}{1,50}@x\\/y`, flags: "" });
  assert.deepEqual(javaRegex("(?s)a.b", "whole"), { pattern: "a.b", flags: "s" });
  assert.deepEqual(javaRegex("(?si)\\.png", "whole"), { pattern: "\\.png", flags: "is" });
  assert.deepEqual(javaRegex("[\\s,]\\S", "whole"), {
    pattern: String.raw`[\t\n\x0B\f\r ,][^\t\n\x0B\f\r ]`,
    flags: "",
  });
  assert.deepEqual(javaRegex("b$", "whole"), { pattern: "b$", flags: "" });
  assert.deepEqual(javaRegex("b$", "find"), {
    pattern: String.raw`b(?:\r\n|[\n\r\x{85}\x{2028}\x{2029}])?$`,
    flags: "",
  });
  for (const [pattern, reason] of [
    ["(a)\\1", "a backreference"],
    ["a(?=b)", "a lookaround, an atomic group, or a mode inside the pattern"],
    ["a(?i)b", "a lookaround, an atomic group, or a mode inside the pattern"],
    ["(?i)ok", "a letter that RE2 matches with other characters when it ignores case"],
    ["(?i)[a-c]", "a letter that RE2 matches with other characters when it ignores case"],
    ["\\bword", "a word boundary"],
    ["a++", "a possessive quantifier"],
    ["\\p{Lu}", "the escape \\p"],
    ["[a-z&&[^b]]", "a class intersection"],
    ["[a[b]]", "a nested class"],
    ["a$|b", "$ before the end of the pattern"],
    ["a{1001}", "a repetition over 1000"],
  ])
    assert.deepEqual(javaRegex(pattern!, "find"), { reason }, pattern);
});
