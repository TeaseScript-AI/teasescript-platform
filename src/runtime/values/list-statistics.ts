import type { RuntimeErrorCode } from "../../diagnostic-codes.js";
import { angleStatisticMessage, angleValue, compareAngles } from "../../angle.js";
import { argumentShapeProblem, type ArgumentShape } from "../../argument-rules.js";
import { withoutNegativeZero } from "../../conversions.js";
import {
  compareDurations,
  durationFamily,
  durationParts,
  exactDuration,
  isCalendar,
} from "../../duration.js";
import type { ListFunctionName } from "../../language-facts.js";
import {
  fewestValuesProblem,
  isStatistic,
  LIST_FUNCTION_CONTRACTS,
  listFunctionShape,
  listValueMessage,
  minMaxValuesProblem,
  mixedListValuesMessage,
  takesValues,
  type ListFunction,
  listValueKind,
  type ListValueKind,
  type MinMaxName,
  type StatisticName,
  missingPropertyMessage,
} from "../../list-function-rules.js";
import { RANDOM_CONTRACTS } from "../../random-functions.js";
import type { PlanSourceLocation } from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import { dateTimeMilliseconds, daysBetween } from "../../temporal.js";
import { RANGE_LIST_FIX } from "../../list-methods.js";
import { RuntimeFault } from "../errors.js";
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
import {
  cloneCapturedSerializableValue,
  createCapturedSerializableObject,
  type SerializableRuntimeTemporal,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import { compareTemporal } from "./temporal-operations.js";
import {
  isAngle,
  isAnyDuration,
  isDict,
  isDuration,
  isList,
  isObject,
  isRange,
  isTemporal,
} from "./value-predicates.js";
import { describeValue, familyOf, VALUE_KINDS, valueKindOf } from "../../value-kinds.js";
import { isTemporalKind } from "../../temporal-builtins.js";
import { copySpan } from "../../plan/source-location.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

type Named = Readonly<Record<string, SerializableRuntimeValue>>;

const MS_PER_DAY = 86_400_000;

/**
 * The values a statistic of `list` reads: its elements, or with `by` the property of that name of each element, which
 * must then all be objects.
 */
function listValues(
  name: string,
  list: SerializableRuntimeValue,
  by: SerializableRuntimeValue | undefined,
  span: SourceSpan,
): SerializableRuntimeValue[] {
  if (!isList(list))
    throw fault(
      "TSV043",
      `${name}(...) needs a list, not ${describeValue(list)}.${isRange(list) ? RANGE_LIST_FIX : ""}`,
      span,
    );
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
      "TSV043",
      `${name}(...) needs the name of a property as its ${option}:, not ${describeValue(property)}.`,
      span,
    );
  if (!isObject(item))
    throw fault(
      "TSV043",
      `${name}(...) needs a list of objects for ${option}:, not a list that holds ${describeValue(item)}.`,
      span,
    );
  const found = item.properties.find((entry) => entry.name === property);
  if (found === undefined) throw fault("TSV043", missingPropertyMessage(name, property), span);
  return found.value;
}

/** Numbers, exact durations as their milliseconds, or angles as their degrees. */
type Amounts =
  | { readonly kind: "numbers"; readonly values: readonly number[] }
  | { readonly kind: "durations"; readonly values: readonly number[] }
  | { readonly kind: "angles"; readonly values: readonly number[] };

/**
 * `values` as numbers, as exact durations, or for `sum` as angles. A calendar duration has no fixed length to add,
 * average, or interpolate (ADR 0026), and an angle wraps around at 360°, so only `sum` takes angles.
 */
