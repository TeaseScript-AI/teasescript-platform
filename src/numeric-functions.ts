import { angleValue, formatAngle, type StoredAngle } from "./angle.js";
import { withoutNegativeZero } from "./conversions.js";
import {
  acosDegrees,
  asinDegrees,
  atan2Degrees,
  atanDegrees,
  cosDegrees,
  degreesToRadians,
  exp,
  ln,
  log10,
  sinDegrees,
  tanDegrees,
} from "./deterministic-math.js";
import type { NumericFunctionName } from "./language-facts.js";

/** What the compiler knows about one argument of a numeric function. */
export interface NumericArgument {
  /** `integer` or `number` when the argument is known to be one, `unknown` otherwise. */
  readonly type: "integer" | "number" | "unknown";
  /** The argument's value when the compiler can see it: a number, or an angle's size in degrees. */
  readonly known: number | undefined;
}

/** How a function whose every argument is a number or an angle is called: a numeric function, or a random one such as `chance`. */
export interface NumberSignature {
  /** What every argument is: a number, or an angle, which the function's domains and result read as its degrees. */
  readonly takes: "numbers" | "angles";
  /** The positional parameter names, which also give the number of positional arguments. */
  readonly parameters: readonly string[];
  /** The named parameters the function may also take, each a number. */
  readonly named?: readonly string[];
}

/**
 * Why a call of a numeric or random function has no result: a compile error when the compiler can see the arguments
 * that cause it, and otherwise runtime error `code`, `TSR036` for a result that is not a finite number and `TSR039` for
 * an argument outside the function's range.
 */
export interface NumericFailure {
  readonly failure: string;
  readonly code: "TSR036" | "TSR039";
}

/**
 * A domain of a function's numbers: the parameters it reads, by name, and why their values are invalid. The runtime
 * checks a call's domains in order before the result, and fails at the first that fails; the compiler checks each domain
 * whose numbers it can see, whatever the call's other arguments are.
 */
export interface NumberDomain {
  readonly reads: readonly string[];
  /** Why the numbers it reads, in the order of `reads`, are invalid, or `undefined` when they are valid. */
  readonly problem: (values: readonly number[]) => string | undefined;
  /**
   * `TSR036` when such numbers give no finite result, as a negative number has no square root; without it a call fails
   * with `TSR039`, an argument out of range.
   */
  readonly code?: "TSR036";
}

/** The result type of a numeric function, from what the compiler knows about its arguments. */
type ResultRule = (
  inputs: readonly NumericArgument[],
  named: Readonly<Record<string, NumericArgument>>,
) => "integer" | "number" | "unknown";

/**
 * A built-in function of numbers or angles (V30 §13): how it is called, what its arguments may be, what it gives, and
 * its help. It only reads its numbers and gives a new value.
 */
export interface NumericFunction extends NumberSignature {
  /** What the call does, for the editor's help. */
  readonly summary: string;
  /** The result type, or how it follows from what the compiler knows about the arguments. */
  readonly result: "integer" | "number" | "angle" | ResultRule;
  readonly domains: readonly NumberDomain[];
  /**
   * The result of numbers within every domain, or why it has none: a result too large to represent, or an infinite
   * tangent. Only `numericResult` calls it, after the domains.
   */
  readonly apply: (
    values: readonly number[],
    named: Readonly<Record<string, number>>,
  ) => number | StoredAngle | NumericFailure;
}

/** Whether `value` is a percentage from 0 through 100, as `chance` and `percentile` take it (V30 §4, §16). */
function isPercentage(value: number): boolean {
  return value >= 0 && value <= 100;
}

/**
 * Why `name` cannot take `value` as its percentage, or `undefined` when it can: a compile error when the compiler can
 * see the value, and otherwise runtime error `TSR039`.
 */
export function percentageFailure(name: string, value: number): string | undefined {
  return isPercentage(value)
    ? undefined
    : `${name}(...) needs a percentage from 0 through 100, not ${value}.`;
}

