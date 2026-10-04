import { isStoredDurationRecord } from "../duration.js";
import { isNormalizedOpaqueColor } from "../color.js";
import { isInteractionChoiceValue } from "../choice-values.js";
import { isValidInteractionPrefill } from "../interaction-answers.js";
import {
  boundedInteractionUtf8ByteLength,
  interactionStringHasNonWhitespace,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../interaction-limits.js";
import { recordValidationTestWork } from "../validation-testing.js";
import { compareProjectPaths, MAIN_FILE_PATH, packagePathProblem } from "../project-paths.js";
import { INSTRUCTION_PLAN_FORMAT, INSTRUCTION_PLAN_VERSION } from "./model.js";
import {
  type PlanFileBoundaries,
  analyzeInstructionStream,
  collectFunctionIds,
  expressionMayReferenceTemporary,
} from "./instruction-stream-analyses.js";
import {
  type PlanValidationError,
  hasExactKeys,
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
  // After the revision checks, so another revision's fields report that revision as unsupported first.
  rejectUnknownFields(value, PLAN_FIELDS, "$", errors);
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
    const files = validatePlanFiles(value.files, value.instructions.length, errors);
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
    analyzeInstructionStream(value.instructions, value.functions, files, errors);
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

const PLAN_FIELDS = ["format", "version", "files", "temporaryCount", "functions", "instructions"];

const PROPERTY_FIELDS = ["name", "value", "span"];

const FILE_FIELDS = [
  "path",
  "sourceSpan",
  "startInstruction",
  "rootEndInstruction",
  "endInstruction",
];

/**
 * Checks the file table: `main.tease` first, the other package paths in order, and blocks that cover the instruction
 * stream one after another. Returns the boundaries for the stream analyses, or `null` when they are unusable.
 */
function validatePlanFiles(
  value: unknown,
  instructionCount: number,
  errors: PlanValidationError[],
): PlanFileBoundaries[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(planError("TSC002", "Plan files must be a non-empty array.", "$.files"));
    return null;
  }
  const boundaries: PlanFileBoundaries[] = [];
  let expectedStart = 0;
  let previousPath: string | null = null;
  value.forEach((file: unknown, fileIndex) => {
    const path = `$.files[${fileIndex}]`;
    if (!isRecord(file)) {
      errors.push(planError("TSC002", "Plan file must be an object.", path));
      expectedStart = -1;
      return;
    }
    rejectUnknownFields(file, FILE_FIELDS, path, errors);
    validateSpan(file.sourceSpan, `${path}.sourceSpan`, errors);
    if (
      typeof file.path !== "string" ||
      packagePathProblem(file.path) !== null ||
      (fileIndex === 0
        ? file.path !== MAIN_FILE_PATH
        : previousPath === null || compareProjectPaths(previousPath, file.path) >= 0)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Plan file paths must be package paths: main.tease first, then the others in order.",
          `${path}.path`,
        ),
      );
    }
    previousPath = typeof file.path === "string" ? file.path : null;
    const { startInstruction: start, rootEndInstruction: rootEnd, endInstruction: end } = file;
    if (
      !validInstructionBoundary(start, instructionCount) ||
      !validInstructionBoundary(rootEnd, instructionCount) ||
      !validInstructionBoundary(end, instructionCount) ||
      start !== expectedStart ||
      rootEnd < start ||
      end < rootEnd
    ) {
      errors.push(planError("TSC002", "Plan file instruction range is impossible.", path));
      expectedStart = -1;
      return;
    }
    boundaries.push({ startInstruction: start, rootEndInstruction: rootEnd, endInstruction: end });
    expectedStart = end;
  });
  if (expectedStart !== instructionCount) {
    if (expectedStart >= 0) {
      errors.push(
        planError("TSC002", "Plan files do not cover the instruction stream.", "$.files"),
      );
    }
    return null;
  }
  return boundaries;
}

