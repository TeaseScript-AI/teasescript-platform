import type { ExpressionPlan, Instruction } from "./model.js";
import { expressionPlanChildren } from "./expression-children.js";

/** The temporaries an instruction reads, given the loop whose frame is innermost when it runs. */
export function requiredInstructionTemporaries(
  instruction: Instruction,
  activeLoopId: number | null,
): ReadonlySet<number> {
  const output = new Set<number>();
  const collect = (expression: ExpressionPlan): void => {
    collectExpressionTemporaries(expression, output);
  };
  switch (instruction.kind) {
    case "declareSpeaker":
      instruction.properties.forEach((property) => collect(property.value));
      break;
    case "declareGlobal":
    case "declareBinding":
      collect(instruction.value);
      break;
    case "prepareReference":
      collect(instruction.expression);
      break;
    case "validateAssignmentTarget":
      collect(instruction.target);
      break;
    case "assign":
      collect(instruction.value);
      collect(instruction.target);
      break;
    case "validateCallReceiver":
      collect(instruction.receiver);
      break;
    case "evaluate":
      collect(instruction.expression);
      break;
    case "jumpIfFalse":
      collect(instruction.condition);
      break;
    case "loopStart":
      // A repeat or for loop evaluates its expression only when it starts, not when it continues.
      if (instruction.loopKind === "while" || activeLoopId !== instruction.loopId) {
        collect(instruction.expression);
      }
      break;
    case "storeTemporary":
    case "bindDefaultParameter":
    case "prepareSayText":
    case "returnValue":
      collect(instruction.value);
      break;
    case "prepareSayContextualSpeaker":
      output.add(instruction.speakerTemporary);
      break;
    case "callFunction":
      instruction.arguments.forEach((argument) =>
        collectExpressionTemporaries(argument.value, output),
      );
      break;
    case "transfer":
    case "setFallback":
      if (instruction.destination !== null && "value" in instruction.destination)
        collect(instruction.destination.value);
      break;
    case "setDefaultSpeaker":
    case "prepareInteractionSpeaker":
    case "enterScope":
    case "leaveScope":
    case "jump":
    case "loopControl":
    case "clearTemporary":
    case "clearTemporaries":
    case "bindSuppliedParameter":
    case "beginFunctionDefaults":
    case "prepareParameterDefault":
    case "enterFunctionBody":
    case "returnVoid":
    case "exit":
      break;
    case "say":
      if (typeof instruction.textTemporary === "number") output.add(instruction.textTemporary);
      else collect(instruction.value);
      if (typeof instruction.speakerTemporary === "number")
        output.add(instruction.speakerTemporary);
      if (typeof instruction.pacing === "object") collect(instruction.pacing);
      if (instruction.presentation !== null) collect(instruction.presentation);
      break;
    case "wait":
      collect(instruction.duration);
      if (typeof instruction.display === "object") collect(instruction.display);
      if (instruction.label !== null) collect(instruction.label);
      break;
    case "startTimer":
      collect(instruction.duration);
      if (typeof instruction.display === "object") collect(instruction.display);
      if (instruction.label !== null) collect(instruction.label);
      break;
    case "pacingBarrier":
      if (instruction.receiver !== null) collect(instruction.receiver);
      break;
    case "showPermanentButton":
      collect(instruction.text);
      break;
    case "showImage":
      if (instruction.image !== null) collect(instruction.image);
      break;
    case "capture":
      if (instruction.tags !== null) collect(instruction.tags);
      break;
    case "storageWrite":
      if (instruction.value !== null) collect(instruction.value);
      collect(instruction.key);
      break;
    case "playMedia":
      collect(instruction.file);
      if (instruction.repeat.kind === "value") collect(instruction.repeat.value);
      if (instruction.repeat.kind === "times") collect(instruction.repeat.count);
      for (const operand of [instruction.startAt, instruction.endAt, instruction.volume]) {
        if (operand !== null) collect(operand);
      }
      for (const cue of instruction.cues) collect(cue.offset);
      break;
    case "interaction":
      if ("preparedUi" in instruction) {
        output.add(instruction.speakerTemporary);
        if (instruction.preparedUi.kind === "button") {
          output.add(instruction.preparedUi.buttonLabelTemporary);
          if (instruction.preparedUi.backgroundTemporary !== undefined)
            output.add(instruction.preparedUi.backgroundTemporary);
          if (instruction.preparedUi.timeoutTemporary !== undefined)
            output.add(instruction.preparedUi.timeoutTemporary);
        } else if (
          instruction.preparedUi.kind === "image" ||
          instruction.preparedUi.kind === "form"
        ) {
          output.add(instruction.preparedUi.requestTemporary);
        } else if (instruction.preparedUi.kind !== "choice") {
          if (instruction.preparedUi.hintTemporary !== null)
            output.add(instruction.preparedUi.hintTemporary);
          if (instruction.preparedUi.prefillTemporary !== undefined)
            output.add(instruction.preparedUi.prefillTemporary);
        } else output.add(instruction.preparedUi.optionsTemporary);
      }
      break;
  }
  return output;
}

/** The temporaries an instruction sets or clears, so that nothing earlier on the path holds them for later. */
export function instructionKilledTemporaries(instruction: Instruction): ReadonlySet<number> {
  switch (instruction.kind) {
    case "storeTemporary":
      return new Set([instruction.temporaryId]);
    case "prepareSayText":
    case "prepareSaySpeaker":
    case "prepareSayContextualSpeaker":
      return new Set([instruction.destinationTemporary]);
    case "prepareInteractionSpeaker":
      return new Set([instruction.destinationTemporary]);
    case "prepareReference":
      return new Set([instruction.destinationTemporary]);
    case "clearTemporary":
      return new Set([instruction.temporaryId]);
    case "clearTemporaries":
      return new Set(instruction.temporaryIds);
    case "callFunction":
      return new Set([instruction.destinationTemporary]);
    case "capture":
      return new Set([instruction.destinationTemporary]);
    case "interaction":
    case "startTimer":
    case "playMedia":
    case "showCamera":
    case "showPermanentButton":
      return instruction.destinationTemporary === null
        ? new Set<number>()
        : new Set([instruction.destinationTemporary]);
    default:
      return new Set<number>();
  }
}

function collectExpressionTemporaries(expression: ExpressionPlan, output: Set<number>): void {
  const pending = [expression];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.kind === "temporary" || current.kind === "preparedReference")
      output.add(current.temporaryId);
    const children = expressionPlanChildren(current);
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
  }
}