/** A function of one number that gives a whole number: `floor`, `ceil`, or `round` without `decimals:`. */
function rounding(compute: (value: number) => number, summary: string): NumericFunction {
  return {
    takes: "numbers",
    parameters: ["value"],
    result: "integer",
    domains: [],
    apply: ([value]) => withoutNegativeZero(compute(value!)),
    summary,
  };
}

/** `value` rounded to a whole number, a half away from zero. */
function halfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** The domain of a logarithm: a number above 0. */
function logarithmDomain(name: string): NumberDomain {
  return {
    reads: ["value"],
    problem: ([value]) =>
      value! > 0
        ? undefined
        : `${name}(${value}) has no result: only a number above 0 has a logarithm.`,
    code: "TSR036",
  };
}

/** The domain of an arcsine or arccosine: a number from -1 through 1. */
function ratioDomain(name: string, inverse: string): NumberDomain {
  return {
    reads: ["value"],
    problem: ([value]) =>
      Math.abs(value!) <= 1
        ? undefined
        : `${name}(${value}) has no result: only a number from -1 through 1 has an ${inverse}.`,
    code: "TSR036",
  };
}

/** A function of one angle that gives a number. */
function ofAngle(compute: (degrees: number) => number, summary: string): NumericFunction {
  return {
    takes: "angles",
    parameters: ["angle"],
    result: "number",
    domains: [],
    apply: ([degrees]) => withoutNegativeZero(compute(degrees!)),
    summary,
  };
}

/** `integer` when every input is one, `number` when every input is a number, and `unknown` otherwise. */
function together(inputs: readonly NumericArgument[]): "integer" | "number" | "unknown" {
  if (inputs.some((input) => input.type === "unknown")) return "unknown";
  return inputs.every((input) => input.type === "integer") ? "integer" : "number";
}

