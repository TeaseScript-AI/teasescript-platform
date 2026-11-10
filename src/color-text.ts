// The text of a normalized colour's coordinates (#2147): Number::toString's layout with the choice ECMAScript only
// recommends made exact, so every engine writes the same text. A closed module: it imports nothing, and
// `tests/runtime/colour-conversion.test.ts` checks it whole.

/**
 * Finite `x` as Number::toString writes it, with the choice ECMAScript only recommends made exact. Number::toString
 * fixes the number of digits, the fewest that read back as `x`, but not which of several such decimals it writes; this
 * takes that count from `String(x)` and writes the decimal of that many digits nearest to `x` (compared exactly), a
 * tie going to the even one. Every engine gives the same text; the engines measured give `String(x)`'s.
 */
export function formatNumber(x: number): string {
  if (x === 0) return "0";
  if (x < 0) return `-${formatNumber(-x)}`;
  // The digit count is the part of String(x) that ECMAScript specifies: the fewest that read back.
  const precision = significantDigits(String(x));
  const [mantissa, exponent] = x.toExponential(precision - 1).split("e");
  const nearest = BigInt(mantissa!.replace(".", ""));
  const scale = BigInt(Number(exponent)) - BigInt(precision - 1);
  const candidates: { readonly digits: bigint; readonly scale: bigint }[] = [];
  for (const offset of [-1n, 0n, 1n]) {
    let digits = nearest + offset;
    let candidateScale = scale;
    // Keep `precision` digits: 10^p becomes 10^(p-1) one place up, 10^(p-1) - 1 gains a digit one place down.
    if (digits === 10n ** BigInt(precision)) {
      digits /= 10n;
      candidateScale += 1n;
    } else if (precision > 1 && digits === 10n ** BigInt(precision - 1) - 1n) {
      digits = digits * 10n + 9n;
      candidateScale -= 1n;
    }
    if (digits > 0n && Number(`${digits}e${candidateScale}`) === x)
      candidates.push({ digits, scale: candidateScale });
  }
  if (candidates.length === 0)
    throw new Error("formatNumber: no decimal of the shortest length reads back");
  if (candidates.length === 1) return layout(candidates[0]!.digits, candidates[0]!.scale);
  const exact = binaryParts(x);
  let best = candidates[0]!;
  let bestDistance = decimalDistance(best.digits, best.scale, exact);
  for (const candidate of candidates.slice(1)) {
    const distance = decimalDistance(candidate.digits, candidate.scale, exact);
    if (distance < bestDistance || (distance === bestDistance && candidate.digits % 2n === 0n)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return layout(best.digits, best.scale);
}

/** The number of significant digits of a Number::toString text: its digits without leading and trailing zeros. */
function significantDigits(text: string): number {
  const digits = text.split("e")[0]!.replace(".", "").replace(/^0+/u, "").replace(/0+$/u, "");
  return Math.max(1, digits.length);
}

/** Positive finite `x` as an exact `mantissa × 2^exponent`. */
function binaryParts(x: number): { readonly mantissa: bigint; readonly exponent: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const field = bits >> 52n;
  const fraction = bits & ((1n << 52n) - 1n);
  return field === 0n
    ? { mantissa: fraction, exponent: -1074n }
    : { mantissa: fraction + (1n << 52n), exponent: field - 1075n };
}

/** |digits × 10^scale − mantissa × 2^exponent|, scaled by a positive factor that depends only on `x` and `scale`. */
function decimalDistance(
  digits: bigint,
  scale: bigint,
  exact: { readonly mantissa: bigint; readonly exponent: bigint },
): bigint {
  const twos = exact.exponent < 0n ? -exact.exponent : 0n;
  const tens = scale < 0n ? -scale : 0n;
  const decimal = digits * 10n ** (scale + tens) * 2n ** twos;
  const binary = exact.mantissa * 2n ** (exact.exponent + twos) * 10n ** tens;
  return decimal > binary ? decimal - binary : binary - decimal;
}

/** `digits × 10^scale` laid out as Number::toString lays out its digits (ECMA-262, steps 6 to 10). */
function layout(digits: bigint, scale: bigint): string {
  let text = `${digits}`;
  let exponent = scale;
  while (text.length > 1 && text.endsWith("0")) {
    text = text.slice(0, -1);
    exponent += 1n;
  }
  const k = BigInt(text.length);
  const n = exponent + k;
  if (k <= n && n <= 21n) return text + "0".repeat(Number(n - k));
  if (0n < n && n <= 21n) return `${text.slice(0, Number(n))}.${text.slice(Number(n))}`;
  if (-6n < n && n <= 0n) return `0.${"0".repeat(Number(-n))}${text}`;
  const e = n - 1n;
  const sign = e < 0n ? "-" : "+";
  const magnitude = e < 0n ? -e : e;
  return text.length === 1
    ? `${text}e${sign}${magnitude}`
    : `${text.slice(0, 1)}.${text.slice(1)}e${sign}${magnitude}`;
}
