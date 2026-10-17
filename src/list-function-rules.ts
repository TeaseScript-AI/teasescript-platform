import {
  argumentCountMessage,
  argumentsTaken,
  unknownNamedArgumentMessage,
  type ArgumentProblem,
  type ArgumentShape,
} from "./argument-rules.js";
import type { ListFunctionName } from "./language-facts.js";
import { percentageFailure, type NumberDomain } from "./numeric-functions.js";

/**
 * The list functions (V30 §16, and `min` and `max`, V30 §13): one contract each, which the type checker, the runtime,
 * say staging, and the editor read. Each only reads its arguments and gives a new value. The type checker and the
 * runtime check their arguments' names and number with one message (`TSV022`, `TSV020`, and otherwise runtime error
 * `TSR028`, for a plan that this compiler did not check or a value whose type it does not know). `randomWeighted`
 * reads its weights as a list function reads values, but is a random function (`RANDOM_CONTRACTS`).
 */

/**
 * A kind of value a list function reads: numbers (integers and numbers together), exact durations, calendar durations,
 * angles, or one kind of date and time value.
 */
export type ListValueKind =
  | "number"
  | "duration"
  | "calendarDuration"
  | "angle"
  | "date"
  | "time"
  | "datetime"
  | "absoluteDateTime";

export type ListFunction = {
  /** The positional parameters, which also give the number of positional arguments. */
  readonly parameters: readonly string[];
  /** The named parameters, each the name of a property of the list's objects to read. */
  readonly named: readonly string[];
  /** What the call does, for the editor's help. */
  readonly summary: string;
} & (
  | {
      /**
       * The values of a list, or with `by:` that property of each of its objects, of one of these kinds; `min` and
       * `max` also take two or more values (`orValues`).
       */
      readonly takes: "values";
      readonly values: readonly ListValueKind[];
      /** The fewest values it needs: fewer is runtime error `TSR018`. */
      readonly fewest: number;
      /** What integers give: an `integer`, or a `number`. Other values give a value of their kind. */
      readonly integers: "integer" | "number";
      /** Its other numbers, each valid as the domains that read it say (`TSR039`), such as `percentile`'s percentage. */
      readonly domains: readonly NumberDomain[];
      readonly orValues?: true;
    }
  | {
      /** Points: the values of a list as y, of `values` kinds, at x positions of `positions` kinds. */
      readonly takes: "points";
      readonly values: readonly ListValueKind[];
      readonly positions: readonly ListValueKind[];
      readonly fewest: number;
    }
  | {
      /** A line from `linearRegression`, and an x of one of `positions`, the kind of the line's start. */
      readonly takes: "line";
      readonly positions: readonly ListValueKind[];
    }
);

/** The kinds of values a statistic reads. */
const AMOUNTS: readonly ListValueKind[] = ["number", "duration"];

/** The kinds of values `min` and `max` compare. */
const ORDERED: readonly ListValueKind[] = [
  "number",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
];

/** The kinds of x a line reads, each measured in steps or days. */
const POSITIONS: readonly ListValueKind[] = ["number", "date", "datetime", "absoluteDateTime"];

/** A statistic of the values of one list, or of that property of each of its objects with `by:`. */
function statistic(
  integers: "integer" | "number",
  summary: string,
  values = AMOUNTS,
  fewest = 1,
): ListFunction & { readonly takes: "values" } {
  return {
    takes: "values",
    parameters: ["list"],
    named: ["by"],
    values,
    fewest,
    integers,
    domains: [],
    summary,
  };
}

