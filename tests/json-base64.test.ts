import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { createSourcePosition, createSourceSpan } from "../src/source.js";
import { valueFromJson } from "../src/runtime/json-base64.js";
import type { SerializableRuntimeValue } from "../src/runtime/serializable-values.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot-validation.js";

/** Runs `source`, which must not fail, and gives the variables it left. */
function variables(source: string): Map<string, SerializableRuntimeValue> {
  const result = runValidSource(`${source}\nexit`);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return new Map(
    result.snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
  );
}

/** The runtime failure of `source`, which compiles. */
function failure(source: string): { code: string; message: string } {
  const failed = runValidSource(`${source}\nexit`).snapshot.failure;
  assert.notEqual(failed, null, source);
  return { code: failed!.code, message: failed!.message };
}

function diagnostics(source: string): [string, string][] {
  return compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
  ]);
}

/** A source text literal of `text`, which needs no escape but those of JSON that a source text has too. */
function literal(text: string): string {
  const written = JSON.stringify(text);
  // An escape that JSON has and a source text has not: a backslash that no other backslash escapes, then b, f, or u.
  assert.ok(!/(?<!\\)(?:\\\\)*\\[bfu]|\$\{/u.test(written), written);
  return written;
}

const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});
const dict = (...entries: [string, SerializableRuntimeValue][]): SerializableRuntimeValue => ({
  kind: "dict",
  entries: entries.map(([key, value]) => ({ key, value })),
});

test("toJson writes each kind of value as compact JSON, in key and set order", () => {
  const written = variables(
    [
      "speaker vera {",
      '  displayName: "Vera"',
      "  mood: 3",
      "}",
      `let text = toJson(${literal('a "quoted"\\ line\nand ü 😀')})`,
      'let scalars = [toJson(42), toJson(2.5), toJson(-7), toJson(true), toJson(false), toJson(null), toJson("")]',
      'let ordered = toJson(set ["b", "a", "b", "c"])',
      'let keyed = toJson(dict{ "b": 1, "2": 2, "1": 3 })',
      'let record = toJson({ name: "Ann", toys: ["rope", "cuffs"], spare: dict{} })',
      'let dates = [toJson(toDate("2026-10-04")), toJson(toTime("14:30")), toJson(toTime("09:05:30.250")), toJson(toDateTime("2026-10-04T18:00"))]',
      'let moment = toJson(toAbsoluteDateTime("2026-10-04T12:30:00.500+02:00"))',
      "let waited = toJson([90 s, 1 hour, 0 s])",
      "let person = toJson(vera)",
      "let nested = toJson({ team: [vera], who: vera })",
    ].join("\n"),
  );
  assert.deepEqual(Object.fromEntries(written), {
    text: '"a \\"quoted\\"\\\\ line\\nand ü 😀"',
    scalars: list("42", "2.5", "-7", "true", "false", "null", '""'),
    ordered: '["b","a","c"]',
    keyed: '{"b":1,"2":2,"1":3}',
    record: '{"name":"Ann","toys":["rope","cuffs"],"spare":{}}',
    // As `.toISO()` writes them.
    dates: list('"2026-10-04"', '"14:30"', '"09:05:30.250"', '"2026-10-04T18:00"'),
    moment: '"2026-10-04T10:30:00.500Z"',
    waited: "[90000,3600000,0]",
    person: '{"displayName":"Vera","mood":3}',
    nested: '{"team":[{"displayName":"Vera","mood":3}],"who":{"displayName":"Vera","mood":3}}',
  });
});

