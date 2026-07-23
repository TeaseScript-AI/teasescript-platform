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
  createRuntimeObject,
  type RuntimeValue,
} from "../src/runtime/values.js";

test("evaluates variables, assignment, precedence, if, and else", () => {
  const result = run([
    "let score = 1",
    "if true {",
    "  score = 2 + 3 * 4",
    "  let local = 99",
    "}",
    "if false {",
    "  score = 0",
    "} else {",
    "  score = score + 1",
    "}",
    "say `${score}`",
  ]);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(sayTexts(result), ["15"]);
});

test("enforces lexical block scope with a span-bearing error", () => {
  const source = [
    "if true {",
    "  let local = 1",
    "}",
    "say `${local}`",
  ].join("\n");
  const result = run(source);

  assert.deepEqual(
    result.errors.map((error) => [
      error.code,
      error.span.start.offset,
      error.span.end.offset,
    ]),
    [["TSR006", source.indexOf("local", source.indexOf("say")), source.length - 2]],
  );
  assert.deepEqual(result.events, []);
});

test("evaluates positional and named injected built-in calls", () => {
  const calls: Array<{ positional: unknown; named: unknown }> = [];
  const capture: BuiltinFunction = (call) => {
    calls.push({
      positional: call.positional.map(toNative),
      named: Object.fromEntries(
        Object.entries(call.named).map(([name, value]) => [name, toNative(value)]),
      ),
    });
    return null;
  };
  const result = run(["capture(1, 2)", "capture(x: 3, y: 4)"], {
    capture,
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(calls, [
    { positional: [1, 2], named: {} },
    { positional: [], named: { x: 3, y: 4 } },
  ]);
});

test("validates injected built-in results at runtime", () => {
  const result = run("let value = invalid()", {
    invalid: () => Number.POSITIVE_INFINITY,
  });

  assert.deepEqual(
    result.errors.map((error) => error.code),
    ["TSR013"],
  );
});

test("evaluates object properties and list indexes and assignments", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let door = { locked: true }",
      'let items = ["map", "coin"]',
      "door.locked = false",
      'items[0] = "key"',
      "capture(door.locked)",
      "capture(items[0])",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [false, "key"]);
});

test("deep-copies list and object assignments before later mutation", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let originalList = [{ value: 1 }]",
      "let copiedList = originalList",
      "copiedList[0].value = 2",
      "let originalObject = { nested: { value: 3 } }",
      "let copiedObject = originalObject",
      "copiedObject.nested.value = 4",
      "capture(originalList[0].value)",
      "capture(copiedList[0].value)",
      "capture(originalObject.nested.value)",
      "capture(copiedObject.nested.value)",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [1, 2, 3, 4]);
});

test("deduplicates sets and preserves insertion order through mutations", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let values = set[1, 2, 2, 3]",
      "values.add(2)",
      "values.add(4)",
      "values.remove(1)",
      "capture(values.toList())",
      "capture(values.contains(3))",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [[2, 3, 4], true]);
});

test("copies sets and converts between lists and sets", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let original = set[1, 2]",
      "let copied = original",
      "copied.add(3)",
      "let converted = [3, 3, 4].toSet()",
      "capture(original.toList())",
      "capture(copied.toList())",
      "capture(converted.toList())",
    ],
    { capture: captureInto(captured) },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [[1, 2], [1, 2, 3], [3, 4]]);
});

test("supports every accepted set property and clear", () => {
  const captured: unknown[] = [];
  const result = run(
    [
      "let values = set[1, 2, 3]",
      "capture(values.length)",
      "capture(values.first)",
      "capture(values.last)",
      "capture(values.random)",
      "values.clear()",
      "capture(values.length)",
    ],
    { capture: captureInto(captured) },
    sequenceRandom([0.4]),
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(captured, [3, 1, 3, 2, 0]);
});

test("rejects set indexing deterministically with the expression span", () => {
  const source = "let values = set[1, 2]\nsay `${values[0]}`";
  const result = run(source);
  const start = source.indexOf("values[0]");

  assert.deepEqual(
    result.errors.map((error) => [
      error.code,
      error.message,
      error.span.start.offset,
      error.span.end.offset,
    ]),
    [["TSR004", "Sets are not indexable.", start, start + "values[0]".length]],
  );
});

test("uses only the injected deterministic RNG for list and set random", () => {
  const random = sequenceRandom([0.75, 0]);
  const result = run(
    [
      'let names = ["a", "b", "c", "d"]',
      'let values = set["first", "last"]',
      "say names.random",
      "say values.random",
    ],
    undefined,
    random,
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(sayTexts(result), ["d", "first"]);
});

test("emits speaker-aware say events and keeps say-as temporary", () => {
  const result = run([
    "speaker vera {",
    '  title: "Mistress"',
    '  firstName: "Vera"',
    '  color: "#123456"',
    "}",
    "speaker cashier {",
    '  displayName: "Cashier"',
    "}",
    "speaker vera",
    "say `Obey ${speaker.title}.`",
    "say as cashier `Ask ${speaker.displayName}.`",
    "say `Still ${speaker.firstName}.`",
  ]);

  assert.deepEqual(result.errors, []);
  const says = result.events.filter((event) => event.kind === "say");
  assert.deepEqual(
    says.map((event) => [
      event.speaker?.identifier,
      event.speaker?.displayName,
      event.text,
    ]),
    [
      ["vera", "Mistress Vera", "Obey Mistress."],
      ["cashier", "Cashier", "Ask Cashier."],
      ["vera", "Mistress Vera", "Still Vera."],
    ],
  );
  assert.equal(says[0]?.speaker?.color, "#123456");
});

test("supports injected structured globals in template interpolation", () => {
  const player = createRuntimeObject(
    new Map<string, RuntimeValue>([["alias", "puppy"]]),
  );
  const result = run('say `Hello ${player.alias}.`', undefined, undefined, {
    player,
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(sayTexts(result), ["Hello puppy."]);
});

test("exit emits one typed event and prevents later execution", () => {
  const result = run(['say "before"', "exit", 'say "after"']);

  assert.deepEqual(result.errors, []);
  assert.equal(result.exited, true);
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["say", "exit"],
  );
  assert.deepEqual(sayTexts(result), ["before"]);
});

test("reports unsupported composite equality instead of inventing semantics", () => {
  const result = run("let equal = [1] == [1]");

  assert.deepEqual(
    result.errors.map((error) => error.code),
    ["TSR029"],
  );
});

function run(
  source: string | readonly string[],
  builtins?: Readonly<Record<string, BuiltinFunction>>,
  random: RandomSource = sequenceRandom([0]),
  globals?: Readonly<Record<string, RuntimeValue>>,
): ExecutionResult {
  const text = typeof source === "string" ? source : source.join("\n");
  const parsed = parse(text);
  assert.deepEqual(parsed.diagnostics, []);
  return execute(parsed.program, {
    random,
    ...(builtins === undefined ? {} : { builtins }),
    ...(globals === undefined ? {} : { globals }),
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

function sequenceRandom(values: readonly number[]): RandomSource {
  let index = 0;
  return {
    next(): number {
      const value = values[index];
      index += 1;
      return value ?? values.at(-1) ?? 0;
    },
  };
}

function sayTexts(result: ExecutionResult): string[] {
  return result.events
    .filter((event) => event.kind === "say")
    .map((event) => event.text);
}
