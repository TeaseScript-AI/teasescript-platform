/**
 * The programs of `tests/type-core-native.test.ts`'s argument-spread regressions (S6c), by the core site whose list
 * each makes source-sized: one text per size, which the test's child process analyses.
 */
export const SPREAD_PROGRAMS: Readonly<Record<string, (size: number) => string>> = {
  // a place's operand regions merged per file (`GuardIndex.#placeOperands`): one test of a field, k of another
  guards: (size) =>
    [
      "let root = {a: 1, b: 1, n: [1, hostValue][1]}",
      `let ok = root.a is integer and ${Array.from({ length: size }, () => "root.b is integer").join(" and ")} and true`,
      "let box = root",
      "repeat box.n {}",
      "exit",
    ].join("\n"),
  // a solver component abandoned when a rerun finds an earlier dependency (`Solver.#abandon`): k mutually recursive
  // results beside one returning their length
  solver: (size) =>
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
  // a choice's button values at a selection step (`Contract.indexItems`): a list of k choice records
  records: (size) =>
    `let picked: integer = askChoice [${Array.from({ length: size }, () => "{text: 1}").join(",")}]\nexit`,
  // a choice record's selected property (`Contract.#selectedAt`): its value a list of k computed elements
  property: (size) =>
    [
      `let choice = {text: "A", value: [${Array.from({ length: size }, () => "1 + 0").join(",")}]}`,
      "let picked: integer = (askChoice choice).first",
      "exit",
    ].join("\n"),
};
