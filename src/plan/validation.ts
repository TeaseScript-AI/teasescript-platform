import {
  boundedInteractionUtf8ByteLength,
  interactionStringHasNonWhitespace,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../interaction-limits.js";
import { recordValidationTestWork } from "../validation-testing.js";
import {
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
} from "./model.js";
import {
  captureFailureValidation,
  capturePlanData,
  isPlanCaptureFailure,
} from "./capture-support.js";

export interface PlanValidationError {
  readonly code: "TSC001" | "TSC002";
  readonly message: string;
  readonly path: string;
}

export interface PlanValidationResult {
  readonly valid: boolean;
  readonly errors: readonly PlanValidationError[];
}

export function validateInstructionPlan(value: unknown): PlanValidationResult {
  const capture = capturePlanData(value);
  return isPlanCaptureFailure(capture)
    ? captureFailureValidation(capture.message, capture.path)
    : validateCapturedInstructionPlan(capture.value);
}

export function validateCapturedInstructionPlan(
  value: unknown,
): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  if (!isRecord(value)) {
    return invalidPlan("TSC002", "Instruction plan must be an object.", "$.");
  }
  if (value.format !== INSTRUCTION_PLAN_FORMAT) {
    errors.push(planError("TSC001", "Unsupported instruction-plan format.", "$.format"));
  }
  if (value.version !== INSTRUCTION_PLAN_VERSION) {
    errors.push(planError("TSC001", "Unsupported instruction-plan version.", "$.version"));
  }
  validateSpan(value.sourceSpan, "$.sourceSpan", errors);
  const temporaryCount = nonNegativeSafeInteger(value.temporaryCount)
    ? value.temporaryCount
    : -1;
  if (temporaryCount < 0) {
    errors.push(planError("TSC002", "temporaryCount must be a non-negative safe integer.", "$.temporaryCount"));
  }
  if (!Array.isArray(value.instructions)) {
    errors.push(planError("TSC002", "Instructions must be an array.", "$.instructions"));
  } else {
    const rootEndInstruction = validInstructionBoundary(
      value.rootEndInstruction,
      value.instructions.length,
    )
      ? value.rootEndInstruction
      : null;
    if (rootEndInstruction === null) {
      errors.push(planError(
        "TSC002",
        "Root execution boundary is invalid.",
        "$.rootEndInstruction",
      ));
    }
    const functionIds = collectFunctionIds(value.functions);
    for (let index = 0; index < value.instructions.length; index += 1) {
      validateInstruction(
        value.instructions[index],
        `$.instructions[${index}]`,
        value.instructions.length,
        index,
        temporaryCount,
        functionIds,
        errors,
      );
    }
    validateLoopStructure(value.instructions, errors);
    validatePreparedReferenceStructure(value.instructions, errors);
    const validationIndex = validateFunctionDefinitions(
      value.functions,
      value.instructions,
      rootEndInstruction,
      errors,
    );
    validateInstructionControlFlowRegions(
      value.instructions,
      validationIndex,
      errors,
    );
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  });
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
      const temporaryId = instruction.destinationTemporary as number;
      if (producers.has(temporaryId)) {
        errors.push(planError(
          "TSC002",
          "Prepared-reference temporary is produced more than once.",
          `$.instructions[${index}].destinationTemporary`,
        ));
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
        errors.push(planError(
          "TSC002",
          "Prepared-reference expression has no matching producer.",
          `$.instructions[${index}]`,
        ));
        continue;
      }
      if (producer >= index) {
        errors.push(planError(
          "TSC002",
          "Prepared-reference producer must precede its use.",
          `$.instructions[${index}]`,
        ));
      }
    }
  }
}

function collectPreparedReferenceIds(
  value: unknown,
  output: Set<number>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPreparedReferenceIds(item, output);
    return;
  }
  if (!isRecord(value)) return;
  if (value.kind === "preparedReference" && Number.isInteger(value.temporaryId)) {
    output.add(value.temporaryId as number);
    return;
  }
  for (const nested of Object.values(value)) {
    collectPreparedReferenceIds(nested, output);
  }
}

function validateLoopStructure(
  instructions: readonly unknown[],
  errors: PlanValidationError[],
): void {
  const starts = new Map<number, { index: number; target: number; continueTarget: number }>();
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!isRecord(instruction) || instruction.kind !== "loopStart") continue;
    if (
      !positiveSafeInteger(instruction.loopId) ||
      !Number.isInteger(instruction.target) ||
      !Number.isInteger(instruction.continueTarget)
    ) continue;
    const loopId = instruction.loopId as number;
    if (starts.has(loopId)) {
      errors.push(planError("TSC002", "Loop IDs must be unique.", `$.instructions[${index}].loopId`));
    } else {
      starts.set(loopId, {
        index,
        target: instruction.target as number,
        continueTarget: instruction.continueTarget as number,
      });
    }
    if ((instruction.target as number) <= index) {
      errors.push(planError("TSC002", "Loop exit target must follow its start.", `$.instructions[${index}].target`));
    }
    if (
      (instruction.loopKind === "while" && (instruction.continueTarget as number) > index) ||
      (instruction.loopKind !== "while" && instruction.continueTarget !== index)
    ) {
      errors.push(planError("TSC002", "Loop continue target is invalid.", `$.instructions[${index}].continueTarget`));
    }
  }
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!isRecord(instruction) || instruction.kind !== "loopControl") continue;
    if (!positiveSafeInteger(instruction.loopId) || !Number.isInteger(instruction.target)) continue;
    const start = starts.get(instruction.loopId as number);
    if (start === undefined) {
      errors.push(planError("TSC002", "Loop control refers to an unknown loop.", `$.instructions[${index}].loopId`));
      continue;
    }
    const expected = instruction.action === "continue" ? start.continueTarget : start.target;
    if (instruction.target !== expected || index <= start.index || index >= start.target) {
      errors.push(planError("TSC002", "Loop-control target does not match its loop.", `$.instructions[${index}].target`));
    }
  }
}

