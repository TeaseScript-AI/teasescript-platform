import { type PlanValidationError, isRecord, planError } from "../validation-support.js";
import { recordValidationTestWork } from "../../validation-testing.js";
import type { InstructionExecutionRegion, PlanValidationIndex } from "./execution-regions.js";
import {
  collectExpressionTemporaryReferences,
  producedTemporaryIds,
  explicitInstructionTargets,
} from "./instruction-facts.js";

export function validateCanonicalPreparedSays(
  instructions: readonly unknown[],
  index: PlanValidationIndex,
  errors: PlanValidationError[],
): void {
  const producers = new Map<number, number[]>();
  let hasPreparedSay = false;
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction)) return;
    if (
      instruction.kind === "say" &&
      (Number.isSafeInteger(instruction.speakerTemporary) ||
        Number.isSafeInteger(instruction.contextualSpeakerTemporary) ||
        Number.isSafeInteger(instruction.textTemporary))
    ) {
      hasPreparedSay = true;
    }
    for (const temporaryId of producedTemporaryIds(instruction)) {
      const entries = producers.get(temporaryId) ?? [];
      entries.push(instructionIndex);
      producers.set(temporaryId, entries);
    }
  });
  // Built for the first prepared say that reaches the clear and bypass checks.
  let rangesCache: PreparedSayRanges | null = null;
  const ranges = (): PreparedSayRanges => (rangesCache ??= preparedSayRanges(instructions, index));
  const payloadReferences = hasPreparedSay
    ? collectPayloadTemporaryReferences(instructions)
    : new Map<number, readonly number[]>();

  const consumed = new Set<number>();
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction) || instruction.kind !== "say") return;
    const region = index.owners[instructionIndex];
    if (region === undefined) return;
    const path = `$.instructions[${instructionIndex}]`;
    const speakerTemporary = instruction.speakerTemporary;
    const contextualSpeakerTemporary = instruction.contextualSpeakerTemporary;
    const textTemporary = instruction.textTemporary;
    if (speakerTemporary !== undefined && contextualSpeakerTemporary === undefined) {
      errors.push(
        planError(
          "TSC002",
          "Prepared say speaker requires its contextual speaker capture.",
          `${path}.contextualSpeakerTemporary`,
        ),
      );
    }
    if (contextualSpeakerTemporary !== undefined && speakerTemporary === undefined) {
      errors.push(
        planError(
          "TSC002",
          "Prepared say contextual speaker requires its output speaker capture.",
          `${path}.speakerTemporary`,
        ),
      );
    }
    if (
      speakerTemporary !== undefined &&
      textTemporary !== undefined &&
      speakerTemporary === textTemporary
    ) {
      errors.push(
        planError(
          "TSC002",
          "Prepared say speaker and text temporaries must not alias.",
          `${path}.textTemporary`,
        ),
      );
    }
    if (
      contextualSpeakerTemporary !== undefined &&
      (contextualSpeakerTemporary === speakerTemporary ||
        contextualSpeakerTemporary === textTemporary)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Prepared say contextual speaker temporary must not alias another prepared say temporary.",
          `${path}.contextualSpeakerTemporary`,
        ),
      );
    }
    validatePreparedSayProducer(
      "prepareSaySpeaker",
      speakerTemporary,
      instruction.speaker,
      instructionIndex,
      path,
      region,
      instructions,
      index,
      ranges,
      producers,
      consumed,
      errors,
    );
    validatePreparedSayProducer(
      "prepareSayText",
      textTemporary,
      instruction.value,
      instructionIndex,
      path,
      region,
      instructions,
      index,
      ranges,
      producers,
      consumed,
      errors,
    );
    validatePreparedSayContextualSpeaker(
      contextualSpeakerTemporary,
      speakerTemporary,
      instructionIndex,
      path,
      region,
      instructions,
      index,
      ranges,
      payloadReferences,
      producers,
      consumed,
      errors,
    );
  });

  instructions.forEach((instruction, instructionIndex) => {
    if (
      isRecord(instruction) &&
      (instruction.kind === "prepareSaySpeaker" ||
        instruction.kind === "prepareSayText" ||
        instruction.kind === "prepareSayContextualSpeaker") &&
      !consumed.has(instructionIndex)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Prepared say instruction must have one matching consuming say instruction.",
          `$.instructions[${instructionIndex}]`,
        ),
      );
    }
  });
}