/** Fields of instruction kinds whose case in validateInstruction does not already require exact keys. */
const INSTRUCTION_FIELDS = fieldsByKind([
  ["declareSpeaker", "name", "properties"],
  ["setDeclaredSpeakerProperty", "speaker", "name", "value"],
  ["setDefaultSpeaker", "name"],
  ["enterScope"],
  ["leaveScope"],
  ["exit"],
  ["declareBinding", "name", "value", "typeCheck"],
  ["prepareReference", "expression", "destinationTemporary"],
  ["validateAssignmentTarget", "target"],
  ["assign", "target", "value", "typeCheck"],
  ["validateCallReceiver", "receiver", "method"],
  ["evaluate", "expression"],
  ["jumpIfFalse", "condition", "target"],
  ["jump", "target"],
  ["loopStart", "loopKind", "loopId", "expression", "continueTarget", "target"],
  ["loopControl", "action", "loopId", "target"],
  ["storeTemporary", "temporaryId", "value", "expectBoolean"],
  ["clearTemporary", "temporaryId"],
  ["clearTemporaries", "temporaryIds"],
  ["callFunction", "functionId", "arguments", "destinationTemporary", "returnInstruction"],
  ["bindSuppliedParameter", "functionId", "parameterIndex"],
  ["beginFunctionDefaults", "functionId"],
  ["prepareParameterDefault", "functionId", "parameterIndex", "target"],
  ["bindDefaultParameter", "functionId", "parameterIndex", "value", "typeCheck"],
  ["enterFunctionBody", "functionId"],
  ["returnValue", "value", "typeCheck"],
  ["returnVoid"],
  [
    "say",
    "presentation",
    "speaker",
    "value",
    "speakerTemporary",
    "contextualSpeakerTemporary",
    "textTemporary",
    "skipPolicy",
    "pacing",
  ],
]);

const FOR_LOOP_START_FIELDS = [
  "kind",
  "span",
  "loopKind",
  "loopId",
  "variable",
  "expression",
  "continueTarget",
  "target",
];

/** Fields of expression kinds whose case in validateExpressionNode does not already require exact keys. */
const EXPRESSION_FIELDS = fieldsByKind([
  ["literal", "value"],
  ["identifier", "name"],
  ["temporary", "temporaryId"],
  ["preparedReference", "temporaryId"],
  ["list", "elements"],
  ["set", "elements"],
  ["object", "properties"],
  ["dict", "entries"],
  ["group", "expression"],
  ["template", "parts"],
  ["property", "object", "name"],
  ["index", "object", "index"],
  ["call", "callee", "arguments", "typeCheck"],
  ["unary", "operator", "operand"],
  ["typeTest", "value", "type", "negated"],
  ["binary", "operator", "left", "right"],
  ["range", "start", "end", "inclusive"],
]);

