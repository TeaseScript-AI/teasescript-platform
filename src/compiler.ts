import type { Program } from "./ast.js";
import { findNonFiniteNumericLiteralDiagnosticsInStableProgram } from "./ast-validation.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { compileStableProject, type InstructionPlan } from "./compiler/compile-program.js";
import { parse } from "./parser.js";
import { validateCapturedInstructionPlan } from "./plan/validation.js";
import { markValidatedImmutableInstructionPlan } from "./plan/validated-immutable.js";
import { planLocationToSourceSpan } from "./plan/source-location.js";
import type { TypeCheckPlan } from "./plan/model.js";
import { compareProjectPaths, MAIN_FILE_PATH, packagePathProblem } from "./project-paths.js";
import { CORE_RUNTIME_BUILTINS } from "./protected-names.js";
import { validateSemantics, type SemanticValidationOptions } from "./semantic.js";
import { checkTypes, type RuntimeCheckSite } from "./type-checker.js";
import { createSourcePosition, createSourceSpan } from "./source.js";

export interface CompileOptions extends SemanticValidationOptions {}

export interface CompilationResult {
  readonly program: Program;
  readonly parserDiagnostics: readonly Diagnostic[];
  readonly semanticDiagnostics: readonly Diagnostic[];
  readonly diagnostics: readonly Diagnostic[];
  readonly plan: InstructionPlan | null;
}

/** One `.tease` file of a project, by its path relative to the package root. */
export interface ProjectSourceFile {
  readonly path: string;
  readonly source: string;
}

/** A diagnostic of one project file. */
export interface ProjectDiagnostic extends Diagnostic {
  readonly path: string;
}

/** The compilation of one project file; `diagnostics` also holds lowering diagnostics of this file. */
export interface ProjectFileCompilation extends Omit<CompilationResult, "plan"> {
  readonly path: string;
}

export interface ProjectCompilationResult {
  /** The files with a valid, unique package path: `main.tease` first, then the others by path. */
  readonly files: readonly ProjectFileCompilation[];
  /** Every diagnostic of the project, with the path of its file. */
  readonly diagnostics: readonly ProjectDiagnostic[];
  /** One plan for all files, or `null` when any file has an error. */
  readonly plan: InstructionPlan | null;
}

export { CORE_RUNTIME_BUILTINS, PLATFORM_STANDARD_LIBRARY_PRELUDE } from "./protected-names.js";

/** Parses, validates, and compiles one source as the `main.tease` of a single-file project, without executing it. */
export function compileSource(source: string, options: CompileOptions = {}): CompilationResult {
  const result = compileProject([{ path: MAIN_FILE_PATH, source }], options);
  const { path: _path, ...file } = result.files[0]!;
  return Object.freeze({ ...file, plan: result.plan });
}

/**
 * Parses, validates, and compiles every file of a project into one plan, without executing it. The session starts
 * at the top of `main.tease`. Each file has its own top-level names and functions.
 */
export function compileProject(
  sources: readonly ProjectSourceFile[],
  options: CompileOptions = {},
): ProjectCompilationResult {
  const inventory = checkProjectFiles(sources);
  const validationOptions = {
    ...options,
    builtins: Object.freeze([...CORE_RUNTIME_BUILTINS, ...(options.builtins ?? [])]),
  };
  const files = inventory.files.map(({ path, source }) =>
    compileFile(path, source, validationOptions),
  );
  let plan: InstructionPlan | null = null;
  if (
    inventory.diagnostics.length === 0 &&
    files.every((file) => file.typeChecks !== null && !hasErrors(file.result.diagnostics))
  ) {
    if (files.some((file) => file.reachesExit)) {
      plan = lowerProject(files);
    } else {
      const main = files[0]!.result;
      const noExit = createDiagnostic(
        DiagnosticSeverity.Error,
        "TSV053",
        "The script never reaches exit, so the session has no end. Add exit where the session should finish.",
        main.program.statements.at(-1)?.span ?? main.program.span,
      );
      files[0]!.result = Object.freeze({
        ...main,
        semanticDiagnostics: Object.freeze([...main.semanticDiagnostics, noExit]),
        diagnostics: Object.freeze([...main.diagnostics, noExit]),
      });
    }
  }
  const results = files.map((file) => file.result);
  return Object.freeze({
    files: Object.freeze(results),
    diagnostics: Object.freeze([
      ...inventory.diagnostics,
      ...results.flatMap((file) =>
        file.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic, path: file.path })),
      ),
    ]),
    plan,
  });
}

