import type { FunctionDeclaration, Program } from "../ast.js";
import {
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
  type CompiledFunctionDefinition,
  type Instruction,
  type InstructionPlan,
  type PlanFile,
  type TypeCheckPlan,
} from "../plan/model.js";
import { freezeInstructionPlan } from "../plan/freeze.js";
import { MAIN_FILE_PATH } from "../project-paths.js";
import { createSourceSpan } from "../source.js";
import { sourceSpanToPlanLocation } from "../plan/source-location.js";
import type { RuntimeCheckSite } from "../type-checker.js";
import { InstructionCompiler, type LoweringCounters } from "./lowering/compiler.js";

export type { InstructionPlan } from "../plan/model.js";
export { InstructionCompilationError } from "./errors.js";

/** One validated file of a project, in plan order: `main.tease` first, then the others by path. */
export interface StableProjectFile {
  readonly path: string;
  readonly program: Program;
  /** The runtime checks the type check recorded for values the compiler cannot know. */
  readonly typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>;
}

/** Lowers the AST of a single-file project, the `main.tease` of `program`. */
export function compileStableProgram(
  program: Program,
  typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan> = new Map(),
): InstructionPlan {
  return compileStableProject([{ path: MAIN_FILE_PATH, program, typeChecks }]);
}

/**
 * Lowers parser-owned AST data of every project file after source parsing and semantic validation. Each file becomes
 * one block of the instruction stream: its root statements, then its functions and handlers.
 */
export function compileStableProject(
  projectFiles: readonly StableProjectFile[],
  onFile: (fileIndex: number) => void = () => {},
): InstructionPlan {
  const instructions: Instruction[] = [];
  const functions: CompiledFunctionDefinition[] = [];
  const counters: LoweringCounters = { nextLoopId: 1, nextTemporaryId: 1 };
  const files: PlanFile[] = [];
  for (const [fileIndex, { path, program, typeChecks }] of projectFiles.entries()) {
    onFile(fileIndex);
    const declarations = program.statements.filter(
      (statement): statement is FunctionDeclaration => statement.kind === "functionDeclaration",
    );
    const compiler = new InstructionCompiler(
      declarations,
      typeChecks,
      instructions,
      functions,
      counters,
    );
    const startInstruction = instructions.length;
    compiler.compileStatements(
      program.statements.filter((statement) => statement.kind !== "functionDeclaration"),
    );
    // The compiler rejects a reachable end of the file, so this `end` only closes the region.
    const fileEnd = createSourceSpan(program.span.end, program.span.end);
    instructions.push({ kind: "end", span: sourceSpanToPlanLocation(fileEnd) });
    const rootEndInstruction = instructions.length;
    compiler.compileFunctions();
    compiler.resolveGotos();
    files.push({
      path,
      sourceSpan: sourceSpanToPlanLocation(program.span),
      startInstruction,
      rootEndInstruction,
      endInstruction: instructions.length,
      labels: compiler.labels,
    });
  }
  return freezeInstructionPlan({
    format: INSTRUCTION_PLAN_FORMAT,
    version: INSTRUCTION_PLAN_VERSION,
    files,
    temporaryCount: counters.nextTemporaryId - 1,
    functions,
    instructions,
  });
}