function validatePreparedSayProducer(
  expectedKind: "prepareSaySpeaker" | "prepareSayText",
  temporaryId: unknown,
  expectedValue: unknown,
  sayIndex: number,
  sayPath: string,
  region: InstructionExecutionRegion,
  instructions: readonly unknown[],
  index: PlanValidationIndex,
  ranges: () => PreparedSayRanges,
  producers: ReadonlyMap<number, readonly number[]>,
  consumed: Set<number>,
  errors: PlanValidationError[],
): void {
  if (!Number.isSafeInteger(temporaryId)) return;
  // EVIDENCE: validation: temporaryId passed Number.isSafeInteger above.
  const preparedTemporaryId = temporaryId as number;
  const candidates = producers.get(preparedTemporaryId) ?? [];
  const producerIndex = candidates.length === 1 ? candidates[0] : undefined;
  const producer = producerIndex === undefined ? undefined : instructions[producerIndex];
  const producerPath = `${sayPath}.${expectedKind === "prepareSaySpeaker" ? "speakerTemporary" : "textTemporary"}`;
  if (
    producerIndex === undefined ||
    !isRecord(producer) ||
    producer.kind !== expectedKind ||
    producerIndex >= sayIndex ||
    index.owners[producerIndex] !== region ||
    !samePreparedSayValue(
      expectedKind === "prepareSaySpeaker" ? producer.speaker : producer.value,
      expectedValue,
    )
  ) {
    errors.push(
      planError(
        "TSC002",
        `Prepared say ${expectedKind === "prepareSaySpeaker" ? "speaker" : "text"} temporary lacks its canonical producer.`,
        producerPath,
      ),
    );
    return;
  }
  if (consumed.has(producerIndex)) {
    errors.push(
      planError(
        "TSC002",
        "Prepared say producer must not be reused by another say instruction.",
        producerPath,
      ),
    );
    return;
  }
  consumed.add(producerIndex);
  if (preparedSayTemporaryIsCleared(ranges(), producerIndex, sayIndex, preparedTemporaryId)) {
    errors.push(
      planError(
        "TSC002",
        `Prepared say ${expectedKind === "prepareSaySpeaker" ? "speaker" : "text"} temporary is cleared before its consuming say instruction.`,
        producerPath,
      ),
    );
  }
  if (preparedSayCanBeBypassed(ranges(), region, producerIndex, sayIndex)) {
    errors.push(
      planError(
        "TSC002",
        "Prepared say instruction can be reached while bypassing its required preparation.",
        sayPath,
      ),
    );
  }
}

function validatePreparedSayContextualSpeaker(
  temporaryId: unknown,
  speakerTemporary: unknown,
  sayIndex: number,
  sayPath: string,
  region: InstructionExecutionRegion,
  instructions: readonly unknown[],
  index: PlanValidationIndex,
  ranges: () => PreparedSayRanges,
  payloadReferences: ReadonlyMap<number, readonly number[]>,
  producers: ReadonlyMap<number, readonly number[]>,
  consumed: Set<number>,
  errors: PlanValidationError[],
): void {
  if (!Number.isSafeInteger(temporaryId)) return;
  // EVIDENCE: validation: temporaryId passed Number.isSafeInteger above.
  const candidates = producers.get(temporaryId as number) ?? [];
  const producerIndex = candidates.length === 1 ? candidates[0] : undefined;
  const producer = producerIndex === undefined ? undefined : instructions[producerIndex];
  const speakerCandidates = Number.isSafeInteger(speakerTemporary)
    ? (producers.get(
        /* EVIDENCE: validation: the conditional checks speakerTemporary with Number.isSafeInteger. */ speakerTemporary as number,
      ) ?? [])
    : [];
  const speakerProducerIndex = speakerCandidates.length === 1 ? speakerCandidates[0] : undefined;
  const path = `${sayPath}.contextualSpeakerTemporary`;
  if (
    producerIndex === undefined ||
    !isRecord(producer) ||
    producer.kind !== "prepareSayContextualSpeaker" ||
    producer.speakerTemporary !== speakerTemporary ||
    speakerProducerIndex === undefined ||
    producerIndex !== speakerProducerIndex + 1 ||
    producerIndex >= sayIndex ||
    index.owners[producerIndex] !== region
  ) {
    errors.push(
      planError("TSC002", "Prepared say contextual speaker lacks its canonical producer.", path),
    );
    return;
  }
  if (consumed.has(producerIndex)) {
    errors.push(
      planError(
        "TSC002",
        "Prepared say producer must not be reused by another say instruction.",
        path,
      ),
    );
    return;
  }
  consumed.add(producerIndex);
  // EVIDENCE: validation: temporaryId passed Number.isSafeInteger before this analysis.
  if (preparedSayTemporaryIsCleared(ranges(), producerIndex, sayIndex, temporaryId as number)) {
    errors.push(
      planError(
        "TSC002",
        "Prepared say contextual speaker is cleared before its consuming say instruction.",
        path,
      ),
    );
  }
  if (
    preparedSayContextualSpeakerIsUsedBeforeCapture(
      payloadReferences,
      index,
      region,
      producerIndex,
      // EVIDENCE: validation: temporaryId passed Number.isSafeInteger before this analysis.
      temporaryId as number,
    )
  ) {
    errors.push(
      planError(
        "TSC002",
        "Prepared say contextual speaker must be captured before its payload is lowered.",
        path,
      ),
    );
  }
  if (preparedSayCanBeBypassed(ranges(), region, producerIndex, sayIndex)) {
    errors.push(
      planError(
        "TSC002",
        "Prepared say instruction can be reached while bypassing its required preparation.",
        sayPath,
      ),
    );
  }
}