/** Each numeric function's contract by its name, which `language-facts.ts` lists. */
export const NUMERIC_CONTRACTS = {
  round: {
    takes: "numbers",
    parameters: ["value"],
    named: ["decimals"],
    result: (_, { decimals }) => (decimals === undefined ? "integer" : "number"),
    domains: [
      {
        reads: ["decimals"],
        problem: ([decimals]) =>
          Number.isInteger(decimals) && decimals! >= 0
            ? undefined
            : `round(...) needs decimals: to be a whole number of at least 0, not ${decimals}.`,
      },
    ],
    apply: ([value], { decimals }) =>
      withoutNegativeZero(
        decimals === undefined ? halfAwayFromZero(value!) : roundedToDecimals(value!, decimals),
      ),
    summary:
      "Rounds a number to the nearest whole number, a half away from zero: round(2.5) is 3 and round(-2.5) is -3. With decimals:, a whole number of at least 0, it rounds to that many decimal places as the number is written and gives a number: round(2.675, decimals: 2) is 2.68.",
  },
  floor: rounding(
    Math.floor,
    "Rounds a number down to a whole number, toward negative infinity: floor(-2.5) is -3.",
  ),
  ceil: rounding(
    Math.ceil,
    "Rounds a number up to a whole number, toward positive infinity: ceil(-2.5) is -2.",
  ),
  abs: {
    takes: "numbers",
    parameters: ["value"],
    result: ([value]) => value!.type,
    domains: [],
    apply: ([value]) => Math.abs(value!),
    summary: "Gives the distance of a number from 0: abs(-2.5) is 2.5.",
  },
  sign: {
    takes: "numbers",
    parameters: ["value"],
    result: "integer",
    domains: [],
    apply: ([value]) => withoutNegativeZero(Math.sign(value!)),
    summary: "Gives -1 for a number below 0, 0 for 0, and 1 for a number above 0.",
  },
  sqrt: {
    takes: "numbers",
    parameters: ["value"],
    result: "number",
    domains: [
      {
        reads: ["value"],
        problem: ([value]) =>
          value! < 0
            ? `sqrt(${value}) has no result: a negative number has no square root.`
            : undefined,
        code: "TSR036",
      },
    ],
    // IEEE 754 rounds a square root correctly, so every JavaScript engine gives the same result.
    apply: ([value]) => Math.sqrt(value!),
    summary: "Gives the square root of a number of at least 0: sqrt(9) is 3.",
  },
  pow: {
    takes: "numbers",
    parameters: ["base", "exponent"],
    // A whole number to a whole power of at least 0 is whole.
    result: ([base, exponent]) =>
      exponent!.known !== undefined && Number.isInteger(exponent!.known) && exponent!.known >= 0
        ? base!.type
        : "number",
    domains: [
      {
        reads: ["base", "exponent"],
        problem: ([base, exponent]) =>
          base === 0 && exponent! < 0
            ? `pow(${base}, ${exponent}) has no result: it divides by zero.`
            : undefined,
        code: "TSR036",
      },
      {
        reads: ["base", "exponent"],
        problem: ([base, exponent]) =>
          base! < 0 && !Number.isInteger(exponent)
            ? `pow(${base}, ${exponent}) has no result: a negative base needs a whole exponent.`
            : undefined,
        code: "TSR036",
      },
    ],
    apply: ([base, exponent]) => power(base!, exponent!),
    summary:
      "Raises base to exponent: pow(2, 10) is 1024, pow(10, -2) is 0.01, and pow(8, 1 / 3) is 2. A base of 0 needs an exponent of at least 0, and a negative base a whole exponent.",
  },
  mod: {
    takes: "numbers",
    parameters: ["value", "divisor"],
    result: together,
    domains: [
      {
        reads: ["divisor"],
        problem: ([divisor]) =>
          divisor === 0 ? "mod(...) has no result: it divides by zero." : undefined,
        code: "TSR036",
      },
    ],
    apply: ([value, divisor]) => modulo(value!, divisor!),
    summary:
      "Gives the remainder of value divided by divisor, with the sign of the divisor: mod(-1, 3) is 2, where -1 % 3 is -1. The divisor is not 0.",
  },
  clamp: {
    takes: "numbers",
    parameters: ["value", "min", "max"],
    result: together,
    domains: [
      {
        reads: ["min", "max"],
        problem: ([min, max]) =>
          min! > max!
            ? `clamp(...) needs a min that is at most its max, but min ${min} is above max ${max}.`
            : undefined,
      },
    ],
    apply: ([value, min, max]) => Math.min(Math.max(value!, min!), max!),
    summary:
      "Gives value, raised to min or lowered to max: clamp(15, 1, 10) is 10. Its min is at most its max.",
  },
  exp: {
    takes: "numbers",
    parameters: ["value"],
    result: "number",
    domains: [],
    apply: ([value]) => {
      const result = exp(value!);
      return result === undefined
        ? noResult(`exp(${value}) gives a number too large to represent. Use smaller values.`)
        : withoutNegativeZero(result);
    },
    summary: "Gives e raised to a number: exp(1) is about 2.71828.",
  },
  ln: {
    takes: "numbers",
    parameters: ["value"],
    result: "number",
    domains: [logarithmDomain("ln")],
    // The domain keeps the value above 0, where the logarithm has a result.
    apply: ([value]) => withoutNegativeZero(ln(value!)!),
    summary: "Gives the natural logarithm of a number above 0: ln(1) is 0.",
  },
  log10: {
    takes: "numbers",
    parameters: ["value"],
    result: "number",
    domains: [logarithmDomain("log10")],
    apply: ([value]) => withoutNegativeZero(log10(value!)!),
    summary: "Gives the logarithm to base 10 of a number above 0: log10(1000) is 3.",
  },
  sin: ofAngle(sinDegrees, "Gives the sine of an angle: sin(30 deg) is 0.5."),
  cos: ofAngle(cosDegrees, "Gives the cosine of an angle: cos(pi rad) is -1."),
  tan: {
    takes: "angles",
    parameters: ["angle"],
    result: "number",
    domains: [],
    apply: ([degrees]) => {
      const angle = angleValue(degrees!);
      const result = tanDegrees(angle.degrees);
      return result === undefined
        ? noResult(
            `tan(${formatAngle(angle)}) has no result: the tangent of ${formatAngle(angle)} is infinite.`,
          )
        : withoutNegativeZero(result);
    },
    summary:
      "Gives the tangent of an angle: tan(45 deg) is 1. An odd multiple of 90° has no tangent.",
  },
  asin: {
    takes: "numbers",
    parameters: ["value"],
    result: "angle",
    domains: [ratioDomain("asin", "arcsine")],
    // The domain keeps the value from -1 through 1, where the angle has a result.
    apply: ([value]) => angleValue(asinDegrees(value!)!),
    summary:
      "Gives the angle from -90° through 90° whose sine is a number from -1 through 1: asin(0.5) is 30°.",
  },
  acos: {
    takes: "numbers",
    parameters: ["value"],
    result: "angle",
    domains: [ratioDomain("acos", "arccosine")],
    apply: ([value]) => angleValue(acosDegrees(value!)!),
    summary:
      "Gives the angle from 0° through 180° whose cosine is a number from -1 through 1: acos(0.5) is 60°.",
  },
  atan: {
    takes: "numbers",
    parameters: ["value"],
    result: "angle",
    domains: [],
    apply: ([value]) => angleValue(atanDegrees(value!)),
    summary: "Gives the angle above -90° and below 90° whose tangent is a number: atan(1) is 45°.",
  },
  atan2: {
    takes: "numbers",
    parameters: ["y", "x"],
    result: "angle",
    domains: [],
    apply: ([y, x]) => angleValue(atan2Degrees(y!, x!)),
    summary:
      "Gives the angle of the direction from the origin to the point (x, y), above -180° and up to 180°: atan2(1, -1) is 135°, and atan2(0, 0) is 0°.",
  },
  toDeg: ofAngle(
    (degrees) => degrees,
    "Gives the size of an angle as a number of degrees: toDeg(pi rad) is 180. Give a plain number its unit first, as in toDeg(input rad).",
  ),
  toRad: ofAngle(
    degreesToRadians,
    "Gives the size of an angle as a number of radians: toRad(180 deg) is 3.141592653589793. Give a plain number its unit first, as in toRad(input deg).",
  ),
} as const satisfies { readonly [Name in NumericFunctionName]: NumericFunction };