interface CompiledProjectFile {
  result: ProjectFileCompilation;
  /** `null` when the file has no valid program to lower. */
  readonly typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan> | null;
  readonly reachesExit: boolean;
  readonly parsed: ReturnType<typeof parse> | null;
}

/** Valid, unique package paths in plan order, and a `TSC009` diagnostic for every other path or a missing main. */
function checkProjectFiles(sources: readonly ProjectSourceFile[]): {
  readonly files: readonly ProjectSourceFile[];
  readonly diagnostics: readonly ProjectDiagnostic[];
} {
  const diagnostics: ProjectDiagnostic[] = [];
  const byPath = new Map<string, ProjectSourceFile>();
  const reported = new Set<string>();
  for (const file of sources) {
    const problem = packagePathProblem(file.path);
    if (problem !== null) {
      diagnostics.push(
        projectDiagnostic(file.path, `'${file.path}' is not a package file path: ${problem}.`),
      );
    } else if (byPath.has(file.path)) {
      if (!reported.has(file.path)) {
        reported.add(file.path);
        diagnostics.push(
          projectDiagnostic(file.path, `The project has more than one file '${file.path}'.`),
        );
      }
    } else {
      byPath.set(file.path, file);
    }
  }
  if (!byPath.has(MAIN_FILE_PATH)) {
    diagnostics.push(
      projectDiagnostic(
        MAIN_FILE_PATH,
        `The project has no ${MAIN_FILE_PATH}; every session starts there.`,
      ),
    );
  }
  const files = [...byPath.values()].sort((left, right) =>
    compareProjectPaths(left.path, right.path),
  );
  return { files, diagnostics };
}

function projectDiagnostic(path: string, message: string): ProjectDiagnostic {
  const start = createSourcePosition(0, 0, 0);
  return Object.freeze({
    ...createDiagnostic(
      DiagnosticSeverity.Error,
      "TSC009",
      message,
      createSourceSpan(start, start),
    ),
    path,
  });
}

function compileFile(path: string, source: string, options: CompileOptions): CompiledProjectFile {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(source);
  } catch (error) {
    if (!isNativeStackExhaustion(error)) throw error;
    return {
      result: stackExhaustionResult(path, source, null),
      typeChecks: null,
      reachesExit: false,
      parsed: null,
    };
  }
  try {
    return checkParsedFile(path, parsed, options);
  } catch (error) {
    if (!isNativeStackExhaustion(error)) throw error;
    return {
      result: stackExhaustionResult(path, source, parsed.program, parsed.diagnostics),
      typeChecks: null,
      reachesExit: false,
      parsed,
    };
  }
}

function checkParsedFile(
  path: string,
  parsed: ReturnType<typeof parse>,
  options: CompileOptions,
): CompiledProjectFile {
  const parserDiagnostics = Object.freeze([
    ...parsed.diagnostics,
    ...findNonFiniteNumericLiteralDiagnosticsInStableProgram(parsed.program),
  ]);
  const hasParserErrors = hasErrors(parserDiagnostics);
  const names = hasParserErrors
    ? Object.freeze({ diagnostics: Object.freeze([]) })
    : validateSemantics(parsed.program, options);
  // Types are checked once every name resolves, so a type message never repeats a name or structure error.
  const types =
    hasParserErrors || hasErrors(names.diagnostics) ? null : checkTypes(parsed.program, options);
  const semanticDiagnostics = Object.freeze([...names.diagnostics, ...(types?.diagnostics ?? [])]);
  return {
    result: Object.freeze({
      path,
      program: parsed.program,
      parserDiagnostics,
      semanticDiagnostics,
      diagnostics: Object.freeze([...parserDiagnostics, ...semanticDiagnostics]),
    }),
    typeChecks: types?.runtimeChecks ?? null,
    reachesExit: types?.reachesExit ?? false,
    parsed,
  };
}

/**
 * Lowers the error-free files into one plan; a lowering diagnostic belongs to the file it arose in, and a failure of the
 * finished plan to `main.tease`.
 */
