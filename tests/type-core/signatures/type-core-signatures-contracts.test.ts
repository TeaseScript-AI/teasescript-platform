// C13 over the contracts of text, lists, sets and dicts: a misfit at each parameter that takes some kinds, and each
// admitted check and dispatch as the derived oracle predicts.

import assert from "node:assert/strict";
import test from "node:test";

import { compileSource, compileSourceWithBackend } from "../../../src/compiler.js";
import { DICT_METHODS, dictMethod } from "../../../src/dict-operations.js";
import { LIST_METHODS, listMethod } from "../../../src/list-methods.js";
import { TEXT_METHODS } from "../../../src/text-operations.js";
import {
  createCapturedSerializableList,
  createCapturedSerializableSet,
  type SerializableRuntimeValue,
} from "../../../src/runtime/values/serializable-values.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import {
  derive,
  evaluate,
  syntaxOf,
  Underivable,
  type PredictedRun,
} from "../../helpers/type-core-derived.js";
import { assignments, runGlobals } from "../../helpers/type-core-route.js";
import { analysed } from "../../helpers/type-core/type-core-signatures-setup.js";

/** A value of each kind of a contract's parameter: one the parameter takes, and one it does not (`null`: it takes any). */
const PARAMETER_VALUES: Readonly<Record<string, readonly [string, string | null]>> = {
  text: ['"a"', "1"],
  regex: ["/a/", '"a"'],
  textOrRegex: ['"a"', "1"],
  position: ["1", '"x"'],
  count: ["1", '"x"'],
  index: ["0", '"x"'],
  list: ["[1]", "1"],
  collection: ["[1]", "1"],
  value: ["1", null],
  key: ['"a"', "1"],
};

/** A positional parameter of a contract: its receiver as written, its method, its parameters' kinds and its position. */
interface ContractParameter {
  readonly receiver: string;
  readonly name: string;
  readonly kinds: readonly string[];
  readonly position: number;
}

/**
 * Every positional parameter of the contracts of text, lists, sets and dicts (`TEXT_METHODS`, `LIST_METHODS`,
 * `DICT_METHODS`), on a receiver of each kind that has its method; a list's `get` is C2's with its `default:`.
 */
function contractParameters(): ContractParameter[] {
  const found: ContractParameter[] = [];
  const add = (receiver: string, name: string, kinds: readonly string[]): void =>
    kinds.forEach((_, position) => found.push({ receiver, name, kinds, position }));
  for (const method of Object.values(TEXT_METHODS))
    add(
      '"abc"',
      method.name,
      method.parameters.map((parameter) => parameter.kind),
    );
  for (const method of Object.keys(LIST_METHODS).map((name) => listMethod(name)!))
    if (method.named === undefined)
      for (const kind of method.receivers)
        add(
          kind === "list" ? "[1, 2]" : "[1, 2].toSet()",
          method.name,
          method.parameters.map((parameter) => parameter.kind),
        );
  for (const method of Object.keys(DICT_METHODS).map((name) => dictMethod(name)!))
    if (method.named === undefined)
      add(
        "dict{a: 1}",
        method.name,
        method.parameters.map(() => "key"),
      );
  return found;
}

/** The call of a contract's method with each argument a value its parameter takes, and `argument` at `position`. */
function contractCall(parameter: ContractParameter, argument: string): string {
  const values = parameter.kinds.map((kind, position) =>
    position === parameter.position ? argument : PARAMETER_VALUES[kind]![0],
  );
  return `${parameter.receiver}.${parameter.name}(${values.join(", ")})`;
}

/**
 * C13 by construction over the contracts (Sol r1 B1): every positional parameter of every text, list, set and dict
 * method that takes some kinds only rejects a definite misfit at the argument, in both orders, as the current checker
 * does; one that takes any value has no misfit.
 */
test("every parameter of the text, list, set and dict contracts that takes some kinds rejects a misfit at its argument", (t) => {
  const missing: string[] = [];
  const stored: string[] = [];
  let checked = 0;
  for (const parameter of contractParameters()) {
    const kind = parameter.kinds[parameter.position]!;
    const misfit = PARAMETER_VALUES[kind]?.[1];
    assert.ok(misfit !== undefined, `${parameter.name}: a parameter kind ${kind} with values`);
    if (misfit === null) continue;
    // (a list's `addAll` adds its argument's elements as a store, F5: the store's consumer's, outside the slice)
    if (parameter.name === "addAll") {
      stored.push(contractCall(parameter, misfit));
      continue;
    }
    const call = contractCall(parameter, misfit);
    const source = `${call}\nexit\n`;
    // (the argument's offset: the call up to it, each argument before it a fitting value)
    const at = contractCall(parameter, "\u0000").indexOf("\u0000");
    const rejected = analysed(source).some(
      (d) =>
        d.class === "compile-error" && d.site.start === at && d.site.end === at + misfit.length,
    );
    const legacy = compileSource(source).diagnostics.some((d) => d.severity === "error");
    checked += 1;
    if (!rejected || !legacy)
      missing.push(
        `${call}: ${rejected ? "" : "no error at the argument"}${legacy ? "" : " (the current checker: none)"}`,
      );
  }
  t.diagnostic(`${checked} parameters rejecting a misfit; a store's: ${stored.join(", ")}`);
  assert.deepEqual(missing, []);
  assert.deepEqual(stored, ["[1, 2].addAll(1)"]);
});

