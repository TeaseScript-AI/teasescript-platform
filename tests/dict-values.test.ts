import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createCheckpoint, serializeCheckpoint } from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { SerializableRuntimeProperty } from "../src/runtime/serializable-values.js";
import type { RuntimeForLoopFrameSnapshot, RuntimeSnapshot } from "../src/runtime/state.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";

/** Hides a value's type from the compiler, so a check reaches the runtime. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

function says(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function failure(source: string): [string, string] | null {
  const failed = runValidSource(source).snapshot.failure;
  return failed === null ? null : [failed.code, failed.message];
}

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function codes(source: string): [string, string][] {
  return diagnostics(source).map(([code, , text]) => [code, text]);
}

test("a dict literal takes written, quoted, and computed keys in source order, and say shows its entries", () => {
  assert.deepEqual(
    says(
      [
        'let spare = "spare"',
        'let toys = dict{ collar: "leather collar", "soft cuffs": "wrist cuffs", [spare]: "spare gag" }',
        "say toys",
        'say toys["soft cuffs"]',
        "say dict{}",
        'say [dict{ "a\\"b": [1, 2] }]',
        // A collision from runtime data replaces the earlier entry in its position.
        'let first = "x"',
        'let again = "x"',
        "say dict{ [first]: 1, z: 2, [again]: 3 }",
        "exit",
      ].join("\n"),
    ),
    [
      'dict{ "collar": "leather collar", "soft cuffs": "wrist cuffs", "spare": "spare gag" }',
      "wrist cuffs",
      "dict{}",
      '[dict{ "a\\"b": [1, 2] }]',
      'dict{ "x": 3, "z": 2 }',
    ],
  );
  // Each key is evaluated before its value.
  assert.deepEqual(
    says(
      [
        "function key(name) {",
        '    say "key ${name}"',
        "    return name",
        "}",
        "function value(amount) {",
        '    say "value ${amount}"',
        "    return amount",
        "}",
        'let table = dict{ [key("a")]: value(1), [key("b")]: value(2) }',
        "say table",
        "exit",
      ].join("\n"),
    ),
    ["key a", "value 1", "key b", "value 2", 'dict{ "a": 1, "b": 2 }'],
  );
});

test("reads, writes, and dict methods keep insertion order, and get gives the default for a missing key", () => {
  assert.deepEqual(
    says(
      [
        'let toys = dict{ collar: "leather", cuffs: "wrist" }',
        'toys["collar"] = "chain"',
        'toys["gag"] = "ball"',
        "say toys",
        "say toys.length",
        'say toys.contains("cuffs")',
        'say toys.contains("rope")',
        "say toys.keys",
        "say toys.values",
        'say toys.remove("cuffs")',
        "say toys",
        'say toys.get("rope", default: "none")',
        'say toys.get("gag", default: "none")',
        "toys.clear()",
        "say toys",
        "let notes: string? dict = dict{ quiet: null }",
        'say notes.get("quiet", default: "unset")',
        "let counts: integer dict = dict{}",
        'counts["spank"] = counts.get("spank", default: 0) + 1',
        'counts["spank"] += 2',
        "say counts",
        "exit",
      ].join("\n"),
    ),
    [
      'dict{ "collar": "chain", "cuffs": "wrist", "gag": "ball" }',
      "3",
      "true",
      "false",
      '["collar", "cuffs", "gag"]',
      '["chain", "wrist", "ball"]',
      "wrist",
      'dict{ "collar": "chain", "gag": "ball" }',
      "none",
      "ball",
      "dict{}",
      "null",
      'dict{ "spank": 3 }',
    ],
  );
});

test("a missing key, a key that is not text, and ${dict} fail with the fix", () => {
  const toys = 'let toys = dict{ collar: "leather" }\nlet name = "cuffs"\n';
  const missing = 'Dictionary has no key "cuffs". Check toys.contains(name) first.';
  assert.deepEqual(failure(`${toys}say toys[name]\nexit`), ["TSR061", missing]);
  assert.deepEqual(failure(`${toys}let old = toys.remove(name)\nexit`), ["TSR061", missing]);
  assert.deepEqual(failure('let counts = dict{ a: 1 }\ncounts["b"] += 1\nexit'), [
    "TSR061",
    'Dictionary has no key "b". Check counts.contains("b") first.',
  ]);
  assert.deepEqual(failure(`${DYNAMIC}${toys}say toys[dynamic(5)]\nexit`), [
    "TSR062",
    'A dict key is text (string), but this is a whole number (integer). Write a number key as text, as in "${id}".',
  ]);
  assert.deepEqual(failure(`${DYNAMIC}${toys}say "\${dynamic(toys)}"\nexit`), [
    "TSR021",
    '"${...}" cannot show a dict. Select one value with dict[key], or show every value with dict.values.join().',
  ]);
  // The compiler reports what it can see.
  assert.deepEqual(diagnostics(`${toys}let id = 5\nsay toys[id]\nsay "\${toys}"\nexit`), [
    [
      "TSV043",
      'A dict key is text (string), but this is a whole number (integer). Write a number key as text, as in "${id}".',
      "id",
    ],
    [
      "TSV042",
      '"${...}" cannot show a dict. Select one value with toys[key], or show every value with toys.values.join().',
      "toys",
    ],
  ]);
  assert.deepEqual(diagnostics('say dict{ a: 1 }["b"]\nsay dict{ a: 1 }.remove("b")\nexit'), [
    ["TSV043", 'Dictionary has no key "b".', '"b"'],
    ["TSV043", 'Dictionary has no key "b".', '"b"'],
  ]);
});

test("a loop goes through the keys as they were when it started", () => {
  assert.deepEqual(
    says(
      [
        "let toys = dict{ a: 1, b: 2, c: 3 }",
        "for key in toys {",
        "    say key",
        '    toys["${key}${key}"] = 0',
        '    if toys.contains("b") {',
        '        toys.remove("b")',
        "    }",
        "}",
        "say toys",
        "exit",
      ].join("\n"),
    ),
    ["a", "b", "c", 'dict{ "a": 1, "c": 3, "aa": 0, "bb": 0, "cc": 0 }'],
  );
  assert.deepEqual(codes("for key in dict{ a: 1 } {\n    let n: integer = key\n}\nexit"), [
    ["TSV041", "key"],
  ]);
});

test("for key, value goes through the entries as they were when it started, with a copy of each value", () => {
  assert.deepEqual(
    says(
      [
        "let toys = dict{ rope: { uses: 1 }, cuffs: { uses: 2 } }",
        "let calls = 0",
        "function source {",
        "    calls += 1",
        "    return toys",
        "}",
        "for key, value in source() {",
        // Changing the copy, or the source's entries, changes neither the other nor a later entry.
        "    value.uses += 10",
        "    if toys.contains(key) {",
        "        toys[key].uses += 100",
        "    }",
        '    toys["added"] = { uses: 0 }',
        '    if toys.contains("cuffs") {',
        '        toys.remove("cuffs")',
        "    }",
        '    say "${key} ${value.uses}"',
        "}",
        "say calls",
        "say toys",
        "for key, value in dict{} {",
        '    say "never"',
        "}",
        "exit",
      ].join("\n"),
    ),
    ["rope 11", "cuffs 12", "1", 'dict{ "rope": { uses: 101 }, "added": { uses: 0 } }'],
  );
  // break, continue, and nested pair loops.
  assert.deepEqual(
    says(
      [
        "let grid = dict{ a: dict{ x: 1, y: 2 }, b: dict{ x: 3 }, c: dict{ x: 4 } }",
        "for row, cells in grid {",
        '    if row == "c" {',
        "        break",
        "    }",
        "    for column, n in cells {",
        '        if column == "y" {',
        "            continue",
        "        }",
        '        say "${row}${column}=${n}"',
        "    }",
        "}",
        "exit",
      ].join("\n"),
    ),
    ["ax=1", "bx=3"],
  );
});

test("for key, value takes a dict, a text key, and the dict's value type, which assignments may widen", () => {
  assert.deepEqual(
    says("for key, value in dict{ a: 1 } {\n    value = 1.5\n    say value\n}\nexit"),
    ["1.5"],
  );
  assert.deepEqual(codes("for key, value in dict{ a: 1 } {\n    let n: integer = key\n}\nexit"), [
    ["TSV041", "key"],
  ]);
  assert.deepEqual(codes('for key, value in dict{ a: "x" } {\n    value = 1\n}\nexit'), [
    ["TSV041", "1"],
  ]);
  assert.deepEqual(codes("for key, value in [1, 2] {\n}\nexit"), [["TSV043", "[1, 2]"]]);
  assert.deepEqual(diagnostics("for key, value in 3 {\n}\nexit"), [
    ["TSV012", "A for-loop with a key and a value goes through a dict.", "3"],
  ]);
  // A line may break after the comma, also with a blank line.
  assert.deepEqual(says("for key,\n    value in dict{ a: 1 } {\n    say value\n}\nexit"), ["1"]);
  assert.deepEqual(says("for key,\n\n    value in dict{ a: 1 } {\n    say value\n}\nexit"), ["1"]);
  // Without a value name, the next line's closing brace or statement stays for recovery.
  for (const source of [
    'if true {\n    for key,\n}\nsay "after"\nexit',
    'if true {\n    for key,\n\n}\nsay "after"\nexit',
    'for key,\nsay "after"\nexit',
  ]) {
    const parsed = parse(source);
    assert.deepEqual(
      parsed.diagnostics.map((diagnostic) => diagnostic.code),
      ["TSP013"],
      source,
    );
    assert.deepEqual(
      parsed.program.statements.map((statement) => statement.kind),
      source.startsWith("if")
        ? ["ifStatement", "sayStatement", "exitStatement"]
        : ["sayStatement", "exitStatement"],
      source,
    );
  }
  assert.deepEqual(codes("for key, key in dict{ a: 1 } {\n}\nexit"), [["TSV001", "key"]]);
  // The header error comes first; the unparsed block then recovers as on main.
  assert.equal(codes("for key, in dict{ a: 1 } {\n}\nexit")[0]?.[0], "TSP013");
  // A source the compiler cannot know is checked when the loop starts.
  assert.deepEqual(failure(`${DYNAMIC}for key, value in dynamic([1]) {\n}\nexit`), [
    "TSR044",
    "for key, value requires a dict source.",
  ]);
});

test("a pair loop resumes from a checkpoint at every step, and a checkpoint rejects a malformed pair loop", () => {
  const source = [
    "let toys = dict{ rope: [1], cuffs: [2] }",
    "for key, value in toys {",
    "    wait 1",
    "    value.add(3)",
    "    toys[key] = value",
    '    say "${key} ${value.length}"',
    "}",
    "say toys",
    "exit",
  ].join("\n");
  const result = assertRuntimeResumeEquivalent(source);
  assert.deepEqual(
    result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["rope 2", "cuffs 2", 'dict{ "rope": [1, 3], "cuffs": [2, 3] }'],
  );

  const plan = compileValidPlan(source);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(waiting.snapshot.status, "waiting");
  const serialized = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  const corrupt = (mutate: (frame: RuntimeForLoopFrameSnapshot) => void) => {
    // EVIDENCE: fixture: the parsed checkpoint was serialized from a valid runtime snapshot just above.
    const json = JSON.parse(serialized) as { snapshot: RuntimeSnapshot };
    const frame = json.snapshot.loopFrames[0];
    assert.ok(frame?.kind === "for" && frame.valueVariable === "value");
    mutate(frame);
    assertCheckpointRejected(json, "TSK002");
  };
  corrupt((frame) => Reflect.deleteProperty(frame, "valueVariable"));
  corrupt((frame) => Object.assign(frame, { valueVariable: "other" }));
  corrupt((frame) => Object.assign(frame, { valueVariable: "key" }));
  corrupt((frame) => Object.assign(frame, { source: { kind: "list", items: ["rope", "cuffs"] } }));
  corrupt((frame) => Object.assign(frame, { position: 3 }));

  // A plan's pair loop needs two different names.
  const forged = JSON.parse(JSON.stringify(plan));
  const loop = forged.instructions.find(
    (instruction: { kind: string }) => instruction.kind === "loopStart",
  );
  loop.valueVariable = loop.variable;
  assert.equal(validateInstructionPlan(forged).valid, false);
  loop.valueVariable = 7;
  assert.equal(validateInstructionPlan(forged).valid, false);
});

test("dicts compare by keys and values in any order and are copied like other values", () => {
  assert.deepEqual(
    says(
      [
        // A known dict and a known object are never equal, which the compiler warns about (ADR 0021 rule 4.5).
        "function dynamic(value) {",
        "    return value",
        "}",
        "let a = dict{ x: [1], y: [1, 2] }",
        "say a == dict{ y: [1, 2], x: [1] }",
        "say a == dict{ x: [1] }",
        "say dict{ x: 1 } == dict{ x: 2 }",
        "say dynamic(dict{ x: 1 }) == { x: 1 }",
        "let c = a",
        'c["x"] = [5]',
        'c["y"].add(3)',
        "say a",
        "say c",
        "let keys = a.keys",
        'keys.add("z")',
        "say a.keys",
        "function change(table) {",
        '    table["x"] = [9]',
        "    return table",
        "}",
        'say change(a)["x"]',
        'say a["x"]',
        "exit",
      ].join("\n"),
    ),
    [
      "true",
      "false",
      "false",
      "false",
      'dict{ "x": [1], "y": [1, 2] }',
      'dict{ "x": [5], "y": [1, 2, 3] }',
      '["x", "y"]',
      "[9]",
      "[1]",
    ],
  );
});

test("typed storage keeps a dict and its entry order, and a typed load checks every value", () => {
  assert.deepEqual(
    says(
      [
        'save dict{ cuffs: "wrist", collar: "leather" } as "toys"',
        'let toys: string dict = load "toys"',
        "say toys",
        'say toys == dict{ collar: "leather", cuffs: "wrist" }',
        "exit",
      ].join("\n"),
    ),
    ['dict{ "cuffs": "wrist", "collar": "leather" }', "true"],
  );
  assert.deepEqual(
    failure('save dict{ a: "x" } as "k"\nlet counts: integer dict = load "k"\nexit'),
    [
      "TSR058",
      `'counts' holds a dict (integer dict), so it cannot take a dict with text (string) at ["a"].`,
    ],
  );
  assert.deepEqual(
    failure(`${DYNAMIC}let counts: integer dict = dict{}\ncounts["a"] = dynamic("x")\nexit`),
    [
      "TSR058",
      "A value of 'counts' holds a whole number (integer), so it cannot take text (string).",
    ],
  );
});

test("execution resumed from a checkpoint at every step, also inside a call that changes a dict, matches", () => {
  assertRuntimeResumeEquivalent(
    [
      "let table = dict{ a: { n: 1 }, b: { n: 2 } }",
      "function bump(key) {",
      '    say "bump ${key}"',
      '    table.remove("a")',
      "    return 5",
      "}",
      "function tag(text) {",
      '    say "tag ${text}"',
      "    return text",
      "}",
      // The receiver `table["b"]` is prepared before the call removes another key.
      'table["b"].n = bump("b")',
      'table[tag("c")] = { n: 0 }',
      "for key in table {",
      "    say key",
      "}",
      "say table",
      'say table.get("z", default: { n: -1 })',
      "exit",
    ].join("\n"),
  );
});

test("a checkpoint keeps dicts and prepared dict keys, and rejects malformed ones", () => {
  const plan = compileValidPlan(
    [
      "let table = dict{ a: { n: 1 }, b: { n: 2 } }",
      "let handles = dict{ beat: timer async 10 s }",
      "function pause {",
      "    wait 1 s",
      "    return 5",
      "}",
      'table["b"].n = pause()',
      "say table",
      "exit",
    ].join("\n"),
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(waiting.snapshot.status, "waiting");
  const serialized = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  const finished = run(plan, observeTime(plan, waiting.snapshot, 1_000).snapshot);
  assert.deepEqual(
    finished.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ['dict{ "a": { n: 1 }, "b": { n: 5 } }'],
  );

  const corrupt = (mutate: (snapshot: RuntimeSnapshot) => void) => {
    // EVIDENCE: fixture: the parsed checkpoint was serialized from a valid runtime snapshot just above.
    const json = JSON.parse(serialized) as { snapshot: RuntimeSnapshot };
    mutate(json.snapshot);
    assertCheckpointRejected(json, "TSK002");
  };
  const table = (snapshot: RuntimeSnapshot) => {
    const found = snapshot.frames[0]!.bindings.find((entry) => entry.name === "table")?.value;
    assert.ok(typeof found === "object" && found !== null && found.kind === "dict");
    return found;
  };
  const keyStep = (snapshot: RuntimeSnapshot): SerializableRuntimeProperty => {
    // The prepared receiver `table["b"]` waits in the caller's temporaries while `pause` runs.
    const text = JSON.stringify(snapshot.callFrames);
    assert.match(text, /"value":"key"/u);
    const temporaries = snapshot.callFrames[0]!.callerTemporaries;
    for (const temporary of temporaries) {
      const value = temporary.value;
      if (typeof value !== "object" || value === null || value.kind !== "object") continue;
      const path = value.properties.find((property) => property.name === "path")?.value;
      if (typeof path !== "object" || path === null || path.kind !== "list") continue;
      const step = path.items[0];
      if (typeof step === "object" && step !== null && step.kind === "object")
        return step.properties.find((property) => property.name === "key")!;
    }
    throw new Error("No prepared dict key step.");
  };
  corrupt((snapshot) => {
    table(snapshot).entries.push({ key: "a", value: null });
  });
  corrupt((snapshot) => {
    Object.assign(table(snapshot).entries[0]!, { key: 1 });
  });
  corrupt((snapshot) => {
    Object.assign(table(snapshot).entries[0]!, { extra: true });
  });
  corrupt((snapshot) => {
    keyStep(snapshot).value = 7;
  });
  corrupt((snapshot) => {
    // A handle inside a dict must refer to a timer the session issued.
    const handles = snapshot.frames[0]!.bindings.find((entry) => entry.name === "handles")?.value;
    assert.ok(typeof handles === "object" && handles !== null && handles.kind === "dict");
    const beat = handles.entries[0]!.value;
    assert.ok(typeof beat === "object" && beat !== null && beat.kind === "timerHandle");
    Object.assign(beat, { timerId: 999_999 });
  });
  corrupt((snapshot) => {
    // A key that the attached dict does not have no longer addresses its entry.
    keyStep(snapshot).value = "missing";
  });
});

test("a dict holds one value type, keyed by text, and its methods take the forms they document", () => {
  assert.deepEqual(diagnostics('let mixed = dict{ a: 1, b: "x" }\nexit'), [
    [
      "TSV044",
      "This dict mixes a whole number (integer) and text (string). A dict holds one type; to keep both, declare a union type, as in 'let mixed: (integer | string) dict = ...'.",
      'dict{ a: 1, b: "x" }',
    ],
  ]);
  assert.deepEqual(
    says('let either: (integer | string) dict = dict{ a: 1, b: "x" }\nsay either\nexit'),
    ['dict{ "a": 1, "b": "x" }'],
  );
  assert.deepEqual(codes('let c = dict{ a: 1 }\nc["b"] = "x"\nexit'), [["TSV041", '"x"']]);
  // An unannotated dict widens to numbers; a declared one stays strict.
  assert.deepEqual(says('let w = dict{ a: 1 }\nw["b"] = 2.5\nsay w\nexit'), [
    'dict{ "a": 1, "b": 2.5 }',
  ]);
  assert.deepEqual(codes('let w = dict{ a: 1 }\nw["b"] = 2.5\nlet n: integer = w["a"]\nexit'), [
    ["TSV041", 'w["a"]'],
  ]);
  assert.deepEqual(codes('let s: integer dict = dict{}\ns["a"] = 2.5\nexit'), [["TSV041", "2.5"]]);

  // The default of get must be a value the dict can hold, and it decides an undecided value type.
  assert.deepEqual(diagnostics('let c = dict{ a: 1 }\nsay c.get("a", default: "x")\nexit'), [
    [
      "TSV041",
      "'c' holds integer values (integer dict), so it cannot default to text (string). To allow both, declare it as 'let c: (integer | string) dict = ...'.",
      '"x"',
    ],
  ]);
  assert.deepEqual(codes('let e = dict{}\nsay e.get("a", default: 0)\ne["b"] = "x"\nexit'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(says('let n = dict{ a: 1 }\nsay n.get("x", default: 0.5)\nsay n\nexit'), [
    "0.5",
    'dict{ "a": 1 }',
  ]);
  // A default the compiler cannot know is checked when the script runs, also where nothing stores the result.
  assert.deepEqual(
    failure(`${DYNAMIC}let c: integer dict = dict{}\nsay c.get("z", default: dynamic("x"))\nexit`),
    ["TSR058", "A value of 'c' holds a whole number (integer), so it cannot take text (string)."],
  );
  // The result is a copy of the default: it has the default's type, but its values are its own.
  assert.deepEqual(
    says(
      [
        "let backup = []",
        "let table = dict{}",
        'let copy = table.get("missing", default: backup)',
        'copy.add("first")',
        'backup.add("text")',
        "say copy",
        "say backup",
        "exit",
      ].join("\n"),
    ),
    ['["first"]', '["text"]'],
  );
  assert.deepEqual(
    codes(
      'let backup = []\nlet table = dict{}\nlet copy = table.get("missing", default: backup)\ncopy.add(1)\nbackup.add("text")\nexit',
    ),
    [["TSV041", "1"]],
  );
  assert.deepEqual(
    diagnostics(
      'let c = dict{ a: 1 }\nsay c.get("a")\nsay c.get("a", fallback: 0)\nsay c.contains()\nc.clear(1)\nexit',
    ),
    [
      [
        "TSV020",
        "get(key, default: value) needs a 'default:' for a missing key. Read a key that must exist as dict[key].",
        'c.get("a")',
      ],
      [
        "TSV022",
        "get(...) has no parameter 'fallback'; its only named argument is 'default:'.",
        "fallback",
      ],
      ["TSV020", "contains(key) takes one key.", "c.contains()"],
      ["TSV020", "clear() takes no arguments.", "c.clear(1)"],
    ],
  );

  // Keys the source shows must differ, including computed keys whose text is known.
  assert.deepEqual(codes('let d = dict{ a: 1, "a": 2, ["${"a"}"]: 3 }'), [
    ["TSV007", '"a"'],
    ["TSV007", '"${"a"}"'],
  ]);
  assert.deepEqual(
    diagnostics(
      'let toys = dict{ collar: "x" }\ntoys.add("y")\nsay toys.first\ntoys.collar = "y"\nexit',
    ),
    [
      [
        "TSV043",
        "Dicts have no method 'add'; store a value by its key, as in dict[key] = value.",
        "add",
      ],
      [
        "TSV043",
        "Dicts have no property 'first'; use length, keys, or values, or read a value by its key, as in toys[\"first\"].",
        "first",
      ],
      [
        "TSV043",
        'Dicts have no properties to assign. Store a value by its key, as in dict["collar"] = value.',
        "toys",
      ],
    ],
  );
  assert.deepEqual(codes('function f(maybe: string dict?) {\n    say maybe["a"]\n}\nexit'), [
    ["TSV043", "maybe"],
  ]);
});

test("objects keep fixed properties, and dicts are not choices", () => {
  assert.deepEqual(
    diagnostics('let door = { name: "x" }\nlet k = "name"\nsay door[k]\nsay door["name"]\nexit'),
    [
      ["TSV043", "Objects have fixed properties. Use a dict to look up by name.", "k"],
      [
        "TSV043",
        "Objects have fixed properties. Use a dict to look up by name. Read a fixed property as 'door.name'.",
        '"name"',
      ],
    ],
  );
  assert.deepEqual(codes('let pick = choose dict{ a: "x" }\nexit'), [["TSV029", 'dict{ a: "x" }']]);
  assert.deepEqual(codes("let dict = 1"), [["TSV001", "dict"]]);
});

test("is dict and is T dict test the values, and typed parameters take dicts", () => {
  assert.deepEqual(
    says(
      [
        DYNAMIC,
        "let v = dynamic(dict{ a: 1 })",
        "say v is dict",
        "say v is integer dict",
        "say v is string dict",
        "say dynamic({ a: 1 }) is dict",
        "say dynamic(dict{}) is string dict",
        "function total(points: integer dict): integer {",
        "    let subtotal = 0",
        "    for key in points {",
        "        subtotal += points[key]",
        "    }",
        "    return subtotal",
        "}",
        "say total(dict{ a: 1, b: 2 })",
        "exit",
      ].join("\n"),
    ),
    ["true", "true", "false", "false", "true", "3"],
  );
  assert.deepEqual(
    codes(
      'function total(points: integer dict): integer {\n    return points.length\n}\nsay total(dict{ a: "x" })\nexit',
    ),
    [["TSV041", '"x"']],
  );
});