test("fromJson reads an object as a dict in source order, an array as a list, and a whole number as an integer", () => {
  const read = variables(
    [
      `let value = fromJson(${literal('{"b": [1, 2.5, -0, 1e2, 1.0, "x", true, false, null, {}], "2": "two", "1": "one", "a": {"c": []}}')}, default: null)`,
      'let whole = value is dict and value["2"] == "two"',
      'let big = fromJson("12345678901234567890", default: null)',
      "let bigWhole = big is integer",
      `let escapes = fromJson(${literal('"\\u00fc \\ud83d\\ude00 \\" \\\\ \\/ \\n\\t"')}, default: null)`,
      'let spaced = fromJson(" \\n\\t[ 1 ,\\r\\n 2 ] ", default: null)',
      'let scalar = fromJson("-3.5e-1", default: null)',
      'let nothing = fromJson("null", default: "unused")',
    ].join("\n"),
  );
  assert.deepEqual(
    read.get("value"),
    dict(
      ["b", list(1, 2.5, 0, 100, 1, "x", true, false, null, dict())],
      ["2", "two"],
      ["1", "one"],
      ["a", dict(["c", list()])],
    ),
  );
  assert.equal(read.get("whole"), true);
  // As every number, a large one is the nearest a number can hold; it stays whole.
  assert.equal(read.get("big"), 12345678901234567000);
  assert.equal(read.get("bigWhole"), true);
  assert.equal(read.get("escapes"), 'ü 😀 " \\ / \n\t');
  assert.deepEqual(read.get("spaced"), list(1, 2));
  assert.equal(read.get("scalar"), -0.35);
  // JSON's null is a value, not text that does not read.
  assert.equal(read.get("nothing"), null);
});

test("a repeated key keeps its first position with its last value, and a mixed array mixes its elements", () => {
  const read = variables(
    [
      `let repeated = fromJson(${literal('{"a": 1, "b": 2, "a": 3, "c": 4, "b": [5]}')}, default: null)`,
      `let mixed = fromJson(${literal('[1, "two", [3], {"four": 4}, null, 5.5]')}, default: null)`,
      'let first: string = "${mixed is list}"',
    ].join("\n"),
  );
  assert.deepEqual(read.get("repeated"), dict(["a", 3], ["b", list(5)], ["c", 4]));
  assert.deepEqual(read.get("mixed"), list(1, "two", list(3), dict(["four", 4]), null, 5.5));
  assert.equal(read.get("first"), "true");
});

test("what fromJson reads has no static type: a test narrows it, and a declared type checks it when the script runs", () => {
  const read = variables(
    [
      'let tasks: string[] = fromJson("[\\"stand\\", \\"kneel\\"]", default: [])',
      'let parsed = fromJson("{\\"rounds\\": 3}", default: null)',
      "let rounds = 0",
      "if parsed is integer dict {",
      '  rounds = parsed["rounds"] + 1',
      "}",
      'let kept: string[] = fromJson("not json", default: ["kneel"])',
    ].join("\n"),
  );
  assert.deepEqual(read.get("tasks"), list("stand", "kneel"));
  assert.equal(read.get("rounds"), 4);
  assert.deepEqual(read.get("kept"), list("kneel"));
  assert.equal(
    failure('let tasks: string[] = fromJson("[\\"stand\\", 2]", default: [])').code,
    "TSR058",
  );
});

// Texts that are not JSON (RFC 8259), and numbers too large to represent.
const NOT_JSON = [
  "",
  " ",
  "{",
  "[",
  "]",
  "[1,]",
  "[,1]",
  "{,}",
  '{"a":1,}',
  "{'a': 1}",
  '{"a" 1}',
  '{"a":}',
  "{1: 2}",
  '{"a":1 "b":2}',
  "[1 2]",
  "1 2",
  "01",
  "-01",
  "1.",
  ".5",
  "+1",
  "--1",
  "1e",
  "1e+",
  "0x10",
  "NaN",
  "Infinity",
  "-Infinity",
  "1e400",
  "-1e400",
  "tru",
  "nul",
  "True",
  "nulll",
  "undefined",
  '"open',
  '"\\x"',
  '"\\u12"',
  '"\\u12g4"',
  '"tab\there"',
  '"line\nbreak"',
  '"\\',
  "\uFEFF1",
  "\u00A01",
  "[1]x",
  "// comment\n1",
  "{} {}",
];

test("fromJson gives its default for every text that is not JSON, and for a value that is not text", () => {
  for (const text of NOT_JSON)
    assert.equal(
      variables(`let read = fromJson(${literal(text)}, default: "fallback")`).get("read"),
      "fallback",
      JSON.stringify(text),
    );
  // A value the compiler cannot know may turn out not to be text; reading it gives the default as well.
  const read = variables(
    'function read(value) {\n  return fromJson(value, default: [])\n}\nlet fromNumber = read(5)\nlet nothing = read(null)\nlet listed = read(["[1]"])',
  );
  assert.deepEqual(read.get("fromNumber"), list());
  assert.deepEqual(read.get("nothing"), list());
  assert.deepEqual(read.get("listed"), list());
});

