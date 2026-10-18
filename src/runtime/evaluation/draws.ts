import { argumentShapeProblem, positionalShape } from "../../argument-rules.js";
import { startValueMessage } from "../../start-value-rules.js";
import type { PlanTag, TagQueryExpressionPlan, TagQueryStepPlan } from "../../plan/model.js";
import { compareTagValue, evaluateTagSteps, passesTagList } from "../../tag-query.js";
import { normalizeTagName } from "../../tags.js";
import { globMatches, isPathGlob } from "../../project-paths.js";
import { domainFailure } from "../../numeric-functions.js";
import { RANDOM_CONTRACTS, type RandomFunction } from "../../random-functions.js";
import { weightedChoices, weightedIndex } from "../values/list-statistics.js";
import type { RandomFunctionName } from "../../language-facts.js";
import { internalFault } from "../errors.js";
import { nextXorShift32 } from "../random/random.js";
import {
  sampleIndex,
  sampleOrder,
  sampleRangeInteger,
  type PrimitiveDraw,
} from "../random/random-draws.js";
import { naturalOf, type RandomNatural, type RandomSupport } from "../random/random-control.js";
import { callNumbers } from "../values/pure-operations.js";
import { emptyRangeProblem, rangeLength } from "../../range-checks.js";
import {
  cloneCapturedSerializableValue,
  type SerializableRuntimeList,
  type SerializableRuntimeRange,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import { isList, isRange, isSet } from "../values/value-predicates.js";
import { describeShownValue } from "../values/value-types.js";
import { stateKey, type RuntimeDebugRandomOperation } from "../debug/debug-trace.js";
import { describeValue } from "../../value-kinds.js";
import type { Evaluator } from "../evaluator.js";
import { type SourceSpan, fault, assertIntegerRange } from "./support.js";

// Random draws, natural or controlled: random functions and elements, ranges, shuffles, and image tag queries.

/** The images matching a tag query, in catalog order, or one of them drawn from the session random generator. */
export function tagQuery(
  evaluator: Evaluator,
  query: TagQueryExpressionPlan,
  operands: readonly SerializableRuntimeValue[],
): SerializableRuntimeValue {
  const bounds = new Map<TagQueryStepPlan, number>();
  const lists = new Map<TagQueryStepPlan, readonly string[]>();
  let next = 0;
  for (const step of query.steps) {
    if (step.kind !== "tagCompare" && step.kind !== "tagList") continue;
    const value = operands[next]!;
    const span = query.operands[next++]!.span;
    if (step.kind === "tagCompare") bounds.set(step, tagBound(value, span));
    else lists.set(step, tagNames(value, step.option, span));
  }
  const matches = (tags: ReadonlyMap<string, number | null>) =>
    evaluateTagSteps(query.steps, (step) => {
      if (step.kind === "tag") return tags.has(step.name);
      if (step.kind === "tagCompare")
        return compareTagValue(tags.get(step.name), step.operator, bounds.get(step)!);
      if (step.kind === "tagList") return passesTagList(step.option, lists.get(step)!, tags);
      return null;
    });
  const found: SerializableRuntimeValue[] = [];
  if (query.catalog === "scripts") {
    // The files that run something, those `from:` names, in path order, each as a reference to its top.
    const named =
      query.from === null
        ? null
        : new Set(
            isPathGlob(query.from)
              ? globMatches(
                  query.from,
                  evaluator.plan.files.map((file) => file.path),
                )
              : [query.from],
          );
    const paths: string[] = [];
    for (const file of evaluator.plan.files) {
      if (
        file.tags !== null &&
        (named === null || named.has(file.path)) &&
        matches(imageTags(file))
      )
        paths.push(file.path);
    }
    // Plan files start with main.tease; picks and lists see path order, as for images.
    paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const path of paths) found.push({ kind: "script", path, label: null });
  } else {
    // The package images in path order, then the photos taken with tags in capture order.
    for (const image of evaluator.plan.images)
      if (matches(imageTags(image))) found.push(image.path);
    for (const image of evaluator.snapshot.capturedImages) {
      if (matches(imageTags(image))) found.push(image.reference);
    }
    // Tagged photos come from accepted captures.
    evaluator.trace?.readState(stateKey("photos"), null, null, null, false);
  }
  if (query.select === "list") return { kind: "list", items: found };
  if (found.length === 0)
    throw fault(
      "TSR082",
      query.catalog === "scripts" ? "No file has these tags." : "No image has these tags.",
      query.span,
    );
  const picked = found[drawIndex(evaluator, query.span, "tagQuery", found)]!;
  evaluator.trace?.randomResult(picked);
  return picked;
}

function tagBound(value: SerializableRuntimeValue, span: SourceSpan): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw fault(
      "TSR080",
      `A tag's number is compared with a number, but this is ${describeValue(value)}.`,
      span,
    );
  }
  return value;
}

/**
 * One semantic draw for `operation`: `sample` turns the primitive draws it takes into the outcome, and a debug trace
 * records them as one record with the generator state around them. Every random operation of an expression draws
 * through here.
 */