function validateInstruction(
  value: unknown,
  path: string,
  instructionCount: number,
  instructionIndex: number,
  temporaryCount: number,
  functionIds: ReadonlySet<number>,
  errors: PlanValidationError[],
): void {
  if (!isRecord(value) || typeof value.kind !== "string") {
    errors.push(planError("TSC002", "Instruction must be an object with a kind.", path));
    return;
  }
  validateSpan(value.span, `${path}.span`, errors);
  switch (value.kind) {
    case "declareSpeaker":
      requireString(value.name, `${path}.name`, errors);
      validateProperties(value.properties, `${path}.properties`, errors, temporaryCount);
      return;
    case "setDeclaredSpeakerProperty":
      requireString(value.speaker, `${path}.speaker`, errors);
      requireString(value.name, `${path}.name`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "setDefaultSpeaker":
      requireString(value.name, `${path}.name`, errors);
      return;
    case "enterScope":
    case "leaveScope":
    case "exit":
      return;
    case "declareBinding":
      requireString(value.name, `${path}.name`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "prepareReference":
      validateExpression(
        value.expression,
        `${path}.expression`,
        errors,
        false,
        temporaryCount,
      );
      validateTemporaryId(
        value.destinationTemporary,
        `${path}.destinationTemporary`,
        temporaryCount,
        errors,
      );
      return;
    case "validateAssignmentTarget":
      validateExpression(value.target, `${path}.target`, errors, true, temporaryCount);
      validatePreparedAssignmentTarget(value.target, `${path}.target`, errors);
      return;
    case "assign":
      validateExpression(value.target, `${path}.target`, errors, true, temporaryCount);
      validatePreparedAssignmentTarget(value.target, `${path}.target`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "validateCallReceiver":
      validateExpression(value.receiver, `${path}.receiver`, errors, false, temporaryCount);
      requireString(value.method, `${path}.method`, errors);
      return;
    case "evaluate":
      validateExpression(value.expression, `${path}.expression`, errors, false, temporaryCount);
      return;
    case "jumpIfFalse":
      validateExpression(value.condition, `${path}.condition`, errors, false, temporaryCount);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "jump":
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "loopStart":
      if (!["repeat", "for", "while"].includes(String(value.loopKind))) {
        errors.push(planError("TSC002", "Invalid loop kind.", `${path}.loopKind`));
      }
      requirePositiveSafeInteger(value.loopId, `${path}.loopId`, errors);
      if (value.loopKind === "for") requireString(value.variable, `${path}.variable`, errors);
      validateExpression(value.expression, `${path}.expression`, errors, false, temporaryCount);
      validateJumpTarget(value.continueTarget, `${path}.continueTarget`, instructionCount, errors);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "loopControl":
      if (!["break", "continue"].includes(String(value.action))) {
        errors.push(planError("TSC002", "Invalid loop-control action.", `${path}.action`));
      }
      requirePositiveSafeInteger(value.loopId, `${path}.loopId`, errors);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "storeTemporary":
      validateTemporaryId(value.temporaryId, `${path}.temporaryId`, temporaryCount, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      if (typeof value.expectBoolean !== "boolean") {
        errors.push(planError("TSC002", "Temporary boolean expectation must be boolean.", `${path}.expectBoolean`));
      }
      return;
    case "prepareSaySpeaker":
      if (!hasExactKeys(value, ["kind", "speaker", "destinationTemporary", "span"])) {
        errors.push(planError("TSC002", "Prepared say speaker instruction contains unsupported fields.", path));
      }
      if (value.speaker !== null) requireString(value.speaker, `${path}.speaker`, errors);
      validateTemporaryId(value.destinationTemporary, `${path}.destinationTemporary`, temporaryCount, errors);
      return;
    case "prepareSayText":
      if (!hasExactKeys(value, ["kind", "value", "destinationTemporary", "span"])) {
        errors.push(planError("TSC002", "Prepared say text instruction contains unsupported fields.", path));
      }
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      validateTemporaryId(value.destinationTemporary, `${path}.destinationTemporary`, temporaryCount, errors);
      return;
    case "prepareInteractionSpeaker":
      if (!hasExactKeys(value, ["kind", "speaker", "destinationTemporary", "span"])) {
        errors.push(planError("TSC002", "Prepared interaction speaker instruction contains unsupported fields.", path));
      }
      if (value.speaker !== null) requireString(value.speaker, `${path}.speaker`, errors);
      validateTemporaryId(value.destinationTemporary, `${path}.destinationTemporary`, temporaryCount, errors);
      return;
    case "clearTemporary":
      validateTemporaryId(value.temporaryId, `${path}.temporaryId`, temporaryCount, errors);
      return;
    case "callFunction":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      validatePreparedArguments(value.arguments, `${path}.arguments`, temporaryCount, errors);
      validateTemporaryId(value.destinationTemporary, `${path}.destinationTemporary`, temporaryCount, errors);
      if (
        Number.isInteger(value.destinationTemporary) &&
        Array.isArray(value.arguments) &&
        value.arguments.some(
          (argument) =>
            isRecord(argument) &&
            argument.temporaryId === value.destinationTemporary,
        )
      ) {
        errors.push(planError(
          "TSC002",
          "Function result destination must not alias an argument temporary.",
          `${path}.destinationTemporary`,
        ));
      }
      validateJumpTarget(value.returnInstruction, `${path}.returnInstruction`, instructionCount, errors);
      if (value.returnInstruction !== instructionIndex + 1) {
        errors.push(planError("TSC002", "Function return target must be the instruction after the call.", `${path}.returnInstruction`));
      }
      return;
    case "bindSuppliedParameter":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      requireNonNegativeInteger(value.parameterIndex, `${path}.parameterIndex`, errors);
      return;
    case "beginFunctionDefaults":
    case "enterFunctionBody":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      return;
    case "prepareParameterDefault":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      requireNonNegativeInteger(value.parameterIndex, `${path}.parameterIndex`, errors);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      if (typeof value.target === "number" && value.target <= instructionIndex) {
        errors.push(planError("TSC002", "Parameter-default target must move forward.", `${path}.target`));
      }
      return;
    case "bindDefaultParameter":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      requireNonNegativeInteger(value.parameterIndex, `${path}.parameterIndex`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "returnValue":
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "returnVoid":
      return;
    case "say":
      if (value.speaker !== null) requireString(value.speaker, `${path}.speaker`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      if (value.speakerTemporary !== undefined) validateTemporaryId(value.speakerTemporary, `${path}.speakerTemporary`, temporaryCount, errors);
      if (value.textTemporary !== undefined) validateTemporaryId(value.textTemporary, `${path}.textTemporary`, temporaryCount, errors);
      if (value.skipPolicy !== null && value.skipPolicy !== "skippable" && value.skipPolicy !== "unskippable") {
        errors.push(planError("TSC002", "Say skip policy is invalid.", `${path}.skipPolicy`));
      }
      if (value.pacing !== "smart" && value.pacing !== "instant") {
        validateExpression(value.pacing, `${path}.pacing`, errors, false, temporaryCount);
      }
      return;
    case "wait":
      if (value.unit !== null && !["ms", "s", "min", "h"].includes(String(value.unit))) {
        errors.push(planError("TSC002", "Wait unit is invalid.", `${path}.unit`));
      }
      validateExpression(value.duration, `${path}.duration`, errors, false, temporaryCount);
      return;
    case "interaction":
      validateInteractionInstruction(value, path, temporaryCount, errors);
      return;
    default:
      errors.push(planError("TSC002", `Unknown instruction kind '${value.kind}'.`, `${path}.kind`));
  }
}

function validateInteractionInstruction(
  value: Record<string, unknown>,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  const prepared = Object.hasOwn(value, "preparedUi") || Object.hasOwn(value, "speakerTemporary");
  const expectedKeys = prepared
    ? ["kind", "interactionKind", "target", "speakerTemporary", "destinationTemporary", "expectedResult", "preparedUi", "span"]
    : ["kind", "interactionKind", "target", "speaker", "destinationTemporary", "expectedResult", "ui", "span"];
  if (!hasExactKeys(value, expectedKeys)) {
    errors.push(planError("TSC002", "Interaction instruction contains unsupported fields.", path));
  }
  const kind = value.interactionKind;
  if (!["button", "text", "number", "choice"].includes(String(kind))) {
    errors.push(planError("TSC002", "Interaction kind is invalid.", `${path}.interactionKind`));
  }
  if (value.target !== "standardChat") errors.push(planError("TSC002", "Interaction target is invalid.", `${path}.target`));

  const ui = prepared ? value.preparedUi : value.ui;
  const labelType = isRecord(ui) && ui.kind === "choice" ? ui.labelType : undefined;
  const expected = kind === "button"
    ? "none"
    : kind === "number" || (kind === "choice" && labelType === "number")
      ? "number"
      : "string";
  if (value.expectedResult !== expected) {
    errors.push(planError(
      "TSC002",
      "Interaction result domain does not match its kind.",
      `${path}.expectedResult`,
    ));
  }
  if (kind === "button") {
    if (value.destinationTemporary !== null) {
      errors.push(planError(
        "TSC002",
        "Button interaction must not have a result destination.",
        `${path}.destinationTemporary`,
      ));
    }
  } else {
    validateTemporaryId(value.destinationTemporary, `${path}.destinationTemporary`, temporaryCount, errors);
  }

  if (prepared) {
    validateTemporaryId(value.speakerTemporary, `${path}.speakerTemporary`, temporaryCount, errors);
    if (value.destinationTemporary === value.speakerTemporary) {
      errors.push(planError(
        "TSC002",
        "Interaction result destination must not alias its prepared speaker temporary.",
        `${path}.destinationTemporary`,
      ));
    }
    validatePreparedInteractionUi(kind, ui, `${path}.preparedUi`, temporaryCount, value.speakerTemporary, value.destinationTemporary, errors);
    return;
  }

  if (value.speaker !== null) requireString(value.speaker, `${path}.speaker`, errors);
  validateStaticInteractionUi(kind, ui, `${path}.ui`, errors);
}

function validateStaticInteractionUi(
  kind: unknown,
  ui: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!isRecord(ui) || ui.kind !== kind) {
    errors.push(planError("TSC002", "Interaction UI payload does not match its kind.", path));
    return;
  }
  const uiKeys = kind === "button"
    ? ["kind", "buttonLabel", "accessibleName"]
    : kind === "text" || kind === "number"
      ? ["kind", "hint", "accessibleName"]
      : ["kind", "labelType", "options", "accessibleName"];
  if (!hasExactKeys(ui, uiKeys)) {
    errors.push(planError("TSC002", "Interaction UI payload contains unsupported fields.", path));
  }
  let aggregate = 0;
  let measurementExhausted = false;
  const countString = (candidate: unknown, fieldPath: string): candidate is string => {
    if (typeof candidate !== "string") {
      errors.push(planError("TSC002", "Interaction text must be a string.", fieldPath));
      return false;
    }
    if (measurementExhausted) {
      if (candidate.length > Math.max(0, MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate)) {
        errors.push(planError("TSC002", "Interaction text exceeds the remaining aggregate UTF-8 byte limit.", fieldPath));
        return false;
      }
      return true;
    }
    recordValidationTestWork("interactionUtf8Measurements");
    const bytes = boundedInteractionUtf8ByteLength(
      candidate,
      MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate,
    );
    if (bytes === null) {
      measurementExhausted = true;
      errors.push(planError("TSC002", "Interaction text exceeds the remaining aggregate UTF-8 byte limit.", fieldPath));
      return false;
    }
    aggregate += bytes;
    return true;
  };
  validateInteractionAccessibleName(
    kind,
    ui.accessibleName,
    `${path}.accessibleName`,
    countString,
    measurementExhausted,
    errors,
  );
  if (kind === "button") countString(ui.buttonLabel, `${path}.buttonLabel`);
  if (kind === "text" || kind === "number") {
    if (ui.hint !== null) countString(ui.hint, `${path}.hint`);
  }
  if (kind === "choice") {
    const labelType = ui.labelType;
    if (!["none", "identifier", "number"].includes(String(labelType))) {
      errors.push(planError("TSC002", "Choice label type is invalid.", `${path}.labelType`));
    }
    if (!Array.isArray(ui.options) || ui.options.length === 0 || ui.options.length > MAX_INTERACTION_OPTION_ENTRIES) {
      errors.push(planError("TSC002", "Choice options exceed the shared collection boundary or are empty.", `${path}.options`));
    } else {
      const labels = new Set<string | number>();
      const visible = new Set<string>();
      for (let index = 0; index < ui.options.length; index += 1) {
        const option = ui.options[index];
        const optionPath = `${path}.options[${index}]`;
        if (!isRecord(option)) {
          errors.push(planError("TSC002", "Choice option must be an object.", optionPath));
          continue;
        }
        if (!hasExactKeys(option, ["text", "label"])) {
          errors.push(planError(
            "TSC002",
            "Choice option contains unsupported fields.",
            optionPath,
          ));
        }
        const textValid = countString(option.text, `${optionPath}.text`);
        const label = option.label;
        const validLabel = labelType === "none"
          ? label === null
          : labelType === "identifier"
            ? typeof label === "string" &&
              countString(label, `${optionPath}.label`) &&
              (measurementExhausted || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(label))
            : typeof label === "number" &&
              Number.isFinite(label) &&
              !Object.is(label, -0);
        if (!validLabel) {
          errors.push(planError(
            "TSC002",
            "Choice option label does not match the choice label type.",
            `${optionPath}.label`,
          ));
        }
        if (!measurementExhausted && validLabel && (typeof label === "string" || typeof label === "number")) {
          if (labels.has(label)) {
            errors.push(planError("TSC002", "Choice labels must be unique.", `${optionPath}.label`));
          }
          labels.add(label);
        }
        if (!measurementExhausted && textValid && labelType === "none") {
          if (visible.has(option.text as string)) {
            errors.push(planError("TSC002", "Unlabelled choice text must be unique.", `${optionPath}.text`));
          }
          visible.add(option.text as string);
        }
      }
    }
  }
}

function validatePreparedInteractionUi(
  kind: unknown,
  ui: unknown,
  path: string,
  temporaryCount: number,
  speakerTemporary: unknown,
  destinationTemporary: unknown,
  errors: PlanValidationError[],
): void {
  if (!isRecord(ui) || ui.kind !== kind) {
    errors.push(planError("TSC002", "Prepared interaction UI payload does not match its kind.", path));
    return;
  }
  const keys = kind === "button"
    ? ["kind", "buttonLabelTemporary", "accessibleName"]
    : kind === "text" || kind === "number"
      ? ["kind", "hintTemporary", "accessibleName"]
      : ["kind", "labelType", "optionsTemporary", "optionCount", "labels", "accessibleName"];
  if (!hasExactKeys(ui, keys)) {
    errors.push(planError("TSC002", "Prepared interaction UI payload contains unsupported fields.", path));
  }
  let aggregate = 0;
  let measurementExhausted = false;
  const countString = (candidate: unknown, fieldPath: string): candidate is string => {
    if (typeof candidate !== "string") {
      errors.push(planError("TSC002", "Interaction text must be a string.", fieldPath));
      return false;
    }
    if (measurementExhausted) {
      if (candidate.length > Math.max(0, MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate)) {
        errors.push(planError("TSC002", "Interaction text exceeds the remaining aggregate UTF-8 byte limit.", fieldPath));
        return false;
      }
      return true;
    }
    recordValidationTestWork("interactionUtf8Measurements");
    const bytes = boundedInteractionUtf8ByteLength(
      candidate,
      MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate,
    );
    if (bytes === null) {
      measurementExhausted = true;
      errors.push(planError("TSC002", "Interaction text exceeds the remaining aggregate UTF-8 byte limit.", fieldPath));
      return false;
    }
    aggregate += bytes;
    return true;
  };
  validateInteractionAccessibleName(
    kind,
    ui.accessibleName,
    `${path}.accessibleName`,
    countString,
    measurementExhausted,
    errors,
  );
  const used = new Set<number>();
  const addTemporary = (value: unknown, fieldPath: string): void => {
    validateTemporaryId(value, fieldPath, temporaryCount, errors);
    if (typeof value === "number") {
      if (value === speakerTemporary || value === destinationTemporary || used.has(value)) {
        errors.push(planError(
          "TSC002",
          "Prepared interaction temporaries must be pairwise distinct.",
          fieldPath,
        ));
      }
      used.add(value);
    }
  };
  if (kind === "button") {
    addTemporary(ui.buttonLabelTemporary, `${path}.buttonLabelTemporary`);
    return;
  }
  if (kind === "text" || kind === "number") {
    if (ui.hintTemporary !== null) addTemporary(ui.hintTemporary, `${path}.hintTemporary`);
    return;
  }
  if (kind !== "choice") return;
  if (!["none", "identifier", "number"].includes(String(ui.labelType))) {
    errors.push(planError("TSC002", "Choice label type is invalid.", `${path}.labelType`));
  }
  addTemporary(ui.optionsTemporary, `${path}.optionsTemporary`);
  if (
    !Number.isSafeInteger(ui.optionCount) ||
    (ui.optionCount as number) < 1 ||
    (ui.optionCount as number) > MAX_INTERACTION_OPTION_ENTRIES
  ) {
    errors.push(planError("TSC002", "Prepared choice option count exceeds the shared collection boundary or is empty.", `${path}.optionCount`));
  }
  if (ui.labelType === "none") {
    if (ui.labels !== null) {
      errors.push(planError(
        "TSC002",
        "Unlabelled prepared choice must not carry labels.",
        `${path}.labels`,
      ));
    }
    return;
  }
  if (!Array.isArray(ui.labels) || ui.labels.length !== ui.optionCount) {
    errors.push(planError("TSC002", "Prepared choice labels must match the option count.", `${path}.labels`));
    return;
  }
  const labels = new Set<string | number>();
  for (let index = 0; index < ui.labels.length; index += 1) {
    const label = ui.labels[index];
    const labelPath = `${path}.labels[${index}]`;
    const valid = ui.labelType === "identifier"
      ? countString(label, labelPath) &&
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(label)
      : typeof label === "number" &&
        Number.isFinite(label) &&
        !Object.is(label, -0);
    if (!valid) {
      errors.push(planError("TSC002", "Prepared choice label does not match the label type.", labelPath));
    }
    if (
      (typeof label === "string" || typeof label === "number") &&
      labels.has(label)
    ) {
      errors.push(planError("TSC002", "Prepared choice labels must be unique.", labelPath));
    }
    if (typeof label === "string" || typeof label === "number") labels.add(label);
  }
}

function validateInteractionAccessibleName(
  kind: unknown,
  accessible: unknown,
  path: string,
  countString: (candidate: unknown, fieldPath: string) => candidate is string,
  measurementExhausted: boolean,
  errors: PlanValidationError[],
): void {
  if (!isRecord(accessible) || (accessible.kind !== "text" && accessible.kind !== "localizedDefault")) {
    errors.push(planError("TSC002", "Interaction accessible name is invalid.", path));
    return;
  }
  if (accessible.kind === "text") {
    if (!hasExactKeys(accessible, ["kind", "text"])) {
      errors.push(planError("TSC002", "Interaction accessible name contains unsupported fields.", path));
    }
    if (
      countString(accessible.text, `${path}.text`) &&
      !measurementExhausted &&
      !interactionStringHasNonWhitespace(accessible.text)
    ) {
      errors.push(planError("TSC002", "Explicit interaction accessible name must contain a non-whitespace character.", `${path}.text`));
    }
    return;
  }
  if (!hasExactKeys(accessible, ["kind", "key"])) {
    errors.push(planError("TSC002", "Interaction accessible name contains unsupported fields.", path));
  }
  const expectedKey = kind === "button"
    ? "continue"
    : kind === "number"
      ? "number"
      : kind === "choice"
        ? "chooseOption"
        : "answer";
  if (accessible.key !== expectedKey) {
    errors.push(planError(
      "TSC002",
      "Interaction localized accessible-name key does not match its kind.",
      `${path}.key`,
    ));
  }
}

function validateExpression(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  assignmentTarget = false,
  temporaryCount = -1,
): void {
  if (!isRecord(value) || typeof value.kind !== "string") {
    errors.push(planError("TSC002", "Expression must be an object with a kind.", path));
    return;
  }
  validateSpan(value.span, `${path}.span`, errors);
  if (assignmentTarget && !["identifier", "property", "index"].includes(value.kind)) {
    errors.push(planError("TSC002", "Invalid assignment target plan.", path));
  }
  switch (value.kind) {
    case "literal":
      if (!isScalar(value.value)) {
        errors.push(planError("TSC002", "Literal value must be a finite JSON scalar.", `${path}.value`));
      }
      return;
    case "identifier":
      requireString(value.name, `${path}.name`, errors);
      return;
    case "temporary":
    case "preparedReference":
      validateTemporaryId(value.temporaryId, `${path}.temporaryId`, temporaryCount, errors);
      return;
    case "list":
    case "set":
      validateExpressionArray(value.elements, `${path}.elements`, errors, temporaryCount);
      return;
    case "object":
      validateProperties(value.properties, `${path}.properties`, errors, temporaryCount);
      return;
    case "group":
      validateExpression(value.expression, `${path}.expression`, errors, false, temporaryCount);
      return;
    case "template":
      validateTemplateParts(value.parts, `${path}.parts`, errors, temporaryCount);
      return;
    case "property":
      validateExpression(value.object, `${path}.object`, errors, false, temporaryCount);
      requireString(value.name, `${path}.name`, errors);
      return;
    case "index":
      validateExpression(value.object, `${path}.object`, errors, false, temporaryCount);
      validateExpression(value.index, `${path}.index`, errors, false, temporaryCount);
      return;
    case "call":
      validateExpression(value.callee, `${path}.callee`, errors, false, temporaryCount);
      validateArguments(value.arguments, `${path}.arguments`, errors, temporaryCount);
      return;
    case "unary":
      if (!["+", "-", "not"].includes(String(value.operator))) {
        errors.push(planError("TSC002", "Invalid unary operator.", `${path}.operator`));
      }
      validateExpression(value.operand, `${path}.operand`, errors, false, temporaryCount);
      return;
    case "binary":
      if (!binaryOperators.has(String(value.operator))) {
        errors.push(planError("TSC002", "Invalid binary operator.", `${path}.operator`));
      }
      validateExpression(value.left, `${path}.left`, errors, false, temporaryCount);
      validateExpression(value.right, `${path}.right`, errors, false, temporaryCount);
      return;
    case "range":
      validateExpression(value.start, `${path}.start`, errors, false, temporaryCount);
      validateExpression(value.end, `${path}.end`, errors, false, temporaryCount);
      if (typeof value.inclusive !== "boolean") {
        errors.push(planError("TSC002", "Range inclusivity must be boolean.", `${path}.inclusive`));
      }
      return;
    default:
      errors.push(planError("TSC002", `Unknown expression kind '${value.kind}'.`, `${path}.kind`));
  }
}

function validatePreparedAssignmentTarget(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!isRecord(value)) return;
  if (value.kind === "identifier") return;
  if (value.kind === "property") {
    if (!isRecord(value.object) || value.object.kind !== "preparedReference") {
      errors.push(planError(
        "TSC002",
        "Assignment receivers must be captured before the right-hand value.",
        `${path}.object`,
      ));
    }
    return;
  }
  if (value.kind === "index") {
    if (!isRecord(value.index) || value.index.kind !== "temporary") {
      errors.push(planError(
        "TSC002",
        "Assignment indexes must be prepared in a temporary before the right-hand value.",
        `${path}.index`,
      ));
    }
    if (!isRecord(value.object) || value.object.kind !== "preparedReference") {
      errors.push(planError(
        "TSC002",
        "Assignment receivers must be captured before the right-hand value.",
        `${path}.object`,
      ));
    }
  }
}

function validateProperties(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  temporaryCount: number,
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Properties must be an array.", path));
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const property = value[index];
    const propertyPath = `${path}[${index}]`;
    if (!isRecord(property)) {
      errors.push(planError("TSC002", "Property must be an object.", propertyPath));
      continue;
    }
    requireString(property.name, `${propertyPath}.name`, errors);
    validateExpression(property.value, `${propertyPath}.value`, errors, false, temporaryCount);
    validateSpan(property.span, `${propertyPath}.span`, errors);
  }
}

function validateExpressionArray(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  temporaryCount: number,
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Expression list must be an array.", path));
    return;
  }
  value.forEach((item, index) =>
    validateExpression(item, `${path}[${index}]`, errors, false, temporaryCount)
  );
}

function validateTemplateParts(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  temporaryCount: number,
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Template parts must be an array.", path));
    return;
  }
  value.forEach((part, index) => {
    const partPath = `${path}[${index}]`;
    if (!isRecord(part)) {
      errors.push(planError("TSC002", "Template part must be an object.", partPath));
      return;
    }
    validateSpan(part.span, `${partPath}.span`, errors);
    if (part.kind === "text") requireString(part.value, `${partPath}.value`, errors);
    else if (part.kind === "expression") {
      validateExpression(part.expression, `${partPath}.expression`, errors, false, temporaryCount);
    } else {
      errors.push(planError("TSC002", "Unknown template part kind.", `${partPath}.kind`));
    }
  });
}

function validateArguments(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  temporaryCount: number,
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Arguments must be an array.", path));
    return;
  }
  value.forEach((argument, index) => {
    const argumentPath = `${path}[${index}]`;
    if (!isRecord(argument)) {
      errors.push(planError("TSC002", "Argument must be an object.", argumentPath));
      return;
    }
    validateSpan(argument.span, `${argumentPath}.span`, errors);
    if (argument.kind === "named") requireString(argument.name, `${argumentPath}.name`, errors);
    else if (argument.kind !== "positional") {
      errors.push(planError("TSC002", "Unknown argument kind.", `${argumentPath}.kind`));
    }
    validateExpression(argument.value, `${argumentPath}.value`, errors, false, temporaryCount);
  });
}

