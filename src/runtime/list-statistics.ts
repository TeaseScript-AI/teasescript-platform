import {
  addDurationParts,
  durationFamily,
  durationParts,
  storedDuration,
  type DurationParts,
} from "../duration.js";
import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { dateTimeMilliseconds, daysBetween } from "../temporal.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import {
  cloneSerializableValue,
  createSerializableObject,
  type SerializableRuntimeTemporal,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import {
  describeRuntimeValue,
  isDict,
  isDuration,
  isList,
  isObject,
  isTemporal,
} from "./value-predicates.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

type Named = Readonly<Record<string, SerializableRuntimeValue>>;

/** The statistics of a list (V30 §16), each with the fewest values it needs. */
export const LIST_STATISTICS: ReadonlyMap<string, number> = new Map([
  ["sum", 1],
  ["average", 1],
  ["median", 1],
  ["percentile", 1],
  ["stddev", 2],
]);

const MS_PER_DAY = 86_400_000;

/**
 * The values a statistic of `list` reads: its elements, or with `by` the property of that name of each element, which
 * must then all be objects.
 */
export function listValues(
  name: string,
  list: SerializableRuntimeValue,
  by: SerializableRuntimeValue | undefined,
  span: SourceSpan,
): SerializableRuntimeValue[] {
  if (!isList(list))
    throw fault("TSR059", `${name}(...) needs a list, not ${describeRuntimeValue(list)}.`, span);
  if (by === undefined) return list.items;
  return list.items.map((item) => propertyValue(name, item, "by", by, span));
}

/** The property named by the named argument `option` of one element, such as `by: "count"`. */
function propertyValue(
  name: string,
  item: SerializableRuntimeValue,
  option: string,
  property: SerializableRuntimeValue,
  span: SourceSpan,
): SerializableRuntimeValue {
  if (typeof property !== "string")
    throw fault(
      "TSR059",
      `${name}(...) needs the name of a property as its ${option}:, not ${describeRuntimeValue(property)}.`,
      span,
    );
  if (!isObject(item))
    throw fault(
      "TSR060",
      `${name}(...) needs a list of objects for ${option}:, not a list that holds ${describeRuntimeValue(item)}.`,
      span,
    );
  const found = item.properties.find((entry) => entry.name === property);
  if (found === undefined)
    throw fault(
      "TSR060",
      `${name}(...): an object in the list has no property '${property}'.`,
      span,
    );
  return found.value;
}

/** Numbers, or durations of one family as their amounts in that family. */
type Amounts =
  | { readonly kind: "numbers"; readonly values: readonly number[] }
  | { readonly kind: "durations"; readonly values: readonly DurationParts[] };

/**
 * `values` as numbers or as durations of one family. `exact` requires durations of exact time, because days, weeks,
 * months, and years have no fixed length to average or interpolate.
 */
function amountsOf(
  name: string,
  values: readonly SerializableRuntimeValue[],
  exact: boolean,
  span: SourceSpan,
): Amounts {
  const numbers = values.filter((value) => typeof value === "number");
  if (numbers.length === values.length) return { kind: "numbers", values: numbers };
  const other = values.find((value) => typeof value !== "number" && !isDuration(value));
  if (other !== undefined || !values.every(isDuration))
    throw fault(
      "TSR060",
      other === undefined
        ? `${name}(...) needs values of one kind: all numbers or all durations.`
        : `${name}(...) needs numbers or durations, not ${describeRuntimeValue(other)}.`,
      span,
    );
  const parts = values.map((value) => durationParts(value));
  const families = new Set(parts.map(durationFamily));
  families.delete("zero");
  if (families.size > 1 || families.has("mixed"))
    throw fault(
      "TSR060",
      `${name}(...) needs durations of one kind: exact time, days and weeks, or months and years.`,
      span,
    );
  if (exact && families.size === 1 && !families.has("exact"))
    throw fault(
      "TSR060",
      `${name}(...) needs exact durations, such as minutes or hours: days, weeks, months, and years have no fixed length.`,
      span,
    );
  return { kind: "durations", values: parts };
}