function preparedSayContextualSpeakerIsUsedBeforeCapture(
  payloadReferences: ReadonlyMap<number, readonly number[]>,
  index: PlanValidationIndex,
  region: InstructionExecutionRegion,
  producerIndex: number,
  temporaryId: number,
): boolean {
  for (const instructionIndex of payloadReferences.get(temporaryId) ?? []) {
    if (instructionIndex >= producerIndex) return false;
    if (index.owners[instructionIndex] === region) return true;
  }
  return false;
}

/**
 * Maps each temporary ID to the ascending instruction indices whose payload may
 * reference it, so the capture-order check does not rescan preceding instructions.
 */
function collectPayloadTemporaryReferences(
  instructions: readonly unknown[],
): ReadonlyMap<number, readonly number[]> {
  const references = new Map<number, number[]>();
  const referenced = new Set<number>();
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction)) return;
    referenced.clear();
    collectPreparedSayPayloadTemporaryReferences(instruction, referenced);
    for (const temporaryId of referenced) {
      const indices = references.get(temporaryId) ?? [];
      indices.push(instructionIndex);
      references.set(temporaryId, indices);
    }
  });
  return references;
}

function collectPreparedSayPayloadTemporaryReferences(
  instruction: Record<string, unknown>,
  output: Set<number>,
): void {
  switch (instruction.kind) {
    case "evaluate":
    case "prepareReference":
      collectExpressionTemporaryReferences(instruction.expression, output);
      return;
    case "say":
      collectExpressionTemporaryReferences(instruction.presentation, output);
      collectExpressionTemporaryReferences(instruction.value, output);
      collectExpressionTemporaryReferences(instruction.pacing, output);
      return;
    case "declareGlobal":
    case "declareBinding":
    case "assign":
    case "storeTemporary":
    case "prepareSayText":
    case "returnValue":
      collectExpressionTemporaryReferences(instruction.value, output);
      return;
  }
}

/**
 * Facts for the clear and bypass checks of prepared says, indexed once per validation. Each check is then a lookup
 * instead of a walk over the instructions between a producer and its say, which nested asks make overlap.
 */
interface PreparedSayRanges {
  readonly index: PlanValidationIndex;
  readonly explicitIncomingSources: readonly (readonly number[])[];
  /** The ascending indices of the instructions that clear each temporary. */
  readonly clears: ReadonlyMap<number, readonly number[]>;
  /** At `i + 1`: how many instructions up to `i` are the target of a `goto` or transfer. */
  readonly gotoTargets: Int32Array;
  /** At `i`: how many instructions up to `i` have another owner than the one before. */
  readonly ownerChanges: Int32Array;
  /** The lowest and highest jump source of each instruction from its own region, by range. */
  readonly lowestSource: RangeTable;
  readonly highestSource: RangeTable;
}

function preparedSayRanges(
  instructions: readonly unknown[],
  index: PlanValidationIndex,
): PreparedSayRanges {
  const explicitIncomingSources = collectExplicitIncomingSources(instructions);
  const clears = new Map<number, number[]>();
  const addClear = (temporaryId: unknown, instructionIndex: number) => {
    if (typeof temporaryId !== "number") return;
    const entries = clears.get(temporaryId) ?? [];
    if (entries.at(-1) !== instructionIndex) entries.push(instructionIndex);
    clears.set(temporaryId, entries);
  };
  const count = instructions.length;
  const gotoTargets = new Int32Array(count + 1);
  const ownerChanges = new Int32Array(count);
  const lowest = new Float64Array(count).fill(Infinity);
  const highest = new Float64Array(count).fill(-Infinity);
  recordValidationTestWork("preparedSayRangeSteps", count);
  for (let instructionIndex = 0; instructionIndex < count; instructionIndex += 1) {
    const instruction = instructions[instructionIndex];
    if (isRecord(instruction) && instruction.kind === "clearTemporary")
      addClear(instruction.temporaryId, instructionIndex);
    else if (
      isRecord(instruction) &&
      instruction.kind === "clearTemporaries" &&
      Array.isArray(instruction.temporaryIds)
    )
      for (const temporaryId of instruction.temporaryIds) addClear(temporaryId, instructionIndex);
    let gotoTarget = false;
    for (const sourceIndex of explicitIncomingSources[instructionIndex] ?? []) {
      if (index.gotoSources.has(sourceIndex)) gotoTarget = true;
      else if (index.owners[sourceIndex] === index.owners[instructionIndex]) {
        lowest[instructionIndex] = Math.min(lowest[instructionIndex]!, sourceIndex);
        highest[instructionIndex] = Math.max(highest[instructionIndex]!, sourceIndex);
      }
    }
    gotoTargets[instructionIndex + 1] = gotoTargets[instructionIndex]! + (gotoTarget ? 1 : 0);
    ownerChanges[instructionIndex] =
      instructionIndex === 0
        ? 0
        : ownerChanges[instructionIndex - 1]! +
          (index.owners[instructionIndex] === index.owners[instructionIndex - 1] ? 0 : 1);
  }
  return {
    index,
    explicitIncomingSources,
    clears,
    gotoTargets,
    ownerChanges,
    lowestSource: rangeTable(lowest, Math.min),
    highestSource: rangeTable(highest, Math.max),
  };
}

