import { isRecord } from "../validation-support.js";

// What one unvalidated instruction or expression sets, reads, or names as a target, for the stream checks.

export function expressionMayReferenceTemporary(value: unknown, temporaryId: number): boolean {
  const referenced = new Set<number>();
  collectExpressionTemporaryReferences(value, referenced);
  return referenced.has(temporaryId);
}

/** Uses an explicit worklist: validation reaches arbitrarily deep accepted expressions. */
export function collectExpressionTemporaryReferences(value: unknown, output: Set<number>): void {
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
      case "unit":
      case "angleUnit":
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

/** The temporaries an instruction sets: its result's, and the one that says whether a call needs its default. */
export function producedTemporaryIds(instruction: Record<string, unknown>): readonly number[] {
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
    instruction.kind === "say" ||
    instruction.kind === "callFunction" ||
    instruction.kind === "interaction" ||
    instruction.kind === "capture" ||
    instruction.kind === "fileStore" ||
    instruction.kind === "lock" ||
    instruction.kind === "startTimer" ||
    instruction.kind === "playMedia" ||
    instruction.kind === "showCamera" ||
    instruction.kind === "showPermanentButton"
  ) {
    value = instruction.destinationTemporary;
  }
  // EVIDENCE: validation: Number.isSafeInteger proves the returned numeric values.
  return [value, instruction.defaultTemporary].filter((id): id is number =>
    Number.isSafeInteger(id),
  );
}

export function explicitInstructionTargets(
  instruction: Record<string, unknown>,
): readonly unknown[] {
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
    case "transfer":
      // A computed destination names no instruction.
      if (!isRecord(instruction.destination) || "value" in instruction.destination) return [];
      return Array.isArray(instruction.destination.pick)
        ? instruction.destination.pick.map((option: unknown) =>
            isRecord(option) ? option.target : undefined,
          )
        : [instruction.destination.target];
    default:
      return [];
  }
}
