import type { PlanFileBoundaries } from "../instruction-stream-analyses.js";
import {
  type PlanValidationError,
  isRecord,
  nonNegativeSafeInteger,
  planError,
} from "../validation-support.js";

// The start values that lead the root region of `main.tease`, and which instructions they are.

/**
 * The start values of globals and speakers lead the root region of `main.tease`, which sets them up once, in order,
 * before the story runs (ADR 0022 §6). Each sets up another name, refers to the file whose source it comes from, and
 * uses only literals, the globals set up before it, operators, and `load`; no control flow leads back into them.
 */
export function validateStartupPrefix(
  instructions: readonly unknown[],
  files: readonly PlanFileBoundaries[] | null,
  fileCount: number,
  errors: PlanValidationError[],
): void {
  let prefixEnd = 0;
  while (isStartupDeclaration(instructions[prefixEnd])) prefixEnd += 1;
  // The first position of each name in the prefix, so a start value can tell the globals set up after it.
  const positions = new Map<unknown, number>();
  for (let index = prefixEnd - 1; index >= 0; index -= 1) {
    const instruction = instructions[index];
    if (isRecord(instruction)) positions.set(instruction.name, index);
  }
  // A label stands after the startup, so a goto never leads into it.
  for (const label of files?.[0]?.labelInstructions ?? [])
    if (label < prefixEnd)
      errors.push(
        planError(
          "TSC002",
          "A label cannot stand in the start of main.tease, which sets up the globals once.",
          "$.files[0].labels",
        ),
      );
  const names = new Set<string>();
  instructions.forEach((instruction, index) => {
    const path = `$.instructions[${index}]`;
    if (!isRecord(instruction)) return;
    const targets =
      typeof instruction.kind === "string" ? CONTROL_TARGETS.get(instruction.kind) : [];
    for (const field of targets ?? [])
      if (typeof instruction[field] === "number" && instruction[field] < prefixEnd)
        errors.push(
          planError(
            "TSC002",
            "Control flow cannot lead back into the start of main.tease, which sets up the globals once.",
            `${path}.${field}`,
          ),
        );
    if (!isStartupDeclaration(instruction)) return;
    if (index >= prefixEnd || (files !== null && index >= files[0]!.rootEndInstruction))
      errors.push(
        planError(
          "TSC002",
          "Globals and speakers are set up only at the start of main.tease.",
          path,
        ),
      );
    if (!nonNegativeSafeInteger(instruction.file) || instruction.file >= fileCount)
      errors.push(
        planError("TSC002", "The source file of a start value is invalid.", `${path}.file`),
      );
    if (typeof instruction.name === "string") {
      if (names.has(instruction.name))
        errors.push(planError("TSC002", "Each global and speaker is set up once.", `${path}.name`));
      names.add(instruction.name);
    }
    // A speaker's properties may read the speaker itself, which is set up before them.
    const firstLater = instruction.kind === "declareSpeaker" ? index + 1 : index;
    const values =
      instruction.kind === "declareGlobal"
        ? [{ value: instruction.value, path: `${path}.value` }]
        : Array.isArray(instruction.properties)
          ? instruction.properties.map((property: unknown, propertyIndex) => ({
              value: isRecord(property) ? property.value : undefined,
              path: `${path}.properties[${propertyIndex}].value`,
            }))
          : [];
    for (const { value, path: valuePath } of values)
      if (!startValueAccepted(value, positions, firstLater))
        errors.push(
          planError(
            "TSC002",
            "A start value uses only literals, globals set up before it, operators, and load.",
            valuePath,
          ),
        );
  });
}

export function isStartupDeclaration(instruction: unknown): instruction is Record<string, unknown> {
  return (
    isRecord(instruction) &&
    (instruction.kind === "declareGlobal" || instruction.kind === "declareSpeaker")
  );
}

/** The fields of each instruction kind that name an instruction where execution continues. */
const CONTROL_TARGETS: ReadonlyMap<string, readonly string[]> = new Map([
  ["goto", ["target"]],
  ["jump", ["target"]],
  ["jumpIfFalse", ["target"]],
  ["loopStart", ["target", "continueTarget"]],
  ["loopControl", ["target"]],
  ["prepareParameterDefault", ["target"]],
  ["callFunction", ["returnInstruction"]],
]);

/**
 * Whether a start value stays in the accepted family: no call, which could run a host effect or change a value, nor a
 * tag query, which reads like one, no temporary or prepared reference, which only instructions after it can produce, and no global set up later. The
 * expression's own shape is validated separately; here every nested record is visited, and the only records that use
 * these kinds are expressions.
 */
function startValueAccepted(
  value: unknown,
  positions: ReadonlyMap<unknown, number>,
  firstLater: number,
): boolean {
  const work = [value];
  while (work.length > 0) {
    const node = work.pop();
    if (Array.isArray(node)) {
      for (const item of node) work.push(item);
      continue;
    }
    if (!isRecord(node)) continue;
    // A script reference is made without effects, like a literal (ADR 0022 §6).
    const scriptReference =
      isRecord(node.callee) && node.callee.kind === "identifier" && node.callee.name === "script";
    if (
      (node.kind === "call" && !scriptReference) ||
      node.kind === "tagQuery" ||
      node.kind === "temporary" ||
      node.kind === "preparedReference"
    )
      return false;
    if (node.kind === "identifier" && (positions.get(node.name) ?? -1) >= firstLater) return false;
    for (const nested of Object.values(node)) work.push(nested);
  }
  return true;
}