/** `sum`, `average`, `median`, `percentile`, or `stddev` of a list of numbers or durations (V30 §16). */
export function listStatistic(
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Named,
  span: SourceSpan,
): SerializableRuntimeValue {
  const percentile = name === "percentile";
  if (positional.length !== (percentile ? 2 : 1) || Object.keys(named).some((key) => key !== "by"))
    throw fault(
      "TSR028",
      `${name}(...) takes a list${percentile ? " and a percentage" : ""}, and optionally by:, such as ${percentile ? "percentile(scores, 10)" : `${name}(scores)`}.`,
      span,
    );
  const values = listValues(name, positional[0]!, named.by, span);
  const fewest = LIST_STATISTICS.get(name)!;
  if (values.length < fewest)
    throw fault(
      "TSR018",
      fewest === 1
        ? `${name}(...) of an empty list has no result. Check that the list's length is above 0 first.`
        : `${name}(...) needs at least ${fewest} values, but the list has ${values.length}.`,
      span,
    );
  const share = percentile ? percentage(positional[1]!, span) : 0;
  const amounts = amountsOf(name, values, name !== "sum", span);
  if (amounts.kind === "durations" && name === "sum") {
    const total = amounts.values.reduce((sum, parts) => addDurationParts(sum, parts));
    if (
      !Number.isFinite(total.milliseconds) ||
      !Number.isSafeInteger(total.months) ||
      !Number.isSafeInteger(total.days)
    )
      throw fault("TSR036", `${name}(...) gives a duration too long to represent.`, span);
    return storedDuration(total);
  }
  const numbers =
    amounts.kind === "numbers" ? amounts.values : amounts.values.map((parts) => parts.milliseconds);
  const result = statistic(name, numbers, share);
  if (!Number.isFinite(result))
    throw fault("TSR036", `${name}(...) gives a number too large to represent.`, span);
  return amounts.kind === "numbers"
    ? result === 0
      ? 0
      : result
    : storedDuration({ months: 0, days: 0, milliseconds: result });
}

/** A percentage from 0 through 100, as `percentile` and `chance` take it. */
function percentage(value: SerializableRuntimeValue, span: SourceSpan): number {
  if (typeof value !== "number")
    throw fault(
      "TSR059",
      `percentile(...) needs a number as its percentage, not ${describeRuntimeValue(value)}.`,
      span,
    );
  if (value < 0 || value > 100)
    throw fault(
      "TSR039",
      `percentile(...) needs a percentage from 0 through 100, not ${value}.`,
      span,
    );
  return value;
}

/**
 * A statistic of numbers in list order, which fixes the rounding of every sum. The numbers are first divided by a power
 * of 2 that brings the largest within 2, which is exact, so the sums cannot overflow and tiny differences keep their
 * precision; the result is multiplied back. Where nothing overflows, the result is the same as without the scaling.
 */
function statistic(name: string, values: readonly number[], share: number): number {
  const exponent = scaleExponent(values);
  const scaled = values.map((value) => timesPowerOfTwo(value, -exponent));
  const back = (value: number): number => timesPowerOfTwo(value, exponent);
  switch (name) {
    case "sum":
      return back(total(scaled));
    case "average":
      return back(total(scaled) / scaled.length);
    case "stddev": {
      // The sample standard deviation. The sum of the distances to the rounded average corrects the squared distances
      // for the rounding of the average (the corrected two-pass algorithm), and equal values have none.
      if (values.every((value) => value === values[0])) return 0;
      const average = total(scaled) / scaled.length;
      const distances = scaled.map((value) => value - average);
      const drift = total(distances);
      const squares = total(distances.map((distance) => distance * distance));
      return back(
        Math.sqrt(Math.max(0, squares - (drift * drift) / scaled.length) / (scaled.length - 1)),
      );
    }
    default: {
      // `median` is the 50th percentile. A percentile lies between the two nearest values in ascending order, at the
      // share of the way that the rank p/100 × (n - 1) passes the lower one. The rank stays scaled by 100 until the
      // last step, so that a whole percentage gives its fraction with one rounding: the 90th of 8 values is 6.3.
      const sorted = [...values].sort((left, right) => left - right);
      const rank = (name === "median" ? 50 : share) * (sorted.length - 1);
      const lower = Math.floor(rank / 100);
      const fraction = (rank - lower * 100) / 100;
      const low = sorted[lower]!;
      if (fraction === 0) return low;
      const high = sorted[lower + 1]!;
      if (low === high) return low;
      // Between two values scaled like the others, so their difference and middle cannot overflow or vanish.
      const ends = scaleExponent([low, high]);
      const [from, to] = [timesPowerOfTwo(low, -ends), timesPowerOfTwo(high, -ends)];
      return timesPowerOfTwo(
        fraction === 0.5 ? (from + to) / 2 : from + fraction * (to - from),
        ends,
      );
    }
  }
}

