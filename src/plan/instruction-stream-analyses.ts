import {
  type PlanValidationError,
  isRecord,
  isOneOf,
  nonNegativeSafeInteger,
  planError,
  positiveSafeInteger,
  rejectUnknownFields,
  requireString,
  validateSpan,
  validInstructionBoundary,
} from "./validation-support.js";
import type { Instruction } from "./model.js";
import { instructionKilledTemporaries, requiredInstructionTemporaries } from "./temporary-uses.js";

/** Validated instruction boundaries of one plan file. */
export interface PlanFileBoundaries {
  readonly startInstruction: number;
  readonly rootEndInstruction: number;
  readonly endInstruction: number;
  /** Where the file's labels stand: the only targets of a goto in the file. */
  readonly labelInstructions: ReadonlySet<number>;
}

export function analyzeInstructionStream(
  instructions: readonly unknown[],
  functions: unknown,
  files: readonly PlanFileBoundaries[] | null,
  errors: PlanValidationError[],
): void {
  validateLoopStructure(instructions, errors);
  validatePreparedReferenceStructure(instructions, errors);
  const validationIndex = validateFunctionDefinitions(functions, instructions, files, errors);
  validateInstructionControlFlowRegions(instructions, validationIndex, errors);
}

/**
 * A goto leaves every block, loop, and temporary value behind, so the code from a label on may need none of them: no
 * temporary that it reads before setting, no block that it leaves before entering, and no loop that it continues or
 * breaks before starting. Checked backward along the root region's control flow; call only for an otherwise valid
 * plan.
 */
export function validateLabelPositions(
  instructions: readonly Instruction[],
  files: readonly PlanFileBoundaries[],
  errors: PlanValidationError[],
): void {
  files.forEach((file, fileIndex) => {
    if (file.labelInstructions.size === 0) return;
    const { startInstruction: start, rootEndInstruction: end } = file;
    const length = end - start;
    const temporaries = Array.from({ length }, () => new Set<number>());
    const scopes = new Array<number>(length).fill(0);
    const loops = Array.from({ length }, () => new Set<number>());
    const inRegion = (index: number): boolean => index >= start && index < end;
    for (let changed = true; changed;) {
      changed = false;
      for (let index = end - 1; index >= start; index -= 1) {
        const instruction = instructions[index]!;
        const successors = rootSuccessors(instruction, index).filter(inRegion);
        const neededTemporaries = new Set<number>();
        let neededScopes = 0;
        const neededLoops = new Set<number>();
        for (const successor of successors) {
          for (const id of temporaries[successor - start]!) neededTemporaries.add(id);
          neededScopes = Math.max(neededScopes, scopes[successor - start]!);
          // A loop that starts here is active on the way into its body.
          const providesLoop =
            instruction.kind === "loopStart" && successor === index + 1 ? instruction.loopId : null;
          for (const id of loops[successor - start]!) if (id !== providesLoop) neededLoops.add(id);
        }
        for (const id of instructionKilledTemporaries(instruction)) neededTemporaries.delete(id);
        for (const id of requiredInstructionTemporaries(instruction, null))
          neededTemporaries.add(id);
        if (instruction.kind === "enterScope") neededScopes = Math.max(neededScopes - 1, 0);
        // More open blocks than instructions means a cycle that leaves blocks it never entered.
        if (instruction.kind === "leaveScope")
          neededScopes = Math.min(neededScopes + 1, length + 1);
        if (instruction.kind === "loopControl") neededLoops.add(instruction.loopId);
        const slot = index - start;
        if (
          !sameNumbers(temporaries[slot]!, neededTemporaries) ||
          scopes[slot] !== neededScopes ||
          !sameNumbers(loops[slot]!, neededLoops)
        ) {
          temporaries[slot] = neededTemporaries;
          scopes[slot] = neededScopes;
          loops[slot] = neededLoops;
          changed = true;
        }
      }
    }
    for (const label of file.labelInstructions) {
      const slot = label - start;
      if (temporaries[slot]!.size > 0 || scopes[slot]! > 0 || loops[slot]!.size > 0) {
        errors.push(
          planError(
            "TSC002",
            "A label must stand between statements of its file's outer scope.",
            `$.files[${fileIndex}].labels`,
          ),
        );
      }
    }
  });
}

/** Where execution can continue from a root instruction; transfers and endings leave the region's flow. */
function rootSuccessors(instruction: Instruction, index: number): readonly number[] {
  switch (instruction.kind) {
    case "jump":
    case "loopControl":
      return [instruction.target];
    case "jumpIfFalse":
    case "loopStart":
      return [instruction.target, index + 1];
    case "callFunction":
      return [instruction.returnInstruction];
    case "exit":
    case "end":
    case "goto":
    case "returnValue":
    case "returnVoid":
      return [];
    default:
      return [index + 1];
  }
}

function sameNumbers(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function validatePreparedReferenceStructure(
  instructions: readonly unknown[],
  errors: PlanValidationError[],
): void {
  const producers = new Map<number, number>();
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!isRecord(instruction)) continue;
    if (
      instruction.kind === "prepareReference" &&
      Number.isInteger(instruction.destinationTemporary)
    ) {
      // EVIDENCE: validation: Number.isInteger accepted destinationTemporary above.
      const temporaryId = instruction.destinationTemporary as number;
      if (producers.has(temporaryId)) {
        errors.push(
          planError(
            "TSC002",
            "Prepared-reference temporary is produced more than once.",
            `$.instructions[${index}].destinationTemporary`,
          ),
        );
      }
      producers.set(temporaryId, index);
    }
  }
  for (let index = 0; index < instructions.length; index += 1) {
    const referenced = new Set<number>();
    collectPreparedReferenceIds(instructions[index], referenced);
    for (const temporaryId of referenced) {
      const producer = producers.get(temporaryId);
      if (producer === undefined) {
        errors.push(
          planError(
            "TSC002",
            "Prepared-reference expression has no matching producer.",
            `$.instructions[${index}]`,
          ),
        );
        continue;
      }
      if (producer >= index) {
        errors.push(
          planError(
            "TSC002",
            "Prepared-reference producer must precede its use.",
            `$.instructions[${index}]`,
          ),
        );
      }
    }
  }
}

