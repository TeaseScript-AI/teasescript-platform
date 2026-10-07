import { rounded, withoutNegativeZero } from "./conversions.js";
import {
  acosDegrees,
  asinDegrees,
  atan2Degrees,
  atanDegrees,
  cosDegrees,
  exp,
  ln,
  log10,
  randomBeta,
  randomNormal,
  randomPert,
  sinDegrees,
  tanDegrees,
} from "./deterministic-math.js";

/** What the compiler knows about one argument of a numeric function. */
export interface NumericArgument {
  /** `integer` or `number` when the argument is known to be one, `unknown` otherwise. */
  readonly type: "integer" | "number" | "unknown";
  /** The argument's value when the compiler can see it. */
  readonly known: number | undefined;
}

/** A built-in function of numbers (V30 §13): every argument is a number, and the result is one too. */
export interface NumericFunction {
  /** The positional parameter names, which also give the number of positional arguments. */
  readonly parameters: readonly string[];
  /** The named parameters the function may also take, each a number. */
  readonly named?: readonly string[];
  /** A call that shows how to use the function. */
  readonly example: string;
  /** The result type, from what the compiler knows about the arguments. */
  readonly result: (
    inputs: readonly NumericArgument[],
    named: Readonly<Record<string, NumericArgument>>,
  ) => "integer" | "number" | "unknown";
  /** The finite result, or why the call has none; a random function draws from the session RNG with `draw`. */
  readonly apply: (
    values: readonly number[],
    named: Readonly<Record<string, number>>,
    draw: () => number,
  ) => number | NumericFailure;
  /**
   * Marks a function that draws from the session RNG, and gives why its arguments are invalid. The runtime checks them
   * before any draw; the compiler checks arguments it can see, but never computes a random result.
   */
  readonly random?: (values: readonly number[]) => NumericFailure | undefined;
}

/**
 * Why a call of a numeric function has no result: a compile error when the compiler can see the arguments, and
 * otherwise runtime error `code`, `TSR036` for a result that is not a finite number and `TSR039` for an argument
 * outside the function's range.
 */
export interface NumericFailure {
  readonly failure: string;
  readonly code: "TSR036" | "TSR039";
}

function rounding(name: string): NumericFunction {
  return {
    parameters: ["value"],
    example: `${name}(2.5)`,
    result: () => "integer",
    apply: ([value]) => rounded(name, value!),
  };
}

/**
 * A function of one or two numbers whose result is always a `number`, computed by an engine-independent function that
 * gives `undefined` when there is no finite result; `failure` then explains why.
 */
function real(
  parameters: readonly string[],
  example: string,
  compute: (...values: number[]) => number | undefined,
  failure: (values: readonly number[]) => string,
): NumericFunction {
  return {
    parameters,
    example,
    result: () => "number",
    apply: (values) => {
      const result = compute(...values);
      return result === undefined ? noResult(failure(values)) : withoutNegativeZero(result);
    },
  };
}

const LOGARITHM = (name: string) => (values: readonly number[]) =>
  `${name}(${values[0]}) has no result: only a number above 0 has a logarithm.`;

/** `integer` when every input is one, `number` when every input is a number, and `unknown` otherwise. */
function together(inputs: readonly NumericArgument[]): "integer" | "number" | "unknown" {
  if (inputs.some((input) => input.type === "unknown")) return "unknown";
  return inputs.every((input) => input.type === "integer") ? "integer" : "number";
}

