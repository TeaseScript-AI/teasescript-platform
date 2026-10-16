import assert from "node:assert/strict";
import test from "node:test";

import { executeValidatedInstruction } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { captureExecutableData } from "../src/runtime/operations/support.js";
import {
  builtSerializableDictIndex,
  type SerializableRuntimeDict,
} from "../src/runtime/serializable-values.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";

/** Hides a value's type from the compiler, so a check reaches the runtime. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

function isDictValue(value: unknown): value is SerializableRuntimeDict {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "dict" &&
    "entries" in value &&
    Array.isArray(value.entries)
  );
}

/**
 * Checks every dict in a state: a key index it built holds exactly its entries, so a lookup can neither find an entry
 * that is gone nor miss one that was added. Returns how many dicts had built one.
 */
function assertDictIndexesExact(snapshot: RuntimeSnapshot): number {
  let indexed = 0;
  const seen = new Set<unknown>();
  const work: unknown[] = [snapshot];
  while (work.length > 0) {
    const value = work.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    const index = isDictValue(value) ? builtSerializableDictIndex(value) : undefined;
    if (isDictValue(value) && index !== undefined) {
      indexed += 1;
      assert.equal(index.size, value.entries.length);
      for (const entry of value.entries) assert.equal(index.get(entry.key), entry, entry.key);
    }
    for (const nested of Array.isArray(value) ? value : Object.values(value)) work.push(nested);
  }
  return indexed;
}

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

/**
 * Runs a script one instruction at a time on the same state, so that the dicts and their indexes live on from one
 * statement to the next, and checks every index after each instruction. Returns what the script said and its failure.
 */
function steps(source: string): {
  said: string[];
  failure: [string, string] | null;
  indexed: number;
} {
  const compiled = compileValidPlan(source);
  const { plan, snapshot } = captureExecutableData(
    compiled,
    createImmediatePacingRuntimeSnapshot(compiled),
  );
  const events: InterpreterEvent[] = [];
  let indexed = 0;
  while (snapshot.status !== "halted" && snapshot.status !== "failed") {
    assert.notEqual(snapshot.status, "waiting", "the script waits");
    events.push(...executeValidatedInstruction(plan, snapshot).events);
    indexed += assertDictIndexesExact(snapshot);
  }
  const failed = snapshot.failure;
  return {
    said: said(events),
    failure: failed === null ? null : [failed.code, failed.message],
    indexed,
  };
}

/** What a script that runs to its end says; its lookups built an index. */
function says(source: string): string[] {
  const result = steps(source);
  assert.equal(result.failure, null);
  assert.ok(result.indexed > 0, "no dict built an index");
  return result.said;
}

/** What a failing script said before it failed, and its failure. */
function failure(source: string): [string[], string, string] {
  const result = steps(source);
  assert.ok(result.failure !== null, "the script did not fail");
  return [result.said, ...result.failure];
}

test("dict keys keep source order, replacement in place, stored nulls, and their meaning as plain text", () => {
  assert.deepEqual(
    says(
      [
        DYNAMIC,
        'let first = dynamic("x")',
        'let second = dynamic("y")',
        // Number-like keys stay text in source order, and a later equal key replaces the first in its position.
        'let d = dict{ "2": "two", "10": "ten", "1": "one", [first]: "x1", [second]: "y", [first]: "x2" }',
        "say d",
        // Names that JavaScript objects inherit are ordinary keys, missing until stored.
        'say d.contains("toString")',
        'say d.contains("__proto__")',
        'say d.get("constructor", default: "none")',
        'say d.contains("hasOwnProperty")',
        'say d.contains("02")',
        'd["__proto__"] = "proto"',
        'd["constructor"] = "maker"',
        'd["toString"] = "text"',
        'say d["__proto__"]',
        'say d.contains("constructor")',
        // A removed key that comes back is added at the end.
        'd.remove("2")',
        'd["2"] = "again"',
        "say d.keys",
        'say d.remove("__proto__")',
        'say d.contains("__proto__")',
        // A stored null is a value, not a missing key.
        'let notes: string? dict = dict{ quiet: null, loud: "yes" }',
        'say notes.contains("quiet")',
        'say notes.get("quiet", default: "unset")',
        'say notes["quiet"]',
        'say notes.remove("quiet")',
        'say notes.get("quiet", default: "unset")',
        "exit",
      ].join("\n"),
    ),
    [
      'dict{ "2": "two", "10": "ten", "1": "one", "x": "x2", "y": "y" }',
      "false",
      "false",
      "none",
      "false",
      "false",
      "proto",
      "true",
      '["10", "1", "x", "y", "__proto__", "constructor", "toString", "2"]',
      "proto",
      "false",
      "true",
      "null",
      "null",
      "null",
      "unset",
    ],
  );
});