function collectPreparedReferenceIds(value: unknown, output: Set<number>): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }
    if (!isRecord(current)) continue;
    if (current.kind === "preparedReference" && Number.isInteger(current.temporaryId)) {
      // EVIDENCE: validation: the prepared-reference temporary ID passed Number.isInteger.
      output.add(current.temporaryId as number);
      continue;
    }
    const nestedValues = Object.values(current);
    for (let index = nestedValues.length - 1; index >= 0; index -= 1) {
      pending.push(nestedValues[index]);
    }
  }
}

function validateLoopStructure(
  instructions: readonly unknown[],
  errors: PlanValidationError[],
): void {
  const starts = new Map<
    number,
    { index: number; target: number; breakTarget: number; continueTarget: number }
  >();
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!isRecord(instruction) || instruction.kind !== "loopStart") continue;
    if (
      !positiveSafeInteger(instruction.loopId) ||
      !Number.isInteger(instruction.target) ||
      !Number.isInteger(instruction.continueTarget)
    )
      continue;
    const loopId = instruction.loopId;
    if (starts.has(loopId)) {
      errors.push(
        planError("TSC002", "Loop IDs must be unique.", `$.instructions[${index}].loopId`),
      );
    } else {
      starts.set(loopId, {
        index,
        // EVIDENCE: validation: the loop target passed Number.isInteger before insertion.
        target: instruction.target as number,
        breakTarget: loopBreakTarget(instructions, index, instruction),
        // EVIDENCE: validation: the continue target passed Number.isInteger before insertion.
        continueTarget: instruction.continueTarget as number,
      });
    }
    // EVIDENCE: validation: the loop target passed Number.isInteger above.
    if ((instruction.target as number) <= index) {
      errors.push(
        planError(
          "TSC002",
          "Loop exit target must follow its start.",
          `$.instructions[${index}].target`,
        ),
      );
    }
    // EVIDENCE: validation: the loop continue target passed Number.isInteger above.
    if (
      (instruction.loopKind === "while" && (instruction.continueTarget as number) > index) ||
      (instruction.loopKind !== "while" && instruction.continueTarget !== index)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Loop continue target is invalid.",
          `$.instructions[${index}].continueTarget`,
        ),
      );
    }
  }
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!isRecord(instruction) || instruction.kind !== "loopControl") continue;
    if (!positiveSafeInteger(instruction.loopId) || !Number.isInteger(instruction.target)) continue;
    const start = starts.get(instruction.loopId);
    if (start === undefined) {
      errors.push(
        planError(
          "TSC002",
          "Loop control refers to an unknown loop.",
          `$.instructions[${index}].loopId`,
        ),
      );
      continue;
    }
    const expected = instruction.action === "continue" ? start.continueTarget : start.breakTarget;
    if (instruction.target !== expected || index <= start.index || index >= start.target) {
      errors.push(
        planError(
          "TSC002",
          "Loop-control target does not match its loop.",
          `$.instructions[${index}].target`,
        ),
      );
    }
  }
}

function loopBreakTarget(
  instructions: readonly unknown[],
  loopStartIndex: number,
  loopStart: Record<string, unknown>,
): number {
  // EVIDENCE: validation: the sole caller checked the loop-start target with Number.isInteger.
  let target = loopStart.target as number;
  let trueCleanup = loopStartIndex + 1;
  while (true) {
    const trueInstruction = instructions[trueCleanup];
    const falseInstruction = instructions[target];
    if (
      !isRecord(trueInstruction) ||
      trueInstruction.kind !== "clearTemporary" ||
      !positiveSafeInteger(trueInstruction.temporaryId) ||
      !isRecord(falseInstruction) ||
      falseInstruction.kind !== "clearTemporary" ||
      falseInstruction.temporaryId !== trueInstruction.temporaryId
    )
      break;
    trueCleanup += 1;
    target += 1;
  }
  return target;
}

export function collectFunctionIds(value: unknown): ReadonlySet<number> {
  if (!Array.isArray(value)) return new Set<number>();
  return new Set(
    value
      .filter(isRecord)
      .map((item) => item.id)
      .filter((id): id is number => {
        // EVIDENCE: validation: Number.isInteger establishes the numeric ID before comparison.
        return Number.isInteger(id) && (id as number) > 0;
      }),
  );
}

type InstructionExecutionRegion =
  | {
      readonly kind: "root";
      readonly file: number;
      readonly startInstruction: number;
      readonly endInstruction: number;
    }
  | {
      readonly kind: "function";
      readonly file: number;
      readonly functionId: number;
      readonly startInstruction: number;
      readonly endInstruction: number;
    };

interface ValidatedFunctionRange {
  readonly definition: Record<string, unknown>;
  readonly path: string;
  readonly file: number;
  readonly id: number;
  readonly global: boolean;
  readonly entryInstruction: number;
  readonly bodyEntryInstruction: number;
  readonly implicitReturnInstruction: number;
  readonly endInstruction: number;
}

/**
 * Per-validation ownership data. It is deliberately local to one validation
 * operation: externally supplied plans must not populate a process-wide cache.
 */
interface PlanValidationIndex {
  readonly owners: readonly (InstructionExecutionRegion | undefined)[];
  readonly functionsById: ReadonlyMap<number, ValidatedFunctionRange>;
  readonly files: readonly PlanFileBoundaries[];
  /** Gotos leave their region, so any of them that lands inside a prepared value bypasses it. */
  readonly gotoSources: ReadonlySet<number>;
}

function createPlanValidationIndex(
  instructions: readonly unknown[],
  files: readonly PlanFileBoundaries[] | null,
  functions: readonly ValidatedFunctionRange[],
): PlanValidationIndex | null {
  if (files === null) return null;
  const owners: Array<InstructionExecutionRegion | undefined> = new Array(instructions.length);
  files.forEach((file, fileIndex) => {
    const root: InstructionExecutionRegion = {
      kind: "root",
      file: fileIndex,
      startInstruction: file.startInstruction,
      endInstruction: file.rootEndInstruction,
    };
    for (let index = file.startInstruction; index < file.rootEndInstruction; index += 1) {
      owners[index] = root;
    }
  });
  const functionsById = new Map<number, ValidatedFunctionRange>();
  for (const definition of functions) {
    const region: InstructionExecutionRegion = {
      kind: "function",
      file: definition.file,
      functionId: definition.id,
      startInstruction: definition.entryInstruction,
      endInstruction: definition.endInstruction,
    };
    functionsById.set(definition.id, definition);
    for (let index = definition.entryInstruction; index < definition.endInstruction; index += 1) {
      owners[index] = region;
    }
  }
  const gotoSources = new Set<number>();
  instructions.forEach((instruction, index) => {
    if (isRecord(instruction) && instruction.kind === "goto") gotoSources.add(index);
  });
  return { owners, functionsById, files, gotoSources };
}