/** The numeric built-ins by name. */
export const NUMERIC_FUNCTIONS: ReadonlyMap<string, NumericFunction> = new Map([
  [
    "round",
    {
      parameters: ["value"],
      named: ["decimals"],
      example: "round(2.5)",
      result: (_, { decimals }) => (decimals === undefined ? "integer" : "number"),
      apply: ([value], { decimals }) =>
        decimals === undefined ? rounded("round", value!) : roundedToDecimals(value!, decimals),
    },
  ],
  ["floor", rounding("floor")],
  ["ceil", rounding("ceil")],
  [
    "abs",
    {
      parameters: ["value"],
      example: "abs(-2)",
      result: ([value]) => value!.type,
      apply: ([value]) => Math.abs(value!),
    },
  ],
  [
    "sign",
    {
      parameters: ["value"],
      example: "sign(-2)",
      result: () => "integer",
      apply: ([value]) => withoutNegativeZero(Math.sign(value!)),
    },
  ],
  [
    "sqrt",
    {
      parameters: ["value"],
      example: "sqrt(2)",
      result: () => "number",
      // IEEE 754 rounds a square root correctly, so every JavaScript engine gives the same result.
      apply: ([value]) =>
        value! < 0
          ? noResult(`sqrt(${value}) has no result: a negative number has no square root.`)
          : Math.sqrt(value!),
    },
  ],
  [
    "pow",
    {
      parameters: ["base", "exponent"],
      example: "pow(2, 3)",
      // A whole number to a whole power of at least 0 is whole.
      result: ([base, exponent]) =>
        exponent!.known !== undefined && Number.isInteger(exponent!.known) && exponent!.known >= 0
          ? base!.type
          : "number",
      apply: ([base, exponent]) => power(base!, exponent!),
    },
  ],
  [
    "mod",
    {
      parameters: ["value", "divisor"],
      example: "mod(-1, 3)",
      result: together,
      apply: ([value, divisor]) => modulo(value!, divisor!),
    },
  ],
  [
    "clamp",
    {
      parameters: ["value", "min", "max"],
      example: "clamp(level, 1, 10)",
      result: together,
      apply: ([value, min, max]) =>
        min! > max!
          ? {
              failure: `clamp(${value}, ${min}, ${max}) needs a min that is at most its max.`,
              code: "TSR039",
            }
          : Math.min(Math.max(value!, min!), max!),
    },
  ],
  [
    "exp",
    real(
      ["value"],
      "exp(1)",
      exp,
      ([value]) => `exp(${value}) gives a number too large to represent. Use smaller values.`,
    ),
  ],
  ["ln", real(["value"], "ln(10)", ln, LOGARITHM("ln"))],
  ["log10", real(["value"], "log10(1000)", log10, LOGARITHM("log10"))],
  ["sin", real(["degrees"], "sin(30)", sinDegrees, () => "")],
  ["cos", real(["degrees"], "cos(60)", cosDegrees, () => "")],
  [
    "tan",
    real(
      ["degrees"],
      "tan(45)",
      tanDegrees,
      ([degrees]) =>
        `tan(${degrees}) has no result: the tangent of ${degrees} degrees is infinite.`,
    ),
  ],
  [
    "asin",
    real(
      ["value"],
      "asin(0.5)",
      asinDegrees,
      ([value]) => `asin(${value}) has no result: only a number from -1 through 1 has an arcsine.`,
    ),
  ],
  [
    "acos",
    real(
      ["value"],
      "acos(0.5)",
      acosDegrees,
      ([value]) =>
        `acos(${value}) has no result: only a number from -1 through 1 has an arccosine.`,
    ),
  ],
  ["atan", real(["value"], "atan(1)", atanDegrees, () => "")],
  ["atan2", real(["y", "x"], "atan2(1, 1)", atan2Degrees, () => "")],
  [
    "randomNormal",
    {
      parameters: ["mean", "spread"],
      example: "randomNormal(20, 5)",
      result: () => "number",
      random: ([, spread]) =>
        spread! < 0
          ? {
              failure: `randomNormal(...) needs a spread of at least 0, not ${spread}.`,
              code: "TSR039",
            }
          : undefined,
      apply: ([mean, spread], _, draw) =>
        sampled("randomNormal", randomNormal(mean!, spread!, draw)),
    },
  ],
  [
    "randomBeta",
    {
      parameters: ["alpha", "beta"],
      example: "randomBeta(2, 5)",
      result: () => "number",
      random: ([alpha, beta]) =>
        alpha! > 0 && beta! > 0
          ? undefined
          : {
              failure: `randomBeta(...) needs an alpha and a beta above 0, not ${alpha} and ${beta}.`,
              code: "TSR039",
            },
      apply: ([alpha, beta], _, draw) => sampled("randomBeta", randomBeta(alpha!, beta!, draw)),
    },
  ],
  [
    "randomPert",
    {
      parameters: ["min", "mostLikely", "max"],
      example: "randomPert(5, 10, 20)",
      result: () => "number",
      random: ([min, mostLikely, max]) =>
        min! <= mostLikely! && mostLikely! <= max!
          ? undefined
          : {
              failure: `randomPert(...) needs min <= mostLikely <= max, not ${min}, ${mostLikely}, and ${max}.`,
              code: "TSR039",
            },
      apply: ([min, mostLikely, max], _, draw) =>
        sampled("randomPert", randomPert(min!, mostLikely!, max!, draw)),
    },
  ],
]);