test("a lookup evaluates the default only for a missing key and fails for a key that is not text", () => {
  const prefix = [
    DYNAMIC,
    "function note(text) {",
    '    say "default ${text}"',
    "    return text",
    "}",
    'let d = dict{ a: "kept" }',
  ].join("\n");
  assert.deepEqual(
    says(
      `${prefix}\nsay d.get("a", default: note("one"))\nsay d.get("b", default: note("two"))\nexit`,
    ),
    ["kept", "default two", "two"],
  );
  const missing = (key: string) =>
    `Dictionary has no key "${key}". Check d.contains("${key}") first.`;
  assert.deepEqual(failure(`${prefix}\nsay d["toString"]\nexit`), [
    [],
    "TSR061",
    missing("toString"),
  ]);
  assert.deepEqual(failure(`${prefix}\nsay d.remove("constructor")\nexit`), [
    [],
    "TSR061",
    missing("constructor"),
  ]);
  const notText =
    'A dict key is text (string), but this is a whole number (integer). Write a number key as text, as in "${id}".';
  assert.deepEqual(failure(`${prefix}\nsay d[dynamic(2)]\nexit`), [[], "TSR062", notText]);
  assert.deepEqual(failure(`${prefix}\nsay d.get(dynamic(2), default: note("three"))\nexit`), [
    [],
    "TSR062",
    notText,
  ]);
  // The calls in a literal's entries run in source order before a key that is not text fails it.
  assert.deepEqual(failure(`${prefix}\nsay dict{ a: note("a"), [dynamic(2)]: note("b") }\nexit`), [
    ["default a", "default b"],
    "TSR062",
    notText,
  ]);
});

test("a wide literal and a large dict a script builds keep every key in order and in reach", () => {
  const width = 1_000;
  const literal = Array.from({ length: width }, (_, index) => `k${index}: ${index}`).join(", ");
  // Run as a whole: the index check after each instruction would walk the wide dict thousands of times.
  const result = runValidSource(
    [
      `let wide = dict{ ${literal} }`,
      "let total = 0",
      "let position = 0",
      "let ordered = true",
      "for key in wide {",
      '    if key != "k${position}" {',
      "        ordered = false",
      "    }",
      "    total += wide[key]",
      "    position += 1",
      "}",
      "say ordered",
      "say total",
      `say wide.contains("k${width - 1}")`,
      `say wide.contains("k${width}")`,
      "let counts: integer dict = dict{}",
      "for i in 0..3000 {",
      '    let key = "k${i % 600}"',
      "    counts[key] = counts.get(key, default: 0) + 1",
      "}",
      "say counts.length",
      "for i in 0..600 {",
      "    if i % 2 == 0 {",
      '        counts.remove("k${i}")',
      "    }",
      "}",
      'counts["k0"] = 100',
      "say counts.length",
      "say counts.keys[0]",
      "say counts.keys[300]",
      'say counts.get("k2", default: -1)',
      'say counts["k599"]',
      'say counts["k0"]',
      "exit",
    ].join("\n"),
  );
  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(said(result.events), [
    "true",
    String((width * (width - 1)) / 2),
    "true",
    "false",
    "600",
    "301",
    "k1",
    "k0",
    "-1",
    "5",
    "100",
  ]);
});

test("every change to a dict, also one reached through a path or a call, keeps its lookups exact", () => {
  assert.deepEqual(
    says(
      [
        "let d = dict{ a: 1, b: 2 }",
        'say d.contains("a")',
        'd["c"] = 3',
        'd["a"] = 10',
        'd["b"] += 5',
        'say [d["a"], d["b"], d["c"]]',
        "say d.keys",
        'd.remove("a")',
        'say d.contains("a")',
        'say d.get("a", default: 0)',
        "d.clear()",
        'say d.contains("b")',
        'd["b"] = 1',
        'say d.contains("c")',
        "say d",
        "d = dict{ z: 26 }",
        'say d.contains("b")',
        // A dict in a list, in an object, and in a dict.
        "let rows = [dict{ k: 1 }]",
        'say rows[0].contains("k")',
        'rows[0]["j"] = 2',
        'rows[0].remove("k")',
        'say rows[0].contains("k")',
        "say rows",
        "let holder = { table: dict{ k: 1 } }",
        'say holder.table.contains("k")',
        'holder.table["m"] = 6',
        'holder.table.remove("k")',
        'say holder.table.contains("k")',
        'say holder.table["m"]',
        "let outer = dict{ inner: dict{ k: 1 } }",
        'say outer["inner"].contains("k")',
        'outer["inner"]["n"] = 2',
        'outer["inner"].clear()',
        'outer["inner"]["k"] = 3',
        'say outer["inner"].contains("n")',
        "say outer",
        // A function changes a dict that its caller reads.
        "let shared = dict{ k: 1, l: 2 }",
        "function change {",
        '    shared.remove("k")',
        '    shared["k"] = 3',
        '    shared["m"] = 4',
        "}",
        'say shared.contains("m")',
        "change()",
        'say shared.contains("m")',
        "say shared",
        // A pair loop goes through the entries it took, while the dict changes.
        "let walked = dict{ a: 1, b: 2 }",
        "for key, value in walked {",
        "    walked.remove(key)",
        '    walked["${key}${key}"] = value',
        "}",
        'say walked.contains("a")',
        "say walked",
        "exit",
      ].join("\n"),
    ),
    [
      "true",
      "[10, 7, 3]",
      '["a", "b", "c"]',
      "false",
      "0",
      "false",
      "false",
      'dict{ "b": 1 }',
      "false",
      "true",
      "false",
      '[dict{ "j": 2 }]',
      "true",
      "false",
      "6",
      "true",
      "false",
      'dict{ "inner": dict{ "k": 3 } }',
      "false",
      "true",
      'dict{ "l": 2, "k": 3, "m": 4 }',
      "false",
      'dict{ "aa": 1, "bb": 2 }',
    ],
  );
});