function validateInstructionControlFlowRegions(
  instructions: readonly unknown[],
  index: PlanValidationIndex | null,
  errors: PlanValidationError[],
): void {
  if (index === null) return;

  validateCanonicalInteractionResultHandoffs(instructions, index, errors);
  validateCanonicalPreparedSays(instructions, index, errors);
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction)) return;
    const region = index.owners[instructionIndex];
    if (region === undefined) return;
    const instructionPath = `$.instructions[${instructionIndex}]`;
    switch (instruction.kind) {
      case "jump":
      case "jumpIfFalse":
      case "loopControl":
      case "prepareParameterDefault":
        validateInstructionRegionTarget(
          instruction.target,
          `${instructionPath}.target`,
          instructions.length,
          region,
          errors,
        );
        return;
      case "loopStart":
        validateInstructionRegionTarget(
          instruction.continueTarget,
          `${instructionPath}.continueTarget`,
          instructions.length,
          region,
          errors,
        );
        validateInstructionRegionTarget(
          instruction.target,
          `${instructionPath}.target`,
          instructions.length,
          region,
          errors,
        );
        return;
      case "goto":
        if (
          typeof instruction.target !== "number" ||
          !index.files[region.file]?.labelInstructions.has(instruction.target)
        ) {
          errors.push(
            planError(
              "TSC002",
              "A goto must continue at a label of its own file.",
              `${instructionPath}.target`,
            ),
          );
        }
        return;
      case "callFunction":
        validateInstructionRegionTarget(
          instruction.returnInstruction,
          `${instructionPath}.returnInstruction`,
          instructions.length,
          region,
          errors,
        );
        return;
    }
  });
}

function validateCanonicalPreparedSays(
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
    const temporaryId = producedTemporaryId(instruction);
    if (temporaryId === null) return;
    const entries = producers.get(temporaryId) ?? [];
    entries.push(instructionIndex);
    producers.set(temporaryId, entries);
  });
  const explicitIncomingSources = hasPreparedSay
    ? collectExplicitIncomingSources(instructions)
    : [];
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
      explicitIncomingSources,
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
      explicitIncomingSources,
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
      explicitIncomingSources,
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
  explicitIncomingSources: readonly (readonly number[])[],
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
  if (preparedSayTemporaryIsCleared(instructions, producerIndex, sayIndex, preparedTemporaryId)) {
    errors.push(
      planError(
        "TSC002",
        `Prepared say ${expectedKind === "prepareSaySpeaker" ? "speaker" : "text"} temporary is cleared before its consuming say instruction.`,
        producerPath,
      ),
    );
  }
  if (preparedSayCanBeBypassed(index, explicitIncomingSources, region, producerIndex, sayIndex)) {
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
  explicitIncomingSources: readonly (readonly number[])[],
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
  if (preparedSayTemporaryIsCleared(instructions, producerIndex, sayIndex, temporaryId as number)) {
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
  if (preparedSayCanBeBypassed(index, explicitIncomingSources, region, producerIndex, sayIndex)) {
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

export function expressionMayReferenceTemporary(value: unknown, temporaryId: number): boolean {
  const referenced = new Set<number>();
  collectExpressionTemporaryReferences(value, referenced);
  return referenced.has(temporaryId);
}

/** Uses an explicit worklist: validation reaches arbitrarily deep accepted expressions. */
function collectExpressionTemporaryReferences(value: unknown, output: Set<number>): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isRecord(current)) continue;
    switch (current.kind) {
      case "temporary":
        if (Number.isInteger(current.temporaryId)) {
          // EVIDENCE: validation: Number.isInteger proved the numeric temporary ID above.
          output.add(current.temporaryId as number);
        }
        break;
      case "list":
      case "set":
        if (Array.isArray(current.elements)) {
          for (const item of current.elements) pending.push(item);
        }
        break;
      case "object":
        if (Array.isArray(current.properties)) {
          for (const property of current.properties) {
            if (isRecord(property)) pending.push(property.value);
          }
        }
        break;
      case "dict":
        if (Array.isArray(current.entries)) {
          for (const entry of current.entries) {
            if (isRecord(entry)) pending.push(entry.key, entry.value);
          }
        }
        break;
      case "group":
        pending.push(current.expression);
        break;
      case "template":
        if (Array.isArray(current.parts)) {
          for (const part of current.parts) {
            if (isRecord(part) && part.kind === "expression") pending.push(part.expression);
          }
        }
        break;
      case "property":
        pending.push(current.object);
        break;
      case "index":
        pending.push(current.object, current.index);
        break;
      case "call":
        if (isRecord(current.callee) && current.callee.kind === "property") {
          pending.push(current.callee.object);
        }
        if (Array.isArray(current.arguments)) {
          for (const argument of current.arguments) {
            if (isRecord(argument)) pending.push(argument.value);
          }
        }
        break;
      case "unary":
        pending.push(current.operand);
        break;
      case "typeTest":
        pending.push(current.value);
        break;
      case "binary":
        pending.push(current.left, current.right);
        break;
      case "range":
        pending.push(current.start, current.end);
        break;
      case "storageLoad":
        pending.push(current.key, current.default);
        break;
      case "tagQuery":
        if (Array.isArray(current.operands)) {
          for (const operand of current.operands) pending.push(operand);
        }
        break;
    }
  }
}

