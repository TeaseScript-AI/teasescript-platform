import type { Answers } from "../../src/type-inference/core/answers.js";

/**
 * The programs of `tests/type-core-native.test.ts`'s spread regressions, one per list it makes source-sized: a text
 * per size, which the test's narrow-stack child analyses, and where needed a fact of its answers beside the outcome.
 */
export interface SpreadCase {
  readonly source: (size: number) => string;
  readonly extra?: (answers: Answers) => number;
}

const repeat = (size: number, line: string): string =>
  Array.from({ length: size }, () => line).join("\n");

export const SPREAD_CASES: Readonly<Record<string, SpreadCase>> = {
  // a literal's stores at a step (`Admission.literalChildren`, review r3): a literal of k elements beside a host value
  literal: {
    source: (size) =>
      `let xs: integer[] = [${Array.from({ length: size }, () => "1").join(",")}, hostValue]\nexit`,
  },
  // a key's definitions below another (`DefinitionLists`, external review r6 F1): stores to one property
  stores: {
    source: (size) =>
      `let root = {n: 0}\n${repeat(size, "root.n = 1")}\nlet box = root\nrepeat box.n {}\nexit`,
  },
  // the exact-path forest's copies of a source (`ExactPath.#forest`, Astra r6 N1): copies of a root replaced once
  copies: {
    source: (size) =>
      [
        "let root = {n: [1, hostValue][1]}",
        "let box = root",
        "root = {n: [1, hostValue][1]}",
        repeat(size, "box = root"),
        "repeat box.n {}",
        "exit",
      ].join("\n"),
  },
  // a key's own events with its prefixes' (`DefinitionLists.ownEvents`, Astra r6 N1): a root stored whole, its place's
  // stores at its property counted
  wholes: {
    source: (size) =>
      [
        "let root = {n: 0}",
        "let shared = {n: 1}",
        repeat(size, "root = shared"),
        "let box = root",
        "repeat box.n {}",
        "exit",
      ].join("\n"),
    extra: (answers) => {
      const declaration = answers.graph.nodes.find(
        (node) => node.kind === "statement" && node.span?.start.offset === 0,
      );
      const root = declaration === undefined ? null : answers.at(declaration)?.place;
      return root ? answers.place(root.id, ["n"]).definitions.events.stores.length : -1;
    },
  },
  // a place's operand regions merged per file (`GuardIndex.#placeOperands`, S6c): one test of a field, k of another
  guards: {
    source: (size) =>
      [
        "let root = {a: 1, b: 1, n: [1, hostValue][1]}",
        `let ok = root.a is integer and ${Array.from({ length: size }, () => "root.b is integer").join(" and ")} and true`,
        "let box = root",
        "repeat box.n {}",
        "exit",
      ].join("\n"),
  },
  // a solver component abandoned when a rerun finds an earlier dependency (`Solver.#abandon`, S6c): k mutually
  // recursive results beside one returning their length
  solver: {
    source: (size) =>
      [
        'let flagHost = askBoolean "flag"',
        "let out = outer().length",
        'function outer: string | integer { if flagHost { return "ok" }\nreturn get0().length }',
        ...Array.from(
          { length: size },
          (_, i) =>
            `function get${i}${i === 0 ? ": object | string | integer" : ""} {\n${
              i === 0 ? "  if flagHost { return {length: outer()} }\n" : ""
            }  return ${i + 1 < size ? `get${i + 1}()` : "get0().length"}\n}`,
        ),
        "exit",
      ].join("\n"),
  },
  // a choice's button values at a selection step (`Contract.indexItems`, S6c): a list of k choice records
  records: {
    source: (size) =>
      `let picked: integer = askChoice [${Array.from({ length: size }, () => "{text: 1}").join(",")}]\nexit`,
  },
  // a choice record's selected property (`Contract.#selectedAt`, S6c): its value a list of k computed elements
  property: {
    source: (size) =>
      [
        `let choice = {text: "A", value: [${Array.from({ length: size }, () => "1 + 0").join(",")}]}`,
        "let picked: integer = (askChoice choice).first",
        "exit",
      ].join("\n"),
  },
};