test("fromJson accepts exactly the texts that native JSON accepts, and reads the same values", () => {
  type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };
  const plain = (value: SerializableRuntimeValue): Plain => {
    if (value === null || typeof value !== "object") return value;
    if (value.kind === "list") return value.items.map(plain);
    assert.ok(value.kind === "dict", value.kind);
    return Object.fromEntries(value.entries.map((entry) => [entry.key, plain(entry.value)]));
  };
  const accepted = [
    "0",
    "-0",
    "0.5e-3",
    "1E+2",
    "-12.75E2",
    '"\\u0041\\uD83D\\uDE00"',
    '"\\b\\f\\n\\r\\t"',
    " [ ] ",
    "{ }",
    '{"":0}',
    '{"__proto__": 1, "constructor": 2}',
    '[[[[{"a":[{"b":null}]}]]]]',
    '{"10":1,"9":2,"a":3}',
    "\t\n\r 7 \t\n\r",
  ];
  for (const text of [...NOT_JSON, ...accepted]) {
    let native: unknown;
    let nativeAccepts = true;
    try {
      native = JSON.parse(text);
    } catch {
      nativeAccepts = false;
    }
    // A number too large to represent is valid JSON that no runtime value holds.
    if (typeof native === "number" && !Number.isFinite(native)) nativeAccepts = false;
    const read = valueFromJson(
      text,
      createSourceSpan(createSourcePosition(0, 0, 0), createSourcePosition(0, 0, 0)),
    );
    assert.equal(read !== undefined, nativeAccepts, JSON.stringify(text));
    // Native JSON moves keys that look like whole numbers to the front; written alike, the values are the same.
    if (read !== undefined)
      assert.equal(JSON.stringify(plain(read)), JSON.stringify(native), JSON.stringify(text));
  }
});

test("toBase64 encodes text as UTF-8 in standard Base64 with padding, and fromBase64 reads it back", () => {
  const long = "Stand in the corner. ".repeat(10);
  const encoded = variables(
    [
      'let empty = toBase64("")',
      'let ascii = toBase64("Ma")',
      'let emoji = toBase64("ü 😀")',
      'let slashes = toBase64("ÿÿ")',
      `let long = toBase64(${literal(long)})`,
      'let back = fromBase64(toBase64("ü 😀\\nline"), default: "")',
      'let none = fromBase64("", default: "fallback")',
    ].join("\n"),
  );
  assert.equal(encoded.get("empty"), "");
  assert.equal(encoded.get("ascii"), "TWE=");
  assert.equal(encoded.get("emoji"), "w7wg8J+YgA==");
  assert.equal(encoded.get("slashes"), "w7/Dvw==");
  // No line breaks, however long.
  assert.equal(encoded.get("long"), Buffer.from(long, "utf8").toString("base64"));
  assert.equal(encoded.get("back"), "ü 😀\nline");
  assert.equal(encoded.get("none"), "");

  const read = variables(
    [
      // Spaces and line breaks, as email and Cornertime wrap the text.
      `let wrapped = fromBase64(${literal(" w7wg\r\n8J+Y\tgA== \n")}, default: "")`,
      // The URL alphabet, and missing padding.
      'let url = fromBase64("w7wg8J-YgA", default: "")',
      'let underscore = fromBase64("w7_Dvw", default: "")',
      'let unpadded = fromBase64("TWE", default: "")',
      // A byte order mark stays part of the text.
      'let marked = fromBase64("77u/QQ==", default: "")',
    ].join("\n"),
  );
  assert.equal(read.get("wrapped"), "ü 😀");
  assert.equal(read.get("url"), "ü 😀");
  assert.equal(read.get("underscore"), "ÿÿ");
  assert.equal(read.get("unpadded"), "Ma");
  assert.equal(read.get("marked"), "\uFEFFA");
});

test("fromBase64 gives its default for text that is not Base64, bytes that are not UTF-8, and a value that is not text", () => {
  for (const text of [
    "abc$",
    "Q",
    "QQ=",
    "Q===",
    "=QQ=",
    "QQ==QQ==",
    // A space that is not ASCII is no line break.
    "QQ==\u00A0",
    "!!!!",
    "w7wg8J+YgA==é",
    // 0xFF, an overlong 0xC0 0x80, a surrogate 0xED 0xA0 0x80, and a cut-off 0xE2 0x82.
    "/w==",
    "wIA=",
    "7aCA",
    "4oI=",
  ])
    assert.equal(
      variables(`let read = fromBase64(${literal(text)}, default: "fallback")`).get("read"),
      "fallback",
      JSON.stringify(text),
    );
  const read = variables(
    'function read(value) {\n  return fromBase64(value, default: null)\n}\nlet fromNumber = read(5)\nlet listed = read(["TWE="])',
  );
  assert.equal(read.get("fromNumber"), null);
  assert.equal(read.get("listed"), null);
});