function fieldsByKind(
  entries: readonly (readonly [kind: string, ...fields: string[]])[],
): ReadonlyMap<string, readonly string[]> {
  return new Map(entries.map(([kind, ...fields]) => [kind, ["kind", "span", ...fields]]));
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
  const fields =
    value.kind === "loopStart" && value.loopKind === "for"
      ? FOR_LOOP_START_FIELDS
      : INSTRUCTION_FIELDS.get(value.kind);
  if (fields !== undefined) rejectUnknownFields(value, fields, path, errors);
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
      validateOptionalTypeCheck(value, path, errors);
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
      validateOptionalTypeCheck(value, path, errors);
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
      if (!isOneOf(value.loopKind, ["repeat", "for", "while"])) {
        errors.push(planError("TSC002", "Invalid loop kind.", `${path}.loopKind`));
      }
      requirePositiveSafeInteger(value.loopId, `${path}.loopId`, errors);
      if (value.loopKind === "for") requireString(value.variable, `${path}.variable`, errors);
      validateExpression(value.expression, `${path}.expression`, errors, false, temporaryCount);
      validateJumpTarget(value.continueTarget, `${path}.continueTarget`, instructionCount, errors);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "loopControl":
      if (!isOneOf(value.action, ["break", "continue"])) {
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
      validateOptionalTypeCheck(value, path, errors);
      return;
    case "returnValue":
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      validateOptionalTypeCheck(value, path, errors);
      return;
    case "returnVoid":
      return;
    case "say":
      if (value.presentation !== null)
        validateExpression(
          value.presentation,
          `${path}.presentation`,
          errors,
          false,
          temporaryCount,
        );
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
      if (
        !hasExactKeys(value, ["kind", "command", "duration", "unit", "display", "label", "span"])
      ) {
        errors.push(planError("TSC002", "Wait instruction has an invalid shape.", path));
      }
      validateDurationUnit(value.unit, `${path}.unit`, errors);
      if (value.command !== "wait" && value.command !== "timer") {
        errors.push(planError("TSC002", "Wait command is invalid.", `${path}.command`));
      } else if (value.command === "wait" && (value.display !== "hidden" || value.label !== null)) {
        errors.push(planError("TSC002", "A wait is hidden and unlabeled.", path));
      }
      if (!isDelayDisplay(value.display)) {
        if (value.command === "timer") {
          validateExpression(value.display, `${path}.display`, errors, false, temporaryCount);
        } else {
          errors.push(planError("TSC002", "Wait display is invalid.", `${path}.display`));
        }
      }
      validateExpression(value.duration, `${path}.duration`, errors, false, temporaryCount);
      if (value.label !== null) {
        validateExpression(value.label, `${path}.label`, errors, false, temporaryCount);
      }
      return;
    case "startTimer":
      if (
        !hasExactKeys(value, [
          "kind",
          "duration",
          "unit",
          "display",
          "label",
          "repeat",
          "persist",
          "handlerFunctionId",
          "destinationTemporary",
          "span",
        ]) ||
        typeof value.repeat !== "boolean" ||
        typeof value.persist !== "boolean"
      ) {
        errors.push(planError("TSC002", "Start-timer instruction has an invalid shape.", path));
      }
      validateDurationUnit(value.unit, `${path}.unit`, errors);
      validateExpression(value.duration, `${path}.duration`, errors, false, temporaryCount);
      if (!isDelayDisplay(value.display)) {
        validateExpression(value.display, `${path}.display`, errors, false, temporaryCount);
      }
      if (value.label !== null) {
        validateExpression(value.label, `${path}.label`, errors, false, temporaryCount);
      }
      if (value.handlerFunctionId !== null) {
        validateFunctionId(
          value.handlerFunctionId,
          `${path}.handlerFunctionId`,
          functionIds,
          errors,
        );
      }
      if (value.destinationTemporary !== null) {
        validateTemporaryId(
          value.destinationTemporary,
          `${path}.destinationTemporary`,
          temporaryCount,
          errors,
        );
      }
      return;
    case "pacingBarrier":
      if (!hasExactKeys(value, ["kind", "receiver", "span"])) {
        errors.push(planError("TSC002", "Pacing-barrier instruction has an invalid shape.", path));
      }
      if (value.receiver !== null) {
        validateExpression(value.receiver, `${path}.receiver`, errors, false, temporaryCount);
        if (!isBarrierReceiver(value.receiver)) {
          errors.push(
            planError(
              "TSC002",
              "A pacing-barrier receiver must be a prepared value or an identifier with property or simple index access.",
              `${path}.receiver`,
            ),
          );
        }
      }
      return;
    case "showImage":
      if (!hasExactKeys(value, ["kind", "image", "span"])) {
        errors.push(planError("TSC002", "Show-image instruction has an invalid shape.", path));
      }
      if (value.image !== null) {
        validateExpression(value.image, `${path}.image`, errors, false, temporaryCount);
      }
      return;
    case "storageWrite":
      if (!hasExactKeys(value, ["kind", "value", "key", "span"])) {
        errors.push(planError("TSC002", "Storage-write instruction has an invalid shape.", path));
      }
      if (value.value !== null) {
        validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      }
      validateExpression(value.key, `${path}.key`, errors, false, temporaryCount);
      return;
    case "playMedia":
      validatePlayMediaInstruction(value, path, temporaryCount, functionIds, errors);
      return;
    case "interaction":
      validateInteractionInstruction(value, path, temporaryCount, errors);
      return;
    default:
      errors.push(planError("TSC002", `Unknown instruction kind '${value.kind}'.`, `${path}.kind`));
  }
}

/**
 * The receiver shapes the compiler emits: an identifier, temporary, or prepared reference, with property access or
 * literal/identifier indexes.
 */
function isBarrierReceiver(value: unknown): boolean {
  let current = value;
  for (;;) {
    if (!isRecord(current)) return false;
    if (
      current.kind === "identifier" ||
      current.kind === "temporary" ||
      current.kind === "preparedReference"
    )
      return true;
    if (current.kind === "property") {
      current = current.object;
    } else if (current.kind === "index") {
      const index = current.index;
      if (!isRecord(index) || (index.kind !== "literal" && index.kind !== "identifier"))
        return false;
      current = current.object;
    } else {
      return false;
    }
  }
}