function preparedSayTemporaryIsCleared(
  instructions: readonly unknown[],
  producerIndex: number,
  sayIndex: number,
  temporaryId: number,
): boolean {
  for (
    let instructionIndex = producerIndex + 1;
    instructionIndex < sayIndex;
    instructionIndex += 1
  ) {
    const instruction = instructions[instructionIndex];
    if (
      isRecord(instruction) &&
      ((instruction.kind === "clearTemporary" && instruction.temporaryId === temporaryId) ||
        (instruction.kind === "clearTemporaries" &&
          Array.isArray(instruction.temporaryIds) &&
          instruction.temporaryIds.includes(temporaryId)))
    )
      return true;
  }
  return false;
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

function preparedSayCanBeBypassed(
  index: PlanValidationIndex,
  explicitIncomingSources: readonly (readonly number[])[],
  region: InstructionExecutionRegion,
  producerIndex: number,
  sayIndex: number,
): boolean {
  for (let target = producerIndex + 1; target <= sayIndex; target += 1) {
    for (const sourceIndex of explicitIncomingSources[target] ?? []) {
      if (index.gotoSources.has(sourceIndex)) return true;
      if (index.owners[sourceIndex] !== region) continue;
      if (sourceIndex < producerIndex || sourceIndex >= sayIndex) return true;
    }
  }
  return false;
}

function samePreparedSayValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => samePreparedSayValue(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && samePreparedSayValue(left[key], right[key]),
    )
  );
}

function validateCanonicalInteractionResultHandoffs(
  instructions: readonly unknown[],
  index: PlanValidationIndex,
  errors: PlanValidationError[],
): void {
  const producers = new Map<number, number[]>();
  const explicitTargets = new Set<number>();
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction)) return;
    const produced = producedTemporaryId(instruction);
    if (produced !== null) {
      const indices = producers.get(produced) ?? [];
      indices.push(instructionIndex);
      producers.set(produced, indices);
    }
    for (const target of explicitInstructionTargets(instruction)) {
      if (Number.isSafeInteger(target))
        explicitTargets.add(
          /* EVIDENCE: validation: only safe-integer instruction targets enter this set. */ target as number,
        );
    }
  });

  instructions.forEach((instruction, instructionIndex) => {
    if (
      !isRecord(instruction) ||
      !(instruction.kind === "interaction" || instruction.kind === "capture") ||
      !Number.isSafeInteger(instruction.destinationTemporary)
    )
      return;
    // EVIDENCE: validation: destinationTemporary passed the safe-integer guard above.
    const destinationTemporary = instruction.destinationTemporary as number;
    const path = `$.instructions[${instructionIndex}]`;
    const region = index.owners[instructionIndex];
    if (region === undefined) return;

    const destinationProducers = producers.get(destinationTemporary) ?? [];
    if (destinationProducers.length !== 1 || destinationProducers[0] !== instructionIndex) {
      errors.push(
        planError(
          "TSC002",
          "Canonical interaction result destinations must be produced only by their owning interaction.",
          `${path}.destinationTemporary`,
        ),
      );
    }

    const continuation = instructionIndex + 1;
    if (continuation >= region.endInstruction) {
      errors.push(
        planError(
          "TSC002",
          "Result-bearing interaction requires a local in-region result handoff.",
          path,
        ),
      );
      return;
    }
    if (explicitTargets.has(continuation)) {
      errors.push(
        planError(
          "TSC002",
          "Interaction result handoff entry must be reachable only from its owning interaction.",
          `$.instructions[${continuation}]`,
        ),
      );
    }

    const handoff = instructions[continuation];
    if (!isRecord(handoff)) return;
    if (handoff.kind === "clearTemporary" && handoff.temporaryId === destinationTemporary) return;
    if (
      handoff.kind === "exit" ||
      handoff.kind === "end" ||
      handoff.kind === "goto" ||
      handoff.kind === "returnVoid"
    )
      return;

    if (!canonicalHandoffConsumesTemporary(handoff, destinationTemporary)) {
      errors.push(
        planError(
          "TSC002",
          "Interaction result handoff must consume the destination immediately.",
          `$.instructions[${continuation}]`,
        ),
      );
      return;
    }
    if (handoff.kind === "returnValue") return;
    if (
      !isOneOf(handoff.kind, [
        "declareBinding",
        "assign",
        "evaluate",
        "storeTemporary",
        "say",
        "prepareReference",
      ])
    ) {
      errors.push(
        planError(
          "TSC002",
          "Interaction result handoff contains a non-canonical intervening instruction.",
          `$.instructions[${continuation}]`,
        ),
      );
      return;
    }

    const clearIndex = continuation + 1;
    const clear = instructions[clearIndex];
    if (
      clearIndex >= region.endInstruction ||
      !isRecord(clear) ||
      clear.kind !== "clearTemporary" ||
      clear.temporaryId !== destinationTemporary
    ) {
      errors.push(
        planError(
          "TSC002",
          "Interaction result handoff must clear its transient destination immediately after transfer.",
          `$.instructions[${clearIndex}]`,
        ),
      );
      return;
    }
    if (explicitTargets.has(clearIndex)) {
      errors.push(
        planError(
          "TSC002",
          "Interaction result handoff cleanup must not be an independent control-flow target.",
          `$.instructions[${clearIndex}]`,
        ),
      );
    }
  });
}

function producedTemporaryId(instruction: Record<string, unknown>): number | null {
  let value: unknown = null;
  if (instruction.kind === "storeTemporary") {
    value = instruction.temporaryId;
  } else if (
    instruction.kind === "prepareSaySpeaker" ||
    instruction.kind === "prepareSayText" ||
    instruction.kind === "prepareSayContextualSpeaker"
  ) {
    value = instruction.destinationTemporary;
  } else if (
    instruction.kind === "prepareInteractionSpeaker" ||
    instruction.kind === "prepareReference" ||
    instruction.kind === "callFunction" ||
    instruction.kind === "interaction" ||
    instruction.kind === "capture" ||
    instruction.kind === "startTimer" ||
    instruction.kind === "playMedia"
  ) {
    value = instruction.destinationTemporary;
  }
  // EVIDENCE: validation: Number.isSafeInteger proves the returned numeric value.
  return Number.isSafeInteger(value) ? (value as number) : null;
}

function explicitInstructionTargets(instruction: Record<string, unknown>): readonly unknown[] {
  switch (instruction.kind) {
    case "jump":
    case "jumpIfFalse":
    case "loopControl":
    case "prepareParameterDefault":
      return [instruction.target];
    case "loopStart":
      return [instruction.continueTarget, instruction.target];
    case "callFunction":
      return [instruction.returnInstruction];
    case "goto":
      return [instruction.target];
    default:
      return [];
  }
}