function collectFunctionIds(value: unknown): ReadonlySet<number> {
  if (!Array.isArray(value)) return new Set<number>();
  return new Set(
    value
      .filter(isRecord)
      .map((item) => item.id)
      .filter((id): id is number => Number.isInteger(id) && (id as number) > 0),
  );
}

type InstructionExecutionRegion =
  | {
      readonly kind: "root";
      readonly startInstruction: 0;
      readonly endInstruction: number;
    }
  | {
      readonly kind: "function";
      readonly functionId: number;
      readonly startInstruction: number;
      readonly endInstruction: number;
    };

interface ValidatedFunctionRange {
  readonly definition: Record<string, unknown>;
  readonly path: string;
  readonly id: number;
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
}

function createPlanValidationIndex(
  instructions: readonly unknown[],
  rootEndInstruction: number | null,
  functions: readonly ValidatedFunctionRange[],
): PlanValidationIndex | null {
  recordValidationTestWork("planOwnerIndexBuilds");
  if (rootEndInstruction === null) return null;
  const owners: Array<InstructionExecutionRegion | undefined> = new Array(instructions.length);
  const root: InstructionExecutionRegion = {
    kind: "root",
    startInstruction: 0,
    endInstruction: rootEndInstruction,
  };
  for (let index = 0; index < rootEndInstruction; index += 1) owners[index] = root;
  const functionsById = new Map<number, ValidatedFunctionRange>();
  for (const definition of functions) {
    const region: InstructionExecutionRegion = {
      kind: "function",
      functionId: definition.id,
      startInstruction: definition.entryInstruction,
      endInstruction: definition.endInstruction,
    };
    functionsById.set(definition.id, definition);
    for (let index = definition.entryInstruction; index < definition.endInstruction; index += 1) {
      owners[index] = region;
    }
  }
  return { owners, functionsById };
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
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction) || ![
      "prepareSaySpeaker",
      "prepareSayText",
    ].includes(String(instruction.kind))) return;
    if (!Number.isSafeInteger(instruction.destinationTemporary)) return;
    const temporaryId = instruction.destinationTemporary as number;
    const entries = producers.get(temporaryId) ?? [];
    entries.push(instructionIndex);
    producers.set(temporaryId, entries);
  });

  const consumed = new Set<number>();
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction) || instruction.kind !== "say") return;
    const region = index.owners[instructionIndex];
    if (region === undefined) return;
    const path = `$.instructions[${instructionIndex}]`;
    const speakerTemporary = instruction.speakerTemporary;
    const textTemporary = instruction.textTemporary;
    if (speakerTemporary !== undefined && textTemporary !== undefined && speakerTemporary === textTemporary) {
      errors.push(planError(
        "TSC002",
        "Prepared say speaker and text temporaries must not alias.",
        `${path}.textTemporary`,
      ));
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
      producers,
      consumed,
      errors,
    );
  });

  instructions.forEach((instruction, instructionIndex) => {
    if (
      isRecord(instruction) &&
      (instruction.kind === "prepareSaySpeaker" || instruction.kind === "prepareSayText") &&
      !consumed.has(instructionIndex)
    ) {
      errors.push(planError(
        "TSC002",
        "Prepared say instruction must have one matching consuming say instruction.",
        `$.instructions[${instructionIndex}]`,
      ));
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
  producers: ReadonlyMap<number, readonly number[]>,
  consumed: Set<number>,
  errors: PlanValidationError[],
): void {
  if (!Number.isSafeInteger(temporaryId)) return;
  const candidates = producers.get(temporaryId as number) ?? [];
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
    errors.push(planError(
      "TSC002",
      `Prepared say ${expectedKind === "prepareSaySpeaker" ? "speaker" : "text"} temporary lacks its canonical producer.`,
      producerPath,
    ));
    return;
  }
  if (consumed.has(producerIndex)) {
    errors.push(planError(
      "TSC002",
      "Prepared say producer must not be reused by another say instruction.",
      producerPath,
    ));
    return;
  }
  consumed.add(producerIndex);
  if (preparedSayCanBeBypassed(instructions, index, region, producerIndex, sayIndex)) {
    errors.push(planError(
      "TSC002",
      "Prepared say instruction can be reached while bypassing its required preparation.",
      sayPath,
    ));
  }
}

function preparedSayCanBeBypassed(
  instructions: readonly unknown[],
  index: PlanValidationIndex,
  region: InstructionExecutionRegion,
  producerIndex: number,
  sayIndex: number,
): boolean {
  for (let sourceIndex = region.startInstruction; sourceIndex < producerIndex; sourceIndex += 1) {
    const instruction = instructions[sourceIndex];
    if (!isRecord(instruction) || index.owners[sourceIndex] !== region) continue;
    if (explicitInstructionTargets(instruction).some((target) =>
      typeof target === "number" && Number.isSafeInteger(target) &&
      target > producerIndex && target <= sayIndex
    )) return true;
  }
  return false;
}

function samePreparedSayValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => samePreparedSayValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.hasOwn(right, key) && samePreparedSayValue(left[key], right[key])
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
      if (Number.isSafeInteger(target)) explicitTargets.add(target as number);
    }
  });

  instructions.forEach((instruction, instructionIndex) => {
    if (
      !isRecord(instruction) ||
      instruction.kind !== "interaction" ||
      instruction.interactionKind === "button" ||
      !Number.isSafeInteger(instruction.destinationTemporary)
    ) return;
    const destinationTemporary = instruction.destinationTemporary as number;
    const path = `$.instructions[${instructionIndex}]`;
    const region = index.owners[instructionIndex];
    if (region === undefined) return;

    const destinationProducers = producers.get(destinationTemporary) ?? [];
    if (
      destinationProducers.length !== 1 ||
      destinationProducers[0] !== instructionIndex
    ) {
      errors.push(planError(
        "TSC002",
        "Canonical interaction result destinations must be produced only by their owning interaction.",
        `${path}.destinationTemporary`,
      ));
    }

    const continuation = instructionIndex + 1;
    if (continuation >= region.endInstruction) {
      errors.push(planError(
        "TSC002",
        "Result-bearing interaction requires a local in-region result handoff.",
        path,
      ));
      return;
    }
    if (explicitTargets.has(continuation)) {
      errors.push(planError(
        "TSC002",
        "Interaction result handoff entry must be reachable only from its owning interaction.",
        `$.instructions[${continuation}]`,
      ));
    }

    const handoff = instructions[continuation];
    if (!isRecord(handoff)) return;
    if (
      handoff.kind === "clearTemporary" &&
      handoff.temporaryId === destinationTemporary
    ) return;
    if (handoff.kind === "exit" || handoff.kind === "returnVoid") return;

    if (!canonicalHandoffConsumesTemporary(handoff, destinationTemporary)) {
      errors.push(planError(
        "TSC002",
        "Interaction result handoff must consume the destination immediately.",
        `$.instructions[${continuation}]`,
      ));
      return;
    }
    if (handoff.kind === "returnValue") return;
    if (![
      "declareBinding",
      "assign",
      "evaluate",
      "storeTemporary",
      "say",
      "setDeclaredSpeakerProperty",
      "prepareReference",
    ].includes(String(handoff.kind))) {
      errors.push(planError(
        "TSC002",
        "Interaction result handoff contains a non-canonical intervening instruction.",
        `$.instructions[${continuation}]`,
      ));
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
      errors.push(planError(
        "TSC002",
        "Interaction result handoff must clear its transient destination immediately after transfer.",
        `$.instructions[${clearIndex}]`,
      ));
      return;
    }
    if (explicitTargets.has(clearIndex)) {
      errors.push(planError(
        "TSC002",
        "Interaction result handoff cleanup must not be an independent control-flow target.",
        `$.instructions[${clearIndex}]`,
      ));
    }
  });
}

