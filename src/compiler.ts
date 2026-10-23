import type { Block, FileTarget, InteractionExpression, Program } from "./ast.js";
import { findNonFiniteNumericLiteralDiagnosticsInStableProgram } from "./ast-validation.js";
import { dayWaitWarnings } from "./day-waits.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import {
  compileStableProject,
  type InstructionPlan,
  type LoweringTrace,
} from "./compiler/compile-program.js";
import { parse } from "./parser.js";
import type { ScriptHeader } from "./script-header.js";
import { runsOnItsOwn } from "./project-globals.js";
import type { Tag } from "./tags.js";
import { validateCapturedInstructionPlan } from "./plan/validation.js";
import { markValidatedImmutableInstructionPlan } from "./plan/validated-immutable.js";
import { planLocationToSourceSpan } from "./plan/source-location.js";
import type {
  PlanImage,
  PreparedFormShape,
  StorageTypePlan,
  TypeCheckPlan,
  TypePlan,
} from "./plan/model.js";
import { instructionExpressions } from "./plan/instruction-expressions.js";
import { expressionPlanChildren } from "./plan/expression-children.js";
import { imageCatalog, type ProjectImageFile } from "./image-catalog.js";
import { capturesTaggedPhotos } from "./capture-call.js";
import { compareProjectPaths, MAIN_FILE_PATH, packagePathProblem } from "./project-paths.js";
import { CORE_RUNTIME_BUILTINS, PROTECTED_NAME_CODE } from "./language-facts.js";
import { PlanControlFlow } from "./plan/control-flow.js";
import { Reachability, type ConstantTest } from "./reachability.js";
import {
  stopsTypeCheck,
  validateProjectSemantics,
  type FileSemanticResult,
  type SemanticValidationOptions,
} from "./semantic.js";
import { speakerFlowDiagnostics, type SpeakerFlowInput } from "./speaker-flow.js";
import type { RuntimeCheckSite } from "./type-inference/backend.js";
import { checkTypes } from "./type-inference/index.js";
import { createSourcePosition, createSourceSpan } from "./source.js";
import { DeadWays, type WayFacts } from "./way-facts.js";

export interface CompileOptions extends SemanticValidationOptions {
  /** The package images and their XMP keywords, which tag queries search; none by default. */
  readonly images?: readonly ProjectImageFile[];
}

/** What every file of a project is checked with: the options, the built-ins, and the image catalog when given. */
interface ProjectCheckOptions extends CompileOptions {
  readonly imageCatalog?: readonly PlanImage[];
  readonly capturesTaggedPhotos?: boolean;
  readonly scriptCatalog?: readonly {
    readonly path: string;
    readonly tags: readonly Tag[] | null;
  }[];
}