function canonicalHandoffConsumesTemporary(
  instruction: Record<string, unknown>,
  temporaryId: number,
): boolean {
  let expression: unknown;
  switch (instruction.kind) {
    case "evaluate":
    case "prepareReference":
      expression = instruction.expression;
      break;
    case "say":
      return (
        expressionGuaranteesTemporaryEvaluation(instruction.presentation, temporaryId) ||
        expressionGuaranteesTemporaryEvaluation(instruction.value, temporaryId) ||
        expressionGuaranteesTemporaryEvaluation(instruction.pacing, temporaryId)
      );
    case "declareGlobal":
    case "declareBinding":
    case "assign":
    case "storeTemporary":
    case "prepareSayText":
    case "returnValue":
      expression = instruction.value;
      break;
    default:
      expression = undefined;
  }
  return expressionGuaranteesTemporaryEvaluation(expression, temporaryId);
}

function expressionGuaranteesTemporaryEvaluation(value: unknown, temporaryId: number): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "temporary":
      return value.temporaryId === temporaryId;
    case "list":
    case "set":
      return (
        Array.isArray(value.elements) &&
        value.elements.some((item) => expressionGuaranteesTemporaryEvaluation(item, temporaryId))
      );
    case "object":
      return (
        Array.isArray(value.properties) &&
        value.properties.some(
          (property) =>
            isRecord(property) &&
            expressionGuaranteesTemporaryEvaluation(property.value, temporaryId),
        )
      );
    case "dict":
      return (
        Array.isArray(value.entries) &&
        value.entries.some(
          (entry) =>
            isRecord(entry) &&
            (expressionGuaranteesTemporaryEvaluation(entry.key, temporaryId) ||
              expressionGuaranteesTemporaryEvaluation(entry.value, temporaryId)),
        )
      );
    case "group":
      return expressionGuaranteesTemporaryEvaluation(value.expression, temporaryId);
    case "template":
      return (
        Array.isArray(value.parts) &&
        value.parts.some(
          (part) =>
            isRecord(part) &&
            part.kind === "expression" &&
            expressionGuaranteesTemporaryEvaluation(part.expression, temporaryId),
        )
      );
    case "property":
      return expressionGuaranteesTemporaryEvaluation(value.object, temporaryId);
    case "index":
      return (
        expressionGuaranteesTemporaryEvaluation(value.object, temporaryId) ||
        expressionGuaranteesTemporaryEvaluation(value.index, temporaryId)
      );
    case "call": {
      const calleeConsumes =
        isRecord(value.callee) &&
        value.callee.kind === "property" &&
        expressionGuaranteesTemporaryEvaluation(value.callee.object, temporaryId);
      const argumentConsumes =
        Array.isArray(value.arguments) &&
        value.arguments.some(
          (argument) =>
            isRecord(argument) &&
            expressionGuaranteesTemporaryEvaluation(argument.value, temporaryId),
        );
      return calleeConsumes || argumentConsumes;
    }
    case "unary":
      return expressionGuaranteesTemporaryEvaluation(value.operand, temporaryId);
    case "typeTest":
      return expressionGuaranteesTemporaryEvaluation(value.value, temporaryId);
    case "binary":
      if (value.operator === "and" || value.operator === "or") {
        return expressionGuaranteesTemporaryEvaluation(value.left, temporaryId);
      }
      return (
        expressionGuaranteesTemporaryEvaluation(value.left, temporaryId) ||
        expressionGuaranteesTemporaryEvaluation(value.right, temporaryId)
      );
    case "range":
      return (
        expressionGuaranteesTemporaryEvaluation(value.start, temporaryId) ||
        expressionGuaranteesTemporaryEvaluation(value.end, temporaryId)
      );
    case "storageLoad":
      // The default runs only for an absent key.
      return expressionGuaranteesTemporaryEvaluation(value.key, temporaryId);
    case "tagQuery":
      // Every operand is evaluated before any image is matched.
      return (
        Array.isArray(value.operands) &&
        value.operands.some((operand) =>
          expressionGuaranteesTemporaryEvaluation(operand, temporaryId),
        )
      );
    default:
      return false;
  }
}

function validateInstructionRegionTarget(
  value: unknown,
  path: string,
  instructionCount: number,
  region: InstructionExecutionRegion,
  errors: PlanValidationError[],
): void {
  if (!validInstructionBoundary(value, instructionCount)) return;
  const target = value;
  const remainsInRegion = target >= region.startInstruction && target < region.endInstruction;
  if (!remainsInRegion) {
    errors.push(
      planError("TSC002", "Control-flow target leaves the instruction's execution region.", path),
    );
  }
}

const FUNCTION_FIELDS = [
  "id",
  "handler",
  "global",
  "selfHandle",
  "name",
  "declarationSpan",
  "parameters",
  "entryInstruction",
  "bodyEntryInstruction",
  "implicitReturnInstruction",
  "endInstruction",
  "bodySpan",
];

const PARAMETER_FIELDS = ["name", "index", "hasDefault", "declarationSpan", "defaultSpan"];

/**
 * Functions and handlers are local to their file, except global functions, which every file may call (ADR 0022 §3). A
 * global function and its handlers see only the project's names, so they call only global functions, and a handler is
 * global exactly when the code that registers it is.
 */
function reportForeignFunction(
  target: ValidatedFunctionRange | undefined,
  ownerRegion: InstructionExecutionRegion | undefined,
  call: boolean,
  index: PlanValidationIndex | null,
  instructionIndex: number,
  errors: PlanValidationError[],
): void {
  if (target === undefined || ownerRegion === undefined) return;
  const ownerGlobal =
    ownerRegion.kind === "function" &&
    index?.functionsById.get(ownerRegion.functionId)?.global === true;
  const problem = call
    ? !target.global && (ownerGlobal || target.file !== ownerRegion.file)
      ? ownerGlobal
        ? "A global function calls a function that is not global."
        : "An instruction refers to a function of another file."
      : null
    : target.file !== ownerRegion.file
      ? "An instruction refers to a function of another file."
      : target.global !== ownerGlobal
        ? "A handler is global exactly when the code that registers it is."
        : null;
  if (problem !== null)
    errors.push(planError("TSC002", problem, `$.instructions[${instructionIndex}]`));
}

