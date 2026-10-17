import type { ArgumentShape } from "./argument-rules.js";

/**
 * Rules of the list functions (V30 §16) that the type checker and the runtime both check, each with one message: their
 * arguments' names and number (`TSV022`, `TSV020`) and how `randomWeighted` takes its weights, and otherwise runtime
 * error `TSR028` for a plan that this compiler did not check or a value whose type it does not know.
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
  [
    "randomWeighted",
    { count: 1, takes: "1 argument (a dict, or a list with weight:)", names: ["weight"] },
  ],
]);

/** What `min` and `max` take besides one list. */
export const MIN_MAX_TAKES = "2 or more arguments, or one list";

export const DICT_WEIGHTS_MESSAGE =
  "randomWeighted(...) of a dict takes its weights from the dict. Remove 'weight:'.";

export const LIST_WEIGHT_MESSAGE = `randomWeighted(...) of a list needs weight:, the property that holds each element's weight, as in randomWeighted(tasks, weight: "chance").`;

/**
 * `randomWeighted` of something else than a dict or a list. The text names neither the type nor the value: the compiler
 * and the runtime would describe them in different words, such as an element type that only the compiler knows.
 */
export const WEIGHTED_SOURCE_MESSAGE =
  "randomWeighted(...) needs a dict of weights or a list of objects.";
