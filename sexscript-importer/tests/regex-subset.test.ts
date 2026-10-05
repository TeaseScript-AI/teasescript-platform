import assert from "node:assert/strict";
import test from "node:test";
import { javaReplacementText, parseRegexSubset, parseTailPattern } from "../src/regex-subset.ts";

test("the regular expressions that text operations express are recognized", () => {
  assert.deepEqual(parseRegexSubset("BOSS"), { kind: "literal", text: "BOSS" });
  assert.deepEqual(parseRegexSubset("\\\\"), { kind: "literal", text: "\\" });
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
  assert.deepEqual(parseTailPattern(".*\\d+\\.jpg"), {
    insensitive: false,
    digits: true,
    tail: ".jpg",
  });
  assert.deepEqual(parseTailPattern("(?i).*\\.png"), {
    insensitive: true,
    digits: false,
    tail: ".png",
  });
  assert.equal(parseTailPattern("Domme(\\d+).jpg"), null);
  assert.equal(parseTailPattern(".*"), null);
});