function validateFunctionDefinitions(
  value: unknown,
  instructions: readonly unknown[],
  files: readonly PlanFileBoundaries[] | null,
  errors: PlanValidationError[],
): PlanValidationIndex | null {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Function definitions must be an array.", "$.functions"));
    return createPlanValidationIndex(instructions, files, []);
  }
  const ids = new Set<number>();
  const validatedRanges: ValidatedFunctionRange[] = [];
  // Function ranges fill each file's block after its root region, file by file; names are unique within a file.
  let file = 0;
  let names = new Set<string>();
  let expectedEntry = files?.[0]?.rootEndInstruction ?? null;
  const skipCompletedFiles = (): void => {
    while (files !== null && file < files.length && expectedEntry === files[file]!.endInstruction) {
      file += 1;
      names = new Set();
      expectedEntry = files[file]?.rootEndInstruction ?? null;
    }
  };
  value.forEach((definition, definitionIndex) => {
    const path = `$.functions[${definitionIndex}]`;
    if (!isRecord(definition)) {
      errors.push(planError("TSC002", "Function definition must be an object.", path));
      return;
    }
    rejectUnknownFields(definition, FUNCTION_FIELDS, path, errors);
    requirePositiveInteger(definition.id, `${path}.id`, errors);
    requireString(definition.name, `${path}.name`, errors);
    if (
      definition.handler !== null &&
      definition.handler !== "timer" &&
      definition.handler !== "media"
    ) {
      errors.push(planError("TSC002", "Function handler kind is invalid.", path));
    } else if (
      definition.handler !== null &&
      (!Array.isArray(definition.parameters) || definition.parameters.length !== 0)
    ) {
      errors.push(planError("TSC002", "A timer or media handler has no parameters.", path));
    }
    if (
      definition.selfHandle !== null &&
      (definition.handler !== "media" ||
        typeof definition.selfHandle !== "string" ||
        definition.selfHandle.length === 0)
    ) {
      errors.push(planError("TSC002", "Only a media handler may bind a self-handle name.", path));
    }
    if (typeof definition.global !== "boolean")
      errors.push(planError("TSC002", "Function global must be a boolean.", `${path}.global`));
    validateSpan(definition.declarationSpan, `${path}.declarationSpan`, errors);
    validateSpan(definition.bodySpan, `${path}.bodySpan`, errors);
    if (typeof definition.id === "number") {
      if (ids.has(definition.id)) {
        errors.push(planError("TSC002", "Function IDs must be unique.", `${path}.id`));
      }
      if (definition.id !== definitionIndex + 1) {
        errors.push(
          planError("TSC002", "Function IDs must follow deterministic source order.", `${path}.id`),
        );
      }
      ids.add(definition.id);
    }
    skipCompletedFiles();
    if (typeof definition.name === "string" && definition.handler === null) {
      if (names.has(definition.name)) {
        errors.push(
          planError("TSC002", "Function names must be unique within a file.", `${path}.name`),
        );
      }
      names.add(definition.name);
    }
    validateFunctionParameters(definition.parameters, `${path}.parameters`, errors);
    const points = [
      definition.entryInstruction,
      definition.bodyEntryInstruction,
      definition.implicitReturnInstruction,
      definition.endInstruction,
    ];
    if (points.some((point) => !nonNegativeSafeInteger(point))) {
      errors.push(
        planError("TSC002", "Function instruction boundaries must be non-negative integers.", path),
      );
      return;
    }
    // EVIDENCE: validation: all four fixed instruction boundaries passed nonNegativeSafeInteger above.
    const [entry, bodyEntry, implicitReturn, end] = points as [number, number, number, number];
    if (
      expectedEntry === null ||
      entry !== expectedEntry ||
      entry >= bodyEntry ||
      bodyEntry > implicitReturn ||
      implicitReturn !== end - 1 ||
      end > (files?.[file]?.endInstruction ?? -1)
    ) {
      errors.push(
        planError("TSC002", "Function instruction range is overlapping or impossible.", path),
      );
      return;
    }
    const functionId = definition.id;
    // EVIDENCE: validation: Number.isSafeInteger establishes the numeric function ID.
    if (!Number.isSafeInteger(functionId) || (functionId as number) < 1) return;

    const validatedRange: ValidatedFunctionRange = {
      definition,
      path,
      file,
      global: definition.global === true,
      // EVIDENCE: validation: functionId passed the positive safe-integer check above.
      id: functionId as number,
      entryInstruction: entry,
      bodyEntryInstruction: bodyEntry,
      implicitReturnInstruction: implicitReturn,
      endInstruction: end,
    };
    validatedRanges.push(validatedRange);

    const bodyEntryMarker = instructions[bodyEntry - 1];
    if (!isRecord(bodyEntryMarker) || bodyEntryMarker.kind !== "enterFunctionBody") {
      errors.push(
        planError(
          "TSC002",
          "Function body entry point is invalid.",
          `${path}.bodyEntryInstruction`,
        ),
      );
    }
    const implicitReturnInstruction = instructions[implicitReturn];
    if (!isRecord(implicitReturnInstruction) || implicitReturnInstruction.kind !== "returnVoid") {
      errors.push(
        planError(
          "TSC002",
          "Function implicit-return boundary is invalid.",
          `${path}.implicitReturnInstruction`,
        ),
      );
    }
    validateFunctionPrologue(validatedRange, instructions, errors);
    expectedEntry = end;
  });
  skipCompletedFiles();
  if (files !== null && expectedEntry !== null && file < files.length) {
    errors.push(
      planError(
        "TSC002",
        "Function ranges do not cover the non-root instruction region.",
        "$.functions",
      ),
    );
  }

  const index = createPlanValidationIndex(instructions, files, validatedRanges);
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction)) return;
    const ownerRegion = index?.owners[instructionIndex];
    const owner =
      ownerRegion?.kind === "function"
        ? index?.functionsById.get(ownerRegion.functionId)
        : undefined;
    const functionOnly = isOneOf(instruction.kind, [
      "bindSuppliedParameter",
      "beginFunctionDefaults",
      "prepareParameterDefault",
      "bindDefaultParameter",
      "enterFunctionBody",
      "returnValue",
      "returnVoid",
    ]);
    if (functionOnly && owner === undefined) {
      errors.push(
        planError(
          "TSC002",
          "Function-only instruction appears in root execution.",
          `$.instructions[${instructionIndex}]`,
        ),
      );
    }
    if (
      owner !== undefined &&
      instruction.kind !== "callFunction" &&
      "functionId" in instruction &&
      instruction.functionId !== owner.id
    ) {
      errors.push(
        planError(
          "TSC002",
          "Function prologue instruction has the wrong function ID.",
          `$.instructions[${instructionIndex}].functionId`,
        ),
      );
    }
    if (
      (instruction.kind === "callFunction" || instruction.kind === "startTimer") &&
      typeof (instruction.kind === "callFunction"
        ? instruction.functionId
        : instruction.handlerFunctionId) === "number"
    ) {
      const targetRange = index?.functionsById.get(
        // EVIDENCE: validation: the enclosing condition established the numeric ID.
        (instruction.kind === "callFunction"
          ? instruction.functionId
          : instruction.handlerFunctionId) as number,
      );
      reportForeignFunction(
        targetRange,
        ownerRegion,
        instruction.kind === "callFunction",
        index,
        instructionIndex,
        errors,
      );
      const target = targetRange?.definition;
      if (
        target !== undefined &&
        target.handler !== (instruction.kind === "startTimer" ? "timer" : null)
      ) {
        errors.push(
          planError(
            "TSC002",
            instruction.kind === "startTimer"
              ? "A timer must refer to a timer-handler region."
              : "A call must not enter a handler region.",
            `$.instructions[${instructionIndex}]`,
          ),
        );
      }
    }
    if (instruction.kind === "playMedia") {
      const handlerIds = [
        ...(Array.isArray(instruction.cues)
          ? instruction.cues.map((cue: unknown) => (isRecord(cue) ? cue.functionId : undefined))
          : []),
        instruction.finishFunctionId,
      ];
      for (const id of handlerIds) {
        if (typeof id !== "number") continue;
        const targetRange = index?.functionsById.get(id);
        reportForeignFunction(targetRange, ownerRegion, false, index, instructionIndex, errors);
        const target = targetRange?.definition;
        if (target !== undefined && target.handler !== "media") {
          errors.push(
            planError(
              "TSC002",
              "Media cues must refer to media-handler regions.",
              `$.instructions[${instructionIndex}]`,
            ),
          );
        }
      }
    }
    if (instruction.kind === "callFunction" && typeof instruction.functionId === "number") {
      const target = index?.functionsById.get(instruction.functionId)?.definition;
      if (
        target !== undefined &&
        Array.isArray(target.parameters) &&
        Array.isArray(instruction.arguments)
      ) {
        const parameterNames = new Set(
          target.parameters
            .filter(isRecord)
            .map((parameter) => parameter.name)
            .filter((name): name is string => typeof name === "string"),
        );
        const supplied = new Set<string>();
        instruction.arguments.forEach((argument, argumentIndex) => {
          if (!isRecord(argument) || typeof argument.parameterName !== "string") return;
          if (!parameterNames.has(argument.parameterName)) {
            errors.push(
              planError(
                "TSC002",
                "Call refers to an unknown function parameter.",
                `$.instructions[${instructionIndex}].arguments[${argumentIndex}].parameterName`,
              ),
            );
          }
          if (supplied.has(argument.parameterName)) {
            errors.push(
              planError(
                "TSC002",
                "Call supplies a function parameter more than once.",
                `$.instructions[${instructionIndex}].arguments[${argumentIndex}].parameterName`,
              ),
            );
          }
          supplied.add(argument.parameterName);
        });
        target.parameters.forEach((parameter, parameterIndex) => {
          if (
            isRecord(parameter) &&
            parameter.hasDefault === false &&
            typeof parameter.name === "string" &&
            !supplied.has(parameter.name)
          ) {
            errors.push(
              planError(
                "TSC002",
                "Call omits a required function parameter.",
                `$.instructions[${instructionIndex}].arguments[${parameterIndex}]`,
              ),
            );
          }
        });
      }
    }
  });
  return index;
}

