import { type PlanValidationError, isRecord, isOneOf, planError } from "../validation-support.js";
import { lazyDefaultArgumentIndex } from "../expression-children.js";
import type { PlanValidationIndex } from "./execution-regions.js";
import { producedTemporaryIds, explicitInstructionTargets } from "./instruction-facts.js";

export function validateCanonicalInteractionResultHandoffs(
  instructions: readonly unknown[],
  index: PlanValidationIndex,
  errors: PlanValidationError[],
): void {
  const producers = new Map<number, number[]>();
  const explicitTargets = new Set<number>();
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction)) return;
    for (const produced of producedTemporaryIds(instruction)) {
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
      // A `default:` that runs only when the call needs it may not run.
      const lazy =
        isRecord(value.callee) && Array.isArray(value.arguments) && value.arguments.every(isRecord)
          ? lazyDefaultArgumentIndex({ callee: value.callee, arguments: value.arguments })
          : -1;
      const argumentConsumes =
        Array.isArray(value.arguments) &&
        value.arguments.some(
          (argument, index) =>
            index !== lazy &&
            isRecord(argument) &&
            expressionGuaranteesTemporaryEvaluation(argument.value, temporaryId),
        );
      return calleeConsumes || argumentConsumes;
    }
    case "unary":
    case "unit":
    case "angleUnit":
      return expressionGuaranteesTemporaryEvaluation(value.operand, temporaryId);
    case "typeTest":
      return expressionGuaranteesTemporaryEvaluation(value.value, temporaryId);
    case "binary":
      // The right operand of a short-circuit operator may not run.
      if (value.operator === "and" || value.operator === "or" || value.operator === "otherwise") {
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
