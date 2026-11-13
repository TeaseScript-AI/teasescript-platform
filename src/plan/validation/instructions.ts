import { DURATION_UNITS } from "../../language-facts.js";
import { isLazyDefaultOperation } from "../../lazy-defaults.js";
import { lazyDefaultArgumentIndex, lazyDefaultCallOperation } from "../expression-children.js";
import { expressionMayReferenceTemporary } from "../instruction-stream-analyses/instruction-facts.js";
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
  fieldsByKind,
  validateTemporaryId,
} from "../validation-support.js";
import { PROPERTY_FIELDS, validateExpression } from "./expressions.js";
import {
  validateOptionalPartChecks,
  validateOptionalTypeCheck,
  validateTypePlan,
} from "./type-plans.js";
import { validateInteractionInstruction } from "./interaction.js";
import {
  validateFileStoreInstruction,
  validateLockInstruction,
  validatePlayMediaInstruction,
  validateHandlerCaptures,
  validateDefaultTemporary,
  validateFunctionId,
} from "./store-lock-media.js";

/**
 * A file and its entry, for a glob a non-empty list of them to pick from, or a computed target's expression. A
 * destination's file and target must also name that file's entry; the stream analysis checks that.
 */
function validateDestinationShape(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  temporaryCount: number,
): void {
  if (isRecord(value) && hasExactKeys(value, ["value"])) {
    validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
    return;
  }
  const single = (candidate: unknown): boolean =>
    isRecord(candidate) &&
    hasExactKeys(candidate, ["file", "target"]) &&
    nonNegativeSafeInteger(candidate.file) &&
    nonNegativeSafeInteger(candidate.target);
  if (
    !single(value) &&
    !(
      isRecord(value) &&
      hasExactKeys(value, ["pick"]) &&
      Array.isArray(value.pick) &&
      value.pick.length > 0 &&
      value.pick.every(single)
    )
  ) {
    errors.push(planError("TSC002", "Transfer destination is malformed.", path));
  }
}

