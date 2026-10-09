import { durationFamily, durationParts, storedDuration, type DurationParts } from "../duration.js";
import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { dateTimeMilliseconds, daysBetween } from "../temporal.js";
import { RuntimeFault } from "./errors.js";
import {
  add,
  compare,
  exact,
  floorDivide,
  multiply,
  quotient,
  squareRoot,
  subtract,
  sum,
  whole,
  type Exact,
} from "./exact-numbers.js";
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
    // Exact like the other statistics: months and days as whole numbers, and milliseconds rounded once.
    let months = 0n;
    let days = 0n;
    for (const parts of amounts.values) {
      months += BigInt(parts.months);
      days += BigInt(parts.days);
    }
    const milliseconds = quotient(
      sum(amounts.values.map((parts) => exact(parts.milliseconds))),
      ONE,
    );
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    if (
      !Number.isFinite(milliseconds) ||
      months > limit ||
      months < -limit ||
      days > limit ||
      days < -limit
    )
      throw fault(
        "TSR036",
        `${name}(...) gives a duration too long to represent. Use shorter durations.`,
        span,
      );
    return storedDuration({ months: Number(months), days: Number(days), milliseconds });
  }
  const numbers =
    amounts.kind === "numbers" ? amounts.values : amounts.values.map((parts) => parts.milliseconds);
  const result = statistic(name, numbers, share);
  if (!Number.isFinite(result))
    throw fault(
      "TSR036",
      `${name}(...) gives a number too large to represent. Use smaller values.`,
      span,
    );
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
 * A statistic of numbers, computed exactly and rounded to the nearest double once (`exact-numbers.ts`), so equal,
 * close, tiny, and huge values and their cancellations give the nearest result, the same on every engine.
 */
function statistic(name: string, values: readonly number[], share: number): number {
  const exacts = values.map(exact);
  const count = BigInt(values.length);
  switch (name) {
    case "sum":
      return quotient(sum(exacts), ONE);
    case "average":
      return quotient(sum(exacts), whole(count));
    case "stddev": {
      // The sample standard deviation: the square root of (n × Σx² - (Σx)²) / (n × (n - 1)).
      const total = sum(exacts);
      const squares = sum(exacts.map((value) => multiply(value, value)));
      return squareRoot(
        subtract(multiply(whole(count), squares), multiply(total, total)),
        whole(count * (count - 1n)),
      );
    }
    default: {
      // `median` is the 50th percentile. A percentile lies between the two nearest values in ascending order, at the
      // share of the way that the rank p/100 × (n - 1) passes the lower one: low + share × (high - low).
      const sorted = [...values].sort((left, right) => left - right);
      const rank = multiply(exact(name === "median" ? 50 : share), whole(sorted.length - 1));
      const lower = Number(floorDivide(rank, 100n));
      const beyond = subtract(rank, whole(lower * 100));
      const low = sorted[lower]!;
      if (beyond.n === 0n) return low;
      const high = exact(sorted[lower + 1]!);
      return quotient(
        add(multiply(whole(100), exact(low)), multiply(beyond, subtract(high, exact(low)))),
        whole(100),
      );
    }
  }
}

const ONE = whole(1);

/**
 * The x positions of points as exact offsets from the first point: steps, whole days between dates, or milliseconds
 * between datetimes or absolute dates and times, `perDay` of them in a day.
 */
