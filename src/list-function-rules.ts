import type { ArgumentShape } from "./argument-rules.js";

/**
 * Rules of the list functions (V30 §16) that the type checker and the runtime both check, each with one message: their
 * arguments' names and number (`TSV022`, `TSV020`), and otherwise runtime error `TSR028` for a plan that this compiler
 * did not check or a value whose type it does not know. `randomWeighted`'s are in its contract (`RANDOM_CONTRACTS`).
 */

const BY = "1 argument (list), and optionally by:";

/** What each list function takes, and `min` and `max` with one list. */
export const LIST_FUNCTION_SHAPES: ReadonlyMap<string, ArgumentShape> = new Map([
  ...["sum", "average", "median", "stddev", "min", "max"].map((name): [string, ArgumentShape] => [
    name,
    { count: 1, takes: BY, names: ["by"] },
  ]),
  [
    "percentile",
    { count: 2, takes: "2 arguments (list, percentage), and optionally by:", names: ["by"] },
  ],
  [
    "linearRegression",
    { count: 1, takes: "1 argument (list), and optionally y: and x:", names: ["y", "x"] },
  ],
  ["predict", { count: 2, takes: "2 arguments (line, x)", names: [] }],
]);

/** What `min` and `max` take besides one list. */
export const MIN_MAX_TAKES = "2 or more arguments, or one list";