export function isNumericFunction(name: string): name is NumericFunctionName {
  return Object.hasOwn(NUMERIC_CONTRACTS, name);
}

/** The argument of `parameter` among a call's positional and named ones, as `signature` orders them. */
export function parameterArgument<Argument>(
  signature: NumberSignature,
  parameter: string,
  positional: readonly Argument[],
  named: Readonly<Record<string, Argument>>,
): Argument | undefined {
  const position = signature.parameters.indexOf(parameter);
  if (position !== -1) return positional[position];
  return Object.hasOwn(named, parameter) ? named[parameter] : undefined;
}

/**
 * The first of `domains` that a call's numbers fail, as the runtime checks them before the result, or `undefined`. A
 * domain that reads a named number the call does not give is not checked.
 */
export function domainFailure(
  signature: NumberSignature & { readonly domains: readonly NumberDomain[] },
  values: readonly number[],
  named: Readonly<Record<string, number>> = {},
): NumericFailure | undefined {
  for (const domain of signature.domains) {
    const read = domain.reads.flatMap(
      (parameter) => parameterArgument(signature, parameter, values, named) ?? [],
    );
    if (read.length < domain.reads.length) continue;
    const problem = domain.problem(read);
    if (problem !== undefined) return { failure: problem, code: domain.code ?? "TSR039" };
  }
  return undefined;
}

/** The result of a numeric function's numbers (angles as their degrees), or why it has none: its domains, then `apply`. */
export function numericResult(
  numeric: NumericFunction,
  values: readonly number[],
  named: Readonly<Record<string, number>>,
): number | StoredAngle | NumericFailure {
  return domainFailure(numeric, values, named) ?? numeric.apply(values, named);
}