function total(items: readonly number[]): number {
  let sum = 0;
  for (const item of items) sum += item;
  return sum;
}

const TWO_32 = 4294967296;

/**
 * The exponent of a power of 2 that brings the largest magnitude of `values` to at least 1 and below 2, or 0 when every
 * value is 0.
 */
function scaleExponent(values: readonly number[]): number {
  let largest = 0;
  for (const value of values) largest = Math.max(largest, Math.abs(value));
  if (largest === 0) return 0;
  let exponent = 0;
  while (largest >= TWO_32) {
    largest /= TWO_32;
    exponent += 32;
  }
  while (largest < 1 / TWO_32) {
    largest *= TWO_32;
    exponent -= 32;
  }
  while (largest >= 2) {
    largest /= 2;
    exponent += 1;
  }
  while (largest < 1) {
    largest *= 2;
    exponent -= 1;
  }
  return exponent;
}

/** `value` × 2^`exponent`, exact while the result is a normal double; a subnormal result is rounded once. */
function timesPowerOfTwo(value: number, exponent: number): number {
  // The factor 2^exponent is a double from 2^-1074 through 2^1023; beyond, the first of two steps is exact.
  if (exponent > 1023) return value * powerOfTwo(exponent - 1023) * powerOfTwo(1023);
  if (exponent < -1074) return value * powerOfTwo(exponent + 1074) * powerOfTwo(-1074);
  return value * powerOfTwo(exponent);
}

/** 2^`exponent` for an exponent from -1074 through 1023, by squaring, every step a power of 2 within range. */
function powerOfTwo(exponent: number): number {
  let result = 1;
  let factor = exponent < 0 ? 0.5 : 2;
  for (let remaining = Math.abs(exponent); remaining > 0;) {
    if (remaining % 2 === 1) result *= factor;
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) factor *= factor;
  }
  return result;
}

/**
 * The x positions of points: steps from the first point, or days from it for date and time values, as `offsets` × 2^
 * `exponent`, so that offsets of numbers spread across the whole range stay finite.
 */
type Positions =
  | {
      readonly kind: "steps";
      readonly start: number;
      readonly offsets: readonly number[];
      readonly exponent: number;
    }
  | {
      readonly kind: "days";
      readonly start: SerializableRuntimeTemporal;
      readonly offsets: readonly number[];
      readonly exponent: number;
    };

/**
 * The least-squares line through points of a list (V30 §16): `slope` per step, or per day for date and time x values,
 * `intercept` the line's value at the first point, `r2` how much of the variation the line explains, and `start` the
 * first point's x, from which `predict` measures.
 */
