import {
  type PlanValidationError,
  isRecord,
  isOneOf,
  nonNegativeSafeInteger,
  planError,
  rejectUnknownFields,
  requireString,
  validateSpan,
  validInstructionBoundary,
} from "../validation-support.js";
import {
  type PlanFileBoundaries,
  type InstructionExecutionRegion,
  type ValidatedFunctionRange,
  type PlanValidationIndex,
  createPlanValidationIndex,
} from "./execution-regions.js";

// The function table: function IDs, and each definition with its range, prologue, and parameters.

export function collectFunctionIds(value: unknown): ReadonlySet<number> {
  if (!Array.isArray(value)) return new Set<number>();
  return new Set(
    value
      .filter(isRecord)
      .map((item) => item.id)
      .filter((id): id is number => {
        // EVIDENCE: validation: Number.isInteger establishes the numeric ID before comparison.
        return Number.isInteger(id) && (id as number) > 0;
      }),
  );
}

const FUNCTION_FIELDS = [
  "id",
  "handler",
  "global",
  "selfHandle",
  "name",
  "declarationSpan",
  "parameters",
  "entryInstruction",
  "bodyEntryInstruction",
  "implicitReturnInstruction",
  "endInstruction",
  "bodySpan",
];

const PARAMETER_FIELDS = ["name", "index", "hasDefault", "declarationSpan", "defaultSpan"];

/**
 * Functions and handlers are local to their file, except global functions, which every file may call (ADR 0022 §3). A
 * global function and its handlers see only the project's names, so they call only global functions, and a handler is
 * global exactly when the code that registers it is.
 */
function reportForeignFunction(
  target: ValidatedFunctionRange | undefined,
  ownerRegion: InstructionExecutionRegion | undefined,
  call: boolean,
  index: PlanValidationIndex | null,
  instructionIndex: number,
  errors: PlanValidationError[],
): void {
  if (target === undefined || ownerRegion === undefined) return;
  const ownerGlobal =
    ownerRegion.kind === "function" &&
    index?.functionsById.get(ownerRegion.functionId)?.global === true;
  const problem = call
    ? !target.global && (ownerGlobal || target.file !== ownerRegion.file)
      ? ownerGlobal
        ? "A global function calls a function that is not global."
        : "An instruction refers to a function of another file."
      : null
    : target.file !== ownerRegion.file
      ? "An instruction refers to a function of another file."
      : target.global !== ownerGlobal
        ? "A handler is global exactly when the code that registers it is."
        : null;
  if (problem !== null)
    errors.push(planError("TSC002", problem, `$.instructions[${instructionIndex}]`));
}