/** A sparse table: the combination of any range of values in constant time. */
interface RangeTable {
  readonly levels: readonly Float64Array[];
  readonly combine: (left: number, right: number) => number;
}

function rangeTable(
  values: Float64Array,
  combine: (left: number, right: number) => number,
): RangeTable {
  const levels = [values];
  for (let width = 2; width <= values.length; width *= 2) {
    const previous = levels.at(-1)!;
    const level = new Float64Array(values.length - width + 1);
    for (let start = 0; start < level.length; start += 1)
      level[start] = combine(previous[start]!, previous[start + width / 2]!);
    levels.push(level);
  }
  return { levels, combine };
}

/** The combination of the values from `first` to `last`, both included. */
function rangeQuery(table: RangeTable, first: number, last: number): number {
  const level = Math.floor(Math.log2(last - first + 1));
  const values = table.levels[level]!;
  return table.combine(values[first]!, values[last - (1 << level) + 1]!);
}

function preparedSayTemporaryIsCleared(
  ranges: PreparedSayRanges,
  producerIndex: number,
  sayIndex: number,
  temporaryId: number,
): boolean {
  recordValidationTestWork("preparedSayRangeSteps");
  const clears = ranges.clears.get(temporaryId);
  if (clears === undefined) return false;
  // The first clear after the producer.
  let low = 0;
  let high = clears.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (clears[middle]! <= producerIndex) low = middle + 1;
    else high = middle;
  }
  return low < clears.length && clears[low]! < sayIndex;
}

function collectExplicitIncomingSources(
  instructions: readonly unknown[],
): readonly (readonly number[])[] {
  const incoming: number[][] = Array.from({ length: instructions.length }, () => []);
  for (let sourceIndex = 0; sourceIndex < instructions.length; sourceIndex += 1) {
    const instruction = instructions[sourceIndex];
    if (!isRecord(instruction)) continue;
    for (const target of explicitInstructionTargets(instruction)) {
      if (
        typeof target === "number" &&
        Number.isSafeInteger(target) &&
        target >= 0 &&
        target < instructions.length
      ) {
        incoming[target]!.push(sourceIndex);
      }
    }
  }
  return incoming;
}

/**
 * Whether an instruction after the producer, up to the say, is the target of a `goto` or transfer, or of a jump from
 * outside that range in the same region.
 */
function preparedSayCanBeBypassed(
  ranges: PreparedSayRanges,
  region: InstructionExecutionRegion,
  producerIndex: number,
  sayIndex: number,
): boolean {
  recordValidationTestWork("preparedSayRangeSteps");
  const first = producerIndex + 1;
  if (first > sayIndex) return false;
  const { index } = ranges;
  if (
    index.owners[first] !== region ||
    ranges.ownerChanges[sayIndex] !== ranges.ownerChanges[first]
  ) {
    // Only a malformed plan mixes regions here; check each target as written.
    recordValidationTestWork("preparedSayRangeSteps", sayIndex - first + 1);
    for (let target = first; target <= sayIndex; target += 1) {
      for (const sourceIndex of ranges.explicitIncomingSources[target] ?? []) {
        if (index.gotoSources.has(sourceIndex)) return true;
        if (index.owners[sourceIndex] !== region) continue;
        if (sourceIndex < producerIndex || sourceIndex >= sayIndex) return true;
      }
    }
    return false;
  }
  return (
    ranges.gotoTargets[sayIndex + 1] !== ranges.gotoTargets[first] ||
    rangeQuery(ranges.lowestSource, first, sayIndex) < producerIndex ||
    rangeQuery(ranges.highestSource, first, sayIndex) >= sayIndex
  );
}

/** Structural equality of two plan values, walked with an explicit stack so that deep expressions fit. */
function samePreparedSayValue(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (Object.is(a, b)) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let item = 0; item < a.length; item += 1) pending.push([a[item], b[item]]);
      continue;
    }
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([a[key], b[key]]);
    }
  }
  return true;
}