function producedTemporaryId(instruction: Record<string, unknown>): number | null {
  let value: unknown = null;
  if (instruction.kind === "storeTemporary") {
    value = instruction.temporaryId;
  } else if (
    instruction.kind === "prepareSaySpeaker" ||
    instruction.kind === "prepareSayText"
  ) {
    value = instruction.destinationTemporary;
  } else if (
    instruction.kind === "prepareInteractionSpeaker" ||
    instruction.kind === "prepareReference" ||
    instruction.kind === "callFunction" ||
    instruction.kind === "interaction"
  ) {
    value = instruction.destinationTemporary;
  }
  return Number.isSafeInteger(value) ? value as number : null;
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
    case "declareBinding":
    case "assign":
    case "storeTemporary":
    case "prepareSayText":
    case "say":
    case "setDeclaredSpeakerProperty":
    case "returnValue":
      expression = instruction.value;
      break;
    default:
      expression = undefined;
  }
  return expressionGuaranteesTemporaryEvaluation(expression, temporaryId);
}

function expressionGuaranteesTemporaryEvaluation(
  value: unknown,
  temporaryId: number,
): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "temporary":
      return value.temporaryId === temporaryId;
    case "list":
    case "set":
      return Array.isArray(value.elements) && value.elements.some((item) =>
        expressionGuaranteesTemporaryEvaluation(item, temporaryId)
      );
    case "object":
      return Array.isArray(value.properties) && value.properties.some((property) =>
        isRecord(property) &&
        expressionGuaranteesTemporaryEvaluation(property.value, temporaryId)
      );
    case "group":
      return expressionGuaranteesTemporaryEvaluation(value.expression, temporaryId);
    case "template":
      return Array.isArray(value.parts) && value.parts.some((part) =>
        isRecord(part) &&
        part.kind === "expression" &&
        expressionGuaranteesTemporaryEvaluation(part.expression, temporaryId)
      );
    case "property":
      return expressionGuaranteesTemporaryEvaluation(value.object, temporaryId);
    case "index":
      return expressionGuaranteesTemporaryEvaluation(value.object, temporaryId) ||
        expressionGuaranteesTemporaryEvaluation(value.index, temporaryId);
    case "call": {
      const calleeConsumes =
        isRecord(value.callee) &&
        value.callee.kind === "property" &&
        expressionGuaranteesTemporaryEvaluation(value.callee.object, temporaryId);
      const argumentConsumes = Array.isArray(value.arguments) && value.arguments.some((argument) =>
        isRecord(argument) &&
        expressionGuaranteesTemporaryEvaluation(argument.value, temporaryId)
      );
      return calleeConsumes || argumentConsumes;
    }
    case "unary":
      return expressionGuaranteesTemporaryEvaluation(value.operand, temporaryId);
    case "binary":
      if (value.operator === "and" || value.operator === "or") {
        return expressionGuaranteesTemporaryEvaluation(value.left, temporaryId);
      }
      return expressionGuaranteesTemporaryEvaluation(value.left, temporaryId) ||
        expressionGuaranteesTemporaryEvaluation(value.right, temporaryId);
    case "range":
      return expressionGuaranteesTemporaryEvaluation(value.start, temporaryId) ||
        expressionGuaranteesTemporaryEvaluation(value.end, temporaryId);
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
  const remainsInRegion = region.kind === "root"
    ? target >= region.startInstruction && target <= region.endInstruction
    : target >= region.startInstruction && target < region.endInstruction;
  if (!remainsInRegion) {
    errors.push(planError(
      "TSC002",
      "Control-flow target leaves the instruction's execution region.",
      path,
    ));
  }
}