export interface CompilationResult {
  readonly program: Program;
  /** The file's `---` header, or `null` when it has none. */
  readonly header: ScriptHeader | null;
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

export { CORE_RUNTIME_BUILTINS, PLATFORM_STANDARD_LIBRARY_PRELUDE } from "./language-facts.js";

/** Parses, validates, and compiles one source as the `main.tease` of a single-file project, without executing it. */
export function compileSource(source: string, options: CompileOptions = {}): CompilationResult {
  const { result, imageDiagnostics: images } = compileProjectFiles(
    [{ path: MAIN_FILE_PATH, source }],
    options,
  );
  const { path: _path, ...file } = result.files[0]!;
  // The image catalog's diagnostics name their image; the source's own follow them, as in the project.
  return Object.freeze({
    ...file,
    diagnostics:
      images.length === 0 ? file.diagnostics : Object.freeze([...images, ...file.diagnostics]),
    plan: result.plan,
  });
}

/**
 * Parses, validates, and compiles every file of a project into one plan, without executing it. The session starts
 * at the top of `main.tease`. Each file has its own top-level names and functions; globals, global functions, and
 * speakers belong to the whole project.
 */
export function compileProject(
  sources: readonly ProjectSourceFile[],
  options: CompileOptions = {},
): ProjectCompilationResult {
  return compileProjectFiles(sources, options).result;
}

/** A project compilation, and the image catalog's share of its diagnostics. */
function compileProjectFiles(
  sources: readonly ProjectSourceFile[],
  options: CompileOptions,
): {
  readonly result: ProjectCompilationResult;
  readonly imageDiagnostics: readonly ProjectDiagnostic[];
} {
  const inventory = checkProjectFiles(sources);
  const catalog = imageCatalog(options.images ?? []);
  const validationOptions: ProjectCheckOptions = {
    ...options,
    builtins: Object.freeze([...CORE_RUNTIME_BUILTINS, ...(options.builtins ?? [])]),
    ...(options.images === undefined ? {} : { imageCatalog: catalog.images }),
  };
  const files = inventory.files.map(({ path, source }) => parseFile(path, source));
  let plan: InstructionPlan | null = null;
  const checked = checkProject(files, {
    ...validationOptions,
    capturesTaggedPhotos: capturesTaggedPhotos(files.map((file) => file.result.program)),
    scriptCatalog: files.map((file) => ({ path: file.result.path, tags: scriptTags(file.result) })),
  });
  if (inventory.diagnostics.length === 0 && !hasErrors(catalog.diagnostics) && checked !== null) {
    const trace: LoweringTrace = { origins: new Map(), statements: new Map() };
    plan = lowerProject(
      files,
      checked.typeChecks,
      catalog.images,
      checked.formShapes,
      checked.storageTypes,
      trace,
    );
    // Which code can run, the endings, and the flow of speaker properties follow the plan, which runs exactly as the
    // session will (V30 §30, §37).
    // A host global or host function may give a script reference to any file (V30 §30).
    const hostValues = (options.globals?.length ?? 0) > 0 || (options.builtins?.length ?? 0) > 0;
    if (plan !== null) plan = checkFlow(files, plan, trace, checked, hostValues);
  }
  const results = files.map((file) => file.result);
  const result = Object.freeze({
    files: Object.freeze(results),
    diagnostics: Object.freeze([
      ...inventory.diagnostics,
      ...catalog.diagnostics,
      ...results.flatMap((file) =>
        file.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic, path: file.path })),
      ),
    ]),
    plan,
  });
  return { result, imageDiagnostics: catalog.diagnostics };
}

interface CompiledProjectFile {
  result: ProjectFileCompilation;
  readonly source: string;
  /** `null` when parsing exhausted the call stack. */
  readonly parsed: ReturnType<typeof parse> | null;
  /** The files each glob target may pick, once the names are checked. */
  picks?: ReadonlyMap<FileTarget, readonly string[]>;
  /** The variables each timer, media, or button block shares with the code that created it. */
  captures?: ReadonlyMap<Block, readonly string[]>;
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
        `The project has no ${MAIN_FILE_PATH}. Every session starts there.`,
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

function parseFile(path: string, source: string): CompiledProjectFile {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(source);
  } catch (error) {
    if (!isNativeStackExhaustion(error)) throw error;
    return { result: stackExhaustionResult(path, source, null, null), source, parsed: null };
  }
  // A declaration with a protected name, which the parser reports where it reads the name, is a problem of the names
  // that leaves the syntax whole, so the names of the file are still validated.
  const parserDiagnostics = Object.freeze([
    ...parsed.diagnostics.filter((diagnostic) => diagnostic.code !== PROTECTED_NAME_CODE),
    ...findNonFiniteNumericLiteralDiagnosticsInStableProgram(parsed.program),
  ]);
  const semanticDiagnostics = Object.freeze(
    parsed.diagnostics.filter((diagnostic) => diagnostic.code === PROTECTED_NAME_CODE),
  );
  return {
    result: Object.freeze({
      path,
      program: parsed.program,
      header: parsed.header,
      parserDiagnostics,
      semanticDiagnostics,
      diagnostics: Object.freeze([...parserDiagnostics, ...semanticDiagnostics]),
    }),
    source,
    parsed,
  };
}

