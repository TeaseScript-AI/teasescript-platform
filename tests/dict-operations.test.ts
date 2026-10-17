import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  DICT_ACCESS,
  DICT_METHODS,
  DICT_PROPERTIES,
  type DictMethod,
  type DictMethodName,
} from "../src/dict-operations.js";
import { LIST_METHODS, type ListMethod } from "../src/list-methods.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function errors(source: string): [string, string][] {
  return compileSource(source)
    .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => [diagnostic.code, diagnostic.message]);
}

function failure(source: string): [string | undefined, string | undefined] {
  const failed = runValidSource(source).snapshot.failure;
  return [failed?.code, failed?.message];
}

function says(source: string): string[] {
  return sayTexts(runValidSource(source));
}

/** Hides a value from the compiler, as host data or untyped storage would. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

const TOYS = "let toys = dict{ collar: 1, gag: 2 }\n";

/** Arguments each method takes on `toys` for a key it has, and for one it does not. */
const ARGUMENTS: Readonly<
  Record<DictMethodName, { readonly has: string; readonly missing: string }>
> = {
  contains: { has: '"collar"', missing: '"cuffs"' },
  remove: { has: '"collar"', missing: '"cuffs"' },
  clear: { has: "", missing: "" },
  get: { has: '"collar", default: 0', missing: '"cuffs", default: 0' },
};

const NAMES = Object.values(DICT_METHODS).map((method) => method.name);
const contract = (name: DictMethodName): DictMethod => DICT_METHODS[name];

test("a dict runs each method of its contract, and fails without one with the compiler's text", () => {
  // What each kind of result is for `toys` and its key "collar".
  const results = { null: "null", boolean: "true", value: "1" };
  for (const name of NAMES) {
    const call = `${name}(${ARGUMENTS[name].has})`;
    assert.deepEqual(says(`${TOYS}say toys.${call}\nexit`), [results[contract(name).result]], call);
    assert.deepEqual(says(`${DYNAMIC}${TOYS}say dynamic(toys).${call}\nexit`), [
      results[contract(name).result],
    ]);
  }
  for (const call of ["add(1)", "sort()", "toList()", "trim()"]) {
    const compiled = errors(`${TOYS}say toys.${call}\nexit`);
    assert.equal(compiled.length, 1, call);
    assert.deepEqual(failure(`${DYNAMIC}${TOYS}say dynamic(toys).${call}\nexit`), [
      "TSR016",
      compiled[0]![1],
    ]);
  }
  assert.deepEqual(errors(`${TOYS}toys.sort()\nexit`), [
    ["TSV043", "Dicts have no method 'sort'. Use contains, remove, clear, or get."],
  ]);
});

test("a method changes the dict it is called on exactly when its contract says so", () => {
  for (const name of NAMES) {
    const call = `${name}(${ARGUMENTS[name].has})`;
    const changes = contract(name).changes !== undefined;
    // A copy compares equal to the dict until one of them changes.
    assert.deepEqual(
      says(`${TOYS}let before = toys\ntoys.${call}\nsay toys == before\nexit`),
      [String(!changes)],
      call,
    );
    // A change to a dict that no variable holds would be lost with the copy.
    const lost = errors(`function toys {\n    return dict{ collar: 1 }\n}\ntoys().${call}\nexit`);
    assert.deepEqual(
      lost.map(([code]) => code),
      changes ? ["TSV067"] : [],
      call,
    );
  }
});

test("a key the dict does not have fails, gives false, gives the default, or is added, as the contract says", () => {
  const outcome = (source: string): string => {
    const [code, message] = failure(source);
    return code === undefined ? says(source).join(" ") : `${code} ${message}`;
  };
  const missing = 'TSR061 Dictionary has no key "cuffs". Check toys.contains(key) first.';
  const expected = {
    fails: missing,
    false: "false",
    default: "0",
    adds: 'dict{ "collar": 1, "gag": 2, "cuffs": 9 }',
  };
  const key = 'let key = "cuffs"\n';
  for (const name of NAMES) {
    const behaviour = contract(name).missing;
    if (behaviour === undefined) continue;
    const args = ARGUMENTS[name].missing.replace('"cuffs"', "key");
    assert.equal(
      outcome(`${TOYS}${key}say toys.${name}(${args})\nexit`),
      expected[behaviour],
      name,
    );
  }
  assert.equal(DICT_ACCESS.read.missing, "fails");
  assert.equal(outcome(`${TOYS}${key}say toys[key]\nexit`), missing);
  assert.equal(DICT_ACCESS.store.missing, "adds");
  assert.equal(outcome(`${TOYS}${key}toys[key] = 9\nsay toys\nexit`), expected.adds);
  // Where the dict is written in the source, a key it does not have is a compile error with the runtime's text.
  const literal = 'Dictionary has no key "cuffs". Check it with contains("cuffs") first.';
  for (const read of ['dict{ collar: 1 }["cuffs"]', 'dict{ collar: 1 }.remove("cuffs")'])
    assert.deepEqual(errors(`say ${read}\nexit`), [["TSV043", literal]], read);
  // A key the source spells as a call is named by its text.
  assert.deepEqual(failure(`${DYNAMIC}say dict{ collar: 1 }[dynamic("cuffs")]\nexit`), [
    "TSR061",
    literal,
  ]);
});