function validateFunctionDefinitions(
  value: unknown,
  instructions: readonly unknown[],
  rootEndInstruction: number | null,
  errors: PlanValidationError[],
): PlanValidationIndex | null {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Function definitions must be an array.", "$.functions"));
    return createPlanValidationIndex(instructions, rootEndInstruction, []);
  }
  const ids = new Set<number>();
  const names = new Set<string>();
  const validatedRanges: ValidatedFunctionRange[] = [];
  let expectedEntry = rootEndInstruction;
  value.forEach((definition, definitionIndex) => {
    const path = `$.functions[${definitionIndex}]`;
    if (!isRecord(definition)) {
      errors.push(planError("TSC002", "Function definition must be an object.", path));
      return;
    }
    requirePositiveInteger(definition.id, `${path}.id`, errors);
    requireString(definition.name, `${path}.name`, errors);
    validateSpan(definition.declarationSpan, `${path}.declarationSpan`, errors);
    validateSpan(definition.bodySpan, `${path}.bodySpan`, errors);
    if (typeof definition.id === "number") {
      if (ids.has(definition.id)) {
        errors.push(planError("TSC002", "Function IDs must be unique.", `${path}.id`));
      }
      if (definition.id !== definitionIndex + 1) {
        errors.push(planError(
          "TSC002",
          "Function IDs must follow deterministic source order.",
          `${path}.id`,
        ));
      }
      ids.add(definition.id);
    }
    if (typeof definition.name === "string") {
      if (names.has(definition.name)) {
        errors.push(planError("TSC002", "Function names must be unique.", `${path}.name`));
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
      errors.push(planError(
        "TSC002",
        "Function instruction boundaries must be non-negative integers.",
        path,
      ));
      return;
    }
    const [entry, bodyEntry, implicitReturn, end] = points as [
      number,
      number,
      number,
      number,
    ];
    if (
      expectedEntry === null ||
      entry !== expectedEntry ||
      entry >= bodyEntry ||
      bodyEntry > implicitReturn ||
      implicitReturn !== end - 1 ||
      end > instructions.length
    ) {
      errors.push(planError(
        "TSC002",
        "Function instruction range is overlapping or impossible.",
        path,
      ));
      return;
    }
    const functionId = definition.id;
    if (!Number.isSafeInteger(functionId) || (functionId as number) < 1) return;

    const validatedRange: ValidatedFunctionRange = {
      definition,
      path,
      id: functionId as number,
      entryInstruction: entry,
      bodyEntryInstruction: bodyEntry,
      implicitReturnInstruction: implicitReturn,
      endInstruction: end,
    };
    validatedRanges.push(validatedRange);

    const bodyEntryMarker = instructions[bodyEntry - 1];
    if (!isRecord(bodyEntryMarker) || bodyEntryMarker.kind !== "enterFunctionBody") {
      errors.push(planError(
        "TSC002",
        "Function body entry point is invalid.",
        `${path}.bodyEntryInstruction`,
      ));
    }
    const implicitReturnInstruction = instructions[implicitReturn];
    if (!isRecord(implicitReturnInstruction) || implicitReturnInstruction.kind !== "returnVoid") {
      errors.push(planError(
        "TSC002",
        "Function implicit-return boundary is invalid.",
        `${path}.implicitReturnInstruction`,
      ));
    }
    validateFunctionPrologue(validatedRange, instructions, errors);
    expectedEntry = end;
  });
  if (expectedEntry !== null && expectedEntry !== instructions.length) {
    errors.push(planError(
      "TSC002",
      "Function ranges do not cover the non-root instruction region.",
      "$.functions",
    ));
  }

  const index = createPlanValidationIndex(instructions, rootEndInstruction, validatedRanges);
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction)) return;
    const ownerRegion = index?.owners[instructionIndex];
    const owner = ownerRegion?.kind === "function"
      ? index?.functionsById.get(ownerRegion.functionId)
      : undefined;
    const functionOnly = [
      "bindSuppliedParameter",
      "beginFunctionDefaults",
      "prepareParameterDefault",
      "bindDefaultParameter",
      "enterFunctionBody",
      "returnValue",
      "returnVoid",
    ].includes(String(instruction.kind));
    if (functionOnly && owner === undefined) {
      errors.push(planError(
        "TSC002",
        "Function-only instruction appears in root execution.",
        `$.instructions[${instructionIndex}]`,
      ));
    }
    if (
      owner !== undefined &&
      instruction.kind !== "callFunction" &&
      "functionId" in instruction &&
      instruction.functionId !== owner.id
    ) {
      errors.push(planError(
        "TSC002",
        "Function prologue instruction has the wrong function ID.",
        `$.instructions[${instructionIndex}].functionId`,
      ));
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
            errors.push(planError(
              "TSC002",
              "Call refers to an unknown function parameter.",
              `$.instructions[${instructionIndex}].arguments[${argumentIndex}].parameterName`,
            ));
          }
          if (supplied.has(argument.parameterName)) {
            errors.push(planError(
              "TSC002",
              "Call supplies a function parameter more than once.",
              `$.instructions[${instructionIndex}].arguments[${argumentIndex}].parameterName`,
            ));
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
            errors.push(planError(
              "TSC002",
              "Call omits a required function parameter.",
              `$.instructions[${instructionIndex}].arguments[${parameterIndex}]`,
            ));
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
      errors.push(planError(
        "TSC002",
        "Function supplied-parameter prologue is malformed.",
        `${path}.entryInstruction`,
      ));
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
    errors.push(planError(
      "TSC002",
      "Function default-parameter prologue is missing.",
      `${path}.entryInstruction`,
    ));
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
      errors.push(planError(
        "TSC002",
        "Function parameter-default sequence is malformed.",
        `${path}.parameters[${index}]`,
      ));
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
        if (
          nested.functionId !== range.id ||
          nested.parameterIndex !== index
        ) {
          errors.push(planError(
            "TSC002",
            "Default binding does not match its parameter segment.",
            `$.instructions[${instructionIndex}]`,
          ));
        }
        defaultBindings.push(nested);
        continue;
      }
      if (
        ![
          "storeTemporary",
          "prepareReference",
          "clearTemporary",
          "callFunction",
          "validateCallReceiver",
          "jumpIfFalse",
          "jump",
        ].includes(String(nested.kind))
      ) {
        errors.push(planError(
          "TSC002",
          "Function default-expression region contains an invalid instruction.",
          `$.instructions[${instructionIndex}]`,
        ));
      }
      if (
        (nested.kind === "jump" || nested.kind === "jumpIfFalse") &&
        (!validInstructionBoundary(nested.target, instructions.length) ||
          nested.target <= instructionIndex ||
          nested.target > regionEnd)
      ) {
        errors.push(planError(
          "TSC002",
          "Default-expression jump escapes its parameter segment.",
          `$.instructions[${instructionIndex}].target`,
        ));
      }
    }
    if (
      (parameter.hasDefault === true && defaultBindings.length !== 1) ||
      (parameter.hasDefault === false && regionEnd !== regionStart)
    ) {
      errors.push(planError(
        "TSC002",
        "Function parameter default does not match its metadata.",
        `${path}.parameters[${index}]`,
      ));
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
        if (instructionIndex > bindingIndex && nested.kind !== "clearTemporary") {
          errors.push(planError(
            "TSC002",
            "Only temporary cleanup may follow a default binding.",
            `$.instructions[${instructionIndex}]`,
          ));
        }
        if (
          (nested.kind === "jump" || nested.kind === "jumpIfFalse") &&
          validInstructionBoundary(nested.target, instructions.length) &&
          nested.target > bindingIndex
        ) {
          errors.push(planError(
            "TSC002",
            "Default-expression control flow may not bypass its binding.",
            `$.instructions[${instructionIndex}].target`,
          ));
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
    errors.push(planError(
      "TSC002",
      "Function body-entry prologue marker is malformed.",
      `${path}.bodyEntryInstruction`,
    ));
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
    if (isRecord(instruction) && prologueOnly.has(String(instruction.kind))) {
      errors.push(planError(
        "TSC002",
        "Function prologue instruction appears inside the function body.",
        `$.instructions[${instructionIndex}]`,
      ));
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
    requireString(parameter.name, `${parameterPath}.name`, errors);
    if (typeof parameter.name === "string") {
      if (names.has(parameter.name)) {
        errors.push(planError("TSC002", "Function parameter names must be unique.", `${parameterPath}.name`));
      }
      names.add(parameter.name);
    }
    if (parameter.index !== index) {
      errors.push(planError("TSC002", "Function parameter indexes must be contiguous.", `${parameterPath}.index`));
    }
    if (typeof parameter.hasDefault !== "boolean") {
      errors.push(planError("TSC002", "Function parameter default metadata is malformed.", `${parameterPath}.hasDefault`));
    } else {
      if (!parameter.hasDefault && sawDefault) {
        errors.push(planError("TSC002", "Required parameter follows a defaulted parameter.", parameterPath));
      }
      sawDefault ||= parameter.hasDefault;
    }
    validateSpan(parameter.declarationSpan, `${parameterPath}.declarationSpan`, errors);
    if (parameter.hasDefault === true) {
      validateSpan(parameter.defaultSpan, `${parameterPath}.defaultSpan`, errors);
    } else if (parameter.defaultSpan !== null) {
      errors.push(planError("TSC002", "Required parameter must not have a default span.", `${parameterPath}.defaultSpan`));
    }
  });
}