/** What the checks of a project give the lowering and the checks that follow the plan. */
interface CheckedProject {
  readonly typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>;
  readonly formShapes: ReadonlyMap<InteractionExpression, PreparedFormShape>;
  readonly storageTypes: readonly StorageTypePlan[];
  readonly speakerFlow: SpeakerFlowInput;
  readonly ways: WayFacts;
  readonly names: readonly FileSemanticResult[];
}

/**
 * Validates the names of the files without syntax errors, then, when every file is free of errors that leave the type
 * check without a basis (see `stopsTypeCheck`), the types of the whole project. Returns what the checks found for the
 * lowering and the checks that follow the plan, or `null` when the project has an error.
 */
function checkProject(
  files: CompiledProjectFile[],
  options: ProjectCheckOptions,
): CheckedProject | null {
  let current = 0;
  const track = (file: number): void => {
    current = file;
  };
  try {
    const names = validateProjectSemantics(
      files.map((file) => ({
        path: file.result.path,
        program: file.result.program,
        tags: scriptTags(file.result),
      })),
      options,
      (index) =>
        files[index]!.parsed !== null && !hasErrors(files[index]!.result.parserDiagnostics),
      track,
    );
    names.forEach((result, index) => {
      // The parser reported the file's protected declaration names already (see `parseFile`).
      const reported = new Set(files[index]!.result.semanticDiagnostics.map(diagnosticKey));
      addSemanticDiagnostics(
        files[index]!,
        result.diagnostics.filter((diagnostic) => !reported.has(diagnosticKey(diagnostic))),
      );
      files[index]!.picks = result.picks;
      files[index]!.captures = result.captures;
    });
    if (files.some((file) => file.parsed === null || file.result.diagnostics.some(stopsTypeCheck)))
      return null;
    // Types are checked once every name resolves, so a type message never repeats a name or structure error.
    const types = checkTypes(
      files.map((file) => ({ path: file.result.path, program: file.result.program })),
      {
        ...options,
        sharedWrites: new Map(names.flatMap((result) => [...result.sharedWrites])),
        written: {
          lets: new Set(names.flatMap((result) => [...result.writtenLets])),
          globals: new Set(names.flatMap((result) => [...result.writtenGlobals])),
        },
        speakers: new Map(names.flatMap((result) => [...result.speakers])),
      },
      track,
    );
    types.diagnostics.forEach((diagnostics, index) =>
      addSemanticDiagnostics(files[index]!, [
        ...diagnostics,
        ...dayWaitWarnings(files[index]!.result.program, files[index]!.source),
      ]),
    );
    return files.some((file) => hasErrors(file.result.diagnostics))
      ? null
      : {
          typeChecks: types.runtimeChecks,
          formShapes: types.formShapes,
          storageTypes: types.storageTypes,
          speakerFlow: types.speakerFlow,
          ways: types.ways,
          names,
        };
  } catch (error) {
    if (!isNativeStackExhaustion(error)) throw error;
    const file = files[current]!;
    file.result = stackExhaustionResult(
      file.result.path,
      file.source,
      file.result.program,
      file.result.header,
      file.parsed?.diagnostics,
    );
    return null;
  }
}

function addSemanticDiagnostics(
  file: CompiledProjectFile,
  diagnostics: readonly Diagnostic[],
): void {
  if (diagnostics.length === 0) return;
  const semanticDiagnostics = Object.freeze([...file.result.semanticDiagnostics, ...diagnostics]);
  file.result = Object.freeze({
    ...file.result,
    semanticDiagnostics,
    diagnostics: Object.freeze([...file.result.parserDiagnostics, ...semanticDiagnostics]),
  });
}

/**
 * The checks that follow the plan, with which ways the type check found possible: which code can run, with the
 * initialization of variables at labels and the endings of files and of the session, then the flow of speaker
 * properties. Returns the plan when they find no error, else `null` with their diagnostics in the files.
 */
