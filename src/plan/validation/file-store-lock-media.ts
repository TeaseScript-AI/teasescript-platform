// The fileStore, lock and playMedia instructions' own validators, and the checks of a default's temporary, a function
// id and a block's captures that they share with the other instructions.

import { isConversion, takesDefault, takesFiles } from "../../conversions.js";
import {
  type PlanValidationError,
  hasExactKeys,
  isRecord,
  planError,
  validateTemporaryId,
} from "../validation-support.js";
import { validateExpression } from "./expressions.js";
import { validateTypePlan } from "./type-plans.js";

/**
 * A `fileStore` instruction runs again once the Playroom answered, so each operand is a temporary or a literal, which
 * reads the same both times; `default:` belongs to the reading calls and `files:` to the JSON ones.
 */
export function validateFileStoreInstruction(
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
 * A `lock` instruction runs again with each answer of the Playroom, so each operand is a temporary or a literal, which
 * reads the same every time. An encrypt call writes each of `password:`, also as a password field, `publicKey:`, and
 * `timeLock:`, or none; a decrypt call has its required `default:`, which follows it, and may have `key:`, which an
 * encrypt call has not.
 */
export function validateLockInstruction(
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

export function validatePlayMediaInstruction(
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
export function validateHandlerCaptures(
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
export function validateDefaultTemporary(
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

export function validateFunctionId(
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
