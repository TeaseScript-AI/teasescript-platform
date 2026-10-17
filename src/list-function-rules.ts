import {
  argumentCountMessage,
  unknownNamedArgumentMessage,
  type ArgumentProblem,
  type ArgumentShape,
} from "./argument-rules.js";

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
const MIN_MAX_TAKES = "2 or more arguments, or one list";

/**
 * The first problem with the names and the number of the arguments of `min` or `max` of values, which is every call but
 * one of one list: a name, which only one list takes, then fewer than 2 values. The compiler checks it where the
 * argument cannot be a list, and the runtime where it is not one. `undefined` when the arguments fit.
 */
export function minMaxValuesProblem(
  name: string,
  received: number,
  named: readonly string[],
): ArgumentProblem | undefined {
  const unknown = named[0];
  if (unknown !== undefined)
    return {
      kind: "unknownNamedArgument",
      name: unknown,
      message: unknownNamedArgumentMessage(name, unknown, []),
    };
  if (received >= 2) return undefined;
  return { kind: "argumentCount", message: argumentCountMessage(name, MIN_MAX_TAKES, received) };
}