/** A drawn value, or the failure of one that is too large to represent. */
function sampled(name: string, value: number | undefined): number | NumericFailure {
  return value === undefined
    ? noResult(`${name}(...) gives a number too large to represent. Use smaller values.`)
    : withoutNegativeZero(value);
}

function noResult(failure: string): NumericFailure {
  return { failure, code: "TSR036" };
}

/**
 * `value` rounded to `decimals` decimal places, a half away from zero, as the number is written: `round(2.675,
 * decimals: 2)` is 2.68, although the double nearest 2.675 is slightly below it.
 */
function roundedToDecimals(value: number, decimals: number): number | NumericFailure {
  if (!Number.isInteger(decimals) || decimals < 0)
    return {
      failure: `round(...) needs decimals: to be a whole number of at least 0, not ${decimals}.`,
      code: "TSR039",
    };
  // String() writes the shortest decimal that reads back as the same double, alike on every engine (ECMAScript
  // Number::toString): its digits are the number as the author sees it, value = digits × 10^-scale.
  const [, whole, fraction = "", exponent = "0"] = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(
    String(Math.abs(value)),
  )!;
  const digits = `${whole}${fraction}`;
  const dropped = fraction.length - Number(exponent) - decimals;
  if (dropped <= 0) return value;
  const kept = digits.length - dropped;
  let result = kept > 0 ? BigInt(digits.slice(0, kept)) : 0n;
  if (kept >= 0 && digits[kept]! >= "5") result += 1n;
  // A decimal of at most 17 significant digits reads back as its nearest double on every engine.
  const magnitude = Number(`${result}e-${decimals}`);
  return withoutNegativeZero(value < 0 ? -magnitude : magnitude);
}

/** The remainder of `value` divided by `divisor` with the sign of the divisor: `mod(-1, 3)` is 2. */
function modulo(value: number, divisor: number): number | NumericFailure {
  if (divisor === 0) return noResult(`mod(${value}, 0) has no result: it divides by zero.`);
  // `%` is exact and keeps the sign of `value`.
  const remainder = value % divisor;
  if (remainder === 0 || remainder < 0 === divisor < 0) return withoutNegativeZero(remainder);
  // A remainder too small to add to the divisor exactly would round to the divisor itself.
  const shifted = remainder + divisor;
  return shifted === divisor ? 0 : shifted;
}

/** `base` to the power `exponent`, or why there is no finite result. */
function power(base: number, exponent: number): number | NumericFailure {
  const call = `pow(${base}, ${exponent})`;
  if (exponent === 0) return 1;
  if (base === 0) return exponent > 0 ? 0 : noResult(`${call} has no result: it divides by zero.`);
  if (base < 0 && !Number.isInteger(exponent))
    return noResult(`${call} has no result: a negative base needs a whole exponent.`);
  // `%` is exact, and every double of at least 2^53 is even.
  const sign = base < 0 && exponent % 2 !== 0 ? -1 : 1;
  const magnitude = Math.abs(base) === 1 ? 1 : positivePower(Math.abs(base), exponent);
  if (magnitude === undefined)
    return noResult(`${call} gives a number too large to represent. Use smaller values.`);
  return withoutNegativeZero(sign * magnitude);
}