function amountsOf(
  name: StatisticName | "linearRegression",
  values: readonly SerializableRuntimeValue[],
  span: SourceSpan,
): Amounts {
  const contract: ListFunction = LIST_FUNCTION_CONTRACTS[name];
  const kinds = contract.takes === "line" ? [] : contract.values;
  switch (listValuesKind(name, values, kinds, span)) {
    case "angle":
      return { kind: "angles", values: values.filter(isAngle).map((value) => value.degrees) };
    case "duration":
      return {
        kind: "durations",
        values: values.filter(isDuration).map((value) => value.milliseconds),
      };
    default:
      return { kind: "numbers", values: values.filter((value) => typeof value === "number") };
  }
}

/** The kind of a value that a list function may read, or `undefined` for another value. */
function kindOf(value: SerializableRuntimeValue): ListValueKind | undefined {
  return listValueKind(valueKindOf(value));
}

/**
 * The one kind of `values`, each of one of `kinds`, or `undefined` for no values; otherwise it fails as the compiler
 * reports the problem (`TSV043`): an angle where `kinds` has none first, then the first value of another kind, then
 * values of several kinds. `x` is as for `listValueMessage`.
 */
function listValuesKind(
  name: string,
  values: readonly SerializableRuntimeValue[],
  kinds: readonly ListValueKind[],
  span: SourceSpan,
  x = false,
): ListValueKind | undefined {
  const angle = kinds.includes("angle") ? undefined : values.find(isAngle);
  const other = angle ?? values.find((value) => !kinds.some((kind) => kind === kindOf(value)));
  if (other !== undefined)
    throw fault(
      "TSV043",
      listValueMessage(name, kinds, describeValue(other), kindOf(other), x),
      span,
    );
  const found = new Set(values.map(kindOf));
  if (found.size > 1) throw fault("TSV043", mixedListValuesMessage(name, kinds, x), span);
  return values.length === 0 ? undefined : kindOf(values[0]!);
}

/**
 * `sum`, `average`, `median`, `percentile`, or `stddev` of a list of numbers or durations, or the `sum` of angles
 * (V30 §16).
 */
function listStatistic(
  name: StatisticName,
  positional: readonly SerializableRuntimeValue[],
  named: Named,
  span: SourceSpan,
): SerializableRuntimeValue {
  checkArguments(name, listFunctionShape(name), positional, named, span);
  const values = statisticValues(name, positional[0]!, named.by, span);
  const [share = 0] = numbersOf(name, positional, span);
  const amounts = amountsOf(name, values, span);
  if (amounts.kind === "durations" && name === "sum") {
    // Exact like the other statistics: milliseconds rounded once.
    const milliseconds = quotient(sum(amounts.values.map((value) => exact(value))), ONE);
    if (!Number.isFinite(milliseconds))
      throw fault(
        "TSR036",
        `${name}(...) gives a duration too long to represent. Use shorter durations.`,
        span,
      );
    return exactDuration(milliseconds);
  }
  if (amounts.kind === "angles") {
    // Exact like the sum of numbers: degrees rounded once.
    const degrees = quotient(sum(amounts.values.map((value) => exact(value))), ONE);
    if (!Number.isFinite(degrees))
      throw fault(
        "TSR036",
        `${name}(...) gives an angle too large to represent. Use smaller angles.`,
        span,
      );
    return angleValue(degrees);
  }
  const numbers = amounts.values;
  const result = statistic(name, numbers, share);
  if (!Number.isFinite(result))
    throw fault(
      "TSR036",
      `${name}(...) gives a number too large to represent. Use smaller values.`,
      span,
    );
  return amounts.kind === "numbers" ? (result === 0 ? 0 : result) : exactDuration(result);
}

/**
 * The values a statistic, or `min` or `max` of one list, reads from `list`, as `listValues` gives them, of which there
 * are as many as it needs (see `ListFunction`): fewer is `TSR018`.
 */
function statisticValues(
  name: ListFunctionName,
  list: SerializableRuntimeValue,
  by: SerializableRuntimeValue | undefined,
  span: SourceSpan,
): SerializableRuntimeValue[] {
  const values = listValues(name, list, by, span);
  const problem = fewestValuesProblem(name, values.length);
  if (problem !== undefined) throw fault("TSR018", problem, span);
  return values;
}