export function validateFunctionDefinitions(
  value: unknown,
  instructions: readonly unknown[],
  files: readonly PlanFileBoundaries[] | null,
  errors: PlanValidationError[],
): PlanValidationIndex | null {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Function definitions must be an array.", "$.functions"));
    return createPlanValidationIndex(instructions, files, []);
  }
  const ids = new Set<number>();
  const validatedRanges: ValidatedFunctionRange[] = [];
  // Function ranges fill each file's block after its root region, file by file; names are unique within a file.
  let file = 0;
  let names = new Set<string>();
  let expectedEntry = files?.[0]?.rootEndInstruction ?? null;
  const skipCompletedFiles = (): void => {
    while (files !== null && file < files.length && expectedEntry === files[file]!.endInstruction) {
      file += 1;
      names = new Set();
      expectedEntry = files[file]?.rootEndInstruction ?? null;
    }
  };
  value.forEach((definition, definitionIndex) => {
    const path = `$.functions[${definitionIndex}]`;
    if (!isRecord(definition)) {
      errors.push(planError("TSC002", "Function definition must be an object.", path));
      return;
    }
    rejectUnknownFields(definition, FUNCTION_FIELDS, path, errors);
    requirePositiveInteger(definition.id, `${path}.id`, errors);
    requireString(definition.name, `${path}.name`, errors);
    if (
      definition.handler !== null &&
      definition.handler !== "timer" &&
      definition.handler !== "media" &&
      definition.handler !== "button"
    ) {
      errors.push(planError("TSC002", "Function handler kind is invalid.", path));
    } else if (
      definition.handler !== null &&
      (!Array.isArray(definition.parameters) || definition.parameters.length !== 0)
    ) {
      errors.push(planError("TSC002", "A handler region has no parameters.", path));
    }
    if (
      definition.selfHandle !== null &&
      (definition.handler !== "media" ||
        typeof definition.selfHandle !== "string" ||
        definition.selfHandle.length === 0)
    ) {
      errors.push(planError("TSC002", "Only a media handler may bind a self-handle name.", path));
    }
    if (typeof definition.global !== "boolean")
      errors.push(planError("TSC002", "Function global must be a boolean.", `${path}.global`));
    validateSpan(definition.declarationSpan, `${path}.declarationSpan`, errors);
    validateSpan(definition.bodySpan, `${path}.bodySpan`, errors);
    if (typeof definition.id === "number") {
      if (ids.has(definition.id)) {
        errors.push(planError("TSC002", "Function IDs must be unique.", `${path}.id`));
      }
      if (definition.id !== definitionIndex + 1) {
        errors.push(
          planError("TSC002", "Function IDs must follow deterministic source order.", `${path}.id`),
        );
      }
      ids.add(definition.id);
    }
    skipCompletedFiles();
    if (typeof definition.name === "string" && definition.handler === null) {
      if (names.has(definition.name)) {
        errors.push(
          planError("TSC002", "Function names must be unique within a file.", `${path}.name`),
        );
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
      errors.push(
        planError("TSC002", "Function instruction boundaries must be non-negative integers.", path),
      );
      return;
    }
    // EVIDENCE: validation: all four fixed instruction boundaries passed nonNegativeSafeInteger above.
    const [entry, bodyEntry, implicitReturn, end] = points as [number, number, number, number];
    if (
      expectedEntry === null ||
      entry !== expectedEntry ||
      entry >= bodyEntry ||
      bodyEntry > implicitReturn ||
      implicitReturn !== end - 1 ||
      end > (files?.[file]?.endInstruction ?? -1)
    ) {
      errors.push(
        planError("TSC002", "Function instruction range is overlapping or impossible.", path),
      );
      return;
    }
    const functionId = definition.id;
    // EVIDENCE: validation: Number.isSafeInteger establishes the numeric function ID.
    if (!Number.isSafeInteger(functionId) || (functionId as number) < 1) return;

    const validatedRange: ValidatedFunctionRange = {
      definition,
      path,
      file,
      global: definition.global === true,
      // EVIDENCE: validation: functionId passed the positive safe-integer check above.
      id: functionId as number,
      entryInstruction: entry,
      bodyEntryInstruction: bodyEntry,
      implicitReturnInstruction: implicitReturn,
      endInstruction: end,
    };
    validatedRanges.push(validatedRange);

    const bodyEntryMarker = instructions[bodyEntry - 1];
    if (!isRecord(bodyEntryMarker) || bodyEntryMarker.kind !== "enterFunctionBody") {
      errors.push(
        planError(
          "TSC002",
          "Function body entry point is invalid.",
          `${path}.bodyEntryInstruction`,
        ),
      );
    }
    const implicitReturnInstruction = instructions[implicitReturn];
    if (!isRecord(implicitReturnInstruction) || implicitReturnInstruction.kind !== "returnVoid") {
      errors.push(
        planError(
          "TSC002",
          "Function implicit-return boundary is invalid.",
          `${path}.implicitReturnInstruction`,
        ),
      );
    }
    validateFunctionPrologue(validatedRange, instructions, errors);
    expectedEntry = end;
  });
  skipCompletedFiles();
  if (files !== null && expectedEntry !== null && file < files.length) {
    errors.push(
      planError(
        "TSC002",
        "Function ranges do not cover the non-root instruction region.",
        "$.functions",
      ),
    );
  }

  const index = createPlanValidationIndex(instructions, files, validatedRanges);
  // A timer, media, or button block is a handler region of its own: a waiting block's resource, its activation, and its
  // shared variables are known from the one statement that uses the block.
  const blockFunctions = new Set<number>();
  const claimBlock = (functionId: number, instructionIndex: number): void => {
    if (!blockFunctions.has(functionId)) {
      blockFunctions.add(functionId);
      return;
    }
    errors.push(
      planError(
        "TSC002",
        "A block function belongs to one timer, media, or button block only.",
        `$.instructions[${instructionIndex}]`,
      ),
    );
  };
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction)) return;
    const ownerRegion = index?.owners[instructionIndex];
    const owner =
      ownerRegion?.kind === "function"
        ? index?.functionsById.get(ownerRegion.functionId)
        : undefined;
    const functionOnly = isOneOf(instruction.kind, [
      "bindSuppliedParameter",
      "beginFunctionDefaults",
      "prepareParameterDefault",
      "bindDefaultParameter",
      "enterFunctionBody",
      "returnValue",
      "returnVoid",
    ]);
    if (functionOnly && owner === undefined) {
      errors.push(
        planError(
          "TSC002",
          "Function-only instruction appears in root execution.",
          `$.instructions[${instructionIndex}]`,
        ),
      );
    }
    if (
      owner !== undefined &&
      instruction.kind !== "callFunction" &&
      "functionId" in instruction &&
      instruction.functionId !== owner.id
    ) {
      errors.push(
        planError(
          "TSC002",
          "Function prologue instruction has the wrong function ID.",
          `$.instructions[${instructionIndex}].functionId`,
        ),
      );
    }
    if (
      (instruction.kind === "callFunction" ||
        instruction.kind === "startTimer" ||
        instruction.kind === "showPermanentButton") &&
      typeof (instruction.kind === "callFunction"
        ? instruction.functionId
        : instruction.handlerFunctionId) === "number"
    ) {
      const targetRange = index?.functionsById.get(
        // EVIDENCE: validation: the enclosing condition established the numeric ID.
        (instruction.kind === "callFunction"
          ? instruction.functionId
          : instruction.handlerFunctionId) as number,
      );
      reportForeignFunction(
        targetRange,
        ownerRegion,
        instruction.kind === "callFunction",
        index,
        instructionIndex,
        errors,
      );
      const target = targetRange?.definition;
      const handler =
        instruction.kind === "startTimer"
          ? "timer"
          : instruction.kind === "showPermanentButton"
            ? "button"
            : null;
      if (handler !== null)
        // EVIDENCE: validation: the enclosing condition established the numeric handler ID.
        claimBlock(instruction.handlerFunctionId as number, instructionIndex);
      if (target !== undefined && target.handler !== handler) {
        errors.push(
          planError(
            "TSC002",
            handler === "timer"
              ? "A timer must refer to a timer-handler region."
              : handler === "button"
                ? "A permanent button must refer to a button-handler region."
                : "A call must not enter a handler region.",
            `$.instructions[${instructionIndex}]`,
          ),
        );
      }
    }
    if (instruction.kind === "playMedia") {
      const handlerIds = [
        ...(Array.isArray(instruction.cues)
          ? instruction.cues.map((cue: unknown) => (isRecord(cue) ? cue.functionId : undefined))
          : []),
        instruction.finishFunctionId,
      ];
      for (const id of handlerIds) {
        if (typeof id !== "number") continue;
        claimBlock(id, instructionIndex);
        const targetRange = index?.functionsById.get(id);
        reportForeignFunction(targetRange, ownerRegion, false, index, instructionIndex, errors);
        const target = targetRange?.definition;
        if (target !== undefined && target.handler !== "media") {
          errors.push(
            planError(
              "TSC002",
              "Media cues must refer to media-handler regions.",
              `$.instructions[${instructionIndex}]`,
            ),
          );
        }
      }
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
            errors.push(
              planError(
                "TSC002",
                "Call refers to an unknown function parameter.",
                `$.instructions[${instructionIndex}].arguments[${argumentIndex}].parameterName`,
              ),
            );
          }
          if (supplied.has(argument.parameterName)) {
            errors.push(
              planError(
                "TSC002",
                "Call supplies a function parameter more than once.",
                `$.instructions[${instructionIndex}].arguments[${argumentIndex}].parameterName`,
              ),
            );
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
            errors.push(
              planError(
                "TSC002",
                "Call omits a required function parameter.",
                `$.instructions[${instructionIndex}].arguments[${parameterIndex}]`,
              ),
            );
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
      errors.push(
        planError(
          "TSC002",
          "Function supplied-parameter prologue is malformed.",
          `${path}.entryInstruction`,
        ),
      );
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
    errors.push(
      planError(
        "TSC002",
        "Function default-parameter prologue is missing.",
        `${path}.entryInstruction`,
      ),
    );
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
      errors.push(
        planError(
          "TSC002",
          "Function parameter-default sequence is malformed.",
          `${path}.parameters[${index}]`,
        ),
      );
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
        if (nested.functionId !== range.id || nested.parameterIndex !== index) {
          errors.push(
            planError(
              "TSC002",
              "Default binding does not match its parameter segment.",
              `$.instructions[${instructionIndex}]`,
            ),
          );
        }
        defaultBindings.push(nested);
        continue;
      }
      if (
        !isOneOf(nested.kind, [
          "storeTemporary",
          "prepareReference",
          "clearTemporary",
          "clearTemporaries",
          "callFunction",
          "validateCallReceiver",
          "jumpIfFalse",
          "jump",
          "showPermanentButton",
          "startTimer",
          // A default may store or read files, as it may call a function that does.
          "fileStore",
        ])
      ) {
        errors.push(
          planError(
            "TSC002",
            "Function default-expression region contains an invalid instruction.",
            `$.instructions[${instructionIndex}]`,
          ),
        );
      }
      if (
        (nested.kind === "jump" || nested.kind === "jumpIfFalse") &&
        (!validInstructionBoundary(nested.target, instructions.length) ||
          nested.target <= instructionIndex ||
          nested.target > regionEnd)
      ) {
        errors.push(
          planError(
            "TSC002",
            "Default-expression jump escapes its parameter segment.",
            `$.instructions[${instructionIndex}].target`,
          ),
        );
      }
    }
    if (
      (parameter.hasDefault === true && defaultBindings.length !== 1) ||
      (parameter.hasDefault === false && regionEnd !== regionStart)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Function parameter default does not match its metadata.",
          `${path}.parameters[${index}]`,
        ),
      );
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
        if (
          instructionIndex > bindingIndex &&
          nested.kind !== "clearTemporary" &&
          nested.kind !== "clearTemporaries"
        ) {
          errors.push(
            planError(
              "TSC002",
              "Only temporary cleanup may follow a default binding.",
              `$.instructions[${instructionIndex}]`,
            ),
          );
        }
        if (
          (nested.kind === "jump" || nested.kind === "jumpIfFalse") &&
          validInstructionBoundary(nested.target, instructions.length) &&
          nested.target > bindingIndex
        ) {
          errors.push(
            planError(
              "TSC002",
              "Default-expression control flow may not bypass its binding.",
              `$.instructions[${instructionIndex}].target`,
            ),
          );
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
    errors.push(
      planError(
        "TSC002",
        "Function body-entry prologue marker is malformed.",
        `${path}.bodyEntryInstruction`,
      ),
    );
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
    if (
      isRecord(instruction) &&
      typeof instruction.kind === "string" &&
      prologueOnly.has(instruction.kind)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Function prologue instruction appears inside the function body.",
          `$.instructions[${instructionIndex}]`,
        ),
      );
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
    rejectUnknownFields(parameter, PARAMETER_FIELDS, parameterPath, errors);
    requireString(parameter.name, `${parameterPath}.name`, errors);
    if (typeof parameter.name === "string") {
      if (names.has(parameter.name)) {
        errors.push(
          planError("TSC002", "Function parameter names must be unique.", `${parameterPath}.name`),
        );
      }
      names.add(parameter.name);
    }
    if (parameter.index !== index) {
      errors.push(
        planError(
          "TSC002",
          "Function parameter indexes must be contiguous.",
          `${parameterPath}.index`,
        ),
      );
    }
    if (typeof parameter.hasDefault !== "boolean") {
      errors.push(
        planError(
          "TSC002",
          "Function parameter default metadata is malformed.",
          `${parameterPath}.hasDefault`,
        ),
      );
    } else {
      if (!parameter.hasDefault && sawDefault) {
        errors.push(
          planError("TSC002", "Required parameter follows a defaulted parameter.", parameterPath),
        );
      }
      sawDefault ||= parameter.hasDefault;
    }
    validateSpan(parameter.declarationSpan, `${parameterPath}.declarationSpan`, errors);
    if (parameter.hasDefault === true) {
      validateSpan(parameter.defaultSpan, `${parameterPath}.defaultSpan`, errors);
    } else if (parameter.defaultSpan !== null) {
      errors.push(
        planError(
          "TSC002",
          "Required parameter must not have a default span.",
          `${parameterPath}.defaultSpan`,
        ),
      );
    }
  });
}

function requirePositiveInteger(value: unknown, path: string, errors: PlanValidationError[]): void {
  // EVIDENCE: validation: Number.isInteger establishes the numeric value before comparison.
  if (!Number.isInteger(value) || (value as number) < 1) {
    errors.push(planError("TSC002", "Expected a positive integer.", path));
  }
}