test("hashText gives the SHA-256 of text in UTF-8 as 64 lowercase hexadecimal digits, at once", () => {
  const hashes = variables(
    [
      // The examples of FIPS 180-2: the 448-bit and 896-bit messages, and one million "a".
      'let empty = hashText("")',
      'let abc = hashText("abc")',
      'let bits448 = hashText("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")',
      'let bits896 = hashText("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu")',
      'let million = hashText("".padStart(1000000, "a"))',
      'let accents = hashText("ü 😀")',
      // A surrogate pair right where the text is encoded in parts.
      'let pair = hashText("".padStart(65535, "a") + "😀")',
      // Lone surrogates, which JSON can write, count as U+FFFD, as in toBase64.
      `let lone = hashText(fromJson(${literal('"\\ud800 \\udc00"')}, default: ""))`,
      'let replaced = hashText("\uFFFD \uFFFD")',
      `let loneBase64 = toBase64(fromJson(${literal('"\\ud800"')}, default: ""))`,
    ].join("\n"),
  );
  const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
  assert.equal(
    hashes.get("empty"),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    hashes.get("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    hashes.get("bits448"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(
    hashes.get("bits896"),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  );
  assert.equal(
    hashes.get("million"),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  );
  assert.equal(hashes.get("accents"), sha256(Buffer.from("ü 😀", "utf8")));
  assert.equal(hashes.get("pair"), sha256(Buffer.from(`${"a".repeat(65535)}😀`, "utf8")));
  // EF BF BD, the UTF-8 of U+FFFD, for each lone surrogate.
  assert.equal(hashes.get("lone"), sha256(Buffer.from([0xef, 0xbf, 0xbd, 0x20, 0xef, 0xbf, 0xbd])));
  assert.equal(hashes.get("replaced"), hashes.get("lone"));
  assert.equal(hashes.get("loneBase64"), "77+9");
});

test("a script compares an answer with a hash it holds, and hashText checks its argument", () => {
  const answered = variables(
    [
      // The hash of "corner" as sha256sum gives it, so the script holds no answer itself.
      'let expected = "45d227c4b297a0ba4ce42738ad3d448e19628a5ecfd509ea861b24a23009d08e"',
      'let right = hashText("corner") == expected',
      'let wrong = hashText("Corner") == expected',
    ].join("\n"),
  );
  assert.deepEqual(
    ["right", "wrong"].map((name) => answered.get(name)),
    [true, false],
  );
  const codes = (source: string) => diagnostics(source).map(([code]) => code);
  assert.deepEqual(diagnostics("let a = hashText(5)"), [
    ["TSV043", "hashText(...) hashes text (string), but this is a whole number (integer)."],
  ]);
  assert.deepEqual(codes('let a = hashText("a", algorithm: "sha1")'), ["TSV022"]);
  assert.deepEqual(codes('let a = hashText("a", "b")'), ["TSV020"]);
  assert.deepEqual(codes('let a: string = hashText("a")'), []);
  assert.deepEqual(codes("let hashText = 1"), ["TSV001"]);
  // Any other value goes through toJson first; one the compiler could not see fails when the script runs.
  assert.deepEqual(failure('let a = hashText(fromJson("[1]", default: null))'), {
    code: "TSR059",
    message: "hashText(...) hashes text (string), not a list.",
  });
  assert.deepEqual(codes("let a = hashText(toJson([1, 2]))"), []);
});

test("a Cornertime preset goes through JSON and Base64 between its lines and back", () => {
  const begin = "-----BEGIN CORNERTIME CUSTOM PUNISHMENT-----";
  const end = "-----END CORNERTIME CUSTOM PUNISHMENT-----";
  const read = variables(
    [
      'let preset = { name: "Corner time ü", minutes: 15, strict: true, note: null, lines: ["Face the wall", "Hands behind your back 😀"] }',
      "let json = toJson(preset)",
      "let encoded = toBase64(json)",
      `let shared = ${literal(begin)} + "\\n" + encoded + "\\n" + ${literal(end)}`,
      `let body = shared.replace(${literal(begin)}, "").replace(${literal(end)}, "")`,
      'let back = fromJson(fromBase64(body, default: ""), default: null)',
      "let same = toJson(back) == json",
    ].join("\n"),
  );
  const json =
    '{"name":"Corner time ü","minutes":15,"strict":true,"note":null,"lines":["Face the wall","Hands behind your back 😀"]}';
  assert.equal(read.get("json"), json);
  // What Cornertime's own decoder reads: atob, then UTF-8.
  const shared = read.get("shared");
  assert.ok(typeof shared === "string");
  const body = shared.slice(begin.length, -end.length);
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))), json);
  assert.deepEqual(
    read.get("back"),
    dict(
      ["name", "Corner time ü"],
      ["minutes", 15],
      ["strict", true],
      ["note", null],
      ["lines", list("Face the wall", "Hands behind your back 😀")],
    ),
  );
  assert.equal(read.get("same"), true);

  // A Cornertime text wrapped at 76 characters reads the same.
  const encoded = Buffer.from(json, "utf8").toString("base64");
  const wrapped = `${begin}\n${encoded.match(/.{1,76}/gu)!.join("\n")}\n${end}`;
  assert.ok(encoded.length > 76);
  assert.equal(
    variables(
      `let back = toJson(fromJson(fromBase64(${literal(wrapped)}.replace(${literal(begin)}, "").replace(${literal(end)}, ""), default: ""), default: null))`,
    ).get("back"),
    json,
  );
});