export function linearRegression(
  positional: readonly SerializableRuntimeValue[],
  named: Named,
  span: SourceSpan,
): SerializableRuntimeValue {
  const name = "linearRegression";
  if (positional.length !== 1 || Object.keys(named).some((key) => key !== "x" && key !== "y"))
    throw fault(
      "TSR028",
      `${name}(...) takes a list, and optionally y: and x:, such as ${name}(scores) or ${name}(sessions, x: "date", y: "count").`,
      span,
    );
  if (named.x !== undefined && named.y === undefined)
    throw fault(
      "TSR028",
      `${name}(...) needs y: with x:, the property that holds the values.`,
      span,
    );
  const items = listValues(name, positional[0]!, undefined, span);
  const ys =
    named.y === undefined
      ? items
      : items.map((item) => propertyValue(name, item, "y", named.y!, span));
  if (ys.length < 2)
    throw fault(
      "TSR018",
      `${name}(...) needs at least 2 points, but the list has ${ys.length}.`,
      span,
    );
  const xs =
    named.x === undefined
      ? undefined
      : items.map((item) => propertyValue(name, item, "x", named.x!, span));
  const positions = positionsOf(xs, ys.length, span);
  const amounts = amountsOf(name, ys, true, span);
  const values =
    amounts.kind === "numbers" ? amounts.values : amounts.values.map((parts) => parts.milliseconds);
  if (positions.offsets.every((offset) => offset === 0))
    throw fault(
      "TSR036",
      `${name}(...) has no result: every point has the same x, so no line fits.`,
      span,
    );
  const line = values.every((value) => value === values[0])
    ? // Every y the same is a horizontal line that fits exactly.
      { slope: 0, intercept: values[0]!, r2: 1 }
    : leastSquares(positions.offsets, positions.exponent, values);
  if (![line.slope, line.intercept].every(Number.isFinite))
    throw fault("TSR036", `${name}(...) gives a number too large to represent.`, span);
  const amount = (value: number): SerializableRuntimeValue =>
    amounts.kind === "numbers"
      ? value === 0
        ? 0
        : value
      : storedDuration({ months: 0, days: 0, milliseconds: value });
  const { slope, intercept, r2 } = line;
  return createSerializableObject([
    { name: "slope", value: amount(slope) },
    { name: "intercept", value: amount(intercept) },
    { name: "r2", value: r2 === 0 ? 0 : r2 },
    {
      name: "start",
      value: positions.kind === "steps" ? positions.start : cloneSerializableValue(positions.start),
    },
  ]);
}

/**
 * The line through points (offset × 2^`exponent`, value) that comes closest by least squares, with its value at offset
 * 0. Offsets and values are scaled by powers of 2 to within 2 first, which is exact, so no sum or product overflows or
 * vanishes, and the sums of distances to the rounded averages correct the sums of products (the corrected two-pass
 * algorithm). Where nothing overflows, the scaling does not change the result.
 */
function leastSquares(
  offsets: readonly number[],
  offsetExponent: number,
  values: readonly number[],
): { readonly slope: number; readonly intercept: number; readonly r2: number } {
  const xExponent = scaleExponent(offsets);
  const yExponent = scaleExponent(values);
  const xs = offsets.map((offset) => timesPowerOfTwo(offset, -xExponent));
  const ys = values.map((value) => timesPowerOfTwo(value, -yExponent));
  const count = xs.length;
  const meanX = total(xs) / count;
  const meanY = total(ys) / count;
  const dx = xs.map((x) => x - meanX);
  const dy = ys.map((y) => y - meanY);
  const driftX = total(dx);
  const driftY = total(dy);
  const sxx = total(dx.map((value) => value * value)) - (driftX * driftX) / count;
  const sxy = total(dx.map((value, index) => value * dy[index]!)) - (driftX * driftY) / count;
  const syy = total(dy.map((value) => value * value)) - (driftY * driftY) / count;
  const slope = sxy / sxx;
  return {
    slope: timesPowerOfTwo(slope, yExponent - xExponent - offsetExponent),
    // The line's value at the first point, whose offset is 0.
    intercept: timesPowerOfTwo(meanY - slope * meanX, yExponent),
    r2: syy <= 0 ? 1 : Math.min(1, Math.max(0, (sxy / sxx) * (sxy / syy))),
  };
}