/** Fields of instruction kinds whose case in validateInstruction does not already require exact keys. */
const INSTRUCTION_FIELDS = fieldsByKind([
  ["declareGlobal", "name", "value", "typeCheck", "file"],
  ["declareSpeaker", "name", "properties", "file"],
  ["setDefaultSpeaker", "name"],
  ["copyPlayerProfile"],
  ["enterScope"],
  ["leaveScope"],
  ["exit"],
  ["end"],
  ["goto", "target"],
  ["transfer", "mode", "destination"],
  ["declareBinding", "name", "value", "typeCheck", "partChecks"],
  ["prepareReference", "expression", "destinationTemporary"],
  ["validateAssignmentTarget", "target"],
  ["assign", "target", "value", "typeCheck", "requireExisting", "partChecks"],
  ["validateCallReceiver", "receiver", "method"],
  ["evaluate", "expression"],
  ["jumpIfFalse", "condition", "target"],
  ["jump", "target"],
  ["loopStart", "loopKind", "loopId", "expression", "continueTarget", "target"],
  ["loopControl", "action", "loopId", "target"],
  [
    "storeTemporary",
    "temporaryId",
    "value",
    "expectBoolean",
    "defaultTemporary",
    "defaultOf",
    "typeCheck",
    "fallbackCheck",
    "repair",
  ],
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
    "destinationTemporary",
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
  "valueVariable",
  "expression",
  "continueTarget",
  "target",
];

export function validateInstruction(
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
    case "declareGlobal":
      requireString(value.name, `${path}.name`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      validateOptionalTypeCheck(value, path, errors);
      return;
    case "setDefaultSpeaker":
      requireString(value.name, `${path}.name`, errors);
      return;
    case "copyPlayerProfile":
    case "enterScope":
    case "leaveScope":
    case "exit":
    case "end":
      return;
    case "goto":
      if (!validInstructionBoundary(value.target, instructionCount)) {
        errors.push(planError("TSC002", "Goto target is outside the plan.", `${path}.target`));
      }
      return;
    case "transfer":
      if (value.mode !== "goto" && value.mode !== "call") {
        errors.push(planError("TSC002", "Transfer mode is invalid.", `${path}.mode`));
      }
      validateDestinationShape(value.destination, `${path}.destination`, errors, temporaryCount);
      return;
    case "declareBinding":
      requireString(value.name, `${path}.name`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      validateOptionalTypeCheck(value, path, errors);
      validateOptionalPartChecks(value, path, errors);
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
      if (
        "requireExisting" in value &&
        (value.requireExisting !== true ||
          !isRecord(value.target) ||
          value.target.kind !== "property")
      )
        errors.push(
          planError(
            "TSC002",
            "Only a property store can require an existing property.",
            `${path}.requireExisting`,
          ),
        );
      validateOptionalPartChecks(value, path, errors);
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
      if (value.loopKind === "for") {
        requireString(value.variable, `${path}.variable`, errors);
        if ("valueVariable" in value) {
          requireString(value.valueVariable, `${path}.valueVariable`, errors);
          if (value.valueVariable === value.variable)
            errors.push(
              planError(
                "TSC002",
                "A for loop's key and value variables must differ.",
                `${path}.valueVariable`,
              ),
            );
        }
      }
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
      validateOptionalTypeCheck(value, path, errors);
      validateOptionalTypeCheck(value, path, errors, "fallbackCheck");
      if ("repair" in value) validateTypePlan(value.repair, `${path}.repair`, errors);
      if ("defaultTemporary" in value) {
        validateDefaultTemporary(
          value.defaultTemporary,
          value.temporaryId,
          path,
          temporaryCount,
          errors,
        );
        if (
          !isDefaultProbe(value.value) ||
          value.expectBoolean !== false ||
          "typeCheck" in value ||
          "defaultOf" in value ||
          "fallbackCheck" in value ||
          "repair" in value
        )
          errors.push(
            planError(
              "TSC002",
              "Only a call or load without its default: tells whether it needs the default.",
              `${path}.defaultTemporary`,
            ),
          );
      }
      if ("defaultOf" in value && !isLazyDefaultOperation(value.defaultOf))
        errors.push(
          planError("TSC002", "The call that takes a default: is invalid.", `${path}.defaultOf`),
        );
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
      if (
        !hasExactKeys(
          value,
          "field" in value
            ? ["kind", "value", "destinationTemporary", "field", "span"]
            : ["kind", "value", "destinationTemporary", "span"],
        ) ||
        ("field" in value && value.field !== true)
      ) {
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
      if (value.destinationTemporary !== undefined) {
        validateTemporaryId(
          value.destinationTemporary,
          `${path}.destinationTemporary`,
          temporaryCount,
          errors,
        );
        if (
          [value.speakerTemporary, value.contextualSpeakerTemporary, value.textTemporary].includes(
            value.destinationTemporary,
          )
        )
          errors.push(
            planError(
              "TSC002",
              "A say's result temporary must differ from its prepared operands.",
              `${path}.destinationTemporary`,
            ),
          );
      }
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
          "captures",
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
      validateHandlerCaptures(value.captures, value.handlerFunctionId !== null, path, errors);
      if (value.destinationTemporary !== null) {
        validateTemporaryId(
          value.destinationTemporary,
          `${path}.destinationTemporary`,
          temporaryCount,
          errors,
        );
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
    case "showCamera":
      if (
        !hasExactKeys(value, ["kind", "placement", "destinationTemporary", "span"]) ||
        !isOneOf(value.placement, ["window", "stage"])
      ) {
        errors.push(planError("TSC002", "Show-camera instruction has an invalid shape.", path));
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
    case "hideCamera":
      if (!hasExactKeys(value, ["kind", "span"])) {
        errors.push(planError("TSC002", "Hide-camera instruction has an invalid shape.", path));
      }
      return;
    case "showPermanentButton":
      if (
        !hasExactKeys(value, [
          "kind",
          "text",
          "persist",
          "handlerFunctionId",
          "captures",
          "destinationTemporary",
          "span",
        ]) ||
        typeof value.persist !== "boolean"
      ) {
        errors.push(
          planError("TSC002", "Show-permanent-button instruction has an invalid shape.", path),
        );
      }
      validateExpression(value.text, `${path}.text`, errors, false, temporaryCount);
      validateFunctionId(value.handlerFunctionId, `${path}.handlerFunctionId`, functionIds, errors);
      validateHandlerCaptures(value.captures, true, path, errors);
      if (value.destinationTemporary !== null) {
        validateTemporaryId(
          value.destinationTemporary,
          `${path}.destinationTemporary`,
          temporaryCount,
          errors,
        );
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
    case "stopAudio":
      if (!hasExactKeys(value, ["kind", "span"])) {
        errors.push(planError("TSC002", "Stop-audio instruction has an invalid shape.", path));
      }
      return;
    case "interaction":
      validateInteractionInstruction(value, path, temporaryCount, errors);
      return;
    case "capture":
      if (!hasExactKeys(value, ["kind", "capture", "tags", "destinationTemporary", "span"])) {
        errors.push(planError("TSC002", "Capture instruction has an invalid shape.", path));
      }
      if (value.capture !== "photo")
        errors.push(planError("TSC002", "Capture kind is invalid.", `${path}.capture`));
      if (value.tags !== null) {
        validateExpression(value.tags, `${path}.tags`, errors, false, temporaryCount);
      }
      validateTemporaryId(
        value.destinationTemporary,
        `${path}.destinationTemporary`,
        temporaryCount,
        errors,
      );
      return;
    case "fileStore":
      validateFileStoreInstruction(value, path, temporaryCount, errors);
      return;
    case "lock":
      validateLockInstruction(value, path, temporaryCount, errors);
      return;
    default:
      errors.push(planError("TSC002", `Unknown instruction kind '${value.kind}'.`, `${path}.kind`));
  }
}

/** Whether a value is a call or `load` without its `default:`, which then runs as the instructions after it. */
function isDefaultProbe(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "storageLoad") return value.default === null;
  if (
    value.kind !== "call" ||
    !isRecord(value.callee) ||
    !Array.isArray(value.arguments) ||
    !value.arguments.every(isRecord)
  )
    return false;
  const call = { callee: value.callee, arguments: value.arguments };
  return (
    lazyDefaultCallOperation(call) !== null &&
    lazyDefaultArgumentIndex(call) === -1 &&
    !("typeCheck" in value)
  );
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
  if (value !== null && !isOneOf(value, DURATION_UNITS)) {
    errors.push(planError("TSC002", "Duration unit is invalid.", path));
  }
}

function isDelayDisplay(value: unknown): boolean {
  return value === "hidden" || value === "visible" || value === "mystery";
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

function nonNegativeInteger(value: unknown): value is number {
  // EVIDENCE: validation: Number.isInteger establishes the numeric value before comparison.
  return Number.isInteger(value) && (value as number) >= 0;
}
