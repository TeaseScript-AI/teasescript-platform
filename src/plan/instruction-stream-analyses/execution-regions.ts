import { isRecord } from "../validation-support.js";

// Execution regions: file boundaries, validated function ranges, and the index of the region each instruction runs in.

/** Validated instruction boundaries of one plan file. */
export interface PlanFileBoundaries {
  readonly startInstruction: number;
  readonly entryInstruction: number;
  readonly rootEndInstruction: number;
  readonly endInstruction: number;
  /** Where the file's labels stand: the only targets of a goto in the file. */
  readonly labelInstructions: ReadonlySet<number>;
}

export type InstructionExecutionRegion =
  | {
      readonly kind: "root";
      readonly file: number;
      readonly startInstruction: number;
      readonly endInstruction: number;
    }
  | {
      readonly kind: "function";
      readonly file: number;
      readonly functionId: number;
      readonly startInstruction: number;
      readonly endInstruction: number;
    };

export interface ValidatedFunctionRange {
  readonly definition: Record<string, unknown>;
  readonly path: string;
  readonly file: number;
  readonly id: number;
  readonly global: boolean;
  readonly entryInstruction: number;
  readonly bodyEntryInstruction: number;
  readonly implicitReturnInstruction: number;
  readonly endInstruction: number;
}

/**
 * Per-validation ownership data. It is deliberately local to one validation
 * operation: externally supplied plans must not populate a process-wide cache.
 */
export interface PlanValidationIndex {
  readonly owners: readonly (InstructionExecutionRegion | undefined)[];
  readonly functionsById: ReadonlyMap<number, ValidatedFunctionRange>;
  readonly files: readonly PlanFileBoundaries[];
  /** Gotos and transfers leave their region, so any of them that lands inside a prepared value bypasses it. */
  readonly gotoSources: ReadonlySet<number>;
}

export function createPlanValidationIndex(
  instructions: readonly unknown[],
  files: readonly PlanFileBoundaries[] | null,
  functions: readonly ValidatedFunctionRange[],
): PlanValidationIndex | null {
  if (files === null) return null;
  const owners: Array<InstructionExecutionRegion | undefined> = new Array(instructions.length);
  files.forEach((file, fileIndex) => {
    const root: InstructionExecutionRegion = {
      kind: "root",
      file: fileIndex,
      startInstruction: file.startInstruction,
      endInstruction: file.rootEndInstruction,
    };
    for (let index = file.startInstruction; index < file.rootEndInstruction; index += 1) {
      owners[index] = root;
    }
  });
  const functionsById = new Map<number, ValidatedFunctionRange>();
  for (const definition of functions) {
    const region: InstructionExecutionRegion = {
      kind: "function",
      file: definition.file,
      functionId: definition.id,
      startInstruction: definition.entryInstruction,
      endInstruction: definition.endInstruction,
    };
    functionsById.set(definition.id, definition);
    for (let index = definition.entryInstruction; index < definition.endInstruction; index += 1) {
      owners[index] = region;
    }
  }
  const gotoSources = new Set<number>();
  instructions.forEach((instruction, index) => {
    if (isRecord(instruction) && (instruction.kind === "goto" || instruction.kind === "transfer"))
      gotoSources.add(index);
  });
  return { owners, functionsById, files, gotoSources };
}
