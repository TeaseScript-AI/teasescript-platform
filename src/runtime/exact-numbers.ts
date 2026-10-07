/**
 * Exact arithmetic on doubles for the list statistics (V30 §16). Every finite double is an integer times a power of 2,
 * so sums and products of doubles are exact as such binary numbers, held in BigInt; a result is rounded to the nearest
 * double once, at the end. This needs no overflow, underflow, or cancellation handling, and gives the same bits on
 * every JavaScript engine. Values of similar size have short integers, so ordinary lists stay cheap.
 */

/** The exact number `n` × 2^`e`. */
export interface Exact {
  readonly n: bigint;
  readonly e: number;
}

const ZERO: Exact = { n: 0n, e: 0 };

/** A finite double as an exact number, read from its IEEE-754 bits. */
export function exact(value: number): Exact {
  if (value === 0) return ZERO;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const field = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const mantissa = field === 0 ? fraction : fraction | 0x10000000000000n;
  const n = bits >> 63n === 1n ? -mantissa : mantissa;
  return { n, e: (field === 0 ? 1 : field) - 1075 };
}

/** A whole number as an exact number. */
export function whole(value: number | bigint): Exact {
  return { n: BigInt(value), e: 0 };
}

export function add(left: Exact, right: Exact): Exact {
  if (left.n === 0n) return right;
  if (right.n === 0n) return left;
  const e = Math.min(left.e, right.e);
  return { n: (left.n << BigInt(left.e - e)) + (right.n << BigInt(right.e - e)), e };
}

export function subtract(left: Exact, right: Exact): Exact {
  return add(left, { n: -right.n, e: right.e });
}

export function multiply(left: Exact, right: Exact): Exact {
  return { n: left.n * right.n, e: left.e + right.e };
}

export function sum(values: readonly Exact[]): Exact {
  let total = ZERO;
  for (const value of values) total = add(total, value);
  return total;
}

export function compare(left: Exact, right: Exact): number {
  const difference = subtract(left, right).n;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

/** The integer part of `value` / `divisor`, toward negative infinity, for a positive whole divisor. */
export function floorDivide(value: Exact, divisor: bigint): bigint {
  const [numerator, denominator] =
    value.e >= 0 ? [value.n << BigInt(value.e), divisor] : [value.n, divisor << BigInt(-value.e)];
  const quotient = numerator / denominator;
  return numerator % denominator !== 0n && numerator < 0n ? quotient - 1n : quotient;
}

/**
 * The double nearest `numerator` / `denominator`, ties to even, also for a subnormal result; an infinite result is too
 * large to represent.
 */
export function quotient(numerator: Exact, denominator: Exact): number {
  if (denominator.n === 0n) throw new Error("An exact quotient needs a denominator other than 0.");
  if (numerator.n === 0n) return 0;
  const negative = numerator.n < 0n !== denominator.n < 0n;
  const top = numerator.n < 0n ? -numerator.n : numerator.n;
  const bottom = denominator.n < 0n ? -denominator.n : denominator.n;
  // top / bottom × 2^weight, with a quotient of at least 56 bits, or finer than the smallest subnormal step.
  let weight = numerator.e - denominator.e;
  const shift = Math.max(56 - (bitLength(top) - bitLength(bottom)), weight + 1076);
  const scaledTop = shift >= 0 ? top << BigInt(shift) : top;
  const scaledBottom = shift >= 0 ? bottom : bottom << BigInt(-shift);
  weight -= shift;
  const rounded = round(scaledTop / scaledBottom, weight, scaledTop % scaledBottom !== 0n);
  return negative ? -rounded : rounded;
}

/** The double nearest the square root of `numerator` / `denominator`, which must not be negative. */
export function squareRoot(numerator: Exact, denominator: Exact): number {
  if (numerator.n === 0n) return 0;
  const top = numerator.n < 0n ? -numerator.n : numerator.n;
  const bottom = denominator.n < 0n ? -denominator.n : denominator.n;
  // The radicand as an integer of at least 112 bits times 2^(2 × half), so that its root has at least 56 bits.
  const weight = numerator.e - denominator.e;
  let shift = Math.max(112 - (bitLength(top) - bitLength(bottom)), weight + 2152);
  if ((weight - shift) % 2 !== 0) shift += 1;
  const scaledTop = shift >= 0 ? top << BigInt(shift) : top;
  const scaledBottom = shift >= 0 ? bottom : bottom << BigInt(-shift);
  const radicand = scaledTop / scaledBottom;
  const root = integerSquareRoot(radicand);
  const inexact = scaledTop % scaledBottom !== 0n || root * root !== radicand;
  return round(root, (weight - shift) / 2, inexact);
}

/** The largest integer whose square is at most `value`, by Newton's method. */
function integerSquareRoot(value: bigint): bigint {
  if (value < 2n) return value;
  let guess = 1n << BigInt(Math.ceil(bitLength(value) / 2));
  while (true) {
    const next = (guess + value / guess) >> 1n;
    if (next >= guess) return guess;
    guess = next;
  }
}

function bitLength(value: bigint): number {
  return value.toString(2).length;
}

/**
 * The double nearest `integer` × 2^`weight` + a positive amount below 2^`weight` when `inexact`: `integer` has at least
 * two bits below the last bit of the result, so the dropped bits and `inexact` decide the rounding, ties to even.
 */
function round(integer: bigint, weight: number, inexact: boolean): number {
  const top = weight + bitLength(integer) - 1;
  if (top > 1023) return Infinity;
  // The last bit of the result: 53 significant bits, but no finer than the smallest subnormal step.
  const unit = Math.max(top - 52, -1074);
  const dropped = BigInt(unit - weight);
  let kept = integer >> dropped;
  const rest = integer - (kept << dropped);
  const half = 1n << (dropped - 1n);
  if (rest > half || (rest === half && (inexact || (kept & 1n) === 1n))) kept += 1n;
  return timesPowerOfTwo(Number(kept), unit);
}

/** `value` × 2^`exponent` for a value of at most 54 bits; exact while the result is a double. */
function timesPowerOfTwo(value: number, exponent: number): number {
  // Two steps keep each factor a normal double.
  const first = Math.max(-1022, Math.min(1023, exponent));
  return value * powerOfTwo(first) * powerOfTwo(exponent - first);
}

/** 2^`exponent` for an exponent from -1022 through 1023. */
function powerOfTwo(exponent: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, (exponent + 1023) * 1048576, false);
  return view.getFloat64(0, false);
}
