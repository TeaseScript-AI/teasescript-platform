// Operands and members: what an operator, a condition, a property or a method takes, a message handle's text, and an
// unknown function's TSV018 for say unskippable(...).

import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../../../src/compiler.js";
import { mismatches, codes, sayTexts } from "../../helpers/type-core/type-enforcement-setup.js";

test("an optional operand and a parenthesized method keep their checks", () => {
  assert.deepEqual(
    mismatches(
      'function maybeText: string? {\n    return "x"\n}\nlet count = 1\nlet text = maybeText()\ncount += text\nexit',
    ),
    [
      [
        "TSV041",
        "'count' holds a whole number (integer), so text (string) or null cannot be added to it. Use a number instead.",
        "text",
      ],
    ],
  );
  assert.deepEqual(mismatches('let items = [1]\n(items.add)("x")\nexit'), [
    [
      "TSV041",
      "'items' holds integer values (integer[]), so it cannot contain text (string). To allow both, declare it as 'let items: (integer | string)[] = ...'.",
      '"x"',
    ],
  ]);
  assert.deepEqual(mismatches('let tags = set["a"]\n(tags.add)(1)\nexit')[0]?.[0], "TSV041");
  assert.deepEqual(mismatches("let count = 1\nlet extra: integer? = 2\ncount += extra\nexit"), []);
});

test("a set compares its members with ==, and only objects and handles take properties", () => {
  // A set compares any value, and checks a value the compiler cannot know when the script runs.
  assert.deepEqual(
    sayTexts(
      'let s = set[1, null]\ns.add(2)\nsay "${s.contains("x")}"\ns.remove(null)\nsay s\nexit',
    ),
    ["false", "[1, 2]"],
  );
  for (const source of [
    "let n = 1\nn.value = true\nexit",
    "let xs = [1]\nxs.length = 2\nexit",
    "let xs = [1]\nxs.first = 2\nexit",
  ])
    assert.deepEqual(
      codes(source).map(([code]) => code),
      ["TSV043"],
      source,
    );
  assert.deepEqual(mismatches("let xs = [1]\nxs.length = 2\nexit"), [
    [
      "TSV043",
      "Only objects, speakers, and timer, media, and message handles have properties to assign, but this is a list (integer[]).",
      "xs",
    ],
  ]);
  assert.deepEqual(sayTexts("let o = { value: 1 }\no.value = 2\nsay o\nexit"), ["{ value: 2 }"]);
  // A value known to be null has no members, and a conversion goes only from a list to a set or back.
  for (const [source, text] of [
    ["function nothing {\n    return null\n}\nnothing().value = true\nexit", "nothing()"],
    ["let s = set[]\ns.add(1).value = true\nexit", "s.add(1)"],
    ["function nothing {\n    return null\n}\nsay nothing().value\nexit", "value"],
    ["function nothing {\n    return null\n}\nnothing().clear()\nexit", "clear"],
    ["let s = set[1]\nlet converted = s.toSet()\nexit", "toSet"],
    ["let xs = [1]\nlet converted = xs.toList()\nexit", "toList"],
  ] as const)
    assert.deepEqual(codes(source), [["TSV043", text]], source);
  assert.deepEqual(sayTexts("let xs = [1, 1, 2]\nsay xs.toSet().toList()\nexit"), ["[1, 2]"]);
  assert.deepEqual(sayTexts("let o = null\no = { value: 1 }\no.value = 2\nsay o\nexit"), [
    "{ value: 2 }",
  ]);
});

test("conditions and logical operands are true or false, and operators get values they support", () => {
  assert.deepEqual(mismatches("let count = 3\nwhile count {\n    count -= 1\n}\nexit"), [
    [
      "TSV043",
      "A condition must be true or false (boolean), but this is a whole number (integer). Compare it instead, such as 'count > 0'.",
      "count",
    ],
  ]);
  assert.deepEqual(
    codes(
      'let names = ["a"]\nif names {\n    say "x"\n}\nlet ok = not 1\nlet both = true and "x"\nexit',
    ),
    [
      ["TSV043", "names"],
      ["TSV043", "1"],
      ["TSV043", '"x"'],
    ],
  );
  assert.deepEqual(
    codes(
      'let r = 1..3\nlet q = r + 1\nlet less = "a" < 1\nlet x = 5\nsay x.length\nlet items = [1]\nitems.noSuchMethod()\nsay items[1.5]\nexit',
    ),
    [
      ["TSV043", "r + 1"],
      ["TSV043", '"a" < 1'],
      ["TSV043", "length"],
      ["TSV043", "noSuchMethod"],
      ["TSV043", "1.5"],
    ],
  );
  assert.deepEqual(codes('let t = timer async 5 s\nsave t as "k"\nlet c = chance("x")\nexit'), [
    ["TSV043", "t"],
    ["TSV043", '"x"'],
  ]);
  // Equality compares values of any kinds, and text compares with text. Values of different types are never equal, so
  // such a comparison only warns (ADR 0021 rule 4.5).
  assert.deepEqual(
    codes('let same = 1 == "1"\nlet before = "a" < "b"\nlet longer = 2 s > 1 s\nexit'),
    [["TSV046", '1 == "1"']],
  );
});

