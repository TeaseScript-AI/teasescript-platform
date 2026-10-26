import { isConversion, takesDefault, takesFiles } from "../../conversions.js";
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
import { validateOptionalTypeCheck, validateTypePlan } from "./type-plans.js";
import { validateInteractionInstruction } from "./interaction.js";

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
  ["declareBinding", "name", "value", "typeCheck"],
  ["prepareReference", "expression", "destinationTemporary"],
  ["validateAssignmentTarget", "target"],
  ["assign", "target", "value", "typeCheck", "requireExisting"],
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

/**
 * A `fileStore` instruction runs again once the Player answered, so each operand is a temporary or a literal, which
 * reads the same both times; `default:` belongs to the reading calls and `files:` to the JSON ones.
 */
function validateFileStoreInstruction(
  value: Record<string, unknown>,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  if (
    !hasExactKeys(value, [
      "kind",
      "call",
      "value",
      "defaultTemporary",
      "files",
      "destinationTemporary",
      ...("expected" in value ? ["expected"] : []),
      "span",
    ])
  ) {
    errors.push(planError("TSC002", "File store instruction has an invalid shape.", path));
    return;
  }
  if ("expected" in value) {
    if (value.call !== "fromJson")
      errors.push(
        planError("TSC002", "Only a 'fromJson' call reads an expected type.", `${path}.expected`),
      );
    validateTypePlan(value.expected, `${path}.expected`, errors);
  }
  const call = value.call;
  const conversion = typeof call === "string" && isConversion(call) && takesFiles(call);
  if (call !== "fileFromBase64" && call !== "fileToBase64" && call !== "hashFile" && !conversion) {
    errors.push(planError("TSC002", "File store call is invalid.", `${path}.call`));
    return;
  }
  const defaulted = call === "fileFromBase64" || (conversion && takesDefault(call));
  if (defaulted !== (value.defaultTemporary !== null))
    errors.push(
      planError("TSC002", `The default of ${call}(...) is invalid.`, `${path}.defaultTemporary`),
    );
  else if (defaulted)
    validateDefaultTemporary(
      value.defaultTemporary,
      value.destinationTemporary,
      path,
      temporaryCount,
      errors,
    );
  if (!conversion && value.files !== null)
    errors.push(planError("TSC002", `${call}(...) takes no files:.`, `${path}.files`));
  for (const name of ["value", "files"] as const) {
    const operand = value[name];
    if (operand === null && name !== "value") continue;
    if (!isRecord(operand) || (operand.kind !== "temporary" && operand.kind !== "literal"))
      errors.push(
        planError(
          "TSC002",
          "A file store operand must be a temporary or a literal.",
          `${path}.${name}`,
        ),
      );
    else validateExpression(operand, `${path}.${name}`, errors, false, temporaryCount);
  }
  validateTemporaryId(
    value.destinationTemporary,
    `${path}.destinationTemporary`,
    temporaryCount,
    errors,
  );
}

/**
 * A `lock` instruction runs again with each answer of the Player, so each operand is a temporary or a literal, which
 * reads the same every time. An encrypt call writes each of `password:`, also as a password field, `publicKey:`, and
 * `timeLock:`, or none; a decrypt call has its required `default:`, which follows it, and may have `key:`, which an
 * encrypt call has not.
 */
function validateLockInstruction(
  value: Record<string, unknown>,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  if (
    !hasExactKeys(value, [
      "kind",
      "call",
      "value",
      "password",
      "passwordField",
      "publicKey",
      "key",
      "timeLock",
      "defaultTemporary",
      "destinationTemporary",
      "span",
    ])
  ) {
    errors.push(planError("TSC002", "Lock instruction has an invalid shape.", path));
    return;
  }
  const call = value.call;
  if (
    call !== "encryptText" &&
    call !== "encryptFile" &&
    call !== "decryptText" &&
    call !== "decryptFile"
  ) {
    errors.push(planError("TSC002", "Lock call is invalid.", `${path}.call`));
    return;
  }
  const decrypts = call === "decryptText" || call === "decryptFile";
  if (decrypts !== (value.defaultTemporary !== null))
    errors.push(
      planError("TSC002", `The default of ${call}(...) is invalid.`, `${path}.defaultTemporary`),
    );
  else if (decrypts)
    validateDefaultTemporary(
      value.defaultTemporary,
      value.destinationTemporary,
      path,
      temporaryCount,
      errors,
    );
  if (!decrypts && value.key !== null)
    errors.push(planError("TSC002", `${call}(...) takes no key:.`, `${path}.key`));
  // A password field asks for the password, so the call has no written password besides it.
  const field = value.passwordField;
  if (
    field !== null &&
    (!isRecord(field) || !hasExactKeys(field, ["hint"]) || value.password !== null)
  )
    errors.push(
      planError("TSC002", "The password field of a lock is invalid.", `${path}.passwordField`),
    );
  const passwordWritten = value.password !== null || field !== null;
  for (const name of ["publicKey", "timeLock"] as const)
    if (decrypts ? value[name] !== null : passwordWritten !== (value[name] !== null))
      errors.push(
        planError("TSC002", `The ${name}: of ${call}(...) is invalid.`, `${path}.${name}`),
      );
  const hint = isRecord(field) && field.hint !== null ? field.hint : null;
  for (const [name, operand] of [
    ["value", value.value],
    ["password", value.password],
    ["passwordField.hint", hint],
    ["publicKey", value.publicKey],
    ["key", value.key],
    ["timeLock", value.timeLock],
  ] as const) {
    if (operand === null && name !== "value") continue;
    if (!isRecord(operand) || (operand.kind !== "temporary" && operand.kind !== "literal"))
      errors.push(
        planError("TSC002", "A lock operand must be a temporary or a literal.", `${path}.${name}`),
      );
    else validateExpression(operand, `${path}.${name}`, errors, false, temporaryCount);
  }
  validateTemporaryId(
    value.destinationTemporary,
    `${path}.destinationTemporary`,
    temporaryCount,
    errors,
  );
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
      "captures",
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
  validateHandlerCaptures(
    value.captures,
    value.finishFunctionId !== null || (Array.isArray(value.cues) && value.cues.length > 0),
    path,
    errors,
  );
  if (value.destinationTemporary !== null) {
    validateTemporaryId(
      value.destinationTemporary,
      `${path}.destinationTemporary`,
      temporaryCount,
      errors,
    );
  }
}

/** The variables a resource's blocks share: distinct names, and none without a block. */
function validateHandlerCaptures(
  captures: unknown,
  hasBlocks: boolean,
  path: string,
  errors: PlanValidationError[],
): void {
  if (
    !Array.isArray(captures) ||
    captures.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(captures).size !== captures.length ||
    (!hasBlocks && captures.length > 0)
  ) {
    errors.push(planError("TSC002", "Handler captures are invalid.", `${path}.captures`));
  }
}

/** The temporary that says whether a call or `load` needs its `default:`, apart from the one of its result. */
function validateDefaultTemporary(
  value: unknown,
  result: unknown,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  validateTemporaryId(value, `${path}.defaultTemporary`, temporaryCount, errors);
  if (value === result)
    errors.push(
      planError(
        "TSC002",
        "Whether the default is needed and the result need two temporaries.",
        `${path}.defaultTemporary`,
      ),
    );
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

function nonNegativeInteger(value: unknown): value is number {
  // EVIDENCE: validation: Number.isInteger establishes the numeric value before comparison.
  return Number.isInteger(value) && (value as number) >= 0;
}
