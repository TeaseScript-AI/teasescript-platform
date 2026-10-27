import assert from "node:assert/strict";
import test from "node:test";

import { changesEntries, DICT_METHODS, type DictMethod } from "../src/dict-operations.js";
import {
  changesElements,
  LIST_METHODS,
  reordersList,
  type ListMethod,
} from "../src/list-methods.js";
import { methodEffects } from "../src/runtime/evaluation/effect-facts.js";
import { TEXT_METHODS, type TextMethod } from "../src/text-operations.js";
import { declaredResult, methodCategory } from "../src/type-inference/core/method-categories.js";

/*
 * The coarse core reads what a built-in method does from its category (`method-categories.ts`): what it does to its
 * receiver's elements from the language's contracts, the one table the compiler and the runtime read too, and the other
 * methods' results from rows of its own. These checks keep the categories the contracts'. A method that changes a
 * list's, set's or dict's elements without its effect would leave them as written, so the core would answer as if the
 * call never ran; a declared result must be the receiver kind's own (F25).
 */

const LISTS: readonly ListMethod[] = Object.values(LIST_METHODS);
const TEXTS: readonly TextMethod[] = Object.values(TEXT_METHODS);
const DICTS: readonly DictMethod[] = Object.values(DICT_METHODS);

/** The methods whose additions the graph already holds as stores into the receiver's elements (`collector.ts`). */
const STORED = new Set(["add", "addAll"]);

const DECLARED: Readonly<Record<string, string>> = {
  null: "null",
  boolean: "boolean",
  integer: "integer",
  "integer?": "integer|null",
  string: "string",
  "string?": "string|null",
};

test("every method that changes its receiver's elements has its effect in the core's categories", () => {
  const changing = [
    ...LISTS.filter((method) => changesElements(method.name) && !STORED.has(method.name)).map(
      (method) => method.name,
    ),
    ...DICTS.filter((method) => changesEntries(method.name)).map((method) => method.name),
  ];
  const missing = changing.filter((name) => methodCategory(name)?.receiver === undefined);
  assert.deepEqual(missing, []);
  const extra = LISTS.map((method) => method.name)
    .filter((name) => methodCategory(name)?.receiver !== undefined)
    .filter((name) => !changing.includes(name));
  assert.deepEqual(extra, []);
});

test("a method's category gives what the contract of each receiver kind that has it declares", () => {
  const wrong: string[] = [];
  // a declared result, a removal's (a dict's removed value, a list's element or `null`), a copy's kind (and whether it
  // may hold none: one that takes a count)
  const check = (owner: string, name: string, result: string, counts = false): void => {
    const gives = methodCategory(name)?.gives;
    if (gives === undefined) return;
    const given =
      gives.kind === "declared"
        ? declaredResult(name, gives.kinds, owner === "text" ? "string" : owner).join("|")
        : gives.kind === "removed"
          ? owner === "dict"
            ? "value"
            : gives.fromList
          : `${gives.into}${gives.mayHoldNone ? " or none" : ""}`;
    const expected =
      gives.kind === "declared" ? DECLARED[result] : `${result}${counts ? " or none" : ""}`;
    if (given !== expected) wrong.push(`${owner} ${name}: ${given}, declared ${result}`);
  };
  for (const method of LISTS)
    check(
      "list",
      method.name,
      method.result,
      method.parameters.some((parameter) => parameter.kind === "count"),
    );
  for (const method of TEXTS) check("text", method.name, method.result);
  for (const method of DICTS) check("dict", method.name, method.result);
  assert.deepEqual(wrong, []);
});

/**
 * What each method that changes its receiver in place changed in the contracts' coarse table, which #1086 replaced with
 * the categories: a list's or set's elements or only their order, and a dict's entries. Every other method changed
 * nothing in place and still changes nothing, as `tests/effect-facts.test.ts` keeps for every method.
 */
const COARSE = {
  list: {
    add: "elements",
    addAll: "elements",
    remove: "elements",
    removeAt: "elements",
    removeFirst: "elements",
    removeLast: "elements",
    clear: "elements",
    sort: "order",
    shuffle: "order",
    reverse: "order",
  },
  dict: { remove: "entries", clear: "entries" },
} as const;

test("what a method changes in place derives from its category as the coarse table said", () => {
  const listChange = (name: string): string =>
    changesElements(name) ? "elements" : reordersList(name) ? "order" : "none";
  const dictChange = (name: string): string => (changesEntries(name) ? "entries" : "none");
  const drift = [
    ...Object.entries(COARSE.list).filter(([name, change]) => listChange(name) !== change),
    ...Object.entries(COARSE.dict).filter(([name, change]) => dictChange(name) !== change),
  ];
  assert.deepEqual(drift, []);
});

test("a new method that removes elements is one row of its contract for the core and the runtime", () => {
  const table: Record<string, ListMethod> = LIST_METHODS;
  table.removeWhere = { ...LIST_METHODS.removeFirst, name: "removeWhere" };
  try {
    assert.deepEqual(methodCategory("removeWhere"), {
      receiver: "removes",
      gives: { kind: "removed", fromList: "element" },
    });
    assert.equal(changesElements("removeWhere"), true);
    assert.equal(methodEffects("removeWhere").changesValue, true);
  } finally {
    delete table.removeWhere;
  }
});