/*
 * Math.pow and ** differ between JavaScript engines in the last bits, also for whole exponents, so `pow` computes its
 * result only with operations that IEEE 754 rounds correctly, which every engine therefore computes alike: + - * / and
 * Math.sqrt. base^exponent is the product of base^whole, by repeated squaring, and base^fraction, by repeated square
 * roots for the binary digits of the fraction. Each step works in double-double arithmetic, a value as the unevaluated
 * sum hi + lo of two doubles, so the product keeps about 100 bits and its final rounding gives the correctly rounded
 * result except within about 2^-100 of a rounding boundary. A separate binary exponent keeps every step in range.
 */

/** The value (hi + lo) × 2^exponent, with hi in [1, 2] and |lo| at most half a unit in the last place of hi. */
interface Scaled {
  readonly hi: number;
  readonly lo: number;
  /** A whole number, or infinite once the value is known to be beyond any finite double or below the smallest. */
  readonly exponent: number;
}

const ONE: Scaled = { hi: 1, lo: 0, exponent: 0 };

const TWO_32 = 4294967296;

/** A binary exponent beyond which base^whole is too large, or too small, whatever the fraction's factor adds. */
const EXPONENT_LIMIT = 2400;

/** Further roots that are this close to 1 change the product by less than 2^-107 together. */
const ROOT_PRECISION = 1 / TWO_32 / TWO_32 / TWO_32 / 4096; // 2^-108

/** `base` (positive, not 1) to the power `exponent` (not 0), or `undefined` when it is too large to represent. */
function positivePower(base: number, exponent: number): number | undefined {
  const whole = Math.trunc(Math.abs(exponent));
  const fraction = Math.abs(exponent) - whole;
  const scaled = scaledOf(base);
  let result = whole === 0 ? ONE : wholePower(scaled, whole);
  if (fraction > 0 && Number.isFinite(result.exponent))
    result = multiply(result, fractionPower(scaled, fraction));
  return numberOf(exponent < 0 ? reciprocal(result) : result);
}

/** `base` to the power `whole`, a positive whole number, by repeated squaring. */
function wholePower(base: Scaled, whole: number): Scaled {
  let result = ONE;
  let factor = base;
  let remaining = whole;
  while (true) {
    // Halving and flooring a double are exact.
    const half = Math.floor(remaining / 2);
    if (remaining - 2 * half === 1) result = multiply(result, factor);
    remaining = half;
    // The factors all grow or all shrink, so one beyond the limit puts base^whole beyond it.
    if (Math.abs(result.exponent) > EXPONENT_LIMIT) return beyondLimit(result);
    if (remaining === 0) return result;
    factor = multiply(factor, factor);
    if (Math.abs(factor.exponent) > EXPONENT_LIMIT) return beyondLimit(factor);
  }
}

function beyondLimit(value: Scaled): Scaled {
  return { ...ONE, exponent: value.exponent > 0 ? Infinity : -Infinity };
}

/** `base` to the power `fraction`, between 0 and 1: the product of base^(2^-i) for each binary digit i of `fraction`. */
function fractionPower(base: Scaled, fraction: number): Scaled {
  let result = ONE;
  let root = base;
  let digits = fraction;
  while (digits > 0) {
    root = squareRoot(root);
    // Doubling a fraction, and taking 1 from a double in [1, 2), are exact.
    digits *= 2;
    if (digits >= 1) {
      result = multiply(result, root);
      digits -= 1;
    }
    // Each further root is half as far from 1, so at most about 120 roots are needed.
    if (root.exponent === 0 && Math.abs(root.hi - 1 + root.lo) < ROOT_PRECISION) break;
  }
  return result;
}

/** A positive finite double as a scaled value; scaling by powers of 2 is exact. */
function scaledOf(value: number): Scaled {
  let hi = value;
  let exponent = 0;
  while (hi >= TWO_32) {
    hi /= TWO_32;
    exponent += 32;
  }
  while (hi < 1 / TWO_32) {
    hi *= TWO_32;
    exponent -= 32;
  }
  return normalized(hi, 0, exponent);
}