/** Each list function's contract by its name, which `language-facts.ts` lists. */
export const LIST_FUNCTION_CONTRACTS = {
  sum: statistic(
    "integer",
    'Gives the sum of the values of a list: numbers, durations, or angles, computed exactly and rounded once. Integers give an integer. With by:, it sums that property of a list of objects, as in sum(sessions, by: "count").',
    ["number", "duration", "angle"],
  ),
  average: statistic(
    "number",
    "Gives the average of the values of a list of numbers or durations, computed exactly and rounded once. With by:, it reads that property of a list of objects.",
  ),
  median: statistic(
    "number",
    "Gives the middle value of a list of numbers or durations, or the average of the two middle values. With by:, it reads that property of a list of objects.",
  ),
  percentile: {
    takes: "values",
    parameters: ["list", "percentage"],
    named: ["by"],
    values: AMOUNTS,
    fewest: 1,
    integers: "number",
    domains: [
      {
        reads: ["percentage"],
        problem: ([percentage]) => percentageFailure("percentile", percentage!),
      },
    ],
    summary:
      "Gives the value that percentage percent of the values of a list of numbers or durations lie at or below, for a percentage from 0 through 100: percentile(scores, 50) is the median. With by:, it reads that property of a list of objects.",
  },
  stddev: statistic(
    "number",
    "Gives the sample standard deviation of a list of at least 2 numbers or durations. With by:, it reads that property of a list of objects.",
    AMOUNTS,
    2,
  ),
  min: {
    ...statistic(
      "integer",
      "Gives the smallest of two or more values, or of the values of one list: all numbers, all durations, all calendar durations of one family, all angles, or all date and time values of one kind. With one list, by: reads that property of a list of objects.",
      ORDERED,
    ),
    orValues: true,
  },
  max: {
    ...statistic(
      "integer",
      "Gives the largest of two or more values, or of the values of one list: all numbers, all durations, all calendar durations of one family, all angles, or all date and time values of one kind. With one list, by: reads that property of a list of objects.",
      ORDERED,
    ),
    orValues: true,
  },
  linearRegression: {
    takes: "points",
    parameters: ["list"],
    named: ["y", "x"],
    values: AMOUNTS,
    positions: POSITIONS,
    fewest: 2,
    summary:
      "Fits the straight line closest to the points of a list, by least squares, and gives { slope, intercept, r2, start }. The values are numbers or durations at x = 0, 1, 2, and so on; y: names the property of a list of objects that holds them, and x: one that holds x as well: numbers, or dates, datetimes, or absolute dates and times of one kind. It needs at least 2 points.",
  },
  predict: {
    takes: "line",
    parameters: ["line", "x"],
    named: [],
    positions: POSITIONS,
    summary:
      "Gives the value of a line from linearRegression(...) at x, of the kind of the line's start: intercept + slope × (x − start), measured in days for date and time values.",
  },
} as const satisfies { readonly [Name in ListFunctionName]: ListFunction };

/** The statistics: the list functions of the values of one list, but `min` and `max`, which take values too. */
export type StatisticName = {
  [Name in ListFunctionName]: (typeof LIST_FUNCTION_CONTRACTS)[Name] extends {
    readonly orValues: true;
  }
    ? never
    : (typeof LIST_FUNCTION_CONTRACTS)[Name] extends { readonly takes: "values" }
      ? Name
      : never;
}[ListFunctionName];

export function isListFunction(name: string): name is ListFunctionName {
  return Object.hasOwn(LIST_FUNCTION_CONTRACTS, name);
}

/** `min` and `max`, which take the values of one list or two or more values. */
export type MinMaxName = {
  [Name in ListFunctionName]: (typeof LIST_FUNCTION_CONTRACTS)[Name] extends {
    readonly orValues: true;
  }
    ? Name
    : never;
}[ListFunctionName];

/**
 * Whether the list function `name` also takes two or more values, as `min` and `max` do (see `ListFunction`), so the
 * type of their arguments decides how a call is checked.
 */
export function takesValues(name: ListFunctionName): name is MinMaxName {
  const contract: ListFunction = LIST_FUNCTION_CONTRACTS[name];
  return contract.takes === "values" && contract.orValues === true;
}

/** Whether the list function `name` is a statistic (see `StatisticName`). */
export function isStatistic(name: ListFunctionName): name is StatisticName {
  const contract: ListFunction = LIST_FUNCTION_CONTRACTS[name];
  return contract.takes === "values" && contract.orValues !== true;
}

/** What a list function takes, and `min` and `max` with one list: its parameters, and its names, which it may leave out. */
export function listFunctionShape(name: ListFunctionName): ArgumentShape {
  const contract: ListFunction = LIST_FUNCTION_CONTRACTS[name];
  const named = contract.named.map((parameter) => `${parameter}:`);
  return {
    count: contract.parameters.length,
    takes: `${argumentsTaken(contract.parameters)}${named.length === 0 ? "" : `, and optionally ${named.join(" and ")}`}`,
    names: contract.named,
  };
}

/**
 * The call as the editor's help writes it, such as `percentile(list, percentage [, by: text])`, or for `min` and `max`
 * `min(value, value, ...)  or  min(list [, by: text])`.
 */
export function listFunctionSyntax(name: ListFunctionName): string {
  const contract: ListFunction = LIST_FUNCTION_CONTRACTS[name];
  const call = `${name}(${contract.parameters.join(", ")}${contract.named.map((parameter) => ` [, ${parameter}: text]`).join("")})`;
  return takesValues(name) ? `${name}(value, value, ...)  or  ${call}` : call;
}

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
