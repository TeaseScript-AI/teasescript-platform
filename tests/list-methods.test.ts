import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  LIST_METHODS,
  LIST_PROPERTIES,
  type ListKind,
  type ListMethod,
  type ListMethodName,
  type ListParameterKind,
} from "../src/list-methods.js";
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

/** Hides a value's type from the compiler, as host data or untyped storage would. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

const LITERALS: Readonly<Record<ListKind, string>> = {
  list: "[3, 1, 2, 5, 4, 9, 7, 8, 6]",
  set: "set[3, 1, 2, 5, 4, 9, 7, 8, 6]",
};

/** Arguments each method takes on a list or set of whole numbers. */
const ARGUMENTS: Readonly<Record<ListMethodName, string>> = {
  add: "10",
  addAll: "[10]",
  remove: "1",
  removeAt: "0",
  removeFirst: "",
  removeLast: "",
  clear: "",
  sort: "",
  shuffle: "",
  reverse: "",
  contains: "1",
  indexOf: "1",
  lastIndexOf: "1",
  count: "1",
  get: "0, default: 0",
  join: '"-"',
  intersection: "[1]",
  union: "[10]",
  difference: "[1]",
  take: "1",
  takeLast: "1",
  toSet: "",
  toList: "",
};

const NAMES = Object.values(LIST_METHODS).map((method) => method.name);
const contract = (name: ListMethodName): ListMethod => LIST_METHODS[name];
const KINDS: readonly ListKind[] = ["list", "set"];

test("a list or set runs the methods of its kind, and fails without one with the compiler's text", () => {
  for (const name of NAMES)
    for (const kind of KINDS) {
      const call = `${name}(${ARGUMENTS[name]})`;
      const compiled = errors(`let xs = ${LITERALS[kind]}\nsay xs.${call}\nexit`);
      const [code, message] = failure(`${DYNAMIC}say dynamic(${LITERALS[kind]}).${call}\nexit`);
      if (contract(name).receivers.includes(kind)) {
        assert.deepEqual(compiled, [], `${kind} ${call}`);
        assert.equal(code, undefined, `${kind} ${call}: ${message}`);
      } else {
        assert.equal(compiled.length, 1, `${kind} ${call}`);
        assert.deepEqual([code, message], ["TSR016", compiled[0]![1]], `${kind} ${call}`);
      }
    }
});

test("a method changes the list or set it is called on exactly when its contract says so", () => {
  for (const name of NAMES)
    for (const kind of contract(name).receivers) {
      const call = `${name}(${ARGUMENTS[name]})`;
      const changes = contract(name).changes !== undefined;
      // A copy compares equal to the list or set until one of them changes.
      assert.deepEqual(
        sayTexts(
          runValidSource(
            `let xs = ${LITERALS[kind]}\nlet before = xs\nxs.${call}\nsay xs == before\nexit`,
            7,
          ),
        ),
        [String(!changes)],
        `${kind} ${call}`,
      );
      // A change to a list or set that no variable holds would be lost with the copy.
      const lost = errors(
        `function things {\n    return ${LITERALS[kind]}\n}\nthings().${call}\nexit`,
      );
      assert.deepEqual(
        lost.map(([code]) => code),
        changes ? ["TSV067"] : [],
        `${kind} ${call}`,
      );
    }
});

/** Values that a count, a list, or a collection parameter does not take, which both passes describe alike. */
const INVALID: Readonly<Partial<Record<ListParameterKind, readonly string[]>>> = {
  count: ['"a"', "null", "(1..=2)", "-1", "1 - 3"],
  list: ['"a"', "null", "(1..=2)"],
  collection: ['"a"', "null", "(1..=2)"],
};

test("a count, list, or collection argument the compiler can see fails as it fails at runtime, whatever the receiver", () => {
  for (const name of NAMES) {
    const parameter = contract(name).parameters[0];
    if (parameter === undefined) continue;
    for (const value of INVALID[parameter.kind] ?? []) {
      const call = `${name}(${value})`;
      const [code, message] = failure(
        `${DYNAMIC}let xs = ${LITERALS.list}\nsay xs.${name}(dynamic(${value}))\nexit`,
      );
      assert.equal(code, parameter.kind === "count" ? "TSR057" : "TSR060", call);
      assert.deepEqual(
        errors(`let xs = ${LITERALS.list}\nsay xs.${call}\nexit`),
        [["TSV043", message]],
        call,
      );
      assert.deepEqual(
        errors(`function f(xs) {\n    return xs.${call}\n}\nexit`),
        [["TSV043", message]],
        `unknown receiver: ${call}`,
      );
    }
  }
});

test("a property of lists and sets reads an element of a list in place and a copy of a set's member", () => {
  for (const property of Object.values(LIST_PROPERTIES)) {
    const name = property.name;
    if (property.gives === "length") {
      assert.deepEqual(
        sayTexts(runValidSource(`say [[1], [2]].${name}\nsay set[1, 1].${name}\nexit`)),
        ["2", "1"],
      );
      continue;
    }
    // A change through a list's element reaches the list; one through a set's member would be lost with the copy.
    const change = (kind: ListKind) =>
      `let xs = ${kind === "list" ? "[[1], [2]]" : "set[[1], [2]]"}\nxs.${name}.add(5)\nsay xs.first.length + xs.last.length\nexit`;
    assert.deepEqual(sayTexts(runValidSource(change("list"), 7)), ["3"], `.${name}`);
    assert.deepEqual(
      errors(change("set")).map(([code]) => code),
      ["TSV067"],
      `.${name}`,
    );
    for (const kind of KINDS)
      assert.equal(
        failure(`${DYNAMIC}say dynamic(${kind === "list" ? "[]" : "set[]"}).${name}\nexit`)[0],
        property.empty,
        `empty ${kind} .${name}`,
      );
  }
  // A property that lists and sets do not have fails alike in both passes.
  for (const kind of KINDS) {
    const compiled = errors(`let xs = ${LITERALS[kind]}\nsay xs.size\nexit`);
    assert.deepEqual(failure(`${DYNAMIC}say dynamic(${LITERALS[kind]}).size\nexit`), [
      "TSR017",
      compiled[0]?.[1],
    ]);
  }
});