/** The double nearest to a scaled value, or `undefined` when it is too large to represent. */
function numberOf(value: Scaled): number | undefined {
  // Below 2^-1075 the value rounds to 0; from 2^1024 on it is not finite.
  if (value.exponent < -1075) return 0;
  if (value.exponent > 1023) return undefined;
  let result = value.hi + value.lo;
  // Scaling by a power of 2 is exact while the result is a normal double, so a subnormal result is rounded only once,
  // by the last step.
  let exponent = Math.max(value.exponent, -1022);
  while (exponent !== 0) {
    const step = Math.max(-32, Math.min(32, exponent));
    result = step > 0 ? result * powerOfTwo(step) : result / powerOfTwo(-step);
    exponent -= step;
  }
  if (value.exponent < -1022) result /= powerOfTwo(-1022 - value.exponent);
  return Number.isFinite(result) ? result : undefined;
}

/** 2^count for a whole count from 0 to 64, by exact doubling. */
function powerOfTwo(count: number): number {
  let result = 1;
  for (let step = 0; step < count; step += 1) result *= 2;
  return result;
}

/** hi + lo, with hi positive and finite, scaled so that hi is in [1, 2). */
function normalized(hi: number, lo: number, exponent: number): Scaled {
  while (hi >= 2) {
    hi /= 2;
    lo /= 2;
    exponent += 1;
  }
  while (hi < 1) {
    hi *= 2;
    lo *= 2;
    exponent -= 1;
  }
  return { hi, lo, exponent };
}

function multiply(left: Scaled, right: Scaled): Scaled {
  const [product, error] = twoProduct(left.hi, right.hi);
  const [hi, lo] = quickTwoSum(product, error + (left.hi * right.lo + left.lo * right.hi));
  return normalized(hi, lo, left.exponent + right.exponent);
}

function squareRoot(value: Scaled): Scaled {
  // An odd exponent moves a factor 2 into the mantissa, which is then in [2, 4).
  const odd = value.exponent % 2 !== 0;
  const hi = odd ? value.hi * 2 : value.hi;
  const lo = odd ? value.lo * 2 : value.lo;
  const root = Math.sqrt(hi);
  // One Newton step corrects the root for the rest of hi - root² and for lo; hi - square is exact.
  const [square, error] = twoProduct(root, root);
  const [sumHi, sumLo] = quickTwoSum(root, (hi - square - error + lo) / (2 * root));
  return normalized(sumHi, sumLo, (odd ? value.exponent - 1 : value.exponent) / 2);
}

function reciprocal(value: Scaled): Scaled {
  if (!Number.isFinite(value.exponent)) return { ...ONE, exponent: -value.exponent };
  const quotient = 1 / value.hi;
  // The remainder 1 - quotient × (hi + lo); 1 - product is exact.
  const [product, error] = twoProduct(quotient, value.hi);
  const remainder = 1 - product - error - quotient * value.lo;
  const [hi, lo] = quickTwoSum(quotient, remainder * quotient);
  return normalized(hi, lo, -value.exponent);
}

/** a + b, where |a| >= |b|, as the rounded sum and its exact error. */
function quickTwoSum(a: number, b: number): [number, number] {
  const sum = a + b;
  return [sum, b - (sum - a)];
}

/** a × b, both in [0, 4], as the rounded product and its exact error, by Dekker's splitting. */
function twoProduct(a: number, b: number): [number, number] {
  const product = a * b;
  const [aHi, aLo] = split(a);
  const [bHi, bLo] = split(b);
  return [product, aHi * bHi - product + aHi * bLo + aLo * bHi + aLo * bLo];
}

/** A double as the sum of two halves of at most 26 significant bits each. */
function split(value: number): [number, number] {
  const scaled = 134217729 * value; // 2^27 + 1
  const hi = scaled - (scaled - value);
  return [hi, value - hi];
}
