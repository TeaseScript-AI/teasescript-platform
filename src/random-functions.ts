import type { ArgumentShape } from "./argument-rules.js";
import { withoutNegativeZero } from "./conversions.js";
import { randomBeta, randomNormal, randomPert } from "./deterministic-math.js";
import type { RandomFunctionName } from "./language-facts.js";
import {
  noResult,
  percentageFailure,
  type NumberDomain,
  type NumberSignature,
  type NumericFailure,
} from "./numeric-functions.js";
import type { RandomSupport } from "./runtime/random-control.js";

/**
 * A random built-in (V30 §4): how it is called, what its arguments may be, what it gives, and its help. Every call
 * draws from the session generator, so it is not pure, but it only reads copies of its arguments and changes no script
 * value. A debug trace names its draws after it, and a host may choose a draw's outcome within its support
 * (`docs/RUNTIME.md#controlled-randomness`).
 */
export type RandomFunction = {
  /** What the call does, for the editor's help. */
  readonly summary: string;
} & (
  | (NumberSignature & {
      /** Numbers, each valid as the domains that read it say, which a draw checks before it draws (`TSR039`). */
      readonly takes: "numbers";
      readonly result: "number" | "boolean";
      readonly domains: readonly NumberDomain[];
      /** The natural result of a draw for valid numbers, or why it has none. */
      readonly sample: (
        values: readonly number[],
        draw: () => number,
      ) => number | boolean | NumericFailure;
      /** What a draw for valid numbers can produce, which a host chooses within. */
      readonly support: (values: readonly number[]) => RandomSupport;
    })
  | {
      /**
       * A range of whole numbers that holds at least one (`range-checks.ts`, as a wait or timer of a range takes it),
       * of which a draw takes one.
       */
      readonly takes: "range";
      readonly parameters: readonly ["range"];
      readonly result: "integer";
    }
  | {
      /**
       * A dict of weights, or a list of objects and `weight:`, the property that holds each element's weight; a draw
       * takes a key of the dict, or a copy of an element, with a chance in proportion to its weight.
       */
      readonly takes: "choices";
      readonly result: "choice";
      /** Its arguments: the dict or the list, and `weight:`, which only a list takes. */
      readonly shape: ArgumentShape;
      /**
       * Why it cannot choose from what it is given: a dict with `weight:`, a list without it, or another value. The last
       * names neither the type nor the value: the compiler and the runtime would describe them in different words, such
       * as an element type that only the compiler knows.
       */
      readonly sources: { readonly dict: string; readonly list: string; readonly other: string };
      /** Why a weight is invalid, or `undefined`. */
      readonly weightProblem: (weight: number) => string | undefined;
      /** Why valid weights are invalid together, or `undefined`. */
      readonly weightsProblem: (weights: readonly number[]) => string | undefined;
    }
);

/** A random function of numbers, such as `chance` or `randomNormal`. */
export type NumberRandomFunction = Extract<RandomFunction, { readonly takes: "numbers" }>;

/** A parameter of `name` that must be above 0, which its text names as `described`, such as "an alpha". */
function aboveZero(name: string, parameter: string, described: string): NumberDomain {
  return {
    reads: [parameter],
    problem: ([value]) =>
      value! > 0 ? undefined : `${name}(...) needs ${described} above 0, not ${value}.`,
  };
}

/** Two parameters of `randomPert` of which the first is at most the second. */
function pertOrder(low: string, high: string): NumberDomain {
  return {
    reads: [low, high],
    problem: ([first, second]) =>
      first! <= second!
        ? undefined
        : `randomPert(...) needs min <= mostLikely <= max, but ${low} ${first} is above ${high} ${second}.`,
  };
}

/** A value drawn by `name` from `values`, or the failure of one that is too large to represent. */
function sampled(
  name: string,
  values: readonly number[],
  value: number | undefined,
): number | NumericFailure {
  return value === undefined
    ? noResult(
        `${name}(${values.join(", ")}) gives a number too large to represent. Use smaller values.`,
      )
    : withoutNegativeZero(value);
}

