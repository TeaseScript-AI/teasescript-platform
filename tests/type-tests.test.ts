import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";
import { run } from "../src/runtime/engine.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../src/runtime/script-storage.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";

function diagnostics(source: string): [string, string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function errors(source: string): [string, string][] {
  return diagnostics(source)
    .filter(([severity]) => severity === "error")
    .map(([, code, , text]) => [code, text]);
}

function sayTexts(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return result.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

/** Hides a value's type from the compiler, so a test decides it at runtime. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

test("a type test is true exactly when the value may be stored in a place of that type", () => {
  const cases: readonly (readonly [value: string, type: string, expected: boolean])[] = [
    ['"a"', "string", true],
    ["5", "integer", true],
    ["2.0", "integer", true],
    ["2.5", "integer", false],
    ["5", "number", true],
    ["true", "boolean", true],
    ["2 s", "duration", true],
    ["null", "null", true],
    ["null", "integer?", true],
    ["5", "integer?", true],
    ['"a"', "integer | string", true],
    ["[1, 2]", "integer[]", true],
    ["[1, 2.5]", "integer[]", false],
    ["[]", "integer[]", true],
    ["mixed", "(integer | string)[]", true],
    ["mixed", "integer[] | string[]", false],
    ["[1]", "list", true],
    ['set["a"]', "string set", true],
    ["set[1]", "set", true],
    ["{ a: 1 }", "object", true],
    ["1..3", "range", true],
    ["[1]", "object", false],
    ['"2026-01-01"', "date", false],
  ];
  const source =
    DYNAMIC +
    'let mixed: (integer | string)[] = [1, "a"]\n' +
    cases
      .map(
        ([value, type], index) =>
          `let v${index} = dynamic(${value})\nsay "\${v${index} is ${type}}"`,
      )
      .join("\n") +
    "\nexit";
  assert.deepEqual(
    sayTexts(source),
    cases.map(([, , expected]) => String(expected)),
  );
  assert.deepEqual(
    sayTexts(
      `${DYNAMIC}speaker vera {}\nlet voice = dynamic(vera)\nlet clock = dynamic(timer async 5)\nsay "\${voice is speaker} \${clock is timer} \${clock is media} \${voice is not speaker}"\nexit`,
    ),
    ["true true false false"],
  );
});

test("a type test evaluates its operand once and never changes it", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      DYNAMIC,
      "let count = 0",
      "function next {\n    count += 1\n    return count\n}",
      'let first = dynamic(next()) is integer\nsay "${first} ${count}"',
      "let items = [1, 2]",
      'let typed = dynamic(items) is integer[]\nsay "${typed} ${items.length}"',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(
    result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["true 1", "true 2"],
  );
});

test("a test on a value of unknown type narrows it, for example a loaded value", () => {
  const source = [
    'let saved = load "level"',
    "let level = 1",
    "if saved is integer {",
    "    level = saved",
    "} else {",
    '    say "Your saved level was invalid, starting over."',
    "}",
    'say "${level}"',
    "exit",
  ].join("\n");
  assert.deepEqual(errors(source), []);
  const compiled = compileSource(source).plan!;
  const run_ = (value: RuntimeScriptStorageEntrySnapshot["value"]) =>
    run(
      compiled,
      createFreshRuntimeSnapshot(compiled, {
        scriptStorage: [{ key: "level", value }],
        baseDelayMs: 0,
        delayPerWordMs: 0,
        delayPerCharacterMs: 0,
      }),
    ).events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  assert.deepEqual(run_(7), ["7"]);
  assert.deepEqual(run_("high"), ["Your saved level was invalid, starting over.", "1"]);
});

test("if, else, and, or, while, and early exits narrow a plain variable", () => {
  const union = 'let reward: integer | string = 10\nif chance(50) {\n    reward = "long"\n}\n';
  for (const body of [
    'if reward is integer {\n    say "${reward + 1}"\n} else {\n    let s: string = reward\n}',
    "if reward is not integer {\n    let s: string = reward\n} else {\n    let n: integer = reward\n}",
    "let big = reward is integer and reward > 3",
    "let small = reward is string or reward < 3",
    "while reward is integer {\n    reward = reward + 1\n    if reward > 3 {\n        break\n    }\n}",
    "if reward is string {\n    exit\n}\nlet n: integer = reward",
    "function f(x: integer | string): integer {\n    if x is string {\n        return 0\n    }\n    return x + 1\n}",
    'let maybe: string? = null\nif chance(50) {\n    maybe = "x"\n}\nif maybe != null and maybe == "x" {\n    say maybe\n}',
  ])
    assert.deepEqual(errors(`${union}${body}\nexit`), [], body);
});

test("tests overlap: an else branch keeps what the test cannot exclude", () => {
  assert.deepEqual(
    errors(
      "let r: number = 2.5\nif r is integer {\n    let i: integer = r\n} else {\n    let n: number = r\n}\nexit",
    ),
    [],
  );
  assert.deepEqual(
    errors(
      "let r: number = 2.5\nif chance(50) {\n    r = 2\n}\nif r is not integer {\n    let i: integer = r\n}\nexit",
    ),
    [["TSV041", "r"]],
  );
});

test("only plain variables narrow, and a call, wait, or shared assignment cancels narrowing", () => {
  const union = 'let v: integer | string = 1\nif chance(50) {\n    v = "y"\n}\n';
  const change = 'function change {\n    v = "x"\n}\n';
  // A function that may assign `v` runs, so the test no longer holds.
  assert.deepEqual(
    errors(`${union}${change}if v is integer {\n    change()\n    let i: integer = v\n}\nexit`),
    [["TSV041", "v"]],
  );
  assert.deepEqual(
    errors(`${union}${change}if v is integer {\n    wait 1\n    let i: integer = v\n}\nexit`),
    [["TSV041", "v"]],
  );
  // Nothing else assigns `v`, so a wait keeps it narrowed.
  assert.deepEqual(
    errors(`${union}if v is integer {\n    wait 1\n    let i: integer = v\n}\nexit`),
    [],
  );
  // At most one block of a `switch` runs: each starts from the facts before it, and they meet after it.
  const cases = (blocks: string) =>
    `${union}let n = 2\nif v is integer {\n    switch n {\n${blocks}    }\n`;
  assert.deepEqual(
    errors(
      `${cases('        case 1 {\n            v = "s"\n        }\n        case 2 {\n            let i: integer = v\n        }\n')}}\nexit`,
    ),
    [],
  );
  assert.deepEqual(
    errors(
      `${cases('        case 1 {\n            v = "s"\n        }\n')}    let i: integer = v\n}\nexit`,
    ),
    [["TSV041", "v"]],
  );
  assert.deepEqual(
    errors(
      `${cases("        case 1 {\n            v = 2\n        }\n        default {\n            v = 3\n        }\n")}    let i: integer = v\n}\nexit`,
    ),
    [],
  );
  // An assignment in a `switch` inside a loop cancels narrowing at the loop's start.
  assert.deepEqual(
    errors(
      `${union}let n = 2\nif v is integer {\n    repeat 2 {\n        let i: integer = v\n        switch n {\n            case 1 {\n                v = "z"\n            }\n        }\n    }\n}\nexit`,
    ),
    [["TSV041", "v"]],
  );
  // A button used as a value waits for the player too, also inside a loop condition.
  const timer = 'timer async 1 s {\n    v = "x"\n}\n';
  assert.deepEqual(
    errors(
      `${union}${timer}if v is integer {\n    let pressed = showButton "Go"\n    let i: integer = v\n}\nexit`,
    ),
    [["TSV041", "v"]],
  );
  assert.deepEqual(
    errors(
      `${union}${timer}if v is integer {\n    while (showButton "Go") < 1 s {\n        let i: integer = v\n    }\n}\nexit`,
    ),
    [["TSV041", "v"]],
  );
  // An assignment in a loop cancels narrowing at the loop's start.
  assert.deepEqual(
    errors(
      `${union}if v is integer {\n    repeat 2 {\n        let i: integer = v\n        v = "z"\n    }\n}\nexit`,
    ),
    [["TSV041", "v"]],
  );
  // A property or element does not narrow.
  assert.deepEqual(
    errors(
      "let box = { value: 1 }\nlet items: (integer | string)[] = [1]\nif items[0] is integer {\n    let i: integer = items[0]\n}\nexit",
    ),
    [["TSV041", "items[0]"]],
  );
  // A function body does not inherit narrowed facts.
  assert.deepEqual(
    errors(
      `${union}if v is integer {\n    say "x"\n}\nfunction f {\n    let i: integer = v\n}\nexit`,
    ),
    [["TSV041", "v"]],
  );
  // Changing an element through a call or in an earlier iteration changes the collection, so its element type is
  // checked again at runtime; a test in each iteration keeps it known.
  const list = "let xs: list = [1]\n";
  for (const body of [
    'function change {\n    xs[0] = "x"\n}\nif xs is integer[] {\n    change()\n    let n: integer = xs[0]\n}',
    'if xs is integer[] {\n    repeat 2 {\n        let n: integer = xs[0]\n        xs[0] = "x"\n    }\n}',
    'function change {\n    (xs.add)("x")\n}\nif xs is integer[] {\n    change()\n    let n: integer = xs[1]\n}',
  ])
    assert.equal(runValidSource(`${list}${body}\nexit`).snapshot.failure?.code, "TSR058", body);
  assert.equal(
    runValidSource(
      `${list}repeat 2 {\n    if xs is integer[] {\n        let n: integer = xs[0]\n    }\n    xs[0] = "x"\n}\nexit`,
    ).snapshot.failure,
    null,
  );
});

test("media pacing and loading, and handle writes, cancel narrowing where a handler may run", () => {
  const shared = 'let reward: integer | string = 1\ntimer async 1 {\n    reward = "changed"\n}\n';
  const music = 'let music = playAudio async "a.mp3"\n';
  for (const body of [
    'if reward is integer {\n    let clip = playAudio async "a.mp3"\n    let result: integer = reward\n}',
    `${music}if reward is integer {\n    music.pause()\n    let result: integer = reward\n}`,
    // A media volume write waits for pacing before its value is evaluated.
    `${music}if reward is integer {\n    music.volume = reward\n}`,
    "function finish(handle: timer | media) {\n    if reward is integer {\n        handle.remaining = 0 s\n        let result: integer = reward\n    }\n}",
  ])
    assert.deepEqual(errors(`${shared}${body}\nexit`), [["TSV041", "reward"]], body);
});

test("takePhoto() gives text or null and cancels narrowing while the Player captures", () => {
  const shared = 'let reward: integer | string = 1\ntimer async 1 {\n    reward = "changed"\n}\n';
  assert.deepEqual(
    errors(
      `${shared}if reward is integer {\n    let photo = takePhoto()\n    let result: integer = reward\n}\nexit`,
    ),
    [["TSV041", "reward"]],
  );
  assert.deepEqual(errors("let photo: string? = takePhoto()\nexit"), []);
  assert.deepEqual(errors("let photo: number = takePhoto()\nexit"), [["TSV041", "takePhoto()"]]);
});

test("a break keeps what is known where it happens, and exhaustive tests end a function", () => {
  assert.deepEqual(
    errors(
      "function pick(value: integer | string): integer {\n    while true {\n        break\n        value = 1\n    }\n    return value\n}\nexit",
    ),
    [["TSV041", "value"]],
  );
  assert.deepEqual(
    errors(
      'function f(x: integer | string): integer {\n    if x is integer {\n        return x\n    }\n    if x is string {\n        return 0\n    }\n}\nlet answer = f("x")\nexit',
    ),
    [],
  );
});

test("tests on undecided places and on collections keep every value that may pass", () => {
  // A place decided only by a value of unknown type takes the tested type.
  assert.deepEqual(
    errors(
      `${DYNAMIC}let x = null\nx = dynamic(1)\nif x is integer {\n    let text: string = x\n}\nexit`,
    ),
    [["TSV041", "x"]],
  );
  // An empty list passes a test of any element type, and element unions overlap member by member.
  assert.deepEqual(sayTexts('let xs: integer[] = []\nsay "${xs is string[]}"\nexit'), ["true"]);
  assert.deepEqual(
    sayTexts(
      'function f(xs: (integer | string)[]) {\n    say "${xs is (integer | boolean)[]}"\n}\nf([1])\nexit',
    ),
    ["true"],
  );
  // A test is not a first value: an empty list or set still takes its element type from the first one stored.
  for (const source of [
    'let xs = []\nif xs is string[] {\n    say "empty"\n}\nxs.add(1)\nexit',
    "let xs = []\nif xs is string[] {\n    xs.add(1)\n}\nexit",
    "let xs = set[]\nif xs is string set {\n    xs.add(1)\n}\nexit",
  ])
    assert.deepEqual(errors(source), [], source);
  // A first store that fits the test still decides the element type, so a later store of another type fails.
  for (const test of ["integer[]", "(integer | string)[]"])
    assert.deepEqual(
      errors(`let xs = []\nif xs is ${test} {\n    xs.add(1)\n}\nxs.add("x")\nexit`),
      [["TSV041", '"x"']],
      test,
    );
});

test("a write that may break a narrowed collection, and an impossible test outcome, are followed exactly", () => {
  // An element of unknown type may not keep `xs is integer[]`, so the next read is checked again at runtime.
  assert.equal(
    runValidSource(
      `${DYNAMIC}let xs: list = [1]\nif xs is integer[] {\n    xs.add(dynamic("x"))\n    let n: integer = xs[1]\n}\nexit`,
    ).snapshot.failure?.code,
    "TSR058",
  );
  // A store the narrowed type does not cover is checked against the declared type and ends the element fact, while a
  // test that excluded null still holds.
  assert.deepEqual(
    errors(
      "let p: number[] = [1.5]\nif p is integer[] {\n    p.add(1.5)\n    let k: integer = p.last\n}\nexit",
    ),
    [["TSV041", "p.last"]],
  );
  assert.deepEqual(
    errors(
      "function f(items: integer[]?) {\n    if items != null {\n        items.add(2)\n        items[0] += 1\n        say items.first\n    }\n}\nexit",
    ),
    [],
  );
  // A call while a store is evaluated ends the test's facts but not the variable's type, which takes the store.
  assert.deepEqual(
    errors(
      "let p: number[] = [1]\nfunction amount {\n    p.add(2)\n    return 1.5\n}\nif p is integer[] {\n    p.add(amount())\n}\nexit",
    ),
    [],
  );
  for (const body of [
    "while true {\n        if x is string {\n            break\n        }\n        return 1\n    }",
    "if x is string or true {\n        return 1\n    }",
  ])
    assert.deepEqual(
      errors(`function f(x: integer): integer {\n    ${body}\n}\nsay "\${f(1)}"\nexit`),
      [],
      body,
    );
});

test("a type test inside parentheses or brackets continues before '|', and 'is' explains a set value", () => {
  for (const [before, after] of [
    ["let passed = (", ')\nsay "${passed}"'],
    ['function show(value) {\n    say "${value}"\n}\nshow(', ")"],
    ["let passed = [", ']\nsay "${passed[0]}"'],
  ])
    assert.deepEqual(
      sayTexts(`${DYNAMIC}${before}dynamic(1) is integer\n    | string${after}\nexit`),
      ["true"],
    );
  // Parameter defaults and named arguments are inside parentheses too; a block or text inside them is not.
  for (const source of [
    'function show(passed = 1 is integer\n    | string) {\n    say "${passed}"\n}\nshow()\nexit',
    'let m = playAudio(file: "a.mp3", async: true, repeat: 1 is integer\n    | string)\nexit',
    'let m = (playAudio async "a.mp3" {\n    let passed = 1 is integer\n    [1].removeLast()\n})\nexit',
  ])
    assert.deepEqual(errors(source), [], source);
  assert.notDeepEqual(errors('let t = (timer async 0 """${1 is integer\n    | string}""")'), []);
  assert.deepEqual(diagnostics("let x = set[1]\nlet passed = x is set[1]"), [
    ["error", "TSP021", "'is' checks a type; use '==' to compare values.", "set[1]"],
  ]);
});

test("an assignment narrows the variable to the assigned value's type", () => {
  assert.deepEqual(errors("let reward: integer | string = 10\nlet points = reward + 1\nexit"), []);
  assert.deepEqual(
    errors(
      'let reward: integer | string = 10\nreward = "x"\nlet points = reward + 1\nexit',
    )[0]?.[0],
    "TSV043",
  );
  // A variable of unknown type takes a copy of the assigned value's type: each object then gets its own properties.
  assert.deepEqual(
    sayTexts(
      'let given = {}\nlet loaded = load "k"\nloaded = given\nloaded.flag = 1\ngiven.flag = true\nsay loaded\nsay given\nexit',
    ),
    ["{ flag: 1 }", "{ flag: true }"],
  );
  assert.deepEqual(
    errors(
      'let given = { flag: true }\nlet loaded = load "k"\nloaded = given\nloaded.flag = 1\nexit',
    ),
    [["TSV041", "1"]],
  );
  // What a test guarantees does not depend on a variable that widens later: a whole number stays whole there.
  for (const guard of [
    "if v is integer {\n    x = v\n}",
    "if p is integer[] {\n    x = p.first\n}",
  ])
    assert.deepEqual(
      errors(`let v = 0\nlet p = [v]\nlet x = 0\n${guard}\nv = 0.5\nlet k: integer = x\nexit`),
      [],
      guard,
    );
  assert.deepEqual(
    errors(
      "let v = 0\nlet x = 0\nif v is number {\n    x = v\n}\nv = 0.5\nlet k: integer = x\nexit",
    ),
    [["TSV041", "x"]],
  );
  // An element that may be null keeps its whole numbers apart from null.
  const nullable = (guard: string) =>
    errors(
      `let v = 0\nlet p = [v, null]\nlet x = null\n${guard}\nv = 0.5\nif x != null {\n    let k: integer = x\n}\nexit`,
    );
  for (const test of ["integer?[]", "(integer | null)[]"])
    assert.deepEqual(nullable(`if p is ${test} {\n    x = p.first\n}`), [], test);
  assert.deepEqual(nullable("if p is number?[] {\n    x = p.first\n}"), [["TSV041", "x"]]);
  // Relaxing the narrowing of an object keeps the object, so a later read is still checked.
  assert.deepEqual(
    errors(
      'let names = ["a", "b"]\nlet p = { xs: [1.5] }\nif p is object {\n    p.xs.add(1.5)\n}\nsay names[p.xs.last]\nexit',
    ),
    [["TSV043", "p.xs.last"]],
  );
});

test("a type test continues after 'is', and a type inside parentheses continues before '|' or '[]'", () => {
  const source = `function show(value: integer
    | string[]) {
    let whole = value is
        not string[]
    say "\${whole}"
}
let tags: (integer
    | string
    []) = ["a"]
show(tags)
show(2)
exit`;
  assert.deepEqual(sayTexts(source), ["false", "true"]);
});

test("is checks a type, and a provably constant test is a warning", () => {
  // Also for a value in an interpolation or in parentheses; '||' after a test is the symbolic 'or'.
  const valueTest = "'is' checks a type; use '==' to compare values.";
  assert.deepEqual(
    diagnostics(
      'let mood = "happy"\nif mood is "happy" {\n    say "x"\n}\nsay "${mood is "happy"}"\nlet same = mood is ("happy")\nlet both = mood is string || false',
    ),
    [
      ["error", "TSP021", valueTest, '"happy"'],
      ["error", "TSP021", valueTest, '"happy"'],
      ["error", "TSP021", valueTest, '("happy")'],
      [
        "error",
        "TSP037",
        "Use 'or' to combine conditions. '|' only separates the types of a union, as in 'integer | string'.",
        "||",
      ],
    ],
  );
  assert.deepEqual(
    errors("let x: integer | string = 1\nlet y = x is integer is boolean")[0]?.[0],
    "TSP020",
  );
  assert.deepEqual(diagnostics("let n = 5\nlet a = n is number\nlet b = n is string\nexit"), [
    [
      "warning",
      "TSV046",
      "'n' always holds a whole number (integer), so this test is always true.",
      "n is number",
    ],
    [
      "warning",
      "TSV046",
      "'n' holds a whole number (integer), never string, so this test is always false.",
      "n is string",
    ],
  ]);
  // A number may still be whole, and a value of unknown type may be anything.
  assert.deepEqual(
    diagnostics('let r = 2.5\nlet a = r is integer\nlet s = load "s"\nlet b = s is integer\nexit'),
    [],
  );
  assert.notEqual(compileSource("let n = 5\nlet a = n is number\nexit").plan, null);
});

test("a comparison with a value the other side can never hold is a warning, like a constant test", () => {
  assert.deepEqual(
    diagnostics(
      'let s = "a"\nlet a = s != null\nlet n: integer = 5\nlet b = n == null\nlet c = s == n\nexit',
    ),
    [
      [
        "warning",
        "TSV046",
        "'s' holds text (string), never null, so this comparison is always true.",
        "s != null",
      ],
      [
        "warning",
        "TSV046",
        "'n' holds a whole number (integer), never null, so this comparison is always false.",
        "n == null",
      ],
      [
        "warning",
        "TSV046",
        "'s' holds text (string), never a whole number (integer), so this comparison is always false.",
        "s == n",
      ],
    ],
  );
  // A list is a list before its element type is decided.
  assert.deepEqual(diagnostics("let items = []\nlet empty = items == null\nexit"), [
    [
      "warning",
      "TSV046",
      "'items' holds a list, never null, so this comparison is always false.",
      "items == null",
    ],
  ]);
  // Values that may be equal stay silent: whole and other numbers, two possibly null values, two lists that may both
  // be empty, and a value the compiler cannot know.
  assert.deepEqual(
    diagnostics(
      [
        "function f(i: integer, r: number, p: integer?, q: string?, l: integer[], m: string[]) {",
        "  let a = i == r",
        "  let b = p == q",
        "  let c = l == m",
        "  let d = p != null",
        "}",
        'let u = load "u"',
        "let e = u == 5",
        "exit",
      ].join("\n"),
    ),
    [],
  );
});

/** The first plan object of `kind`, with its validator path such as `$.instructions[2].value`. */
function findKind(
  value: unknown,
  kind: string,
  path = "$",
): { readonly path: string; readonly node: object } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("kind" in value && value.kind === kind) return { path, node: value };
  for (const [key, item] of Object.entries(value)) {
    const found = findKind(item, kind, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

test("plan validation rejects a malformed type test at its path", () => {
  const compiled = compileValidPlan('let saved = load "level"\nlet whole = saved is integer\nexit');
  for (const [description, field, value, path] of [
    ["negated that is not true or false", "negated", "yes", "negated"],
    ["unknown type kind", "type", { kind: "whole" }, "type.kind"],
    ["unknown field", "operator", "is", "operator"],
  ] as const) {
    const plan: unknown = structuredClone(compiled);
    const typeTest = findKind(plan, "typeTest");
    assert.ok(typeTest !== undefined);
    Reflect.set(typeTest.node, field, value);
    assert.deepEqual(
      validateInstructionPlan(plan).errors.map((error) => [error.code, error.path]),
      [["TSC002", `${typeTest.path}.${path}`]],
      description,
    );
  }
});