function checkFlow(
  files: CompiledProjectFile[],
  plan: InstructionPlan,
  trace: LoweringTrace,
  checked: CheckedProject,
  hostValues: boolean,
): InstructionPlan | null {
  try {
    const ways = new DeadWays(new PlanControlFlow(plan), trace.origins, checked.ways);
    const reachability = new Reachability(
      files.map((file) => file.result.program),
      plan,
      trace,
      ways,
    );
    const statementFlow = reachability.statementFlow();
    const endings = reachability.endingDiagnostics();
    const returns = reachability.pendingCallDiagnostics(() => ({
      picks: taggedPicks(plan, trace, checked.names),
      referenced: referencedFiles(plan, checked.names, hostValues),
    }));
    const errors = files.map((_, index) => [
      // The initialization check at labels decides itself which functions and blocks run, by the calls and creations
      // in statements that can run (ADR 0022 §3.4).
      ...checked.names[index]!.checkInitialization(statementFlow),
      ...endings[index]!,
      ...returns[index]!.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error),
    ]);
    if (!errors.some((diagnostics) => diagnostics.length > 0) && !reachability.reachesExit()) {
      const main = files[0]!.result.program;
      errors[0]!.push(
        createDiagnostic(
          DiagnosticSeverity.Error,
          "TSV053",
          "The script never reaches exit, so the session has no end. Add exit where the session should finish.",
          main.statements.at(-1)?.span ?? main.span,
        ),
      );
    }
    const warnings = reachability.warnings(
      files.map((file) =>
        file.result.diagnostics.flatMap((diagnostic): ConstantTest[] =>
          diagnostic.code === "TSV046"
            ? [{ span: diagnostic.span, value: constantTestValue(diagnostic.message) }]
            : [],
        ),
      ),
    );
    // In source order, a warning before an error at the same place, as the loop that never ends comes before the
    // missing exit that it causes.
    files.forEach((file, index) =>
      addSemanticDiagnostics(
        file,
        [
          ...warnings[index]!,
          ...returns[index]!.filter(
            (diagnostic) => diagnostic.severity === DiagnosticSeverity.Warning,
          ),
          ...errors[index]!,
        ].sort((left, right) => left.span.start.offset - right.span.start.offset),
      ),
    );
    if (errors.some((diagnostics) => diagnostics.length > 0)) return null;
    const flow = speakerFlowDiagnostics(plan, trace.origins, ways, checked.speakerFlow);
    if (!flow.some((diagnostics) => diagnostics.length > 0)) return plan;
    flow.forEach((diagnostics, index) => addSemanticDiagnostics(files[index]!, diagnostics));
    return null;
  } catch (error) {
    if (!isNativeStackExhaustion(error)) throw error;
    const main = files[0]!;
    main.result = stackExhaustionResult(
      main.result.path,
      main.source,
      main.result.program,
      main.result.header,
      main.parsed?.diagnostics,
    );
    return null;
  }
}

/**
 * The files that a script reference may name where a computed target uses it, by index: those the project's
 * `script(...)` calls and `findScripts(...)` lists may name (see `FileSemanticResult.referencedScripts`). `null` for any
 * file: when one of them may name any file, when a `load` may give a reference, which an earlier session may have saved
 * for any file, or when the host gives values.
 */
function referencedFiles(
  plan: InstructionPlan,
  names: readonly FileSemanticResult[],
  hostValues: boolean,
): readonly number[] | null {
  const referenced = names[0]?.referencedScripts ?? null;
  if (referenced === null || hostValues) return null;
  for (const instruction of plan.instructions)
    for (const root of instructionExpressions(instruction)) {
      const pending = [root];
      for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
        if (node.kind === "storageLoad" && mayHoldScript(node.type)) return null;
        // One by one: an expression may have more children than a call takes arguments.
        for (const child of expressionPlanChildren(node)) pending.push(child);
      }
    }
  return plan.files.flatMap((file, index) => (referenced.has(file.path) ? [index] : []));
}