function semanticDraw<T>(
  evaluator: Evaluator,
  span: SourceSpan,
  operation: RuntimeDebugRandomOperation,
  choices: number | null,
  range: SerializableRuntimeRange | null,
  sample: (draw: PrimitiveDraw) => T,
): T {
  const trace = evaluator.trace;
  const before = trace === null && evaluator.control === null ? null : randomState(evaluator);
  // A controlled run has no injected source, so the state before is the draw's ID.
  if (evaluator.control !== null) evaluator.drawId = before!;
  let draws = 0;
  const outcome = sample(() => {
    draws += 1;
    return drawRandom(evaluator, span, operation);
  });
  if (trace !== null && draws > 0)
    trace.random(operation, span, choices, range, before, randomState(evaluator), draws);
  return outcome;
}

/**
 * The outcome a controlled draw takes after its natural sampling: the natural one, one the host chose, or none, when
 * the draw pauses.
 */
function resolve(
  evaluator: Evaluator,
  span: SourceSpan,
  operation: RuntimeDebugRandomOperation,
  natural: RandomNatural,
  support: () => RandomSupport,
): RandomNatural {
  return evaluator.control!.resolve(
    evaluator.snapshot.nextInstruction,
    span,
    operation,
    evaluator.drawId,
    natural,
    support,
  );
}

/** The index of one of the equally likely `candidates`. */
export function drawIndex(
  evaluator: Evaluator,
  span: SourceSpan,
  operation: RuntimeDebugRandomOperation,
  candidates: readonly SerializableRuntimeValue[],
): number {
  const count = candidates.length;
  const index = semanticDraw(evaluator, span, operation, count, null, (draw) =>
    sampleIndex(draw, count),
  );
  if (evaluator.control === null) return index;
  return outcomeIndex(
    resolve(evaluator, span, operation, { kind: "index", index }, () => ({
      kind: "candidates",
      candidates,
    })),
  );
}

/** The session generator's state, or `null` when the host injected the random source. */
function randomState(evaluator: Evaluator): number | null {
  return evaluator.capabilities.random === undefined ? evaluator.snapshot.rng.state : null;
}

function drawRandom(
  evaluator: Evaluator,
  span: SourceSpan,
  operation: RuntimeDebugRandomOperation,
): number {
  // The compiler reports '.random' and a list in '${...}' where it knows the value's type, and every other random
  // operation of a start value as a call.
  if (evaluator.startValue !== null)
    throw fault(
      "TSR067",
      startValueMessage(evaluator.startValue, {
        kind:
          operation === "collectionRandom"
            ? "random"
            : operation === "interpolation"
              ? "shownList"
              : "call",
      }),
      span,
    );
  const random =
    evaluator.capabilities.random === undefined
      ? nextXorShift32(evaluator.snapshot.rng)
      : evaluator.capabilities.random.next();
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw fault(
      "TSR020",
      internalFault(
        `The random source returned ${typeof random === "number" ? String(random) : random === null ? "null" : `a value of type ${typeof random}`}, but it must return a number that is at least 0 and less than 1.`,
      ),
      span,
    );
  }
  return random;
}

/**
 * A call of a random function (see `RANDOM_CONTRACTS`), whose arguments are checked before it draws. A debug trace
 * records its draws as one record under its name, and under random control a host may choose the outcome.
 */
export function randomFunction(
  evaluator: Evaluator,
  name: RandomFunctionName,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): SerializableRuntimeValue {
  const random: RandomFunction = RANDOM_CONTRACTS[name];
  if (random.takes === "choices") return randomWeighted(evaluator, positional, named, span);
  if (random.takes === "range") {
    const problem = argumentShapeProblem(
      name,
      positionalShape(random.parameters),
      positional.length,
      Object.keys(named),
    );
    if (problem !== undefined) throw fault("TSR028", problem.message, span);
    const range = positional[0]!;
    if (!isRange(range))
      throw fault(
        "TSR040",
        `${name}(range) needs a range such as '1..=6', but this is ${describeShownValue(range)}.`,
        span,
      );
    return randomIntegerInRange(evaluator, range, span, `${name}(range)`, name);
  }
  const { numbers, options } = callNumbers(name, random, positional, named, span);
  const invalid = domainFailure(random, numbers, options);
  if (invalid !== undefined) throw fault(invalid.code, invalid.failure, span);
  let result = semanticDraw(evaluator, span, name, null, null, (draw) =>
    random.sample(numbers, draw),
  );
  if (evaluator.control !== null) {
    const resolved = resolve(evaluator, span, name, naturalOf(result), () =>
      random.support(numbers),
    );
    // A natural failure stays the draw's failure; a chosen outcome replaces it.
    if (resolved.kind !== "failure")
      result = random.result === "boolean" ? outcomeBoolean(resolved) : outcomeNumber(resolved);
  }
  if (typeof result === "object") throw fault(result.code, result.failure, span);
  evaluator.trace?.randomResult(result);
  return result;
}

