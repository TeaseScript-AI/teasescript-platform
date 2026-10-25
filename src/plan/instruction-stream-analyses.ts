import {
  type PlanValidationError,
  isRecord,
  planError,
  positiveSafeInteger,
  validInstructionBoundary,
} from "./validation-support.js";
import type {
  PlanFileBoundaries,
  InstructionExecutionRegion,
  PlanValidationIndex,
} from "./instruction-stream-analyses/execution-regions.js";
import { validateFunctionDefinitions } from "./instruction-stream-analyses/function-definitions.js";
import { validateCanonicalInteractionResultHandoffs } from "./instruction-stream-analyses/interaction-result-handoffs.js";
import { validateCanonicalPreparedSays } from "./instruction-stream-analyses/prepared-says.js";

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
        } else if (
          region.kind === "function" &&
          index.functionsById.get(region.functionId)?.global === true
        ) {
          // A global function runs in the file that called it, so no label is its own (V30 §11).
          errors.push(
            planError(
              "TSC002",
              "A goto in a global function or its blocks has no label to continue at.",
              `${instructionPath}.target`,
            ),
          );
        }
        return;
      case "transfer":
        // A computed destination is resolved, and checked, when it runs.
        if (
          !(isRecord(instruction.destination) && "value" in instruction.destination) &&
          !isFileDestination(index, instruction.destination)
        ) {
          errors.push(
            planError(
              "TSC002",
              "A transfer must enter a file at its entry.",
              `${instructionPath}.destination`,
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

/** A plain destination, or a glob's list of them; a pick holds plain destinations only. */
function isFileDestination(index: PlanValidationIndex, destination: unknown): boolean {
  if (isRecord(destination) && Array.isArray(destination.pick)) {
    return destination.pick.every((option) => isPlainFileDestination(index, option));
  }
  return isPlainFileDestination(index, destination);
}

function isPlainFileDestination(index: PlanValidationIndex, destination: unknown): boolean {
  if (!isRecord(destination)) return false;
  const { file, target } = destination;
  if (typeof file !== "number" || typeof target !== "number") return false;
  const boundaries = index.files[file];
  return boundaries !== undefined && target === boundaries.entryInstruction;
}
