import assert from "node:assert/strict";
import test from "node:test";
import { MAX_REGEX_WORK, withRegexWorkLimit } from "../../src/regex-engine.js";
import { MAX_REGEX_GROUPS } from "../../src/regex.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../src/runtime/snapshot/checkpoint.js";
import { run } from "../../src/runtime/engine.js";
import {
  validateSerializableValue,
  type SerializableRuntimeValue,
} from "../../src/runtime/values/serializable-values.js";
import { compileValidPlan } from "../helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "../helpers/runtime-equivalence.js";
import { sayTexts } from "../helpers/runtime-events.js";
import { runValidSource } from "../helpers/run-valid-source.js";
import { said, runWithGlobals } from "../helpers/runtime/regex-host.js";

/*
 * Regexes (V30 §8): the literal, the `regex` value, `toRegex`, the searches `matches`, `contains`, `find`, `capture`,
 * `indexOf`, `findAll`, `count`, and `lastIndexOf`, `split` and `replace` with a regex, and the work limit of each
 * operation, from source through the runtime, checkpoints, and storage.
 */

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

test("\\d, \\w, and \\s match ASCII characters, and Unicode properties match every script", () => {
  assert.deepEqual(
    said(
      'say "${"٣".matches(/\\d/)} ${"é".matches(/\\w/)} ${"\u00a0".matches(/\\s/)} ${"٣".matches(/\\p{Nd}/)} ${"é".matches(/\\p{L}/)}"',
    ),
    ["false false false true true"],
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