test("deeply nested JSON reads and writes back without native recursion, and survives a checkpoint", () => {
  const depth = 100_000;
  const plan = compileValidPlan(
    [
      `let lists = "[".repeat(${depth}) + "]".repeat(${depth})`,
      `let objects = "{\\"a\\":".repeat(${depth}) + "1" + "}".repeat(${depth})`,
      "let deepLists = fromJson(lists, default: null)",
      "let deepObjects = fromJson(objects, default: null)",
      "let same = toJson(deepLists) == lists and toJson(deepObjects) == objects",
      "let nested = deepLists is list",
      "exit",
    ].join("\n"),
  );
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(result.snapshot.failure, null);
  const bindings = new Map(
    result.snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
  );
  assert.equal(bindings.get("same"), true);
  assert.equal(bindings.get("nested"), true);
  // Compared as JSON: a deep comparison of the values themselves would recurse natively.
  const json = serializeCheckpoint(createCheckpoint(plan, result.snapshot));
  const restored = deserializeCheckpoint(json);
  assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true);
  assert.equal(serializeCheckpoint(restored), json);
});

test("toJson cannot write a value without a JSON form: a compile error where the type shows it, a runtime error otherwise", () => {
  const fix = "Write plain values, such as text, numbers, lists, or dicts, instead.";
  // The functions are checked after the code around them.
  assert.deepEqual(
    diagnostics(
      [
        "let t = timer async 5 s {",
        "}",
        'let b = showPermanentButton "Stop" {',
        "}",
        "let view = showCamera",
        "function write(m: media, line: messageHandle, s: script) {",
        "  let a = toJson(m)",
        "  let c = toJson([line])",
        "  let d = toJson({ file: s })",
        "}",
        "let e = toJson(t)",
        "let f = toJson(b)",
        "let g = toJson(view)",
        "let h = toJson(1..5)",
        "let i = toJson(2 calendar months)",
        "function either(j: integer | range) {",
        "  let k = toJson(j)",
        "}",
      ].join("\n"),
    ),
    [
      [
        "TSV043",
        `toJson(...) cannot write a timer handle, which exists only in the current session. ${fix}`,
      ],
      [
        "TSV043",
        `toJson(...) cannot write a permanent button, which exists only in the current session. ${fix}`,
      ],
      [
        "TSV043",
        `toJson(...) cannot write a camera view, which exists only in the current session. ${fix}`,
      ],
      ["TSV043", `toJson(...) cannot write a range, which has no JSON form. ${fix}`],
      ["TSV043", `toJson(...) cannot write a calendar duration, which has no JSON form. ${fix}`],
      [
        "TSV043",
        `toJson(...) cannot write a media handle, which exists only in the current session. ${fix}`,
      ],
      [
        "TSV043",
        `toJson(...) cannot write a message handle, which exists only in the current session, and this is a list (messageHandle[]). ${fix}`,
      ],
      [
        "TSV043",
        `toJson(...) cannot write a script reference, which has no JSON form, and this is an object. ${fix}`,
      ],
      [
        "TSV043",
        `toJson(...) cannot write a range, which has no JSON form, and this is a whole number (integer) or a range. ${fix}`,
      ],
    ],
  );

  // Where the compiler cannot know the value, the runtime refuses it.
  const write = "function write(value) {\n  return toJson(value)\n}\n";
  assert.deepEqual(failure(`${write}let t = timer async 5 s {\n}\nlet j = write(t)`), {
    code: "TSR059",
    message: `toJson(...) cannot write a timer handle, which exists only in the current session. ${fix}`,
  });
  assert.deepEqual(failure(`${write}let j = write({ steps: [1..3] })`), {
    code: "TSR059",
    message: `toJson(...) cannot write this value: it holds a range, which has no JSON form. ${fix}`,
  });
  assert.deepEqual(failure(`${write}let j = write(1 calendar day)`), {
    code: "TSR059",
    message: `toJson(...) cannot write a calendar duration, which has no JSON form. ${fix}`,
  });
  // A speaker that holds itself, through another, would never end.
  assert.deepEqual(
    failure(
      'speaker vera {\n  displayName: "Vera"\n}\nspeaker ann {\n  displayName: "Ann"\n}\nvera.friend = ann\nann.friend = vera\nlet j = toJson(vera)',
    ),
    {
      code: "TSR059",
      message:
        "toJson(...) cannot write speaker 'vera' inside its own properties, as the text would never end. Write the speaker's name in its place instead.",
    },
  );
});