/**
 * The derived oracle follows every admitted argument check and the runtime's dispatch (Sol r1 B5, r2): each text, list
 * and set method's parameter that takes some kinds, given host data on the candidate route; the elements `join` shows
 * and `sort` orders; and every admitted method of text, lists, sets and dicts on a receiver the script cannot know,
 * under host values of each kind the runtime dispatches differently. Every run of the plan is the run the oracle derives
 * from the record and the source, and each discharge of an argument or a member by the call's own check is violable: a
 * host value stops the run at the call (removing the check would show here).
 */
test("every admitted argument check and method dispatch runs as the derived oracle predicts, and each such discharge stops a run at its call", (t) => {
  const programs = [
    ...contractParameters()
      .filter((parameter) => !parameter.receiver.startsWith("dict"))
      .filter((parameter) => PARAMETER_VALUES[parameter.kinds[parameter.position]!]?.[1] !== null)
      .map((parameter) => `let r = ${contractCall(parameter, "hostValue")}\nsay "after"\nexit\n`),
    'let xs = [hostValue otherwise [1]]\nsay xs.join()\nsay "after"\nexit\n',
    'let xs = [hostValue]\nxs.sort()\nsay "after"\nexit\n',
  ];
  // (each admitted method on a receiver the script cannot know, under host values of every kind that dispatches it
  // differently: text, a list, an empty list, a set, a dict, a number, null, each date and time kind; the member
  // check's discharge too)
  const dispatched = [
    ...new Set([
      ...Object.keys(TEXT_METHODS),
      ...Object.keys(LIST_METHODS).filter(
        (name) => listMethod(name)!.changes === undefined || name === "sort",
      ),
      ...Object.keys(DICT_METHODS).filter((name) => dictMethod(name)!.changes === undefined),
    ]),
  ].map((name) => {
    const parameter = contractParameters().find((found) => found.name === name);
    const call =
      parameter === undefined
        ? `r.${name}()`
        : contractCall({ ...parameter, receiver: "r", position: -1 }, "");
    return `let r = hostValue\nlet result = ${name === "get" ? `r.get("a", default: 0)` : call}\nsay "after"\nexit\n`;
  });
  // (a key of another kind than text: a dict's own check at the key, TSR062)
  dispatched.push('let r = hostValue\nlet result = r.contains(1)\nsay "after"\nexit\n');
  const receivers: readonly SerializableRuntimeValue[] = [
    "abc",
    2,
    null,
    createCapturedSerializableList([1, 2]),
    createCapturedSerializableList([]),
    createCapturedSerializableSet([1, 2]),
    { kind: "dict", entries: [{ key: "a", value: 1 }] },
    { kind: "date", year: 2026, month: 10, day: 29 },
    { kind: "time", hour: 12, minute: 0, second: 0, millisecond: 0 },
    {
      kind: "datetime",
      year: 2026,
      month: 10,
      day: 29,
      hour: 12,
      minute: 0,
      second: 0,
      millisecond: 0,
    },
    { kind: "absoluteDateTime", epochMilliseconds: 0 },
  ];
  const differing: string[] = [];
  let [planned, outside, discharges] = [0, 0, 0];
  for (const source of [...programs, ...dispatched]) {
    let result: ReturnType<typeof compileSourceWithBackend>;
    try {
      result = compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND);
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      outside += 1;
      continue;
    }
    if (result.plan === null) {
      differing.push(`${source}: no plan`);
      continue;
    }
    planned += 1;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, source);
    const syntax = syntaxOf(source);
    const derived = (() => {
      try {
        return derive(syntax, compactAnalysis(request));
      } catch (error) {
        if (error instanceof Underivable) return error.message;
        throw error;
      }
    })();
    if (typeof derived === "string") {
      differing.push(`${source}: underivable: ${derived}`);
      continue;
    }
    const failures: (string | null)[] = [];
    const inputsOf = dispatched.includes(source)
      ? receivers.map((hostValue) => ({ hostValue }))
      : assignments(["hostValue"]);
    for (const inputs of inputsOf) {
      const ran = runGlobals(result.plan, inputs);
      let predicted: PredictedRun | string;
      try {
        predicted = evaluate(syntax, derived.stores, inputs, false, derived.content).run;
      } catch (error) {
        if (!(error instanceof Underivable)) throw error;
        predicted = `underivable: ${error.message}`;
      }
      if (JSON.stringify(ran) !== JSON.stringify(predicted))
        differing.push(
          `${source} with ${JSON.stringify(inputs)}: ran ${JSON.stringify(ran)}, derived ${JSON.stringify(predicted)}`,
        );
      failures.push(ran.failure);
    }
    for (const discharge of derived.discharges)
      if (
        discharge.by === "native" &&
        (discharge.what === "argument" || discharge.what === "member")
      ) {
        discharges += 1;
        // (a method's member check stops the run at the call, which starts where the member does)
        const at =
          discharge.what === "member" ? `${discharge.site.split(":")[0]}:` : discharge.site;
        if (
          !failures.some((failure) =>
            discharge.what === "member"
              ? failure?.split("@")[1]?.startsWith(at) === true
              : failure?.split("@")[1] === at,
          )
        )
          differing.push(
            `${source}: the ${discharge.what} check at ${discharge.site} stops no run`,
          );
      }
  }
  t.diagnostic(
    `${planned} programs with a plan (${outside} outside the slice), ${discharges} argument and member discharges`,
  );
  assert.deepEqual(differing, []);
});
