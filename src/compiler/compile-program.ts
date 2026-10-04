import type { FileTarget, FunctionDeclaration, Program } from "../ast.js";
import {
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
  type CompiledFunctionDefinition,
  type Instruction,
  type InstructionPlan,
  type PlanFile,
  type PlanImage,
  type PlanTag,
  type TypeCheckPlan,
} from "../plan/model.js";
import { freezeInstructionPlan } from "../plan/freeze.js";
import { MAIN_FILE_PATH } from "../project-paths.js";
import { createSourceSpan } from "../source.js";
import { sourceSpanToPlanLocation } from "../plan/source-location.js";
import type { RuntimeCheckSite } from "../type-checker.js";
import {
  InstructionCompiler,
  type LoweringCounters,
  type PendingDestination,
  type ProjectFunctions,
} from "./lowering/compiler.js";
import { sessionDeclarations } from "../project-globals.js";

export type { InstructionPlan } from "../plan/model.js";
export { InstructionCompilationError } from "./errors.js";

/** One validated file of a project, in plan order: `main.tease` first, then the others by path. */
export interface StableProjectFile {
  readonly path: string;
  readonly program: Program;
  /** The files each glob target may pick, from semantic validation. */
  readonly picks?: ReadonlyMap<FileTarget, readonly string[]>;
  /** The tags of the file's header, in name order; `null` for a file of declarations only. */
  readonly tags?: readonly PlanTag[] | null;
}

/** Lowers the AST of a single-file project, the `main.tease` of `program`. */
export function compileStableProgram(
  program: Program,
  typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan> = new Map(),
): InstructionPlan {
  return compileStableProject([{ path: MAIN_FILE_PATH, program }], typeChecks);
}

/**
 * Lowers parser-owned AST data of every project file after source parsing and semantic validation. Each file becomes
 * one block of the instruction stream: its root statements, then its functions and handlers. The root region of
 * `main.tease` starts with the start values of the globals and speakers of every file, in session-start order.
 * `typeChecks` are the runtime checks the type check recorded for values the compiler cannot know, and `images` is the
 * validated image catalog, in path order.
 */
export function compileStableProject(
  projectFiles: readonly StableProjectFile[],
  typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan> = new Map(),
  onFile: (fileIndex: number) => void = () => {},
  images: readonly PlanImage[] = [],
): InstructionPlan {
  const instructions: Instruction[] = [];
  const functions: CompiledFunctionDefinition[] = [];
  const counters: LoweringCounters = { nextLoopId: 1, nextTemporaryId: 1 };
  const globalFunctions = new Map<string, FunctionDeclaration>();
  for (const { program } of projectFiles)
    for (const statement of program.statements)
      if (statement.kind === "functionDeclaration" && statement.global)
        globalFunctions.set(statement.name.name, statement);
  const project: ProjectFunctions = { global: globalFunctions, foreignCalls: [] };
  const globalIds = new Map<string, number>();
  const files: PlanFile[] = [];
  const destinations: PendingDestination[] = [];
  for (const [fileIndex, { path, program, picks, tags }] of projectFiles.entries()) {
    const declarations = program.statements.filter(
      (statement): statement is FunctionDeclaration => statement.kind === "functionDeclaration",
    );
    const compiler = new InstructionCompiler(
      declarations,
      typeChecks,
      instructions,
      functions,
      counters,
      project,
      path,
      picks,
    );
    const startInstruction = instructions.length;
    if (fileIndex === 0)
      for (const { file, declaration } of sessionDeclarations(
        projectFiles.map((projectFile) => projectFile.program),
      )) {
        onFile(file);
        compiler.compileStartValue(declaration, file);
      }
    // A file is entered after the start values, which run once, at the start of the session.
    const entryInstruction = instructions.length;
    onFile(fileIndex);
    compiler.compileStatements(
      program.statements.filter((statement) => statement.kind !== "functionDeclaration"),
    );
    // The compiler rejects a reachable end of the file, so this `end` only closes the region.
    const fileEnd = createSourceSpan(program.span.end, program.span.end);
    instructions.push({ kind: "end", span: sourceSpanToPlanLocation(fileEnd) });
    const rootEndInstruction = instructions.length;
    compiler.compileFunctions();
    compiler.resolveGotos();
    for (const declaration of declarations)
      if (declaration.global)
        globalIds.set(declaration.name.name, compiler.functionId(declaration));
    for (const destination of compiler.destinations) destinations.push(destination);
    files.push({
      path,
      sourceSpan: sourceSpanToPlanLocation(program.span),
      startInstruction,
      entryInstruction,
      rootEndInstruction,
      endInstruction: instructions.length,
      labels: compiler.labels,
      tags:
        tags === null ? null : (tags ?? []).map((tag) => ({ name: tag.name, value: tag.value })),
    });
  }
  for (const { instruction, name } of project.foreignCalls) {
    const call = instructions[instruction];
    if (call?.kind !== "callFunction" || !globalIds.has(name))
      throw new TypeError("A call of a global function lost its target during compilation.");
    instructions[instruction] = { ...call, functionId: globalIds.get(name)! };
  }
  // Every file has its entry and labels now, so transfers and fallbacks can name any of them.
  const fileIndexByPath = new Map(files.map((file, index) => [file.path, index]));
  for (const { instruction, paths, label, pick } of destinations) {
    const options = paths.map((path) => {
      const file = fileIndexByPath.get(path) ?? -1;
      const target =
        label === null
          ? files[file]?.entryInstruction
          : files[file]?.labels.find((candidate) => candidate.name === label)?.instruction;
      if (target === undefined) {
        throw new TypeError("Semantically invalid transfer reached compilation.");
      }
      return { file, target };
    });
    const pending = instructions[instruction];
    if (pending?.kind !== "transfer" && pending?.kind !== "setFallback") {
      throw new TypeError("Semantically invalid transfer reached compilation.");
    }
    instructions[instruction] = { ...pending, destination: pick ? { pick: options } : options[0]! };
  }
  return freezeInstructionPlan({
    format: INSTRUCTION_PLAN_FORMAT,
    version: INSTRUCTION_PLAN_VERSION,
    files,
    images: images.map((image) => ({
      path: image.path,
      tags: image.tags.map((tag) => ({ name: tag.name, value: tag.value })),
    })),
    temporaryCount: counters.nextTemporaryId - 1,
    functions,
    instructions,
  });
}
