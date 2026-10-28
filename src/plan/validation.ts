import { packageAssetPathProblem } from "../project-paths.js";
import { normalizeTagName } from "../tags.js";
import {
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
  type InstructionPlan,
} from "./model.js";
import { analyzeInstructionStream } from "./instruction-stream-analyses.js";
import { collectFunctionIds } from "./instruction-stream-analyses/function-definitions.js";
import { validateLabelPositions } from "./instruction-stream-analyses/label-positions.js";
import {
  type PlanValidationError,
  hasExactKeys,
  isRecord,
  nonNegativeSafeInteger,
  planError,
  rejectUnknownFields,
} from "./validation-support.js";
import {
  captureFailureValidation,
  capturePlanData,
  isPlanCaptureFailure,
} from "./capture-support.js";
import { validatePlanFiles } from "./validation/files.js";
import { validateInstruction } from "./validation/instructions.js";
import { validateStartupPrefix } from "./validation/startup-prefix.js";
import { validateTypePlan } from "./validation/type-plans.js";

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
    errors.push(planError("TSC010", "Unsupported instruction-plan format.", "$.format"));
  }
  if (value.version !== INSTRUCTION_PLAN_VERSION) {
    errors.push(planError("TSC010", "Unsupported instruction-plan revision.", "$.version"));
  }
  // After the revision checks, so another revision's fields report that revision as unsupported first.
  rejectUnknownFields(value, PLAN_FIELDS, "$", errors);
  validatePlanImages(value.images, errors);
  validateStorageTypes(value.storageTypes, errors);
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
    const files = validatePlanFiles(value.files, value.instructions, errors);
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
    validateStartupPrefix(
      value.instructions,
      files,
      Array.isArray(value.files) ? value.files.length : 0,
      errors,
    );
    analyzeInstructionStream(value.instructions, value.functions, files, errors);
    if (errors.length === 0 && files !== null) {
      const plan: unknown = value;
      // EVIDENCE: validation: every part of the plan passed its check above, with no error.
      validateLabelPositions(plan as InstructionPlan, files, errors);
    }
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

const PLAN_FIELDS = [
  "format",
  "version",
  "files",
  "images",
  "temporaryCount",
  "functions",
  "instructions",
  "storageTypes",
];

/** The types of storage keys: unique keys in UTF-16 code-unit order, each with a valid type (ADR 0021 §6). */
function validateStorageTypes(value: unknown, errors: PlanValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Plan storage types must be an array.", "$.storageTypes"));
    return;
  }
  let previousKey: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    const path = `$.storageTypes[${index}]`;
    if (!isRecord(entry) || !hasExactKeys(entry, ["key", "type"])) {
      errors.push(planError("TSC002", "A storage type has a key and a type.", path));
      continue;
    }
    if (typeof entry.key !== "string") {
      errors.push(planError("TSC002", "A storage type's key is a string.", `${path}.key`));
    } else if (previousKey !== null && !(previousKey < entry.key)) {
      errors.push(planError("TSC002", "Storage types are unique and in key order.", `${path}.key`));
    } else {
      previousKey = entry.key;
    }
    validateTypePlan(entry.type, `${path}.type`, errors);
  }
}

/** The image catalog: unique package paths in order, each with canonical tags in name order (ADR 0023). */
function validatePlanImages(value: unknown, errors: PlanValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Plan images must be an array.", "$.images"));
    return;
  }
  let previousPath: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const image: unknown = value[index];
    const path = `$.images[${index}]`;
    if (!isRecord(image) || !hasExactKeys(image, ["path", "tags"])) {
      errors.push(planError("TSC002", "A plan image has a path and tags.", path));
      continue;
    }
    if (typeof image.path !== "string" || packageAssetPathProblem(image.path) !== null) {
      errors.push(planError("TSC002", "A plan image path is a package path.", `${path}.path`));
    } else if (previousPath !== null && !(previousPath < image.path)) {
      errors.push(planError("TSC002", "Plan images are unique and in path order.", `${path}.path`));
    } else {
      previousPath = image.path;
    }
    if (!Array.isArray(image.tags)) {
      errors.push(planError("TSC002", "Image tags must be an array.", `${path}.tags`));
      continue;
    }
    let previousName: string | null = null;
    for (let tagIndex = 0; tagIndex < image.tags.length; tagIndex += 1) {
      const tag: unknown = image.tags[tagIndex];
      const tagPath = `${path}.tags[${tagIndex}]`;
      if (
        !isRecord(tag) ||
        !hasExactKeys(tag, ["name", "value"]) ||
        typeof tag.name !== "string" ||
        normalizeTagName(tag.name) !== tag.name ||
        (previousName !== null && !(previousName < tag.name)) ||
        !(tag.value === null || (typeof tag.value === "number" && Number.isFinite(tag.value)))
      ) {
        errors.push(
          planError(
            "TSC002",
            "An image tag has a canonical name, unique and in name order, and a finite number or null.",
            tagPath,
          ),
        );
        continue;
      }
      previousName = tag.name;
    }
  }
}

function invalidPlan(
  code: PlanValidationError["code"],
  message: string,
  path: string,
): PlanValidationResult {
  return Object.freeze({ valid: false, errors: Object.freeze([planError(code, message, path)]) });
}