test("the four functions check their arguments, need a default: to read, and their names are reserved", () => {
  const codes = (source: string) => diagnostics(source).map(([code]) => code);
  assert.deepEqual(diagnostics('let a = fromJson("[]")'), [
    [
      "TSV020",
      "'fromJson(text, default: value)' needs a 'default:' for text that is not valid JSON. Add one, such as 'default: null'.",
    ],
  ]);
  assert.deepEqual(diagnostics('let a = fromBase64("TWE=")'), [
    [
      "TSV020",
      "'fromBase64(text, default: value)' needs a 'default:' for text that is not valid Base64. Add one, such as 'default: null'.",
    ],
  ]);
  assert.deepEqual(codes("let a = toJson()"), ["TSV020"]);
  assert.deepEqual(codes("let a = toJson(1, 2)"), ["TSV020"]);
  assert.deepEqual(codes("let a = toJson(1, indent: 2)"), ["TSV022"]);
  assert.deepEqual(codes('let a = toBase64("a", default: "")'), ["TSV022"]);
  assert.deepEqual(codes('let a = fromJson("1", fallback: 0)'), ["TSV022", "TSV020"]);
  assert.deepEqual(codes("let a = fromJson(default: 0)"), ["TSV020"]);
  // Text to read or encode is text; a value that may be text is read when the script runs.
  assert.deepEqual(diagnostics("let a = fromJson(5, default: null)"), [
    ["TSV043", "fromJson(...) reads text (string), not a whole number (integer)."],
  ]);
  assert.deepEqual(codes('let a = fromBase64(["TWE="], default: null)'), ["TSV043"]);
  assert.deepEqual(
    codes("function read(s: string?) {\n  let a = fromJson(s, default: null)\n}"),
    [],
  );
  assert.deepEqual(diagnostics("let a = toBase64(5)"), [
    ["TSV043", "toBase64(...) encodes text (string), but this is a whole number (integer)."],
  ]);
  // toJson and toBase64 give text; fromBase64 its default otherwise.
  assert.deepEqual(codes('let a: string = toJson([1])\nlet b: string = toBase64("x")'), []);
  assert.deepEqual(codes('let a: string? = fromBase64("TWE=", default: null)'), []);
  assert.deepEqual(codes('let a: string = fromBase64("TWE=", default: 0)'), ["TSV041"]);
  for (const name of ["toJson", "fromJson", "toBase64", "fromBase64"])
    assert.deepEqual(codes(`let ${name} = 1`), ["TSV001"], name);
});
