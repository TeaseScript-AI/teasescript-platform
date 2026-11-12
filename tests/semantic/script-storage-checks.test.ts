/*
 * The compiler's reading of storage: `save`, `load` and `delete` syntax, its checks, and the syntax cases a run
 * witnesses (where a bounded load ends, quoted load operands inside interpolation). The O4 lead's half of the storage
 * tests; the runtime protocol stays in `runtime/persistence/script-storage.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  compileSource,
  completeAction,
  createFreshRuntimeSnapshot,
  run,
  type RuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../../src/index.js";
import { parse } from "../../src/parser.js";
import { compileValidPlan as plan } from "../helpers/compile-valid-plan.js";
import { assertRuntimeResumeEquivalent } from "../helpers/runtime-equivalence.js";

const keyMessage = "Storage key must be a string.";
const loadKeyMessage =
  "Storage key must be a string. To compare the loaded value, write 'let value: string? = load(\"k\", default: null)', then 'value == null'.";

function binding(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const found = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(found !== undefined, `binding ${name} exists`);
  return found.value;
}

test("a bounded or grouped load compares the loaded value; a compact comparison gets TSV038 and its hint", () => {
  const result = assertRuntimeResumeEquivalent(
    'let absent = load("k" + "", default: null) == null\nlet grouped = (load "k" + "", default: null) == null\nexit',
  );
  assert.equal(binding(result.finalSnapshot, "absent"), true);
  assert.equal(binding(result.finalSnapshot, "grouped"), true);
  const invalid = compileSource('let absent = load "k" == null');
  assert.equal(invalid.plan, null);
  // The load without default: leaves the type check its basis, which reports the key and the constant comparison.
  assert.deepEqual(
    invalid.diagnostics.map(({ code }) => code),
    ["TSV020", "TSV046", "TSV038"],
  );
  assert.equal(invalid.diagnostics[2]?.message, loadKeyMessage);
});

test("a bounded load ends at its ')', also with a space before '(' and options on several lines", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      'save 2 as "n"',
      'save [10, 20] as "list"',
      'save { name: "Ada" } as "record"',
      'function key(prefix) { return "${prefix}st" }',
      'let total = load ("n", default: 0) + 1',
      'let fallbackSum = load("missing", default: 3) * 2',
      'let second = load(key("li"), default: null)[1]',
      'let name = load("record" + "", default: null).name',
      'let nested = load("missing", default: load("list" + "", default: null))[0]',
      "let multiline = load(",
      '    "missing",',
      '    default: load("n" + "", default: null)',
      ")",
      'let record = { value: load("missing" + "", default: null), default: 1 }',
      'let text = "${load("record", default: { name: "none" }).name}"',
      "exit",
    ].join("\n"),
  );
  const bound = (name: string) => binding(result.finalSnapshot, name);
  assert.equal(bound("total"), 3);
  assert.equal(bound("fallbackSum"), 6);
  assert.equal(bound("second"), 20);
  assert.equal(bound("name"), "Ada");
  assert.equal(bound("nested"), 10);
  assert.equal(bound("multiline"), 2);
  // The `default` after `)` is a property of the record, not a fallback.
  assert.deepEqual(bound("record"), {
    kind: "object",
    properties: [
      { name: "value", value: null },
      { name: "default", value: 1 },
    ],
  });
  assert.equal(bound("text"), "Ada");
});

test("a bounded load takes one key and the option 'default:', and names what is wrong", () => {
  const diagnostics = (source: string) =>
    compileSource(`${source}\nlet = 1\nexit`).diagnostics.map(
      (item) => `${item.code} ${item.span.start.line}:${item.span.start.column} ${item.message}`,
    );
  // Each case ends with the error of the next statement, which shows that parsing recovered.
  const next = "TSP013 1:4 Expected a variable identifier after 'let'.";
  for (const [source, error] of [
    [
      "let v = load()",
      "TSP036 0:8 Expected a storage key in 'load(...)', such as 'load(\"name\", default: \"\")'.",
    ],
    [
      "let v = load(default: 1)",
      "TSP036 0:8 Expected a storage key in 'load(...)', such as 'load(\"name\", default: \"\")'.",
    ],
    [
      'let v = load("k", "j")',
      "TSP040 0:18 load(...) takes one unnamed value. Name the others, such as 'default:'.",
    ],
    [
      'let v = load("k", fallback: 1)',
      "TSP040 0:18 Unknown load option 'fallback'. Use 'default:'.",
    ],
    ['let v = load("k", default: 1, default: 2)', "TSP040 0:30 Duplicate load option 'default'."],
    // The earlier grouped-key fallback is now a bounded load followed by a stray option.
    ['let v = load ("k"), default: 1', "TSP002 0:18 Expected a newline after the statement."],
  ] as const) {
    assert.deepEqual(diagnostics(source), [error, next], source);
  }
});

test("statically non-string storage keys get TSV038 after unwrapping parentheses", () => {
  for (const key of [
    "1",
    "1 s",
    "true",
    "null",
    "[]",
    "set[]",
    "{ item: 1 }",
    "1..=2",
    "-1",
    "not true",
    '"a" == "b"',
    '"a" != "b"',
    "1 < 2",
    "1 <= 2",
    "1 > 2",
    "1 >= 2",
    "true and false",
    "true or false",
    "timer async 1 s",
    'playAudio async "a.mp3"',
  ]) {
    for (const [source, message] of [
      [`let value = load(((${key})), default: null)`, loadKeyMessage],
      [`save 0 as ((${key}))`, keyMessage],
      [`delete ((${key}))`, keyMessage],
    ] as const) {
      const compiled = compileSource(source);
      assert.equal(compiled.plan, null, source);
      assert.deepEqual(
        compiled.diagnostics.map(({ code, message: text }) => [code, text]),
        [["TSV038", message]],
        source,
      );
    }
  }
});

test("compact interactions end at the save 'as', and a grouped load key leaves the fallback to load", () => {
  const compiled = plan(
    [
      'save askText as "bare"',
      'save askText "Your name?" as "name"',
      'save load "nick", default: askText "Nickname?" as "nick"',
      'let pick = load((askChoice first: "a", second: "b"), default: "fallback")',
      "exit",
    ].join("\n"),
  );
  let result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled, { scriptStorage: [{ key: "second", value: "stored" }] }),
  );
  for (const answer of ["Bare", "Ada", "Addy"]) {
    const action = result.snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction" && action.interactionKind === "text", answer);
    const completed = completeAction(compiled, result.snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: answer },
    });
    result = run(compiled, completed.snapshot);
  }
  assert.deepEqual(result.snapshot.scriptStorage, [
    { key: "bare", value: "Bare" },
    { key: "name", value: "Ada" },
    { key: "nick", value: "Addy" },
    { key: "second", value: "stored" },
  ]);
  const choice = result.snapshot.foregroundAction;
  assert.ok(choice?.kind === "interaction" && choice.interactionKind === "choice");
  const chosen = completeAction(compiled, result.snapshot, {
    actionId: choice.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 1 },
  });
  const finished = run(compiled, chosen.snapshot);
  assert.equal(finished.snapshot.status, "halted");
  assert.equal(binding(finished.snapshot, "pick"), "stored");

  // A present key never prompts; its stored value is saved again.
  const present = plan('save load "nick", default: askText "Nickname?" as "nick"\nexit');
  const rerun = run(
    present,
    createFreshRuntimeSnapshot(present, { scriptStorage: [{ key: "nick", value: "Addy" }] }),
  );
  assert.equal(rerun.snapshot.status, "halted");
  assert.deepEqual(rerun.snapshot.scriptStorage, [{ key: "nick", value: "Addy" }]);

  // Inside a save value, `as` belongs to save; a speaker clause needs parentheses.
  const speakerSource = 'speaker mistress {\n  name: "M"\n}\n';
  assert.notEqual(
    compileSource(`${speakerSource}save (askText as mistress "Name?") as "name"\nexit`).plan,
    null,
  );
  assert.deepEqual(
    compileSource(`${speakerSource}let name = askText "Your name?" as mistress`).diagnostics.map(
      ({ code }) => code,
    ),
    ["TSP032"],
  );
});

test("load takes its fallback as ', default:', and the earlier form names the fix", () => {
  const diagnostics = (source: string) =>
    compileSource(source).diagnostics.map(
      (item) => `${item.code} ${item.span.start.column + 1} ${item.message}`,
    );
  const fix =
    "TSP017 18 Write a fallback for load as 'load key, default: value', with a comma and a colon.";

  assert.deepEqual(diagnostics('let v = load "k" default 1'), [fix]);
  assert.deepEqual(diagnostics('let v = load "k" default: 1'), [fix]);
  assert.deepEqual(diagnostics('let v = load "k", default:'), [
    "TSP012 27 Expected a fallback value after 'default:'.",
  ]);
  // The fix is named after a choice key and inside interpolation too.
  assert.equal(
    diagnostics('let v = load askChoice a: "x", b: "y" default "z"')[0],
    "TSP017 39 Write a fallback for load as 'load key, default: value', with a comma and a colon.",
  );
  assert.equal(
    diagnostics('let v = "${load "k" default "x"}"')[0],
    "TSP017 21 Write a fallback for load as 'load key, default: value', with a comma and a colon.",
  );
  // A missing fallback leaves the next statement intact.
  const missing = parse('let v = load "k", default:\nlet ok = 1');
  assert.deepEqual(
    missing.diagnostics.map((item) => item.code),
    ["TSP012"],
  );
  assert.equal(missing.program.statements.length, 2);
});

test("a ', default:' belongs to the nearest load before it, and is an error after a compact ask", () => {
  const initializer = (source: string) => {
    const [statement] = parse(source).program.statements;
    assert.ok(statement?.kind === "letStatement");
    return statement.initializer;
  };

  // An ask's starting answer is its `prefill:`; its earlier `default:` is an error that names the fix, also in a load
  // key, where grouping gives the fallback to load.
  assert.deepEqual(
    parse('let v = load askText "Key?", default: "x"').diagnostics.map(
      (diagnostic) => diagnostic.message,
    ),
    ["askText has no 'default:'. Use 'prefill:'."],
  );
  const askKey = initializer('let v = load((askText "Key?"), default: "x")');
  assert.ok(askKey.kind === "loadExpression" && askKey.defaultValue !== null);

  const loadDefault = initializer('let v = askText "Name?", prefill: load "name", default: "Ada"');
  assert.ok(loadDefault.kind === "interactionExpression");
  assert.ok(loadDefault.prefill?.kind === "loadExpression");
  assert.equal(loadDefault.prefill.defaultValue?.kind, "stringLiteral");

  const list = initializer('let v = [load "a", default: 1, 2]');
  assert.ok(list.kind === "listLiteral" && list.elements.length === 2);
  assert.ok(list.elements[0]?.kind === "loadExpression" && list.elements[0].defaultValue !== null);

  // Inside delimiters a line break does not end the expression, so a comma on the next line binds the same way; outside
  // them a line may not start with a comma (V30 §2).
  const object = initializer('let v = {first: load "k"\n, default: "x"}');
  assert.ok(object.kind === "objectLiteral" && object.properties.length === 1);
  const grouped = initializer('let v = (load "k"\n, default: 7)');
  assert.ok(grouped.kind === "parenthesizedExpression");
  assert.ok(
    grouped.expression.kind === "loadExpression" && grouped.expression.defaultValue !== null,
  );
  assert.notDeepEqual(parse('let v = load "k"\n, default: 7').diagnostics, []);
  // Every `()` list counts, also function parameters and say presentation options.
  for (const source of [
    'function f(x = load "k"\n, default: 7) { return x }\nsay f()\nexit',
    'say bubble(color: load "color"\n, default: "red") "Hi", instant\nexit',
  ])
    assert.deepEqual(compileSource(source).diagnostics, [], source);

  // By the same rule, a compact choice takes `default:` as its own option label; grouping gives the fallback to load.
  for (const source of [
    'let v = load askChoice a: "x", b: "y", default: "z"',
    'let v = (load askChoice a: "x", b: "y"\n, default: "z")',
  ]) {
    let labelled = initializer(source);
    if (labelled.kind === "parenthesizedExpression") labelled = labelled.expression;
    assert.ok(labelled.kind === "loadExpression" && labelled.defaultValue === null, source);
    assert.ok(labelled.key.kind === "interactionExpression", source);
    assert.equal(labelled.key.options.length, 3, source);
  }
  const choiceKey = initializer('let v = load((askChoice a: "x", b: "y"), default: "z")');
  assert.ok(choiceKey.kind === "loadExpression" && choiceKey.defaultValue !== null);
});

test("compact interactions parse in every storage operand position", () => {
  const prelude =
    'speaker mistress {\n  name: "M"\n}\nfunction wrap(value) { return "${value}" }\n';
  const values = [
    "askText",
    'askText "Hint?"',
    "askNumber",
    'askNumber "Age?"',
    'askChoice "a", "b"',
    'askChoice default: "A", other: "B"',
    '(askText as mistress "Hint?")',
    '(askChoice as mistress "a", "b")',
    '"${askText}"',
    "wrap(askNumber)",
    'timer(duration: 1 s, async: true, label: askText as mistress "Label?").state',
    'playAudio(file: askText as mistress "File?", async: true).state',
  ];
  // `true` marks a storage key position, where a number answer is a type error rather than a parse error.
  const positions: readonly (readonly [(value: string) => string, boolean])[] = [
    [(value) => `save ${value} as "k"`, false],
    [(value) => `save [${value}] as "k"`, false],
    // A `, default:` after an ungrouped interaction would be a choice label or an ask's error, so these keys are grouped.
    [(value) => `let v = load((${value}), default: "d")`, true],
    [(value) => `let v = load "k", default: ${value}`, false],
    [(value) => `save load "k", default: ${value} as "k"`, false],
    [(value) => `save load((${value}), default: "d") as "k"`, true],
  ];
  for (const value of values) {
    for (const [position, key] of positions) {
      const source = position(value);
      const compiled = compileSource(`${prelude}${source}\nexit`);
      const numberKey = key && value.startsWith("askNumber");
      assert.deepEqual(
        compiled.diagnostics.map((diagnostic) => diagnostic.code),
        numberKey ? ["TSV038"] : [],
        source,
      );
    }
  }
});

test("load operands may be quoted strings inside interpolation", () => {
  const result = assertRuntimeResumeEquivalent(
    'save "Ada" as "k"\nlet key = "missing"\nlet present = "${load "k" + "", default: null}"\nlet absent = "${load key, default: "fallback"}"\nexit',
  );
  assert.equal(binding(result.finalSnapshot, "present"), "Ada");
  assert.equal(binding(result.finalSnapshot, "absent"), "fallback");
});

test("a member named load or default does not start a nested string in interpolation", () => {
  const diagnostics = (member: string) =>
    compileSource(
      `let obj = { load: "Ada", default: "fallback", name: "Bo" }\nsay "\${obj.${member}"\nlet after = 7\nexit`,
    ).diagnostics.map(({ code }) => code);
  // Recovery from the malformed interpolation matches an ordinary member name.
  assert.deepEqual(diagnostics("load"), diagnostics("name"));
  assert.deepEqual(diagnostics("default"), diagnostics("name"));
});