test("a dict restored from a checkpoint at any step finds the keys it had and takes changes", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let d = dict{ a: 1, b: 2 }",
      'say d.contains("a")',
      "wait 1 s",
      'd["c"] = 3',
      'd.remove("a")',
      "wait 1 s",
      'say d.contains("a")',
      "say d.keys",
      'd["a"] = 4',
      "wait 1 s",
      'say d["a"]',
      "say d.keys",
      "d.clear()",
      "wait 1 s",
      'say d.contains("b")',
      'd["b"] = 5',
      "say d",
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(said(result.events), [
    "true",
    "false",
    '["b", "c"]',
    "4",
    '["b", "c", "a"]',
    "false",
    'dict{ "b": 5 }',
  ]);
  assertDictIndexesExact(result.finalSnapshot);
});

test("a copy of a dict and the dict it came from change apart", () => {
  assert.deepEqual(
    says(
      [
        "let a = dict{ x: 1, y: 2 }",
        'say a.contains("x")',
        "let b = a",
        'say b.contains("x")',
        'b["z"] = 3',
        'b.remove("x")',
        'a["y"] = 20',
        "say a",
        "say b",
        'say a.contains("z")',
        'say b.contains("x")',
        "function grow(table: integer dict): integer dict {",
        '    table["w"] = 4',
        '    table.remove("y")',
        "    return table",
        "}",
        "let c = grow(a)",
        'c["x"] = 100',
        "say a",
        "say c",
        "let pair = [a, a]",
        'pair[0]["q"] = 1',
        'say pair[1].contains("q")',
        'say a.contains("q")',
        "say a == dict{ y: 20, x: 1 }",
        "exit",
      ].join("\n"),
    ),
    [
      "true",
      "true",
      'dict{ "x": 1, "y": 20 }',
      'dict{ "y": 2, "z": 3 }',
      "false",
      "false",
      'dict{ "x": 1, "y": 20 }',
      'dict{ "x": 100, "w": 4 }',
      "false",
      "false",
      "true",
    ],
  );
});

test("a change prepared through a dict key reaches the entry the key holds when the change is made", () => {
  const source = [
    'let d = dict{ "k": [1], "other": [2] }',
    "function grow {",
    "    for i in 0..10 {",
    '        d["n${i}"] = [i]',
    "    }",
    "    return 3",
    "}",
    'd["k"].add(grow())',
    'say d["k"]',
    "say d.length",
    "function move {",
    '    d.remove("k")',
    '    d["k"] = [9]',
    "    return 4",
    "}",
    'd["k"].add(move())',
    'say d["k"]',
    "say d.keys[d.length - 1]",
    "function swap {",
    '    d["other"] = [7]',
    "    return 5",
    "}",
    'd["other"].add(swap())',
    'say d["other"]',
    "function wipe {",
    "    d.clear()",
    '    d["k"] = [0]',
    "    return 6",
    "}",
    'd["k"].add(wipe())',
    "say d",
    'let e = dict{ "k": [[1]], "j": [[5]] }',
    'e["j"][0].add(e["k"].length)',
    "say e",
    "exit",
  ].join("\n");
  const expected = [
    "[1, 3]",
    "12",
    "[9]",
    "k",
    "[7]",
    'dict{ "k": [0] }',
    'dict{ "k": [[1]], "j": [[5, 1]] }',
  ];
  assert.deepEqual(says(source), expected);
  // The prepared changes also wait in a checkpoint while the calls run.
  const resumed = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(said(resumed.events), expected);
  assertDictIndexesExact(resumed.finalSnapshot);
  // The key a statement changes through is gone once something in the same statement removed it.
  assert.deepEqual(
    failure('let e = dict{ "k": [[1]] }\ne["k"][e.remove("k").length - 1].add(4)\nexit'),
    [
      [],
      "TSR053",
      'The dict entry this statement changes no longer exists: something in the same statement removed the key "k". Make the change in a separate statement.',
    ],
  );
});
