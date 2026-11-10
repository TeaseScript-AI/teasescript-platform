// The text of a normalized colour's coordinates (#2147): 15 significant digits, so a decimal written with at most 15
// digits prints as written, and every engine prints the same text for the same double. A closed module: it imports
// nothing, and `tests/runtime/colour-conversion.test.ts` checks it whole.

/** The magnitude above which 15 digits can round past the largest double: 17 digits always read back. */
const FIFTEEN_DIGITS_READ_BACK = 1.79769313486231e308;

/**
 * Finite `x` with 15 significant digits (17 above `FIFTEEN_DIGITS_READ_BACK`), trailing fractional zeros removed. Each
 * text reads back as a finite double that prints the same text again. `toPrecision` with an explicit precision has
 * uniquely specified rounding and layout (ECMA-262, Number.prototype.toPrecision), the exponent form included.
 */
export function formatNumber(x: number): string {
  if (x === 0) return "0";
  // Every double above this literal can round at 15 digits to a decimal beyond the largest double.
  const text = Math.abs(x) > FIFTEEN_DIGITS_READ_BACK ? x.toPrecision(17) : x.toPrecision(15);
  const parts = text.split("e");
  let mantissa = parts[0]!;
  if (mantissa.includes(".")) {
    while (mantissa.endsWith("0")) mantissa = mantissa.slice(0, -1);
    if (mantissa.endsWith(".")) mantissa = mantissa.slice(0, -1);
  }
  return parts.length === 2 ? mantissa + "e" + parts[1]! : mantissa;
}