test("a key that is not text has one text when compiled and when run, which names the key", () => {
  const notText =
    'A dict key is text (string), but this is a whole number (integer). Write a number key as text, as in "${count}".';
  for (const use of [
    "toys[count]",
    "toys.contains(count)",
    "toys.get(count, default: 0)",
    "dict{ [count]: 1 }",
  ]) {
    assert.deepEqual(errors(`${TOYS}let count = 5\nsay ${use}\nexit`), [["TSV043", notText]], use);
    assert.deepEqual(
      failure(`${DYNAMIC}${TOYS}let count = dynamic(5)\nsay ${use}\nexit`),
      ["TSR062", notText],
      use,
    );
  }
  assert.deepEqual(failure(`${DYNAMIC}${TOYS}let count = dynamic(5)\ntoys[count] = 3\nexit`), [
    "TSR062",
    notText,
  ]);
  // A key the source does not name by a variable or path, such as a call, is named `id`.
  assert.deepEqual(failure(`${DYNAMIC}${TOYS}say toys[dynamic(5)]\nexit`), [
    "TSR062",
    notText.replace("${count}", "${id}"),
  ]);
});

test("each method takes the arguments of its contract, as many as the list method of its name", () => {
  for (const name of NAMES) {
    const method = contract(name);
    const list: ListMethod = LIST_METHODS[name];
    // A receiver of unknown type is checked with the list method's shape.
    assert.equal(method.parameters.length, list.parameters.length, name);
    assert.deepEqual(method.named, list.named, name);
    const extra = errors(
      `${TOYS}say toys.${name}(${['"a"', ...method.parameters.map(() => '"a"')].join(", ")})\nexit`,
    );
    assert.deepEqual(
      extra.map(([code]) => code),
      ["TSV020"],
      name,
    );
  }
  assert.deepEqual(errors(`${TOYS}say toys.contains()\nexit`), [
    ["TSV020", "contains() takes 1 argument (key), received 0."],
  ]);
  assert.deepEqual(errors(`${TOYS}say toys.get("a", fallback: 0)\nexit`), [
    ["TSV022", "get() has no parameter 'fallback'. Its only named argument is 'default:'."],
  ]);
  // A dict in a union takes the arguments as a dict does (ADR 0021 rule 3.5); the first member's problem is reported.
  assert.deepEqual(
    errors(
      `${DYNAMIC}let d: (integer dict | string[]) = dynamic(dict{ a: 1 })\nsay d.contains(1, 2)\nexit`,
    ),
    [["TSV020", "contains() takes 1 argument (key), received 2."]],
  );
});

test("a property gives its contract's value, and a name without one has one text when compiled and when run", () => {
  // What each property gives for `toys`.
  const values = { length: "2", keys: '["collar", "gag"]', values: "[1, 2]" };
  for (const property of Object.values(DICT_PROPERTIES))
    assert.deepEqual(
      says(`${TOYS}say toys.${property.name}\nexit`),
      [values[property.gives]],
      property.name,
    );
  // `keys` and `values` are new lists, so changing one leaves the dict as it was.
  assert.deepEqual(says(`${TOYS}let keys = toys.keys\nkeys.add("cuffs")\nsay toys.length\nexit`), [
    "2",
  ]);
  const compiled = errors(`${TOYS}say toys.first\nexit`);
  assert.deepEqual(compiled, [
    [
      "TSV043",
      "Dicts have no property 'first'. Use length, keys, or values. To read a value by its key, write 'toys[\"first\"]'.",
    ],
  ]);
  assert.deepEqual(failure(`${DYNAMIC}${TOYS}let d = dynamic(toys)\nsay d.first\nexit`), [
    "TSR017",
    compiled[0]![1].replace("toys[", "d["),
  ]);
});

test("a method that only reads a dict the compiler knows gives a known value; one that changes it makes it unknown", () => {
  const chance = 'say chance(d.get("a", default: 0))\nexit';
  const percentage = "chance(...) needs a percentage from 0 through 100, not 101.";
  assert.deepEqual(errors(`let d = dict{ a: 101 }\n${chance}`), [["TSV043", percentage]]);
  assert.deepEqual(errors(`say chance(dict{ a: 101 }.get("b", default: 101))\nexit`), [
    ["TSV043", percentage],
  ]);
  for (const name of NAMES.filter((name) => contract(name).changes !== undefined)) {
    const source = `let d = dict{ a: 101 }\nd.${name}(${ARGUMENTS[name].has.replace('"collar"', '"b"')})\n${chance}`;
    assert.deepEqual(errors(source), [], name);
  }
  // A store changes it too, and so the run decides.
  const stored = `let d = dict{ a: 101 }\nd["b"] = 1\n${chance}`;
  assert.deepEqual(errors(stored), []);
  assert.deepEqual(failure(stored), ["TSR039", percentage]);
});