function validateFunctionPrologue(
  range: ValidatedFunctionRange,
  instructions: readonly unknown[],
  errors: PlanValidationError[],
): void {
  const { definition, path } = range;
  if (!Array.isArray(definition.parameters)) return;

  let cursor = range.entryInstruction;
  for (let index = 0; index < definition.parameters.length; index += 1) {
    const instruction = instructions[cursor];
    if (
      !isRecord(instruction) ||
      instruction.kind !== "bindSuppliedParameter" ||
      instruction.functionId !== range.id ||
      instruction.parameterIndex !== index
    ) {
      errors.push(
        planError(
          "TSC002",
          "Function supplied-parameter prologue is malformed.",
          `${path}.entryInstruction`,
        ),
      );
      return;
    }
    cursor += 1;
  }
  const beginDefaults = instructions[cursor];
  if (
    !isRecord(beginDefaults) ||
    beginDefaults.kind !== "beginFunctionDefaults" ||
    beginDefaults.functionId !== range.id
  ) {
    errors.push(
      planError(
        "TSC002",
        "Function default-parameter prologue is missing.",
        `${path}.entryInstruction`,
      ),
    );
    return;
  }
  cursor += 1;
  for (let index = 0; index < definition.parameters.length; index += 1) {
    const parameter = definition.parameters[index];
    const prepare = instructions[cursor];
    if (
      !isRecord(parameter) ||
      !isRecord(prepare) ||
      prepare.kind !== "prepareParameterDefault" ||
      prepare.functionId !== range.id ||
      prepare.parameterIndex !== index ||
      !validInstructionBoundary(prepare.target, instructions.length) ||
      prepare.target <= cursor ||
      prepare.target >= range.bodyEntryInstruction
    ) {
      errors.push(
        planError(
          "TSC002",
          "Function parameter-default sequence is malformed.",
          `${path}.parameters[${index}]`,
        ),
      );
      return;
    }
    const regionStart = cursor + 1;
    const regionEnd = prepare.target;
    const defaultBindings: Record<string, unknown>[] = [];
    for (
      let instructionIndex = regionStart;
      instructionIndex < regionEnd && instructionIndex < instructions.length;
      instructionIndex += 1
    ) {
      const nested = instructions[instructionIndex];
      if (!isRecord(nested)) continue;
      if (nested.kind === "bindDefaultParameter") {
        if (nested.functionId !== range.id || nested.parameterIndex !== index) {
          errors.push(
            planError(
              "TSC002",
              "Default binding does not match its parameter segment.",
              `$.instructions[${instructionIndex}]`,
            ),
          );
        }
        defaultBindings.push(nested);
        continue;
      }
      if (
        !isOneOf(nested.kind, [
          "storeTemporary",
          "prepareReference",
          "clearTemporary",
          "clearTemporaries",
          "callFunction",
          "validateCallReceiver",
          "jumpIfFalse",
          "jump",
        ])
      ) {
        errors.push(
          planError(
            "TSC002",
            "Function default-expression region contains an invalid instruction.",
            `$.instructions[${instructionIndex}]`,
          ),
        );
      }
      if (
        (nested.kind === "jump" || nested.kind === "jumpIfFalse") &&
        (!validInstructionBoundary(nested.target, instructions.length) ||
          nested.target <= instructionIndex ||
          nested.target > regionEnd)
      ) {
        errors.push(
          planError(
            "TSC002",
            "Default-expression jump escapes its parameter segment.",
            `$.instructions[${instructionIndex}].target`,
          ),
        );
      }
    }
    if (
      (parameter.hasDefault === true && defaultBindings.length !== 1) ||
      (parameter.hasDefault === false && regionEnd !== regionStart)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Function parameter default does not match its metadata.",
          `${path}.parameters[${index}]`,
        ),
      );
    }
    if (parameter.hasDefault === true && defaultBindings.length === 1) {
      const bindingIndex = instructions.indexOf(defaultBindings[0]);
      for (
        let instructionIndex = regionStart;
        instructionIndex < regionEnd && instructionIndex < instructions.length;
        instructionIndex += 1
      ) {
        const nested = instructions[instructionIndex];
        if (!isRecord(nested)) continue;
        if (
          instructionIndex > bindingIndex &&
          nested.kind !== "clearTemporary" &&
          nested.kind !== "clearTemporaries"
        ) {
          errors.push(
            planError(
              "TSC002",
              "Only temporary cleanup may follow a default binding.",
              `$.instructions[${instructionIndex}]`,
            ),
          );
        }
        if (
          (nested.kind === "jump" || nested.kind === "jumpIfFalse") &&
          validInstructionBoundary(nested.target, instructions.length) &&
          nested.target > bindingIndex
        ) {
          errors.push(
            planError(
              "TSC002",
              "Default-expression control flow may not bypass its binding.",
              `$.instructions[${instructionIndex}].target`,
            ),
          );
        }
      }
    }
    cursor = prepare.target;
  }
  const bodyMarker = instructions[cursor];
  if (
    !isRecord(bodyMarker) ||
    bodyMarker.kind !== "enterFunctionBody" ||
    bodyMarker.functionId !== range.id ||
    cursor + 1 !== range.bodyEntryInstruction
  ) {
    errors.push(
      planError(
        "TSC002",
        "Function body-entry prologue marker is malformed.",
        `${path}.bodyEntryInstruction`,
      ),
    );
  }
  const prologueOnly = new Set([
    "bindSuppliedParameter",
    "beginFunctionDefaults",
    "prepareParameterDefault",
    "bindDefaultParameter",
    "enterFunctionBody",
  ]);
  for (
    let instructionIndex = range.bodyEntryInstruction;
    instructionIndex < range.endInstruction && instructionIndex < instructions.length;
    instructionIndex += 1
  ) {
    const instruction = instructions[instructionIndex];
    if (
      isRecord(instruction) &&
      typeof instruction.kind === "string" &&
      prologueOnly.has(instruction.kind)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Function prologue instruction appears inside the function body.",
          `$.instructions[${instructionIndex}]`,
        ),
      );
    }
  }
}