function validatePreparedArguments(
  value: unknown,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Prepared function arguments must be an array.", path));
    return;
  }
  const temporaryIds = new Set<number>();
  value.forEach((argument, index) => {
    const argumentPath = `${path}[${index}]`;
    if (!isRecord(argument)) {
      errors.push(planError("TSC002", "Prepared function argument must be an object.", argumentPath));
      return;
    }
    requireString(argument.parameterName, `${argumentPath}.parameterName`, errors);
    validateTemporaryId(argument.temporaryId, `${argumentPath}.temporaryId`, temporaryCount, errors);
    if (typeof argument.temporaryId === "number") {
      if (temporaryIds.has(argument.temporaryId)) {
        errors.push(planError(
          "TSC002",
          "Prepared function argument temporary IDs must be unique.",
          `${argumentPath}.temporaryId`,
        ));
      }
      temporaryIds.add(argument.temporaryId);
    }
    validateSpan(argument.span, `${argumentPath}.span`, errors);
  });
}

function validateTemporaryId(
  value: unknown,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  if (!positiveSafeInteger(value) || value > temporaryCount) {
    errors.push(planError("TSC002", "Temporary reference is outside the plan's temporary range.", path));
  }
}

function validateFunctionId(
  value: unknown,
  path: string,
  functionIds: ReadonlySet<number>,
  errors: PlanValidationError[],
): void {
  if (!Number.isInteger(value) || !functionIds.has(value as number)) {
    errors.push(planError("TSC002", "Instruction refers to an unknown function ID.", path));
  }
}