function lowerProject(files: CompiledProjectFile[]): InstructionPlan | null {
  let current = files[0]!;
  let failure: ReturnType<typeof compiledPlanValidationDiagnostic>;
  try {
    const compiled = compileStableProject(
      files.map((file) => ({
        path: file.result.path,
        program: file.result.program,
        typeChecks: file.typeChecks!,
      })),
      (fileIndex) => {
        current = files[fileIndex]!;
      },
    );
    current = files[0]!;
    failure = compiledPlanValidationDiagnostic(compiled);
    if (failure === null) return markValidatedImmutableInstructionPlan(compiled);
  } catch (error) {
    if (!isNativeStackExhaustion(error)) throw error;
    const parsed = current.parsed!;
    current.result = stackExhaustionResult(
      current.result.path,
      "",
      parsed.program,
      parsed.diagnostics,
    );
    return null;
  }
  const file = files[failure.file]!;
  file.result = withDiagnostic(file.result, failure.diagnostic);
  return null;
}

function withDiagnostic(
  result: ProjectFileCompilation,
  diagnostic: Diagnostic,
): ProjectFileCompilation {
  return Object.freeze({
    ...result,
    diagnostics: Object.freeze([...result.diagnostics, diagnostic]),
  });
}

function stackExhaustionResult(
  path: string,
  source: string,
  parsedProgram: Program | null,
  parserDiagnostics: readonly Diagnostic[] = [],
): ProjectFileCompilation {
  const sourceSpan = parsedProgram?.span ?? completeSourceSpan(source);
  const stackDiagnostic = createDiagnostic(
    DiagnosticSeverity.Error,
    "TSC007",
    "Compilation exhausted the JavaScript host's call stack while processing this source.",
    sourceSpan,
  );
  const frozenParserDiagnostics = Object.freeze([...parserDiagnostics]);
  const semanticDiagnostics = Object.freeze([]);
  return Object.freeze({
    path,
    program:
      parsedProgram ??
      Object.freeze({ kind: "program", statements: Object.freeze([]), span: sourceSpan }),
    parserDiagnostics: frozenParserDiagnostics,
    semanticDiagnostics,
    diagnostics: Object.freeze([...frozenParserDiagnostics, stackDiagnostic]),
  });
}

function completeSourceSpan(source: string) {
  let line = 0;
  let column = 0;
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] === "\r" && source[offset + 1] === "\n") {
      offset += 1;
      line += 1;
      column = 0;
    } else if (source[offset] === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return createSourceSpan(
    createSourcePosition(0, 0, 0),
    createSourcePosition(source.length, line, column),
  );
}

function isNativeStackExhaustion(error: unknown): boolean {
  if (!(error instanceof RangeError) && !(error instanceof SyntaxError)) return false;
  const message = error.message.toLowerCase();
  if (error instanceof RangeError) {
    return (
      message.includes("maximum call stack size exceeded") || message.includes("stack overflow")
    );
  }
  return message.startsWith("invalid regular expression:") && message.endsWith("stack overflow");
}

/** The first plan validation error as a diagnostic of the file whose instruction it concerns. */
function compiledPlanValidationDiagnostic(
  plan: InstructionPlan,
): { readonly file: number; readonly diagnostic: Diagnostic } | null {
  const validation = validateCapturedInstructionPlan(plan);
  if (validation.valid) return null;
  const match = validation.errors.flatMap((error) => {
    const instructionMatch = /^\$\.instructions\[(\d+)\]/u.exec(error.path);
    if (instructionMatch === null) return [];
    const instructionIndex = Number(instructionMatch[1]);
    if (
      !Number.isSafeInteger(instructionIndex) ||
      plan.instructions[instructionIndex]?.kind !== "interaction"
    ) {
      return [];
    }
    return [{ error, instructionIndex }];
  })[0];
  if (match === undefined) {
    return {
      file: 0,
      diagnostic: createDiagnostic(
        DiagnosticSeverity.Error,
        "TSC006",
        `Compiled instruction plan is invalid: ${validation.errors[0]!.message}`,
        planLocationToSourceSpan(plan.files[0]!.sourceSpan),
      ),
    };
  }

  return {
    file: plan.files.findIndex((file) => match.instructionIndex < file.endInstruction),
    diagnostic: createDiagnostic(
      DiagnosticSeverity.Error,
      "TSC006",
      `Compiled interaction data is rejected by the current instruction-plan validation boundary: ${match.error.message}`,
      planLocationToSourceSpan(plan.instructions[match.instructionIndex]!.span),
    ),
  };
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error);
}