/** The x positions of `count` points: their indexes, or the values in `xs`, numbers or one kind of date and time. */
function positionsOf(
  xs: readonly SerializableRuntimeValue[] | undefined,
  count: number,
  span: SourceSpan,
): Positions {
  if (xs === undefined)
    return {
      kind: "steps",
      start: 0,
      offsets: Array.from({ length: count }, (_, index) => index),
      exponent: 0,
    };
  const numbers = xs.filter((x) => typeof x === "number");
  if (numbers.length === xs.length) {
    // Scaled first, so that the offset between the smallest and the largest number cannot overflow.
    const exponent = scaleExponent(numbers);
    const scaled = numbers.map((x) => timesPowerOfTwo(x, -exponent));
    return {
      kind: "steps",
      start: numbers[0]!,
      offsets: scaled.map((x) => x - scaled[0]!),
      exponent,
    };
  }
  const first = xs[0]!;
  const temporals = xs.filter(
    (x): x is SerializableRuntimeTemporal =>
      isTemporal(x) && isTemporal(first) && x.kind === first.kind && x.kind !== "time",
  );
  const start = temporals[0];
  if (start === undefined || temporals.length !== xs.length) {
    const other =
      xs.find((x) => typeof x !== "number" && !isTemporal(x)) ??
      xs.find((x) => isTemporal(x) && x.kind === "time");
    throw fault(
      "TSR060",
      other === undefined
        ? "linearRegression(...) needs x values of one kind: numbers, dates, datetimes, or timestamps."
        : `linearRegression(...) needs numbers, dates, datetimes, or timestamps as x values, not ${describeRuntimeValue(other)}.`,
      span,
    );
  }
  return { kind: "days", start, offsets: temporals.map((x) => daysFrom(start, x)), exponent: 0 };
}

/** The days from `start` to `value`, both dates, datetimes, or timestamps; a time of day is a fraction of a day. */
function daysFrom(start: SerializableRuntimeTemporal, value: SerializableRuntimeTemporal): number {
  if (start.kind === "date" && value.kind === "date") return daysBetween(value, start);
  if (start.kind === "datetime" && value.kind === "datetime")
    return (dateTimeMilliseconds(value) - dateTimeMilliseconds(start)) / MS_PER_DAY;
  if (start.kind === "timestamp" && value.kind === "timestamp")
    return (value.epochMilliseconds - start.epochMilliseconds) / MS_PER_DAY;
  throw new Error("Only dates, datetimes, or timestamps of one kind are measured in days.");
}

/** The value a line from `linearRegression` expects at `x` (V30 §16). */
export function predict(
  positional: readonly SerializableRuntimeValue[],
  named: Named,
  span: SourceSpan,
): SerializableRuntimeValue {
  if (positional.length !== 2 || Object.keys(named).length !== 0)
    throw fault("TSR028", "predict(...) takes a line and an x, such as predict(trend, 10).", span);
  const line = positional[0]!;
  const x = positional[1]!;
  const property = (key: string): SerializableRuntimeValue | undefined =>
    isObject(line) ? line.properties.find((entry) => entry.name === key)?.value : undefined;
  const slope = property("slope");
  const intercept = property("intercept");
  const start = property("start");
  // The amounts of a line: numbers, or durations of exact time.
  const amount = (value: SerializableRuntimeValue | undefined): number | undefined =>
    typeof value === "number"
      ? value
      : value !== undefined &&
          isDuration(value) &&
          (value.months ?? 0) === 0 &&
          (value.days ?? 0) === 0
        ? value.milliseconds
        : undefined;
  const slopeAmount = amount(slope);
  const interceptAmount = amount(intercept);
  const durations = slope !== undefined && isDuration(slope);
  const startKind =
    typeof start === "number"
      ? "number"
      : start !== undefined && isTemporal(start) && start.kind !== "time"
        ? start.kind
        : undefined;
  if (
    slopeAmount === undefined ||
    interceptAmount === undefined ||
    (intercept !== undefined && isDuration(intercept)) !== durations ||
    startKind === undefined
  )
    throw fault(
      "TSR059",
      `predict(...) needs a line from linearRegression(...), with slope, intercept, and start, not ${describeRuntimeValue(line)}.`,
      span,
    );
  // A horizontal line has its intercept everywhere. Two numbers more than the largest double apart are halved first,
  // which is exact, so that a finite prediction does not fail on their distance.
  let change: number | undefined;
  if (typeof start === "number") {
    if (typeof x === "number") {
      const offset = x - start;
      change =
        slopeAmount === 0
          ? 0
          : Number.isFinite(offset)
            ? slopeAmount * offset
            : 2 * (slopeAmount * (x / 2 - start / 2));
    }
  } else if (start !== undefined && isTemporal(start) && isTemporal(x) && x.kind === start.kind)
    change = slopeAmount === 0 ? 0 : slopeAmount * daysFrom(start, x);
  if (change === undefined)
    throw fault(
      "TSR059",
      `predict(...) needs ${startKind === "number" ? "a number" : startKind === "datetime" ? "a date and time" : `a ${startKind}`} as its x, like the line's start, not ${describeRuntimeValue(x)}.`,
      span,
    );
  const value = interceptAmount + change;
  if (!Number.isFinite(value))
    throw fault("TSR036", "predict(...) gives a number too large to represent.", span);
  return durations
    ? storedDuration({ months: 0, days: 0, milliseconds: value })
    : value === 0
      ? 0
      : value;
}