function validateSpan(value: unknown, path: string, errors: PlanValidationError[]): void {
  if (!isRecord(value) || !validPosition(value.start) || !validPosition(value.end)) {
    errors.push(planError("TSC002", "Source span is malformed.", path));
    return;
  }
  const start = value.start as { offset: number };
  const end = value.end as { offset: number };
  if (end.offset < start.offset) {
    errors.push(planError("TSC002", "Source span ends before it starts.", path));
  }
}

function validPosition(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonNegativeSafeInteger(value.offset) &&
    nonNegativeSafeInteger(value.line) &&
    nonNegativeSafeInteger(value.column)
  );
}

function validateJumpTarget(
  value: unknown,
  path: string,
  instructionCount: number,
  errors: PlanValidationError[],
): void {
  if (!validInstructionBoundary(value, instructionCount)) {
    errors.push(planError("TSC002", "Jump target is outside the instruction plan.", path));
  }
}

function requireString(value: unknown, path: string, errors: PlanValidationError[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(planError("TSC002", "Expected a non-empty string.", path));
  }
}

function requirePositiveInteger(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    errors.push(planError("TSC002", "Expected a positive integer.", path));
  }
}

function requirePositiveSafeInteger(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!positiveSafeInteger(value)) {
    errors.push(planError("TSC002", "Expected a positive safe integer.", path));
  }
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!nonNegativeInteger(value)) {
    errors.push(planError("TSC002", "Expected a non-negative integer.", path));
  }
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function validInstructionBoundary(
  value: unknown,
  instructionCount: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= instructionCount
  );
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
const binaryOperators = new Set([
  "*", "/", "%", "+", "-", "==", "!=", "<", "<=", ">", ">=", "and", "or",
]);

function planError(
  code: PlanValidationError["code"],
  message: string,
  path: string,
): PlanValidationError {
  return Object.freeze({ code, message, path });
}

function invalidPlan(
  code: PlanValidationError["code"],
  message: string,
  path: string,
): PlanValidationResult {
  return Object.freeze({ valid: false, errors: Object.freeze([planError(code, message, path)]) });
}
