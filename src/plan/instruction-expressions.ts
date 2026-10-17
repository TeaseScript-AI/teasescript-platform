import type { AssignmentTargetPlan, ExpressionPlan, Instruction } from "./model.js";

/**
 * The expression plans whose values the instruction reads when it runs, in no particular order: the runtime decides
 * it, and a lazy operand among them runs only on some ways (see `conditionalExpressionPlanChildren`). An assignment
 * target counts by what it reads: the object of a property, or the object and index of an element. An instruction that
 * reads only prepared temporaries gives none. A new instruction kind needs its expressions here alone.
 */
export function instructionExpressions(instruction: Instruction): readonly ExpressionPlan[] {
  switch (instruction.kind) {
    case "declareSpeaker":
      return instruction.properties.map((property) => property.value);
    case "declareGlobal":
    case "declareBinding":
    case "storeTemporary":
    case "bindDefaultParameter":
    case "prepareSayText":
    case "returnValue":
      return [instruction.value];
    case "prepareReference":
      return [instruction.expression];
    case "evaluate":
      return [instruction.expression];
    case "validateAssignmentTarget":
      return targetReads(instruction.target);
    case "assign":
      return [instruction.value, ...targetReads(instruction.target)];
    case "validateCallReceiver":
      return [instruction.receiver];
    case "jumpIfFalse":
      return [instruction.condition];
    case "loopStart":
      return [instruction.expression];
    case "callFunction":
      return instruction.arguments.map((argument) => argument.value);
    case "transfer":
    case "setFallback":
      return instruction.destination !== null && "value" in instruction.destination
        ? [instruction.destination.value]
        : [];
    case "say":
      return [
        ...(typeof instruction.textTemporary === "number" ? [] : [instruction.value]),
        ...(typeof instruction.pacing === "object" ? [instruction.pacing] : []),
        ...(instruction.presentation === null ? [] : [instruction.presentation]),
      ];
    case "wait":
    case "startTimer":
      return [
        instruction.duration,
        ...(typeof instruction.display === "object" ? [instruction.display] : []),
        ...(instruction.label === null ? [] : [instruction.label]),
      ];
    case "showPermanentButton":
      return [instruction.text];
    case "showImage":
      return instruction.image === null ? [] : [instruction.image];
    case "capture":
      return instruction.tags === null ? [] : [instruction.tags];
    case "fileStore":
      return [instruction.value, ...(instruction.files === null ? [] : [instruction.files])];
    case "lock":
      return [
        instruction.value,
        instruction.password,
        instruction.passwordField?.hint ?? null,
        instruction.timeLock,
      ].filter((operand): operand is ExpressionPlan => operand !== null);
    case "storageWrite":
      return [...(instruction.value === null ? [] : [instruction.value]), instruction.key];
    case "playMedia":
      return [
        instruction.file,
        ...(instruction.repeat.kind === "value"
          ? [instruction.repeat.value]
          : instruction.repeat.kind === "times"
            ? [instruction.repeat.count]
            : []),
        ...[instruction.startAt, instruction.endAt, instruction.volume].filter(
          (operand): operand is ExpressionPlan => operand !== null,
        ),
        ...instruction.cues.map((cue) => cue.offset),
      ];
    case "interaction":
    case "setDefaultSpeaker":
    case "copyAccount":
    case "enterScope":
    case "leaveScope":
    case "jump":
    case "loopControl":
    case "prepareSaySpeaker":
    case "prepareSayContextualSpeaker":
    case "prepareInteractionSpeaker":
    case "clearTemporary":
    case "clearTemporaries":
    case "bindSuppliedParameter":
    case "beginFunctionDefaults":
    case "prepareParameterDefault":
    case "enterFunctionBody":
    case "returnVoid":
    case "showCamera":
    case "hideCamera":
    case "stopAudio":
    case "goto":
    case "end":
    case "exit":
      return [];
  }
  instruction satisfies never;
  return [];
}

function targetReads(target: AssignmentTargetPlan): readonly ExpressionPlan[] {
  switch (target.kind) {
    case "identifier":
      return [];
    case "property":
      return [target.object];
    case "index":
      return [target.object, target.index];
  }
}