function validateFunctionParameters(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Function parameters must be an array.", path));
    return;
  }
  const names = new Set<string>();
  let sawDefault = false;
  value.forEach((parameter, index) => {
    const parameterPath = `${path}[${index}]`;
    if (!isRecord(parameter)) {
      errors.push(planError("TSC002", "Function parameter must be an object.", parameterPath));
      return;
    }
    rejectUnknownFields(parameter, PARAMETER_FIELDS, parameterPath, errors);
    requireString(parameter.name, `${parameterPath}.name`, errors);
    if (typeof parameter.name === "string") {
      if (names.has(parameter.name)) {
        errors.push(
          planError("TSC002", "Function parameter names must be unique.", `${parameterPath}.name`),
        );
      }
      names.add(parameter.name);
    }
    if (parameter.index !== index) {
      errors.push(
        planError(
          "TSC002",
          "Function parameter indexes must be contiguous.",
          `${parameterPath}.index`,
        ),
      );
    }
    if (typeof parameter.hasDefault !== "boolean") {
      errors.push(
        planError(
          "TSC002",
          "Function parameter default metadata is malformed.",
          `${parameterPath}.hasDefault`,
        ),
      );
    } else {
      if (!parameter.hasDefault && sawDefault) {
        errors.push(
          planError("TSC002", "Required parameter follows a defaulted parameter.", parameterPath),
        );
      }
      sawDefault ||= parameter.hasDefault;
    }
    validateSpan(parameter.declarationSpan, `${parameterPath}.declarationSpan`, errors);
    if (parameter.hasDefault === true) {
      validateSpan(parameter.defaultSpan, `${parameterPath}.defaultSpan`, errors);
    } else if (parameter.defaultSpan !== null) {
      errors.push(
        planError(
          "TSC002",
          "Required parameter must not have a default span.",
          `${parameterPath}.defaultSpan`,
        ),
      );
    }
  });
}

function requirePositiveInteger(value: unknown, path: string, errors: PlanValidationError[]): void {
  // EVIDENCE: validation: Number.isInteger establishes the numeric value before comparison.
  if (!Number.isInteger(value) || (value as number) < 1) {
    errors.push(planError("TSC002", "Expected a positive integer.", path));
  }
}