test("timer ranges and handle members are checked by type, wherever the value comes from", () => {
  assert.deepEqual(codes("let span = 1..=3\nlet t = timer async span s\nexit"), []);
  assert.deepEqual(
    mismatches(
      "function make {\n    return timer async 1 s\n}\nlet t = make()\nt.nope()\nt.elapsed = 1 s\nsay t.colour\nexit",
    ).map(([code, message, text]) => [code, text, message]),
    [
      ["TSV034", "nope", "Timer handles have no method 'nope'. Use pause(), resume(), or stop()."],
      [
        "TSV034",
        "elapsed",
        "Timer handle property 'elapsed' cannot be assigned. You can assign remaining, display, or repeatDuration.",
      ],
      ["TSV034", "colour", "Timer handles have no property 'colour'."],
    ],
  );
});

test("a message handle has one text property, takes text, and stays out of text, storage, and start values", () => {
  const codes = (source: string) =>
    mismatches(`let line = say "Waiting", instant\n${source}\nexit`).map(([code, message]) => [
      code,
      message,
    ]);
  assert.deepEqual(
    codes('let shown: string = line.text\nline.text = "Ready"\nline.text += "."'),
    [],
  );
  assert.deepEqual(codes("line.text = 5"), [
    [
      "TSV041",
      "'line.text' holds text (string), so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
    ],
  ]);
  assert.deepEqual(codes('line.text -= "."'), [
    ["TSV041", "'line.text' holds text (string), so text (string) cannot be subtracted from it."],
  ]);
  for (const [source, message] of [
    [
      'line.color = "red"',
      "Message handle property 'color' cannot be assigned. You can assign text.",
    ] as const,
    ["say line.speaker", "Message handles have no property 'speaker'. Use the text property."],
    [
      "line.stop()",
      "Message handles have no method 'stop'. Use remove(), or change the message with its text property.",
    ],
  ] as const)
    assert.deepEqual(codes(source), [["TSV043", message]], source);
  assert.equal(codes('say "${line}"')[0]?.[0], "TSV042");
  assert.equal(codes("say toString(line)")[0]?.[0], "TSV043");
  assert.match(
    codes('save [line] as "k"')[0]?.[1] ?? "",
    /save cannot store this list: it holds a message handle.*text property/u,
  );
  assert.deepEqual(codes('save line.text as "status"'), []);
  assert.equal(codes('let other: string = say "x"')[0]?.[0], "TSV041");
  // `message` stays an ordinary name; `messageHandle` is the type's.
  assert.deepEqual(mismatches("let message = 1\nsay message\nexit"), []);
  assert.equal(mismatches("let messageHandle = 1\nexit")[0]?.[0], "TSV001");
  // Showing a message is an effect that start values and parameter defaults cannot have.
  assert.equal(mismatches('global greeting = say "Hi"\nexit')[0]?.[0], "TSV055");
  assert.equal(mismatches('speaker vera {\n    displayName: say "Hi"\n}\nexit')[0]?.[0], "TSV055");
  assert.equal(mismatches('function f(m = say "Hi") {\n}\nexit')[0]?.[0], "TSV032");
  // A handle that may be null is checked first, and a nullable global can take one later.
  assert.match(
    mismatches('function f(m: messageHandle?) {\n    m.text = "z"\n}\nexit')[0]?.[1] ?? "",
    /must be checked for null before it is used here/u,
  );
  assert.deepEqual(
    mismatches(
      'global status: messageHandle? = null\nstatus = say "Ready", instant\nif status != null {\n    status.text = "Set"\n}\nexit',
    ).filter(([code]) => code !== "TSV046"),
    [],
  );
});

test("a say statement that calls skippable or unskippable names the forms that show the text", () => {
  assert.deepEqual(mismatches('say unskippable("Hi")\nexit'), [
    [
      "TSV018",
      "Unknown function 'unskippable'. To say a message unskippable, write its text without parentheses, as in 'say unskippable \"Hi\"'. Only a say used as a value, such as 'let line = say unskippable (\"Hi\", instant)', takes its text in parentheses.",
      "unskippable",
    ],
  ]);
  // A function of that name keeps being called, as before, also one the host provides.
  assert.deepEqual(
    mismatches('function unskippable(text) {\n    return text\n}\nsay unskippable("Hi")\nexit'),
    [],
  );
  for (const name of ["skippable", "unskippable"])
    assert.deepEqual(
      compileSource(`say ${name}("Hi"), instant\nexit`, { builtins: [name] }).diagnostics,
      [],
    );
  // The call is checked as any other.
  assert.deepEqual(
    mismatches("say unskippable(a: 1, a: 2)\nexit").map(([code]) => code),
    ["TSV023", "TSV018"],
  );
});
