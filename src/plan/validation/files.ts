import { compareProjectPaths, MAIN_FILE_PATH, packagePathProblem } from "../../project-paths.js";
import { isCanonicalTagList } from "../../tags.js";
import type { PlanFileBoundaries } from "../instruction-stream-analyses/execution-regions.js";
import {
  type PlanValidationError,
  isRecord,
  planError,
  rejectUnknownFields,
  validateSpan,
  validInstructionBoundary,
} from "../validation-support.js";
import { isStartupDeclaration } from "./startup-prefix.js";

const FILE_FIELDS = [
  "path",
  "sourceSpan",
  "startInstruction",
  "entryInstruction",
  "rootEndInstruction",
  "endInstruction",
  "labels",
  "tags",
];

const LABEL_FIELDS = ["name", "instruction"];

/**
 * Checks the file table: `main.tease` first, the other package paths in order, and blocks that cover the instruction
 * stream one after another. Returns the boundaries for the stream analyses, or `null` when they are unusable.
 */
/** Label names are unique in their file and stand in source order inside its root region. */
function validatePlanLabels(
  value: unknown,
  start: number,
  rootEnd: number,
  path: string,
  errors: PlanValidationError[],
): ReadonlySet<number> {
  const instructions = new Set<number>();
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Plan file labels must be an array.", path));
    return instructions;
  }
  const names = new Set<string>();
  let previous = start;
  value.forEach((label: unknown, index) => {
    const labelPath = `${path}[${index}]`;
    if (!isRecord(label)) {
      errors.push(planError("TSC002", "Plan label must be an object.", labelPath));
      return;
    }
    rejectUnknownFields(label, LABEL_FIELDS, labelPath, errors);
    if (typeof label.name !== "string" || !IDENTIFIER.test(label.name) || names.has(label.name)) {
      errors.push(
        planError("TSC002", "Plan label names must be unique identifiers.", `${labelPath}.name`),
      );
    } else {
      names.add(label.name);
    }
    const instruction = label.instruction;
    if (
      typeof instruction !== "number" ||
      !Number.isSafeInteger(instruction) ||
      instruction < previous ||
      instruction >= rootEnd
    ) {
      errors.push(
        planError(
          "TSC002",
          "Plan labels stand in source order inside their file's root region.",
          `${labelPath}.instruction`,
        ),
      );
      return;
    }
    previous = instruction;
    instructions.add(previous);
  });
  return instructions;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function validatePlanFiles(
  value: unknown,
  instructions: readonly unknown[],
  errors: PlanValidationError[],
): PlanFileBoundaries[] | null {
  const instructionCount = instructions.length;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(planError("TSC002", "Plan files must be a non-empty array.", "$.files"));
    return null;
  }
  const boundaries: PlanFileBoundaries[] = [];
  let expectedStart = 0;
  let previousPath: string | null = null;
  let startupEnd = 0;
  while (isStartupDeclaration(instructions[startupEnd])) startupEnd += 1;
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
      rootEnd <= start ||
      end < rootEnd
    ) {
      errors.push(planError("TSC002", "Plan file instruction range is impossible.", path));
      expectedStart = -1;
      return;
    }
    const closing = instructions[rootEnd - 1];
    if (!isRecord(closing) || closing.kind !== "end") {
      errors.push(
        planError(
          "TSC002",
          "A file's root region must close with an end.",
          `${path}.rootEndInstruction`,
        ),
      );
    }
    // A fresh activation starts at the top of its file, where no block, loop, or temporary is open; in main.tease,
    // after the start values, which set up the globals once.
    const entry = file.entryInstruction;
    if (entry !== (fileIndex === 0 ? startupEnd : start)) {
      errors.push(
        planError(
          "TSC002",
          "A file's entry must be the start of its root region, after main.tease's start values.",
          `${path}.entryInstruction`,
        ),
      );
    }
    if (file.tags !== null && !isCanonicalTagList(file.tags)) {
      errors.push(
        planError(
          "TSC002",
          "A file's tags are null, or canonical names, each once, in name order, with a finite number or null.",
          `${path}.tags`,
        ),
      );
    }
    boundaries.push({
      startInstruction: start,
      entryInstruction: typeof entry === "number" ? entry : start,
      rootEndInstruction: rootEnd,
      endInstruction: end,
      labelInstructions: validatePlanLabels(file.labels, start, rootEnd, `${path}.labels`, errors),
    });
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