type Positions =
  | {
      readonly kind: "steps";
      readonly start: number;
      readonly offsets: readonly Exact[];
      readonly perDay: bigint;
    }
  | {
      readonly kind: "days";
      readonly start: SerializableRuntimeTemporal;
      readonly offsets: readonly Exact[];
      readonly perDay: bigint;
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
  if (positions.offsets.every((offset) => offset.n === 0n))
    throw fault(
      "TSR036",
      `${name}(...) has no result: every point has the same x, so the line's slope cannot be determined. Use points with at least two different x values.`,
      span,
    );
  const { slope, intercept, r2 } = leastSquares(positions.offsets, positions.perDay, values);
  if (![slope, intercept].every(Number.isFinite))
    throw fault(
      "TSR036",
      `${name}(...) gives a number too large to represent. Use smaller values.`,
      span,
    );
  const amount = (value: number): SerializableRuntimeValue =>
    amounts.kind === "numbers"
      ? value === 0
        ? 0
        : value
      : storedDuration({ months: 0, days: 0, milliseconds: value });
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
 * The line through points (offset, value) that comes closest by least squares, with its value at offset 0, from exact
 * sums: with Sx, Sy, Sxx, Sxy, and Syy the sums of x, y, x², xy, and y², and n the count, the slope is (n Sxy - Sx Sy) /
 * (n Sxx - Sx²), per day when there are `perDay` offsets in a day, and r2 is the square of n Sxy - Sx Sy over the
 * product of n Sxx - Sx² and n Syy - Sy², or 1 when every y is the same.
 */
function leastSquares(
  offsets: readonly Exact[],
  perDay: bigint,
  values: readonly number[],
): { readonly slope: number; readonly intercept: number; readonly r2: number } {
  const ys = values.map(exact);
  const count = whole(ys.length);
  const sx = sum(offsets);
  const sy = sum(ys);
  const xx = subtract(multiply(count, sum(offsets.map((x) => multiply(x, x)))), multiply(sx, sx));
  const xy = subtract(
    multiply(count, sum(offsets.map((x, index) => multiply(x, ys[index]!)))),
    multiply(sx, sy),
  );
  const yy = subtract(multiply(count, sum(ys.map((y) => multiply(y, y)))), multiply(sy, sy));
  return {
    slope: quotient(multiply(xy, whole(perDay)), xx),
    // The line's value at the first point, whose offset is 0: (Sy - slope × Sx) / n.
    intercept: quotient(subtract(multiply(sy, xx), multiply(xy, sx)), multiply(count, xx)),
    r2: yy.n === 0n ? 1 : quotient(multiply(xy, xy), multiply(xx, yy)),
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
      offsets: Array.from({ length: count }, (_, index) => whole(index)),
      perDay: 1n,
    };
  const numbers = xs.filter((x) => typeof x === "number");
  if (numbers.length === xs.length) {
    const start = exact(numbers[0]!);
    return {
      kind: "steps",
      start: numbers[0]!,
      offsets: numbers.map((x) => subtract(exact(x), start)),
      perDay: 1n,
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
        ? "linearRegression(...) needs x values of one kind: numbers, dates, datetimes, or absolute dates and times."
        : `linearRegression(...) needs numbers, dates, datetimes, or absolute dates and times as x values, not ${describeRuntimeValue(other)}.`,
      span,
    );
  }
  return {
    kind: "days",
    start,
    offsets: temporals.map((x) => whole(unitsFrom(start, x))),
    perDay: start.kind === "date" ? 1n : BigInt(MS_PER_DAY),
  };
}

/** The whole days from `start` to `value` for dates, and otherwise the milliseconds, of two values of one kind. */
function unitsFrom(start: SerializableRuntimeTemporal, value: SerializableRuntimeTemporal): number {
  if (start.kind === "date" && value.kind === "date") return daysBetween(value, start);
  if (start.kind === "datetime" && value.kind === "datetime")
    return dateTimeMilliseconds(value) - dateTimeMilliseconds(start);
  if (start.kind === "absoluteDateTime" && value.kind === "absoluteDateTime")
    return value.epochMilliseconds - start.epochMilliseconds;
  throw new Error(
    "Only dates, datetimes, or absolute dates and times of one kind have a distance.",
  );
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
  // intercept + slope × (x - start), exactly, with x - start in days, and rounded once.
  let offset: Exact | undefined;
  let perDay = 1n;
  if (typeof start === "number") {
    if (typeof x === "number") offset = subtract(exact(x), exact(start));
  } else if (start !== undefined && isTemporal(start) && isTemporal(x) && x.kind === start.kind) {
    offset = whole(unitsFrom(start, x));
    if (start.kind !== "date") perDay = BigInt(MS_PER_DAY);
  }
  if (offset === undefined)
    throw fault(
      "TSR059",
      `predict(...) needs ${describeRuntimeValue(start!)} as its x, like the line's start, not ${describeRuntimeValue(x)}.`,
      span,
    );
  const value = quotient(
    add(multiply(exact(interceptAmount), whole(perDay)), multiply(exact(slopeAmount), offset)),
    whole(perDay),
  );
  if (!Number.isFinite(value))
    throw fault(
      "TSR036",
      "predict(...) gives a number too large to represent. Use smaller values.",
      span,
    );
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
 * The index a draw in [0, 1) chooses: each choice with weight has its share of the total weight, in order. The
 * comparison is exact, so only the proportions of the weights count.
 */
export function weightedIndex(weights: readonly number[], draw: number): number {
  const exacts = weights.map(exact);
  const target = multiply(exact(draw), sum(exacts));
  let reached = whole(0);
  let last = 0;
  for (let index = 0; index < exacts.length; index += 1) {
    if (weights[index]! === 0) continue;
    last = index;
    reached = add(reached, exacts[index]!);
    if (compare(target, reached) < 0) return index;
  }
  return last;
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
