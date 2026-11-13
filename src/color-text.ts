// The text of a normalized colour's coordinates (#2147). Fixed precision: 15 significant digits, or 17 above the
// conservative overflow cutoff. A closed module: it imports nothing, and `tests/runtime/values/colour-conversion.test.ts`
// checks it whole.

/** A conservative cutoff: above it, 15 digits could round past the largest double, so 17 are printed; 17 always read back. */
const FIFTEEN_DIGITS_READ_BACK = 1.79769313486231e308;

/**
 * Finite `x` with 15 significant digits (17 above `FIFTEEN_DIGITS_READ_BACK`), trailing fractional zeros removed. Each
 * text reads back as a finite double that prints the same text again. `toPrecision` with an explicit precision has
 * uniquely specified rounding and layout (ECMA-262, Number.prototype.toPrecision), the exponent form included.
 */
export function formatNumber(x: number): string {
  if (x === 0) return "0";
  // Near the largest double, 15 digits can round to a decimal beyond it; the cutoff is conservative.
  const text = Math.abs(x) > FIFTEEN_DIGITS_READ_BACK ? x.toPrecision(17) : x.toPrecision(15);
  const parts = text.split("e");
  let mantissa = parts[0]!;
  if (mantissa.includes(".")) {
    while (mantissa.endsWith("0")) mantissa = mantissa.slice(0, -1);
    if (mantissa.endsWith(".")) mantissa = mantissa.slice(0, -1);
  }
  return parts.length === 2 ? mantissa + "e" + parts[1]! : mantissa;
}