/** Whether a numeric function's result is a failure. */
export function isNumericFailure(
  result: number | StoredAngle | NumericFailure,
): result is NumericFailure {
  return typeof result === "object" && "failure" in result;
}

/**
 * The fix for a plain number where an angle function needs an angle: both units, or for `toDeg` and `toRad` the unit
 * they convert from, since a plain number does not say its unit.
 */
function plainNumberFix(name: string): string {
  if (name === "toDeg") return "write 'toDeg(pi rad)' for radians";
  if (name === "toRad") return "write 'toRad(180 deg)' for degrees";
  return `write '${name}(${name === "tan" ? 45 : 90} deg)' for degrees or '${name}(1.5 rad)' for radians`;
}

/**
 * Why an argument of `name`, a function of numbers or angles, does not fit, for a value described as `given` that is a
 * number, text, an angle, or another value (`kind`); `place` names a named argument, as in ` as its decimals:`. A plain
 * number where an angle is needed gets the unit to write, text gets its conversion, and an angle where a number is
 * needed gets its size in degrees, unless the function gives an angle: it takes a number such as a sine.
 */
export function numberArgumentMessage(
  name: string,
  signature: NumberSignature & { readonly result: unknown },
  given: string,
  kind: "number" | "string" | "angle" | "other",
  place = "",
): string {
  if (signature.takes === "angles")
    return kind === "number"
      ? `${name} needs an angle: ${plainNumberFix(name)}.`
      : `${name}(...) needs an angle, not ${given}.`;
  const fix =
    kind === "string"
      ? " Convert the text with the toNumber function."
      : kind === "angle" && signature.result !== "angle"
        ? " Convert the angle to a number of degrees with the toDeg function first."
        : "";
  return `${name}(...) needs a number${place}, not ${given}.${fix}`;
}

/** The call as the editor's help writes it, such as `atan2(y, x)` or `round(value [, decimals: number])`. */
export function numericSyntax(name: NumericFunctionName): string {
  const numeric: NumericFunction = NUMERIC_CONTRACTS[name];
  const named = (numeric.named ?? []).map((parameter) => ` [, ${parameter}: number]`).join("");
  return `${name}(${numeric.parameters.join(", ")}${named})`;
}

/** The failure of a call with no finite result: `TSR036`. */
export function noResult(failure: string): NumericFailure {
  return { failure, code: "TSR036" };
}

/**
 * `value` rounded to `decimals` decimal places, a whole number of at least 0, a half away from zero, as the number is
 * written: `round(2.675, decimals: 2)` is 2.68, although the double nearest 2.675 is slightly below it.
 */
function roundedToDecimals(value: number, decimals: number): number {
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
  return value < 0 ? -magnitude : magnitude;
}

/** The remainder of `value` divided by `divisor`, not 0, with the sign of the divisor: `mod(-1, 3)` is 2. */
function modulo(value: number, divisor: number): number {
  // `%` is exact and keeps the sign of `value`.
  const remainder = value % divisor;
  if (remainder === 0 || remainder < 0 === divisor < 0) return withoutNegativeZero(remainder);
  // A remainder too small to add to the divisor exactly would round to the divisor itself.
  const shifted = remainder + divisor;
  return shifted === divisor ? 0 : shifted;
}

/**
 * `base` to the power `exponent`, within its domains (a base of 0 has an exponent of at least 0, and a negative base a
 * whole exponent), or the failure of a result too large to represent.
 */
function power(base: number, exponent: number): number | NumericFailure {
  if (exponent === 0) return 1;
  if (base === 0) return 0;
  // `%` is exact, and every double of at least 2^53 is even.
  const sign = base < 0 && exponent % 2 !== 0 ? -1 : 1;
  const magnitude = Math.abs(base) === 1 ? 1 : positivePower(Math.abs(base), exponent);
  if (magnitude === undefined)
    return noResult(
      `pow(${base}, ${exponent}) gives a number too large to represent. Use smaller values.`,
    );
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