/** Each random function's contract by its name, which `language-facts.ts` lists. */
export const RANDOM_CONTRACTS = {
  random: {
    takes: "numbers",
    parameters: [],
    result: "number",
    domains: [],
    sample: (_, draw) => draw(),
    support: () => ({ kind: "unit" }),
    summary: "Gives a random number from 0 up to, but not including, 1.",
  },
  chance: {
    takes: "numbers",
    parameters: ["percent"],
    result: "boolean",
    domains: [
      { reads: ["percent"], problem: ([percent]) => percentageFailure("chance", percent!) },
    ],
    // One draw, also at 0 and 100.
    sample: ([percent], draw) => draw() * 100 < percent!,
    support: ([percent]) => ({ kind: "chance", percent: percent! }),
    summary:
      "Gives true with a chance of percent, a percentage from 0 through 100, and false otherwise: chance(25) is true about once in four calls.",
  },
  randomInteger: {
    takes: "range",
    parameters: ["range"],
    result: "integer",
    summary:
      "Gives a random whole number of a range: randomInteger(1..=6) gives 1 through 6, and randomInteger(0..items.length) an index of a list. The range decides whether its end is included.",
  },
  randomWeighted: {
    takes: "choices",
    result: "choice",
    shape: { count: 1, takes: "1 argument (a dict, or a list with weight:)", names: ["weight"] },
    sources: {
      dict: "randomWeighted(...) of a dict takes its weights from the dict. Remove 'weight:'.",
      list: `randomWeighted(...) of a list needs weight:, the property that holds each element's weight, as in randomWeighted(tasks, weight: "chance").`,
      other: "randomWeighted(...) needs a dict of weights or a list of objects.",
    },
    weightProblem: (weight) =>
      weight < 0 ? `randomWeighted(...) needs weights of at least 0, not ${weight}.` : undefined,
    weightsProblem: (weights) =>
      weights.some((weight) => weight > 0)
        ? undefined
        : "randomWeighted(...) needs at least one weight above 0.",
    summary:
      'Chooses a key of a dict, weighted by its values, or a copy of an element of a list, weighted by the property that weight: names, as in randomWeighted(tasks, weight: "chance"). Weights are numbers of at least 0, and at least one is above 0; an element of weight 0 is never chosen.',
  },
  randomNormal: {
    takes: "numbers",
    parameters: ["mean", "spread"],
    result: "number",
    domains: [
      {
        reads: ["spread"],
        problem: ([spread]) =>
          spread! < 0
            ? `randomNormal(...) needs a spread of at least 0, not ${spread}.`
            : undefined,
      },
    ],
    sample: (values, draw) =>
      sampled("randomNormal", values, randomNormal(values[0]!, values[1]!, draw)),
    support: ([mean, spread]) => ({ kind: "normal", mean: mean!, spread: spread! }),
    summary:
      "Draws a number from the normal distribution with this mean and spread, its standard deviation: around the mean, mostly within two spreads of it. The spread is at least 0.",
  },
  randomBeta: {
    takes: "numbers",
    parameters: ["alpha", "beta"],
    result: "number",
    domains: [
      aboveZero("randomBeta", "alpha", "an alpha"),
      aboveZero("randomBeta", "beta", "a beta"),
    ],
    sample: (values, draw) =>
      sampled("randomBeta", values, randomBeta(values[0]!, values[1]!, draw)),
    support: ([alpha, beta]) => ({ kind: "beta", alpha: alpha!, beta: beta! }),
    summary:
      "Draws a number from 0 through 1 from the beta distribution, for alpha and beta above 0: randomBeta(2, 5) is mostly low.",
  },
  randomPert: {
    takes: "numbers",
    parameters: ["min", "mostLikely", "max"],
    result: "number",
    // Each pair, so that two numbers the compiler can see are checked whatever the third is.
    domains: [
      pertOrder("min", "max"),
      pertOrder("min", "mostLikely"),
      pertOrder("mostLikely", "max"),
    ],
    sample: (values, draw) =>
      sampled("randomPert", values, randomPert(values[0]!, values[1]!, values[2]!, draw)),
    support: ([min, mostLikely, max]) => ({
      kind: "pert",
      min: min!,
      mostLikely: mostLikely!,
      max: max!,
    }),
    summary:
      "Draws a number from min through max, most often near mostLikely, from the PERT distribution, for min <= mostLikely <= max. With min equal to max it gives min.",
  },
} as const satisfies { readonly [Name in RandomFunctionName]: RandomFunction };

export function isRandomFunction(name: string): name is RandomFunctionName {
  return Object.hasOwn(RANDOM_CONTRACTS, name);
}

/**
 * The call as the editor's help writes it, from its shape, such as `randomNormal(mean, spread)` or
 * `randomWeighted(dict)  or  randomWeighted(list, weight: text)`.
 */
export function randomSyntax(name: RandomFunctionName): string {
  const random: RandomFunction = RANDOM_CONTRACTS[name];
  return random.takes === "choices"
    ? `${name}(dict)  or  ${name}(list, weight: text)`
    : `${name}(${random.parameters.join(", ")})`;
}
