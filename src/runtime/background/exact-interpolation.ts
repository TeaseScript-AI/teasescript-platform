/**
 * Exact linear interpolation between two samples, rounded to whole milliseconds. Doubles are exact binary fractions, so
 * the interpolated value is an exact rational number; rounding it directly makes the result independent of how samples
 * of one straight playback segment are spaced, which floating-point interpolation cannot guarantee at boundaries.
 */

const bits = new DataView(new ArrayBuffer(8));

/** `value = mantissa * 2^exponent` for a finite non-negative double. */
function binaryParts(value: number): { readonly mantissa: bigint; readonly exponent: number } {
  bits.setFloat64(0, value);
  const high = bits.getUint32(0);
  const biased = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(bits.getUint32(4));
  return biased === 0
    ? { mantissa: fraction, exponent: -1074 }
    : { mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
}

/**
 * `b0 + (a - a0) * (b1 - b0) / (a1 - a0)` as a non-negative fraction, for `a0 <= a`, `a0 < a1`, and `0 <= b0 <= b1`.
 */
function exactLinear(
  a0: number,
  b0: number,
  a1: number,
  b1: number,
  a: number,
): { readonly numerator: bigint; readonly denominator: bigint } {
  if ([a0, b0, a1, b1, a].every(Number.isSafeInteger)) {
    return {
      numerator: BigInt(b0) * BigInt(a1 - a0) + BigInt(a - a0) * BigInt(b1 - b0),
      denominator: BigInt(a1 - a0),
    };
  }
  const parts = [a0, b0, a1, b1, a].map(binaryParts);
  const exponent = Math.min(...parts.map((part) => part.exponent));
  const [A0, B0, A1, B1, A] = parts.map(
    (part) => part.mantissa << BigInt(part.exponent - exponent),
  );
  const numerator = B0! * (A1! - A0!) + (A! - A0!) * (B1! - B0!);
  const denominator = A1! - A0!;
  return exponent >= 0
    ? { numerator: numerator << BigInt(exponent), denominator }
    : { numerator, denominator: denominator << BigInt(-exponent) };
}

/** The smallest whole millisecond at or after the exact interpolated value. */
export function interpolateCeilMs(
  a0: number,
  b0: number,
  a1: number,
  b1: number,
  a: number,
): number {
  const { numerator, denominator } = exactLinear(a0, b0, a1, b1, a);
  return Number((numerator + denominator - 1n) / denominator);
}

/** The exact interpolated value rounded to the nearest whole millisecond, halves up. */
export function interpolateRoundMs(
  a0: number,
  b0: number,
  a1: number,
  b1: number,
  a: number,
): number {
  const { numerator, denominator } = exactLinear(a0, b0, a1, b1, a);
  return Number((2n * numerator + denominator) / (2n * denominator));
}