/**
 * Whether a loaded value of this type may hold a script reference: `null`, a type not known, may, and so may an object,
 * whose type checks only the properties it lists, so another property may hold anything.
 */
function mayHoldScript(type: TypePlan | null): boolean {
  if (type === null) return true;
  switch (type.kind) {
    case "script":
    case "object":
      return true;
    case "list":
    case "set":
    case "dict":
      return mayHoldScript(type.element);
    case "union":
      return type.members.some(mayHoldScript);
    default:
      return false;
  }
}

/**
 * The files that each tagged pick of the plan may start, by its transfer instruction (see `FileSemanticResult`). Picks
 * that share their list of paths share one list of files.
 */
function taggedPicks(
  plan: InstructionPlan,
  trace: LoweringTrace,
  names: readonly FileSemanticResult[],
): ReadonlyMap<number, readonly number[]> {
  const files = new Map(plan.files.map((file, index) => [file.path, index]));
  const shared = new Map<readonly string[], readonly number[]>();
  const picks = new Map<number, readonly number[]>();
  for (const result of names)
    for (const [statement, paths] of result.taggedPicks) {
      const range = trace.statements.get(statement);
      if (range === undefined) continue;
      let indices = shared.get(paths);
      if (indices === undefined) {
        indices = paths.flatMap((path) => {
          const file = files.get(path);
          return file === undefined ? [] : [file];
        });
        shared.set(paths, indices);
      }
      // The transfer comes last, after the tag tests and lists.
      for (let index = range.end - 1; index >= range.start; index -= 1)
        if (plan.instructions[index]!.kind === "transfer") {
          picks.set(index, indices);
          break;
        }
    }
  return picks;
}

/** What a TSV046 warning says its test always gives, by its words: `null` for a case that never matches or an empty range. */
function constantTestValue(message: string): boolean | null {
  return message.endsWith("always true.") ? true : message.endsWith("always false.") ? false : null;
}

/**
 * Lowers the error-free files into one plan; a lowering diagnostic belongs to the file it arose in, and a failure of the
 * finished plan to `main.tease`. `trace` receives what the checks that follow the plan read it back as source with.
 */
function lowerProject(
  files: CompiledProjectFile[],
  typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  images: readonly PlanImage[],
  formShapes: ReadonlyMap<InteractionExpression, PreparedFormShape>,
  storageTypes: readonly StorageTypePlan[],
  trace: LoweringTrace,
): InstructionPlan | null {
  let current = files[0]!;
  let failure: ReturnType<typeof compiledPlanValidationDiagnostic>;
  try {
    const compiled = compileStableProject(
      files.map((file) => ({
        path: file.result.path,
        program: file.result.program,
        ...(file.picks === undefined ? {} : { picks: file.picks }),
        ...(file.captures === undefined ? {} : { captures: file.captures }),
        tags: scriptTags(file.result),
      })),
      typeChecks,
      (fileIndex) => {
        current = files[fileIndex]!;
      },
      images,
      formShapes,
      storageTypes,
      trace,
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
      parsed.header,
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
  header: ScriptHeader | null,
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
    header,
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

export function isNativeStackExhaustion(error: unknown): boolean {
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

/** A diagnostic's code, place, and text, which two reports of one problem share. */
function diagnosticKey({ code, span, message }: Diagnostic): string {
  return `${code} ${span.start.offset} ${span.end.offset} ${message}`;
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error);
}

/**
 * The tags script tag queries match for a file: its header tags in name order, or `null` for a file of declarations
 * only, which runs nothing on its own and so is never picked or listed, as for globs (ADR 0022 §4.3).
 */
function scriptTags(file: ProjectFileCompilation): readonly Tag[] | null {
  if (!file.program.statements.some(runsOnItsOwn)) return null;
  return [...(file.header?.tags ?? [])].sort((left, right) => (left.name < right.name ? -1 : 1));
}
