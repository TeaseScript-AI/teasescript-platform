import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "../src/parser.js";
import {
  execute,
  type BuiltinFunction,
  type ExecutionResult,
  type RandomSource,
} from "../src/runtime/interpreter.js";
import {
  createRuntimeList,
  type RuntimeValue,
} from "../src/runtime/values.js";

test("deep-copies lists for declarations and direct assignments", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let original = [1, 2]",
      "let declaredCopy = original",
      "declaredCopy[0] = 10",
      "let assignedCopy = [0, 0]",
      "assignedCopy = original",
      "assignedCopy[1] = 20",
      "capture(original)",
      "capture(declaredCopy)",
      "capture(assignedCopy)",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [[1, 2], [10, 2], [1, 20]]);
});

test("recursively deep-copies nested lists", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let original = [[1, 2], [3]]",
      "let copy = original",
      "copy[0][1] = 99",
      "copy[1].add(4)",
      "capture(original)",
      "capture(copy)",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [
    [[1, 2], [3]],
    [[1, 99], [3, 4]],
  ]);
});

test("recursively deep-copies ordinary objects", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let original = { nested: { value: 1 } }",
      "let copy = original",
      "copy.nested.value = 2",
      "capture(original)",
      "capture(copy)",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [
    { nested: { value: 1 } },
    { nested: { value: 2 } },
  ]);
});

test("deep-copies objects containing lists and sets", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let original = { items: [{ value: 1 }], values: set[1, 2] }",
      "let copy = original",
      "copy.items[0].value = 9",
      "copy.values.add(3)",
      "capture(original)",
      "capture(copy)",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [
    { items: [{ value: 1 }], values: [1, 2] },
    { items: [{ value: 9 }], values: [1, 2, 3] },
  ]);
});

test("copies sets independently for declaration and assignment", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let original = set[1, 2]",
      "let declaredCopy = original",
      "declaredCopy.add(3)",
      "let assignedCopy = set[]",
      "assignedCopy = original",
      "assignedCopy.remove(1)",
      "capture(original.toList())",
      "capture(declaredCopy.toList())",
      "capture(assignedCopy.toList())",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [[1, 2], [1, 2, 3], [2]]);
});

test("turns a cyclic injected script value into a structured runtime error", () => {
  const cyclic = createRuntimeList([]);
  cyclic.items.push(cyclic);
  const source = "let copy = cyclicValue()";
  const result = run(source, { cyclicValue: () => cyclic });
  const start = source.indexOf("cyclicValue");

  assert.deepEqual(
    result.errors.map((error) => [
      error.code,
      error.message,
      error.span.start.offset,
      error.span.end.offset,
    ]),
    [
      [
        "TSR031",
        "Cyclic script values are not supported.",
        start,
        source.length,
      ],
    ],
  );
});

test("rejects list, object, and set values in set literals at element spans", () => {
  const cases = [
    ["let values = set[[1]]", "[1]"],
    ["let values = set[{ value: 1 }]", "{ value: 1 }"],
    ["let values = set[set[1]]", "set[1]"],
  ] as const;

  for (const [source, elementText] of cases) {
    const result = run(source);
    const start = source.indexOf(elementText);
    assert.deepEqual(
      result.errors.map((error) => [
        error.code,
        error.span.start.offset,
        error.span.end.offset,
      ]),
      [["TSR032", start, start + elementText.length]],
    );
  }
});

test("rejects composite values through set add, contains, and list toSet", () => {
  for (const source of [
    "let values = set[]\nvalues.add([1])",
    "let values = set[1]\nlet found = values.contains([1])",
    "let source = [{ value: 1 }]\nlet values = source.toSet()",
    "let source = [set[1]]\nlet values = source.toSet()",
  ]) {
    const result = run(source);
    assert.deepEqual(
      result.errors.map((error) => error.code),
      ["TSR032"],
    );
  }
});

test("uses scalar equality for set uniqueness and retains insertion order", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      'let values = set["a", "a", true, true, 1, 1.0, null, null, false]',
      "capture(values.toList())",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [["a", true, 1, null, false]]);
});

test("errors for first, last, and random on empty lists and sets", () => {
  const cases = [
    ["[]", "first", "TSR018"],
    ["[]", "last", "TSR018"],
    ["[]", "random", "TSR019"],
    ["set[]", "first", "TSR018"],
    ["set[]", "last", "TSR018"],
    ["set[]", "random", "TSR019"],
  ] as const;

  for (const [literal, property, code] of cases) {
    const source = `let values = ${literal}\nsay values.${property}`;
    const result = run(source);
    const start = source.indexOf(`values.${property}`);
    assert.deepEqual(
      result.errors.map((error) => [
        error.code,
        error.span.start.offset,
        error.span.end.offset,
      ]),
      [[code, start, start + `values.${property}`.length]],
    );
  }
});

test("does not advance RNG state for empty list or set random", () => {
  for (const literal of ["[]", "set[]"] as const) {
    let calls = 0;
    const random: RandomSource = {
      next(): number {
        calls += 1;
        return 0;
      },
    };
    const result = run(
      `let values = ${literal}\nsay values.random`,
      undefined,
      random,
    );

    assert.deepEqual(result.errors.map((error) => error.code), ["TSR019"]);
    assert.equal(calls, 0);
  }
});

test("uses the speaker identifier fallback and warns only once per speaker", () => {
  const source = [
    "speaker mistressVera {}",
    "speaker mistressVera",
    'say "First"',
    'say "Second"',
    'say as mistressVera "Third"',
  ].join("\n");
  const result = run(source);
  const firstSayStart = source.indexOf('say "First"');

  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.events
      .filter((event) => event.kind === "say")
      .map((event) => event.speaker?.displayName),
    ["mistressVera", "mistressVera", "mistressVera"],
  );
  assert.deepEqual(
    result.warnings.map((warning) => [
      warning.kind,
      warning.severity,
      warning.code,
      warning.message,
      warning.span.start.offset,
      warning.span.end.offset,
    ]),
    [
      [
        "developerWarning",
        "warning",
        "TSW001",
        "Speaker 'mistressVera' uses its identifier as the display name.",
        firstSayStart,
        firstSayStart + 'say "First"'.length,
      ],
    ],
  );
});

test("keeps explicit and derived speaker display names warning-free", () => {
  const result = run([
    "speaker explicit {",
    '  displayName: "Visible Name"',
    "}",
    "speaker derived {",
    '  title: "Doctor"',
    '  firstName: "Vera"',
    "}",
    'say as explicit "Hello"',
    'say as derived "Hello"',
  ]);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.events
      .filter((event) => event.kind === "say")
      .map((event) => event.speaker?.displayName),
    ["Visible Name", "Doctor Vera"],
  );
});

function run(
  source: string | readonly string[],
  builtins?: Readonly<Record<string, BuiltinFunction>>,
  random: RandomSource = { next: () => 0 },
): ExecutionResult {
  const text = typeof source === "string" ? source : source.join("\n");
  const parsed = parse(text);
  assert.deepEqual(parsed.diagnostics, []);
  return execute(parsed.program, {
    random,
    ...(builtins === undefined ? {} : { builtins }),
  });
}

function captureInto(values: unknown[]): BuiltinFunction {
  return (call) => {
    values.push(toNative(call.positional[0] ?? null));
    return null;
  };
}

function toNative(value: RuntimeValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value.kind === "list" || value.kind === "set") {
    return value.items.map(toNative);
  }
  if (value.kind === "speaker") return value.identifier;
  return Object.fromEntries(
    [...value.properties].map(([name, item]) => [name, toNative(item)]),
  );
}