function validatePlayMediaInstruction(
  value: Record<string, unknown>,
  path: string,
  temporaryCount: number,
  functionIds: ReadonlySet<number>,
  errors: PlanValidationError[],
): void {
  if (
    !hasExactKeys(value, [
      "kind",
      "media",
      "async",
      "file",
      "repeat",
      "startAt",
      "endAt",
      "volume",
      "cues",
      "finishFunctionId",
      "destinationTemporary",
      "span",
    ]) ||
    (value.media !== "audio" && value.media !== "video") ||
    typeof value.async !== "boolean" ||
    (value.destinationTemporary !== null && value.async !== true)
  ) {
    errors.push(planError("TSC002", "Play-media instruction has an invalid shape.", path));
  }
  validateExpression(value.file, `${path}.file`, errors, false, temporaryCount);
  const repeat = value.repeat;
  if (!isRecord(repeat)) {
    errors.push(planError("TSC002", "Media repeat is invalid.", `${path}.repeat`));
  } else if (repeat.kind === "once" || repeat.kind === "indefinite") {
    if (
      !hasExactKeys(repeat, ["kind"]) ||
      (repeat.kind === "indefinite" && (value.async !== true || value.finishFunctionId !== null))
    ) {
      errors.push(planError("TSC002", "Media repeat is invalid.", `${path}.repeat`));
    }
  } else if (repeat.kind === "value" && hasExactKeys(repeat, ["kind", "value"])) {
    validateExpression(repeat.value, `${path}.repeat.value`, errors, false, temporaryCount);
  } else if (repeat.kind === "times" && hasExactKeys(repeat, ["kind", "count"])) {
    validateExpression(repeat.count, `${path}.repeat.count`, errors, false, temporaryCount);
  } else {
    errors.push(planError("TSC002", "Media repeat is invalid.", `${path}.repeat`));
  }
  for (const name of ["startAt", "endAt", "volume"] as const) {
    if (value[name] !== null) {
      validateExpression(value[name], `${path}.${name}`, errors, false, temporaryCount);
    }
  }
  if (!Array.isArray(value.cues)) {
    errors.push(planError("TSC002", "Media cues must be an array.", `${path}.cues`));
  } else {
    value.cues.forEach((cue: unknown, index) => {
      const cuePath = `${path}.cues[${index}]`;
      if (
        !isRecord(cue) ||
        !hasExactKeys(cue, ["kind", "offset", "functionId"]) ||
        (cue.kind !== "at" && cue.kind !== "beforeEnd")
      ) {
        errors.push(planError("TSC002", "Media cue has an invalid shape.", cuePath));
        return;
      }
      validateExpression(cue.offset, `${cuePath}.offset`, errors, false, temporaryCount);
      validateFunctionId(cue.functionId, `${cuePath}.functionId`, functionIds, errors);
    });
  }
  if (value.finishFunctionId !== null) {
    validateFunctionId(value.finishFunctionId, `${path}.finishFunctionId`, functionIds, errors);
  }
  if (value.destinationTemporary !== null) {
    validateTemporaryId(
      value.destinationTemporary,
      `${path}.destinationTemporary`,
      temporaryCount,
      errors,
    );
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
  if (!isOneOf(kind, ["button", "text", "number", "choice", "temporal"])) {
    errors.push(planError("TSC002", "Interaction kind is invalid.", `${path}.interactionKind`));
  }
  if (value.target !== "standardChat")
    errors.push(planError("TSC002", "Interaction target is invalid.", `${path}.target`));

  const ui = prepared ? value.preparedUi : value.ui;
  const expected =
    kind === "button"
      ? value.destinationTemporary === null
        ? "none"
        : "duration"
      : kind === "number"
        ? "number"
        : kind === "choice"
          ? "choice"
          : kind === "temporal"
            ? "temporal"
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
  if (kind !== "button" || value.destinationTemporary !== null) {
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
      ? ["kind", "buttonLabel", "accessibleName", ...("background" in ui ? ["background"] : [])]
      : kind === "text" || kind === "number" || kind === "temporal"
        ? [
            "kind",
            "hint",
            "accessibleName",
            ...("prefill" in ui ? ["prefill"] : []),
            ...(kind === "number" && "integer" in ui ? ["integer"] : []),
            ...(kind === "temporal" ? ["temporalKind"] : []),
          ]
        : ["kind", "options", "accessibleName"];
  if (
    !hasExactKeys(ui, uiKeys) ||
    ("integer" in ui && ui.integer !== true) ||
    (kind === "temporal" && !isOneOf(ui.temporalKind, ["date", "time", "datetime"]))
  ) {
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
  if (kind === "button") {
    countString(ui.buttonLabel, `${path}.buttonLabel`);
    if ("background" in ui && !isNormalizedOpaqueColor(ui.background))
      errors.push(planError("TSC002", "Invalid opaque button background.", `${path}.background`));
  }
  if (kind === "text" || kind === "number" || kind === "temporal") {
    if (ui.hint !== null) countString(ui.hint, `${path}.hint`);
    const temporalKind = ui.temporalKind;
    const answerKind =
      temporalKind === "date" || temporalKind === "time" || temporalKind === "datetime"
        ? temporalKind
        : ui.integer === true
          ? "integer"
          : kind === "number"
            ? "number"
            : "text";
    if (
      "prefill" in ui &&
      countString(ui.prefill, `${path}.prefill`) &&
      !isValidInteractionPrefill(answerKind, ui.prefill)
    )
      errors.push(
        planError("TSC002", "Interaction prefill is not a valid answer.", `${path}.prefill`),
      );
  }
  if (kind === "choice") {
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
      for (let index = 0; index < ui.options.length; index += 1) {
        const option = ui.options[index];
        const optionPath = `${path}.options[${index}]`;
        if (!isRecord(option)) {
          errors.push(planError("TSC002", "Choice option must be an object.", optionPath));
          continue;
        }
        if (
          !hasExactKeys(option, [
            "text",
            "value",
            ...("background" in option ? ["background"] : []),
          ])
        ) {
          errors.push(
            planError("TSC002", "Choice option contains unsupported fields.", optionPath),
          );
        }
        if ("background" in option && !isNormalizedOpaqueColor(option.background))
          errors.push(
            planError("TSC002", "Invalid opaque choice background.", `${optionPath}.background`),
          );
        countString(option.text, `${optionPath}.text`);
        const value = option.value;
        if (!isInteractionChoiceValue(value)) {
          errors.push(
            planError("TSC002", "Choice option value is invalid.", `${optionPath}.value`),
          );
          continue;
        }
        if (typeof value === "string" && value !== option.text)
          countString(value, `${optionPath}.value`);
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
      ? [
          "kind",
          "buttonLabelTemporary",
          "accessibleName",
          ...("backgroundTemporary" in ui ? ["backgroundTemporary"] : []),
          ...("timeoutTemporary" in ui ? ["timeoutTemporary"] : []),
        ]
      : kind === "text" || kind === "number" || kind === "temporal"
        ? [
            "kind",
            "hintTemporary",
            "accessibleName",
            ...("prefillTemporary" in ui ? ["prefillTemporary"] : []),
            ...(kind === "number" && "integer" in ui ? ["integer"] : []),
            ...(kind === "temporal" ? ["temporalKind"] : []),
          ]
        : ["kind", "optionsTemporary", "values", "accessibleName"];
  if (
    !hasExactKeys(ui, keys) ||
    ("integer" in ui && ui.integer !== true) ||
    (kind === "temporal" && !isOneOf(ui.temporalKind, ["date", "time", "datetime"]))
  ) {
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
    if ("backgroundTemporary" in ui)
      addTemporary(ui.backgroundTemporary, `${path}.backgroundTemporary`);
    if ("timeoutTemporary" in ui) addTemporary(ui.timeoutTemporary, `${path}.timeoutTemporary`);
    return;
  }
  if (kind === "text" || kind === "number" || kind === "temporal") {
    if (ui.hintTemporary !== null) addTemporary(ui.hintTemporary, `${path}.hintTemporary`);
    if ("prefillTemporary" in ui) addTemporary(ui.prefillTemporary, `${path}.prefillTemporary`);
    return;
  }
  if (kind !== "choice") return;
  addTemporary(ui.optionsTemporary, `${path}.optionsTemporary`);
  if (
    !Array.isArray(ui.values) ||
    ui.values.length === 0 ||
    ui.values.length > MAX_INTERACTION_OPTION_ENTRIES
  ) {
    errors.push(
      planError(
        "TSC002",
        "Prepared choice values exceed the shared collection boundary or are empty.",
        `${path}.values`,
      ),
    );
    return;
  }
  for (let index = 0; index < ui.values.length; index += 1) {
    const value = ui.values[index];
    if (value === null) continue;
    const valuePath = `${path}.values[${index}]`;
    const valid =
      typeof value === "string"
        ? countString(value, valuePath) && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
        : typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
    if (!valid) {
      errors.push(planError("TSC002", "Prepared choice value is invalid.", valuePath));
    }
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
  | { kind: "property" | "entry"; value: unknown; path: string }
  | {
      kind: "span" | "string" | "inclusive" | "parts" | "arguments" | "part" | "argument";
      value: unknown;
      path: string;
    };

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
      else if (current.kind === "string") requireString(current.value, current.path, errors);
      else if (current.kind === "inclusive") {
        if (typeof current.value !== "boolean")
          errors.push(planError("TSC002", "Range inclusivity must be boolean.", current.path));
      } else if (current.kind === "parts" || current.kind === "arguments") {
        if (!Array.isArray(current.value))
          errors.push(
            planError(
              "TSC002",
              current.kind === "parts"
                ? "Template parts must be an array."
                : "Arguments must be an array.",
              current.path,
            ),
          );
        else
          for (let i = current.value.length - 1; i >= 0; i--)
            pending.push({
              kind: current.kind === "parts" ? "part" : "argument",
              value: current.value[i],
              path: `${current.path}[${i}]`,
            });
      } else if (!isRecord(current.value)) {
        errors.push(
          planError(
            "TSC002",
            current.kind === "part"
              ? "Template part must be an object."
              : current.kind === "argument"
                ? "Argument must be an object."
                : current.kind === "entry"
                  ? "Dict entry must be an object."
                  : "Property must be an object.",
            current.path,
          ),
        );
      } else if (current.kind === "part") {
        validateSpan(current.value.span, `${current.path}.span`, errors);
        if (current.value.kind === "text") {
          rejectUnknownFields(current.value, ["kind", "value", "span"], current.path, errors);
          requireString(current.value.value, `${current.path}.value`, errors);
        } else if (current.value.kind === "expression") {
          rejectUnknownFields(current.value, ["kind", "expression", "span"], current.path, errors);
          pending.push({
            value: current.value.expression,
            path: `${current.path}.expression`,
            assignmentTarget: false,
          });
        } else
          errors.push(planError("TSC002", "Unknown template part kind.", `${current.path}.kind`));
      } else if (current.kind === "argument") {
        validateSpan(current.value.span, `${current.path}.span`, errors);
        if (current.value.kind === "named") {
          rejectUnknownFields(
            current.value,
            ["kind", "name", "value", "span"],
            current.path,
            errors,
          );
          requireString(current.value.name, `${current.path}.name`, errors);
        } else if (current.value.kind === "positional")
          rejectUnknownFields(current.value, ["kind", "value", "span"], current.path, errors);
        else errors.push(planError("TSC002", "Unknown argument kind.", `${current.path}.kind`));
        pending.push({
          value: current.value.value,
          path: `${current.path}.value`,
          assignmentTarget: false,
        });
      } else if (current.kind === "entry") {
        rejectUnknownFields(current.value, ["key", "value", "span"], current.path, errors);
        pending.push({ kind: "span", value: current.value.span, path: `${current.path}.span` });
        pending.push({
          value: current.value.value,
          path: `${current.path}.value`,
          assignmentTarget: false,
        });
        pending.push({
          value: current.value.key,
          path: `${current.path}.key`,
          assignmentTarget: false,
        });
      } else {
        rejectUnknownFields(current.value, PROPERTY_FIELDS, current.path, errors);
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

/** Validates the optional `typeCheck` of a receiving instruction, call argument, or `add` call. */
function validateOptionalTypeCheck(
  owner: Record<string, unknown>,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!("typeCheck" in owner)) return;
  const check = owner.typeCheck;
  const checkPath = `${path}.typeCheck`;
  if (!isRecord(check)) {
    errors.push(planError("TSC002", "A type check must be an object.", checkPath));
    return;
  }
  rejectUnknownFields(check, ["type", "place"], checkPath, errors);
  requireString(check.place, `${checkPath}.place`, errors);
  validateTypePlan(check.type, `${checkPath}.type`, errors);
}

/** Validates a type of a runtime type check or a type test, iteratively for deep types. */
function validateTypePlan(root: unknown, rootPath: string, errors: PlanValidationError[]): void {
  const pending: { readonly value: unknown; readonly path: string }[] = [
    { value: root, path: rootPath },
  ];
  while (pending.length > 0) {
    const { value: type, path: typePath } = pending.pop()!;
    if (!isRecord(type)) {
      errors.push(planError("TSC002", "A type must be an object.", typePath));
      continue;
    }
    switch (type.kind) {
      case "list":
      case "set":
      case "dict":
        rejectUnknownFields(type, ["kind", "element"], typePath, errors);
        if (type.element !== null)
          pending.push({ value: type.element, path: `${typePath}.element` });
        break;
      case "object": {
        rejectUnknownFields(type, ["kind", "properties"], typePath, errors);
        if (!Array.isArray(type.properties)) {
          errors.push(
            planError(
              "TSC002",
              "Object type properties must be an array.",
              `${typePath}.properties`,
            ),
          );
          break;
        }
        const names = new Set<unknown>();
        type.properties.forEach((property: unknown, index) => {
          const propertyPath = `${typePath}.properties[${index}]`;
          if (!isRecord(property)) {
            errors.push(
              planError("TSC002", "An object type property must be an object.", propertyPath),
            );
            return;
          }
          rejectUnknownFields(property, ["name", "type"], propertyPath, errors);
          requireString(property.name, `${propertyPath}.name`, errors);
          if (names.has(property.name))
            errors.push(
              planError(
                "TSC002",
                "Object type property names must be unique.",
                `${propertyPath}.name`,
              ),
            );
          names.add(property.name);
          pending.push({ value: property.type, path: `${propertyPath}.type` });
        });
        break;
      }
      case "union":
        rejectUnknownFields(type, ["kind", "members"], typePath, errors);
        if (!Array.isArray(type.members) || type.members.length === 0) {
          errors.push(
            planError("TSC002", "A union type needs at least one member.", `${typePath}.members`),
          );
          break;
        }
        type.members.forEach((member: unknown, index) =>
          pending.push({ value: member, path: `${typePath}.members[${index}]` }),
        );
        break;
      default:
        if (isOneOf(type.kind, TYPE_PLAN_NAMES))
          rejectUnknownFields(type, ["kind"], typePath, errors);
        else errors.push(planError("TSC002", "Unknown type kind.", `${typePath}.kind`));
    }
  }
}

const TYPE_PLAN_NAMES = [
  "string",
  "boolean",
  "integer",
  "number",
  "duration",
  "date",
  "time",
  "datetime",
  "timestamp",
  "never",
  "null",
  "range",
  "speaker",
  "timer",
  "media",
];

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
  const fields = EXPRESSION_FIELDS.get(value.kind);
  if (fields !== undefined) rejectUnknownFields(value, fields, path, errors);
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
    case "duration":
      if (!isStoredDurationRecord(value, ["span"])) {
        errors.push(planError("TSC002", "Duration literal plan is invalid.", path));
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
    case "dict":
      if (!Array.isArray(value.entries))
        errors.push(planError("TSC002", "Dict entries must be an array.", `${path}.entries`));
      else
        for (let index = value.entries.length - 1; index >= 0; index -= 1)
          pending.push({
            kind: "entry",
            value: value.entries[index],
            path: `${path}.entries[${index}]`,
          });
      return;
    case "group":
      pending.push({
        value: value.expression,
        path: `${path}.expression`,
        assignmentTarget: false,
      });
      return;
    case "template":
      pending.push({ kind: "parts", value: value.parts, path: `${path}.parts` });
      return;
    case "property":
      pending.push({ kind: "string", value: value.name, path: `${path}.name` });
      pending.push({ value: value.object, path: `${path}.object`, assignmentTarget: false });

      return;
    case "index":
      pending.push({ value: value.index, path: `${path}.index`, assignmentTarget: false });
      pending.push({ value: value.object, path: `${path}.object`, assignmentTarget: false });
      return;
    case "call":
      validateOptionalTypeCheck(value, path, errors);
      if (
        "typeCheck" in value &&
        !(
          isRecord(value.callee) &&
          value.callee.kind === "property" &&
          Array.isArray(value.arguments) &&
          ((value.callee.name === "add" && value.arguments.length === 1) ||
            (value.callee.name === "get" &&
              value.arguments.length === 2 &&
              isRecord(value.arguments[1]) &&
              value.arguments[1].kind === "named" &&
              value.arguments[1].name === "default"))
        )
      )
        errors.push(
          planError(
            "TSC002",
            "Only a list or set 'add' call with one argument, or a dict 'get' call with a 'default:', checks a type.",
            `${path}.typeCheck`,
          ),
        );
      pending.push({ kind: "arguments", value: value.arguments, path: `${path}.arguments` });
      pending.push({ value: value.callee, path: `${path}.callee`, assignmentTarget: false });
      return;
    case "typeTest":
      if (typeof value.negated !== "boolean")
        errors.push(
          planError("TSC002", "A type test needs a boolean 'negated'.", `${path}.negated`),
        );
      validateTypePlan(value.type, `${path}.type`, errors);
      pending.push({ value: value.value, path: `${path}.value`, assignmentTarget: false });
      return;
    case "unary":
      if (!isOneOf(value.operator, ["+", "-", "not"])) {
        errors.push(planError("TSC002", "Invalid unary operator.", `${path}.operator`));
      }
      pending.push({ value: value.operand, path: `${path}.operand`, assignmentTarget: false });
      return;
    case "binary":
      if (!(typeof value.operator === "string" && binaryOperators.has(value.operator))) {
        errors.push(planError("TSC002", "Invalid binary operator.", `${path}.operator`));
      }
      pending.push(
        { value: value.right, path: `${path}.right`, assignmentTarget: false },
        { value: value.left, path: `${path}.left`, assignmentTarget: false },
      );
      return;
    case "range":
      pending.push({ kind: "inclusive", value: value.inclusive, path: `${path}.inclusive` });
      pending.push({ value: value.end, path: `${path}.end`, assignmentTarget: false });
      pending.push({ value: value.start, path: `${path}.start`, assignmentTarget: false });
      return;
    case "storageLoad":
      if (!hasExactKeys(value, ["kind", "key", "default", "span"])) {
        errors.push(planError("TSC002", "Storage-load expression has an invalid shape.", path));
      }
      if (value.default !== null) {
        pending.push({ value: value.default, path: `${path}.default`, assignmentTarget: false });
      }
      pending.push({ value: value.key, path: `${path}.key`, assignmentTarget: false });
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
    rejectUnknownFields(property, PROPERTY_FIELDS, propertyPath, errors);
    requireString(property.name, `${propertyPath}.name`, errors);
    validateExpression(property.value, `${propertyPath}.value`, errors, false, temporaryCount);
    validateSpan(property.span, `${propertyPath}.span`, errors);
  }
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
    const fields = ["parameterName", "value", "span"];
    if (!hasExactKeys(argument, "typeCheck" in argument ? [...fields, "typeCheck"] : fields)) {
      errors.push(
        planError("TSC002", "Function argument contains unsupported fields.", argumentPath),
      );
    }
    requireString(argument.parameterName, `${argumentPath}.parameterName`, errors);
    validateExpression(argument.value, `${argumentPath}.value`, errors, false, temporaryCount);
    validateSpan(argument.span, `${argumentPath}.span`, errors);
    validateOptionalTypeCheck(argument, argumentPath, errors);
  });
}

function validateDurationUnit(value: unknown, path: string, errors: PlanValidationError[]): void {
  if (value !== null && !isOneOf(value, ["ms", "s", "min", "h"])) {
    errors.push(planError("TSC002", "Duration unit is invalid.", path));
  }
}

function isDelayDisplay(value: unknown): boolean {
  return value === "hidden" || value === "visible" || value === "mystery";
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
  "in",
]);

function invalidPlan(
  code: PlanValidationError["code"],
  message: string,
  path: string,
): PlanValidationResult {
  return Object.freeze({ valid: false, errors: Object.freeze([planError(code, message, path)]) });
}
