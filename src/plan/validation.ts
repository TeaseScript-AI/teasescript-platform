import {
  boundedInteractionUtf8ByteLength,
  interactionStringHasNonWhitespace,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../interaction-limits.js";
import { recordValidationTestWork } from "../validation-testing.js";
import { INSTRUCTION_PLAN_FORMAT, INSTRUCTION_PLAN_VERSION } from "./model.js";
import {
  analyzeInstructionStream,
  collectFunctionIds,
  expressionMayReferenceTemporary,
} from "./instruction-stream-analyses.js";
import {
  type PlanValidationError,
  hasExactKeys,
  isRecord,
  nonNegativeSafeInteger,
  planError,
  positiveSafeInteger,
  requireString,
  validateSpan,
  validInstructionBoundary,
} from "./validation-support.js";
import {
  captureFailureValidation,
  capturePlanData,
  isPlanCaptureFailure,
} from "./capture-support.js";

export type { PlanValidationError } from "./validation-support.js";

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

export function validateCapturedInstructionPlan(value: unknown): PlanValidationResult {
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
  const temporaryCount = nonNegativeSafeInteger(value.temporaryCount) ? value.temporaryCount : -1;
  if (temporaryCount < 0) {
    errors.push(
      planError(
        "TSC002",
        "temporaryCount must be a non-negative safe integer.",
        "$.temporaryCount",
      ),
    );
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
      errors.push(
        planError("TSC002", "Root execution boundary is invalid.", "$.rootEndInstruction"),
      );
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
    analyzeInstructionStream(value.instructions, value.functions, rootEndInstruction, errors);
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
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
      validateExpression(value.expression, `${path}.expression`, errors, false, temporaryCount);
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
        errors.push(
          planError(
            "TSC002",
            "Temporary boolean expectation must be boolean.",
            `${path}.expectBoolean`,
          ),
        );
      }
      return;
    case "prepareSaySpeaker":
      if (!hasExactKeys(value, ["kind", "speaker", "destinationTemporary", "span"])) {
        errors.push(
          planError(
            "TSC002",
            "Prepared say speaker instruction contains unsupported fields.",
            path,
          ),
        );
      }
      if (value.speaker !== null) requireString(value.speaker, `${path}.speaker`, errors);
      validateTemporaryId(
        value.destinationTemporary,
        `${path}.destinationTemporary`,
        temporaryCount,
        errors,
      );
      return;
    case "prepareSayContextualSpeaker":
      if (!hasExactKeys(value, ["kind", "speakerTemporary", "destinationTemporary", "span"])) {
        errors.push(
          planError(
            "TSC002",
            "Prepared say contextual speaker instruction contains unsupported fields.",
            path,
          ),
        );
      }
      validateTemporaryId(
        value.speakerTemporary,
        `${path}.speakerTemporary`,
        temporaryCount,
        errors,
      );
      validateTemporaryId(
        value.destinationTemporary,
        `${path}.destinationTemporary`,
        temporaryCount,
        errors,
      );
      if (value.speakerTemporary === value.destinationTemporary) {
        errors.push(
          planError(
            "TSC002",
            "Prepared say contextual speaker must not alias its output speaker.",
            `${path}.destinationTemporary`,
          ),
        );
      }
      return;
    case "prepareSayText":
      if (!hasExactKeys(value, ["kind", "value", "destinationTemporary", "span"])) {
        errors.push(
          planError("TSC002", "Prepared say text instruction contains unsupported fields.", path),
        );
      }
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      validateTemporaryId(
        value.destinationTemporary,
        `${path}.destinationTemporary`,
        temporaryCount,
        errors,
      );
      return;
    case "prepareInteractionSpeaker":
      if (!hasExactKeys(value, ["kind", "speaker", "destinationTemporary", "span"])) {
        errors.push(
          planError(
            "TSC002",
            "Prepared interaction speaker instruction contains unsupported fields.",
            path,
          ),
        );
      }
      if (value.speaker !== null) requireString(value.speaker, `${path}.speaker`, errors);
      validateTemporaryId(
        value.destinationTemporary,
        `${path}.destinationTemporary`,
        temporaryCount,
        errors,
      );
      return;
    case "clearTemporary":
      validateTemporaryId(value.temporaryId, `${path}.temporaryId`, temporaryCount, errors);
      return;
    case "clearTemporaries":
      validateTemporaryIds(value.temporaryIds, `${path}.temporaryIds`, temporaryCount, errors);
      return;
    case "callFunction":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      validateCallArguments(value.arguments, `${path}.arguments`, temporaryCount, errors);
      validateTemporaryId(
        value.destinationTemporary,
        `${path}.destinationTemporary`,
        temporaryCount,
        errors,
      );
      if (
        Number.isInteger(value.destinationTemporary) &&
        Array.isArray(value.arguments) &&
        value.arguments.some(
          (argument) =>
            isRecord(argument) &&
            expressionMayReferenceTemporary(
              argument.value,
              // EVIDENCE: validation: the enclosing condition checked destinationTemporary before this callback.
              value.destinationTemporary as number,
            ),
        )
      ) {
        errors.push(
          planError(
            "TSC002",
            "Function result destination must not alias an argument temporary.",
            `${path}.destinationTemporary`,
          ),
        );
      }
      validateJumpTarget(
        value.returnInstruction,
        `${path}.returnInstruction`,
        instructionCount,
        errors,
      );
      if (value.returnInstruction !== instructionIndex + 1) {
        errors.push(
          planError(
            "TSC002",
            "Function return target must be the instruction after the call.",
            `${path}.returnInstruction`,
          ),
        );
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
        errors.push(
          planError("TSC002", "Parameter-default target must move forward.", `${path}.target`),
        );
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
      if (value.speakerTemporary !== undefined)
        validateTemporaryId(
          value.speakerTemporary,
          `${path}.speakerTemporary`,
          temporaryCount,
          errors,
        );
      if (value.contextualSpeakerTemporary !== undefined)
        validateTemporaryId(
          value.contextualSpeakerTemporary,
          `${path}.contextualSpeakerTemporary`,
          temporaryCount,
          errors,
        );
      if (value.textTemporary !== undefined)
        validateTemporaryId(value.textTemporary, `${path}.textTemporary`, temporaryCount, errors);
      if (
        value.skipPolicy !== null &&
        value.skipPolicy !== "skippable" &&
        value.skipPolicy !== "unskippable"
      ) {
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
    ? [
        "kind",
        "interactionKind",
        "target",
        "speakerTemporary",
        "destinationTemporary",
        "expectedResult",
        "preparedUi",
        "span",
      ]
    : [
        "kind",
        "interactionKind",
        "target",
        "speaker",
        "destinationTemporary",
        "expectedResult",
        "ui",
        "span",
      ];
  if (!hasExactKeys(value, expectedKeys)) {
    errors.push(planError("TSC002", "Interaction instruction contains unsupported fields.", path));
  }
  const kind = value.interactionKind;
  if (!["button", "text", "number", "choice"].includes(String(kind))) {
    errors.push(planError("TSC002", "Interaction kind is invalid.", `${path}.interactionKind`));
  }
  if (value.target !== "standardChat")
    errors.push(planError("TSC002", "Interaction target is invalid.", `${path}.target`));

  const ui = prepared ? value.preparedUi : value.ui;
  const labelType = isRecord(ui) && ui.kind === "choice" ? ui.labelType : undefined;
  const expected =
    kind === "button"
      ? "none"
      : kind === "number" || (kind === "choice" && labelType === "number")
        ? "number"
        : "string";
  if (value.expectedResult !== expected) {
    errors.push(
      planError(
        "TSC002",
        "Interaction result domain does not match its kind.",
        `${path}.expectedResult`,
      ),
    );
  }
  if (kind === "button") {
    if (value.destinationTemporary !== null) {
      errors.push(
        planError(
          "TSC002",
          "Button interaction must not have a result destination.",
          `${path}.destinationTemporary`,
        ),
      );
    }
  } else {
    validateTemporaryId(
      value.destinationTemporary,
      `${path}.destinationTemporary`,
      temporaryCount,
      errors,
    );
  }

  if (prepared) {
    validateTemporaryId(value.speakerTemporary, `${path}.speakerTemporary`, temporaryCount, errors);
    if (value.destinationTemporary === value.speakerTemporary) {
      errors.push(
        planError(
          "TSC002",
          "Interaction result destination must not alias its prepared speaker temporary.",
          `${path}.destinationTemporary`,
        ),
      );
    }
    validatePreparedInteractionUi(
      kind,
      ui,
      `${path}.preparedUi`,
      temporaryCount,
      value.speakerTemporary,
      value.destinationTemporary,
      errors,
    );
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
  const uiKeys =
    kind === "button"
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
        errors.push(
          planError(
            "TSC002",
            "Interaction text exceeds the remaining aggregate UTF-8 byte limit.",
            fieldPath,
          ),
        );
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
      errors.push(
        planError(
          "TSC002",
          "Interaction text exceeds the remaining aggregate UTF-8 byte limit.",
          fieldPath,
        ),
      );
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
    if (
      !Array.isArray(ui.options) ||
      ui.options.length === 0 ||
      ui.options.length > MAX_INTERACTION_OPTION_ENTRIES
    ) {
      errors.push(
        planError(
          "TSC002",
          "Choice options exceed the shared collection boundary or are empty.",
          `${path}.options`,
        ),
      );
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
          errors.push(
            planError("TSC002", "Choice option contains unsupported fields.", optionPath),
          );
        }
        const textValid = countString(option.text, `${optionPath}.text`);
        const label = option.label;
        const validLabel =
          labelType === "none"
            ? label === null
            : labelType === "identifier"
              ? typeof label === "string" &&
                countString(label, `${optionPath}.label`) &&
                (measurementExhausted || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(label))
              : typeof label === "number" && Number.isFinite(label) && !Object.is(label, -0);
        if (!validLabel) {
          errors.push(
            planError(
              "TSC002",
              "Choice option label does not match the choice label type.",
              `${optionPath}.label`,
            ),
          );
        }
        if (
          !measurementExhausted &&
          validLabel &&
          (typeof label === "string" || typeof label === "number")
        ) {
          if (labels.has(label)) {
            errors.push(
              planError("TSC002", "Choice labels must be unique.", `${optionPath}.label`),
            );
          }
          labels.add(label);
        }
        if (!measurementExhausted && textValid && labelType === "none") {
          // EVIDENCE: validation: textValid records the option text string check above.
          if (visible.has(option.text as string)) {
            errors.push(
              planError("TSC002", "Unlabelled choice text must be unique.", `${optionPath}.text`),
            );
          }
          // EVIDENCE: validation: textValid records the option text string check above.
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
    errors.push(
      planError("TSC002", "Prepared interaction UI payload does not match its kind.", path),
    );
    return;
  }
  const keys =
    kind === "button"
      ? ["kind", "buttonLabelTemporary", "accessibleName"]
      : kind === "text" || kind === "number"
        ? ["kind", "hintTemporary", "accessibleName"]
        : ["kind", "labelType", "optionsTemporary", "optionCount", "labels", "accessibleName"];
  if (!hasExactKeys(ui, keys)) {
    errors.push(
      planError("TSC002", "Prepared interaction UI payload contains unsupported fields.", path),
    );
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
        errors.push(
          planError(
            "TSC002",
            "Interaction text exceeds the remaining aggregate UTF-8 byte limit.",
            fieldPath,
          ),
        );
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
      errors.push(
        planError(
          "TSC002",
          "Interaction text exceeds the remaining aggregate UTF-8 byte limit.",
          fieldPath,
        ),
      );
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
        errors.push(
          planError(
            "TSC002",
            "Prepared interaction temporaries must be pairwise distinct.",
            fieldPath,
          ),
        );
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
  // EVIDENCE: validation: the first condition checks optionCount with Number.isSafeInteger before the lower-bound comparison.
  // EVIDENCE: validation: the first condition checks optionCount with Number.isSafeInteger before the upper-bound comparison.
  if (
    !Number.isSafeInteger(ui.optionCount) ||
    (ui.optionCount as number) < 1 ||
    (ui.optionCount as number) > MAX_INTERACTION_OPTION_ENTRIES
  ) {
    errors.push(
      planError(
        "TSC002",
        "Prepared choice option count exceeds the shared collection boundary or is empty.",
        `${path}.optionCount`,
      ),
    );
  }
  if (ui.labelType === "none") {
    if (ui.labels !== null) {
      errors.push(
        planError("TSC002", "Unlabelled prepared choice must not carry labels.", `${path}.labels`),
      );
    }
    return;
  }
  if (!Array.isArray(ui.labels) || ui.labels.length !== ui.optionCount) {
    errors.push(
      planError("TSC002", "Prepared choice labels must match the option count.", `${path}.labels`),
    );
    return;
  }
  const labels = new Set<string | number>();
  for (let index = 0; index < ui.labels.length; index += 1) {
    const label = ui.labels[index];
    const labelPath = `${path}.labels[${index}]`;
    const valid =
      ui.labelType === "identifier"
        ? countString(label, labelPath) && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(label)
        : typeof label === "number" && Number.isFinite(label) && !Object.is(label, -0);
    if (!valid) {
      errors.push(
        planError("TSC002", "Prepared choice label does not match the label type.", labelPath),
      );
    }
    if ((typeof label === "string" || typeof label === "number") && labels.has(label)) {
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
  if (
    !isRecord(accessible) ||
    (accessible.kind !== "text" && accessible.kind !== "localizedDefault")
  ) {
    errors.push(planError("TSC002", "Interaction accessible name is invalid.", path));
    return;
  }
  if (accessible.kind === "text") {
    if (!hasExactKeys(accessible, ["kind", "text"])) {
      errors.push(
        planError("TSC002", "Interaction accessible name contains unsupported fields.", path),
      );
    }
    if (
      countString(accessible.text, `${path}.text`) &&
      !measurementExhausted &&
      !interactionStringHasNonWhitespace(accessible.text)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Explicit interaction accessible name must contain a non-whitespace character.",
          `${path}.text`,
        ),
      );
    }
    return;
  }
  if (!hasExactKeys(accessible, ["kind", "key"])) {
    errors.push(
      planError("TSC002", "Interaction accessible name contains unsupported fields.", path),
    );
  }
  const expectedKey =
    kind === "button"
      ? "continue"
      : kind === "number"
        ? "number"
        : kind === "choice"
          ? "chooseOption"
          : "answer";
  if (accessible.key !== expectedKey) {
    errors.push(
      planError(
        "TSC002",
        "Interaction localized accessible-name key does not match its kind.",
        `${path}.key`,
      ),
    );
  }
}

type ExpressionValidationWork =
  | { value: unknown; path: string; assignmentTarget: boolean }
  | { kind: "property"; value: unknown; path: string }
  | { kind: "span"; value: unknown; path: string };

function validateExpression(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  assignmentTarget = false,
  temporaryCount = -1,
): void {
  const pending: ExpressionValidationWork[] = [{ value, path, assignmentTarget }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) return;
    if ("kind" in current) {
      if (current.kind === "span") validateSpan(current.value, current.path, errors);
      else if (!isRecord(current.value))
        errors.push(planError("TSC002", "Property must be an object.", current.path));
      else {
        requireString(current.value.name, `${current.path}.name`, errors);
        pending.push({ kind: "span", value: current.value.span, path: `${current.path}.span` });
        pending.push({
          value: current.value.value,
          path: `${current.path}.value`,
          assignmentTarget: false,
        });
      }
      continue;
    }
    validateExpressionNode(
      current.value,
      current.path,
      errors,
      current.assignmentTarget,
      temporaryCount,
      pending,
    );
  }
}

function validateExpressionNode(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  assignmentTarget: boolean,
  temporaryCount: number,
  pending: ExpressionValidationWork[],
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
        errors.push(
          planError("TSC002", "Literal value must be a finite JSON scalar.", `${path}.value`),
        );
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
    case "set": {
      const elementsPath = `${path}.elements`;
      if (!Array.isArray(value.elements)) {
        errors.push(planError("TSC002", "Expression list must be an array.", elementsPath));
        return;
      }
      for (let index = value.elements.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: value.elements[index],
          path: `${elementsPath}[${index}]`,
          assignmentTarget: false,
        });
      }
      return;
    }
    case "object":
      if (!Array.isArray(value.properties))
        errors.push(planError("TSC002", "Properties must be an array.", `${path}.properties`));
      else
        for (let index = value.properties.length - 1; index >= 0; index -= 1)
          pending.push({
            kind: "property",
            value: value.properties[index],
            path: `${path}.properties[${index}]`,
          });
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
      pending.push(
        { value: value.right, path: `${path}.right`, assignmentTarget: false },
        { value: value.left, path: `${path}.left`, assignmentTarget: false },
      );
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
      errors.push(
        planError(
          "TSC002",
          "Assignment receivers must be captured before the right-hand value.",
          `${path}.object`,
        ),
      );
    }
    return;
  }
  if (value.kind === "index") {
    if (!isRecord(value.index) || value.index.kind !== "temporary") {
      errors.push(
        planError(
          "TSC002",
          "Assignment indexes must be prepared in a temporary before the right-hand value.",
          `${path}.index`,
        ),
      );
    }
    if (!isRecord(value.object) || value.object.kind !== "preparedReference") {
      errors.push(
        planError(
          "TSC002",
          "Assignment receivers must be captured before the right-hand value.",
          `${path}.object`,
        ),
      );
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

function validateCallArguments(
  value: unknown,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Function arguments must be an array.", path));
    return;
  }
  value.forEach((argument, index) => {
    const argumentPath = `${path}[${index}]`;
    if (!isRecord(argument)) {
      errors.push(planError("TSC002", "Function argument must be an object.", argumentPath));
      return;
    }
    if (!hasExactKeys(argument, ["parameterName", "value", "span"])) {
      errors.push(
        planError("TSC002", "Function argument contains unsupported fields.", argumentPath),
      );
    }
    requireString(argument.parameterName, `${argumentPath}.parameterName`, errors);
    validateExpression(argument.value, `${argumentPath}.value`, errors, false, temporaryCount);
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
    errors.push(
      planError("TSC002", "Temporary reference is outside the plan's temporary range.", path),
    );
  }
}

function validateTemporaryIds(
  value: unknown,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(planError("TSC002", "Temporary ID list must be a non-empty array.", path));
    return;
  }
  const seen = new Set<number>();
  value.forEach((temporaryId, index) => {
    validateTemporaryId(temporaryId, `${path}[${index}]`, temporaryCount, errors);
    if (typeof temporaryId !== "number") return;
    if (seen.has(temporaryId)) {
      errors.push(
        planError("TSC002", "Temporary ID list must not contain duplicates.", `${path}[${index}]`),
      );
    }
    seen.add(temporaryId);
  });
}

function validateFunctionId(
  value: unknown,
  path: string,
  functionIds: ReadonlySet<number>,
  errors: PlanValidationError[],
): void {
  // EVIDENCE: validation: Number.isInteger establishes the numeric function ID before lookup.
  if (!Number.isInteger(value) || !functionIds.has(value as number)) {
    errors.push(planError("TSC002", "Instruction refers to an unknown function ID.", path));
  }
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

function nonNegativeInteger(value: unknown): value is number {
  // EVIDENCE: validation: Number.isInteger establishes the numeric value before comparison.
  return Number.isInteger(value) && (value as number) >= 0;
}

const binaryOperators = new Set([
  "*",
  "/",
  "%",
  "+",
  "-",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "and",
  "or",
]);

function invalidPlan(
  code: PlanValidationError["code"],
  message: string,
  path: string,
): PlanValidationResult {
  return Object.freeze({ valid: false, errors: Object.freeze([planError(code, message, path)]) });
}