/**
 * The choices and weights of `randomWeighted` (V30 §4): the keys of a dict and its values, or the elements of a list
 * and the property `weight` of each. Weights are numbers of at least 0, and at least one is above 0.
 */
export function weightedChoices(
  positional: readonly SerializableRuntimeValue[],
  named: Named,
  span: SourceSpan,
): { readonly choices: readonly SerializableRuntimeValue[]; readonly weights: readonly number[] } {
  const name = "randomWeighted";
  const source = positional[0];
  const dict = source !== undefined && isDict(source);
  if (
    positional.length !== 1 ||
    Object.keys(named).some((key) => key !== "weight") ||
    (dict ? named.weight !== undefined : named.weight === undefined)
  )
    throw fault(
      "TSR028",
      `${name}(...) takes a dict of weights, such as ${name}(dict{ "squats": 3, "plank": 1 }), or a list of objects and weight:, such as ${name}(tasks, weight: "chance").`,
      span,
    );
  const choices = dict
    ? source.entries.map((entry) => entry.key)
    : listValues(name, source!, undefined, span);
  const weights = dict
    ? source.entries.map((entry) => entry.value)
    : choices.map((choice) => propertyValue(name, choice, "weight", named.weight!, span));
  if (choices.length === 0)
    throw fault(
      "TSR018",
      `${name}(...) of an empty ${dict ? "dict" : "list"} has nothing to choose.`,
      span,
    );
  const numbers = weights.map((weight) => {
    if (typeof weight !== "number")
      throw fault(
        "TSR060",
        `${name}(...) needs numbers as weights, not ${describeRuntimeValue(weight)}.`,
        span,
      );
    if (weight < 0)
      throw fault("TSR039", `${name}(...) needs weights of at least 0, not ${weight}.`, span);
    return weight;
  });
  if (!numbers.some((weight) => weight > 0))
    throw fault("TSR039", `${name}(...) needs at least one weight above 0.`, span);
  return { choices, weights: numbers };
}

/**
 * The index a draw in [0, 1) chooses: each choice has a share of the total weight, in order. The weights are scaled by
 * a power of 2 that brings the largest within 2, which is exact, so that their total neither overflows nor vanishes and
 * only their proportions count. Rounding can put the scaled draw at the total itself, which chooses the last choice
 * with weight.
 */
export function weightedIndex(weights: readonly number[], draw: number): number {
  const exponent = scaleExponent(weights);
  const scaled = weights.map((weight) => timesPowerOfTwo(weight, -exponent));
  const target = draw * total(scaled);
  let reached = 0;
  let last = 0;
  for (let index = 0; index < scaled.length; index += 1) {
    if (weights[index]! === 0) continue;
    last = index;
    reached += scaled[index]!;
    if (target < reached) return index;
  }
  return last;
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
