import assert from "node:assert/strict";
import test from "node:test";

import { DICT_METHODS, type DictMethod } from "../src/dict-operations.js";
import { LIST_METHODS, type ListMethod } from "../src/list-methods.js";
import { TEXT_METHODS, type TextMethod } from "../src/text-operations.js";
import { declaredResult, methodCategory } from "../src/type-inference/core/method-categories.js";

/*
 * The coarse core reads what a built-in method does from its category (`method-categories.ts`), whose rows the
 * language's contracts cannot give yet: they say that a method changes its receiver's elements, not whether it adds,
 * removes some or clears them. These checks keep the rows the contracts'. A method that changes a list's, set's or
 * dict's elements without its effect would leave them as written, so the core would answer as if the call never ran;
 * a declared result must be the receiver kind's own (F25).
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
    ...LISTS.filter((method) => method.changes === "elements" && !STORED.has(method.name)).map(
      (method) => method.name,
    ),
    ...DICTS.filter((method) => method.changes === "entries").map((method) => method.name),
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
        ? declaredResult(name, gives.kinds, owner === "text").join("|")
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