/** Draws one whole number from a non-empty integer range with the session RNG. */
export function randomIntegerInRange(
  evaluator: Evaluator,
  range: SerializableRuntimeRange,
  span: SourceSpan,
  subject: string,
  operation: RuntimeDebugRandomOperation,
): number {
  assertIntegerRange(range, subject, span);
  const empty = emptyRangeProblem(subject, range);
  if (empty !== null) throw fault("TSR041", empty, span);
  const length = rangeLength(range);
  let drawn = semanticDraw(evaluator, span, operation, length, range, (draw) =>
    sampleRangeInteger(draw, range, length),
  );
  if (evaluator.control !== null)
    drawn = outcomeNumber(
      resolve(evaluator, span, operation, { kind: "number", value: drawn }, () => ({
        kind: "integer",
        min: range.start,
        max: range.start + length - 1,
      })),
    );
  evaluator.trace?.randomResult(drawn);
  return drawn;
}

/** One key of a dict, or element of a list, chosen with one draw, with the chance of its share of the weight. */
function randomWeighted(
  evaluator: Evaluator,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): SerializableRuntimeValue {
  const { choices, weights } = weightedChoices(positional, named, span);
  let index = semanticDraw(evaluator, span, "randomWeighted", choices.length, null, (draw) =>
    weightedIndex(weights, draw()),
  );
  if (evaluator.control !== null)
    index = outcomeIndex(
      resolve(evaluator, span, "randomWeighted", { kind: "index", index }, () => ({
        kind: "weighted",
        candidates: choices,
        weights,
      })),
    );
  // The choices are parts of the captured arguments, so the result is a trusted copy of one.
  const chosen = cloneCapturedSerializableValue(choices[index]!);
  evaluator.trace?.randomResult(chosen);
  return chosen;
}

/** A uniform random order of the list's items, as their old indexes; a trace records it as one record of its draws. */
export function shuffleOrder(
  evaluator: Evaluator,
  list: SerializableRuntimeList,
  span: SourceSpan,
): readonly number[] {
  const length = list.items.length;
  const order = semanticDraw(evaluator, span, "shuffle", length, null, (draw) =>
    sampleOrder(draw, length),
  );
  // Fewer than two items draw nothing, so nothing pauses.
  if (evaluator.control === null || length < 2) return order;
  return outcomeOrder(
    resolve(evaluator, span, "shuffle", { kind: "order", order }, () => ({
      kind: "order",
      items: list.items,
    })),
  );
}

export function randomItem(
  evaluator: Evaluator,
  items: readonly SerializableRuntimeValue[],
  span: SourceSpan,
  operation: RuntimeDebugRandomOperation,
): SerializableRuntimeValue {
  if (items.length === 0)
    throw fault(
      "TSR019",
      "Cannot select '.random' from an empty collection. Check its length first.",
      span,
    );
  const item = items[drawIndex(evaluator, span, operation, items)]!;
  evaluator.trace?.randomResult(item);
  return item;
}

/*
 * A resolved draw has the kind of outcome its support admits: control checks every chosen outcome against the support
 * before it is used, and a natural one has its sampler's kind.
 */
function outcomeIndex(outcome: RandomNatural): number {
  if (outcome.kind !== "index")
    throw new Error("A random draw resolved to another kind of outcome.");
  return outcome.index;
}

function outcomeNumber(outcome: RandomNatural): number {
  if (outcome.kind !== "number")
    throw new Error("A random draw resolved to another kind of outcome.");
  return outcome.value;
}

function outcomeBoolean(outcome: RandomNatural): boolean {
  if (outcome.kind !== "boolean")
    throw new Error("A random draw resolved to another kind of outcome.");
  return outcome.value;
}

function outcomeOrder(outcome: RandomNatural): readonly number[] {
  if (outcome.kind !== "order")
    throw new Error("A random draw resolved to another kind of outcome.");
  return outcome.order;
}

const imageTagMaps = new WeakMap<object, ReadonlyMap<string, number | null>>();

/** An image's tags by name, built once per catalog entry: a plan image or a photo taken with tags. */
function imageTags(image: {
  readonly tags: readonly PlanTag[] | null;
}): ReadonlyMap<string, number | null> {
  let tags = imageTagMaps.get(image);
  if (tags === undefined) {
    tags = new Map((image.tags ?? []).map((tag) => [tag.name, tag.value]));
    imageTagMaps.set(image, tags);
  }
  return tags;
}

/** The tag names of an `all:`, `none:`, or `any:` list or set, normalized as authors write them. */
function tagNames(
  value: SerializableRuntimeValue,
  option: string,
  span: SourceSpan,
): readonly string[] {
  if (!isList(value) && !isSet(value)) {
    throw fault(
      "TSR081",
      `'${option}:' takes a list of tag names, but this is ${describeValue(value)}.`,
      span,
    );
  }
  return value.items.map((item) => {
    const name = typeof item === "string" ? normalizeTagName(item) : null;
    if (name === null) {
      throw fault(
        "TSR081",
        `'${option}:' takes tag names, which use lowercase letters a–z, digits, and hyphens, but it holds ${typeof item === "string" ? `'${item}'` : describeValue(item)}.`,
        span,
      );
    }
    return name;
  });
}