/**
 * The numbers a statistic takes after its list, such as `percentile`'s percentage, each a number (`TSV043`) valid as
 * the contract's domains say (`TSR039`).
 */
function numbersOf(
  name: StatisticName,
  positional: readonly SerializableRuntimeValue[],
  span: SourceSpan,
): number[] {
  const contract: ListFunction = LIST_FUNCTION_CONTRACTS[name];
  if (contract.takes !== "values") return [];
  const numbers = contract.parameters.slice(1).map((parameter, index) => {
    const value = positional[index + 1]!;
    if (typeof value !== "number")
      throw fault(
        "TSV043",
        `${name}(...) needs a number as its ${parameter}, not ${describeValue(value)}.`,
        span,
      );
    return value;
  });
  for (const domain of contract.domains) {
    const failure = domain.problem(
      domain.reads.map((parameter) => numbers[contract.parameters.indexOf(parameter) - 1]!),
    );
    if (failure !== undefined) throw fault(domain.code ?? "TSR039", failure, span);
  }
  return numbers;
}

/**
 * A statistic of numbers, computed exactly and rounded to the nearest double once (`exact-numbers.ts`), so equal,
 * close, tiny, and huge values and their cancellations give the nearest result, the same on every engine.
 */
function statistic(name: string, values: readonly number[], share: number): number {
  switch (name) {
    case "sum":
      // Not the native `Math.sumPrecise`: WebKit's is wrong for some negative sums, such as `[-1]`
      // (https://bugs.webkit.org/show_bug.cgi?id=315450), fixed upstream in
      // https://github.com/WebKit/WebKit/pull/65558. Switch once the fix ships in the supported browsers.
      return quotient(sum(values.map(exact)), ONE);
    case "average":
      return quotient(sum(values.map(exact)), whole(values.length));
    case "stddev": {
      // The sample standard deviation: the square root of (n × Σx² - (Σx)²) / (n × (n - 1)).
      const exacts = values.map(exact);
      const count = BigInt(values.length);
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
function linearRegression(
  positional: readonly SerializableRuntimeValue[],
  named: Named,
  span: SourceSpan,
): SerializableRuntimeValue {
  const name = "linearRegression";
  checkArguments(name, listFunctionShape(name), positional, named, span);
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
  const fewest = fewestValuesProblem(name, ys.length);
  if (fewest !== undefined) throw fault("TSR018", fewest, span);
  const xs =
    named.x === undefined
      ? undefined
      : items.map((item) => propertyValue(name, item, "x", named.x!, span));
  const positions = positionsOf(xs, ys.length, span);
  const amounts = amountsOf(name, ys, span);
  const values = amounts.values;
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
    amounts.kind === "numbers" ? (value === 0 ? 0 : value) : exactDuration(value);
  // Built from the captured arguments, so the object takes trusted copies of its parts.
  return createCapturedSerializableObject([
    { name: "slope", value: amount(slope) },
    { name: "intercept", value: amount(intercept) },
    { name: "r2", value: r2 === 0 ? 0 : r2 },
    { name: "start", value: positions.start },
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
  const { positions } = LIST_FUNCTION_CONTRACTS.linearRegression;
  if (listValuesKind("linearRegression", xs, positions, span, true) === "number") {
    const numbers = xs.filter((x) => typeof x === "number");
    const start = exact(numbers[0]!);
    return {
      kind: "steps",
      start: numbers[0]!,
      offsets: numbers.map((x) => subtract(exact(x), start)),
      perDay: 1n,
    };
  }
  // Dates, datetimes, or absolute dates and times, all of one kind.
  const temporals = xs.filter(isTemporal);
  const start = temporals[0]!;
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
function predict(
  positional: readonly SerializableRuntimeValue[],
  named: Named,
  span: SourceSpan,
): SerializableRuntimeValue {
  checkArguments("predict", listFunctionShape("predict"), positional, named, span);
  const line = positional[0]!;
  const x = positional[1]!;
  const property = (key: string): SerializableRuntimeValue | undefined =>
    isObject(line) ? line.properties.find((entry) => entry.name === key)?.value : undefined;
  const slope = property("slope");
  const intercept = property("intercept");
  const start = property("start");
  // The amounts of a line: numbers, or exact durations.
  const amount = (value: SerializableRuntimeValue | undefined): number | undefined =>
    typeof value === "number"
      ? value
      : value !== undefined && isDuration(value)
        ? value.milliseconds
        : undefined;
  const slopeAmount = amount(slope);
  const interceptAmount = amount(intercept);
  const durations = slope !== undefined && isDuration(slope);
  const kind = start === undefined ? undefined : kindOf(start);
  const startKind =
    kind !== undefined && LIST_FUNCTION_CONTRACTS.predict.positions.includes(kind)
      ? kind
      : undefined;
  if (
    slopeAmount === undefined ||
    interceptAmount === undefined ||
    (intercept !== undefined && isDuration(intercept)) !== durations ||
    startKind === undefined
  )
    throw fault(
      "TSV043",
      `predict(...) needs a line from linearRegression(...), with slope, intercept, and start, not ${describeValue(line)}.`,
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
      "TSV043",
      isAngle(x)
        ? angleStatisticMessage("predict")
        : `predict(...) needs ${VALUE_KINDS[familyOf(valueKindOf(start!))].description} as its x, like the line's start, not ${describeValue(x)}.`,
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
  return durations ? exactDuration(value) : value === 0 ? 0 : value;
}

/**
 * The choices and weights of `randomWeighted` (V30 §4): the keys of a dict and its values, or the elements of a list
 * and the property `weight` of each. Weights are numbers, valid as its contract says (see `RANDOM_CONTRACTS`).
 */
export function weightedChoices(
  positional: readonly SerializableRuntimeValue[],
  named: Named,
  span: SourceSpan,
): { readonly choices: readonly SerializableRuntimeValue[]; readonly weights: readonly number[] } {
  const name = "randomWeighted";
  const contract = RANDOM_CONTRACTS[name];
  checkArguments(name, contract.shape, positional, named, span);
  const source = positional[0]!;
  const dict = isDict(source);
  // A dict has its weights, and anything else needs weight:, as the compiler checks them.
  if (dict ? named.weight !== undefined : named.weight === undefined)
    throw fault(
      "TSR028",
      contract.sources[dict ? "dict" : isList(source) ? "list" : "other"],
      span,
    );
  const choices = dict
    ? source.entries.map((entry) => entry.key)
    : listValues(name, source, undefined, span);
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
        `${name}(...) needs numbers as weights, not ${describeValue(weight)}.`,
        span,
      );
    const problem = contract.weightProblem(weight);
    if (problem !== undefined) throw fault("TSR039", problem, span);
    return weight;
  });
  const problem = contract.weightsProblem(numbers);
  if (problem !== undefined) throw fault("TSR039", problem, span);
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

/** A call of a list function (see `LIST_FUNCTION_CONTRACTS`). */
export function listFunctionValue(
  name: ListFunctionName,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): SerializableRuntimeValue {
  if (isStatistic(name)) return listStatistic(name, positional, named, span);
  if (takesValues(name)) return minMaxValue(name, positional, named, span);
  switch (name) {
    case "linearRegression":
      return linearRegression(positional, named, span);
    case "predict":
      return predict(positional, named, span);
    default: {
      const unhandled: never = name;
      throw new Error(`List function '${String(unhandled)}' has no implementation.`);
    }
  }
}

/**
 * `min` or `max` of two or more values that are all numbers, all durations, all angles, or all date or time values of
 * one kind, or of the values of one list.
 */
function minMaxValue(
  name: MinMaxName,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): SerializableRuntimeValue {
  // One list, optionally with by:, chooses among its values (V30 §16). As the compiler, which knows the type, the
  // arguments are checked as one list takes them, else as the values do, also one value that is not a list.
  const one = positional.length === 1;
  const names = Object.keys(named);
  const problem =
    one && isList(positional[0]!)
      ? argumentShapeProblem(name, listFunctionShape(name), 1, names)
      : minMaxValuesProblem(name, positional.length, names);
  if (problem !== undefined) throw fault("TSR028", problem.message, span);
  // The values of one list are of one kind it reads, as the compiler checks them (`TSV043`).
  if (one) {
    positional = statisticValues(name, positional[0]!, named.by, span);
    listValuesKind(name, positional, LIST_FUNCTION_CONTRACTS[name].values, span);
  }
  // Values of one kind that `min` and `max` compare (`LIST_FUNCTION_CONTRACTS`), as the compiler checks them.
  const compared = LIST_FUNCTION_CONTRACTS[name].values;
  const kinds = positional.map((value) => listValueKind(valueKindOf(value)));
  const kind = kinds[0];
  if (kind === undefined || !compared.includes(kind) || kinds.some((other) => other !== kind)) {
    const other = positional.find((_, index) => {
      const otherKind = kinds[index];
      return otherKind === undefined || !compared.includes(otherKind);
    });
    throw fault(
      "TSR059",
      other === undefined
        ? `${name}(...) needs values of one kind: all numbers, all durations, all calendar durations, all angles, or all dates, times, datetimes, or absolute dates and times.`
        : `${name}(...) needs numbers, durations, angles, or date and time values, not ${describeValue(other)}.`,
      span,
    );
  }
  if (kind === "angle") {
    const values = positional.filter(isAngle);
    let best = values[0]!;
    for (const candidate of values) {
      const order = compareAngles(candidate, best);
      if (name === "min" ? order < 0 : order > 0) best = candidate;
    }
    return { ...best };
  }
  if (isTemporalKind(kind)) {
    const temporals = positional.filter(isTemporal);
    let best = temporals[0]!;
    for (const candidate of temporals) {
      const order = compareTemporal(candidate, best);
      if (name === "min" ? order < 0 : order > 0) best = candidate;
    }
    return cloneCapturedSerializableValue(best);
  }
  // A loop, not a spread into Math.min/Math.max, so a call with very many arguments cannot overflow the native stack.
  if (kind === "number") {
    const values = positional.filter((item): item is number => typeof item === "number");
    let best = values[0]!;
    for (const candidate of values)
      if (name === "min" ? candidate < best : candidate > best) best = candidate;
    return withoutNegativeZero(best);
  }
  // Calendar durations order only within one family (ADR 0026), also those that do not win; zero belongs to every
  // family. The result keeps its own parts.
  const values = positional.filter(isAnyDuration);
  const families = new Set(values.map((item) => durationFamily(durationParts(item))));
  families.delete("zero");
  if (values.some(isCalendar) && (families.size > 1 || families.has("mixed")))
    throw fault(
      "TSR059",
      `${name}(...) compares calendar durations of one kind only: months, days, or exact time.`,
      span,
    );
  let best = values[0]!;
  for (const candidate of values) {
    const order = compareDurations(candidate, best);
    if (typeof order === "string")
      throw fault("TSR059", `${name}(...) cannot compare these durations: ${order}.`, span);
    if (name === "min" ? order < 0 : order > 0) best = candidate;
  }
  return cloneCapturedSerializableValue(best);
}

/**
 * Fails as the compiler reports the first problem with the names and the number of a list function's arguments, or of
 * `randomWeighted`'s, which `shape` gives.
 */
function checkArguments(
  name: string,
  shape: ArgumentShape,
  positional: readonly SerializableRuntimeValue[],
  named: Named,
  span: SourceSpan,
): void {
  const problem = argumentShapeProblem(name, shape, positional.length, Object.keys(named));
  if (problem !== undefined) throw fault("TSR028", problem.message, span);
}

function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
